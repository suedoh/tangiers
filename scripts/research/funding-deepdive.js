#!/usr/bin/env node
'use strict';

/**
 * scripts/research/funding-deepdive.js — interrogate the one surviving lead.
 *
 * The battery threw up exactly one cell with a real conditional deviation:
 * at ±3×ATR, rows where trailing-30d funding sits in its top decile go
 * UP-first 56.6% of the time against a 50.6% unconditional base. Before that
 * can be called anything, four things have to be true — this script tests all
 * four and is written to kill the lead, not to confirm it:
 *
 *   1. INDEPENDENCE. 2,855 rows is not 2,855 observations. Consecutive 30m
 *      bars share a funding settlement AND a 72h label window, so they are
 *      near-duplicates. Reported three ways: block bootstrap on 7-day blocks,
 *      a strictly non-overlapping subsample (one row per 72h), and the count
 *      of distinct funding episodes.
 *   2. REGIME. The sample must not be one uptrend wearing a costume. Split by
 *      year and by 30d trend sign; a lead that only exists while BTC rises is
 *      drift with extra steps.
 *   3. NOVELTY. Funding is high after price rises, so the cell may be nothing
 *      but 7d momentum re-labelled. Tested head-to-head and conditioned.
 *   4. ECONOMICS. Hit rate is not expectancy. E[R] = (2p−1) − fee(k) must clear
 *      the spec 07.1 bar (+0.25R gross), not merely break even.
 *
 * Usage: node scripts/research/funding-deepdive.js
 */

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { wilson, makeRng } = require('../audit/falsification');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

const DAY = 86_400_000;

function blockBootstrap(items, blockDays, B = 10000, rng = makeRng(23)) {
  const byBlock = new Map();
  for (const it of items) {
    const b = Math.floor(it.t / (blockDays * DAY));
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push(it.y);
  }
  const blocks = [...byBlock.values()];
  if (blocks.length < 5) return { lo: null, hi: null, blocks: blocks.length };
  const means = [];
  for (let i = 0; i < B; i++) {
    let s = 0, n = 0;
    for (let j = 0; j < blocks.length; j++) {
      const b = blocks[Math.floor(rng() * blocks.length)];
      for (const v of b) { s += v; n++; }
    }
    means.push(n ? s / n : 0);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * B)], hi: means[Math.floor(0.975 * B)], blocks: blocks.length };
}

const pct = x => (100 * x).toFixed(2) + '%';

