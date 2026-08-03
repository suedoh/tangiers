#!/usr/bin/env node
'use strict';

/**
 * scripts/research/zone-replay.js — replay the LIVE VRVP zone signal across the
 * full 5m corpus, to test the system's own hypothesis at a sample size the
 * 814-row live ledger can never reach (spec 07 round 6).
 *
 * Why this exists. Rounds 1–5 tested market-wide rules on every bar and found
 * nothing. The 2026-08-03 audit tested the 682 resolved live signals and found
 * 43.5% symmetric skill — but n=682 with ESS≈348 cannot resolve a conditional
 * edge, and the audit DID see conditional structure inside the signal's own
 * state space (symmetric hit ran 54.7% → 28.4% across chase quintiles). So the
 * question "is there a high-probability SUBSET of the zone signal?" has never
 * actually been answerable. This makes it answerable.
 *
 * What it does: walks the corpus at the live poll cadence, maintains a rolling
 * VRVP over the same window the live system uses, applies the same proximity
 * rule (checkVRVPProximity), and emits one row per trigger with features known
 * AT trigger time plus a symmetric ±k×ATR barrier label resolved strictly
 * afterwards.
 *
 * FIDELITY — deviations from live, stated so results are not over-claimed:
 *  1. Bucket grid is LOG-price with constant relative width, anchored on the
 *     frozen calibration (rowSize 34.7 at price 63857 → 5.43bp). The live code
 *     uses an absolute 34.7 grid, which is 0.87% of price in 2019 and 0.055%
 *     today — an absolute grid would make 2019 zones meaningless. Constant
 *     relative resolution is the only way one rule spans the corpus.
 *  2. Labels resolve on 5m bars (the corpus extent) rather than 1m. Round 3
 *     established 5m is adequate at ≥30m-ATR barrier widths.
 *  3. No CVD/OI/VWAP-from-session: those need trade-level or endpoint data not
 *     available historically. Taker-buy ratio (`tb`) IS in the corpus and is
 *     the same quantity CVD is built from, so order flow is represented.
 *  4. No confirmation gate and no dedup — this measures the SIGNAL, not the
 *     execution wrapper. The audit already measured what confirmation does.
 *
 * Output: NDJSON, one row per trigger. Read by audit/zone-selective.py.
 *
 * Usage:
 *   node scripts/research/zone-replay.js --k 1 --out /tmp/zone-signals.ndjson
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const K          = Number(arg('k', 1));
const OUT        = arg('out', path.join(ROOT, '.market-data-cache', `zone-signals-k${K}.ndjson`));
const CORPUS     = arg('corpus', path.join(ROOT, '.market-data-cache', 'research-5m-full.json'));
const HORIZON_H  = Number(arg('horizon', 24));

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'btc-zones.json'), 'utf8'));
const REL_ROW  = cfg.rowSize / cfg.calibration.tv.price;   // 34.7 / 63857.2 = 5.433e-4
const LOG_STEP = Math.log(1 + REL_ROW);
const WINDOW_BARS = Math.round(cfg.windowDays * 24 * 12);  // 14d of 5m bars
const STEP_BARS   = 2;                                     // 10-min poll cadence
const VA_PCT      = cfg.valueAreaPct;
const ATR_BARS    = 6 * 14;                                // ATR14 on 30m ≈ 84 5m bars

const bucketOf = px => Math.floor(Math.log(px) / LOG_STEP);
const priceOf  = b  => Math.exp((b + 0.5) * LOG_STEP);

// ─── corpus ──────────────────────────────────────────────────────────────────
console.error(`[zone-replay] loading ${path.basename(CORPUS)} …`);
const C = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const N = C.t.length;
console.error(`[zone-replay] ${N} 5m bars  ${new Date(C.t[0]).toISOString().slice(0,10)} → ${new Date(C.t[N-1]).toISOString().slice(0,10)}`);

// ─── rolling volume histogram (sparse, incremental) ──────────────────────────
// A bar's volume is spread across the buckets its high-low range touches,
// proportional to overlap — same convention as lib/market-data.js
// buildVolumeProfile, just on a log grid so it can span 7 years of price.
const hist = new Map();                    // bucket → {tv, uv, dv}
function apply(i, sign) {
  const lo = C.l[i], hi = C.h[i], v = C.v[i], tb = C.tb[i];
  if (!(v > 0)) return;
  const bLo = bucketOf(lo), bHi = bucketOf(hi);
  if (bHi === bLo) {
    const c = hist.get(bLo) || { tv: 0, uv: 0, dv: 0 };
    c.tv += sign * v; c.uv += sign * tb; c.dv += sign * (v - tb);
    hist.set(bLo, c);
    return;
  }
  const span = hi - lo;
  for (let b = bLo; b <= bHi; b++) {
    const eLo = Math.exp(b * LOG_STEP), eHi = Math.exp((b + 1) * LOG_STEP);
    const ov = Math.min(hi, eHi) - Math.max(lo, eLo);
    if (ov <= 0) continue;
    const f = ov / span;
    const c = hist.get(b) || { tv: 0, uv: 0, dv: 0 };
    c.tv += sign * v * f; c.uv += sign * tb * f; c.dv += sign * (v - tb) * f;
    hist.set(b, c);
  }
}

/** POC / VAH / VAL / HVNs from the current histogram — mirrors computeVRVPLevels. */
function levels() {
  let keys = [];
  for (const [b, c] of hist) if (c.tv > 1e-9) keys.push(b);
  if (keys.length < 5) return null;
  keys.sort((a, b) => a - b);
  let total = 0, pocB = keys[0], pocV = -1;
  for (const b of keys) { const tv = hist.get(b).tv; total += tv; if (tv > pocV) { pocV = tv; pocB = b; } }
  const avg = total / keys.length;

  // 70% value area: greedy expansion from POC, larger neighbour first
  const idx = new Map(keys.map((b, i) => [b, i]));
  let lo = idx.get(pocB), hi = lo, cap = pocV;
  const target = total * VA_PCT;
  while (cap < target && (lo > 0 || hi < keys.length - 1)) {
    const below = lo > 0 ? hist.get(keys[lo - 1]).tv : -1;
    const above = hi < keys.length - 1 ? hist.get(keys[hi + 1]).tv : -1;
    if (below >= above) { lo--; cap += hist.get(keys[lo]).tv; }
    else { hi++; cap += hist.get(keys[hi]).tv; }
  }

  // HVN clusters: >1.5× avg, adjacent buckets merged (live merges within 50pts;
  // one log bucket is the scale-free equivalent). Outer 2 rows excluded.
  const inner = keys.slice(2, -2);
  const hv = inner.filter(b => hist.get(b).tv > avg * 1.5);
  const hvns = [];
  for (let i = 0; i < hv.length; i++) {
    const start = hv[i];
    let end = start, mx = hist.get(start).tv, uv = hist.get(start).uv, dv = hist.get(start).dv;
    while (i + 1 < hv.length && hv[i + 1] <= end + 1) {
      i++; end = hv[i];
      const c = hist.get(end);
      mx = Math.max(mx, c.tv); uv += c.uv; dv += c.dv;
    }
    hvns.push({ lo: Math.exp(start * LOG_STEP), hi: Math.exp((end + 1) * LOG_STEP), maxVol: mx, upVol: uv, downVol: dv });
  }
  hvns.sort((a, b) => b.maxVol - a.maxVol);

  return {
    poc: priceOf(pocB), pocVol: pocV, avgVol: avg, totalVol: total,
    vah: Math.exp((keys[hi] + 1) * LOG_STEP), val: Math.exp(keys[lo] * LOG_STEP),
    hvns: hvns.slice(0, 6), nRows: keys.length,
  };
}

