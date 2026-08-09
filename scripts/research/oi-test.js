#!/usr/bin/env node
'use strict';

/**
 * scripts/research/oi-test.js — spec 07 round 10a: OPEN INTEREST.
 *
 * The genuine gap. Round 2 listed OI as untested because Binance caps
 * `/futures/data/openInterestHist` at 30 days, and nobody came back to it. Volume
 * (`volZ`, `tvol`) and CVD/taker-imbalance (`imb`, `imbZ`) HAVE been tested and
 * refuted — order flow was round 2's headline failure at +1.2pp. OI has not.
 *
 * PRE-REGISTERED HYPOTHESES — the textbook four-quadrant reading, declared before
 * running so a sign flip cannot be claimed as a discovery afterwards:
 *   Q1 price↑ OI↑ → new longs, continuation      → predict up
 *   Q2 price↑ OI↓ → short covering, weak rally   → predict down
 *   Q3 price↓ OI↑ → new shorts, continuation     → predict down
 *   Q4 price↓ OI↓ → long liquidation, exhaustion → predict up
 * Plus two continuous cells: OI 30d-percentile extremes (fade and follow).
 * Both directions of every cell are declared. 10 cells total.
 *
 * ⚠️ SAMPLE CEILING, STATED UP FRONT: 30 days is the venue's entire history for
 * this endpoint. At 1h that is ~720 overlapping points — perhaps a few dozen
 * independent episodes after the label horizon. This test CANNOT clear spec
 * 07.1's ≥150-signal / ≥60-day / ≥2-regime bar no matter what it finds. A
 * positive result here is a LEAD to accumulate forward, never a green light.
 * The recorder change (see --record) starts that accumulation.
 *
 * Usage: node scripts/research/oi-test.js [--period 1h] [--k 2] [--horizon 24]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadEnv, ROOT } = require('../lib/env');
loadEnv();
const { getKlinesRange } = require('../lib/binance');
const { wilson, bhFDR } = require('../audit/falsification');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const PERIOD = arg('period', '1h');
const K = Number(arg('k', 2));
const HORIZON_H = Number(arg('horizon', 24));
const CACHE = path.join(ROOT, '.market-data-cache', `oi-${PERIOD}.json`);

const get = url => new Promise((res, rej) => {
  const r = https.get(url, { timeout: 25000, family: 4 }, x => {
    let d = ''; x.on('data', c => (d += c));
    x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0, 140))); } });
  });
  r.on('error', rej); r.on('timeout', () => r.destroy(new Error('timeout')));
});

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const pctlOf = (arr, v) => arr.filter(x => x < v).length / arr.length;

(async () => {
  let oi;
  if (fs.existsSync(CACHE)) {
    oi = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } else {
    console.error(`[oi] fetching openInterestHist period=${PERIOD} (venue caps this at 30 days) …`);
    oi = [];
    let end = Date.now();
    for (let page = 0; page < 12; page++) {
      const b = await get(`https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=${PERIOD}&limit=500&endTime=${end}`);
      if (!Array.isArray(b) || !b.length) break;
      oi.unshift(...b.map(x => ({ t: Number(x.timestamp), oi: Number(x.sumOpenInterest), oiVal: Number(x.sumOpenInterestValue) })));
      end = Number(b[0].timestamp) - 1;
      if (b.length < 500) break;
      await new Promise(r => setTimeout(r, 150));
    }
    const seen = new Set();
    oi = oi.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true))).sort((a, b) => a.t - b.t);
    fs.writeFileSync(CACHE, JSON.stringify(oi));
  }
  if (oi.length < 100) { console.error('insufficient OI history'); process.exit(1); }
  const days = (oi[oi.length - 1].t - oi[0].t) / 864e5;
  console.log(`OI points: ${oi.length} · ${days.toFixed(1)} days · ${new Date(oi[0].t).toISOString().slice(0, 10)} → ${new Date(oi[oi.length - 1].t).toISOString().slice(0, 10)}`);

  // Labels on 1m klines, same convention as every prior round.
  const k1 = await getKlinesRange(oi[0].t - 3600e3, oi[oi.length - 1].t + HORIZON_H * 3600e3 + 3600e3, '1m');
  const byMin = new Map(k1.map(b => [b.openTime, b]));
  const opens = k1.map(b => b.openTime);
  console.log(`label bars: ${k1.length} × 1m\n`);

  function atrAt(ms) {
    let i = opens.length - 1; while (i >= 0 && opens[i] >= ms) i--;
    if (i < 60 * 14) return null;
    let s = 0, n = 0;
    for (let j = i - 60 * 14; j < i; j += 60) {
      let hh = -Infinity, ll = Infinity;
      for (let m = j; m < j + 60 && m <= i; m++) { const b = k1[m]; if (!b) continue; if (b.high > hh) hh = b.high; if (b.low < ll) ll = b.low; }
      if (hh > -Infinity) { s += hh - ll; n++; }
    }
    return n ? s / n : null;
  }
  function label(ms, px, atr) {
    const up = px + K * atr, dn = px - K * atr;
    for (let m = ms + 60000; m <= ms + HORIZON_H * 3600e3; m += 60000) {
      const b = byMin.get(m); if (!b) continue;
      const hu = b.high >= up, hd = b.low <= dn;
      if (hu && hd) return null;
      if (hu) return 1; if (hd) return 0;
    }
    return null;
  }

  // Build rows: OI change and price change over the prior bar, label forward.
  const rows = [];
  const oiHist = [];
  for (let i = 1; i < oi.length; i++) {
    const t = oi[i].t;
    const bar = byMin.get(Math.floor(t / 60000) * 60000);
    if (!bar) continue;
    const prevBar = byMin.get(Math.floor(oi[i - 1].t / 60000) * 60000);
    if (!prevBar) continue;
    oiHist.push(oi[i].oi);
    const atr = atrAt(t); if (!atr) continue;
    const y = label(Math.floor(t / 60000) * 60000, bar.close, atr);
    if (y == null) continue;
    rows.push({
      t, y,
      dOi: oi[i].oi / oi[i - 1].oi - 1,
      dPx: bar.close / prevBar.close - 1,
      oiPctl: oiHist.length > 50 ? pctlOf(oiHist.slice(-720), oi[i].oi) : null,
    });
  }
  const base = mean(rows.map(r => r.y));
  const feeR = 0.0008 / (K * 0.004);
  console.log(`labelled rows: ${rows.length}   base rate up-first ${(base * 100).toFixed(2)}%`);
  console.log(`always-long benchmark = the base rate; break-even ≈ ${(50 * (1 + feeR)).toFixed(1)}% at k=${K}\n`);

  const BASE = base;
  const cells = [];
  const add = (name, pred, predictUp) => {
    const sel = rows.filter(pred);
    if (sel.length < 25) { cells.push({ name, n: sel.length, skip: true }); return; }
    const hit = mean(sel.map(r => (predictUp ? r.y === 1 : r.y === 0) ? 1 : 0));
    const [, lo, hi] = wilson(Math.round(hit * sel.length), sel.length);
    const alwaysLong = mean(sel.map(r => r.y));
    // For a predict-up cell hit === alwaysLong BY CONSTRUCTION, so comparing the
    // two is vacuous. The real question is whether knowing the quadrant beats
    // knowing nothing: contrast against the unconditional base rate, using the
    // same side the cell trades.
    const naive = predictUp ? BASE : 1 - BASE;
    cells.push({ name, n: sel.length, hit, lo, hi, alwaysLong, lift: (hit - naive) * 100 });
  };

  add('Q1 px↑ OI↑ → long',  r => r.dPx > 0 && r.dOi > 0, true);
  add('Q2 px↑ OI↓ → short', r => r.dPx > 0 && r.dOi < 0, false);
  add('Q3 px↓ OI↑ → short', r => r.dPx < 0 && r.dOi > 0, false);
  add('Q4 px↓ OI↓ → long',  r => r.dPx < 0 && r.dOi < 0, true);
  add('Q1 inverse → short', r => r.dPx > 0 && r.dOi > 0, false);
  add('Q2 inverse → long',  r => r.dPx > 0 && r.dOi < 0, true);
  add('Q3 inverse → long',  r => r.dPx < 0 && r.dOi > 0, true);
  add('Q4 inverse → short', r => r.dPx < 0 && r.dOi < 0, false);
  add('OI pctl>0.9 → short', r => r.oiPctl != null && r.oiPctl > 0.9, false);
  add('OI pctl<0.1 → long',  r => r.oiPctl != null && r.oiPctl < 0.1, true);

  console.log(`${'cell'.padEnd(24)} ${'n'.padStart(5)} ${'hit%'.padStart(7)} ${'Wilson95'.padStart(16)} ${'alwaysLong%'.padStart(12)} ${'vs base'.padStart(9)}`);
  for (const c of cells) {
    if (c.skip) { console.log(`${c.name.padEnd(24)} ${String(c.n).padStart(5)}   (n<25 — not scored)`); continue; }
    console.log(`${c.name.padEnd(24)} ${String(c.n).padStart(5)} ${(c.hit * 100).toFixed(2).padStart(6)}% `
      + `[${(c.lo * 100).toFixed(1)},${(c.hi * 100).toFixed(1)}]`.padStart(16)
      + ` ${(c.alwaysLong * 100).toFixed(2).padStart(12)}% ${(c.lift >= 0 ? '+' : '') + c.lift.toFixed(2)}pp`.padStart(9));
  }

  const scored = cells.filter(c => !c.skip);
  const beat = scored.filter(c => c.lo > 0.5 + feeR / 2);
  console.log(`\nbreak-even ${(50 * (1 + feeR)).toFixed(1)}% — cells whose Wilson LOWER bound clears it: ${beat.length}/${scored.length}`);
  console.log(`\n⚠️  SAMPLE CEILING: ${days.toFixed(0)} days is the venue's entire OI history. Even a clean`);
  console.log('   result here cannot satisfy spec 07.1 (≥150 signals, ≥60 days, ≥2 regimes).');
  console.log('   Treat anything positive as a lead to accumulate forward, not a green light.');
})().catch(e => { console.error('oi-test failed:', e.message); process.exit(1); });
