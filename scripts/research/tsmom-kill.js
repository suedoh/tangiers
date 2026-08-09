#!/usr/bin/env node
'use strict';

/**
 * scripts/research/tsmom-kill.js — kill-tests for the round-10b TSMOM lead.
 *
 * The raw grid showed 9mo/1wk at 60.0% CAGR vs 36.2% always-long (+23.8pp) with
 * a bootstrap CI excluding zero — the first directional cell in 292 to clear
 * that bar. Every prior lead in this project (funding round 2, 1h k=3 round 6,
 * 4h long-filter round 6b) looked equally good and died on the same four checks.
 * Apply them before believing anything.
 *
 *   1. PARAMETER STABILITY — the grid is already non-monotone (3mo −17.7pp,
 *      9mo +23.8pp). A real effect should not flip sign between neighbouring
 *      lookbacks. Sweep finely; if only a narrow spike works, it is fitted.
 *   2. REGIME — BTC rose ~10× over this window. A rule long 65–74% of the time
 *      inherits that for free. Split by year and check whether the edge exists
 *      anywhere the market was not rising.
 *   3. WALK-FORWARD — choose the lookback on the first half, apply it blind to
 *      the second. In-sample cell-picking across a 10-cell grid is exactly the
 *      multiple-comparisons trap this project has fallen into before.
 *   4. NON-OVERLAPPING SAMPLE — at 12mo/1mo there are ~71 observations and BTC
 *      had perhaps 3–4 major trends. Count the independent episodes, not the rows.
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const C = JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', 'research-1d.json'), 'utf8'));
const N = C.t.length;
const COST = 0.0008;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;

/** Run the rule; returns per-hold net returns, equity, and the always-long equity. */
function run(lbDays, holdD, from = 20, to = N) {
  let eq = 1, bh = 1, prevLong = null, flips = 0;
  const rets = [], bhRets = [], times = [];
  for (let i = Math.max(from, lbDays); i + holdD < to; i += holdD) {
    const long = (C.c[i] / C.c[i - lbDays] - 1) > 0;
    const fwd = C.c[i + holdD] / C.c[i] - 1;
    const cost = (prevLong === null || long !== prevLong) ? COST : 0;
    if (long !== prevLong) flips++;
    prevLong = long;
    const net = (long ? fwd : 0) - cost;
    eq *= (1 + net); bh *= (1 + fwd);
    rets.push(net); bhRets.push(fwd); times.push(C.t[i]);
  }
  const years = (rets.length * holdD) / 365;
  return {
    n: rets.length, flips, rets, bhRets, times,
    cagr: Math.pow(eq, 1 / years) - 1,
    bhCagr: Math.pow(bh, 1 / years) - 1,
  };
}

// ── 1. parameter stability ──────────────────────────────────────────────────
console.log('1) PARAMETER STABILITY — fine sweep of the lookback, 1-week holds');
console.log(`${'lookback'.padStart(9)} ${'CAGR'.padStart(8)} ${'B&H'.padStart(8)} ${'vs B&H'.padStart(9)}`);
const sweep = [];
for (let mo = 1; mo <= 15; mo++) {
  const r = run(Math.round(mo * 30.44), 7);
  sweep.push({ mo, delta: (r.cagr - r.bhCagr) * 100, cagr: r.cagr });
  const bar = r.cagr > r.bhCagr ? '█'.repeat(Math.min(30, Math.round((r.cagr - r.bhCagr) * 100 / 2))) : '';
  console.log(`${(mo + 'mo').padStart(9)} ${(r.cagr * 100).toFixed(1).padStart(7)}% ${(r.bhCagr * 100).toFixed(1).padStart(7)}% `
    + `${(((r.cagr - r.bhCagr) >= 0 ? '+' : '') + ((r.cagr - r.bhCagr) * 100).toFixed(1) + 'pp').padStart(9)} ${bar}`);
}
const pos = sweep.filter(s => s.delta > 0).length;
const signFlips = sweep.slice(1).filter((s, i) => Math.sign(s.delta) !== Math.sign(sweep[i].delta)).length;
console.log(`  → ${pos}/15 lookbacks beat B&H; ${signFlips} sign flips across neighbours`);
console.log(`  → ${signFlips >= 4 ? '⚠️  UNSTABLE — the sign flips repeatedly across adjacent parameters' : 'reasonably stable across the neighbourhood'}`);

// ── 2. regime ───────────────────────────────────────────────────────────────
console.log('\n2) REGIME — is the edge anywhere the market was not rising?');
for (const [lbMo, holdD] of [[9, 7], [12, 7]]) {
  const r = run(Math.round(lbMo * 30.44), holdD);
  console.log(`  ${lbMo}mo/${holdD}d:`);
  const byYear = {};
  r.times.forEach((t, i) => { const y = new Date(t).getUTCFullYear(); (byYear[y] = byYear[y] || { s: [], b: [] }); byYear[y].s.push(r.rets[i]); byYear[y].b.push(r.bhRets[i]); });
  for (const y of Object.keys(byYear).sort()) {
    const v = byYear[y];
    const sAnn = mean(v.s) * (365 / holdD) * 100, bAnn = mean(v.b) * (365 / holdD) * 100;
    console.log(`    ${y}  n=${String(v.s.length).padStart(3)}  rule ${sAnn.toFixed(0).padStart(5)}%/yr  vs B&H ${bAnn.toFixed(0).padStart(5)}%/yr  `
      + `${sAnn > bAnn ? '✓' : '✗'}  ${bAnn < 0 ? '(market DOWN — the real test)' : ''}`);
  }
}

// ── 3. walk-forward ─────────────────────────────────────────────────────────
console.log('\n3) WALK-FORWARD — pick the lookback on the first half, apply blind to the second');
const mid = Math.floor(N / 2);
let bestMo = null, bestDelta = -Infinity;
for (let mo = 1; mo <= 15; mo++) {
  const r = run(Math.round(mo * 30.44), 7, 20, mid);
  const d = (r.cagr - r.bhCagr) * 100;
  if (d > bestDelta) { bestDelta = d; bestMo = mo; }
}
console.log(`  first half picks: ${bestMo}mo (+${bestDelta.toFixed(1)}pp in-sample)`);
const oos = run(Math.round(bestMo * 30.44), 7, mid, N);
const oosDelta = (oos.cagr - oos.bhCagr) * 100;
console.log(`  second half OOS: rule ${(oos.cagr * 100).toFixed(1)}% vs B&H ${(oos.bhCagr * 100).toFixed(1)}% → ${(oosDelta >= 0 ? '+' : '') + oosDelta.toFixed(1)}pp`);
console.log(`  → ${oosDelta > 0 ? '✓ survives out of sample' : '✗ FAILS out of sample — the in-sample pick did not transfer'}`);

// ── 4. independent episodes ─────────────────────────────────────────────────
console.log('\n4) HOW MANY INDEPENDENT BETS IS THIS REALLY?');
for (const [lbMo, holdD] of [[9, 7], [12, 30]]) {
  const r = run(Math.round(lbMo * 30.44), holdD);
  console.log(`  ${lbMo}mo/${holdD}d: ${r.n} observations but only ${r.flips} position changes`);
  console.log(`    → the entire result rests on ~${r.flips} independent decisions, not ${r.n}`);
}
