#!/usr/bin/env node
'use strict';

/**
 * scripts/research/early-warning-test.js — which clues warn of a big BTC move at least 15 minutes ahead?
 *
 * A novice watching BTC asked for alerts with at least 15 minutes of heads-up before a big move. Direction is
 * not the target (nearly 300 direction ideas have failed here); the question is which clues make a ±1% move
 * more likely to arrive AFTER a 15-minute warning, beyond what current volatility already implies. Every 15m
 * close since 2021 is scored on five long-history clues (volume while calm, OI build-up while flat, funding
 * extreme, absorption, the US morning) plus two exploratory order-book clues, against a placebo and an
 * "already moving" control. Rules, cells and the pass bar were fixed first in
 * notes/early-warning/PREREG-2026-11-10.md — read it before changing anything here.
 *
 * Inputs: .market-data-cache/ecl-5m.json and oi-archive-5m.json (as entry-checklist-test.js), funding history
 * (fetched into .market-data-cache/ews-funding.json on first run or with --refresh-funding), and the
 * book-recorder corpus in data/orderbook/.
 *
 * Usage: node scripts/research/early-warning-test.js [--json <out>] [--refresh-funding]
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/env');
const { wilson, bhFDR, makeRng } = require('../audit/falsification');

const H = 3_600_000, DAY = 86_400_000, M5 = 300_000, M15 = 900_000;
const START = Date.UTC(2021, 0, 1), OOS = Date.UTC(2025, 0, 1);
const MOVE = 0.01, LEAD = 15 * 60_000, WIN = 2 * H + LEAD, COOLDOWN = 2 * H, B = 10_000;
const LIQ_START = Date.UTC(2026, 6, 27, 12, 45); // liquidation columns are structurally empty before this
const MAX_SAMPLES = 600;                         // depth20@100ms cap; above it a reconnect double-counted
const CACHE = path.join(ROOT, '.market-data-cache');
const cache = f => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : undefined; };
const iso = t => new Date(t).toISOString().slice(0, 16);

function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
// Quantiles of the finite values in a[lo, hi)
function quantiles(a, lo, hi, qs) {
  const v = [];
  for (let i = lo; i < hi; i++) if (Number.isFinite(a[i])) v.push(a[i]);
  if (v.length < 20) return null;
  v.sort((x, y) => x - y);
  return qs.map(q => v[Math.min(v.length - 1, Math.floor(q * v.length))]);
}

async function loadFunding() {
  const file = path.join(CACHE, 'ews-funding.json');
  if (fs.existsSync(file) && !process.argv.includes('--refresh-funding')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = { t: [], r: [] };
  for (let from = Date.UTC(2019, 8, 1); ;) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=${from}&limit=1000`);
    if (!res.ok) throw new Error(`fundingRate ${res.status}`);
    const rows = await res.json();
    for (const f of rows) { out.t.push(+f.fundingTime); out.r.push(+f.fundingRate); }
    if (rows.length < 1000) break;
    from = +rows.at(-1).fundingTime + 1;
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

// One row per UTC minute from book-recorder; only rows that can be trusted (see the PREREG's exclusions)
function loadBook() {
  const dir = path.join(ROOT, 'data', 'orderbook'), rows = new Map();
  if (!fs.existsSync(dir)) return rows;
  for (const f of fs.readdirSync(dir).filter(f => /^btcusdt-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.gap || !(r.samples > 0) || r.samples > MAX_SAMPLES) continue;
      rows.set(r.t, r);
    }
  }
  return rows;
}

async function main() {
  const k5 = cache('ecl-5m.json'), oiA = cache('oi-archive-5m.json'), fund = await loadFunding(), book = loadBook();
  const dataEnd = k5.t.at(-1); // the newest 5m candle was still forming when fetched
  const i5 = new Map(k5.t.map((t, i) => [t, i]));

  // ── 15m candles (three 5m candles, gaps dropped), indexed by close time ──
  const s = { T: [], o: [], h: [], l: [], c: [], v: [], d: [] };
  for (let i = 0; i + 2 < k5.t.length; i++) {
    const t = k5.t[i];
    if (t % M15 || k5.t[i + 2] !== t + 2 * M5 || t + M15 > dataEnd) continue;
    s.T.push(t + M15); s.o.push(k5.o[i]); s.c.push(k5.c[i + 2]);
    s.h.push(Math.max(k5.h[i], k5.h[i + 1], k5.h[i + 2])); s.l.push(Math.min(k5.l[i], k5.l[i + 1], k5.l[i + 2]));
    const v = k5.v[i] + k5.v[i + 1] + k5.v[i + 2], tb = k5.tb[i] + k5.tb[i + 1] + k5.tb[i + 2];
    s.v.push(v); s.d.push(2 * tb - v);
  }
  const N = s.T.length, nan = () => new Float64Array(N).fill(NaN);
  const oiAt = T => { const k = lowerBound(oiA.t, T + 1) - 1; return k >= 0 && T - oiA.t[k] <= 10 * 60_000 ? oiA.oi[k] : null; };
  // Range of the n candles ending at q, as a fraction of the close; NaN if they are not contiguous
  const rangeOf = (q, n) => {
    if (q - n + 1 < 0 || s.T[q] - s.T[q - n + 1] !== (n - 1) * M15) return NaN;
    let hi = -Infinity, lo = Infinity;
    for (let j = q - n + 1; j <= q; j++) { hi = Math.max(hi, s.h[j]); lo = Math.min(lo, s.l[j]); }
    return (hi - lo) / s.c[q];
  };

  // ── Features per 15m close ──
  const volX = nan(), r2h = nan(), r4h = nan(), r6h = nan(), oi4h = nan(), absD = nan(), body = nan(), fundR = nan(), depth = nan(), liq = nan();
  const nyMorning = new Uint8Array(N);
  const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  let fp = 0;
  for (let q = 0; q < N; q++) {
    const T = s.T[q];
    if (q >= 20 && s.T[q] - s.T[q - 20] === 20 * M15) { let m = 0; for (let j = q - 20; j < q; j++) m += s.v[j]; volX[q] = s.v[q] / (m / 20); }
    r2h[q] = rangeOf(q, 8); r4h[q] = rangeOf(q, 16); r6h[q] = rangeOf(q, 24);
    const a = oiAt(T - 4 * H), b = oiAt(T); if (a && b) oi4h[q] = b / a - 1;
    absD[q] = Math.abs(s.d[q]); body[q] = Math.abs(s.c[q] - s.o[q]) / s.o[q];
    while (fp + 1 < fund.t.length && fund.t[fp + 1] <= T) fp++;
    if (fund.t[fp] <= T) fundR[q] = fund.r[fp];
    if (T % H === LEAD) {
      const p = Object.fromEntries(nyFmt.formatToParts(new Date(T)).map(x => [x.type, x.value]));
      nyMorning[q] = p.hour === '08' && p.minute === '15' && !['Sat', 'Sun'].includes(p.weekday) ? 1 : 0;
    }
    if (book.size) {
      let dSum = 0, dN = 0, lSum = 0, lN = 0;
      for (let m = T - M15; m < T; m += 60_000) {
        const r = book.get(m); if (!r) continue;
        if (Number.isFinite(r.dBid) && Number.isFinite(r.dAsk)) { dSum += r.dBid + r.dAsk; dN++; }
        if (m >= LIQ_START && Number.isFinite(r.liqLong) && Number.isFinite(r.liqShort)) { lSum += r.liqLong + r.liqShort; lN++; }
      }
      if (dN >= 12) depth[q] = dSum / dN;
      if (lN >= 12) liq[q] = lSum;
    }
  }

  // ── Daily thresholds from the prior 30 days (7 for the order book, 90 for funding) ──
  const days = new Map();
  const thr = q => {
    const D = Math.floor(s.T[q] / DAY) * DAY;
    if (days.has(D)) return days.get(D);
    const w = n => [lowerBound(s.T, D - n * DAY), lowerBound(s.T, D)];
    const [a30, b30] = w(30), [a7, b7] = w(7);
    const fA = lowerBound(fund.t, D - 90 * DAY), fB = lowerBound(fund.t, D);
    const t = {
      r2hCuts: quantiles(r2h, a30, b30, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]),
      r6h90: quantiles(r6h, a30, b30, [0.9])?.[0], r4h50: quantiles(r4h, a30, b30, [0.5])?.[0],
      oi90: quantiles(oi4h, a30, b30, [0.9])?.[0], absD95: quantiles(absD, a30, b30, [0.95])?.[0], body50: quantiles(body, a30, b30, [0.5])?.[0],
      fund: fB - fA >= 60 ? quantiles(fund.r, fA, fB, [0.05, 0.95]) : null,
      depth10: quantiles(depth, a7, b7, [0.1])?.[0], liq99: quantiles(liq, a7, b7, [0.99])?.[0],
    };
    days.set(D, t);
    return t;
  };
  const decile = q => { const c = thr(q).r2hCuts; if (!c || !Number.isFinite(r2h[q])) return -1; let k = 0; while (k < 9 && r2h[q] > c[k]) k++; return k; };

  // ── Outcomes per 15m close ──
  // primary: first ±1% touch (from the close at T) lands after T+15m and by T+2h15m, none inside the warning
  // (a): ±1% from the price at T+15m within 2h · (b): ±1.5% from the price at T+15m within 6h
  const prim = new Int8Array(N).fill(-1), outA = new Int8Array(N).fill(-1), outB = new Int8Array(N).fill(-1);
  const lead = nan(), up = new Int8Array(N).fill(-1);
  const touch = (k, P, pct, until) => {
    for (let i = k; i < k5.t.length && k5.t[i] + M5 <= until; i++) {
      const hiHit = k5.h[i] >= P * (1 + pct), loHit = k5.l[i] <= P * (1 - pct);
      if (hiHit || loHit) return { end: k5.t[i] + M5, up: hiHit && !loHit ? 1 : loHit && !hiHit ? 0 : -1 };
    }
    return null;
  };
  for (let q = 0; q < N; q++) {
    const T = s.T[q], k = i5.get(T), k15 = i5.get(T + LEAD);
    if (k === undefined || k15 === undefined || k5.t[k15 - 1] !== T + LEAD - M5) continue;
    const P15 = k5.c[k15 - 1];
    if (T + WIN <= dataEnd) {
      const f = touch(k, s.c[q], MOVE, T + WIN);
      prim[q] = f && f.end > T + LEAD ? 1 : 0;
      if (prim[q]) { lead[q] = (f.end - T) / 60_000; up[q] = f.up; }
      outA[q] = touch(k15, P15, MOVE, T + LEAD + 2 * H) ? 1 : 0;
    }
    if (T + LEAD + 6 * H <= dataEnd) outB[q] = touch(k15, P15, 0.015, T + LEAD + 6 * H) ? 1 : 0;
  }

  // ── Clues ──
  const CLUES = {
    E1: { name: 'volume while calm', fires: q => { const t = thr(q); return volX[q] >= 3 && t.r6h90 !== undefined && r6h[q] <= t.r6h90; } },
    E2: { name: 'OI build-up while flat', fires: q => { const t = thr(q); return oi4h[q] >= t.oi90 && r4h[q] <= t.r4h50; } },
    E3: { name: 'funding extreme', fires: q => { const f = thr(q).fund; return !!f && (fundR[q] <= f[0] || fundR[q] >= f[1]); } },
    E4: { name: 'absorption', fires: q => { const t = thr(q); return absD[q] >= t.absD95 && body[q] <= t.body50; } },
    E5: { name: 'US morning 8:15 ET', fires: q => nyMorning[q] === 1 },
    B1: { name: 'thin book', book: true, fires: q => depth[q] <= thr(q).depth10 },
    B2: { name: 'liquidation burst', book: true, fires: q => liq[q] > 0 && liq[q] >= thr(q).liq99 },
    C0: { name: 'already moving (control)', fires: q => decile(q) === 9 },
  };
  const LONG = ['E1', 'E2', 'E3', 'E4', 'E5'];
  const valid = q => prim[q] >= 0 && decile(q) >= 0;

  // Periods: IS / OOS for long-history clues; chronological halves of the corpus (after a 7-day warm-up) for the book
  let bookFrom = Infinity;
  for (const t of book.keys()) bookFrom = Math.min(bookFrom, t);
  bookFrom += 7 * DAY;
  const bookMid = bookFrom + (dataEnd - bookFrom) / 2;
  const PERIODS = { is: [START, OOS], oos: [OOS, Infinity], h1: [bookFrom, bookMid], h2: [bookMid, Infinity] };
  const inP = (q, p) => s.T[q] >= PERIODS[p][0] && s.T[q] < PERIODS[p][1];

  // Base rates per period: plain, and per volatility decile, for each outcome
  const OUTS = { prim, a: outA, b: outB };
  const base = {};
  for (const p of Object.keys(PERIODS)) {
    base[p] = {};
    for (const [o, arr] of Object.entries(OUTS)) {
      const hit = new Array(10).fill(0), n = new Array(10).fill(0);
      let H1 = 0, N1 = 0;
      for (let q = 0; q < N; q++) {
        if (!inP(q, p) || !valid(q) || arr[q] < 0) continue;
        const d = decile(q); hit[d] += arr[q]; n[d]++; H1 += arr[q]; N1++;
      }
      base[p][o] = { plain: N1 ? H1 / N1 : NaN, dec: hit.map((h, d) => (n[d] ? h / n[d] : NaN)), n: N1 };
    }
  }
  // Big-move episodes per period (primary outcome turning on), for the "how many moves got a warning" figure
  const episodes = {};
  for (const p of Object.keys(PERIODS)) {
    episodes[p] = [];
    for (let q = 1; q < N; q++) if (inP(q, p) && prim[q] === 1 && prim[q - 1] === 0 && s.T[q] - s.T[q - 1] === M15) episodes[p].push(s.T[q]);
  }

  const alertsOf = (fires, p) => {
    const out = []; let last = -Infinity;
    for (let q = 0; q < N; q++) {
      if (!inP(q, p) || !valid(q) || !fires(q) || s.T[q] - last < COOLDOWN) continue;
      out.push(q); last = s.T[q];
    }
    return out;
  };
  const rng = makeRng(7);
  function stats(qs, p) {
    if (qs.length < 2) return { n: qs.length };
    const bp = base[p], days = new Map();
    for (const q of qs) {
      const d = Math.floor(s.T[q] / DAY), e = bp.prim.dec[decile(q)];
      const x = days.get(d) || days.set(d, [0, 0]).get(d); x[0] += prim[q]; x[1] += e;
    }
    const dv = [...days.values()], lifts = [];
    for (let b = 0; b < B; b++) {
      let h = 0, e = 0;
      for (let k = 0; k < dv.length; k++) { const x = dv[(rng() * dv.length) | 0]; h += x[0]; e += x[1]; }
      lifts.push(h / e);
    }
    lifts.sort((a, b) => a - b);
    const mean = (arr, f) => { let h = 0, n = 0; for (const q of qs) if (arr[q] >= 0) { h += f ? f(q) : arr[q]; n++; } return n ? h / n : NaN; };
    const vm = o => mean(OUTS[o]) / mean(OUTS[o], q => bp[o].dec[decile(q)]);
    const hits = qs.filter(q => prim[q] === 1), leads = hits.map(q => lead[q]).sort((a, b) => a - b), dir = hits.filter(q => up[q] >= 0);
    const [hr, hlo, hhi] = wilson(hits.length, qs.length);
    const span = Math.max(DAY, Math.min(PERIODS[p][1], dataEnd) - Math.max(PERIODS[p][0], s.T[0]));
    const eps = episodes[p], aT = qs.map(q => s.T[q]);
    const warned = eps.filter(t => { const i = lowerBound(aT, t - 2 * H); return i < aT.length && aT[i] <= t; }).length;
    return {
      n: qs.length, perDay: qs.length / (span / DAY), hit: hr, hitLo: hlo, hitHi: hhi, base: bp.prim.plain,
      liftPlain: hr / bp.prim.plain, liftVM: vm('prim'), lo: lifts[(0.025 * B) | 0], hi: lifts[(0.975 * B) | 0], p: lifts.filter(x => x <= 1).length / B,
      liftA: vm('a'), liftB: vm('b'), medLead: leads.length ? leads[leads.length >> 1] : null,
      upShare: dir.length ? dir.filter(q => up[q] === 1).length / dir.length : null, episodes: eps.length, warned: eps.length ? warned / eps.length : null,
    };
  }

  const results = {};
  for (const [id, c] of Object.entries(CLUES)) {
    const ps = c.book ? ['h1', 'h2'] : ['is', 'oos'];
    results[id] = { name: c.name };
    for (const p of ps) results[id][p] = stats(alertsOf(c.fires, p), p);
  }
  // Placebo: random valid closes, as many as E1 alerted, per period
  const prng = makeRng(13);
  results.P0 = { name: 'placebo (random times)' };
  for (const p of ['is', 'oos']) {
    const pool = []; for (let q = 0; q < N; q++) if (inP(q, p) && valid(q)) pool.push(q);
    const pick = new Set(); while (pick.size < Math.min(results.E1[p].n, pool.length)) pick.add(pool[(prng() * pool.length) | 0]);
    results.P0[p] = stats([...pick].sort((a, b) => a - b), p);
  }
  const sig = bhFDR(LONG.map(id => results[id].oos.p ?? 1));
  LONG.forEach((id, i) => {
    const r = results[id], o = r.oos;
    r.bh = sig[i];
    r.pass = !!(o.n >= 100 && o.liftVM >= 1.2 && o.lo > 1 && r.is.liftVM > 1 && sig[i]);
  });
  for (const id of ['B1', 'B2']) {
    const r = results[id];
    r.lead = [r.h1, r.h2].every(x => x.n >= 30 && x.liftVM >= 1.2);
  }

  // ── Post-hoc robustness (NOT pre-registered; reported as such) ──
  // Big moves cluster by time of day, so a clue that tends to fire before the US session could be borrowing
  // E5's effect. Re-match E1/E2 on (New York hour × volatility decile), drop E2 alerts from 7-11 AM New York,
  // and vary E2's two cut-points to see whether the effect lives only at the pre-registered values.
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  const nyHour = new Int8Array(N);
  for (let q = 0; q < N; q++) nyHour[q] = +hourFmt.format(new Date(s.T[q])) % 24;
  const hourBase = {};
  for (const p of ['is', 'oos']) {
    const hit = new Float64Array(240), n = new Float64Array(240);
    for (let q = 0; q < N; q++) if (inP(q, p) && valid(q)) { const k = nyHour[q] * 10 + decile(q); hit[k] += prim[q]; n[k]++; }
    hourBase[p] = Array.from(hit, (h, k) => (n[k] ? h / n[k] : NaN));
  }
  const liftBy = (qs, p, exp) => { let h = 0, e = 0; for (const q of qs) { h += prim[q]; e += exp(q); } return { n: qs.length, lift: h / e }; };
  const gridDays = new Map();
  const grid = q => {
    const D = Math.floor(s.T[q] / DAY) * DAY;
    if (!gridDays.has(D)) {
      const a = lowerBound(s.T, D - 30 * DAY), b = lowerBound(s.T, D);
      gridDays.set(D, { oi: quantiles(oi4h, a, b, [0.8, 0.9, 0.95]), r: quantiles(r4h, a, b, [0.4, 0.5, 0.6]) });
    }
    return gridDays.get(D);
  };
  const robust = {};
  for (const p of ['is', 'oos']) {
    const r = robust[p] = {};
    for (const id of ['E1', 'E2']) r[`${id} hour-matched`] = liftBy(alertsOf(CLUES[id].fires, p), p, q => hourBase[p][nyHour[q] * 10 + decile(q)]);
    r['E2 outside 7-11 AM NY'] = liftBy(alertsOf(q => CLUES.E2.fires(q) && (nyHour[q] < 7 || nyHour[q] > 10), p), p, q => base[p].prim.dec[decile(q)]);
    [0.8, 0.9, 0.95].forEach((oq, i) => [0.4, 0.5, 0.6].forEach((rq, j) => {
      r[`E2 OI≥p${oq * 100} range≤p${rq * 100}`] = liftBy(alertsOf(q => { const g = grid(q); return !!g.oi && !!g.r && oi4h[q] >= g.oi[i] && r4h[q] <= g.r[j]; }, p), p, q => base[p].prim.dec[decile(q)]);
    }));
  }

  // ── Report ──
  const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(d));
  const pc = x => (x == null || !Number.isFinite(x) ? '-' : (x * 100).toFixed(1) + '%');
  console.log(`15m closes ${N} | ${iso(START)} → ${iso(dataEnd)} | IS < ${iso(OOS)} ≤ OOS | book ${book.size} minutes, halves split ${iso(bookMid)}`);
  for (const p of ['is', 'oos', 'h1', 'h2']) console.log(`  base ${p}: primary ${pc(base[p].prim.plain)} (n ${base[p].prim.n}) · (a) ${pc(base[p].a.plain)} · (b) ${pc(base[p].b.plain)} · deciles ${base[p].prim.dec.map(x => pc(x)).join(' ')} · episodes ${episodes[p].length}`);
  for (const [id, r] of Object.entries(results)) {
    const tag = LONG.includes(id) ? (r.pass ? '  PASS' : `  fail (BH ${r.bh ? 'yes' : 'no'})`) : r.lead !== undefined ? (r.lead ? '  LEAD' : '  no lead') : '';
    console.log(`${id} ${r.name}${tag}`);
    for (const p of Object.keys(r).filter(k => PERIODS[k])) {
      const x = r[p];
      if (!x || x.n < 2) { console.log(`  ${p.padEnd(3)} n=${x?.n ?? 0}`); continue; }
      console.log(`  ${p.padEnd(3)} n=${String(x.n).padStart(5)} (${f(x.perDay)}/day)  hit ${pc(x.hit)} vs base ${pc(x.base)}  lift plain ${f(x.liftPlain)}  vol-matched ${f(x.liftVM)} [${f(x.lo)}, ${f(x.hi)}] p=${f(x.p, 3)}  `
        + `(a) ${f(x.liftA)} (b) ${f(x.liftB)}  lead median ${f(x.medLead, 0)}m  warned ${pc(x.warned)} of ${x.episodes} moves  up ${pc(x.upShare)}`);
    }
  }
  console.log('POST-HOC robustness (not pre-registered): vol-matched lift unless noted');
  for (const k of Object.keys(robust.is)) console.log(`  ${k.padEnd(28)} is ${f(robust.is[k].lift)} (n ${robust.is[k].n})  oos ${f(robust.oos[k].lift)} (n ${robust.oos[k].n})`);
  const out = arg('json');
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify({ run: new Date().toISOString(), dataEnd, base, results, robust }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
