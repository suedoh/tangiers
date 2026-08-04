#!/usr/bin/env node
'use strict';

/**
 * scripts/research/blofin-carry-test.js — round 7 economics on BLOFIN'S OWN RATES
 * (spec 07 round 9).
 *
 * Round 7 measured BTC funding carry on BINANCE data and found +7–10%/yr full
 * sample, decaying to ~T-bills by 2026. That number does not transfer: funding is
 * venue-specific, and a spot check on 2026-08-04 found BloFin at **−7.0%/yr**
 * while Binance's trailing 90 settlements ran **+6.34%/yr** — the same asset,
 * ~13pp apart. So the question "is the carry trade viable for us" has to be
 * answered on BloFin's book, not Binance's.
 *
 * CORRECTION OF RECORD: an earlier probe concluded BloFin had no spot market and
 * therefore no second leg. That was wrong. `/api/v1/market/instruments?instType=SPOT`
 * silently ignores instType and returns swaps; the spot API is a SEPARATE
 * namespace — `/api/v1/spot/market/*` — with 241 instruments in prod and 27 in
 * demo, BTC-USDT present in both. The trade IS single-venue executable. This is
 * the exact trap CLAUDE.md warns about: probe first, trust later.
 *
 * Data, all from BloFin public endpoints (no auth, no credentials):
 *   funding : /api/v1/market/funding-rate-history  (100/page, paginate via `after`)
 *   perp    : /api/v1/market/candles
 *   spot    : /api/v1/spot/market/candles
 *
 * FEE CAVEAT: perp maker/taker (2bp/6bp) are MEASURED from real BloFin fills.
 * BloFin SPOT fees are NOT verified — a spot fee probe has never been run. Both a
 * matched-fee case and a pessimistic spot case are reported so the conclusion
 * does not rest on the unverified number.
 *
 * Usage: node scripts/research/blofin-carry-test.js [--days 400]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(ROOT, '.market-data-cache');
const OUT = path.join(CACHE, 'blofin-carry.json');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('days', 400);

const HOST = 'openapi.blofin.com';
function get(p, tries = 3) {
  return new Promise((res, rej) => {
    const r = https.request({ host: HOST, path: p, method: 'GET', family: 4, headers: { 'User-Agent': 'ace-research/1.0' } }, x => {
      let d = ''; x.on('data', c => (d += c));
      x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { tries > 0 ? setTimeout(() => get(p, tries - 1).then(res, rej), 1200) : rej(new Error(d.slice(0, 120))); } });
    });
    r.on('error', e => tries > 0 ? setTimeout(() => get(p, tries - 1).then(res, rej), 1200) : rej(e));
    r.setTimeout(25000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}

async function fundingHistory(instId, sinceMs) {
  const out = new Map();
  let cursor = null;
  for (let page = 0; page < 60; page++) {
    const p = `/api/v1/market/funding-rate-history?instId=${instId}&limit=100` + (cursor ? `&after=${cursor}` : '');
    const j = await get(p);
    const d = j.data || [];
    if (!d.length) break;
    for (const x of d) out.set(Number(x.fundingTime), Number(x.fundingRate));
    const oldest = Math.min(...d.map(x => Number(x.fundingTime)));
    if (oldest <= sinceMs) break;
    cursor = oldest;
    await new Promise(r => setTimeout(r, 110));
  }
  return out;
}

async function candles(pathBase, instId, sinceMs, extra = '') {
  const out = new Map();
  let after = null;
  for (let page = 0; page < 60; page++) {
    const p = `${pathBase}?instId=${instId}&bar=8H&limit=100${extra}` + (after ? `&after=${after}` : '');
    const j = await get(p);
    const d = j.data || [];
    if (!d.length) break;
    for (const c of d) out.set(Number(c[0]), Number(c[4]));   // [ts,o,h,l,c,...]
    const oldest = Math.min(...d.map(c => Number(c[0])));
    if (oldest <= sinceMs) break;
    after = oldest;
    await new Promise(r => setTimeout(r, 110));
  }
  return out;
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const qt = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? NaN; };

function blockBoot(v, t, B = 5000) {
  if (v.length < 15) return [NaN, NaN];
  const blk = {};
  t.forEach((x, i) => { const b = Math.floor(x / (7 * 864e5)); (blk[b] = blk[b] || []).push(v[i]); });
  const keys = Object.keys(blk), out = [];
  for (let i = 0; i < B; i++) {
    let s = 0, n = 0;
    for (let j = 0; j < keys.length; j++) { const g = blk[keys[(Math.random() * keys.length) | 0]]; for (const x of g) { s += x; n++; } }
    out.push(s / n);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(B * .025)], out[Math.floor(B * .975)]];
}

(async () => {
  const since = Date.now() - DAYS * 864e5;
  console.log(`BloFin BTC-USDT — pulling ${DAYS}d of funding + spot/perp candles …`);
  const [fund, perp, spot] = [
    await fundingHistory('BTC-USDT', since),
    await candles('/api/v1/market/candles', 'BTC-USDT', since),
    await candles('/api/v1/spot/market/candles', 'BTC-USDT', since, '&instType=SPOT'),
  ];
  console.log(`funding ${fund.size} settlements · perp ${perp.size} bars · spot ${spot.size} bars`);

  const rows = [];
  for (const [t, r] of [...fund].sort((a, b) => a[0] - b[0])) {
    const bar = Math.floor(t / 288e5) * 288e5 - 288e5;
    const P = perp.get(bar), S = spot.get(bar);
    if (P == null || S == null || !(S > 0)) continue;
    rows.push({ t, r, perp: P, spot: S, basis: (P - S) / S });
  }
  fs.writeFileSync(OUT, JSON.stringify(rows));
  if (rows.length < 30) { console.log(`only ${rows.length} aligned rows — insufficient`); return; }
  console.log(`aligned rows: ${rows.length}  ${new Date(rows[0].t).toISOString().slice(0,10)} → ${new Date(rows[rows.length-1].t).toISOString().slice(0,10)}\n`);

  const fr = rows.map(r => r.r);
  console.log('═══ BLOFIN\'S OWN CARRY ═══');
  console.log(`mean funding / 8h    ${(mean(fr) * 1e4).toFixed(3)} bp   = ${(mean(fr) * 3 * 365 * 100).toFixed(2)}%/yr`);
  console.log(`median               ${(qt(fr, .5) * 1e4).toFixed(3)} bp`);
  console.log(`p10 / p90            ${(qt(fr, .1) * 1e4).toFixed(3)} / ${(qt(fr, .9) * 1e4).toFixed(3)} bp`);
  console.log(`settlements positive ${(fr.filter(x => x > 0).length / fr.length * 100).toFixed(1)}%   (long-spot/short-perp collects only when positive)`);
  console.log(`mean basis           ${(mean(rows.map(r => r.basis)) * 1e4).toFixed(2)} bp`);
  console.log(`\nfor reference, round 7 on BINANCE full sample: 1.065 bp/8h = 11.67%/yr, 85.5% positive`);

  // Fee cases. Perp legs measured; spot legs unverified.
  const CASES = [
    ['matched maker  ', 0.0002, 0.0002],
    ['spot 10bp maker', 0.0002, 0.0010],
    ['all taker      ', 0.0006, 0.0006],
  ];
  console.log('\n═══ SIMULATED CARRY ON BLOFIN RATES ═══  (return on capital: spot 1.0× + perp margin at 10×)');
  console.log(`${'fees'.padEnd(17)} ${'hold'.padEnd(10)} ${'n'.padStart(4)} ${'carry'.padStart(9)} ${'basis'.padStart(9)} ${'cost'.padStart(8)} ${'net/trade'.padStart(10)} ${'ann%'.padStart(8)} ${'win%'.padStart(5)}  95% CI (ann%)`);
  const capMult = 1.1;
  for (const [name, fPerp, fSpot] of CASES) {
    const rt = 2 * (fPerp + fSpot);
    for (const hold of [21, 45, 90]) {
      const nets = [], ts = [], carries = [], bas = [];
      for (let i = 0; i + hold < rows.length; i += hold) {
        const e = rows[i], x = rows[i + hold];
        let c = 0; for (let j = i + 1; j <= i + hold; j++) c += rows[j].r;
        const b = e.basis - x.basis;
        nets.push((c + b - rt) / capMult); carries.push(c); bas.push(b); ts.push(e.t);
      }
      if (nets.length < 3) continue;
      const py = (3 * 365) / hold;
      const [lo, hi] = blockBoot(nets, ts);
      console.log(`${name.padEnd(17)} ${(hold + '×8h').padEnd(10)} ${String(nets.length).padStart(4)} `
        + `${(mean(carries) * 100).toFixed(3).padStart(8)}% ${(mean(bas) * 100).toFixed(3).padStart(8)}% ${(rt * 100).toFixed(3).padStart(7)}% `
        + `${(mean(nets) * 100).toFixed(3).padStart(9)}% ${(mean(nets) * py * 100).toFixed(2).padStart(7)}% `
        + `${(nets.filter(x => x > 0).length / nets.length * 100).toFixed(0).padStart(4)}%  `
        + `[${(lo * py * 100).toFixed(1)}, ${(hi * py * 100).toFixed(1)}]`);
    }
  }

  console.log('\n═══ REGIME ═══');
  const byM = {};
  for (const r of rows) { const m = new Date(r.t).toISOString().slice(0, 7); (byM[m] = byM[m] || []).push(r.r); }
  for (const m of Object.keys(byM).sort()) {
    const v = byM[m];
    console.log(`  ${m}  n=${String(v.length).padStart(3)}  ${(mean(v) * 1e4).toFixed(3).padStart(7)} bp/8h  ${(mean(v) * 3 * 365 * 100).toFixed(1).padStart(7)}%/yr  positive ${(v.filter(x => x > 0).length / v.length * 100).toFixed(0).padStart(3)}%`);
  }
})().catch(e => { console.error('blofin-carry-test failed:', e.message); process.exit(1); });
