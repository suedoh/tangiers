#!/usr/bin/env node
'use strict';

/**
 * scripts/research/xs-carry-test.js — spec 07 round 8: CROSS-SECTIONAL funding carry.
 *
 * The one carry structure executable on BloFin alone. BloFin has no spot and no
 * dated futures, so the BTC cash-and-carry of round 7 has no second leg there.
 * But it lists 88 perps whose funding rates differ enormously — measured live
 * 2026-08-04: ZK −16.47bp/8h (−180%/yr) to M +10.97bp/8h (+120%/yr), a 300%/yr
 * cross-sectional spread. So: LONG the perps that pay you to be long, SHORT the
 * perps that pay you to be short, dollar-neutral. Every leg is a perp.
 *
 * THE CENTRAL RISK, AND WHY THIS IS NOT ROUND 7. In the BTC cash-and-carry both
 * legs are the SAME asset, so price cancels almost exactly (measured basis P&L:
 * 0.000–0.002% per trade). Here the legs are DIFFERENT COINS. Long-ZK/short-M is
 * dollar-neutral but not risk-neutral, and extreme negative funding usually marks
 * a token in freefall — you would collect 180%/yr while the price halves. So the
 * price P&L of the basket is NOT assumed away: it is measured and reported as its
 * own column, and the verdict depends on carry surviving it.
 *
 * Universe: the 81 perps tradeable on BOTH venues (verified, not assumed).
 * History from Binance (BloFin serves none) via xs-carry-fetch.js.
 *
 * Costs: every rebalance closes and opens 2N legs. Perp maker 2bp / taker 6bp,
 * measured from real BloFin fills. Alt perps are thinner than BTC, so the taker
 * column is the realistic one and is reported alongside.
 *
 * Usage: node scripts/research/xs-carry-test.js [--legs 5] [--rebalance 3]
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(ROOT, '.market-data-cache', 'xs-corpus.json');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const LEGS = arg('legs', 5);            // per side
const REBAL = arg('rebalance', 3);      // settlements between rebalances (3 = daily)
const TRAIL = arg('trail', 21);         // settlements of trailing funding for the rank

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? NaN; };

function blockBoot(v, t, B = 4000) {
  if (v.length < 20) return [NaN, NaN];
  const blk = {};
  t.forEach((x, i) => { const b = Math.floor(x / (7 * 864e5)); (blk[b] = blk[b] || []).push(v[i]); });
  const keys = Object.keys(blk), out = [];
  for (let i = 0; i < B; i++) {
    let s = 0, n = 0;
    for (let j = 0; j < keys.length; j++) { const g = blk[keys[(Math.random() * keys.length) | 0]]; for (const x of g) { s += x; n++; } }
    out.push(s / n);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(B * .025)], out[Math.floor(B * .975)]];
}

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const symbols = corpus.symbols.filter(s => corpus.rows[s].length > 500);
console.log(`universe: ${symbols.length} symbols with >500 settlements`);

// Index by settlement time.
const bySym = {};
const allT = new Set();
for (const s of symbols) {
  bySym[s] = new Map();
  for (const r of corpus.rows[s]) { bySym[s].set(r.t, r); allT.add(r.t); }
}
const times = [...allT].sort((a, b) => a - b);
console.log(`settlement grid: ${times.length}  ${new Date(times[0]).toISOString().slice(0,10)} → ${new Date(times[times.length-1]).toISOString().slice(0,10)}\n`);

/** Trailing mean funding for `sym` over the TRAIL settlements ending before `ti`. */
function trailFunding(sym, ti) {
  const m = bySym[sym]; const out = [];
  for (let k = Math.max(0, ti - TRAIL); k < ti; k++) { const r = m.get(times[k]); if (r) out.push(r.r); }
  return out.length >= TRAIL * 0.6 ? mean(out) : null;
}

