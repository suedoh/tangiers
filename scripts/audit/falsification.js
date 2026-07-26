#!/usr/bin/env node
'use strict';

/**
 * scripts/audit/falsification.js — standing falsification harness (rebuild spec 07.2 / 09.1)
 *
 * Ported from rebuild/tools/stats.js — the 2026-07-26 independent audit's reference
 * implementation for honest measurement. Two gates, run weekly (ace-cron) and on demand:
 *
 *   GATE 1 — symmetric ±1×ATR30m skill test on the trailing ledger.
 *            PASS = hit% ≥ 55 AND the day-clustered bootstrap CI excludes 50%.
 *   GATE 2 — random-entry Monte Carlo: ≥200 books of random-minute entries with
 *            geometry resampled from the real book, scored with the canonical accounting.
 *            PASS = actual trailing book total > 95th percentile of random books.
 *
 * Two consecutive failing RECORDED runs (cron passes --record) trip the kill file:
 * `.autotrade-disabled.json` is written at repo root and a red alert posts to
 * BLOFIN_RECON_WEBHOOK. The autotrade layer checks that file and skips entries while it
 * exists. RE-ENABLE IS MANUAL — the operator deletes the file; this script never does.
 *
 * Schema: prefers the corrected-ledger fields from rebuild spec 03 (`fillPrice`,
 * `riskPerUnit`, `grossR`, `feeR`, net `pnlR`) and falls back to the legacy schema
 * (planned-entry `pnlR`, fire-time reference) with a loud stderr warning.
 *
 * Usage:
 *   node scripts/audit/falsification.js                       # full ledger, posts Discord
 *   node scripts/audit/falsification.js --dry-run             # console only, no Discord
 *   node scripts/audit/falsification.js --days 90 --record    # weekly cron form (trips state)
 *   node scripts/audit/falsification.js --trades /tmp/copy.json --klines-dir /tmp/k --self-test
 *
 * Flags:
 *   --trades <path>       ledger to read (default <root>/trades.json). READ-ONLY — this
 *                         script never writes the trades file. Point it at a scratch copy
 *                         for experiments.
 *   --klines-dir <dir>    read klines-30m.json / klines-1m.json from <dir> instead of
 *                         fetching from Binance (offline / reproducible runs).
 *   --days <N|all>        trailing window on firedAt (default: all).
 *   --sims <N>            Monte Carlo book count (default 200; spec floor 200).
 *   --dry-run             skip all Discord posts.
 *   --record              update .falsification-state.json and run the two-strikes trip
 *                         logic. Only the weekly cron should pass this; on-demand and
 *                         experimental runs must not count toward consecutive failures.
 *   --self-test           print reconciliation vs the 2026-07-26 audit's published numbers.
 *
 * No CDP, no TradingView, no LLM. Data: Binance public REST + the trades ledger.
 * Exchange orders are never touched.
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
const { getKlinesRange } = require('../lib/binance');
const discord = require('../lib/discord');

loadEnv();

const TAKER = 0.0006; // measured from BloFin fills (audit §2)
const MAKER = 0.0002;
const STATE_FILE = path.join(ROOT, '.falsification-state.json');
const TRIP_FILE = path.join(ROOT, '.autotrade-disabled.json');
const MAX_STATE_RUNS = 12;

// ─── Stats battery (exported — the standard battery of spec 07.2) ────────────

/** Wilson 95% score interval on a proportion. Returns [p, lo, hi]. */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z / d) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [p, c - h, c + h];
}

const lgamma = (() => { // Lanczos
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  return function lg(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lg(1 - z);
    z -= 1; let x = 0.99999999999980993;
    for (let i = 0; i < 8; i++) x += g[i] / (z + i + 1);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  };
})();
const lchoose = (n, k) => (k < 0 || k > n) ? -Infinity : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

/** Two-sided Fisher exact test on a 2×2 table (sum of probabilities ≤ observed). */
function fisherExact(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = a + b + c + d;
  const lp = x => lchoose(r1, x) + lchoose(r2, c1 - x) - lchoose(n, c1);
  const p0 = lp(a); let p = 0;
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
  for (let x = lo; x <= hi; x++) { const px = lp(x); if (px <= p0 + 1e-9) p += Math.exp(px); }
  return Math.min(1, p);
}

/** Benjamini–Hochberg FDR at q. Returns per-cell significance flags. */
function bhFDR(pvals, q = 0.10) {
  const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const m = pvals.length; let cut = -1;
  for (let r = 0; r < m; r++) if (idx[r][0] <= q * (r + 1) / m) cut = r;
  const sig = new Array(m).fill(false);
  for (let r = 0; r <= cut; r++) sig[idx[r][1]] = true;
  return sig;
}

/** Seeded LCG (same generator as the audit's stats.js) — one stream per component. */
function makeRng(seed = 42) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/**
 * Day-clustered bootstrap (resample DAYS with replacement) on the mean of a field.
 * rows need a firedAt ISO string. B ≥ 10,000 for gate use.
 */
