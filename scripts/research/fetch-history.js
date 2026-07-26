#!/usr/bin/env node
'use strict';

/**
 * scripts/research/fetch-history.js — market history for spec 07 signal research.
 *
 * Pulls Binance USDT-M futures klines and stores them COLUMNAR (arrays of
 * numbers, not objects) so two years of 1-minute bars stay a ~40 MB file
 * instead of ~400 MB of JSON object overhead.
 *
 * Two series, two jobs:
 *   30m — features. Keeps takerBuyBase (kline field 9) and tradeCount (8),
 *         which the repo's shared getKlinesRange() drops. Per-bar aggressor
 *         imbalance is the only order-flow measure available this far back,
 *         and it is exactly the thing spec 07 wants tested natively.
 *   1m  — labels. Symmetric ±k×ATR outcomes are path-dependent; resolving them
 *         on 5m bars leaves ambiguous bars where both barriers fall inside one
 *         bar. 1m is what the audit used for its 633/633 cross-verification,
 *         so labels stay comparable to published numbers.
 *
 * Output is research data, not repo data — default lands in .market-data-cache/
 * (gitignored); pass --out to redirect. Resumable: an existing file is extended
 * from its last bar rather than refetched.
 *
 * Usage:
 *   node scripts/research/fetch-history.js --years 2
 *   node scripts/research/fetch-history.js --start 2024-07-26 --interval 30m --out /tmp/k30.json
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');

const INTERVAL_MS = { '1m': 60_000, '5m': 300_000, '30m': 1_800_000, '1h': 3_600_000 };

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : def;
}

function get(url, tries = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20_000 }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 418/429 = rate limited. Back off hard; Binance means it.
          if (tries > 0 && (res.statusCode === 429 || res.statusCode === 418 || res.statusCode >= 500)) {
            const waitMs = res.statusCode === 429 || res.statusCode === 418 ? 60_000 : 2_000;
            return setTimeout(() => get(url, tries - 1).then(resolve, reject), waitMs);
          }
          return reject(new Error(`http ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', e => {
      if (tries > 0) return setTimeout(() => get(url, tries - 1).then(resolve, reject), 2_000);
      reject(e);
    });
  });
}

// Columnar store. t/o/h/l/c/v always; 30m also carries tb (taker buy base) and n
// (trade count) — the fields that make aggressor imbalance computable.
function emptyStore(interval) {
  return { symbol: 'BTCUSDT', interval, t: [], o: [], h: [], l: [], c: [], v: [], tb: [], n: [] };
}

async function fetchInto(store, startMs, endMs, interval) {
  const step = INTERVAL_MS[interval];
  let cursor = startMs;
  let reqs = 0;
  const t0 = Date.now();
  while (cursor < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}`
              + `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const arr = await get(url);
    reqs++;
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const k of arr) {
      // Guard against overlap on resume — the API is inclusive of startTime.
      if (store.t.length && k[0] <= store.t[store.t.length - 1]) continue;
      store.t.push(k[0]);
      store.o.push(+k[1]); store.h.push(+k[2]); store.l.push(+k[3]); store.c.push(+k[4]);
      store.v.push(+k[5]); store.tb.push(+k[9]); store.n.push(+k[8]);
    }
    const last = arr[arr.length - 1][0];
    if (last < cursor) break;              // no forward progress — bail, never spin
    cursor = last + step;
    if (arr.length < 1000) break;
    if (reqs % 25 === 0) {
      const pct = (100 * (cursor - startMs) / (endMs - startMs)).toFixed(1);
      process.stderr.write(`\r  ${interval}: ${store.t.length} bars (${pct}%, ${reqs} reqs, ${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
    }
    // fapi allows 2400 weight/min; a limit=1000 klines call costs 5. Stay well under.
    await new Promise(r => setTimeout(r, 120));
  }
  process.stderr.write('\n');
  return reqs;
}

function integrity(store) {
  const step = INTERVAL_MS[store.interval];
  let gaps = 0, dupes = 0, missingBars = 0;
  for (let i = 1; i < store.t.length; i++) {
    const d = store.t[i] - store.t[i - 1];
    if (d === 0) dupes++;
    else if (d !== step) { gaps++; missingBars += Math.round(d / step) - 1; }
  }
  return { gaps, dupes, missingBars };
}

(async () => {
  const interval = arg('interval', null);
  const intervals = interval ? [interval] : ['30m', '1m'];
  const years = Number(arg('years', 2));
  const endMs = Number(arg('end', Date.now()));
  const startMs = arg('start')
    ? Date.parse(`${arg('start')}T00:00:00Z`)
    : endMs - years * 365 * 86_400_000;

  for (const iv of intervals) {
    const out = arg('out') || path.join(ROOT, '.market-data-cache', `research-${iv}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    let store = emptyStore(iv);
    let from = startMs;
    if (fs.existsSync(out)) {
      try {
        const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
        if (prev.interval === iv && prev.t?.length) {
          store = prev;
          from = prev.t[prev.t.length - 1] + INTERVAL_MS[iv];
          console.log(`${iv}: resuming from ${new Date(from).toISOString()} (${prev.t.length} bars on disk)`);
        }
      } catch { /* corrupt cache — refetch */ }
    }

    if (from < endMs) await fetchInto(store, from, endMs, iv);

    const chk = integrity(store);
    fs.writeFileSync(out, JSON.stringify(store));
    const sizeMb = (fs.statSync(out).size / 1e6).toFixed(1);
    console.log(`${iv}: ${store.t.length} bars | ${new Date(store.t[0]).toISOString().slice(0, 10)} → `
      + `${new Date(store.t[store.t.length - 1]).toISOString().slice(0, 10)} | gaps ${chk.gaps} `
      + `(${chk.missingBars} missing bars) dupes ${chk.dupes} | ${sizeMb} MB → ${path.relative(ROOT, out)}`);
  }
})().catch(e => { console.error('fetch-history failed:', e.message); process.exit(1); });
