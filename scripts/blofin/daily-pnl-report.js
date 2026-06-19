#!/usr/bin/env node
'use strict';

/**
 * Daily P&L report — posts to BLOFIN_RECON_WEBHOOK at 21:00 UTC (5 PM EDT
 * during DST; 4 PM EST in winter). Always posts, even when state is boring,
 * so the user knows the report ran.
 *
 * Sections:
 *   1. Account snapshot — equity, available, margin used
 *   2. Open positions — side, size, mark, uPnL, SL distance, TP distance
 *   3. Today's activity — signals fired, fills, realized P&L
 *   4. Protection status — every open position MUST have an SL
 *
 * Reads BloFin REST + Mongo. No CDP. Lives in scripts/cron/ace.crontab.
 *
 * Usage:  make blofin-daily-pnl
 *    or:  node scripts/blofin/daily-pnl-report.js
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin  = require('../lib/blofin');
const store   = require('../lib/blofin-store');
const db      = require('../lib/db');
const discord = require('../lib/discord');
const fs      = require('fs');
const path    = require('path');

const ROOT        = path.resolve(__dirname, '..', '..');
const TRADES_FILE = path.join(ROOT, 'trades.json');

function fmtMoney(n)   { if (n == null || isNaN(Number(n))) return '—'; return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtPx(n)      { if (n == null || isNaN(Number(n))) return '—'; return Number(n).toFixed(1); }
function fmtPct(n)     { if (n == null || isNaN(Number(n))) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtSize(n)    { if (n == null) return '—'; return Number(n).toFixed(1); }

function startOfUtcDay(d = new Date()) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

async function getMarkPrice() {
  // Binance REST is faster + already a dep
  const https = require('https');
  return new Promise((resolve) => {
    https.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(Number(JSON.parse(d).price)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function todaysSignals() {
  try {
    const all = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    const cutoff = startOfUtcDay().getTime();
    return all.filter(t => t.firedAt && new Date(t.firedAt).getTime() >= cutoff);
  } catch { return []; }
}

async function buildReport() {
  const todayStart = startOfUtcDay();
  const sections   = [];
  let totalUnrealized = 0;
  let alertColor = false;

  // ─── 1. Account snapshot ────────────────────────────────────────────────
  const balRows = await blofin.getBalance('futures');
  const usdt    = (balRows || []).find(r => r.currency === 'USDT') || {};
  const balance = Number(usdt.balance || 0);
  const avail   = Number(usdt.available || 0);
  const frozen  = Number(usdt.frozen || 0);

  // ─── 2. Open positions ──────────────────────────────────────────────────
  const positions = await blofin.getPositions();
  const openPositions = (positions || []).filter(p => Math.abs(Number(p.positions || p.pos || 0)) > 0);

  // Active TPSLs and limit orders for context
  const pendingTPSL = await blofin.getPendingTPSL();
  const pendingLimit = await blofin.getActiveOrders();

  const positionLines = [];
  for (const pos of openPositions) {
    const sz       = Number(pos.positions || pos.pos);
    const side     = sz > 0 ? 'LONG' : 'SHORT';
    const emoji    = sz > 0 ? '🟢' : '🔴';
    const absSize  = Math.abs(sz);
    const avgPx    = Number(pos.averagePrice);
    const markPx   = Number(pos.markPrice || await getMarkPrice());
    const uPnL     = Number(pos.unrealizedPnl);
    const realPnL  = Number(pos.realizedPnl || 0);
    totalUnrealized += uPnL;

    // Find covering SL on this instId
    const sls = (pendingTPSL || []).filter(o => o.instId === pos.instId && Number(o.slTriggerPrice) > 0);
    const slLine = sls.length === 0
      ? '🚨 **NO ACTIVE SL — POSITION UNPROTECTED**'
      : sls.map(s => {
          const trig = Number(s.slTriggerPrice);
          const dist = ((trig - markPx) / markPx * 100);
          return `   SL: ${fmtPx(trig)} (${s.slTriggerPriceType}) — ${fmtPct(dist)} from mark`;
        }).join('\n');
    if (sls.length === 0) alertColor = true;

    // Nearest TP from the limit order book for this position
    const tps = (pendingLimit || [])
      .filter(o => o.instId === pos.instId && o.orderType === 'limit')
      .map(o => ({ price: Number(o.price), side: o.side }))
      .sort((a, b) => Math.abs(a.price - markPx) - Math.abs(b.price - markPx));
    const nearestTp = tps[0];
    const tpLine = nearestTp
      ? `   Nearest TP: ${fmtPx(nearestTp.price)} ${nearestTp.side.toUpperCase()} — ${fmtPct((nearestTp.price - markPx) / markPx * 100)} from mark`
      : '   Nearest TP: (none)';

    positionLines.push(
      `${emoji} **${pos.instId} ${side}**`,
      `   Size: ${fmtSize(absSize)} contracts · Avg entry: ${fmtPx(avgPx)} · Mark: ${fmtPx(markPx)}`,
      `   uPnL: ${fmtMoney(uPnL)} (margin realized PnL today: ${fmtMoney(realPnL)})`,
      slLine,
      tpLine,
      '',
    );
  }
  const equity = balance + frozen + totalUnrealized;

  // ─── 3. Today's activity ────────────────────────────────────────────────
  await db.connect();
  const todayFills = await db.blofinOrders().find({
    env: 'demo', state: 'filled', filledAt: { $gte: todayStart },
  }).toArray();
  const todaysSigs = todaysSignals();

  // Realized P&L from today's fills via fillPnl (sum from fills-history per orderId)
  let realizedToday = 0;
  for (const f of todayFills) {
    try {
      const hist = await blofin.getTradeHistory({ instId: f.instId, orderId: f.orderId, limit: 50 });
      for (const h of hist || []) realizedToday += Number(h.fillPnl || 0);
    } catch (_) { /* swallow — partial counts are fine */ }
  }

  // ─── Compose ───────────────────────────────────────────────────────────
  sections.push(
    `**📊 Daily P&L Report — ${todayStart.toISOString().slice(0,10)}**`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    '',
    `**Account (USDT futures)**`,
    `Equity:    ${fmtMoney(equity)}  (cash ${fmtMoney(balance)} · margin ${fmtMoney(frozen)} · uPnL ${fmtMoney(totalUnrealized)})`,
    `Available: ${fmtMoney(avail)}`,
    '',
  );

  if (openPositions.length === 0) {
    sections.push(`**Open Positions** — none`, '');
  } else {
    sections.push(`**Open Positions (${openPositions.length})**`, '', ...positionLines);
  }

  sections.push(
    `**Today's Activity** (UTC day)`,
    `Signals fired:  ${todaysSigs.length}`,
    `Orders filled:  ${todayFills.length}`,
    `Realized P&L:   ${fmtMoney(realizedToday)}`,
    '',
  );

  // Protection invariant
  const unprotected = await store.findUnprotectedPositions();
  if (unprotected.length === 0) {
    sections.push('**Protection** ✅ all positions covered by SL');
  } else {
    sections.push('🚨 **PROTECTION FAILURE** 🚨');
    unprotected.forEach(p => sections.push(`• ${p.instId} ${p.side.toUpperCase()} size=${p.size} — NO ACTIVE SL`));
    sections.push('**Action:** flip BLOFIN_AUTOTRADE=false and set SL via UI immediately.');
    alertColor = true;
  }

  sections.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  return { body: sections.join('\n'), alertColor };
}

async function main() {
  if (!process.env.BLOFIN_RECON_WEBHOOK) {
    console.error('BLOFIN_RECON_WEBHOOK not set — exiting');
    process.exit(1);
  }
  console.log('Building daily P&L report…');
  let body, alertColor;
  try {
    ({ body, alertColor } = await buildReport());
  } catch (e) {
    body = `**Daily P&L Report — generation FAILED**\n\`\`\`\n${e.message}\n\`\`\``;
    alertColor = true;
  }

  const footer = `Daily P&L · ${blofin.isDemo() ? 'demo' : 'PROD'} · ${new Date().toUTCString().slice(5, 25)} UTC`;
  await discord.postWebhook(process.env.BLOFIN_RECON_WEBHOOK, alertColor ? 'error' : 'info', body, footer);
  console.log('Posted.');
  await db.disconnect();
}

main().catch(async e => {
  console.error('unexpected:', e);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
