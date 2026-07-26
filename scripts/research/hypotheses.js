#!/usr/bin/env node
'use strict';

/**
 * scripts/research/hypotheses.js — pre-registered hypothesis battery (spec 07.3).
 *
 * Scores directional rules against the symmetric ±k×ATR label built by
 * build-dataset.js. Every rule below was written BEFORE any result was looked
 * at, and every cell it produces is counted toward the cumulative BH-FDR family
 * in rebuild/research-log.md — including the ones that fail. That is the point.
 *
 * ── What "viable" means, derived before looking at data ────────────────────
 * At a symmetric ±k×ATR barrier the payoff is ±1R, so expectancy is
 *     E[R] = (2p − 1) − fee(k)
 * where fee(k) is the round-trip cost expressed in R. Cost in R scales as
 * 1/stop-width: notional/risk = 1/(k·atrPct), and at the measured 6bp taker /
 * 2bp maker with a taker entry and maker exit,
 *     fee(k) = (1/(k·atrPct)) × 0.0008
 * With the sample's median atrPct (~0.4%), that is ≈0.20R at k=1, 0.10R at
 * k=2, 0.067R at k=3. Spec 07.1 wants gross ≥ +0.25R, so the break-even and
 * the *bar* differ sharply by k — printed per-k at runtime rather than
 * hardcoded, because atrPct is measured from the data, not assumed.
 *
 * The consequence, stated up front: a symmetric edge needs p ≈ 0.60 at k=1 but
 * only ≈0.55 at k=3. Wide stops do not create edge; they lower the toll.
 *
 * ── The null that matters ─────────────────────────────────────────────────
 * BTC drifted over the sample, so "always long" is not a 50% strategy. Every
 * cell therefore reports the always-long hit rate ON THE SAME ROWS. A rule
 * whose hit rate merely matches always-long has found drift, not skill.
 *
 * Usage:
 *   node scripts/research/hypotheses.js --data .market-data-cache/research-dataset.json
 *   node scripts/research/hypotheses.js --data ... --json out.json
 */

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { wilson, bhFDR, makeRng, lag1AutocorrESS } = require('../audit/falsification');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

const TAKER = 0.0006, MAKER = 0.0002;
const PRIOR_CELLS = Number(process.env.PRIOR_CELLS || 88);  // research-log.md count excluding this battery

// ─── stats ───────────────────────────────────────────────────────────────────

const lgamma = (() => {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  return function lg(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lg(1 - x);
    x -= 1; let a = 0.99999999999980993; const t = x + 7.5;
    for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  };
})();
const lchoose = (n, k) => (k < 0 || k > n) ? -Infinity
  : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

// Two-sided exact binomial test against p0 (method of small p-values).
function binomTest(k, n, p0 = 0.5) {
  if (n === 0) return 1;
  const lp = i => lchoose(n, i) + i * Math.log(p0) + (n - i) * Math.log(1 - p0);
  const obs = lp(k);
  let sum = 0;
  for (let i = 0; i <= n; i++) if (lp(i) <= obs + 1e-9) sum += Math.exp(lp(i));
  return Math.min(1, sum);
}

// Day-clustered bootstrap on a 0/1 hit series. Resamples whole UTC days, so
// the 30-minute autocorrelation inside a day cannot inflate confidence.
function clusteredHitCI(rows, B = 10000, rng = makeRng(7)) {
  const byDay = new Map();
  for (const r of rows) {
    const d = Math.floor(r.t / 86_400_000);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r.hit);
  }
  const days = [...byDay.values()];
  if (days.length < 5) return { lo: null, hi: null, days: days.length };
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, m = 0;
    for (let i = 0; i < days.length; i++) {
      const d = days[Math.floor(rng() * days.length)];
      for (const x of d) { s += x; m++; }
    }
    means.push(m ? s / m : 0);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * B)], hi: means[Math.floor(0.975 * B)], days: days.length };
}

// ─── pre-registered rules ────────────────────────────────────────────────────
// Each returns 'long' | 'short' | null (rule does not apply to this row).
// Written before any result was inspected. Inverses are stated explicitly as
// their own cells rather than left as a free option after seeing a sign.