function run(feePerSide, label) {
  const periodRets = [], periodT = [], carryCol = [], priceCol = [];
  for (let ti = TRAIL; ti + REBAL < times.length; ti += REBAL) {
    // Rank on information available BEFORE this period.
    const ranked = [];
    for (const s of symbols) {
      const f = trailFunding(s, ti);
      const now = bySym[s].get(times[ti]);
      const later = bySym[s].get(times[ti + REBAL]);
      if (f == null || !now || !later || !(now.close > 0) || !(later.close > 0)) continue;
      ranked.push({ s, f, p0: now.close, p1: later.close });
    }
    if (ranked.length < LEGS * 3) continue;
    ranked.sort((a, b) => a.f - b.f);
    const longs = ranked.slice(0, LEGS);            // most NEGATIVE funding → paid to be long
    const shorts = ranked.slice(-LEGS);             // most POSITIVE funding → paid to be short

    // Funding actually received over the held settlements (sign: long pays when
    // funding > 0, so a long on negative funding RECEIVES −r).
    let carry = 0;
    for (const L of longs) for (let k = ti + 1; k <= ti + REBAL; k++) { const r = bySym[L.s].get(times[k]); if (r) carry += -r.r / LEGS; }
    for (const S of shorts) for (let k = ti + 1; k <= ti + REBAL; k++) { const r = bySym[S.s].get(times[k]); if (r) carry += r.r / LEGS; }

    // Price P&L of the dollar-neutral basket — NOT assumed to cancel.
    const longRet = mean(longs.map(x => x.p1 / x.p0 - 1));
    const shortRet = mean(shorts.map(x => x.p1 / x.p0 - 1));
    const price = longRet - shortRet;

    const cost = 2 * feePerSide * 2;   // open+close, both sides of the book
    periodRets.push(carry + price - cost);
    carryCol.push(carry); priceCol.push(price);
    periodT.push(times[ti]);
  }
  const perYear = (3 * 365) / REBAL;
  const [lo, hi] = blockBoot(periodRets, periodT);
  const wins = periodRets.filter(x => x > 0).length;
  console.log(`${label.padEnd(8)} n=${String(periodRets.length).padStart(4)}  `
    + `carry ${(mean(carryCol) * 100).toFixed(4).padStart(8)}%  `
    + `price ${(mean(priceCol) * 100).toFixed(4).padStart(9)}%  `
    + `cost ${(2 * feePerSide * 2 * 100).toFixed(3)}%  →  `
    + `net ${(mean(periodRets) * 100).toFixed(4).padStart(8)}%/period  `
    + `${(mean(periodRets) * perYear * 100).toFixed(1).padStart(7)}%/yr  `
    + `win ${(wins / periodRets.length * 100).toFixed(0).padStart(3)}%  `
    + `CI [${(lo * perYear * 100).toFixed(1)}, ${(hi * perYear * 100).toFixed(1)}]`);
  return { periodRets, periodT, carryCol, priceCol, perYear };
}

console.log(`config: ${LEGS} legs/side, rebalance every ${REBAL} settlements (${REBAL / 3} day), rank on ${TRAIL}-settlement trailing funding\n`);
console.log('fee      n      gross carry   basket price   cost        NET');
const maker = run(0.0002, 'maker');
const taker = run(0.0006, 'taker');

// ── does the carry survive the price leg? ───────────────────────────────────
console.log('\n═══ DOES THE CARRY SURVIVE THE PRICE LEG? ═══');
console.log(`mean carry per period   ${(mean(maker.carryCol) * 100).toFixed(4)}%`);
console.log(`mean price P&L          ${(mean(maker.priceCol) * 100).toFixed(4)}%   ← the un-hedged part`);
console.log(`price P&L sd            ${Math.sqrt(mean(maker.priceCol.map(x => (x - mean(maker.priceCol)) ** 2))) * 100}%`);
console.log(`ratio sd(price)/carry   ${(Math.sqrt(mean(maker.priceCol.map(x => (x - mean(maker.priceCol)) ** 2))) / Math.abs(mean(maker.carryCol))).toFixed(1)}×`);
console.log('  (round 7 BTC cash-and-carry: basis noise was 0.4× the carry — that is what a real hedge looks like)');

// ── regime ──────────────────────────────────────────────────────────────────
console.log('\n═══ REGIME ═══ (maker fees)');
const byYear = {};
maker.periodT.forEach((t, i) => { const y = new Date(t).getUTCFullYear(); (byYear[y] = byYear[y] || []).push(maker.periodRets[i]); });
for (const y of Object.keys(byYear).sort()) {
  const v = byYear[y];
  console.log(`  ${y}  n=${String(v.length).padStart(4)}  net ${(mean(v) * maker.perYear * 100).toFixed(1).padStart(8)}%/yr  win ${(v.filter(x => x > 0).length / v.length * 100).toFixed(0).padStart(3)}%`);
}

// ── worst case ──────────────────────────────────────────────────────────────
let eq = 1, peak = 1, mdd = 0;
for (const r of maker.periodRets) { eq *= (1 + r); peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
console.log(`\nequity curve (maker): ×${eq.toFixed(3)} over the window · max drawdown ${(mdd * 100).toFixed(1)}%`);
console.log(`worst single period: ${(Math.min(...maker.periodRets) * 100).toFixed(2)}%  ·  best: ${(Math.max(...maker.periodRets) * 100).toFixed(2)}%`);
