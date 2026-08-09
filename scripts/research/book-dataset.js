#!/usr/bin/env node
'use strict';

/**
 * scripts/research/book-dataset.js — Path B infrastructure: turn the order-book
 * corpus into a labelled feature matrix for the selective-prediction harness.
 *
 * WHY THIS IS THE ONE TEST LEFT. Rounds 1–9 covered 292 FDR cells and every
 * feature in them was a transformation of OHLCV — momentum, volatility, VWAP
 * distance, taker imbalance from aggregated klines, funding. The order-book
 * corpus is the first feature family that is NOT: resting-liquidity imbalance at
 * four depths, book slope, microprice deviation, per-minute large-trade flags,
 * and liquidation cascades. Binance serves no order-book history, so this corpus
 * exists only because the recorder has been running since 2026-07-26 — it cannot
 * be backfilled, and it is genuinely independent evidence.
 *
 * ⛔ THE MATURITY GUARD. Per rebuild/07-signal-research.md §07.5, this corpus is
 * not to be analysed before ~30 days of coverage. That rule was written BEFORE
 * the data existed, precisely so a thin, noisy early read could not become "one
 * more month and it'll be clear". This script therefore builds the dataset at any
 * coverage but REFUSES to emit it as analysis-ready below MIN_DAYS unless
 * --force is passed, and stamps the coverage into the output either way.
 *
 * ⚠️ KNOWN CORPUS DEFECT, excluded automatically: rows from 2026-07-26 17:35 →
 * 2026-07-27 12:44 UTC have structurally empty `liq` and `liqAll` columns — the
 * liquidation feed was on the wrong Binance route. Those are MISSING, not quiet,
 * and reading them as zero would fabricate a signal.
 *
 * Labels: symmetric ±k×ATR(1m-derived) barrier, resolved on Binance 1m klines
 * strictly AFTER the feature minute. Same convention as every prior round, so
 * results are directly comparable and the same FDR family applies.
 *
 * Usage:
 *   node scripts/research/book-dataset.js --k 1 --horizon 60
 *   node scripts/research/book-dataset.js --status
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
loadEnv();
const { getKlinesRange } = require('../lib/binance');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const K = Number(arg('k', 1));
const HORIZON_MIN = Number(arg('horizon', 60));
const MIN_DAYS = 30;
const FORCE = process.argv.includes('--force');
const STATUS = process.argv.includes('--status');

const DIR = path.join(ROOT, 'data', 'orderbook');
const OUT = path.join(ROOT, '.market-data-cache', `book-ds-k${K}.json`);

// Liquidation feed was mis-routed until this instant — see refactors/2026-07-27-liq-stream-route-fix.md
const LIQ_VALID_FROM = Date.parse('2026-07-27T12:44:00Z');

// Feature columns straight from the recorder. `mark`/`funding`/`basisBps` are
// kept because they are book-side state, not OHLCV derivations.
const FEATS = [
  'obi1', 'obi5', 'obi5sd', 'obi20', 'obi20sd', 'obi20last', 'obiTouch', 'obiTouchSd',
  'spread', 'spreadMax', 'dBid', 'dAsk', 'slopeBid', 'slopeAsk', 'mpDev',
  'trades', 'tvol', 'tbuy', 'tmax', 'tbigBuy', 'tbigSell',
  'liqLong', 'liqShort', 'liqN', 'liqNotional',
  'liqAllLong', 'liqAllShort', 'liqAllN', 'liqAllNotional',
  'funding', 'basisBps',
];

function loadRows() {
  if (!fs.existsSync(DIR)) return [];
  const rows = [];
  for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.ndjson')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip torn line */ }
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

