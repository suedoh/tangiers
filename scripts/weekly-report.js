#!/usr/bin/env node
/**
 * Ace Trading System — Weekly Performance Report
 *
 * Reads trades.json, computes 7-day stats, posts to #backtest-btc via Discord.
 * Run via cron every Monday at 09:00 UTC.
 *
 * Usage: node scripts/weekly-report.js
 *        node scripts/weekly-report.js --days 30   (custom lookback)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT        = path.resolve(__dirname, '..');
const ENV_FILE    = path.join(ROOT, '.env');
const TRADES_FILE = path.join(ROOT, 'trades.json');

// ─── Env ─────────────────────────────────────────────────────────────────────

if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const idx = l.indexOf('=');
      if (idx > 0) process.env[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
    });
}

const WEBHOOK_URL = process.env.DISCORD_BTC_BACKTEST_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error('ERROR: DISCORD_BTC_BACKTEST_WEBHOOK_URL not set in .env');
  process.exit(1);
}

// ─── Args ─────────────────────────────────────────────────────────────────────

const daysArg = process.argv.indexOf('--days');
const LOOKBACK_DAYS = daysArg !== -1 ? parseInt(process.argv[daysArg + 1], 10) : 7;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function postToDiscord(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      if (res.statusCode === 204) resolve();
      else reject(new Error(`Discord returned HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function pct(n, d) {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

function fmt(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function analyse(trades, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const window = trades.filter(t => new Date(t.firedAt).getTime() >= cutoff);

  // Only evaluate closed trades (outcome set)
  const closed  = window.filter(t => t.outcome !== null && t.outcome !== 'expired');
  const open    = window.filter(t => t.outcome === null);
  const expired = window.filter(t => t.outcome === 'expired');

  // Wins = any TP hit. Losses = stop or invalidated.
  const wins   = closed.filter(t => t.outcome?.startsWith('tp'));
  const losses = closed.filter(t => t.outcome === 'stop' || t.outcome === 'invalidated');

  const totalR = closed.reduce((sum, t) => sum + (t.pnlR ?? 0), 0);
  const avgR   = closed.length ? totalR / closed.length : null;

  // By setup type
  const bySetup = {};
  for (const t of closed) {
    const key = t.setupType || 'Unknown';
    if (!bySetup[key]) bySetup[key] = { wins: 0, losses: 0, totalR: 0 };
    if (t.outcome?.startsWith('tp')) bySetup[key].wins++;
    else bySetup[key].losses++;
    bySetup[key].totalR += t.pnlR ?? 0;
  }

  // By direction
  const longs  = closed.filter(t => t.direction === 'long');
  const shorts = closed.filter(t => t.direction === 'short');
  const longWins  = longs.filter(t => t.outcome?.startsWith('tp'));
  const shortWins = shorts.filter(t => t.outcome?.startsWith('tp'));

  // Best / worst
  const sorted = [...closed].sort((a, b) => (b.pnlR ?? 0) - (a.pnlR ?? 0));
  const best   = sorted[0]  ?? null;
  const worst  = sorted[sorted.length - 1] ?? null;

  // TP distribution (of wins)
  const tp1hits = wins.filter(t => t.outcome === 'tp1').length;
  const tp2hits = wins.filter(t => t.outcome === 'tp2').length;
  const tp3hits = wins.filter(t => t.outcome === 'tp3').length;

  // Criteria accuracy — which auto-criteria were most predictive
  // A criterion is "predictive" if: when it passed, the trade won
  const criteriaStats = {};
  for (const t of closed) {
    for (const c of (t.criteria || [])) {
      if (!c.auto || c.pass === null) continue;
      const k = c.label.replace(/\$[\d,]+/g, '$X').replace(/[+-]?\d+(\.\d+)?/g, 'N'); // normalize numbers
      if (!criteriaStats[k]) criteriaStats[k] = { aligned_wins: 0, aligned_losses: 0, misaligned_wins: 0, misaligned_losses: 0 };
      const won = t.outcome?.startsWith('tp');
      if (c.pass) { won ? criteriaStats[k].aligned_wins++ : criteriaStats[k].aligned_losses++; }
      else        { won ? criteriaStats[k].misaligned_wins++ : criteriaStats[k].misaligned_losses++; }
    }
  }

  return {
    days, window: window.length, closed: closed.length, open: open.length, expired: expired.length,
    wins: wins.length, losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    totalR, avgR,
    longs: longs.length, longWins: longWins.length,
    shorts: shorts.length, shortWins: shortWins.length,
    bySetup,
    best, worst,
    tp1hits, tp2hits, tp3hits,
    criteriaStats,
  };
}

// ─── Format ───────────────────────────────────────────────────────────────────

function formatReport(s) {
  const dateRange = (() => {
    const end   = new Date();
    const start = new Date(Date.now() - s.days * 24 * 60 * 60 * 1000);
    return `${start.toLocaleDateString('en-CA')} → ${end.toLocaleDateString('en-CA')}`;
  })();

  // Setup breakdown
  const setupLines = Object.entries(s.bySetup).map(([name, d]) => {
    const total = d.wins + d.losses;
    return `  ${name}: ${d.wins}/${total} wins (${pct(d.wins, total)}) | ${fmt(d.totalR)} total`;
  }).join('\n') || '  No closed trades';

  // Criteria accuracy — top 3 most predictive (highest aligned win rate, min 3 samples)
  const criteriaLines = Object.entries(s.criteriaStats)
    .map(([label, d]) => {
      const aligned = d.aligned_wins + d.aligned_losses;
      const rate    = aligned >= 3 ? d.aligned_wins / aligned : null;
      return { label, rate, aligned };
    })
    .filter(c => c.rate !== null)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3)
    .map(c => `  ${pct(Math.round(c.rate * 100), 100)} win rate when ✅ — ${c.label} (${c.aligned} samples)`)
    .join('\n') || '  Not enough data yet';

  // Best/worst trades
  const bestLine  = s.best  ? `  ${s.best.direction.toUpperCase()} ${s.best.setupType} on ${s.best.firedAt.slice(0,10)} → ${fmt(s.best.pnlR)} (${s.best.outcome})` : '  —';
  const worstLine = s.worst ? `  ${s.worst.direction.toUpperCase()} ${s.worst.setupType} on ${s.worst.firedAt.slice(0,10)} → ${fmt(s.worst.pnlR)} (${s.worst.outcome})` : '  —';

  const winRateStr  = s.winRate != null ? `${Math.round(s.winRate * 100)}%` : '—';
  const totalRStr   = fmt(s.totalR);
  const avgRStr     = fmt(s.avgR);

  const noDataNote = s.closed === 0
    ? '\n⚠️ No closed trades yet — outcomes populate automatically as price hits TP/stop levels.'
    : '';

  return [
    `📊 **WEEKLY PERFORMANCE REPORT** | BINANCE:BTCUSDT.P`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `**Period**  ${dateRange} (${s.days} days)`,
    ``,
    `**OVERVIEW**`,
    `Signals fired: ${s.window} | Closed: ${s.closed} | Open: ${s.open}`,
    `Wins: ${s.wins} | Losses: ${s.losses} | Win Rate: **${winRateStr}**`,
    `Total R: **${totalRStr}** | Avg R per trade: ${avgRStr}`,
    ``,
    `**BY DIRECTION**`,
    `Longs:  ${s.longWins}/${s.longs} wins (${pct(s.longWins, s.longs)})`,
    `Shorts: ${s.shortWins}/${s.shorts} wins (${pct(s.shortWins, s.shorts)})`,
    ``,
    `**BY SETUP TYPE**`,
    setupLines,
    ``,
    `**TP DISTRIBUTION** (of ${s.wins} wins)`,
    `TP1: ${s.tp1hits}  TP2: ${s.tp2hits}  TP3: ${s.tp3hits}`,
    ``,
    `**MOST PREDICTIVE CRITERIA**`,
    criteriaLines,
    ``,
    `**BEST TRADE**`,
    bestLine,
    `**WORST TRADE**`,
    worstLine,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    noDataNote,
  ].filter(l => l !== undefined).join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const trades = readTrades();
  const stats  = analyse(trades, LOOKBACK_DAYS);
  const report = formatReport(stats);

  console.log(report);
  console.log('');

  const payload = {
    embeds: [{
      description: report,
      color: 3447003, // blue
      footer: { text: `Ace • BINANCE:BTCUSDT.P • ${LOOKBACK_DAYS}-day report` },
      timestamp: new Date().toISOString(),
    }],
  };

  await postToDiscord(payload);
  console.log(`Report posted to #backtest-btc (${stats.closed} closed trades analysed)`);
}

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; }
}

main().catch(err => {
  console.error('weekly-report failed:', err.message);
  process.exit(1);
});
