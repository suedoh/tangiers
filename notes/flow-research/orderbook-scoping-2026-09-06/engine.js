#!/usr/bin/env node
'use strict';
/**
 * Phase B scoping engine — DESCRIPTIVE ONLY.
 *
 * Produces no p-values, no FDR, no walk-forward, no verdict. Every conditional
 * mean is printed next to the same-bar always-long drift, because the prior
 * study's decisive finding (§3.4) was that every apparently profitable mean R
 * was drift wearing a signal's clothes.
 *
 * Rules are exactly as fixed in PREREG.md, which was written before this ran.
 */
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BOOK = path.join(ROOT, 'data', 'orderbook');

// ─── analysis window: the contiguous 19-day block only ───────────────────────
// Today's restart rows (2026-09-06) are ~60 minutes and cannot support a
// trailing-1440 window; including them would let a percentile window straddle
// the 23-day hole.
const WIN_START = Date.parse('2026-07-26T00:00:00Z');
const WIN_END   = Date.parse('2026-08-14T23:59:00Z');
const LIQ_VALID_FROM = Date.parse('2026-07-27T12:45:00Z'); // liq feed route fix
const WARMUP = 1440;
const KS = [1, 5, 15, 30];
const COST_BP = 14;

// ─── load ────────────────────────────────────────────────────────────────────
function loadCorpus() {
  const rows = [];
  for (const f of fs.readdirSync(BOOK).filter(f => f.endsWith('.ndjson')).sort()) {
    for (const l of fs.readFileSync(path.join(BOOK, f), 'utf8').split('\n')) {
      if (!l) continue;
      try { rows.push(JSON.parse(l)); } catch { /* counted in the integrity pass */ }
    }
  }
  rows.sort((a, b) => a.t - b.t);
  // Deduplicate the one repeated minute, keeping the richer row.
  const byT = new Map();
  for (const r of rows) {
    const p = byT.get(r.t);
    if (!p || (r.samples || 0) > (p.samples || 0)) byT.set(r.t, r);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t)
    .filter(r => r.t >= WIN_START && r.t <= WIN_END);
}

const klines = JSON.parse(fs.readFileSync(path.join(__dirname, 'klines-1m.json'), 'utf8'));
const kByT = new Map(klines.map(k => [k.t, k]));

// ─── build the joined frame ──────────────────────────────────────────────────
// Row t=T aggregates [T, T+60s). Its features are known at T+60s, which is the
// close of kline T. Forward return runs close(T) → close(T+k). No lookahead.
const corpus = loadCorpus();
const F = [];
for (const r of corpus) {
  const k0 = kByT.get(r.t);
  if (!k0) continue;
  const row = {
    t: r.t, gap: r.gap === true, samples: r.samples || 0, ticks: r.ticks || 0,
    obi1: r.obi1, obi5: r.obi5, obi20: r.obi20, obiTouch: r.obiTouch,
    spread: r.spread, mpDev: r.mpDev,
    dBid: r.dBid, dAsk: r.dAsk, slopeBid: r.slopeBid, slopeAsk: r.slopeAsk,
    trades: r.trades, tvol: r.tvol, tbuy: r.tbuy,
    tbigBuy: r.tbigBuy, tbigSell: r.tbigSell,
    liqLong: r.liqLong, liqShort: r.liqShort, liqN: r.liqN, liqNotional: r.liqNotional,
    liqAllNotional: r.liqAllNotional,
    hasLiq: r.t >= LIQ_VALID_FROM && r.liqN != null,
    close: k0.c, open: k0.o,
    rSame: (k0.c / k0.o - 1) * 1e4,                    // contemporaneous, bps
    flow: (r.tvol != null && r.tbuy != null) ? 2 * r.tbuy - r.tvol : null,
    depth: (r.dBid != null && r.dAsk != null) ? r.dBid + r.dAsk : null,
    block: (r.tbigBuy != null && r.tbigSell != null) ? r.tbigBuy - r.tbigSell : null,
  };
  row.absBlock = row.block == null ? null : Math.abs(row.block);
  for (const k of KS) {
    const kk = kByT.get(r.t + k * 60000);
    row['f' + k] = kk ? (kk.c / k0.c - 1) * 1e4 : null;
  }
  F.push(row);
}

