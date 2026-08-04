#!/usr/bin/env node
'use strict';

/**
 * scripts/research/carry-test.js — spec 07 round 7: perpetual funding CARRY.
 *
 * Different in kind from rounds 1–6. Those asked "can we predict direction?" and
 * the answer, over 255 FDR cells, was no. This asks a structural question with
 * no forecast in it:
 *
 *   Hold long spot + short perp (delta-neutral). Collect the 8-hourly funding
 *   the crowded side pays. Does that payment exceed the cost of holding both
 *   legs?
 *
 * Price direction cancels between the legs, so nothing here depends on being
 * right about where BTC goes. That is the entire point.
 *
 * NOT to be confused with round 2's funding family (F1–F6), which used funding
 * as a DIRECTIONAL predictor and was refuted. This captures the payment itself.
 *
 * P&L decomposition per trade, all in fractions of notional:
 *   spot leg   : (S_exit − S_entry)/S_entry
 *   perp short : (P_entry − P_exit)/P_entry
 *   → together ≈ basis_entry − basis_exit    where basis = (P − S)/S
 *   funding    : Σ f_i over held settlements (received when short and f>0)
 *   costs      : 4 legs (open spot, open perp, close spot, close perp)
 *
 * total = (basis_entry − basis_exit) + Σf − costs
 *
 * Capital: spot must be fully funded (1.0× notional) plus perp initial margin
 * (1/leverage). Return on CAPITAL is what is reported — return on notional
 * would flatter the strategy by the leverage factor.
 *
 * Usage:
 *   node scripts/research/carry-test.js
 *   node scripts/research/carry-test.js --hold 21 --fee-model taker
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(ROOT, '.market-data-cache');
const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const LEVERAGE = Number(arg('leverage', 10));

// Fee models. Perp side measured from real BloFin fills (audit §2): 6bp taker,
// 2bp maker. Spot side uses Binance published retail tiers. Both round trips
// are reported because execution style is the single biggest lever the operator
// actually controls.
const FEES = {
  taker: { perp: 0.0006, spot: 0.0010 },   // cross the spread on all four legs
  mixed: { perp: 0.0004, spot: 0.0006 },   // half passive
  maker: { perp: 0.0002, spot: 0.0002 },   // fully passive, both venues
};

function get(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: 30000, family: 4 }, r => {
      let b = ''; r.on('data', d => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error(b.slice(0, 200))); } });
    });
    req.on('error', rej);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function klines(host, symbol, interval, startMs, endMs, cacheName) {
  const cf = path.join(CACHE, cacheName);
  if (fs.existsSync(cf)) {
    const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
    if (c.length && c[0][0] <= startMs + 864e5 && c[c.length - 1][0] >= endMs - 3 * 864e5) return c;
  }
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://${host}/${host.startsWith('fapi') ? 'fapi/v1' : 'api/v3'}/klines`
      + `?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const b = await get(url);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    cursor = b[b.length - 1][0] + 1;
    if (b.length < 1000) break;
    await new Promise(r => setTimeout(r, 120));
  }
  fs.writeFileSync(cf, JSON.stringify(out));
  return out;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };

/** 7-day block bootstrap CI on a mean — trades overlap in time, iid is too tight. */
function blockBoot(vals, times, B = 5000) {
  if (vals.length < 20) return [NaN, NaN];
  const blk = {};
  times.forEach((t, i) => { const b = Math.floor(t / (7 * 864e5)); (blk[b] = blk[b] || []).push(vals[i]); });
  const keys = Object.keys(blk), out = [];
  for (let i = 0; i < B; i++) {
    let s = 0, n = 0;
    for (let j = 0; j < keys.length; j++) {
      const v = blk[keys[(Math.random() * keys.length) | 0]];
      for (const x of v) { s += x; n++; }
    }
    out.push(s / n);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(B * 0.025)], out[Math.floor(B * 0.975)]];
}

