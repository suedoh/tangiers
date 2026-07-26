#!/usr/bin/env node
'use strict';

/**
 * scripts/research/funding-test.js — pre-registered family 3: perpetual funding.
 *
 * Declared before running: the OHLCV/taker feature set is price-derived, so it
 * cannot see *positioning*. Funding is the one economically-motivated,
 * historically-available variable that can — it is the price crowded longs pay
 * to stay long. Prior: extreme positive funding marks crowded longs and should
 * precede down-first outcomes (and the mirror). Both directions are declared as
 * their own cells, so a sign flip cannot be claimed as a discovery after the fact.
 *
 * Cells (6): {extreme high, extreme low} × {fade, follow} at the 90th/10th
 * percentile of trailing 30d funding, plus the two continuous-tercile cells.
 * All six count toward the cumulative BH-FDR family in rebuild/research-log.md.
 *
 * Usage: node scripts/research/funding-test.js --data .market-data-cache/ds-k1.json
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const ROOT  = path.resolve(__dirname, '..', '..');
const { wilson, bhFDR } = require('../audit/falsification');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

const CACHE = path.join(ROOT, '.market-data-cache', 'funding-btcusdt.json');

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { timeout: 20_000 }, r => {
      let b = ''; r.on('data', d => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function loadFunding(fromMs, toMs) {
  if (fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.length && c[0].t <= fromMs + 86_400_000 && c[c.length - 1].t >= toMs - 86_400_000) return c;
  }
  const out = [];
  let cursor = fromMs;
  while (cursor < toMs) {
    const arr = await get('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT'
      + `&startTime=${cursor}&endTime=${toMs}&limit=1000`);
    if (!Array.isArray(arr) || !arr.length) break;
    for (const f of arr) out.push({ t: f.fundingTime, r: parseFloat(f.fundingRate) });
    const last = arr[arr.length - 1].fundingTime;
    if (last <= cursor) break;
    cursor = last + 1;
    if (arr.length < 1000) break;
    await new Promise(r => setTimeout(r, 200));
  }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(out));
  return out;
}

const lgamma = (() => {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  return function lg(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lg(1 - x);
    x -= 1; let a = 0.99999999999980993; const t = x + 7.5;
    for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  };
})();
const lchoose = (n, k) => (k < 0 || k > n) ? -Infinity : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
function binomTest(k, n, p0 = 0.5) {
  if (!n) return 1;
  const lp = i => lchoose(n, i) + i * Math.log(p0) + (n - i) * Math.log(1 - p0);
  const obs = lp(k);
  let s = 0;
  for (let i = 0; i <= n; i++) if (lp(i) <= obs + 1e-9) s += Math.exp(lp(i));
  return Math.min(1, s);
}

(async () => {
  const dataFile = arg('data', path.join(ROOT, '.market-data-cache', 'ds-k1.json'));
  const { meta, rows } = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const funding = await loadFunding(rows[0].t - 40 * 86_400_000, rows[rows.length - 1].t + 86_400_000);
  console.log(`funding records ${funding.length} | ${new Date(funding[0].t).toISOString().slice(0, 10)} → ${new Date(funding[funding.length - 1].t).toISOString().slice(0, 10)}`);

  // Attach, for each bar, the most recent SETTLED funding rate and its
  // percentile within the trailing 30 days (90 settlements). Strictly causal.
  const fT = funding.map(f => f.t), fR = funding.map(f => f.r);
  let fi = 0;
  const tagged = [];
  for (const r of rows) {
    while (fi + 1 < fT.length && fT[fi + 1] <= r.t) fi++;
    if (fT[fi] > r.t || fi < 90) continue;
    const win = fR.slice(fi - 89, fi + 1);
    const cur = fR[fi];
    const pctl = win.filter(x => x < cur).length / win.length;
    tagged.push({ ...r, fund: cur, fundPctl: pctl });
  }
  console.log(`rows with funding context: ${tagged.length}\n`);

  const CELLS = [
    { id: 'F1-hiFade',    fn: r => r.fundPctl >= 0.9 ? 'short' : null, why: 'crowded longs → fade' },
    { id: 'F2-hiFollow',  fn: r => r.fundPctl >= 0.9 ? 'long'  : null, why: 'explicit inverse of F1' },
    { id: 'F3-loFade',    fn: r => r.fundPctl <= 0.1 ? 'long'  : null, why: 'crowded shorts → fade' },
    { id: 'F4-loFollow',  fn: r => r.fundPctl <= 0.1 ? 'short' : null, why: 'explicit inverse of F3' },
    { id: 'F5-signFade',  fn: r => r.fund > 0 ? 'short' : r.fund < 0 ? 'long' : null, why: 'fade the sign of funding' },
    { id: 'F6-signFollow',fn: r => r.fund > 0 ? 'long'  : r.fund < 0 ? 'short' : null, why: 'explicit inverse of F5' },
  ];

  const atrPcts = tagged.map(r => r.atrPct).sort((a, b) => a - b);
  const medAtr = atrPcts[Math.floor(atrPcts.length / 2)];
  const breakEven = (1 + 0.0008 / (meta.k * medAtr)) / 2;
  console.log(`label ±${meta.k}×ATR | break-even hit ${(100 * breakEven).toFixed(1)}%\n`);

  const res = [];
  for (const c of CELLS) {
    const sel = tagged.filter(r => c.fn(r));
    if (!sel.length) continue;
    const k = sel.filter(r => (c.fn(r) === 'long') === (r.upFirst === 1)).length;
    const al = sel.filter(r => r.upFirst === 1).length / sel.length;
    const [, lo, hi] = wilson(k, sel.length);
    res.push({ id: c.id, why: c.why, n: sel.length, hit: k / sel.length, lo, hi,
               al, drift: k / sel.length - Math.max(al, 1 - al), p: binomTest(k, sel.length) });
  }
  // Cumulative BH family, per rebuild/research-log.md: 98 cells total once this
  // run's 6 are counted. Prior cells enter as p=1 placeholders — they cannot be
  // rejected themselves, but they inflate m, which is the correction required.
  const bh = bhFDR(res.map(r => r.p).concat(new Array(92).fill(1)), 0.10);

  console.log('cell               n    hit%   Wilson95        alwaysLong  lift-vs-drift        p   BH');
  console.log('─'.repeat(88));
  res.forEach((r, i) => console.log(
    r.id.padEnd(14) + String(r.n).padStart(6) + (100 * r.hit).toFixed(2).padStart(8) + '   ' +
    `[${(100 * r.lo).toFixed(1)},${(100 * r.hi).toFixed(1)}]`.padEnd(16) +
    (100 * r.al).toFixed(1).padStart(10) + (100 * r.drift).toFixed(2).padStart(14) + 'pp' +
    r.p.toExponential(2).padStart(11) + (bh[i] ? '  ✓' : '  ·')));
  const best = res.reduce((a, b) => (b.hit > a.hit ? b : a));
  console.log(`\nbest cell ${best.id} at ${(100 * best.hit).toFixed(2)}% vs break-even ${(100 * breakEven).toFixed(1)}% `
    + `→ ${best.hit >= breakEven ? 'CLEARS' : 'short by ' + (100 * (breakEven - best.hit)).toFixed(1) + 'pp'}`);
})().catch(e => { console.error('funding-test failed:', e.message); process.exit(1); });
