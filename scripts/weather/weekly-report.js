#!/usr/bin/env node
'use strict';

/**
 * weather/weekly-report.js — Sunday weekly P&L summary
 *
 * Posts a performance report to #weather-backtest every Sunday at 18:00 UTC.
 * Covers the trailing 7 days of signals: win rate, P&L, top/bottom performers.
 *
 * Crontab:
 *   0 18 * * 0  node /path/to/trading/scripts/weather/weekly-report.js
 *
 * Manual run:
 *   node scripts/weather/weekly-report.js --force
 */

const path = require('path');
const fs   = require('fs');
const { loadEnv, ROOT } = require('../lib/env');
const { postWebhook }   = require('../lib/discord');

loadEnv();

if (process.env.PRIMARY === 'false' && !process.argv.includes('--force')) {
  console.log('[weather-report] PRIMARY=false — skipping');
  process.exit(0);
}

const BACKTEST_HOOK = process.env.WEATHER_DISCORD_BACKTEST_WEBHOOK;
const TRADES_FILE   = path.join(ROOT, 'weather-trades.json');

function log(msg) { console.log(`[${new Date().toISOString()}] [weather-report] ${msg}`); }
function usd(v)   { return v != null ? (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2) : '?'; }
function pct(v)   { return v != null ? (v * 100).toFixed(1) + '%' : 'N/A'; }

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); }
  catch { return []; }
}

async function main() {
  const trades = readTrades();

  // ── Filter to past 7 days ─────────────────────────────────────────────────
  const cutoff = Date.now() - 7 * 24 * 3_600_000;
  const recent = trades.filter(t =>
    new Date(t.firedAt).getTime() > cutoff && t.outcome !== 'superseded'
  );

  const resolved = recent.filter(t => t.signalResult != null);
  const open     = recent.filter(t => t.outcome === null);
  const wins     = resolved.filter(t => t.signalResult === 'win');
  const losses   = resolved.filter(t => t.signalResult === 'loss');

  const totalPnl = resolved.reduce((acc, t) => acc + (t.pnlDollars || 0), 0);
  const winRate  = resolved.length > 0 ? wins.length / resolved.length : null;

  // Average edge on winning vs losing signals
  const avgEdgeWin  = wins.length   > 0 ? wins.reduce((a, t) => a + t.edge, 0) / wins.length   : null;
  const avgEdgeLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.edge, 0) / losses.length : null;

  // ── Lifetime stats ────────────────────────────────────────────────────────
  const allResolved = trades.filter(t => t.signalResult != null);
  const allWins     = allResolved.filter(t => t.signalResult === 'win');
  const allPnl      = allResolved.reduce((acc, t) => acc + (t.pnlDollars || 0), 0);
  const allWinRate  = allResolved.length > 0 ? allWins.length / allResolved.length : null;

  // ── Top and bottom signals this week ─────────────────────────────────────
  const topSignal = resolved
    .filter(t => t.pnlDollars != null)
    .sort((a, b) => b.pnlDollars - a.pnlDollars)[0];
  const botSignal = resolved
    .filter(t => t.pnlDollars != null)
    .sort((a, b) => a.pnlDollars - b.pnlDollars)[0];

  // ── Build report card ─────────────────────────────────────────────────────
  const now      = new Date().toISOString().slice(0, 10);
  const weekAgo  = new Date(cutoff).toISOString().slice(0, 10);

  const lines = [
    `## ☀️ WEATHERMEN — WEEKLY REPORT`,
    `**${weekAgo} → ${now}**`,
    '',
    '### 📊 THIS WEEK',
  ];

  if (resolved.length === 0 && open.length === 0) {
    lines.push('*No signals fired this week.*');
  } else {
    lines.push(
      `Signals fired:   **${recent.length}** (${resolved.length} resolved, ${open.length} open)`,
      `Win / Loss:      **${wins.length}W / ${losses.length}L**${winRate != null ? ` (${pct(winRate)} win rate)` : ''}`,
      `Paper P&L:       **${usd(totalPnl)}**`,
    );

    if (avgEdgeWin != null)  lines.push(`Avg edge — wins:   **${avgEdgeWin.toFixed(1)}%**`);
    if (avgEdgeLoss != null) lines.push(`Avg edge — losses: **${avgEdgeLoss.toFixed(1)}%**`);

    if (topSignal) {
      lines.push('', `🏆 **Best signal:** ${topSignal.question.slice(0, 60)}...`);
      lines.push(`   ${topSignal.side.toUpperCase()} | Edge ${topSignal.edge}% | **${usd(topSignal.pnlDollars)}**`);
    }
    if (botSignal && botSignal.id !== topSignal?.id) {
      lines.push(`💀 **Worst signal:** ${botSignal.question.slice(0, 60)}...`);
      lines.push(`   ${botSignal.side.toUpperCase()} | Edge ${botSignal.edge}% | **${usd(botSignal.pnlDollars)}**`);
    }
  }

  lines.push('', '### 📈 ALL-TIME');
  lines.push(
    `Total signals:  **${allResolved.length}** resolved`,
    `Win rate:       **${allWinRate != null ? pct(allWinRate) : 'N/A'}**`,
    `Total paper P&L: **${usd(allPnl)}**`,
  );

  // Source breakdown
  const sourceCount = {};
  for (const t of allResolved) {
    for (const s of (t.sources || [])) {
      sourceCount[s] = (sourceCount[s] || 0) + 1;
    }
  }
  if (Object.keys(sourceCount).length > 0) {
    lines.push('', '**Forecast sources used:**');
    for (const [src, cnt] of Object.entries(sourceCount)) {
      lines.push(`  ${src}: ${cnt}x`);
    }
  }

  // Open positions
  if (open.length > 0) {
    lines.push('', `### 🟡 OPEN POSITIONS (${open.length})`);
    for (const t of open.slice(0, 5)) {
      lines.push(`  ${t.side === 'yes' ? '🟢' : '🔴'} ${t.side.toUpperCase()} | ${t.question.slice(0, 55)}...`);
      lines.push(`     Edge ${t.edge}% | Market ${pct(t.yesPrice)} YES | Resolves ${t.parsed?.date}`);
    }
    if (open.length > 5) lines.push(`  …and ${open.length - 5} more`);
  }

  lines.push('', `*📌 Paper trades only — Phase A signal validation*`);
  lines.push(`*Advance to live execution after ${allResolved.length < 20 ? `${20 - allResolved.length} more resolved signals` : 'Phase B activation'}*`);

  const body   = lines.join('\n');
  const footer = `Weathermen • Weekly Report • ${now}`;

  if (BACKTEST_HOOK) {
    await postWebhook(BACKTEST_HOOK, 'info', body, footer);
    log('Weekly report posted');
  } else {
    log('WEATHER_DISCORD_BACKTEST_WEBHOOK not set — printing to stdout');
    console.log('\n' + body + '\n');
  }
}

main().catch(err => {
  console.error('[weather-report] Fatal:', err);
  process.exit(1);
});
