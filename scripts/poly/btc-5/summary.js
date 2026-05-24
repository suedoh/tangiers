'use strict';

/**
 * Poly BTC-5 — performance summary over the last N days.
 *
 * Reads poly-btc-5-trades.json directly (not Mongo, so this works on partner
 * machines too). Computes Wilson 95% CI on win rate, Brier score, ECE,
 * direction split, score split, and hour-of-day buckets.
 *
 * Two modes:
 *   - Module: require('./summary').computeSummary({ days }) → formatted string
 *   - CLI:    node scripts/poly/btc-5/summary.js --days 14
 *
 * The Discord !summary command in handlers/poly-btc-5.js calls the module
 * directly and posts the result to the invoking channel.
 */

const fs   = require('fs');
const path = require('path');
const { ROOT } = require('../../lib/env');

const TRADES_FILE = path.join(ROOT, 'poly-btc-5-trades.json');

// Wilson score interval at 95% (z = 1.96). Standard small-sample binomial CI;
// matches audit methodology (memory: feedback_audit_methodology).
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p     = k / n;
  const denom = 1 + (z * z) / n;
  const ctr   = (p + (z * z) / (2 * n)) / denom;
  const mar   = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, ctr - mar), Math.min(1, ctr + mar)];
}

function fmtPct(p)    { return `${(p * 100).toFixed(1)}%`; }
function fmtCI(k, n)  { const [lo, hi] = wilson(k, n); return `${fmtPct(k / n)} [${fmtPct(lo)}–${fmtPct(hi)}]`; }

// Probability is not stored in the trade record; recompute from the same
// formula trigger-check.js uses at signal time.
function predictedProb(t) {
  const edge = Math.abs((t.upScore ?? 0) - (t.downScore ?? 0));
  return Math.min(88, 50 + edge * 9) / 100;
}

// Brier score over signaled+resolved trades (lower is better).
function brier(trades) {
  if (trades.length === 0) return null;
  let sum = 0;
  for (const t of trades) {
    const p = predictedProb(t);
    const o = t.correct ? 1 : 0;
    sum += (p - o) ** 2;
  }
  return sum / trades.length;
}

// Expected Calibration Error — bucket by predicted probability, compare mean
// predicted vs mean actual within each bucket, weight by bucket size.
function ece(trades) {
  if (trades.length === 0) return null;
  const buckets = new Map();
  for (const t of trades) {
    const p   = predictedProb(t);
    const key = Math.floor(p * 10) / 10; // 0.0, 0.1, ... 0.9
    if (!buckets.has(key)) buckets.set(key, { n: 0, sumP: 0, k: 0 });
    const b = buckets.get(key);
    b.n++;
    b.sumP += p;
    b.k += t.correct ? 1 : 0;
  }
  const N = trades.length;
  let err = 0;
  for (const b of buckets.values()) {
    const meanP = b.sumP / b.n;
    const meanA = b.k / b.n;
    err += (b.n / N) * Math.abs(meanP - meanA);
  }
  return err;
}

function bucketBy(trades, keyFn) {
  const m = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, { n: 0, k: 0 });
    const b = m.get(k);
    b.n++;
    if (t.correct) b.k++;
  }
  return m;
}