function bootDayCI(rows, field, B = 10000, rng = makeRng(1)) {
  const byDay = new Map();
  for (const r of rows) {
    const d = r.firedAt.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(typeof field === 'function' ? field(r) : (r[field] ?? 0));
  }
  const days = [...byDay.values()]; const nD = days.length;
  if (!nD) return { mean: null, lo: null, hi: null, nDays: 0 };
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, c = 0;
    for (let i = 0; i < nD; i++) { const d = days[(rng() * nD) | 0]; for (const v of d) { s += v; c++; } }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);
  let sum = 0, cnt = 0;
  for (const d of days) for (const v of d) { sum += v; cnt++; }
  return { mean: sum / cnt, lo: means[(0.025 * B) | 0], hi: means[(0.975 * B) | 0], nDays: nD };
}

/** Lag-1 autocorrelation with Fisher-z 95% CI and effective sample size. */
function lag1AutocorrESS(xs) {
  const n = xs.length;
  if (n < 4) return { rho: null, lo: null, hi: null, ess: n, n };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { den += (xs[i] - m) ** 2; if (i) num += (xs[i] - m) * (xs[i - 1] - m); }
  if (!den) return { rho: 0, lo: 0, hi: 0, ess: n, n };
  const rho = num / den;
  const z = 0.5 * Math.log((1 + rho) / (1 - rho)), se = 1 / Math.sqrt(n - 3);
  const inv = v => (Math.exp(2 * v) - 1) / (Math.exp(2 * v) + 1);
  return { rho, lo: inv(z - 1.96 * se), hi: inv(z + 1.96 * se), ess: n * (1 - rho) / (1 + rho), n };
}

/** Brier score + expected calibration error over {p: forecast 0..1, y: 0|1} pairs. */
function brierECE(pairs) {
  if (!pairs.length) return { brier: null, ece: null, bins: [], n: 0 };
  let brier = 0; const bins = new Map();
  for (const { p, y } of pairs) {
    brier += (p - y) ** 2;
    const key = Math.round(p * 100);
    if (!bins.has(key)) bins.set(key, [0, 0]);
    const b = bins.get(key); b[0] += y; b[1]++;
  }
  let ece = 0; const out = [];
  for (const [key, [k, n]] of [...bins].sort((a, b) => a[0] - b[0])) {
    const [obs, lo, hi] = wilson(k, n);
    ece += (n / pairs.length) * Math.abs(obs - key / 100);
    out.push({ p: key, obs, lo, hi, n });
  }
  return { brier: brier / pairs.length, ece, bins: out, n: pairs.length };
}

/** Fixed-window walk-forward bucketing (descriptive; fit-free). */
function walkForwardWindows(rows, windowDays, t0Ms) {
  const wf = new Map();
  for (const r of rows) {
    const w = Math.floor((Date.parse(r.firedAt) - t0Ms) / (windowDays * 864e5));
    if (!wf.has(w)) wf.set(w, []);
    wf.get(w).push(r);
  }
  return [...wf].sort((a, b) => a[0] - b[0])
    .map(([w, rs]) => ({ window: w, startMs: t0Ms + w * windowDays * 864e5, rows: rs }));
}

// ─── Kline plumbing ──────────────────────────────────────────────────────────

function indexKlines(k30, k1) {
  return {
    k30, k1,
    k1ByOpen: new Map(k1.map(b => [b.openTime, b])),
    k30Opens: k30.map(b => b.openTime),
    lastK1Open: k1[k1.length - 1].openTime,
  };
}

/** Index of the last 30m bar fully completed (open+30m ≤ ms). */
function idx30LastCompleted(K, ms) {
  let lo = 0, hi = K.k30.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (K.k30Opens[m] + 1800000 <= ms) lo = m + 1; else hi = m; }
  return lo - 1;
}

/** First 30m bar with openTime > ms (canonical-walk semantics). */
function idx30After(K, ms) {
  let lo = 0, hi = K.k30.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (K.k30Opens[m] > ms) hi = m; else lo = m + 1; }
  return lo;
}