/** Proximity rule — same shape and buffers as checkVRVPProximity in trigger-check.js. */
function proximity(price, L) {
  if (!L) return null;
  const buf = price * 0.0035;
  const cand = [];
  if (L.val != null) {
    const d = Math.abs(price - L.val);
    if (d <= buf * 1.5 || (price >= L.val - buf && price <= L.val + buf * 3))
      cand.push({ type: 'VAL', mid: L.val, direction: 'long', dist: d, priority: 10 });
  }
  if (L.vah != null) {
    const d = Math.abs(price - L.vah);
    if (d <= buf * 1.5)
      cand.push({ type: 'VAH', mid: L.vah, direction: price > L.vah + buf ? 'long' : 'short', dist: d, priority: 10 });
  }
  for (const h of L.hvns) {
    const mid = (h.lo + h.hi) / 2;
    const inside = price >= h.lo && price <= h.hi;
    const d = inside ? 0 : Math.min(Math.abs(price - h.lo), Math.abs(price - h.hi));
    if (inside || d <= buf)
      cand.push({ type: 'HVN', mid, direction: price > mid ? 'long' : 'short', dist: d, priority: 5,
                  zoneVol: h.maxVol, upVol: h.upVol, downVol: h.downVol });
  }
  if (L.poc != null) {
    const d = Math.abs(price - L.poc);
    if (d <= buf) cand.push({ type: 'POC', mid: L.poc, direction: price > L.poc ? 'long' : 'short', dist: d, priority: 1 });
  }
  if (!cand.length) return null;
  cand.sort((a, b) => b.priority - a.priority || a.dist - b.dist);
  return cand[0];
}

// ─── ATR(14) on 30m, from 5m bars ────────────────────────────────────────────
function atr30At(i) {
  if (i < ATR_BARS + 6) return null;
  let sum = 0, n = 0;
  for (let j = i - ATR_BARS; j < i; j += 6) {
    let hh = -Infinity, ll = Infinity;
    for (let m = j; m < j + 6 && m < i; m++) { if (C.h[m] > hh) hh = C.h[m]; if (C.l[m] < ll) ll = C.l[m]; }
    const prevC = C.c[Math.max(0, j - 1)];
    sum += Math.max(hh - ll, Math.abs(hh - prevC), Math.abs(ll - prevC)); n++;
  }
  return n ? sum / n : null;
}

