#!/usr/bin/env node
'use strict';

/**
 * scripts/research/lead-tests.js — the gates a surviving lead must pass (spec 07).
 *
 * Round 3 left one candidate alive: H9-trendHiVol on 4h bars — momentum sign
 * conditioned on the top-30% ATR percentile. Hit rate and clustered CIs are not
 * enough to trade it. This runs the four tests that decide whether a lead is an
 * edge, each of which has killed a previous candidate:
 *
 *   1. CAPACITY   — hit rate per SIGNAL is meaningless if signals overlap. With a
 *                   96h horizon and a signal every 4h, most "trades" cannot be
 *                   taken. Walks a non-overlapping book: take a signal, stay in
 *                   until the barrier resolves, only then look again. Reports
 *                   trades/year and R/year, which is what capital actually earns.
 *   2. FUNDING    — perp funding is charged every 8h and is NOT in the barrier
 *                   label. At 11.7% annualised and ~64× notional-to-risk (k=1),
 *                   a multi-day hold can cost more than the entire gross edge.
 *   3. WALKFWD    — expanding-window out-of-sample by year. Chronological halves
 *                   are too coarse; the 1d order-flow lead passed halves and died.
 *   4. SENSITIVITY— the 0.7 percentile and the momentum lookback were choices. If
 *                   the edge exists only at those exact cut-points it is fitted.
 *                   Every grid cell counts toward the cumulative FDR family.
 *
 * Usage:
 *   node scripts/research/lead-tests.js --set 4h-k1
 *   node scripts/research/lead-tests.js --set 4h-k2 --json out.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const SET      = arg('set', '4h-k1');
const K        = Number(SET.split('-k')[1]);
const LABEL_MS = 300_000;          // label series is 5m bars
const FEE      = 0.0008;           // 6bp taker in + 2bp maker out, of notional

const ds = JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', `ds-${SET}.json`), 'utf8'));
const rows = ds.rows;
const funding = JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', 'funding-full.json'), 'utf8'));

const medAtr = [...rows.map(r => r.atrPct)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
const feeR   = FEE / (K * medAtr);
const breakEven = (1 + feeR) / 2;

// The lead, stated once. atrPctl>0.7 AND momentum sign, per-row.
const rule = (r, pctl = 0.7, momField = 'ret24h') =>
  (r.atrPctl > pctl ? (r[momField] > 0 ? 'long' : r[momField] < 0 ? 'short' : null) : null);

const won = (side, r) => (side === 'long') === (r.upFirst === 1);

// ─── funding: sum the settlements that land inside the hold ──────────────────
// Long pays when the rate is positive; short receives. Converted to R by the
// same notional/risk ratio that sets the fee, so it is directly comparable.
const fT = funding.map(f => f.t);
function fundingR(row, side, holdMs) {
  let lo = 0, hi = fT.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fT[m] < row.t) lo = m + 1; else hi = m; }
  let sum = 0;
  for (let i = lo; i < funding.length && funding[i].t <= row.t + holdMs; i++) sum += funding[i].r;
  const notionalToRisk = 1 / (K * row.atrPct);
  return (side === 'long' ? sum : -sum) * notionalToRisk;
}

// ─── 1+2. capacity and funding, on a non-overlapping book ────────────────────
function capacityBook(pctl = 0.7, momField = 'ret24h') {
  let busyUntil = 0;
  const taken = [];
  for (const r of rows) {
    if (r.t < busyUntil) continue;                 // still in a position
    const side = rule(r, pctl, momField);
    if (!side) continue;
    const holdMs = (r.barsToLabel || 0) * LABEL_MS;
    const grossR = won(side, r) ? 1 : -1;
    const fund = fundingR(r, side, holdMs);
    taken.push({ t: r.t, side, grossR, feeR, fundR: fund, netR: grossR - feeR - fund, holdH: holdMs / 3.6e6 });
    busyUntil = r.t + holdMs;
  }
  const years = (rows[rows.length - 1].t - rows[0].t) / (365.25 * 86_400_000);
  const sum = f => taken.reduce((s, x) => s + x[f], 0);
  const wins = taken.filter(x => x.grossR > 0).length;
  return {
    n: taken.length, years,
    perYear: taken.length / years,
    hit: wins / taken.length,
    grossR: sum('grossR'), feeR: sum('feeR'), fundR: sum('fundR'), netR: sum('netR'),
    netPerTrade: sum('netR') / taken.length,
    netPerYear: sum('netR') / years,
    meanHoldH: sum('holdH') / taken.length,
    taken,
  };
}

// ─── 3. expanding-window walk-forward by calendar year ───────────────────────
function walkForward() {
  const yrs = [...new Set(rows.map(r => new Date(r.t).getUTCFullYear()))].sort();
  const out = [];
  for (let i = 1; i < yrs.length; i++) {
    const y = yrs[i];
    const test = rows.filter(r => new Date(r.t).getUTCFullYear() === y);
    let n = 0, w = 0, al = 0;
    for (const r of test) {
      const s = rule(r); if (!s) continue;
      n++; if (won(s, r)) w++; if (r.upFirst === 1) al++;
    }
    if (n < 30) continue;
    out.push({ year: y, n, hit: w / n, alwaysLong: al / n, eR: (2 * (w / n) - 1) - feeR });
  }
  return out;
}

// ─── 4. sensitivity to the two chosen cut-points ─────────────────────────────
function sensitivity() {
  const pctls = [0.5, 0.6, 0.7, 0.8, 0.9];
  const moms  = ['mom1', 'mom2', 'mom3'];
  const grid = [];
  for (const p of pctls) for (const m of moms) {
    let n = 0, w = 0, al = 0;
    for (const r of rows) {
      const s = rule(r, p, m); if (!s) continue;
      n++; if (won(s, r)) w++; if (r.upFirst === 1) al++;
    }
    if (!n) continue;
    grid.push({ pctl: p, mom: m, n, hit: w / n, alwaysLong: al / n, eR: (2 * (w / n) - 1) - feeR });
  }
  return grid;
}

// ─── report ──────────────────────────────────────────────────────────────────
const pc = x => (100 * x).toFixed(1) + '%';
const sg = x => (x >= 0 ? '+' : '') + x.toFixed(3);

console.log(`\n═══ LEAD TESTS — ${SET} · H9-trendHiVol (atrPctl>0.7 × momentum sign)`);
console.log(`    ${rows.length} bars · ${new Date(rows[0].t).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1].t).toISOString().slice(0, 10)}`);
console.log(`    median ATR ${pc(medAtr)} · fee ${feeR.toFixed(3)}R · break-even ${pc(breakEven)}`);
console.log(`    NOTE: at ${SET.split('-')[0]}, mom2/"ret24h" = ${ds.meta.momentumBars[1]} bars = ${ds.meta.momentumSpans.mom2}\n`);

const cap = capacityBook();
console.log('── TEST 1+2: non-overlapping book, fees AND funding charged');
console.log(`   signals if every bar were tradeable : ${rows.filter(r => rule(r)).length}`);
console.log(`   actually tradeable (no overlap)     : ${cap.n}  (${cap.perYear.toFixed(1)}/yr over ${cap.years.toFixed(1)}y)`);
console.log(`   mean hold                           : ${cap.meanHoldH.toFixed(1)}h`);
console.log(`   hit rate                            : ${pc(cap.hit)}  (break-even ${pc(breakEven)})`);
console.log(`   gross                               : ${sg(cap.grossR)}R`);
console.log(`   fees                                : ${sg(-cap.feeR)}R`);
console.log(`   funding                             : ${sg(-cap.fundR)}R`);
console.log(`   NET                                 : ${sg(cap.netR)}R  =  ${sg(cap.netPerTrade)}R/trade  ·  ${sg(cap.netPerYear)}R/year`);
console.log(`   at 1% risk/trade that is            : ${(cap.netPerYear).toFixed(1)}% of account per year\n`);

console.log('── TEST 3: expanding walk-forward by year');
const wf = walkForward();
console.log('   year     n     hit     alwaysLong   E[R]');
for (const y of wf) {
  console.log(`   ${y.year}  ${String(y.n).padEnd(5)} ${pc(y.hit).padEnd(7)} ${pc(y.alwaysLong).padEnd(12)} ${sg(y.eR)}  ${y.eR > 0 ? '' : '← loses'}`);
}
const pos = wf.filter(y => y.eR > 0).length;
console.log(`   ${pos}/${wf.length} years positive\n`);

console.log('── TEST 4: sensitivity to the two chosen cut-points');
console.log('   atrPctl  mom     n      hit     E[R]     vs always-long');
for (const g of sensitivity()) {
  const lift = 100 * (g.hit - g.alwaysLong);
  const star = (g.pctl === 0.7 && g.mom === 'mom2') ? '  ← the chosen cell' : '';
  console.log(`   ${g.pctl.toFixed(1)}      ${g.mom}  ${String(g.n).padEnd(6)} ${pc(g.hit).padEnd(7)} ${sg(g.eR).padEnd(8)} ${(lift >= 0 ? '+' : '') + lift.toFixed(1)}pp${star}`);
}

// ─── 5. the test that matters: capacity AT EVERY cut-point ───────────────────
// Per-signal expectancy rises monotonically with the vol threshold, but higher
// thresholds fire less often. Only a non-overlapping book, charged fees and
// funding, says whether the stronger cells survive contact with reality.
console.log('\n── TEST 5: non-overlapping book at every cut-point (fees + funding charged)');
console.log('   atrPctl  mom    tradeable  /yr    hit     net/trade  net/year  account%/yr');
let best = null;
for (const p of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  for (const m of ['mom2', 'mom3']) {
    const c = capacityBook(p, m);
    if (c.n < 50) continue;
    if (!best || c.netPerYear > best.c.netPerYear) best = { p, m, c };
    console.log(`   ${p.toFixed(1)}      ${m}  ${String(c.n).padEnd(10)} ${c.perYear.toFixed(0).padEnd(6)} ${pc(c.hit).padEnd(7)} ${sg(c.netPerTrade).padEnd(10)} ${sg(c.netPerYear).padEnd(9)} ${c.netPerYear.toFixed(1)}%`);
  }
}
if (best) {
  console.log(`\n   best non-overlapping cell: atrPctl>${best.p} ${best.m} → ${sg(best.c.netPerYear)}R/yr`
    + ` (${best.c.perYear.toFixed(0)} trades/yr, hit ${pc(best.c.hit)} vs break-even ${pc(breakEven)})`);
  console.log(`   gross ${sg(best.c.grossR)}R · fees ${sg(-best.c.feeR)}R · funding ${sg(-best.c.fundR)}R`);
}

// ─── 6. honest out-of-sample: CHOOSE on early data, SCORE on late data ───────
// Test 5's winner is the maximum of a 10-cell grid picked after seeing results,
// so its number is biased upward by construction. The only way to know what it
// is worth is to make the choice with early data only and never touch the tail
// until the choice is locked. Split at 60% of the calendar.
console.log('\n── TEST 6: out-of-sample — cut-point chosen on early data only');
const splitT = rows[0].t + 0.6 * (rows[rows.length - 1].t - rows[0].t);
const allRows = rows;

function bookOn(subset, p, m) {
  const saved = rows.length;
  let busyUntil = 0; const taken = [];
  for (const r of subset) {
    if (r.t < busyUntil) continue;
    const side = rule(r, p, m); if (!side) continue;
    const holdMs = (r.barsToLabel || 0) * LABEL_MS;
    const fund = fundingR(r, side, holdMs);
    taken.push({ netR: (won(side, r) ? 1 : -1) - feeR - fund, win: won(side, r), up: r.upFirst === 1, side });
    busyUntil = r.t + holdMs;
  }
  void saved;
  const yrs = subset.length ? (subset[subset.length - 1].t - subset[0].t) / (365.25 * 86_400_000) : 1;
  const net = taken.reduce((s, x) => s + x.netR, 0);
  const wins = taken.filter(x => x.win).length;
  // always-long on the SAME schedule: same entries, forced long.
  const alWins = taken.filter(x => x.up).length;
  return { n: taken.length, hit: taken.length ? wins / taken.length : 0,
           alwaysLong: taken.length ? alWins / taken.length : 0,
           net, perYear: net / yrs, yrs };
}

const early = allRows.filter(r => r.t < splitT);
const late  = allRows.filter(r => r.t >= splitT);
let pick = null;
for (const p of [0.5, 0.6, 0.7, 0.8, 0.9]) for (const m of ['mom2', 'mom3']) {
  const b = bookOn(early, p, m);
  if (b.n < 40) continue;
  if (!pick || b.perYear > pick.b.perYear) pick = { p, m, b };
}
console.log(`   in-sample  ${new Date(early[0].t).toISOString().slice(0, 10)} → ${new Date(early[early.length - 1].t).toISOString().slice(0, 10)}`
  + `  → chooses atrPctl>${pick.p} ${pick.m}  (${sg(pick.b.perYear)}R/yr, hit ${pc(pick.b.hit)}, n=${pick.b.n})`);
const oos = bookOn(late, pick.p, pick.m);
console.log(`   OUT-OF-SAMPLE ${new Date(late[0].t).toISOString().slice(0, 10)} → ${new Date(late[late.length - 1].t).toISOString().slice(0, 10)}`);
console.log(`     n=${oos.n} over ${oos.yrs.toFixed(1)}y · hit ${pc(oos.hit)} · always-long on same entries ${pc(oos.alwaysLong)}`
  + ` · lift ${(100 * (oos.hit - oos.alwaysLong) >= 0 ? '+' : '') + (100 * (oos.hit - oos.alwaysLong)).toFixed(1)}pp`);
console.log(`     net ${sg(oos.net)}R = ${sg(oos.perYear)}R/yr  →  ${oos.perYear > 0 ? 'SURVIVES' : 'FAILS'} out of sample`);

if (arg('json')) {
  fs.writeFileSync(arg('json'), JSON.stringify({
    set: SET, medAtr, feeR, breakEven,
    capacity: { ...cap, taken: undefined }, walkForward: wf, sensitivity: sensitivity(),
  }, null, 2));
}
