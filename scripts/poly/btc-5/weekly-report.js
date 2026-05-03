#!/usr/bin/env node
'use strict';

/**
 * Polymarket BTC 5-min — Weekly Performance Report
 *
 * Posts a performance summary to #poly-btc-5-report every Monday at 09:00 UTC.
 * Covers: win rate, factor correlation, tier breakdown, best session windows.
 *
 * Usage:
 *   node scripts/poly/btc-5/weekly-report.js          → auto (Monday 09:00–09:05 UTC)
 *   node scripts/poly/btc-5/weekly-report.js --force  → run immediately
 */

const path = require('path');
const fs   = require('fs');

const { loadEnv, ROOT } = require('../../lib/env');
const { postWebhook }   = require('../../lib/discord');

loadEnv();

const REPORT_HOOK  = process.env.POLY_BTC_5_REPORT_WEBHOOK;
const SIGNALS_HOOK = process.env.POLY_BTC_5_SIGNALS_WEBHOOK;
const TRADES_FILE  = path.join(ROOT, 'poly-btc-5-trades.json');
const FORCE        = process.argv.includes('--force');

function log(msg) { console.log(`[${new Date().toISOString()}] [poly-btc-5-report] ${msg}`); }

function shouldRun() {
  if (FORCE) return true;
  const now    = new Date();
  const day    = now.getUTCDay();
  const hour   = now.getUTCHours();
  const minute = now.getUTCMinutes();
  return day === 1 && hour === 9 && minute < 5;
}

function readTrades() { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } }

// ─── Stats ────────────────────────────────────────────────────────────────────

