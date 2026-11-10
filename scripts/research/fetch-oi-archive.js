#!/usr/bin/env node
'use strict';

/**
 * scripts/research/fetch-oi-archive.js — years of BTCUSDT open interest.
 *
 * `/futures/data/openInterestHist` serves only the last 30 days, which capped
 * the spec-07 OI test (scripts/research/oi-test.js) at a few dozen episodes.
 * Binance's public archive (data.binance.vision) keeps one `metrics` file per
 * day for USDT-M futures with `sum_open_interest` every 5 minutes, back to
 * 2020-09 (probed 2026-11-09; there are no monthly bundles for metrics).
 *
 * Output: columnar { t: [ms], oi: [BTC] } in .market-data-cache/ (gitignored).
 * Resumable: days already covered are skipped. Archive zips are fetched into
 * their own directory and only read with `unzip -p` (data, never executed).
 *
 * Usage: node scripts/research/fetch-oi-archive.js [--start 2020-09-01] [--out <file>]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { ROOT } = require('../lib/env');

const arg = (k, def) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : def; };
const OUT = arg('out', path.join(ROOT, '.market-data-cache', 'oi-archive-5m.json'));
const ZIPS = path.join(ROOT, '.market-data-cache', 'oi-archive-zips');
const START = Date.parse(`${arg('start', '2020-09-01')}T00:00:00Z`);
const BASE = 'https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT';
const DAY = 86_400_000, CONCURRENCY = 6;

function download(url, file, tries = 4) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30_000 }, res => {
      if (res.statusCode === 404) { res.resume(); return resolve(false); } // day not published (yet)
      if (res.statusCode !== 200) {
        res.resume();
        return tries > 0 ? setTimeout(() => download(url, file, tries - 1).then(resolve, reject), 2_000) : reject(new Error(`${res.statusCode} ${url}`));
      }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => resolve(true));
      out.on('error', reject);
    }).on('error', e => (tries > 0 ? setTimeout(() => download(url, file, tries - 1).then(resolve, reject), 2_000) : reject(e)));
  });
}

// CSV header: create_time,symbol,sum_open_interest,sum_open_interest_value,... (create_time is UTC)
function parse(csv) {
  const rows = [];
  for (const line of csv.split('\n')) {
    const f = line.split(',');
    if (f.length < 3 || f[0] === 'create_time') continue;
    const t = Date.parse(`${f[0].replace(' ', 'T')}Z`), oi = +f[2];
    if (Number.isFinite(t) && Number.isFinite(oi) && oi > 0) rows.push([t, oi]);
  }
  return rows;
}

(async () => {
  fs.mkdirSync(ZIPS, { recursive: true });
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { t: [], oi: [] };
  const have = new Set(prev.t.map(t => Math.floor(t / DAY)));
  const days = [];
  for (let d = START; d < Math.floor(Date.now() / DAY) * DAY; d += DAY) if (!have.has(d / DAY)) days.push(d);
  console.log(`${days.length} day(s) to fetch`);

  const got = new Map();
  let done = 0, missing = 0;
  async function worker() {
    while (days.length) {
      const d = days.shift(), ds = new Date(d).toISOString().slice(0, 10);
      const file = path.join(ZIPS, `BTCUSDT-metrics-${ds}.zip`);
      const ok = await download(`${BASE}/BTCUSDT-metrics-${ds}.zip`, file);
      if (!ok) { missing++; continue; }
      got.set(d, parse(execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })));
      fs.unlinkSync(file);
      if (++done % 100 === 0) process.stderr.write(`\r  ${done} days fetched   `);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const all = prev.t.map((t, i) => [t, prev.oi[i]]);
  for (const rows of got.values()) all.push(...rows);
  all.sort((a, b) => a[0] - b[0]);
  const t = [], oi = [];
  for (const [ts, v] of all) if (!t.length || ts > t[t.length - 1]) { t.push(ts); oi.push(v); }
  fs.writeFileSync(OUT, JSON.stringify({ symbol: 'BTCUSDT', interval: '5m', source: 'data.binance.vision metrics', t, oi }));
  console.log(`\n${t.length} rows | ${new Date(t[0]).toISOString().slice(0, 10)} → ${new Date(t.at(-1)).toISOString().slice(0, 16)} | `
    + `${done} new day(s), ${missing} not published → ${path.relative(ROOT, OUT)}`);
})().catch(e => { console.error('fatal:', e.message); process.exit(1); });
