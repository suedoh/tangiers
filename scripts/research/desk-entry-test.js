#!/usr/bin/env node
'use strict';

/**
 * scripts/research/desk-entry-test.js — do the "a desk trader would take this" alerts make money after fees?
 *
 * The live watcher .claude/watchers/btc-entry-watch.js alerts a novice when a 15m or 1h candle rejects a key
 * level in the direction of the 4h + daily trend, the closing 5m flow and open interest agree, and the plan
 * (stop past the wick, target the next level) still pays >= 2x risk after fees. This replays those rules at
 * every 15m and 1h close since 2021, simulates each trade and compares it with random entries of the same
 * risk/reward shape (its "twins"). Rules, cells and the pass bar were fixed first in
 * notes/desk-entry/PREREG-2026-11-10.md — read it before changing anything here.
 *
 * Inputs: the same .market-data-cache files as entry-checklist-test.js (ecl-{5m,1h,4h,1d}.json,
 * oi-archive-5m.json).
 *
 * Usage: node scripts/research/desk-entry-test.js [--json <out>] [--dump N]
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');
const { buildVolumeProfile } = require('../lib/market-data');
const { wilson, bhFDR, makeRng, lag1AutocorrESS, TAKER } = require('../audit/falsification');
const zones = require('../../config/btc-zones.json');

const H = 3_600_000, DAY = 86_400_000, M5 = 300_000, M15 = 900_000, H4 = 4 * H;
const START = Date.UTC(2021, 0, 1), OOS = Date.UTC(2025, 0, 1);
// The live watcher's constants
const MERGE = 0.0015, TOUCH = 0.001, WICK = 0.4, STOP_PAD = 0.0005, TGT_GAP = 0.001, RR_MIN = 2, COOLDOWN = 2 * H;
const SLIP = 0.0002, COST = 2 * (TAKER + SLIP), TIME_STOP = 48 * H;
const B = 10_000, TWINS = 20, TWIN_SPAN = 45 * DAY, MIN_OOS = 150;
const cache = f => JSON.parse(fs.readFileSync(path.join(ROOT, '.market-data-cache', f), 'utf8'));
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };
const iso = t => new Date(t).toISOString().slice(0, 16);

const emaSeries = (c, n) => { const k = 2 / (n + 1); let e = c[0]; return c.map(v => (e = v * k + e * (1 - k))); };
function trends(s) {
  const e20 = emaSeries(s.c, 20), e50 = emaSeries(s.c, 50);
  return s.c.map((p, i) => (p > e20[i] && e20[i] > e50[i] ? 'up' : p < e20[i] && e20[i] < e50[i] ? 'down' : 'mixed'));
}
function lastClosed(s, step, T, from) {
  let i = from;
  while (i + 1 < s.t.length && s.t[i + 1] + step <= T) i++;
  return i;
}
// First index with a[i] >= x
function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

// 15m candles from three consecutive 5m candles; a gap drops that 15m candle
function build15(k5) {
  const s = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i + 2 < k5.t.length; i++) {
    const t = k5.t[i];
    if (t % M15 || k5.t[i + 2] !== t + 2 * M5) continue;
    s.t.push(t); s.o.push(k5.o[i]); s.c.push(k5.c[i + 2]);
    s.h.push(Math.max(k5.h[i], k5.h[i + 1], k5.h[i + 2])); s.l.push(Math.min(k5.l[i], k5.l[i + 1], k5.l[i + 2]));
  }
  return s;
}

function main() {
  const k5 = cache('ecl-5m.json'), k1 = cache('ecl-1h.json'), k4 = cache('ecl-4h.json'), kd = cache('ecl-1d.json');
  const oiA = cache('oi-archive-5m.json');
  const dataEnd = k5.t.at(-1); // the newest 5m candle was still forming when fetched
  const c15 = build15(k5);
  const tr4 = trends(k4), trD = trends(kd), ema200 = emaSeries(kd.c, 200);
  const i5 = new Map(k5.t.map((t, i) => [t, i])), i1 = new Map(k1.t.map((t, i) => [t, i]));
  // OI as of T: the last 5-min row at or before T, unknown if that row is over 10 minutes old (an archive gap)
  const oiAt = T => {
    const k = lowerBound(oiA.t, T + 1) - 1;
    return k >= 0 && T - oiA.t[k] <= 10 * 60_000 ? oiA.oi[k] : null;
  };

  // Levels for UTC day D from data before D: previous day high/low, 14-day VRVP VAL/POC/VAH, daily EMA200
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

  // The trade, resolved on 5m candles after T: first touch wins, both in one candle = the stop
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
    const gross = (long ? exit - entry : entry - exit) / risk;
    return { exitT, exit, how, grossR: gross, netR: gross - entry * COST / risk, riskPct: risk / entry * 100 };
  }

  // ── Every 15m close (and the 1h close at the top of the hour): every level touch that a valid plan exists for ──
  // Each candidate carries the three filter boxes separately so the cells can switch them off one at a time.
  const cands = [], bias15 = new Array(c15.t.length).fill(null);
  let j4 = 0, jd = 0;
  for (let q = 0; q < c15.t.length; q++) {
    const T = c15.t[q] + M15;
    if (T > dataEnd) break;
    j4 = lastClosed(k4, H4, T, j4); jd = lastClosed(kd, DAY, T, jd);
    const bias = tr4[j4] === 'down' && trD[jd] === 'down' ? 'short' : tr4[j4] === 'up' && trD[jd] === 'up' ? 'long' : null;
    bias15[q] = bias;
    if (T < START) continue;
    const lv = levelsFor(Math.floor(T / DAY) * DAY);
    if (!lv) continue;
    const l5 = i5.get(T - M5);
    if (l5 === undefined) continue;
    const last5 = 2 * k5.tb[l5] - k5.v[l5];
    const trig = [['15m', { t: c15.t[q], o: c15.o[q], h: c15.h[q], l: c15.l[q], c: c15.c[q] }]];
    const h1 = i1.get(T - H);
    if (T % H === 0 && h1 !== undefined) trig.push(['1h', { t: T - H, o: k1.o[h1], h: k1.h[h1], l: k1.l[h1], c: k1.c[h1] }]);
    for (const [tf, c] of trig) {
      const oi0 = oiAt(c.t), oi1 = oiAt(T), oiChg = oi0 && oi1 ? oi1 / oi0 - 1 : null;
      const range = c.h - c.l || 1;
      for (const side of ['long', 'short']) {
        const short = side === 'short', wick = short ? c.h - Math.max(c.o, c.c) : Math.min(c.o, c.c) - c.l;
        for (const L of lv) {
          const tested = short ? c.h >= L * (1 - TOUCH) && c.c < L : c.l <= L * (1 + TOUCH) && c.c > L;
          if (!tested) continue;
          const entry = c.c, stop = short ? c.h * (1 + STOP_PAD) : c.l * (1 - STOP_PAD);
          const target = short ? lv.filter(x => x < entry * (1 - TGT_GAP)).at(-1) : lv.find(x => x > entry * (1 + TGT_GAP));
          if (target === undefined) continue;
          const cost = entry * COST, rr = (Math.abs(target - entry) - cost) / (Math.abs(entry - stop) + cost);
          if (rr < RR_MIN) continue;
          cands.push({
            id: cands.length, T, tf, side, L, key: `${side}:${Math.round(L)}`, candle: c, entry, stop, target, rr, last5, oiChg,
            wickPct: wick / range, bias: bias === side, wick: wick / range >= WICK, flow: (short ? last5 < 0 : last5 > 0) && oiChg !== null && oiChg >= 0,
          });
        }
      }
    }
  }

  // ── Twins: the same side and the same stop/target distances in %, entered at random 15m closes within ±45 days ──
  const trng = makeRng(11);
  function twinMean(s, biasOnly) {
    const lo = lowerBound(c15.t, s.T - TWIN_SPAN), hi = lowerBound(c15.t, s.T + TWIN_SPAN);
    const stopPct = Math.abs(s.entry - s.stop) / s.entry, tgtPct = Math.abs(s.target - s.entry) / s.entry, long = s.side === 'long';
    let sum = 0, n = 0;
    for (let tries = 0; n < TWINS && tries < TWINS * 50; tries++) {
      const k = lo + ((trng() * (hi - lo)) | 0);
      if (biasOnly && bias15[k] !== s.side) continue;
      const e = c15.c[k];
      const sim = simulate(c15.t[k] + M15, s.side, e, long ? e * (1 - stopPct) : e * (1 + stopPct), long ? e * (1 + tgtPct) : e * (1 - tgtPct));
      if (sim) { sum += sim.netR; n++; }
    }
    return n ? sum / n : null;
  }
  const simCache = new Map(), twinCache = new Map(), biasTwinCache = new Map();
  const memo = (m, k, f) => (m.has(k) ? m.get(k) : m.set(k, f()).get(k));

  // ── Cells: the live cooldown applies to every alert; one position at a time per (side, cell) for the stats ──
  const CELLS = {
    'all': c => c.wick && c.flow && c.bias,
    '15m only': c => c.tf === '15m' && c.wick && c.flow && c.bias,
    '1h only': c => c.tf === '1h' && c.wick && c.flow && c.bias,
    'no flow box': c => c.wick && c.bias,
    'no wick box': c => c.flow && c.bias,
    'no bias box': c => c.wick && c.flow,
  };
  const PRIMARY = ['long|all', 'short|all'];
  const alerts = {};
  function take(side, name) {
    const pick = CELLS[name], out = [], last = new Map();
    let busy = 0, nAlerts = 0;
    for (const c of cands) {
      if (c.side !== side || !pick(c) || c.T - (last.get(c.key) ?? -Infinity) < COOLDOWN) continue;
      last.set(c.key, c.T); nAlerts++;
      if (c.T < busy) continue;
      const sim = memo(simCache, c.id, () => simulate(c.T, side, c.entry, c.stop, c.target));
      if (!sim) continue;
      const row = { ...c, ...sim };
      row.twinR = memo(twinCache, c.id, () => twinMean(row, false));
      if (row.twinR === null) continue;
      row.diffR = row.netR - row.twinR;
      if (name === 'all') { row.biasTwinR = memo(biasTwinCache, c.id, () => twinMean(row, true)); row.biasDiffR = row.biasTwinR === null ? null : row.netR - row.biasTwinR; }
      out.push(row); busy = sim.exitT;
    }
    alerts[`${side}|${name}`] = nAlerts;
    return out;
  }

  const rng = makeRng(7);
  // Day-clustered bootstrap of the mean of one field, with the one-sided p(mean <= 0)
  function dayBoot(rows, field) {
    const m = new Map();
    for (const r of rows) { if (r[field] == null) continue; const d = Math.floor(r.T / DAY); (m.get(d) || m.set(d, []).get(d)).push(r[field]); }
    const days = [...m.values()], means = [];
    for (let b = 0; b < B; b++) {
      let s = 0, c = 0;
      for (let k = 0; k < days.length; k++) { const d = days[(rng() * days.length) | 0]; for (const v of d) { s += v; c++; } }
      means.push(s / c);
    }
    means.sort((a, b) => a - b);
    return { lo: means[(0.025 * B) | 0], hi: means[(0.975 * B) | 0], p: means.filter(x => x <= 0).length / B, days: days.length };
  }
  function stats(rows, months) {
    if (rows.length < 2) return { n: rows.length };
    const mean = f => { const v = rows.filter(r => r[f] != null); return v.reduce((a, r) => a + r[f], 0) / v.length; };
    const r = dayBoot(rows, 'netR'), d = dayBoot(rows, 'diffR'), bd = rows[0].biasDiffR !== undefined ? dayBoot(rows, 'biasDiffR') : null;
    const [wr, wlo, whi] = wilson(rows.filter(x => x.netR > 0).length, rows.length);
    return {
      n: rows.length, days: r.days, perMonth: rows.length / months, meanR: mean('netR'), lo: r.lo, hi: r.hi, p: r.p, totalR: mean('netR') * rows.length,
      twinR: mean('twinR'), diffR: mean('diffR'), diffLo: d.lo, diffHi: d.hi,
      biasTwinR: bd ? mean('biasTwinR') : null, biasDiffLo: bd?.lo ?? null, biasDiffHi: bd?.hi ?? null,
      grossR: mean('grossR'), winRate: wr, winLo: wlo, winHi: whi, riskPct: mean('riskPct'),
      targets: rows.filter(x => x.how === 'target').length / rows.length, timeStops: rows.filter(x => x.how === 'time').length / rows.length,
      rho: lag1AutocorrESS(rows.map(x => x.netR)).rho,
    };
  }

  const MONTH = 30.44 * DAY, isMonths = (OOS - START) / MONTH, oosMonths = (dataEnd - OOS) / MONTH;
  const results = {}, rowsBy = {};
  for (const side of ['long', 'short']) {
    for (const name of Object.keys(CELLS)) {
      const rows = take(side, name);
      rowsBy[`${side}|${name}`] = rows;
      results[`${side}|${name}`] = { is: stats(rows.filter(x => x.T < OOS), isMonths), oos: stats(rows.filter(x => x.T >= OOS), oosMonths) };
    }
  }
  const sig = bhFDR(PRIMARY.map(k => results[k].oos.p ?? 1));
  PRIMARY.forEach((k, i) => {
    const r = results[k], o = r.oos;
    r.bh = sig[i];
    r.pass = !!(o.n >= MIN_OOS && o.lo > 0 && o.diffLo > 0 && r.is.meanR > 0 && sig[i]);
    r.verdict = r.pass ? 'PASS' : o.n < MIN_OOS && o.meanR > 0 ? 'too few to judge' : 'fail';
  });

  // ── Report ──
  const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '   -' : (x >= 0 ? '+' : '') + x.toFixed(d));
  const line = (k, p) => {
    const s = results[k][p];
    if (!s || s.n < 2) return `  ${p.padEnd(3)} n=${s?.n ?? 0}`;
    return `  ${p.padEnd(3)} n=${String(s.n).padStart(4)} (${s.perMonth.toFixed(1)}/mo)  meanR ${f(s.meanR, 3)} [${f(s.lo, 3)}, ${f(s.hi, 3)}]  grossR ${f(s.grossR, 3)}  `
      + `twins ${f(s.twinR, 3)} diff [${f(s.diffLo, 3)}, ${f(s.diffHi, 3)}]${s.biasTwinR != null ? `  bias-twins ${f(s.biasTwinR, 3)} diff [${f(s.biasDiffLo, 3)}, ${f(s.biasDiffHi, 3)}]` : ''}  `
      + `win ${(s.winRate * 100).toFixed(1)}% [${(s.winLo * 100).toFixed(1)}-${(s.winHi * 100).toFixed(1)}]  target ${(s.targets * 100).toFixed(0)}%  time ${(s.timeStops * 100).toFixed(0)}%  risk ${s.riskPct.toFixed(2)}%  rho ${f(s.rho)}`;
  };
  const oiCover = cands.filter(c => c.oiChg !== null).length / cands.length;
  console.log(`candidates ${cands.length} (${(oiCover * 100).toFixed(1)}% with OI) | ${iso(START)} → ${iso(dataEnd)} | IS < ${iso(OOS)} ≤ OOS | alerts fired: `
    + Object.entries(alerts).map(([k, v]) => `${k} ${v}`).join(', '));
  for (const k of Object.keys(results)) {
    const tag = PRIMARY.includes(k) ? `  ${results[k].verdict.toUpperCase()} (BH ${results[k].bh ? 'yes' : 'no'})` : '';
    console.log(`${k}${tag}`); console.log(line(k, 'is')); console.log(line(k, 'oos'));
  }
  // --dump N [--dump-how stop|target|time]: N evenly spaced trades of the primary cells, for checking by hand
  // against raw Binance candles
  const dump = +arg('dump') || 0, dumpHow = arg('dump-how');
  if (dump) {
    const all = [...rowsBy['long|all'], ...rowsBy['short|all']].filter(s => !dumpHow || s.how === dumpHow).sort((a, b) => a.T - b.T);
    const step = Math.max(1, Math.floor(all.length / dump));
    for (let i = 0; i < all.length && i / step < dump; i += step) {
      const s = all[i], c = s.candle;
      console.log(`DUMP ${iso(s.T)} ${s.tf} ${s.side} L ${s.L.toFixed(1)} candle ${iso(c.t)} O ${c.o} H ${c.h} L ${c.l} C ${c.c} wick ${(s.wickPct * 100).toFixed(0)}% `
        + `last5 ${s.last5.toFixed(1)} oi ${(s.oiChg * 100).toFixed(3)}% | entry ${s.entry} stop ${s.stop.toFixed(1)} target ${s.target.toFixed(1)} rr ${s.rr.toFixed(2)} `
        + `-> ${s.how} ${s.exit} at ${iso(s.exitT)} gross ${s.grossR.toFixed(2)} net ${s.netR.toFixed(2)} twins ${s.twinR.toFixed(2)}`);
    }
  }
  const out = arg('json');
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify({ run: new Date().toISOString(), oiCover, candidates: cands.length, alerts, results }, null, 2));
}

main();