/** ATR(14) on 30m bars: SMA of true range over the last 14 COMPLETED bars before ms. */
function atr30m(K, ms, n = 14) {
  const end = idx30LastCompleted(K, ms);
  if (end < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) {
    const b = K.k30[i], pc = K.k30[i - 1].close;
    s += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  return s / n;
}

/** Earliest-achievable market fill after ms: open of the next 1m bar (audit verify.js). */
function mktFillAfter(K, ms, fallbackPx) {
  const nextMin = (Math.floor(ms / 60000) + 1) * 60000;
  const nb = K.k1ByOpen.get(nextMin);
  if (nb) return { px: nb.open, fromMs: nextMin };
  const fb = K.k1ByOpen.get(Math.floor(ms / 60000) * 60000);
  return { px: fb ? fb.close : fallbackPx, fromMs: nextMin };
}

// ─── Gate 1 — symmetric ±1×ATR30m skill test ────────────────────────────────

/**
 * From the honest reference price, does price travel +k×ATR30m in the signal
 * direction before −k×ATR30m against? 1m-bar walk, adverse-first inside a bar
 * (stop-first convention, conservative). Returns 1 / 0 / null (unresolved).
 */
function walkSymmetric(K, px, isLong, fromMs, atr, k = 1) {
  const up = px + k * atr, dn = px - k * atr;
  const start = (Math.floor(fromMs / 60000) + 1) * 60000;
  for (let ms = start; ms <= K.lastK1Open; ms += 60000) {
    const b = K.k1ByOpen.get(ms); if (!b) continue;
    const hitUp = b.high >= up, hitDn = b.low <= dn;
    if (hitUp && hitDn) return 0;                       // both in one bar → adverse-first
    if (isLong) { if (hitDn) return 0; if (hitUp) return 1; }
    else { if (hitUp) return 0; if (hitDn) return 1; }
  }
  return null;
}

/**
 * Symmetric skill over the ledger. New schema: bet from fillPrice at confirmedAt.
 * Legacy schema: bet from the fire-time reference price at firedAt (this is the
 * convention that reproduces the audit's 47.8% on the historical book).
 */
function symmetricSkill(trades, K, { newSchema, k = 1 }) {
  const rows = []; let unresolved = 0, noAtr = 0;
  for (const t of trades) {
    let px, refMs;
    if (newSchema && t.fillPrice != null && t.confirmedAt) {
      px = t.fillPrice; refMs = Date.parse(t.confirmedAt);
    } else if (t.confirmed === true && t.price != null) {
      px = t.price; refMs = Date.parse(t.firedAt);
    } else continue;                                    // never-confirmed ⇒ no honest entry
    const atr = atr30m(K, refMs);
    if (!atr) { noAtr++; continue; }
    const hit = walkSymmetric(K, px, t.direction === 'long', refMs, atr, k);
    if (hit == null) { unresolved++; continue; }
    rows.push({ firedAt: t.firedAt, hit, r: hit ? 1 : -1 });
  }
  const n = rows.length, hits = rows.reduce((s, r) => s + r.hit, 0);
  const [p, lo, hi] = wilson(hits, n);
  const bootHit = bootDayCI(rows, 'hit', 10000, makeRng(7));
  const bootR = bootDayCI(rows, 'r', 10000, makeRng(11));
  const acf = lag1AutocorrESS(rows.map(r => r.hit));
  return { n, hits, p, wilsonLo: lo, wilsonHi: hi, bootHit, bootR, acf, unresolved, noAtr };
}

// ─── Honest ladder walk with fees (context metric; ported verbatim in spirit) ─

function ladderNet(K, t, fillPx, fromMs) {
  const stop = t.stop, isLong = t.direction === 'long';
  const risk = Math.abs(fillPx - stop); if (!(risk > 0)) return null;
  const ratio = fillPx / risk;
  const minGap = Math.max(fillPx * 0.0005, Math.abs(t.entry - t.stop) * 0.1);
  const tps = [t.tp1, t.tp2, t.tp3].filter(v => v != null)
    .filter(px => isLong ? px >= fillPx + minGap : px <= fillPx - minGap);
  const entryFeeR = ratio * TAKER;
  if (!tps.length) return { outcome: 'all_burned', grossR: 0, netR: -2 * ratio * TAKER, feeR: 2 * ratio * TAKER };
  const rungs = tps.map(px => ({ px, rr: (isLong ? px - fillPx : fillPx - px) / risk }));
  const shr = 1 / rungs.length;
  let realized = 0, remaining = 1, hit = 0, feeR = entryFeeR;
  for (let ms = Math.floor(fromMs / 60000) * 60000; ms <= K.lastK1Open; ms += 60000) {
    const b = K.k1ByOpen.get(ms); if (!b || ms < fromMs) continue;
    if (isLong ? b.low <= stop : b.high >= stop) {
      realized += remaining * -1; feeR += remaining * ratio * TAKER;
      return { outcome: hit ? `stop_after_${hit}` : 'stop', grossR: realized, feeR, netR: realized - feeR };
    }
    while (hit < rungs.length) {
      const r = rungs[hit];
      if (!(isLong ? b.high >= r.px : b.low <= r.px)) break;
      realized += shr * r.rr; remaining -= shr; feeR += shr * ratio * MAKER; hit++;
    }
    if (hit === rungs.length) return { outcome: `tp${hit}`, grossR: realized, feeR, netR: realized - feeR };
  }
  return { outcome: 'open', grossR: null, netR: null, feeR };
}

// ─── Gate 2 — random-entry Monte Carlo (canonical accounting, geometry-matched) ─

/** Canonical 30m walk on synthetic geometry (stop-first, tp3→tp1, full position). */
function walk30G(K, g) {
  for (let i = idx30After(K, g.t); i < K.k30.length; i++) {
    const b = K.k30[i];
    if (g.long) {
      if (b.low <= g.stop) return -1;
      if (b.high >= g.tp3) return g.rr3; if (b.high >= g.tp2) return g.rr2; if (b.high >= g.tp1) return g.rr1;
    } else {
      if (b.high >= g.stop) return -1;
      if (b.low <= g.tp3) return g.rr3; if (b.low <= g.tp2) return g.rr2; if (b.low <= g.tp1) return g.rr1;
    }
  }
  return 0;
}

/**
 * ≥200 books of random-minute entries; geometry (risk fraction, limit-advantage,
 * rr ladder, direction) resampled from the real trailing book; canonical accounting.
 * Ladder-net accounting reported alongside on a smaller sim count (runtime).
 */
function randomEntryMC(K, trades, { sims = 200, ladderSims = 30, tMinMs, tMaxMs, rng = makeRng(42) }) {
  const geoms = [];
  for (const t of trades) {
    const planRisk = Math.abs(t.entry - t.stop);
    if (!(planRisk > 0) || t.tp1 == null || t.tp2 == null || t.tp3 == null) continue;
    const { px: mkt } = mktFillAfter(K, Date.parse(t.firedAt), t.price);
    const advR = t.direction === 'long' ? (mkt - t.entry) / planRisk : (t.entry - mkt) / planRisk;
    const g = {
      fr: planRisk / t.price, advR,
      rr1: parseFloat(t.rr1), rr2: parseFloat(t.rr2), rr3: parseFloat(t.rr3),
      long: t.direction === 'long',
    };
    if (isFinite(g.advR) && isFinite(g.rr1) && isFinite(g.rr2) && isFinite(g.rr3)) geoms.push(g);
  }
  if (!geoms.length) return null;
  const nSig = trades.length;
  const simTotals = [], simWr = [], simLadTotals = [];
  for (let s = 0; s < Math.max(sims, ladderSims); s++) {
    let tot = 0, wins = 0, resl = 0, ladTot = 0;
    const doLadder = s < ladderSims;
    for (let i = 0; i < nSig; i++) {
      const g = geoms[(rng() * geoms.length) | 0];
      const τ = tMinMs + rng() * (tMaxMs - tMinMs);
      const ms = Math.floor(τ / 60000) * 60000;
      const b = K.k1ByOpen.get(ms); if (!b) { i--; continue; }
      const p = b.close, risk = g.fr * p;
      const entry = g.long ? p - g.advR * risk : p + g.advR * risk;
      const stop = g.long ? entry - risk : entry + risk;
      const geo = {
        t: ms, long: g.long, stop,
        tp1: g.long ? entry + g.rr1 * risk : entry - g.rr1 * risk,
        tp2: g.long ? entry + g.rr2 * risk : entry - g.rr2 * risk,
        tp3: g.long ? entry + g.rr3 * risk : entry - g.rr3 * risk,
        rr1: g.rr1, rr2: g.rr2, rr3: g.rr3,
      };
      const r = walk30G(K, geo);
      tot += r; if (r !== 0) { resl++; if (r > 0) wins++; }
      if (doLadder) {
        const lad = ladderNet(K, { entry, stop, tp1: geo.tp1, tp2: geo.tp2, tp3: geo.tp3, direction: g.long ? 'long' : 'short' }, p, ms + 60000);
        if (lad && lad.netR != null) ladTot += lad.netR;
      }
    }
    if (s < sims) { simTotals.push(tot); simWr.push(resl ? wins / resl : 0); }
    if (doLadder) simLadTotals.push(ladTot);
  }
  simTotals.sort((a, b) => a - b); simWr.sort((a, b) => a - b); simLadTotals.sort((a, b) => a - b);
  return { simTotals, simWr, simLadTotals, nGeoms: geoms.length, nSig };
}

const percentile = (sorted, v) => sorted.length ? 100 * sorted.filter(x => x < v).length / sorted.length : null;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

// ─── State + trip mechanism (contract with the autotrade layer) ──────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { consecutiveFails: 0, runs: [] }; }
}