// ─── trailing causal percentile ──────────────────────────────────────────────
// Strictly prior WARMUP rows, and only when they are genuinely contiguous in
// wall-clock (guards against a window straddling a recording outage).
// Sliding sorted window: insert/remove by binary search, O(window) per step
// instead of an O(window log window) sort per row. Results are identical to the
// naive version (asserted below on a sample).
function precomputePcts(arr, key, ps) {
  const out = ps.map(() => new Array(arr.length).fill(null));
  const win = [];
  const bs = v => { let lo = 0, hi = win.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } return lo; };
  // Invariant entering the body of iteration i: win holds arr[i-WARMUP .. i-1].
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) { const add = arr[i - 1][key];
      if (add != null && Number.isFinite(add)) win.splice(bs(add), 0, add); }
    if (i > WARMUP) { const drop = arr[i - 1 - WARMUP][key];
      if (drop != null && Number.isFinite(drop)) { const k = bs(drop); if (win[k] === drop) win.splice(k, 1); } }
    const lo = i - WARMUP;
    if (lo < 0 || arr[i].t - arr[lo].t > WARMUP * 60000 * 1.05 || win.length < WARMUP * 0.5) continue;
    ps.forEach((p, pi) => { out[pi][i] = win[Math.min(win.length - 1, Math.floor(p * win.length))]; });
  }
  return out;
}

// Naive reference, used only to verify the sliding window.
function trailingPctNaive(arr, i, key, p) {
  const lo = i - WARMUP;
  if (lo < 0) return null;
  if (arr[i].t - arr[lo].t > WARMUP * 60000 * 1.05) return null;
  const v = [];
  for (let j = lo; j < i; j++) { const x = arr[j][key]; if (x != null && Number.isFinite(x)) v.push(x); }
  if (v.length < WARMUP * 0.5) return null;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(p * v.length))];
}

// All callers pass the same frame F; the cache key is therefore (key, p).
const PCT_CACHE = new Map();
function trailingPct(arr, i, key, p) {
  const ck = key + '|' + p;
  if (!PCT_CACHE.has(ck)) PCT_CACHE.set(ck, precomputePcts(arr, key, [p])[0]);
  return PCT_CACHE.get(ck)[i];
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const fmt = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) : '   n/a');

/**
 * Descriptive summary of one triggered set. Reports the signed mean next to the
 * always-long mean ON THE SAME MINUTES so drift contamination is visible.
 * No p-value, no CI, no verdict — by design.
 */
function describe(label, picks) {
  const out = [];
  for (const k of KS) {
    const rows = picks.filter(p => p.row['f' + k] != null);
    if (!rows.length) continue;
    const signed = rows.map(p => p.dir * p.row['f' + k]);
    const long   = rows.map(p => p.row['f' + k]);
    const hit    = signed.filter(x => x > 0).length / signed.length * 100;
    const baseHit = long.filter(x => x > 0).length / long.length * 100;
    out.push({ k, n: rows.length, hit, baseHit,
      meanSigned: mean(signed), drift: mean(long), excess: mean(signed) - mean(long) });
  }
  return { label, rows: out };
}

function printTable(title, blocks) {
  console.log(`\n### ${title}`);
  console.log('rule                              k     n    hit%   long-hit%   mean bp   drift bp   EXCESS bp   net@14bp');
  for (const b of blocks) {
    for (const r of b.rows) {
      console.log(
        `${b.label.padEnd(32)} ${String(r.k).padStart(3)} ${String(r.n).padStart(5)}  ` +
        `${r.hit.toFixed(2).padStart(6)}  ${r.baseHit.toFixed(2).padStart(9)}  ` +
        `${fmt(r.meanSigned).padStart(8)}  ${fmt(r.drift).padStart(9)}  ${fmt(r.excess).padStart(9)}  ` +
        `${fmt(r.meanSigned - COST_BP).padStart(9)}`);
    }
  }
}

// ─── 0. Regime first, before any conditional number ──────────────────────────
console.log('='.repeat(112));
console.log('PHASE B — DESCRIPTIVE SCOPING. NOT A TEST. NO VERDICT. 19 DAYS, ONE REGIME.');
console.log('='.repeat(112));
const valid = F.filter(r => !r.gap && r.samples > 0);
console.log(`\ncorpus rows in window: ${F.length}  (usable, non-gap: ${valid.length})`);
console.log(`span: ${new Date(F[0].t).toISOString()} → ${new Date(F[F.length-1].t).toISOString()}`);
const p0 = F[0].close, p1 = F[F.length - 1].close;
console.log(`\n### 0. REGIME (read this before any number below)`);
console.log(`BTC close: ${p0.toFixed(1)} → ${p1.toFixed(1)}   = ${((p1/p0-1)*100).toFixed(2)}% over the window`);
const allF = F.filter(r => r.f30 != null).map(r => r.f30);
console.log(`unconditional 30-min forward return: mean ${fmt(mean(allF))}bp, up-share ${(allF.filter(x=>x>0).length/allF.length*100).toFixed(2)}%`);
const dayCloses = {};
for (const r of F) dayCloses[new Date(r.t).toISOString().slice(0,10)] = r.close;
console.log('daily closes:', Object.entries(dayCloses).map(([d,c])=>`${d.slice(5)}=${(c/1000).toFixed(1)}k`).join(' '));

