#!/usr/bin/env node
'use strict';

/**
 * scripts/research/setup-odds-test.js - how often did the textbook desk-trader setups actually work on the 1h, 15m and
 * 5m charts, and does any filter a desk trader uses turn one of them into a real, repeatable edge?
 *
 * The novice's coach (.claude/watchers/btc-coach.js) prints each setup's record from this test's output, so "high
 * probability" is a number, not a claim. The first version measured the 1h chart only (none positive after fees); the
 * novice then asked for smaller-timeframe setups, so it runs the same three setups, at the same daily levels, on the 1h,
 * 15m and 5m charts under ten filters, and asks two questions of every cell:
 *   1. Probable? How often did +1R come before -1R (Wilson 95%)? Probable = lower bound > 55% in BOTH periods.
 *   2. Profitable? Average result after fees (day-clustered bootstrap). A survivor needs: in-sample (2021-24) mean > 0,
 *      out-of-sample (2025-26) mean > 0, at least 30 out-of-sample trades, and the out-of-sample p-value passing
 *      Benjamini-Hochberg FDR at q = 0.10 across every cell.
 * Pre-registered (written before any result was seen):
 *   setups   REJECTION (wick >= 40%), FAKE BREAK (1-3 closes past, then back), RETEST (break within 1-6 bars, held touch
 *            with wick >= 30%), exactly as in setup-odds-test.js but counted in bars of the timeframe.
 *   levels   previous day high/low, 14-day volume-profile VAL/POC/VAH, daily EMA200 (merged within 0.15%).
 *   trade    entry at the close, stop 0.05% past the extreme, target the next level, R:R after fees >= 1.
 *            Resolved on 5m candles, stop first; time limit 48h (1h), 12h (15m), 4h (5m). Fees 0.16% round trip.
 *            One trade at a time per (cell, side).
 *   filters  all | trend (4h and daily agree) | flow (the candle's CVD agrees and OI did not fall) | A (trend + flow) |
 *            us (bar closes 8:30-11:30 AM New York, weekdays) | vol (volume >= 2x its 20-bar average) |
 *            h1 (the 1h trend agrees) | A+vol | A+us. Plus B (not A), the coach's second grade, reported but not a
 *            hypothesis.
 * Also reports the average result BEFORE fees: if that is not above zero, no cheaper fee or better fill can save it.
 *
 * Usage: node scripts/research/setup-odds-test.js [--json <out>]
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');
const { buildVolumeProfile } = require('../lib/market-data');
const { wilson, makeRng, bhFDR, TAKER } = require('../audit/falsification');
const zones = require('../../config/btc-zones.json');

const M5 = 300_000, M15 = 900_000, H = 3_600_000, H4 = 4 * H, DAY = 86_400_000;
const START = Date.UTC(2021, 0, 1), OOS = Date.UTC(2025, 0, 1);
const MERGE = 0.0015, TOUCH = 0.0005, PAD = 0.0005, GAP = 0.001, COST = 2 * (TAKER + 0.0002), B = 5000;
const TFS = [['1h', H, 48 * H], ['15m', M15, 12 * H], ['5m', M5, 4 * H]];
const FAMS = ['rejection', 'fake break', 'retest'];
const FILTERS = {
  all: () => true, trend: c => c.trendOk, flow: c => c.flowOk, A: c => c.trendOk && c.flowOk, us: c => c.us, vol: c => c.vol,
  h1: c => c.h1Ok, 'A+vol': c => c.trendOk && c.flowOk && c.vol, 'A+us': c => c.trendOk && c.flowOk && c.us,
  B: c => !(c.trendOk && c.flowOk),
};
const DESCRIPTIVE = new Set(['B']); // left out of the FDR family and the verdicts
const cache = f => JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', f), 'utf8'));
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };
const emaSeries = (c, n) => { const k = 2 / (n + 1); let e = c[0]; return c.map(v => (e = v * k + e * (1 - k))); };
const trends = s => { const a = emaSeries(s.c, 20), b = emaSeries(s.c, 50); return s.c.map((p, i) => (p > a[i] && a[i] > b[i] ? 'up' : p < a[i] && a[i] < b[i] ? 'down' : 'mixed')); };
const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
const lastClosed = (s, step, T) => lowerBound(s.t, T - step + 1) - 1; // last bar whose close (t + step) <= T

// New York is UTC-4 from the second Sunday of March 07:00 UTC to the first Sunday of November 06:00 UTC, else UTC-5
const nthSunday = (y, m, n) => { const d = new Date(Date.UTC(y, m, 1)); return Date.UTC(y, m, 1 + ((7 - d.getUTCDay()) % 7) + 7 * (n - 1)); };
const dstCache = new Map();
function nyMinutes(T) {
  const y = new Date(T).getUTCFullYear();
  if (!dstCache.has(y)) dstCache.set(y, [nthSunday(y, 2, 2) + 7 * H, nthSunday(y, 10, 1) + 6 * H]);
  const [a, b] = dstCache.get(y), local = T - (T >= a && T < b ? 4 : 5) * H, d = new Date(local);
  return { min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

function aggregate(k5, step) {
  const out = { t: [], o: [], h: [], l: [], c: [], v: [], tb: [] };
  for (let i = 0; i < k5.t.length; i++) {
    const t = Math.floor(k5.t[i] / step) * step, n = out.t.length - 1;
    if (n < 0 || out.t[n] !== t) { out.t.push(t); out.o.push(k5.o[i]); out.h.push(k5.h[i]); out.l.push(k5.l[i]); out.c.push(k5.c[i]); out.v.push(k5.v[i]); out.tb.push(k5.tb[i]); continue; }
    out.h[n] = Math.max(out.h[n], k5.h[i]); out.l[n] = Math.min(out.l[n], k5.l[i]); out.c[n] = k5.c[i]; out.v[n] += k5.v[i]; out.tb[n] += k5.tb[i];
  }
  // Drop bars with missing 5m pieces (gaps), so a partial bar never poses as a full one
  const want = step / M5, count = new Map();
  for (const t of k5.t) { const b = Math.floor(t / step) * step; count.set(b, (count.get(b) || 0) + 1); }
  const keep = out.t.map(t => count.get(t) === want);
  for (const k of Object.keys(out)) out[k] = out[k].filter((_, i) => keep[i]);
  return out;
}

function main() {
  const k5 = cache('ecl-5m.json'), k4 = cache('ecl-4h.json'), kd = cache('ecl-1d.json'), oiA = cache('oi-archive-5m.json');
  const dataEnd = k5.t.at(-1), i5 = new Map(k5.t.map((t, i) => [t, i]));
  const tr4 = trends(k4), trD = trends(kd), ema200 = emaSeries(kd.c, 200);
  const k1 = aggregate(k5, H), tr1 = trends(k1);
  const oiAt = T => { const k = lowerBound(oiA.t, T + 1) - 1; return k >= 0 && T - oiA.t[k] <= 10 * 60_000 ? oiA.oi[k] : null; };
  const levelCache = new Map(); let p5 = 0;
  function levelsFor(D) {
    if (levelCache.has(D)) return levelCache.get(D);
    const dIdx = kd.t.indexOf(D - DAY);
    if (dIdx < 200) { levelCache.set(D, null); return null; }
    while (p5 < k5.t.length && k5.t[p5] < D - zones.windowDays * DAY) p5++;
    const bars = [];
    for (let i = p5; i < k5.t.length && k5.t[i] < D; i++) bars.push({ h: k5.h[i], l: k5.l[i], v: k5.v[i], tb: k5.tb[i] });
    const vp = buildVolumeProfile(bars, { rowSize: zones.rowSize });
    const all = [kd.h[dIdx], kd.l[dIdx], ema200[dIdx], ...(vp ? [vp.val, vp.poc, vp.vah] : [])].sort((a, b) => a - b);
    const lv = all.filter((L, i) => !all.slice(0, i).some(M => Math.abs(M / L - 1) < MERGE));
    levelCache.set(D, lv);
    return lv;
  }
  function simulate(T, long, entry, stop, target, limit) {
    const k = i5.get(T);
    if (k === undefined) return null;
    const risk = Math.abs(entry - stop), up1 = long ? entry + risk : entry - risk;
    let exit = null, exitT = null, how = 'time', oneR = null;
    for (let i = k; i < k5.t.length && k5.t[i] < T + limit; i++) {
      if (k5.t[i] >= dataEnd) return null;
      const hitStop = long ? k5.l[i] <= stop : k5.h[i] >= stop, hitTgt = long ? k5.h[i] >= target : k5.l[i] <= target;
      const hit1 = long ? k5.h[i] >= up1 : k5.l[i] <= up1;
      if (oneR === null && (hitStop || hit1)) oneR = hitStop ? 0 : 1;
      if (hitStop) { exit = stop; exitT = k5.t[i] + M5; how = 'stop'; break; }
      if (hitTgt) { exit = target; exitT = k5.t[i] + M5; how = 'target'; break; }
      exit = k5.c[i]; exitT = k5.t[i] + M5;
    }
    if (exit === null || (how === 'time' && exitT < T + limit)) return null;
    const gross = (long ? exit - entry : entry - exit) / risk;
    return { exitT, how, oneR: oneR ?? 0, grossR: gross, netR: gross - entry * COST / risk };
  }

  const rng = makeRng(11);
  function stats(rows) {
    if (rows.length < 2) return { n: rows.length };
    const m = new Map();
    for (const r of rows) { const d = Math.floor(r.T / DAY); (m.get(d) || m.set(d, []).get(d)).push(r.netR); }
    const days = [...m.values()], means = [];
    for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let k = 0; k < days.length; k++) { const d = days[(rng() * days.length) | 0]; for (const v of d) { s += v; n++; } } means.push(s / n); }
    means.sort((a, b) => a - b);
    const one = rows.filter(r => r.oneR === 1).length, [o, olo, ohi] = wilson(one, rows.length);
    return { n: rows.length, oneR: o, oneRLo: olo, oneRHi: ohi, win: rows.filter(r => r.how === 'target').length / rows.length,
      meanR: rows.reduce((a, r) => a + r.netR, 0) / rows.length, grossR: rows.reduce((a, r) => a + r.grossR, 0) / rows.length,
      lo: means[(0.025 * B) | 0], hi: means[(0.975 * B) | 0],
      p: (lowerBound(means, 0) + 1) / (B + 1) };
  }

  const cells = [];
  for (const [tf, step, limit] of TFS) {
    const s = tf === '1h' ? k1 : step === M5 ? k5 : aggregate(k5, step);
    const cands = [];
    for (let i = 21; i < s.t.length; i++) {
      const T = s.t[i] + step;
      if (T < START || T > dataEnd) continue;
      const lv = levelsFor(Math.floor(T / DAY) * DAY);
      if (!lv) continue;
      const c = { o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i] }, range = c.h - c.l || 1;
      const up = (c.h - Math.max(c.o, c.c)) / range, dn = (Math.min(c.o, c.c) - c.l) / range;
      const touches = lv.some(L => c.h >= L * (1 - TOUCH) && c.l <= L * (1 + TOUCH)) || lv.some(L => (s.c[i - 1] - L) * (c.c - L) < 0) ||
        lv.some(L => s.c.slice(i - 7, i).some(x => (x - L) * (c.c - L) < 0));
      if (!touches) continue; // nothing near a level: no setup can form (keeps the 5m pass fast)
      const j4 = lastClosed(k4, H4, T), jd = lastClosed(kd, DAY, T), j1 = lastClosed(k1, H, T);
      const cvd = 2 * s.tb[i] - s.v[i], oi0 = oiAt(s.t[i]), oi1 = oiAt(T), oiChg = oi0 && oi1 ? oi1 / oi0 - 1 : null;
      let v20 = 0; for (let k = i - 20; k < i; k++) v20 += s.v[k];
      const ny = nyMinutes(T), us = ny.dow >= 1 && ny.dow <= 5 && ny.min >= 510 && ny.min <= 690, vol = s.v[i] >= 2 * v20 / 20;
      const add = (fam, long, L, extreme) => {
        const entry = c.c, stop = long ? extreme * (1 - PAD) : extreme * (1 + PAD);
        if (long ? stop >= entry : stop <= entry) return;
        const tgt = long ? lv.find(x => x > entry * (1 + GAP)) : lv.filter(x => x < entry * (1 - GAP)).at(-1);
        if (tgt === undefined) return;
        const rr = (Math.abs(tgt - entry) - entry * COST) / (Math.abs(entry - stop) + entry * COST);
        if (rr < 1) return;
        const dir = long ? 'up' : 'down';
        cands.push({ T, fam, long, entry, stop, tgt, trendOk: tr4[j4] === dir && trD[jd] === dir,
          flowOk: oiChg !== null && oiChg >= 0 && (long ? cvd > 0 : cvd < 0), us, vol, h1Ok: tr1[j1] === dir });
      };
      for (const L of lv) {
        if (c.h >= L * (1 - TOUCH) && c.c < L && up >= 0.4) add('rejection', false, L, c.h);
        if (c.l <= L * (1 + TOUCH) && c.c > L && dn >= 0.4) add('rejection', true, L, c.l);
        for (let j = 1; j <= 3; j++) {
          const run = s.c.slice(i - j, i);
          if (run.every(x => x < L) && s.c[i - j - 1] > L && c.c > L) { add('fake break', true, L, Math.min(...s.l.slice(i - j, i + 1))); break; }
          if (run.every(x => x > L) && s.c[i - j - 1] < L && c.c < L) { add('fake break', false, L, Math.max(...s.h.slice(i - j, i + 1))); break; }
        }
        for (let j = 1; j <= 6; j++) {
          const run = s.c.slice(i - j, i);
          if (s.c[i - j - 1] < L && run.every(x => x > L) && c.l <= L * (1 + TOUCH) && c.c > L && dn >= 0.3) { add('retest', true, L, c.l); break; }
          if (s.c[i - j - 1] > L && run.every(x => x < L) && c.h >= L * (1 - TOUCH) && c.c < L && up >= 0.3) { add('retest', false, L, c.h); break; }
        }
      }
    }
    const sims = new Map();
    const sim = c => { if (!sims.has(c)) sims.set(c, simulate(c.T, c.long, c.entry, c.stop, c.tgt, limit)); return sims.get(c); };
    for (const fam of FAMS) for (const [fname, keep] of Object.entries(FILTERS)) {
      const rows = [];
      for (const long of [true, false]) {
        let busy = 0;
        for (const c of cands) {
          if (c.fam !== fam || c.long !== long || c.T < busy || !keep(c)) continue;
          const r = sim(c);
          if (!r) continue;
          rows.push({ T: c.T, ...r }); busy = r.exitT;
        }
      }
      cells.push({ tf, fam, filter: fname, is: stats(rows.filter(r => r.T < OOS)), oos: stats(rows.filter(r => r.T >= OOS)) });
    }
    console.error(`${tf}: ${cands.length} setups found`);
  }

  const family = cells.filter(c => !DESCRIPTIVE.has(c.filter)), sig = bhFDR(family.map(c => c.oos.p ?? 1), 0.10);
  family.forEach((c, k) => {
    c.fdr = sig[k];
    c.survivor = c.fdr && (c.is.meanR ?? -1) > 0 && (c.oos.meanR ?? -1) > 0 && (c.oos.n ?? 0) >= 30;
    c.probable = (c.is.oneRLo ?? 0) > 0.55 && (c.oos.oneRLo ?? 0) > 0.55;
  });
  const f = x => (x == null || !Number.isFinite(x) ? '   -' : (x >= 0 ? '+' : '') + x.toFixed(2));
  const pc = x => (x == null ? ' -' : (x * 100).toFixed(0).padStart(2));
  console.log('tf   setup       filter |  IS n  1R-first  meanR |  OOS n  1R-first  meanR [95% CI]      p      before fees IS/OOS | verdict');
  for (const c of cells) {
    const a = c.is, b = c.oos;
    console.log(`${c.tf.padEnd(4)} ${c.fam.padEnd(11)} ${c.filter.padEnd(6)} | ${String(a.n ?? 0).padStart(5)}  ${pc(a.oneR)}% [${pc(a.oneRLo)}-${pc(a.oneRHi)}] ${f(a.meanR)} | ` +
      `${String(b.n ?? 0).padStart(5)}  ${pc(b.oneR)}% [${pc(b.oneRLo)}-${pc(b.oneRHi)}] ${f(b.meanR)} [${f(b.lo)},${f(b.hi)}] ${(b.p ?? 1).toFixed(4)}  ${f(a.grossR)} / ${f(b.grossR)} | ` +
      `${DESCRIPTIVE.has(c.filter) ? '(descriptive)' : c.survivor ? 'SURVIVOR' : c.probable ? 'probable' : ''}`);
  }
  const pos = family.filter(c => (c.is.grossR ?? -1) > 0 && (c.oos.grossR ?? -1) > 0 && (c.oos.n ?? 0) >= 30);
  console.log(`\nsurvivors: ${family.filter(c => c.survivor).length} of ${family.length}; probable (1R-first lower bound > 55% in both periods): ${family.filter(c => c.probable).length}; ` +
    `positive BEFORE fees in both periods (n OOS >= 30): ${pos.map(c => `${c.tf} ${c.fam} ${c.filter}`).join(', ') || 'none'}`);
  const out = arg('json');
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify({ run: new Date().toISOString(), dataEnd, cells }, null, 2));
}

main();