/** Symmetric ±k×ATR barrier resolved on 5m bars strictly after bar i. */
const HORIZON_BARS = HORIZON_H * 12;
function label(i, px, atr, isLong) {
  const up = px + K * atr, dn = px - K * atr;
  const end = Math.min(N - 1, i + HORIZON_BARS);
  for (let j = i + 1; j <= end; j++) {
    const hitUp = C.h[j] >= up, hitDn = C.l[j] <= dn;
    if (hitUp && hitDn) return { upFirst: null, ambiguous: true };   // never guess
    if (hitUp) return { upFirst: 1, bars: j - i };
    if (hitDn) return { upFirst: 0, bars: j - i };
  }
  return { upFirst: null, unresolved: true };
}

// ─── walk ────────────────────────────────────────────────────────────────────
const out = fs.createWriteStream(OUT);
let emitted = 0, ambiguous = 0, unresolved = 0, evals = 0;

for (let i = 0; i < WINDOW_BARS; i++) apply(i, +1);

for (let i = WINDOW_BARS; i < N - 1; i += STEP_BARS) {
  for (let j = i - STEP_BARS; j < i; j++) { apply(j, +1); apply(j - WINDOW_BARS, -1); }
  if (i < ATR_BARS + 12) continue;
  evals++;

  const price = C.c[i];
  const L = levels();
  const trig = proximity(price, L);
  if (!trig) continue;

  const atr = atr30At(i);
  if (!atr || !(atr > 0)) continue;
  const lab = label(i, price, atr, trig.direction === 'long');
  if (lab.ambiguous) { ambiguous++; continue; }
  if (lab.upFirst === null) { unresolved++; continue; }

  // ── features, all knowable AT bar i ──
  const ret = (n) => i - n >= 0 ? price / C.c[i - n] - 1 : null;
  let tb = 0, vv = 0;
  for (let j = Math.max(0, i - 12); j <= i; j++) { tb += C.tb[j]; vv += C.v[j]; }
  const takerImb = vv > 0 ? (2 * tb - vv) / vv : 0;          // CVD's underlying quantity
  let tb4 = 0, vv4 = 0;
  for (let j = Math.max(0, i - 288); j <= i; j++) { tb4 += C.tb[j]; vv4 += C.v[j]; }
  const takerImbD = vv4 > 0 ? (2 * tb4 - vv4) / vv4 : 0;
  let volSum = 0, volN = 0;
  for (let j = Math.max(0, i - 2016); j <= i; j++) { volSum += C.v[j]; volN++; }
  const volAvg = volN ? volSum / volN : 1;
  let vwNum = 0, vwDen = 0;
  for (let j = Math.max(0, i - 288); j <= i; j++) { const tp = (C.h[j] + C.l[j] + C.c[j]) / 3; vwNum += tp * C.v[j]; vwDen += C.v[j]; }
  const vwap = vwDen ? vwNum / vwDen : price;
  const vaWidth = (L.vah - L.val) / price;
  const d = new Date(C.t[i]);

  out.write(JSON.stringify({
    t: C.t[i], price, k: K,
    // --- the signal's own decision ---
    zoneType: trig.type, direction: trig.direction,
    distPct: trig.dist / price,                 // how far price is from the zone
    zoneMidRel: (trig.mid - price) / price,     // signed — above or below
    // --- zone structure ---
    vaWidthPct: vaWidth,
    vaPos: (price - L.val) / Math.max(1e-9, L.vah - L.val),   // where in the value area
    pocRel: (L.poc - price) / price,
    zoneStrength: trig.zoneVol ? trig.zoneVol / L.avgVol : (L.pocVol / L.avgVol),
    zoneFlowImb: trig.upVol != null && trig.upVol + trig.downVol > 0
      ? (trig.upVol - trig.downVol) / (trig.upVol + trig.downVol) : null,
    nRows: L.nRows,
    // --- market state ---
    atrPct: atr / price,
    ret1h: ret(12), ret6h: ret(72), ret24h: ret(288), ret7d: ret(2016),
    vwapDist: (price - vwap) / price,
    takerImb1h: takerImb, takerImb24h: takerImbD,
    volZ: Math.log(Math.max(1e-9, C.v[i] / Math.max(1e-9, volAvg))),
    hour: d.getUTCHours(), dow: d.getUTCDay(),
    // --- label (resolved strictly after bar i) ---
    upFirst: lab.upFirst,
    // did the SIGNAL's direction win?
    win: (trig.direction === 'long') === (lab.upFirst === 1) ? 1 : 0,
    barsToLabel: lab.bars,
  }) + '\n');
  emitted++;

  if (emitted % 20000 === 0) console.error(`[zone-replay] ${emitted} signals · bar ${i}/${N}`);
}

out.end();
console.error(`[zone-replay] done: ${emitted} signals from ${evals} evaluations (${(100*emitted/evals).toFixed(1)}% trigger rate)`);
console.error(`[zone-replay] excluded: ${ambiguous} ambiguous, ${unresolved} unresolved`);
console.error(`[zone-replay] → ${OUT}`);