const RULES = [
  { id: 'H1-trend24',    why: 'momentum continuation on the 24h return',
    fn: r => r.ret24h > 0 ? 'long' : r.ret24h < 0 ? 'short' : null },
  { id: 'H2-trend7d',    why: 'momentum continuation on the 7d return',
    fn: r => r.ret7d > 0 ? 'long' : r.ret7d < 0 ? 'short' : null },
  { id: 'H3-emaCross',   why: 'EMA20/50 spread as trend state',
    fn: r => r.emaSpread > 0 ? 'long' : r.emaSpread < 0 ? 'short' : null },
  { id: 'H4-revExtreme', why: 'mean reversion at the edges of the 7d range',
    fn: r => r.rangePos > 0.9 ? 'short' : r.rangePos < 0.1 ? 'long' : null },
  { id: 'H5-imbCont',    why: 'aggressor imbalance continues (order-flow follow)',
    fn: r => r.imbZ > 1 ? 'long' : r.imbZ < -1 ? 'short' : null },
  { id: 'H6-imbFade',    why: 'aggressor imbalance mean-reverts (explicit inverse of H5)',
    fn: r => r.imbZ > 1 ? 'short' : r.imbZ < -1 ? 'long' : null },
  { id: 'H7-vwapRev',    why: 'reversion to session VWAP from >0.4% away',
    fn: r => r.vwapDist > 0.004 ? 'short' : r.vwapDist < -0.004 ? 'long' : null },
  { id: 'H8-trendPull',  why: 'trend + pullback: 7d trend, entry in the near half of the range',
    fn: r => (r.ret7d > 0 && r.rangePos < 0.4) ? 'long'
           : (r.ret7d < 0 && r.rangePos > 0.6) ? 'short' : null },
  { id: 'H9-trendHiVol', why: 'H1 conditioned on the top-30% volatility regime',
    fn: r => r.atrPctl > 0.7 ? (r.ret24h > 0 ? 'long' : r.ret24h < 0 ? 'short' : null) : null },
  { id: 'H10-revLoVol',  why: 'H4 conditioned on the bottom-30% volatility regime',
    fn: r => r.atrPctl < 0.3 ? (r.rangePos > 0.9 ? 'short' : r.rangePos < 0.1 ? 'long' : null) : null },
];

// ─── evaluation ──────────────────────────────────────────────────────────────

function evaluate(rule, rows) {
  const hits = [];
  for (const r of rows) {
    const pred = rule.fn(r);
    if (!pred) continue;
    hits.push({ t: r.t, hit: (pred === 'long') === (r.upFirst === 1) ? 1 : 0, upFirst: r.upFirst });
  }
  const n = hits.length;
  if (n === 0) return { id: rule.id, n: 0 };
  const k = hits.reduce((s, x) => s + x.hit, 0);
  const p = k / n;
  const [, wLo, wHi] = wilson(k, n);   // returns [p, lo, hi]
  const cl = clusteredHitCI(hits);
  const ac = lag1AutocorrESS(hits.map(x => x.hit));
  // Always-long benchmark on the SAME rows — exposes drift masquerading as skill.
  const alwaysLong = hits.filter(x => x.upFirst === 1).length / n;
  return {
    id: rule.id, why: rule.why, n, hit: p,
    wilsonLo: wLo, wilsonHi: wHi,
    clusterLo: cl.lo, clusterHi: cl.hi, days: cl.days,
    pval: binomTest(k, n, 0.5),
    alwaysLong,
    driftAdjusted: p - Math.max(alwaysLong, 1 - alwaysLong),
    ess: ac.ess, rho: ac.rho,
    hits,
  };
}

function quarterly(res, rows) {
  const byQ = new Map();
  for (const h of res.hits) {
    const d = new Date(h.t);
    const q = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    if (!byQ.has(q)) byQ.set(q, [0, 0]);
    const e = byQ.get(q); e[0] += h.hit; e[1]++;
  }
  return [...byQ.entries()].sort().map(([q, [k, n]]) => `${q} ${(100 * k / n).toFixed(1)}%(${n})`);
}

// ─── main ────────────────────────────────────────────────────────────────────

