#!/usr/bin/env node
'use strict';

/**
 * scripts/research/build-dataset.js — feature/label matrix for spec 07 research.
 *
 * One row per completed 30m bar. Features are computed from bars **up to and
 * including** bar i; the label is resolved on 1m bars strictly **after** bar i
 * closes. There is no point where a row can see its own future — that
 * discipline is the whole reason the audit's numbers were reproducible and the
 * legacy ledger's were not.
 *
 * Entry convention: price = close of bar i. That instant IS the close of bar i
 * and the open of the label walk, so entry and label share a boundary with no
 * gap and no overlap.
 *
 * Label (primary): symmetric ±k×ATR14(30m) barrier. Walking forward on 1m bars,
 * which barrier is touched first within HORIZON_H hours?
 *   upFirst = 1  → +k×ATR touched first
 *   upFirst = 0  → −k×ATR touched first
 *   upFirst = null → neither inside the horizon (unresolved; excluded, counted)
 * A 1m bar that contains BOTH barriers is ambiguous — recorded separately, never
 * silently assigned. This is direction-free: it measures whether the *market*
 * went up-first, so any directional rule can be scored against it.
 *
 * Usage:
 *   node scripts/research/build-dataset.js --out /tmp/dataset.json
 *   node scripts/research/build-dataset.js --k 1 --horizon 24
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

const K         = Number(arg('k', 1));           // barrier width in ATR
const BAR       = arg('bar', '30m');             // feature-bar timeframe

// Every lookback below used to be a bar count hard-coded for 30m spacing
// (12=6h, 48=24h, 336=7d, 1440=30d) alongside a literal `t[i] + 1_800_000` for
// the bar close. Higher timeframes need their own windows: 336 daily bars is a
// year of lookback and would eat most of a 2,515-bar series as warmup.
//
// Windows are chosen to span comparable *calendar* time where that is
// meaningful, and to keep warmup a small fraction of each series:
//   mom  — three momentum lookbacks, in bars
//   pctl — ATR-percentile / z-score window
//   rng  — structural high-low range window
const TF = {
  '30m': { ms: 1_800_000,  mom: [12, 48, 336], pctl: 1440, rng: 336, horizonH: 24 },
  '1h':  { ms: 3_600_000,  mom: [6, 24, 168],  pctl: 720,  rng: 168, horizonH: 48 },
  '4h':  { ms: 14_400_000, mom: [6, 30, 42],   pctl: 180,  rng: 42,  horizonH: 96 },
  '1d':  { ms: 86_400_000, mom: [3, 7, 30],    pctl: 180,  rng: 30,  horizonH: 480 },
}[BAR];
if (!TF) throw new Error(`unsupported --bar ${BAR} (want 30m|1h|4h|1d)`);

const BAR_MS    = TF.ms;
const HORIZON_H = Number(arg('horizon', TF.horizonH));
const MOM       = TF.mom;
const PCTL_W    = TF.pctl;
const RNG_W     = TF.rng;
const WARMUP    = Math.max(PCTL_W, RNG_W, MOM[2]) + MOM[0];
// A day-anchored VWAP is meaningless once a bar IS a day (or longer): every bar
// becomes its own session, so vwapDist collapses to a function of the bar's own
// shape rather than an independent benchmark. Drop it rather than ship a
// feature that silently means something different at one timeframe.
const USE_VWAP  = BAR_MS < 86_400_000;

// ─── indicators (all causal — index i sees only 0..i) ────────────────────────

function wilderATR(h, l, c, n = 14) {
  const out = new Array(h.length).fill(null);
  let prev = null;
  for (let i = 1; i < h.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    prev = prev == null
      ? (i >= n ? (out[i - 1] ?? tr) : tr)
      : (prev * (n - 1) + tr) / n;
    if (i >= n) out[i] = prev;
  }
  return out;
}

function wilderRSI(c, n = 14) {
  const out = new Array(c.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const g = Math.max(0, d), ls = Math.max(0, -d);
    if (i <= n) { ag += g / n; al += ls / n; if (i === n) out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    else {
      ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + ls) / n;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}

function ema(c, n) {
  const out = new Array(c.length).fill(null);
  const a = 2 / (n + 1);
  let e = c[0];
  for (let i = 0; i < c.length; i++) { e = i === 0 ? c[0] : c[i] * a + e * (1 - a); if (i >= n) out[i] = e; }
  return out;
}

// Rolling percentile of x[i] within the trailing `win` values (inclusive).
// O(n·win) but n=35k, win=1440 — a few seconds, and clarity beats cleverness here.
function rollingPctl(x, win) {
  const out = new Array(x.length).fill(null);
  for (let i = win; i < x.length; i++) {
    if (x[i] == null) continue;
    let below = 0, count = 0;
    for (let j = i - win; j < i; j++) { if (x[j] == null) continue; count++; if (x[j] < x[i]) below++; }
    out[i] = count ? below / count : null;
  }
  return out;
}

function rollingZ(x, win) {
  const out = new Array(x.length).fill(null);
  for (let i = win; i < x.length; i++) {
    if (x[i] == null) continue;
    let s = 0, ss = 0, m = 0;
    for (let j = i - win; j < i; j++) { if (x[j] == null) continue; s += x[j]; ss += x[j] * x[j]; m++; }
    if (m < 30) continue;
    const mean = s / m, sd = Math.sqrt(Math.max(0, ss / m - mean * mean));
    out[i] = sd > 0 ? (x[i] - mean) / sd : null;
  }
  return out;
}

// ─── label walk ──────────────────────────────────────────────────────────────

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

function resolveBarrier(K1, startIdx, entry, up, dn, horizonMs) {
  const tEnd = K1.t[startIdx] + horizonMs;
  for (let j = startIdx; j < K1.t.length && K1.t[j] <= tEnd; j++) {
    const hitUp = K1.h[j] >= up, hitDn = K1.l[j] <= dn;
    if (hitUp && hitDn) return { upFirst: null, ambiguous: true, bars: j - startIdx };
    if (hitUp) return { upFirst: 1, ambiguous: false, bars: j - startIdx };
    if (hitDn) return { upFirst: 0, ambiguous: false, bars: j - startIdx };
  }
  return { upFirst: null, ambiguous: false, bars: null };  // unresolved in horizon
}

// ─── build ───────────────────────────────────────────────────────────────────

(function main() {
  const f30 = arg('k30', path.join(ROOT, '.market-data-cache', 'research-30m.json'));
  const f1m = arg('k1m', path.join(ROOT, '.market-data-cache', 'research-1m.json'));
  const out = arg('out', path.join(ROOT, '.market-data-cache', 'research-dataset.json'));

  const K30 = JSON.parse(fs.readFileSync(f30, 'utf8'));
  const K1  = JSON.parse(fs.readFileSync(f1m, 'utf8'));
  console.log(`feature bars (${BAR}) ${K30.t.length} | label bars (${K1.interval || '1m'}) ${K1.t.length}`);
  if (K30.interval && K30.interval !== BAR) {
    throw new Error(`--bar ${BAR} but feature file holds ${K30.interval} bars`);
  }

  const { t, o, h, l, c, v, tb } = K30;
  const n = t.length;

  const atr   = wilderATR(h, l, c, 14);
  const rsi   = wilderRSI(c, 14);
  const e20   = ema(c, 20);
  const e50   = ema(c, 50);
  const atrPct = atr.map((a, i) => (a == null ? null : a / c[i]));

  // Aggressor imbalance over MOM[0] bars: (buy − sell) / total, from taker-buy base volume.
  const W = MOM[0];
  const imb = new Array(n).fill(null);
  for (let i = W - 1; i < n; i++) {
    let vol = 0, buy = 0;
    for (let j = i - (W - 1); j <= i; j++) { vol += v[j]; buy += tb[j]; }
    imb[i] = vol > 0 ? (2 * buy - vol) / vol : null;
  }
  // Same-window volume total, for its own z-score
  const volW = new Array(n).fill(null);
  for (let i = W - 1; i < n; i++) { let s = 0; for (let j = i - (W - 1); j <= i; j++) s += v[j]; volW[i] = s; }

  console.log('computing rolling windows…');
  const atrPctl = rollingPctl(atrPct, PCTL_W);
  const imbZ    = rollingZ(imb, PCTL_W);
  const volZ    = rollingZ(volW, PCTL_W);

  // UTC-day-anchored VWAP (session VWAP, same anchor the live system uses)
  const vwap = new Array(n).fill(null);
  if (USE_VWAP) {
    let day = null, pv = 0, vv = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.floor(t[i] / 86_400_000);
      if (d !== day) { day = d; pv = 0; vv = 0; }
      const tp = (h[i] + l[i] + c[i]) / 3;
      pv += tp * v[i]; vv += v[i];
      vwap[i] = vv > 0 ? pv / vv : null;
    }
  }

  const rows = [];
  let ambiguous = 0, unresolved = 0;
  const horizonMs = HORIZON_H * 3_600_000;

  for (let i = WARMUP; i < n; i++) {
    if (atr[i] == null || atrPctl[i] == null || imbZ[i] == null) continue;

    const price = c[i];
    const barrier = K * atr[i];
    const closeMs = t[i] + BAR_MS;                  // bar i closes here
    const s = lowerBound(K1.t, closeMs);            // first label bar at/after the close
    if (s >= K1.t.length) continue;

    const lab = resolveBarrier(K1, s, price, price + barrier, price - barrier, horizonMs);
    if (lab.ambiguous) { ambiguous++; continue; }
    if (lab.upFirst == null) { unresolved++; continue; }

    // Structural range position over RNG_W bars
    let hi7 = -Infinity, lo7 = Infinity;
    for (let j = i - (RNG_W - 1); j <= i; j++) { if (h[j] > hi7) hi7 = h[j]; if (l[j] < lo7) lo7 = l[j]; }

    // ret6h/ret24h/ret7d are SLOT names, kept so the pre-registered rule battery
    // in hypotheses.js runs unchanged at every timeframe. They mean MOM[0]/[1]/[2]
    // bars back — at 30m that is literally 6h/24h/7d, at 4h it is 1d/5d/7d, at 1d
    // it is 3d/7d/30d. meta.momentumSpans records the true spans. mom1/2/3 are
    // honest aliases for new code.
    rows.push({
      t: t[i],
      price,
      atrPct: atrPct[i],
      atrPctl: atrPctl[i],
      ret6h:  Math.log(c[i] / c[i - MOM[0]]),
      ret24h: Math.log(c[i] / c[i - MOM[1]]),
      ret7d:  Math.log(c[i] / c[i - MOM[2]]),
      mom1:   Math.log(c[i] / c[i - MOM[0]]),
      mom2:   Math.log(c[i] / c[i - MOM[1]]),
      mom3:   Math.log(c[i] / c[i - MOM[2]]),
      emaSpread: (e20[i] - e50[i]) / price,
      rsi: rsi[i],
      rangePos: hi7 > lo7 ? (price - lo7) / (hi7 - lo7) : null,
      vwapDist: vwap[i] ? (price - vwap[i]) / price : null,
      imb: imb[i],
      imbZ: imbZ[i],
      volZ: volZ[i],
      bodyRatio: h[i] > l[i] ? (c[i] - o[i]) / (h[i] - l[i]) : 0,
      hour: new Date(t[i]).getUTCHours(),
      dow: new Date(t[i]).getUTCDay(),
      upFirst: lab.upFirst,
      barsToLabel: lab.bars,
    });

    if (rows.length % 5000 === 0) process.stderr.write(`\r  ${rows.length} rows…   `);
  }
  process.stderr.write('\n');

  const up = rows.filter(r => r.upFirst === 1).length;
  const hrs = bars => +(bars * BAR_MS / 3_600_000).toFixed(2);
  const meta = {
    builtAt: new Date().toISOString(),
    bar: BAR, barMs: BAR_MS,
    k: K, horizonH: HORIZON_H,
    momentumBars: MOM,
    momentumSpans: { mom1: `${hrs(MOM[0])}h`, mom2: `${hrs(MOM[1])}h`, mom3: `${hrs(MOM[2])}h` },
    pctlWindowBars: PCTL_W, rangeWindowBars: RNG_W, warmupBars: WARMUP,
    vwapUsed: USE_VWAP,
    rows: rows.length, ambiguous, unresolved,
    ambiguousPct: +(100 * ambiguous / (rows.length + ambiguous + unresolved)).toFixed(2),
    unresolvedPct: +(100 * unresolved / (rows.length + ambiguous + unresolved)).toFixed(2),
    baseRateUpFirst: +(up / rows.length).toFixed(4),
    from: new Date(rows[0].t).toISOString(),
    to: new Date(rows[rows.length - 1].t).toISOString(),
  };
  fs.writeFileSync(out, JSON.stringify({ meta, rows }));
  console.log(JSON.stringify(meta, null, 2));
  console.log(`→ ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
})();
