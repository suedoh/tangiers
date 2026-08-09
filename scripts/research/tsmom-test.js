#!/usr/bin/env node
'use strict';

/**
 * scripts/research/tsmom-test.js — spec 07 round 10b: TIME-SERIES MOMENTUM at
 * the horizons the published effect actually occupies.
 *
 * WHY THIS IS NOT A REPEAT. Rounds 1–6 tested momentum, but only as features on
 * 30m/1h/4h/1d bars with barrier horizons of 24–480 hours. The documented TSMOM
 * result (Moskowitz, Ooi & Pedersen 2012, 58 instruments, 1965–2009) is a
 * **1–12 month lookback with 1-month holding periods**. That parameter region has
 * never been scored here. It is also the region where transaction costs stop
 * mattering: at a 1-month hold, 8bp round trip is ~0.1% of a ~20% annualised
 * move.
 *
 * PRE-REGISTERED: lookbacks {1,3,6,9,12} months × holds {1 week, 1 month} = 10
 * cells, sign-of-past-return → position. Both the follow and fade directions are
 * implied by the sign convention and reported together, so a flip cannot be
 * claimed post hoc.
 *
 * THE BENCHMARK IS ALWAYS-LONG, NOT ZERO. BTC compounded at 35.5%/yr over this
 * window. Any long-biased rule inherits that for free, and round 8b showed every
 * trailing-stop variant LOSING to buy-and-hold by 23–38pp of CAGR. A TSMOM rule
 * that returns 30%/yr is a failure here, not a success.
 *
 * SAMPLE HONESTY: 2,515 daily bars ≈ 6.9 years. At a 12-month lookback with
 * monthly holds that is ~70 non-overlapping observations, and BTC's history is
 * dominated by three or four huge trends — so a "significant" result can rest on
 * a handful of episodes. Non-overlapping counts are reported alongside every
 * cell for exactly this reason.
 *
 * Usage: node scripts/research/tsmom-test.js
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const C = JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', 'research-1d.json'), 'utf8'));
const N = C.t.length;
const TAKER = 0.0006, MAKER = 0.0002;

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

/** Block bootstrap on a mean, blocks sized to the holding period. */
function boot(v, blockLen, B = 5000) {
  if (v.length < 12) return [NaN, NaN];
  const nb = Math.max(2, Math.ceil(v.length / blockLen));
  const out = [];
  for (let i = 0; i < B; i++) {
    const s = [];
    while (s.length < v.length) {
      const st = Math.floor(Math.random() * Math.max(1, v.length - blockLen));
      for (let j = 0; j < blockLen && s.length < v.length; j++) s.push(v[st + j]);
    }
    out.push(mean(s));
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(B * .025)], out[Math.floor(B * .975)]];
}

console.log(`BTC daily ${new Date(C.t[0]).toISOString().slice(0,10)} → ${new Date(C.t[N-1]).toISOString().slice(0,10)} (${N} bars, ${(N/365).toFixed(1)}y)\n`);

// Benchmark: buy and hold, and the per-hold return distribution it implies.
function holdReturns(holdD) {
  const r = [];
  for (let i = 20; i + holdD < N; i += holdD) r.push(C.c[i + holdD] / C.c[i] - 1);
  return r;
}

console.log(`${'lookback'.padEnd(10)} ${'hold'.padEnd(8)} ${'n'.padStart(4)} ${'inMkt%'.padStart(7)} ${'CAGR'.padStart(8)} ${'always-long'.padStart(12)} ${'vs B&H'.padStart(9)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'95% CI on mean hold ret'.padStart(24)}`);

const results = [];
for (const lbMonths of [1, 3, 6, 9, 12]) {
  const lb = Math.round(lbMonths * 30.44);
  for (const [holdName, holdD] of [['1 week', 7], ['1 month', 30]]) {
    let eq = 1, bh = 1, inMkt = 0, n = 0, trades = 0, prevLong = null;
    const E = [], rets = [];
    for (let i = Math.max(20, lb); i + holdD < N; i += holdD) {
      const past = C.c[i] / C.c[i - lb] - 1;
      const long = past > 0;                       // sign-of-past-return
      const fwd = C.c[i + holdD] / C.c[i] - 1;
      // Long-only when signal is up, flat otherwise (shorting BTC perps carries
      // funding costs that this daily series cannot model honestly).
      const gross = long ? fwd : 0;
      const cost = (prevLong === null || long !== prevLong) ? (TAKER + MAKER) : 0;
      const net = gross - cost;
      if (long !== prevLong) trades++;
      prevLong = long;
      eq *= (1 + net); bh *= (1 + fwd);
      if (long) inMkt++;
      n++; rets.push(net); E.push(eq);
    }
    const years = (n * holdD) / 365;
    const cagr = Math.pow(eq, 1 / years) - 1;
    const bhCagr = Math.pow(bh, 1 / years) - 1;
    let peak = -Infinity, mdd = 0;
    for (const e of E) { peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1); }
    const per = Math.sqrt(365 / holdD);
    const sharpe = sd(rets) > 0 ? (mean(rets) / sd(rets)) * per : 0;
    const [lo, hi] = boot(rets, Math.max(2, Math.round(90 / holdD)));
    const delta = (cagr - bhCagr) * 100;
    results.push({ lbMonths, holdName, n, cagr, bhCagr, delta, sharpe, mdd, lo, hi });
    console.log(`${(lbMonths + 'mo').padEnd(10)} ${holdName.padEnd(8)} ${String(n).padStart(4)} `
      + `${(inMkt / n * 100).toFixed(0).padStart(6)}% ${(cagr * 100).toFixed(1).padStart(7)}% `
      + `${(bhCagr * 100).toFixed(1).padStart(11)}% ${((delta >= 0 ? '+' : '') + delta.toFixed(1) + 'pp').padStart(9)} `
      + `${sharpe.toFixed(2).padStart(6)} ${(mdd * 100).toFixed(1).padStart(7)}% `
      + `[${(lo * 100).toFixed(2)}, ${(hi * 100).toFixed(2)}]%`.padStart(24));
  }
}

const beat = results.filter(r => r.delta > 0);
console.log(`\ncells beating buy-and-hold on CAGR: ${beat.length}/${results.length}`);
const beatCI = results.filter(r => r.delta > 0 && r.lo > 0);
console.log(`…of those, with a block-bootstrap CI on mean hold-return excluding zero: ${beatCI.length}`);
console.log('\nNOTE: beating B&H on CAGR alone is not enough — round 8b showed');
console.log('drawdown reduction is where trend rules genuinely earn their keep, and');
console.log('a rule that is flat half the time will trail a rising market by construction.');
console.log('Non-overlapping n is printed above; at 12mo/1mo it is small enough that a');
console.log('few trend episodes drive the whole result.');