// ─── identity check: mpDev is not independent of obi1 ────────────────────────
console.log(`\n### 0b. INTERNAL CONSISTENCY — mpDev vs obi1×spread/2`);
const idr = valid.filter(r => r.mpDev != null && r.obi1 != null && r.spread != null);
const pred = idr.map(r => r.obi1 * r.spread / 2), act = idr.map(r => r.mpDev);
const corr = (a, b) => { const ma=mean(a), mb=mean(b);
  let n=0,da=0,db=0; for(let i=0;i<a.length;i++){n+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}
  return n/Math.sqrt(da*db); };
console.log(`corr(mpDev, obi1×spread/2) = ${corr(pred, act).toFixed(4)}  (n=${idr.length})`);
console.log(`Algebraically micro−mid ≡ obi1 × spread/2, so mpDev carries no information beyond obi1 and spread.`);
console.log(`corr(obi1,obi5)=${corr(valid.filter(r=>r.obi1!=null&&r.obi5!=null).map(r=>r.obi1),valid.filter(r=>r.obi1!=null&&r.obi5!=null).map(r=>r.obi5)).toFixed(3)}` +
  `  corr(obi5,obi20)=${corr(valid.filter(r=>r.obi5!=null&&r.obi20!=null).map(r=>r.obi5),valid.filter(r=>r.obi5!=null&&r.obi20!=null).map(r=>r.obi20)).toFixed(3)}` +
  `  corr(obi5,obiTouch)=${corr(valid.filter(r=>r.obi5!=null&&r.obiTouch!=null).map(r=>r.obi5),valid.filter(r=>r.obi5!=null&&r.obiTouch!=null).map(r=>r.obiTouch)).toFixed(3)}`);

// ─── verify the fast percentile path against the naive one ───────────────────
{
  let checked = 0, bad = 0;
  for (let i = 0; i < F.length; i += 97) {
    for (const [key, p] of [['obi5', 0.80], ['obi5', 0.20], ['depth', 0.3333], ['absBlock', 0.90]]) {
      const a = trailingPct(F, i, key, p), b = trailingPctNaive(F, i, key, p);
      checked++;
      if (!(a === b || (a == null && b == null))) { bad++; if (bad < 4) console.error(`MISMATCH i=${i} ${key} p${p}: fast=${a} naive=${b}`); }
    }
  }
  console.log(`\n[check] sliding-window percentiles vs naive: ${checked} probes, ${bad} mismatches`);
  if (bad) { console.error('percentile path is wrong — aborting'); process.exit(1); }
}

// ─── H-B1 — depth imbalance → direction ──────────────────────────────────────
const hb1 = [];
for (const key of ['obi1', 'obi5', 'obi20', 'obiTouch']) {
  const picks = [];
  for (let i = 0; i < F.length; i++) {
    const r = F[i];
    if (r.gap || r[key] == null) continue;
    const hi = trailingPct(F, i, key, 0.80), lo = trailingPct(F, i, key, 0.20);
    if (hi == null || lo == null) continue;
    if (r[key] >= hi) picks.push({ row: r, dir: +1 });
    else if (r[key] <= lo) picks.push({ row: r, dir: -1 });
  }
  hb1.push(describe(`H-B1 ${key} (continuation)`, picks));
}
printTable('H-B1 — resting depth imbalance, P80/P20 trailing-1440, continuation', hb1);