function recordRun(result) {
  const state = readState();
  state.lastRunAt = result.at;
  state.lastResult = result.pass ? 'PASS' : 'FAIL';
  state.consecutiveFails = result.pass ? 0 : (state.consecutiveFails || 0) + 1;
  state.runs = [...(state.runs || []), result].slice(-MAX_STATE_RUNS);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

async function maybeTrip(state, dryRun) {
  if (state.consecutiveFails < 2) return false;
  if (fs.existsSync(TRIP_FILE)) {
    console.error(`[falsification] gate failing (${state.consecutiveFails} consecutive) — ${path.basename(TRIP_FILE)} already present, autotrade already disabled`);
    return true;
  }
  const failing = state.runs.filter(r => !r.pass).slice(-state.consecutiveFails);
  const trip = {
    trippedAt: new Date().toISOString(),
    reason: `falsification gate failed ${state.consecutiveFails} consecutive weekly runs`,
    runs: failing,
  };
  fs.writeFileSync(TRIP_FILE, JSON.stringify(trip, null, 2));
  console.error(`[falsification] TRIPPED — wrote ${TRIP_FILE}. Re-enable is manual: operator deletes the file after review.`);
  const webhook = process.env.BLOFIN_RECON_WEBHOOK;
  if (webhook && !dryRun) {
    const lines = [
      '🚨 **FALSIFICATION GATE TRIPPED — AUTOTRADE DISABLED**',
      '',
      `Two consecutive failing weekly runs. \`.autotrade-disabled.json\` written at repo root;`,
      `the autotrade layer skips all new entries while it exists.`,
      '',
      ...failing.map(r => `• ${r.at.slice(0, 10)} — skill ${(r.skill.p * 100).toFixed(1)}% [${(r.skill.bootLo * 100).toFixed(1)}, ${(r.skill.bootHi * 100).toFixed(1)}] (need ≥55, CI>50) · MC pctile ${r.mc.pctile.toFixed(0)} (need >95)`),
      '',
      '**Re-enable is a manual operator action only** — delete `.autotrade-disabled.json` after review.',
    ].join('\n');
    await discord.postWebhook(webhook, 'error', lines, 'Ace • falsification gate • spec 09.1');
  }
  return true;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };
  return {
    trades: get('--trades') || path.join(ROOT, 'trades.json'),
    klinesDir: get('--klines-dir'),
    days: get('--days') || 'all',
    sims: Math.max(200, parseInt(get('--sims') || '200', 10) || 200),
    dryRun: argv.includes('--dry-run'),
    record: argv.includes('--record'),
    selfTest: argv.includes('--self-test'),
  };
}

