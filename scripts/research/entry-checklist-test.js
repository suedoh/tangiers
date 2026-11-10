#!/usr/bin/env node
'use strict';

/**
 * scripts/research/entry-checklist-test.js — does the 4-point entry-zone checklist pick better trades?
 *
 * The live alert watchers (.claude/watchers/entry-check.js) score long and short 0-4 on trend (4h + daily),
 * location (at a level), flow (CVD + new OI) and reward:risk >= 2, as learning data for a novice. This replays
 * that checklist at every 1h close since 2021, simulates the textbook trade it implies (stop just past the
 * level, target the next level, 48h time stop, taker fees + slippage) and asks whether high scores beat the
 * same trade taken at any hour. Rules, cells and the pass bar were fixed first in
 * notes/entry-checklist/PREREG-2026-11-09.md — read it before changing anything here.
 *
 * Inputs (.market-data-cache, gitignored): ecl-{5m,1h,4h,1d}.json from fetch-history.js (copies of the
 * research-* candles extended to the run date) and oi-archive-5m.json from fetch-oi-archive.js.
 *
 * Usage: node scripts/research/entry-checklist-test.js [--json <out>]
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');
const { buildVolumeProfile } = require('../lib/market-data');
const { wilson, bhFDR, makeRng, lag1AutocorrESS, TAKER } = require('../audit/falsification');
const zones = require('../../config/btc-zones.json');

const H = 3_600_000, DAY = 86_400_000, M5 = 300_000, H4 = 4 * H;
const START = Date.UTC(2021, 0, 1), OOS = Date.UTC(2025, 0, 1);
const NEAR = 0.003, BUFFER = 0.0015, MERGE = 0.0015, OI_MIN = 0.0015, RR_MIN = 2;
const SLIP = 0.0002, TIME_STOP = 48 * H, B = 10_000;
const cache = f => JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', f), 'utf8'));
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };

const emaSeries = (c, n) => { const k = 2 / (n + 1); let e = c[0]; return c.map(v => (e = v * k + e * (1 - k))); };
// Trend label per bar, as the live check reads it: last close above a rising EMA20 > EMA50 stack = up
function trends(s) {
  const e20 = emaSeries(s.c, 20), e50 = emaSeries(s.c, 50);
  return s.c.map((p, i) => (p > e20[i] && e20[i] > e50[i] ? 'up' : p < e20[i] && e20[i] < e50[i] ? 'down' : 'mixed'));
}
// Index of the last bar of `s` that has fully closed by time T (bars are sorted by open time)
function lastClosed(s, step, T, from) {
  let i = from;
  while (i + 1 < s.t.length && s.t[i + 1] + step <= T) i++;
  return i;
}

function main() {
  const k5 = cache('ecl-5m.json'), k1 = cache('ecl-1h.json'), k4 = cache('ecl-4h.json'), kd = cache('ecl-1d.json');
  const oiA = cache('oi-archive-5m.json');
  // The newest bar of each file was still forming when fetched: data ends where the last 5m bar opened
  const dataEnd = k5.t.at(-1);
  const tr4 = trends(k4), trD = trends(kd), ema200 = emaSeries(kd.c, 200);
  const i5 = new Map(k5.t.map((t, i) => [t, i]));
  let oiPtr = 0;
  // An archive gap must read as unknown, not as the last value carried forward (which would fake "OI flat")
  const oiAt = T => {
    while (oiPtr + 1 < oiA.t.length && oiA.t[oiPtr + 1] <= T) oiPtr++;
    return oiA.t[oiPtr] <= T && T - oiA.t[oiPtr] <= 10 * 60_000 ? oiA.oi[oiPtr] : null;
  };

  // Levels for UTC day D, built only from data before D (live recomputes continuously; daily is the
  // pre-registered approximation): previous day high/low, 14-day VRVP VAL/POC/VAH, daily EMA200
  const levelCache = new Map();
  let p5 = 0;
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

  // The textbook trade, resolved on 5m bars: first touch wins, both in one bar = the stop
  function simulate(T, side, entry, stop, target) {
    const k = i5.get(T);
    if (k === undefined) return null;
    const risk = Math.abs(entry - stop), long = side === 'long';
    let exit = null, exitT = null, how = 'time';
    for (let i = k; i < k5.t.length && k5.t[i] < T + TIME_STOP; i++) {
      if (k5.t[i] >= dataEnd) return null; // ran into the unfinished present
      const hitStop = long ? k5.l[i] <= stop : k5.h[i] >= stop, hitTarget = long ? k5.h[i] >= target : k5.l[i] <= target;
      if (hitStop) { exit = stop; exitT = k5.t[i] + M5; how = 'stop'; break; }
      if (hitTarget) { exit = target; exitT = k5.t[i] + M5; how = 'target'; break; }
      exit = k5.c[i]; exitT = k5.t[i] + M5;
    }
    if (exit === null || (how === 'time' && exitT < T + TIME_STOP)) return null;
    const gross = (long ? exit - entry : entry - exit) / risk, cost = entry * 2 * (TAKER + SLIP) / risk;
    return { exitT, exit, how, grossR: gross, netR: gross - cost, riskPct: risk / entry * 100 };
  }

  // ── Score every 1h close ──
  const setups = [];
  let j4 = 0, jd = 0;
  for (let i = 1; i < k1.t.length; i++) {
    const T = k1.t[i] + H;
    if (T < START || T > dataEnd) continue;
    j4 = lastClosed(k4, H4, T, j4); jd = lastClosed(kd, DAY, T, jd);
    const lv = levelsFor(Math.floor(T / DAY) * DAY);
    if (!lv) continue;
    const P = k1.c[i], cvd = 2 * k1.tb[i] - k1.v[i];
    const oi0 = oiAt(k1.t[i]), oi1 = oiAt(T);
    const oiChg = oi0 && oi1 ? oi1 / oi0 - 1 : null;
    const sup = lv.filter(L => L < P).at(-1), res = lv.find(L => L > P);
    for (const side of ['long', 'short']) {
      const long = side === 'long';
      if (sup === undefined || res === undefined) continue;
      const stop = long ? sup * (1 - BUFFER) : res * (1 + BUFFER), target = long ? res : sup;
      const box = {
        trend: long ? tr4[j4] === 'up' && trD[jd] === 'up' : tr4[j4] === 'down' && trD[jd] === 'down',
        location: long ? (P - sup) / P <= NEAR : (res - P) / P <= NEAR,
        flow: oiChg !== null && oiChg > OI_MIN && (long ? cvd > 0 : cvd < 0),
        rr: Math.abs(target - P) / Math.abs(P - stop) >= RR_MIN,
      };
      const sim = simulate(T, side, P, stop, target);
      if (!sim) continue;
      setups.push({ T, side, P, sup, res, stop, target, cvd, oiChg, score: Object.values(box).filter(Boolean).length, box, oiKnown: oiChg !== null, ...sim });
    }
  }

  // ── Cells: one position at a time per (side, cell), split in-sample / out-of-sample by entry time ──
  const CELLS = {
    'score 4': s => s.score === 4, 'score >=3': s => s.score >= 3, 'score <=2': s => s.score <= 2, 'every hour': () => true,
    'trend only': s => s.box.trend, 'location only': s => s.box.location, 'flow only': s => s.box.flow, 'rr only': s => s.box.rr,
  };
  const PRIMARY = ['long|score 4', 'short|score 4', 'long|score >=3', 'short|score >=3'];
  const take = (side, pick) => {
    const out = []; let busy = 0;
    for (const s of setups) if (s.side === side && s.T >= busy && pick(s)) { out.push(s); busy = s.exitT; }
    return out;
  };
  const rng = makeRng(7);
  const byDay = rows => { const m = new Map(); for (const r of rows) { const d = Math.floor(r.T / DAY); (m.get(d) || m.set(d, []).get(d)).push(r.netR); } return [...m.values()]; };
  const boot = (days, draws) => { let s = 0, c = 0; for (let k = 0; k < draws; k++) { const d = days[(rng() * days.length) | 0]; for (const v of d) { s += v; c++; } } return s / c; };
  // Day-clustered bootstrap of mean net R (and of the difference to a baseline), with a one-sided p(mean <= 0)
  function stats(rows, base) {
    if (rows.length < 2) return { n: rows.length };
    const days = byDay(rows), bdays = base && byDay(base);
    const means = [], diffs = [];
    for (let b = 0; b < B; b++) {
      const m = boot(days, days.length); means.push(m);
      if (bdays) diffs.push(m - boot(bdays, bdays.length));
    }
    means.sort((a, b) => a - b); diffs.sort((a, b) => a - b);
    const mean = rows.reduce((a, r) => a + r.netR, 0) / rows.length, wins = rows.filter(r => r.netR > 0).length;
    const [wr, wlo, whi] = wilson(wins, rows.length);
    return {
      n: rows.length, days: days.length, meanR: mean, lo: means[(0.025 * B) | 0], hi: means[(0.975 * B) | 0],
      p: means.filter(m => m <= 0).length / B, totalR: mean * rows.length,
      diffLo: bdays ? diffs[(0.025 * B) | 0] : null, diffHi: bdays ? diffs[(0.975 * B) | 0] : null,
      winRate: wr, winLo: wlo, winHi: whi, rho: lag1AutocorrESS(rows.map(r => r.netR)).rho,
      riskPct: rows.reduce((a, r) => a + r.riskPct, 0) / rows.length, timeStops: rows.filter(r => r.how === 'time').length / rows.length,
      grossR: rows.reduce((a, r) => a + r.grossR, 0) / rows.length, // before fees: separates "bad picks" from "fees ate it"
    };
  }

  const results = {};
  for (const side of ['long', 'short']) {
    const base = take(side, CELLS['every hour']);
    for (const [name, pick] of Object.entries(CELLS)) {
      const rows = take(side, pick);
      results[`${side}|${name}`] = {
        is: stats(rows.filter(r => r.T < OOS), name === 'every hour' ? null : base.filter(r => r.T < OOS)),
        oos: stats(rows.filter(r => r.T >= OOS), name === 'every hour' ? null : base.filter(r => r.T >= OOS)),
      };
    }
  }
  const sig = bhFDR(PRIMARY.map(k => results[k].oos.p ?? 1));
  PRIMARY.forEach((k, i) => {
    const r = results[k], o = r.oos;
    r.bh = sig[i];
    r.pass = !!(o.n >= 150 && o.lo > 0 && o.diffLo > 0 && r.is.meanR > 0 && sig[i]);
  });

  // ── Report ──
  const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '   -' : (x >= 0 ? '+' : '') + x.toFixed(d));
  const line = (k, p) => {
    const s = results[k][p];
    if (!s || s.n < 2) return `  ${p.padEnd(3)} n=${s?.n ?? 0}`;
    return `  ${p.padEnd(3)} n=${String(s.n).padStart(5)}  meanR ${f(s.meanR, 3)} [${f(s.lo, 3)}, ${f(s.hi, 3)}]  vs base [${f(s.diffLo, 3)}, ${f(s.diffHi, 3)}]  `
      + `win ${(s.winRate * 100).toFixed(1)}% [${(s.winLo * 100).toFixed(1)}-${(s.winHi * 100).toFixed(1)}]  risk ${s.riskPct.toFixed(2)}%  time-stop ${(s.timeStops * 100).toFixed(0)}%  rho ${f(s.rho)}  grossR ${f(s.grossR, 3)}`;
  };
  const oiCover = setups.filter(s => s.oiKnown).length / setups.length;
  console.log(`setups ${setups.length} (${(oiCover * 100).toFixed(1)}% with OI) | ${new Date(START).toISOString().slice(0, 10)} → ${new Date(setups.at(-1).T).toISOString().slice(0, 16)} | IS < ${new Date(OOS).toISOString().slice(0, 10)} ≤ OOS`);
  for (const k of Object.keys(results)) {
    const tag = PRIMARY.includes(k) ? (results[k].pass ? '  PASS' : `  fail (BH ${results[k].bh ? 'yes' : 'no'})`) : '';
    console.log(`${k}${tag}`); console.log(line(k, 'is')); console.log(line(k, 'oos'));
  }
  // --dump N: print N evenly spaced score>=3 setups for checking by hand against the raw candles
  const dump = +arg('dump') || 0;
  if (dump) {
    const hi = setups.filter(s => s.score >= 3), step = Math.max(1, Math.floor(hi.length / dump));
    for (let i = 0; i < hi.length && i / step < dump; i += step) {
      const s = hi[i];
      console.log(`DUMP ${new Date(s.T).toISOString().slice(0, 16)} ${s.side} score ${s.score} ${JSON.stringify(s.box)} P ${s.P} sup ${s.sup.toFixed(1)} res ${s.res.toFixed(1)} `
        + `stop ${s.stop.toFixed(1)} target ${s.target.toFixed(1)} cvd ${s.cvd.toFixed(1)} oi ${s.oiChg == null ? '?' : (s.oiChg * 100).toFixed(2) + '%'} -> ${s.how} ${s.exit} at ${new Date(s.exitT).toISOString().slice(0, 16)} gross ${s.grossR.toFixed(2)} net ${s.netR.toFixed(2)}`);
    }
  }
  const out = arg('json');
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify({ run: new Date().toISOString(), oiCover, setups: setups.length, results }, null, 2));
}

main();