function computeSummary({ days = 7 } = {}) {
  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const cohort = trades.filter(t => t.signaled && t.outcome !== null
    && new Date(t.barOpen).getTime() >= cutoff);

  if (cohort.length === 0) {
    return `📊 **Poly BTC-5 — Performance Summary** (last ${days}d)\nNo resolved signals in this window yet.`;
  }

  const wins = cohort.filter(t => t.correct).length;
  const br   = brier(cohort);
  const ec   = ece(cohort);

  // $-EV cohort: signals that captured a Polymarket entry ask at fire time.
  // Pre-2026-05-24 signals don't have this (A1 ships forward-only). Need ≥30
  // for the metric to be more than anecdote.
  const evCohort = cohort.filter(t => typeof t.entryAsk === 'number');
  let evStats = null;
  if (evCohort.length >= 30) {
    const meanAsk = evCohort.reduce((s, t) => s + t.entryAsk, 0) / evCohort.length;
    const pnls    = evCohort.map(t => t.correct ? (1 - t.entryAsk) : -t.entryAsk);
    const meanPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const totPnl  = pnls.reduce((a, b) => a + b, 0);
    const meanSpread = evCohort.reduce((s, t) => s + (t.entrySpreadBps || 0), 0) / evCohort.length;
    evStats = { n: evCohort.length, meanAsk, meanPnl, totPnl, meanSpread };
  }

  // Direction split
  const upTrades   = cohort.filter(t => t.prediction === 'UP');
  const downTrades = cohort.filter(t => t.prediction === 'DOWN');

  // Score split
  const scoreBuckets = bucketBy(cohort, t => t.score);
  const scoreKeys    = [...scoreBuckets.keys()].sort();

  // Hour-of-day buckets (≥5 signals to be reportable)
  const hourBuckets = bucketBy(cohort, t => new Date(t.barOpen).getUTCHours());
  const reportableHours = [...hourBuckets.entries()].filter(([, v]) => v.n >= 5);
  reportableHours.sort(([, a], [, b]) => (b.k / b.n) - (a.k / a.n));
  const bestHour  = reportableHours[0];
  const worstHour = reportableHours[reportableHours.length - 1];

  const lines = [];
  lines.push(`📊 **Poly BTC-5 — Performance Summary** (last ${days}d)`);
  lines.push('');
  lines.push(`**Signals:** ${cohort.length}  |  **Win rate:** ${fmtCI(wins, cohort.length)} (Wilson 95%)`);
  lines.push(`**Brier:** ${br.toFixed(3)}  |  **ECE:** ${(ec * 100).toFixed(1)}pp  (lower is better for both)`);
  if (evStats) {
    const sign = evStats.meanPnl >= 0 ? '+' : '';
    lines.push(`**$-EV/signal:** ${sign}$${evStats.meanPnl.toFixed(3)}  |  **Total P&L:** ${evStats.totPnl >= 0 ? '+' : ''}$${evStats.totPnl.toFixed(2)} over ${evStats.n} signals  |  Mean ask ${evStats.meanAsk.toFixed(2)}, spread ${evStats.meanSpread.toFixed(0)}bps`);
  } else if (evCohort.length > 0) {
    lines.push(`*$-EV: ${evCohort.length} signals captured entry — need 30+ before showing*`);
  }
  lines.push('');

  lines.push('**Direction**');
  if (upTrades.length > 0)   lines.push(`🟢 UP    ${String(upTrades.length).padStart(3)} · ${fmtCI(upTrades.filter(t => t.correct).length, upTrades.length)}`);
  if (downTrades.length > 0) lines.push(`🔴 DOWN  ${String(downTrades.length).padStart(3)} · ${fmtCI(downTrades.filter(t => t.correct).length, downTrades.length)}`);
  lines.push('');

  lines.push('**Score**');
  for (const s of scoreKeys) {
    const b = scoreBuckets.get(s);
    lines.push(`${s}/6  ${String(b.n).padStart(3)} · ${fmtCI(b.k, b.n)}`);
  }
  lines.push('');

  if (bestHour && worstHour && bestHour !== worstHour) {
    const [bh, bv] = bestHour;
    const [wh, wv] = worstHour;
    lines.push('**Hour of day (UTC, n≥5)**');
    lines.push(`🟢 best  ${String(bh).padStart(2, '0')}:00  ${fmtCI(bv.k, bv.n)}`);
    lines.push(`🔴 worst ${String(wh).padStart(2, '0')}:00  ${fmtCI(wv.k, wv.n)}`);
  }

  return lines.join('\n');
}

// CLI
if (require.main === module) {
  const idx  = process.argv.indexOf('--days');
  const days = idx >= 0 ? parseInt(process.argv[idx + 1], 10) || 7 : 7;
  console.log(computeSummary({ days }));
}

module.exports = { computeSummary };