(async () => {
  const rows = loadRows();
  if (!rows.length) { console.error('no corpus rows found in data/orderbook/'); process.exit(1); }
  const coverageDays = (rows[rows.length - 1].t - rows[0].t) / 864e5;
  const mature = coverageDays >= MIN_DAYS;

  console.log(`corpus: ${rows.length} minute rows · ${coverageDays.toFixed(1)} days `
    + `(${new Date(rows[0].t).toISOString().slice(0, 16)} → ${new Date(rows[rows.length - 1].t).toISOString().slice(0, 16)})`);
  console.log(`maturity guard: ${MIN_DAYS}d required — ${mature ? '✅ MATURE, analysis-ready' : `🔒 NOT YET (${(MIN_DAYS - coverageDays).toFixed(1)}d to go)`}`);

  if (STATUS) {
    const withLiq = rows.filter(r => r.t >= LIQ_VALID_FROM).length;
    console.log(`rows with a valid liquidation feed: ${withLiq} (${(withLiq / rows.length * 100).toFixed(1)}%)`);
    const gaps = rows.slice(1).filter((r, i) => r.t - rows[i].t > 120000).length;
    console.log(`gaps >2min: ${gaps}`);
    return;
  }

  // ── labels from Binance 1m klines ──
  console.error('[book-ds] fetching 1m klines for labels …');
  const k1 = await getKlinesRange(rows[0].t - 2 * 3600e3, rows[rows.length - 1].t + HORIZON_MIN * 60e3 + 3600e3, '1m');
  const byOpen = new Map(k1.map(b => [b.openTime, b]));
  const opens = k1.map(b => b.openTime);
  console.error(`[book-ds] ${k1.length} 1m bars`);

  // ATR(14) on 1m, computed from completed bars strictly before each row.
  function atrAt(ms) {
    let i = opens.length - 1;
    while (i >= 0 && opens[i] >= ms) i--;
    if (i < 15) return null;
    let s = 0;
    for (let j = i - 13; j <= i; j++) {
      const b = k1[j], p = k1[j - 1];
      s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    }
    return s / 14;
  }

  function label(ms, px, atr) {
    const up = px + K * atr, dn = px - K * atr;
    for (let m = ms + 60000; m <= ms + HORIZON_MIN * 60000; m += 60000) {
      const b = byOpen.get(m); if (!b) continue;
      const hu = b.high >= up, hd = b.low <= dn;
      if (hu && hd) return null;                 // ambiguous — never guess
      if (hu) return 1;
      if (hd) return 0;
    }
    return null;                                  // unresolved in horizon
  }

  const out = [];
  let noAtr = 0, unres = 0, liqExcluded = 0;
  for (const r of rows) {
    const bar = byOpen.get(Math.floor(r.t / 60000) * 60000);
    const px = bar ? bar.close : r.mark;
    if (!(px > 0)) continue;
    const atr = atrAt(r.t);
    if (!atr) { noAtr++; continue; }
    const y = label(Math.floor(r.t / 60000) * 60000, px, atr);
    if (y == null) { unres++; continue; }

    const rec = { t: r.t, price: px, atrPct: atr / px, upFirst: y };
    const liqOk = r.t >= LIQ_VALID_FROM;
    if (!liqOk) liqExcluded++;
    for (const f of FEATS) {
      const isLiq = f.startsWith('liq');
      rec[f] = (isLiq && !liqOk) ? null : (r[f] ?? null);   // null, never 0 — missing is not quiet
    }
    out.push(rec);
  }

  const base = out.filter(r => r.upFirst === 1).length / out.length;
  console.log(`\nlabelled rows: ${out.length}  (excluded: ${noAtr} no-ATR, ${unres} unresolved/ambiguous)`);
  console.log(`liq columns nulled on ${liqExcluded} early rows (feed was mis-routed — missing, not zero)`);
  console.log(`base rate up-first: ${(base * 100).toFixed(2)}%   (a driftless barrier should sit near 50%)`);
  // ── The economics, BEFORE any model is trained ──────────────────────────
  // Round 6's lesson applied prospectively: predictability is worthless if the
  // barrier is too tight to pay its toll. At 1m ATR the fee dwarfs the risk unit,
  // so most of the k-grid is unwinnable at ANY hit rate — print that up front so
  // nobody spends a month modelling a cell that cannot clear by construction.
  const mAtr = out.reduce((s, r) => s + r.atrPct, 0) / out.length;
  console.log(`\nmedian ATR(1m): ${(mAtr * 100).toFixed(4)}% of price`);
  console.log('barrier economics (6bp taker in + 2bp maker out):');
  console.log(`  ${'k×ATR'.padEnd(8)} ${'barrier'.padStart(9)} ${'fee (R)'.padStart(9)} ${'break-even hit'.padStart(15)}`);
  for (const kk of [1, 5, 10, 21, 40, 80]) {
    const fee = 0.0008 / (kk * mAtr);
    const be = 50 * (1 + fee);
    console.log(`  ${String(kk).padEnd(8)} ${(kk * mAtr * 100).toFixed(3).padStart(8)}% ${fee.toFixed(3).padStart(9)} `
      + `${(be > 100 ? 'IMPOSSIBLE' : be.toFixed(1) + '%').padStart(15)}`);
  }
  const kMin = 0.0008 / (0.1 * mAtr);
  console.log(`  → the barrier must be ≥ ${kMin.toFixed(0)}×ATR(1m) = ${(kMin * mAtr * 100).toFixed(2)}% of price`);
  console.log('    for the fee to fall to 0.1R (a ~55% break-even). Anything tighter is');
  console.log('    unwinnable regardless of how well the book predicts it.');

  fs.writeFileSync(OUT, JSON.stringify({
    meta: {
      builtAt: new Date().toISOString(), k: K, horizonMin: HORIZON_MIN,
      coverageDays: +coverageDays.toFixed(2), mature, minDaysRequired: MIN_DAYS,
      rows: out.length, baseRateUpFirst: +base.toFixed(4), features: FEATS,
      liqValidFrom: new Date(LIQ_VALID_FROM).toISOString(),
    },
    rows: out,
  }));
  console.log(`\n→ ${OUT}`);
  if (!mature && !FORCE) {
    console.log(`\n🔒 Dataset written but NOT analysis-ready: ${coverageDays.toFixed(1)}d < ${MIN_DAYS}d.`);
    console.log('   The guard exists so a thin early read cannot become "one more month and it will be clear".');
    console.log('   Re-run after the corpus matures, or pass --force to override deliberately.');
  }
})().catch(e => { console.error('book-dataset failed:', e.message); process.exit(1); });