(async () => {
  const funding = JSON.parse(fs.readFileSync(path.join(CACHE, 'funding-full.json'), 'utf8'))
    .filter(f => Number.isFinite(f.r)).sort((a, b) => a.t - b.t);
  const t0 = funding[0].t, t1 = funding[funding.length - 1].t;
  console.log(`funding settlements: ${funding.length}  ${new Date(t0).toISOString().slice(0,10)} → ${new Date(t1).toISOString().slice(0,10)}`);

  console.log('fetching spot + perp 8h klines …');
  const [spotK, perpK] = await Promise.all([
    klines('api.binance.com', 'BTCUSDT', '8h', t0 - 864e5, t1 + 864e5, 'carry-spot-8h.json'),
    klines('fapi.binance.com', 'BTCUSDT', '8h', t0 - 864e5, t1 + 864e5, 'carry-perp-8h.json'),
  ]);
  const spot = new Map(spotK.map(k => [k[0], +k[4]]));   // close
  const perp = new Map(perpK.map(k => [k[0], +k[4]]));
  console.log(`spot ${spotK.length} bars · perp ${perpK.length} bars`);

  // Align funding settlements to the 8h bar that closes at that settlement.
  const rows = [];
  for (const f of funding) {
    const barOpen = Math.floor(f.t / 288e5) * 288e5 - 288e5; // bar whose close ≈ settlement
    const s = spot.get(barOpen), p = perp.get(barOpen);
    if (s == null || p == null) continue;
    rows.push({ t: f.t, r: f.r, spot: s, perp: p, basis: (p - s) / s });
  }
  console.log(`aligned rows: ${rows.length}\n`);

  // ── the raw carry ──────────────────────────────────────────────────────────
  const fr = rows.map(r => r.r);
  const posShare = fr.filter(x => x > 0).length / fr.length;
  console.log('═══ THE RAW CARRY ═══');
  console.log(`mean funding / 8h      ${(mean(fr) * 1e4).toFixed(3)} bp   (${(mean(fr) * 3 * 365 * 100).toFixed(2)}% annualised)`);
  console.log(`median                 ${(q(fr, .5) * 1e4).toFixed(3)} bp`);
  console.log(`p10 / p90              ${(q(fr, .1) * 1e4).toFixed(3)} / ${(q(fr, .9) * 1e4).toFixed(3)} bp`);
  console.log(`settlements positive   ${(posShare * 100).toFixed(1)}%  (short-perp collects)`);
  console.log(`mean basis (perp−spot) ${(mean(rows.map(r => r.basis)) * 1e4).toFixed(2)} bp`);
  console.log();

  console.log('═══ BREAK-EVEN HOLD ═══  (how many 8h periods of carry pay for one round trip)');
  console.log('fee model   round-trip cost   periods needed   = days');
  for (const [name, f] of Object.entries(FEES)) {
    const rt = 2 * (f.perp + f.spot);
    const periods = rt / mean(fr);
    console.log(`${name.padEnd(11)} ${(rt * 1e4).toFixed(1).padStart(8)} bp   ${periods.toFixed(1).padStart(14)}   ${(periods / 3).toFixed(1).padStart(6)}`);
  }
  console.log();

  // ── simulated carry trades ─────────────────────────────────────────────────
  console.log('═══ SIMULATED DELTA-NEUTRAL CARRY ═══');
  console.log('long spot + short perp, entered every 8h, held N periods, non-overlapping capital');
  console.log('return on CAPITAL (spot 1.0x notional + perp margin 1/lev), net of all 4 legs\n');
  console.log(`${'hold'.padEnd(12)} ${'n'.padStart(5)} ${'gross carry'.padStart(12)} ${'basis P&L'.padStart(10)} ${'cost'.padStart(8)} ${'NET/trade'.padStart(10)} ${'ann.%'.padStart(8)} ${'win%'.padStart(6)}  ${'95% block CI (ann.%)'.padStart(22)}`);

  const capMult = 1 + 1 / LEVERAGE;
  const results = {};
  for (const feeName of ['taker', 'mixed', 'maker']) {
    const F = FEES[feeName];
    const rt = 2 * (F.perp + F.spot);
    console.log(`\n── fee model: ${feeName} (perp ${(F.perp*1e4).toFixed(0)}bp, spot ${(F.spot*1e4).toFixed(0)}bp per side; round trip ${(rt*1e4).toFixed(0)}bp) ──`);
    for (const hold of [3, 9, 21, 45, 90, 180]) {
      const trades = [];
      for (let i = 0; i + hold < rows.length; i += hold) {   // non-overlapping
        const e = rows[i], x = rows[i + hold];
        let carry = 0;
        for (let j = i + 1; j <= i + hold; j++) carry += rows[j].r;  // short receives when r>0
        const basisPnl = e.basis - x.basis;
        const net = (carry + basisPnl - rt) / capMult;
        trades.push({ net, carry, basisPnl, t: e.t });
      }
      if (trades.length < 10) continue;
      const nets = trades.map(t => t.net);
      const perYear = (3 * 365) / hold;
      const ann = mean(nets) * perYear * 100;
      const [lo, hi] = blockBoot(nets, trades.map(t => t.t));
      const win = nets.filter(x => x > 0).length / nets.length;
      console.log(`${(hold + ' × 8h').padEnd(12)} ${String(trades.length).padStart(5)} `
        + `${(mean(trades.map(t => t.carry)) * 100).toFixed(3).padStart(11)}% `
        + `${(mean(trades.map(t => t.basisPnl)) * 100).toFixed(3).padStart(9)}% `
        + `${(rt * 100).toFixed(3).padStart(7)}% `
        + `${(mean(nets) * 100).toFixed(3).padStart(9)}% `
        + `${ann.toFixed(2).padStart(7)}% ${(win * 100).toFixed(1).padStart(5)}%  `
        + `[${(lo * perYear * 100).toFixed(2)}, ${(hi * perYear * 100).toFixed(2)}]`);
      results[`${feeName}-${hold}`] = { ann, lo: lo * perYear * 100, hi: hi * perYear * 100, n: trades.length, win };
    }
  }

  // ── regime stability on the best-looking configuration ─────────────────────
  console.log('\n═══ REGIME STABILITY ═══  (mixed fees, hold 21 × 8h = 7 days)');
  const F = FEES.mixed, rt = 2 * (F.perp + F.spot), hold = 21;
  const byYear = {};
  for (let i = 0; i + hold < rows.length; i += hold) {
    const e = rows[i], x = rows[i + hold];
    let carry = 0;
    for (let j = i + 1; j <= i + hold; j++) carry += rows[j].r;
    const net = (carry + (e.basis - x.basis) - rt) / capMult;
    const y = new Date(e.t).getUTCFullYear();
    (byYear[y] = byYear[y] || []).push(net);
  }
  const perYear = (3 * 365) / hold;
  console.log('year     n    net/trade    annualised    win%');
  for (const y of Object.keys(byYear).sort()) {
    const v = byYear[y];
    console.log(`${y}  ${String(v.length).padStart(3)}  ${(mean(v) * 100).toFixed(3).padStart(9)}%  ${(mean(v) * perYear * 100).toFixed(2).padStart(11)}%  ${(v.filter(x => x > 0).length / v.length * 100).toFixed(0).padStart(5)}%`);
  }

  console.log('\n═══ WHAT KILLS IT ═══');
  const neg = rows.filter(r => r.r < 0).length;
  console.log(`funding negative on ${(neg / rows.length * 100).toFixed(1)}% of settlements — you PAY on those`);
  let worst = 0, run = 0;
  for (const r of rows) { run = r.r < 0 ? run + r.r : 0; worst = Math.min(worst, run); }
  console.log(`worst cumulative negative-funding run: ${(worst * 100).toFixed(3)}% of notional`);
  const bmoves = [];
  for (let i = 21; i < rows.length; i++) bmoves.push(Math.abs(rows[i].basis - rows[i - 21].basis));
  console.log(`|Δbasis| over 7 days: median ${(q(bmoves, .5) * 100).toFixed(3)}%  p95 ${(q(bmoves, .95) * 100).toFixed(3)}%`);
  console.log(`  → basis noise p95 is ${(q(bmoves, .95) / (mean(fr) * 21)).toFixed(1)}× the 7-day carry — this is the real risk, not direction`);
})().catch(e => { console.error('carry-test failed:', e.message); process.exit(1); });