// ─── H-B2 — Kyle lambda vs measured depth ────────────────────────────────────
console.log(`\n### H-B2 — price impact vs MEASURED resting depth (Kyle λ)`);
const dRows = [];
for (let i = 0; i < F.length; i++) {
  const r = F[i];
  if (r.gap || r.depth == null || r.flow == null || !Number.isFinite(r.rSame)) continue;
  const t33 = trailingPct(F, i, 'depth', 0.3333), t66 = trailingPct(F, i, 'depth', 0.6667);
  if (t33 == null || t66 == null) continue;
  dRows.push({ ...r, tercile: r.depth <= t33 ? 'thin' : r.depth >= t66 ? 'thick' : 'mid' });
}
// OLS slope through origin of same-minute return on signed flow: λ = Σxy/Σx².
function lambdaOf(rows) {
  let sxy = 0, sxx = 0;
  for (const r of rows) { sxy += r.flow * r.rSame; sxx += r.flow * r.flow; }
  return sxx > 0 ? sxy / sxx : NaN;
}
console.log('tercile      n      median depth(BTC)   lambda (bp per BTC of signed flow)   mean|flow|');
for (const t of ['thin', 'mid', 'thick']) {
  const rows = dRows.filter(r => r.tercile === t);
  const med = rows.map(r => r.depth).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  console.log(`${t.padEnd(8)} ${String(rows.length).padStart(6)}   ${med.toFixed(1).padStart(15)}   ` +
    `${lambdaOf(rows).toExponential(3).padStart(34)}   ${mean(rows.map(r => Math.abs(r.flow))).toFixed(1).padStart(9)}`);
}
console.log('\nH-B2b reversion — mean(sign(flow) × forward return) by depth tercile (negative = impact reverts):');
console.log('tercile        k=1      k=5     k=15     k=30');
for (const t of ['thin', 'mid', 'thick']) {
  const rows = dRows.filter(r => r.tercile === t && r.flow !== 0);
  const cells = KS.map(k => {
    const v = rows.filter(r => r['f' + k] != null).map(r => Math.sign(r.flow) * r['f' + k]);
    return fmt(mean(v)).padStart(8);
  });
  console.log(`${t.padEnd(8)} ${cells.join(' ')}`);
}

// ─── H-B3 — liquidation cascades ─────────────────────────────────────────────
const liqRows = F.filter(r => r.hasLiq);
console.log(`\n### H-B3 — liquidation cascades   (rows with a valid liq feed: ${liqRows.length} of ${F.length})`);
const hb3 = [];
for (const [name, sgn] of [['continuation', +1], ['reversion', -1]]) {
  const picks = [];
  for (let i = 0; i < F.length; i++) {
    const r = F[i];
    if (r.gap || !r.hasLiq || !r.liqNotional) continue;
    const p95 = trailingPct(F, i, 'liqNotional', 0.95);
    if (p95 == null || r.liqNotional < p95) continue;
    const L = (r.liqShort || 0) - (r.liqLong || 0);
    if (L === 0) continue;
    picks.push({ row: r, dir: sgn * Math.sign(L) });
  }
  hb3.push(describe(`H-B3 ${name}`, picks));
}
printTable('H-B3 — liqNotional ≥ P95 trailing-1440, direction = ±sign(liqShort − liqLong)', hb3);
const liqAct = liqRows.filter(r => r.liqN > 0);
console.log(`\nliquidation activity: ${liqAct.length} minutes with ≥1 BTC liquidation (${(liqAct.length/liqRows.length*100).toFixed(1)}% of valid minutes)`);
console.log(`liqNotional when active: median $${liqAct.map(r=>r.liqNotional).sort((a,b)=>a-b)[Math.floor(liqAct.length/2)].toLocaleString()}, ` +
  `max $${Math.max(...liqAct.map(r=>r.liqNotional)).toLocaleString()}`);

// ─── H-B4 — block prints ─────────────────────────────────────────────────────
const hb4 = [];
for (const [name, sgn] of [['permanent', +1], ['reversion', -1]]) {
  const picks = [];
  for (let i = 0; i < F.length; i++) {
    const r = F[i];
    if (r.gap || r.block == null || r.block === 0) continue;
    const p90 = trailingPct(F, i, 'absBlock', 0.90);
    if (p90 == null || r.absBlock < p90) continue;
    picks.push({ row: r, dir: sgn * Math.sign(r.block) });
  }
  hb4.push(describe(`H-B4 ${name}`, picks));
}
printTable('H-B4 — |net block flow| ≥ P90 trailing-1440, direction = ±sign(tbigBuy − tbigSell)', hb4);
const withBlock = valid.filter(r => r.tbigBuy != null && r.tvol > 0);
const blockShare = withBlock.map(r => (r.tbigBuy + r.tbigSell) / r.tvol).sort((a, b) => a - b);
console.log(`\nblock share of volume: median ${(blockShare[Math.floor(blockShare.length/2)]*100).toFixed(1)}%, ` +
  `p90 ${(blockShare[Math.floor(blockShare.length*0.9)]*100).toFixed(1)}%, ` +
  `minutes with zero block flow: ${(withBlock.filter(r=>!r.tbigBuy&&!r.tbigSell).length/withBlock.length*100).toFixed(1)}%`);