async function loadKlines(args, windowStartMs) {
  if (args.klinesDir) {
    const k30 = JSON.parse(fs.readFileSync(path.join(args.klinesDir, 'klines-30m.json'), 'utf8'));
    const k1 = JSON.parse(fs.readFileSync(path.join(args.klinesDir, 'klines-1m.json'), 'utf8'));
    if (k30[0].openTime > windowStartMs - 12 * 3600e3) {
      console.error('[falsification] WARNING: klines-30m starts after the ATR warmup window — early trades may be dropped (noAtr)');
    }
    return indexKlines(k30, k1);
  }
  const start = windowStartMs - 2 * 864e5; // 2d margin for ATR(14×30m) warmup
  const end = Date.now();
  console.error(`[falsification] fetching Binance klines ${new Date(start).toISOString().slice(0, 10)} → now …`);
  const k30 = await getKlinesRange(start, end, '30m');
  const k1 = await getKlinesRange(start, end, '1m');
  for (const [bars, step, name] of [[k30, 1800000, '30m'], [k1, 60000, '1m']]) {
    let gaps = 0;
    for (let i = 1; i < bars.length; i++) if (bars[i].openTime - bars[i - 1].openTime !== step) gaps++;
    if (gaps) console.error(`[falsification] WARNING: ${gaps} gaps in ${name} klines`);
  }
  console.error(`[falsification] klines: ${k30.length}×30m, ${k1.length}×1m`);
  return indexKlines(k30, k1);
}