(function main() {
  const dataFile = arg('data', path.join(ROOT, '.market-data-cache', 'research-dataset.json'));
  const { meta, rows } = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  // Fee hurdle from the data, not from an assumption.
  const atrPcts = rows.map(r => r.atrPct).sort((a, b) => a - b);
  const medAtr = atrPcts[Math.floor(atrPcts.length / 2)];
  const feeR = (TAKER + MAKER) / (meta.k * medAtr);
  const breakEvenP = (1 + feeR) / 2;
  const barP = (1 + feeR + 0.25) / 2;   // spec 07.1 row 2: gross ≥ +0.25R

  console.log('═══ Pre-registered hypothesis battery ═══');
  console.log(`data     ${path.relative(ROOT, dataFile)}`);
  console.log(`window   ${meta.from.slice(0, 10)} → ${meta.to.slice(0, 10)}  |  ${meta.rows} labelled bars`);
  console.log(`label    symmetric ±${meta.k}×ATR30m, ${meta.horizonH}h horizon`);
  console.log(`         unresolved ${meta.unresolvedPct}% · ambiguous ${meta.ambiguousPct}% (both excluded)`);
  console.log(`base     P(up-first) = ${(100 * meta.baseRateUpFirst).toFixed(2)}%  ← the drift null`);
  console.log(`costs    median ATR ${(100 * medAtr).toFixed(3)}% → fee ${feeR.toFixed(3)}R round trip`);
  console.log(`         break-even hit ${(100 * breakEvenP).toFixed(1)}%  ·  spec-07 bar (+0.25R) ${(100 * barP).toFixed(1)}%`);
  console.log('');

  const results = RULES.map(r => evaluate(r, rows)).filter(r => r.n > 0);
  // bhFDR returns a boolean array, one per p-value, in input order.
  const bh = bhFDR(results.map(r => r.pval), 0.10);
  // BH across the CUMULATIVE family: this battery + every cell ever tested.
  // Prior cells enter as p=1 placeholders — they cannot themselves be rejected,
  // but they inflate m, which is exactly the correction the spec demands.
  const cumulative = bhFDR(
    results.map(r => r.pval).concat(new Array(PRIOR_CELLS).fill(1)), 0.10);

  const hdr = ['rule', 'n', 'hit%', 'Wilson95', 'clustered95', 'alwaysLong', 'p', 'BH', 'ESS'];
  console.log(hdr[0].padEnd(15) + hdr[1].padStart(7) + hdr[2].padStart(8) + '  '
    + hdr[3].padEnd(15) + hdr[4].padEnd(15) + hdr[5].padStart(11) + hdr[6].padStart(10)
    + hdr[7].padStart(5) + hdr[8].padStart(8));
  console.log('─'.repeat(96));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(
      r.id.padEnd(15) +
      String(r.n).padStart(7) +
      (100 * r.hit).toFixed(1).padStart(8) + '  ' +
      `[${(100 * r.wilsonLo).toFixed(1)},${(100 * r.wilsonHi).toFixed(1)}]`.padEnd(15) +
      (r.clusterLo == null ? '—'.padEnd(15)
        : `[${(100 * r.clusterLo).toFixed(1)},${(100 * r.clusterHi).toFixed(1)}]`.padEnd(15)) +
      (100 * r.alwaysLong).toFixed(1).padStart(11) +
      r.pval.toExponential(2).padStart(10) +
      (cumulative[i] ? '  ✓' : '  ·').padStart(5) +
      Math.round(r.ess).toString().padStart(8));
  }
  console.log('');
  console.log(`BH-FDR q=0.10 over ${results.length} new + ${PRIOR_CELLS} prior = `
    + `${results.length + PRIOR_CELLS} cumulative cells (rebuild/research-log.md is authoritative).`);
  console.log(`  significant within this battery alone: ${bh.filter(Boolean).length}`);
  console.log(`  significant against the cumulative family: ${cumulative.slice(0, results.length).filter(Boolean).length}`);
  console.log('');

  // Anything that clears the economic bar is worth a walk-forward look; the
  // per-quarter split is where in-sample flukes usually die.
  const notable = results.filter(r => r.hit >= breakEvenP || r.hit <= 1 - breakEvenP);
  if (notable.length) {
    console.log('Cells at or beyond break-even — quarterly stability:');
    for (const r of notable) console.log(`  ${r.id.padEnd(15)} ${quarterly(r, rows).join('  ')}`);
  } else {
    console.log(`No cell reached the break-even hit rate of ${(100 * breakEvenP).toFixed(1)}%.`);
  }

  if (arg('json')) {
    fs.writeFileSync(arg('json'), JSON.stringify({
      meta, medAtr, feeR, breakEvenP, barP,
      results: results.map(({ hits, ...r }) => r),
    }, null, 2));
    console.log(`\n→ ${arg('json')}`);
  }
})();