function computeStats(trades) {
  const weekAgo     = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent      = trades.filter(t => new Date(t.barOpen).getTime() > weekAgo);
  const allTime     = trades.filter(t => t.outcome != null);
  const signaled    = recent.filter(t => t.signaled);
  const resolved    = signaled.filter(t => t.outcome != null);
  const correct     = resolved.filter(t => t.correct);
  const highTier    = resolved.filter(t => t.tier === 'high');
  const highCorrect = highTier.filter(t => t.correct);

  const byHour = {};
  for (const t of allTime.filter(t => t.signaled)) {
    const h = new Date(t.barOpen).getUTCHours();
    if (!byHour[h]) byHour[h] = { total: 0, correct: 0 };
    byHour[h].total++;
    if (t.correct) byHour[h].correct++;
  }
  const bestHours = Object.entries(byHour)
    .filter(([, v]) => v.total >= 3)
    .map(([h, v]) => ({ hour: parseInt(h), rate: v.correct / v.total, total: v.total }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3);

  const factorKeys = ['cvdDir', 'vwapDir', 'structDir', 'oiRising', 'cleanAir', 'goodSession'];
  const factorStats = {};
  for (const k of factorKeys) {
    const fired   = allTime.filter(t => t.signaled && t.factors?.[k] != null && t.factors[k] !== false);
    const correct = fired.filter(t => t.correct);
    factorStats[k] = { total: fired.length, correct: correct.length };
  }

  const ups   = resolved.filter(t => t.prediction === 'UP');
  const downs = resolved.filter(t => t.prediction === 'DOWN');

  let streak = 0, streakDir = null;
  const signaledAll = allTime.filter(t => t.signaled);
  for (let i = signaledAll.length - 1; i >= 0; i--) {
    const t = signaledAll[i];
    if (!t.outcome) continue;
    if (streak === 0) streakDir = t.correct ? 'WIN' : 'LOSS';
    if ((t.correct && streakDir === 'WIN') || (!t.correct && streakDir === 'LOSS')) streak++;
    else break;
  }

  return {
    recent: { total: recent.length, signaled: signaled.length, resolved: resolved.length },
    winRate: resolved.length > 0 ? correct.length / resolved.length : null,
    highTierWinRate: highTier.length > 0 ? highCorrect.length / highTier.length : null,
    correct: correct.length, total: resolved.length,
    highCorrect: highCorrect.length, highTotal: highTier.length,
    allTimeTotal: allTime.filter(t => t.signaled && t.outcome).length,
    allTimeCorrect: allTime.filter(t => t.signaled && t.correct).length,
    bestHours, factorStats,
    upWinRate: ups.length > 0 ? ups.filter(t => t.correct).length / ups.length : null,
    downWinRate: downs.length > 0 ? downs.filter(t => t.correct).length / downs.length : null,
    ups: ups.length, downs: downs.length,
    streak, streakDir,
  };
}

function formatPct(n) {
  if (n == null) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}

function buildReport(stats) {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  const factorLines = [
    `  CVD direction:   ${stats.factorStats.cvdDir?.total    || 0} signals → ${formatPct(stats.factorStats.cvdDir?.total    > 0 ? stats.factorStats.cvdDir.correct    / stats.factorStats.cvdDir.total    : null)} win`,
    `  VWAP direction:  ${stats.factorStats.vwapDir?.total   || 0} signals → ${formatPct(stats.factorStats.vwapDir?.total   > 0 ? stats.factorStats.vwapDir.correct   / stats.factorStats.vwapDir.total   : null)} win`,
    `  1H structure:    ${stats.factorStats.structDir?.total || 0} signals → ${formatPct(stats.factorStats.structDir?.total > 0 ? stats.factorStats.structDir.correct / stats.factorStats.structDir.total : null)} win`,
    `  OI rising:       ${stats.factorStats.oiRising?.total  || 0} signals → ${formatPct(stats.factorStats.oiRising?.total  > 0 ? stats.factorStats.oiRising.correct  / stats.factorStats.oiRising.total  : null)} win`,
    `  Clean air:       ${stats.factorStats.cleanAir?.total  || 0} signals → ${formatPct(stats.factorStats.cleanAir?.total  > 0 ? stats.factorStats.cleanAir.correct  / stats.factorStats.cleanAir.total  : null)} win`,
  ];

  const hourLines = stats.bestHours.length > 0
    ? stats.bestHours.map(h => `  ${String(h.hour).padStart(2, '0')}:00–${String(h.hour + 1).padStart(2, '0')}:00 UTC: ${formatPct(h.rate)} (${h.total} signals)`)
    : ['  Not enough data yet'];

  const streakLine = stats.streak > 0
    ? `Current streak: ${stats.streak} ${stats.streakDir}S`
    : 'No streak data yet';

  const targetMsg = stats.winRate == null
    ? '*(accumulating baseline data — target: 60%+ on 100+ signals)*'
    : stats.winRate >= 0.60
      ? '✅ Above 60% target — strategy viable'
      : `⚠️ Below 60% target (${formatPct(stats.winRate)}) — threshold or factor tuning needed`;

  const lines = [
    `📊 **Poly BTC-5 Weekly Report — ${date}**`,
    SEP,
    '',
    `**THIS WEEK**`,
    `Bars evaluated:   ${stats.recent.total}`,
    `Signals fired:    ${stats.recent.signaled}  (${stats.recent.total > 0 ? ((stats.recent.signaled / stats.recent.total) * 100).toFixed(1) : '?'}% fire rate)`,
    `Resolved:         ${stats.recent.resolved}`,
    `Win rate (all):   **${formatPct(stats.winRate)}**  (${stats.correct}/${stats.total})`,
    `Win rate (high):  **${formatPct(stats.highTierWinRate)}**  (${stats.highCorrect}/${stats.highTotal})`,
    `UP signals:       ${stats.ups} → ${formatPct(stats.upWinRate)} win rate`,
    `DOWN signals:     ${stats.downs} → ${formatPct(stats.downWinRate)} win rate`,
    '',
    SEP,
    `**ALL TIME**`,
    `Total resolved:   ${stats.allTimeTotal} signals`,
    `Overall win rate: **${formatPct(stats.allTimeTotal > 0 ? stats.allTimeCorrect / stats.allTimeTotal : null)}**  (${stats.allTimeCorrect}/${stats.allTimeTotal})`,
    streakLine,
    '',
    targetMsg,
    '',
    SEP,
    `**FACTOR CORRELATION** *(all-time, signals only)*`,
    ...factorLines,
    '',
    SEP,
    `**BEST SESSION WINDOWS** *(min 3 signals to appear)*`,
    ...hourLines,
    '',
    SEP,
    `*Run \`!report\` in #poly-btc-5 to regenerate.*`,
    `*Run \`!trades\` to see recent evaluations.*`,
  ];

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!shouldRun()) {
    log('Not Monday 09:00 UTC — use --force to run manually');
    return;
  }

  if (!REPORT_HOOK) {
    log('ERROR: POLY_BTC_5_REPORT_WEBHOOK not set in .env');
    process.exit(1);
  }

  log('Generating weekly report...');

  const trades = readTrades();
  const stats  = computeStats(trades);
  const report = buildReport(stats);

  const footer = `Poly BTC-5 • Weekly Report • ${new Date().toUTCString().slice(5, 25)} UTC`;
  await postWebhook(REPORT_HOOK, 'info', report, footer);
  log('Report posted');

  if (SIGNALS_HOOK && SIGNALS_HOOK !== REPORT_HOOK) {
    const summary = [
      `📋 **Poly BTC-5 Weekly Report Posted**`,
      `See **#poly-btc-5-report** for the full breakdown.`,
      `This week: ${stats.recent.signaled} signals fired · Win rate: **${formatPct(stats.winRate)}** (${stats.correct}/${stats.total})`,
    ].join('\n');
    await postWebhook(SIGNALS_HOOK, 'info', summary, footer);
  }

  log('Done');
}

main().catch(e => { console.error('[poly-btc-5-report] Fatal:', e.message); process.exit(1); });