function detectSchema(trades) {
  const resolved = trades.filter(t => ['tp1', 'tp2', 'tp3', 'stop'].includes(t.outcome));
  const sample = resolved.length ? resolved : trades;
  const newSchema = sample.some(t => t.fillPrice != null || t.grossR != null || t.feeR != null);
  if (!newSchema) {
    console.error('╔════════════════════════════════════════════════════════════════════════╗');
    console.error('║ WARNING: LEGACY trades schema detected (planned-entry pnlR; no        ║');
    console.error('║ fillPrice/grossR/feeR). Numbers below are measured with the audit\'s   ║');
    console.error('║ conventions on the OLD ledger — the +R totals are the known-fictional ║');
    console.error('║ accounting (audit D1). Corrected-ledger fields (rebuild spec 03) will ║');
    console.error('║ be preferred automatically once the ledger rewrite lands.             ║');
    console.error('╚════════════════════════════════════════════════════════════════════════╝');
  }
  return newSchema;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = JSON.parse(fs.readFileSync(args.trades, 'utf8'));
  const cutoffMs = args.days === 'all' ? 0 : Date.now() - parseInt(args.days, 10) * 864e5;
  const trades = all.filter(t => Date.parse(t.firedAt) >= cutoffMs);
  if (!trades.length) { console.error('[falsification] no trades in window — nothing to test'); process.exit(0); }

  const newSchema = detectSchema(trades);
  const windowStartMs = Math.min(...trades.map(t => Date.parse(t.firedAt)));
  const K = await loadKlines(args, windowStartMs);

  const label = newSchema ? 'corrected ledger (net-of-fee, spec 03)' : 'LEGACY ledger (planned-entry accounting)';
  console.log(`\n=== FALSIFICATION HARNESS — ${new Date().toISOString()} ===`);
  console.log(`ledger: ${args.trades}`);
  console.log(`window: ${args.days === 'all' ? 'full ledger' : `trailing ${args.days}d`} · n=${trades.length} signals · schema: ${label}`);
  console.log('All numbers below are IN-SAMPLE on the trailing ledger. No out-of-sample estimate exists until one exists.');

  // ── GATE 1 — symmetric skill ──
  const skill = symmetricSkill(trades, K, { newSchema });
  const gate1 = skill.p >= 0.55 && skill.bootHit.lo > 0.50;
  console.log('\n--- GATE 1: symmetric ±1×ATR30m skill ---');
  console.log(`hit ${skill.hits}/${skill.n} = ${(skill.p * 100).toFixed(1)}%  Wilson [${(skill.wilsonLo * 100).toFixed(1)}, ${(skill.wilsonHi * 100).toFixed(1)}]`);
  console.log(`day-clustered bootstrap (B=10000): ${(skill.bootHit.mean * 100).toFixed(1)}% [${(skill.bootHit.lo * 100).toFixed(1)}, ${(skill.bootHit.hi * 100).toFixed(1)}]  days=${skill.bootHit.nDays}`);
  console.log(`mean R (±1 at 1:1), day-clustered: ${skill.bootR.mean.toFixed(3)} [${skill.bootR.lo.toFixed(3)}, ${skill.bootR.hi.toFixed(3)}]`);
  console.log(`lag-1 ρ=${skill.acf.rho.toFixed(3)} [${skill.acf.lo.toFixed(3)}, ${skill.acf.hi.toFixed(3)}]  ESS≈${skill.acf.ess.toFixed(0)} of ${skill.acf.n}`);
  if (skill.unresolved || skill.noAtr) console.log(`excluded: ${skill.unresolved} unresolved, ${skill.noAtr} no-ATR`);
  console.log(`GATE 1: ${gate1 ? 'PASS' : 'FAIL'}  (need ≥55% AND clustered CI lo >50%)`);

  // ── GATE 2 — random-entry Monte Carlo ──
  const tMaxMs = K.k30Opens[K.k30Opens.length - 1] - 7 * 864e5; // leave room to resolve
  const mc = randomEntryMC(K, trades, { sims: args.sims, tMinMs: windowStartMs, tMaxMs, rng: makeRng(42) });
  const actualTotal = trades.reduce((s, t) => s + (t.pnlR ?? 0), 0);
  const q95 = quantile(mc.simTotals, 0.95);
  const pctile = percentile(mc.simTotals, actualTotal);
  const gate2 = actualTotal > q95;
  console.log('\n--- GATE 2: random-entry Monte Carlo (canonical accounting, geometry-matched) ---');
  console.log(`${args.sims} books × ${mc.nSig} random-minute signals (geometry pool ${mc.nGeoms})`);
  console.log(`MC totals: median ${quantile(mc.simTotals, 0.5).toFixed(0)}R  [${mc.simTotals[0].toFixed(0)}, ${mc.simTotals[mc.simTotals.length - 1].toFixed(0)}]  q95=${q95.toFixed(0)}R`);
  console.log(`MC win rates: median ${(quantile(mc.simWr, 0.5) * 100).toFixed(1)}%`);
  console.log(`actual book (Σ ledger ${newSchema ? 'net ' : ''}pnlR): ${actualTotal.toFixed(1)}R → percentile ${pctile.toFixed(0)}`);
  if (mc.simLadTotals.length) {
    console.log(`MC honest-ladder net (fees ${(TAKER * 1e4).toFixed(0)}bp/${(MAKER * 1e4).toFixed(0)}bp, ${mc.simLadTotals.length} books): median ${quantile(mc.simLadTotals, 0.5).toFixed(0)}R  [${mc.simLadTotals[0].toFixed(0)}, ${mc.simLadTotals[mc.simLadTotals.length - 1].toFixed(0)}]`);
  }
  console.log(`GATE 2: ${gate2 ? 'PASS' : 'FAIL'}  (need actual > 95th percentile of random books)`);

  // ── context battery: honest ladder on the real book ──
  const lads = [];
  for (const t of trades) {
    const fired = Date.parse(t.firedAt);
    const { px, fromMs } = mktFillAfter(K, fired, t.price);
    const lad = ladderNet(K, t, px, fromMs);
    if (lad && lad.netR != null) lads.push({ firedAt: t.firedAt, ...lad });
  }
  if (lads.length) {
    const g = lads.reduce((s, r) => s + r.grossR, 0), f = lads.reduce((s, r) => s + r.feeR, 0);
    const bootNet = bootDayCI(lads, 'netR', 10000, makeRng(23));
    console.log('\n--- context: honest ladder from market fill, fees charged (in-sample) ---');
    console.log(`gross ${g.toFixed(1)}R  fees ${f.toFixed(1)}R (mean ${(f / lads.length).toFixed(3)}R/trade)  NET ${(g - f).toFixed(1)}R  n=${lads.length}`);
    console.log(`net mean R/trade day-clustered: ${bootNet.mean.toFixed(3)} [${bootNet.lo.toFixed(3)}, ${bootNet.hi.toFixed(3)}]`);
  }
  if (newSchema) {
    const feeRTot = trades.reduce((s, t) => s + (t.feeR ?? 0), 0);
    console.log(`ledger feeR total (spec 03 fields): ${feeRTot.toFixed(1)}R`);
  }

  // ── context battery: calibration of any published probabilities ──
  const resolved = trades.filter(t => ['tp1', 'tp2', 'tp3', 'stop'].includes(t.outcome));
  const probPairs = resolved.filter(t => t.probability != null)
    .map(t => ({ p: t.probability / 100, y: (t.pnlR ?? 0) > 0 ? 1 : 0 }));
  console.log('\n--- context: calibration of published probabilities (in-sample) ---');
  if (probPairs.length) {
    const cal = brierECE(probPairs);
    console.log(`Brier ${cal.brier.toFixed(4)} (0.25 = coin at p=0.5)  ECE ${(cal.ece * 100).toFixed(1)}pp  n=${cal.n}`);
    for (const b of cal.bins) console.log(`  p=${b.p}%: realized ${(b.obs * 100).toFixed(1)}% [${(b.lo * 100).toFixed(1)}, ${(b.hi * 100).toFixed(1)}] n=${b.n}`);
  } else {
    console.log('no published probabilities on ledger records — nothing to calibrate (correct state per spec 09.2)');
  }

  // ── context battery: walk-forward (only meaningful ≥60d of data) ──
  const spanDays = (Date.now() - windowStartMs) / 864e5;
  if (spanDays >= 60) {
    console.log('\n--- context: walk-forward, 15-day windows (descriptive, in-sample) ---');
    for (const w of walkForwardWindows(trades, 15, windowStartMs)) {
      const res = w.rows.filter(t => ['tp1', 'tp2', 'tp3', 'stop'].includes(t.outcome));
      const wr = res.length ? res.filter(t => (t.pnlR ?? 0) > 0).length / res.length : null;
      console.log(`w${w.window} (${new Date(w.startMs).toISOString().slice(5, 10)}..): n=${w.rows.length} Σ=${w.rows.reduce((s, t) => s + (t.pnlR ?? 0), 0).toFixed(0)}R wr=${wr != null ? (wr * 100).toFixed(0) + '%' : '—'}`);
    }
  }

  const pass = gate1 && gate2;
  console.log(`\n=== OVERALL: ${pass ? 'PASS' : 'FAIL'} ===`);

  // ── self-test reconciliation vs the 2026-07-26 audit ──
  if (args.selfTest) {
    console.log('\n=== SELF-TEST: reconciliation vs 2026-07-26 audit (full historical book) ===');
    const rows = [
      ['symmetric skill hit%', `${(skill.p * 100).toFixed(1)}%`, '47.8%', Math.abs(skill.p * 100 - 47.8) <= 1.0],
      ['  Wilson lo', `${(skill.wilsonLo * 100).toFixed(1)}%`, '44.3%', Math.abs(skill.wilsonLo * 100 - 44.3) <= 1.0],
      ['  Wilson hi', `${(skill.wilsonHi * 100).toFixed(1)}%`, '51.3%', Math.abs(skill.wilsonHi * 100 - 51.3) <= 1.0],
      ['  mean-R clustered CI', `[${skill.bootR.lo.toFixed(2)}, ${skill.bootR.hi.toFixed(2)}]`, '[−0.17, +0.08]', Math.abs(skill.bootR.lo - (-0.17)) <= 0.06 && Math.abs(skill.bootR.hi - 0.08) <= 0.06],
      ['claimed book total', `${actualTotal.toFixed(1)}R`, '+964.7R', Math.abs(actualTotal - 964.7) <= 25],
      ['MC median total', `${quantile(mc.simTotals, 0.5).toFixed(0)}R`, '≈+1032R [966, 1179]', Math.abs(quantile(mc.simTotals, 0.5) - 1032) <= 120],
      ['MC actual percentile', pctile.toFixed(0), '0 (at/near 0th)', pctile <= 5],
      ['lag-1 ρ (skill seq ref: wins ρ=0.349)', skill.acf.rho.toFixed(3), '—', true],
      ['honest ladder NET', lads.length ? `${(lads.reduce((s, r) => s + r.netR, 0)).toFixed(0)}R` : 'n/a', '≈−348R', lads.length ? Math.abs(lads.reduce((s, r) => s + r.netR, 0) - (-348)) <= 60 : false],
      ['honest ladder fees', lads.length ? `${lads.reduce((s, r) => s + r.feeR, 0).toFixed(0)}R` : 'n/a', '≈+359R', lads.length ? Math.abs(lads.reduce((s, r) => s + r.feeR, 0) - 359) <= 40 : false],
      ['Brier (claimed accounting)', probPairs.length ? brierECE(probPairs).brier.toFixed(4) : 'n/a', '0.2122', probPairs.length ? Math.abs(brierECE(probPairs).brier - 0.2122) <= 0.01 : false],
    ];
    let ok = true;
    for (const [name, got, want, fine] of rows) {
      if (!fine) ok = false;
      console.log(`${fine ? '  OK   ' : '  DRIFT'} ${name.padEnd(38)} got ${String(got).padEnd(18)} audit ${want}`);
    }
    console.log(ok ? 'SELF-TEST: reproduces the audit within tolerance.' : 'SELF-TEST: MATERIAL DISAGREEMENT — the port is wrong; reconcile against rebuild/tools/stats.js.');
    if (!ok) process.exitCode = 2;
  }

  // ── Discord post (weekly report channel) ──
  const webhook = process.env.DISCORD_BTC_BACKTEST_WEBHOOK_URL;
  if (!args.dryRun && webhook) {
    const body = [
      `**FALSIFICATION GATE — ${pass ? '✅ PASS' : '❌ FAIL'}** (${args.days === 'all' ? 'full ledger' : `trailing ${args.days}d`}, n=${trades.length}, in-sample, ${newSchema ? 'corrected ledger' : 'legacy ledger — pre-spec-03 accounting'})`,
      '',
      `**Gate 1 — symmetric ±1×ATR30m skill:** ${gate1 ? 'PASS' : 'FAIL'}`,
      `${(skill.p * 100).toFixed(1)}% (${skill.hits}/${skill.n}) · clustered CI [${(skill.bootHit.lo * 100).toFixed(1)}, ${(skill.bootHit.hi * 100).toFixed(1)}] · need ≥55% with CI >50% · ESS≈${skill.acf.ess.toFixed(0)}`,
      '',
      `**Gate 2 — random-entry MC (${args.sims} books):** ${gate2 ? 'PASS' : 'FAIL'}`,
      `actual ${actualTotal.toFixed(1)}R vs MC median ${quantile(mc.simTotals, 0.5).toFixed(0)}R · percentile ${pctile.toFixed(0)} · need >95`,
      '',
      lads.length ? `Honest-ladder context: NET ${(lads.reduce((s, r) => s + r.netR, 0)).toFixed(1)}R (fees ${lads.reduce((s, r) => s + r.feeR, 0).toFixed(1)}R, mean ${(lads.reduce((s, r) => s + r.feeR, 0) / lads.length).toFixed(2)}R/trade) — in-sample` : '',
      fs.existsSync(TRIP_FILE) ? '⚠️ `.autotrade-disabled.json` present — autotrade disabled; re-enable is a manual operator action.' : '',
    ].filter(Boolean).join('\n');
    await discord.postWebhook(webhook, pass ? 'info' : 'error', body, 'Ace • falsification gate • spec 09.1 • weekly');
  } else if (!args.dryRun && !webhook) {
    console.error('[falsification] DISCORD_BTC_BACKTEST_WEBHOOK_URL not set — skipping post');
  }

  // ── record + trip (weekly cron only) ──
  if (args.record) {
    const result = {
      at: new Date().toISOString(), pass,
      windowDays: args.days, n: trades.length, schema: newSchema ? 'corrected' : 'legacy',
      skill: { p: skill.p, n: skill.n, bootLo: skill.bootHit.lo, bootHi: skill.bootHit.hi, ess: skill.acf.ess, pass: gate1 },
      mc: { actual: actualTotal, median: quantile(mc.simTotals, 0.5), q95, pctile, sims: args.sims, pass: gate2 },
    };
    const state = recordRun(result);
    console.log(`[falsification] recorded: consecutiveFails=${state.consecutiveFails}`);
    await maybeTrip(state, args.dryRun);
  }
}

module.exports = {
  wilson, fisherExact, bhFDR, makeRng, bootDayCI, lag1AutocorrESS, brierECE,
  walkForwardWindows, atr30m, walkSymmetric, symmetricSkill, ladderNet, walk30G,
  randomEntryMC, indexKlines, mktFillAfter, TAKER, MAKER, STATE_FILE, TRIP_FILE,
};

if (require.main === module) {
  main().catch(e => { console.error('falsification failed:', e.stack || e.message); process.exit(1); });
}