(function main() {
  const dataFile = arg('data', path.join(ROOT, '.market-data-cache', 'ds-k3.json'));
  const { meta, rows } = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const funding = JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', 'funding-btcusdt.json'), 'utf8'));

  const fT = funding.map(f => f.t), fR = funding.map(f => f.r);
  let fi = 0;
  const tagged = [];
  for (const r of rows) {
    while (fi + 1 < fT.length && fT[fi + 1] <= r.t) fi++;
    if (fT[fi] > r.t || fi < 90) continue;
    const win = fR.slice(fi - 89, fi + 1), cur = fR[fi];
    tagged.push({ ...r, fund: cur, fundPctl: win.filter(x => x < cur).length / win.length, settle: fT[fi] });
  }

  const sel = tagged.filter(r => r.fundPctl >= 0.9);
  const base = tagged.filter(r => r.upFirst === 1).length / tagged.length;
  const items = sel.map(r => ({ t: r.t, y: r.upFirst, settle: r.settle }));
  const hit = items.reduce((s, x) => s + x.y, 0) / items.length;

  const atrPcts = tagged.map(r => r.atrPct).sort((a, b) => a - b);
  const medAtr = atrPcts[Math.floor(atrPcts.length / 2)];
  const feeR = 0.0008 / (meta.k * medAtr);

  console.log('═══ Funding top-decile lead — adversarial review ═══');
  console.log(`label ±${meta.k}×ATR / ${meta.horizonH}h | rows ${tagged.length} | base P(up-first) ${pct(base)}`);
  console.log(`cell: fundPctl ≥ 0.90 → long | n=${sel.length} | hit ${pct(hit)} | raw lift ${((hit - base) * 100).toFixed(2)}pp\n`);

  // ── 1. independence ────────────────────────────────────────────────────────
  const [, wLo, wHi] = wilson(items.reduce((s, x) => s + x.y, 0), items.length);
  console.log('1. INDEPENDENCE');
  console.log(`   naive Wilson 95%      [${pct(wLo)}, ${pct(wHi)}]   ← assumes 2,855 independent draws`);
  for (const bd of [3, 7, 14]) {
    const bb = blockBootstrap(items, bd);
    console.log(`   ${String(bd).padStart(2)}-day block bootstrap  [${pct(bb.lo)}, ${pct(bb.hi)}]   (${bb.blocks} blocks)`);
  }
  const episodes = new Set(items.map(x => x.settle)).size;
  // Strictly non-overlapping: one row per label horizon, so no two share future path.
  const stride = meta.horizonH * 3_600_000;
  const nonOverlap = [];
  let lastT = -Infinity;
  for (const it of items) if (it.t - lastT >= stride) { nonOverlap.push(it); lastT = it.t; }
  const noHit = nonOverlap.reduce((s, x) => s + x.y, 0) / nonOverlap.length;
  const [, nLo, nHi] = wilson(nonOverlap.reduce((s, x) => s + x.y, 0), nonOverlap.length);
  console.log(`   distinct funding settlements: ${episodes}`);
  console.log(`   non-overlapping subsample:    n=${nonOverlap.length}  hit ${pct(noHit)}  Wilson [${pct(nLo)}, ${pct(nHi)}]`);

  // ── 2. regime ──────────────────────────────────────────────────────────────
  console.log('\n2. REGIME');
  const byYear = new Map();
  for (const r of sel) {
    const y = new Date(r.t).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, [0, 0]);
    const e = byYear.get(y); e[0] += r.upFirst; e[1]++;
  }
  for (const [y, [k, n]] of [...byYear.entries()].sort()) {
    const [, lo, hi] = wilson(k, n);
    console.log(`   ${y}  n=${String(n).padStart(5)}  hit ${pct(k / n)}  [${pct(lo)}, ${pct(hi)}]`);
  }
  for (const [label, f] of [['30d uptrend  ', r => r.ret7d > 0], ['30d downtrend', r => r.ret7d <= 0]]) {
    const s = sel.filter(f);
    if (!s.length) continue;
    const k = s.filter(r => r.upFirst === 1).length;
    const b = tagged.filter(f);
    const bb = b.filter(r => r.upFirst === 1).length / b.length;
    const [, lo, hi] = wilson(k, s.length);
    console.log(`   ${label} n=${String(s.length).padStart(5)}  hit ${pct(k / s.length)}  [${pct(lo)}, ${pct(hi)}]  `
      + `vs regime base ${pct(bb)}  → lift ${((k / s.length - bb) * 100).toFixed(2)}pp`);
  }

  // ── 3. novelty vs momentum ────────────────────────────────────────────────
  console.log('\n3. NOVELTY (is this just 7d momentum?)');
  const mom = tagged.filter(r => r.ret7d > 0);
  const momHit = mom.filter(r => r.upFirst === 1).length / mom.length;
  console.log(`   plain momentum (ret7d>0 → long)      n=${mom.length}  hit ${pct(momHit)}  lift ${((momHit - base) * 100).toFixed(2)}pp`);
  const both = tagged.filter(r => r.ret7d > 0 && r.fundPctl >= 0.9);
  const bothHit = both.filter(r => r.upFirst === 1).length / both.length;
  console.log(`   momentum ∧ high funding             n=${both.length}  hit ${pct(bothHit)}  lift ${((bothHit - base) * 100).toFixed(2)}pp`);
  const fundOnly = tagged.filter(r => r.ret7d <= 0 && r.fundPctl >= 0.9);
  if (fundOnly.length > 30) {
    const fo = fundOnly.filter(r => r.upFirst === 1).length / fundOnly.length;
    console.log(`   high funding WITHOUT momentum       n=${fundOnly.length}  hit ${pct(fo)}  lift ${((fo - base) * 100).toFixed(2)}pp`
      + `   ← the incremental information`);
  } else {
    console.log(`   high funding WITHOUT momentum       n=${fundOnly.length}  — too few to separate the two`);
  }

  // ── 4. economics ──────────────────────────────────────────────────────────
  console.log('\n4. ECONOMICS');
  const gross = 2 * hit - 1;
  console.log(`   gross E[R] = 2p−1 = ${gross.toFixed(3)}R      spec 07.1 bar: ≥ +0.250R  → ${gross >= 0.25 ? 'PASS' : 'FAIL'}`);
  console.log(`   fee(k=${meta.k}) = ${feeR.toFixed(3)}R  →  net ${(gross - feeR).toFixed(3)}R per trade`);
  const bbLead = blockBootstrap(items, 7);
  const grossLo = 2 * bbLead.lo - 1;
  console.log(`   net at the LOWER 7-day-block bound (${pct(bbLead.lo)}): ${(grossLo - feeR).toFixed(3)}R`);
  console.log(`   spec 07.1 row 1 requires ≥55% at ±1×ATR — this cell is measured at ±${meta.k}×ATR.`);
})();