// ─── VPIN — the pre-registered positive control ONLY ─────────────────────────
console.log(`\n### VPIN — pre-registered POSITIVE CONTROL (high VPIN must predict HIGHER forward vol)`);
const vr = valid.filter(r => r.tvol > 0 && r.tbuy != null);
const totalVol = vr.reduce((s, r) => s + r.tvol, 0);
const days = (F[F.length-1].t - F[0].t) / 86400000;
const bucketV = totalVol / (days * 50);          // 50 buckets/day, as in the prior study
const buckets = [];
let acc = 0, accSigned = 0, accBuy = 0, startIdx = 0;
for (let i = 0; i < vr.length; i++) {
  acc += vr[i].tvol; accBuy += vr[i].tbuy;
  accSigned += Math.abs(2 * vr[i].tbuy - vr[i].tvol);
  if (acc >= bucketV) {
    buckets.push({ endT: vr[i].t, vol: acc, imb: accSigned / acc, idx: i, startIdx });
    acc = 0; accSigned = 0; accBuy = 0; startIdx = i + 1;
  }
}
console.log(`bucket size ${bucketV.toFixed(1)} BTC → ${buckets.length} buckets over ${days.toFixed(1)} days (${(buckets.length/days).toFixed(1)}/day)`);
const N = 50;
const vpin = [];
for (let i = N; i < buckets.length; i++) {
  vpin.push({ endT: buckets[i].endT, idx: buckets[i].idx,
    v: mean(buckets.slice(i - N, i).map(b => b.imb)) });
}
// Forward realized vol over the next 60 minutes from each bucket end.
const closeByT = new Map(F.map(r => [r.t, r.close]));
function fwdVol(t, mins) {
  const rets = [];
  for (let m = 0; m < mins; m++) {
    const a = closeByT.get(t + m * 60000), b = closeByT.get(t + (m + 1) * 60000);
    if (a && b) rets.push(Math.log(b / a));
  }
  if (rets.length < mins * 0.7) return null;
  return Math.sqrt(rets.reduce((s, x) => s + x * x, 0) / rets.length) * 1e4;
}
const withVol = vpin.map(v => ({ ...v, fv: fwdVol(v.endT, 60) })).filter(v => v.fv != null);
const sortedV = withVol.map(v => v.v).sort((a, b) => a - b);
const p90v = sortedV[Math.floor(sortedV.length * 0.9)];
const high = withVol.filter(v => v.v >= p90v), rest = withVol.filter(v => v.v < p90v);
const ratio = mean(high.map(v => v.fv)) / mean(rest.map(v => v.fv));
console.log(`n buckets with forward vol: ${withVol.length}  (high-VPIN ≥P90: ${high.length})`);
console.log(`fwd-60min realized vol — high-VPIN ${mean(high.map(v=>v.fv)).toFixed(2)}bp/min vs rest ${mean(rest.map(v=>v.fv)).toFixed(2)}bp/min`);
console.log(`RATIO = ${ratio.toFixed(3)}   → positive control ${ratio > 1 ? 'PASSES' : 'FAILS'} (must be > 1)`);
const volSeries = withVol.map(v => v.v), volFwd = withVol.map(v => v.fv);
console.log(`corr(VPIN, fwd vol) = ${corr(volSeries, volFwd).toFixed(3)}`);
const bucketVolPerMin = vr.map(r => r.tvol);
console.log(`corr(per-minute |imbalance ratio|, volume) = ${corr(
  vr.map(r => Math.abs(2*r.tbuy - r.tvol) / r.tvol), bucketVolPerMin).toFixed(3)}` +
  `   (prior study found −0.44 on bar-clock, the sign that diagnosed the construct failure)`);

console.log(`\n${'='.repeat(112)}`);
console.log('END. Every number above is DESCRIPTIVE. 19 days, one regime, overlapping windows,');
console.log('no multiplicity correction, no significance claimed. Phase C is deferred to ~60-90 days.');
console.log('='.repeat(112));
