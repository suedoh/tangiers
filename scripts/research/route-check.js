#!/usr/bin/env node
'use strict';

/**
 * scripts/research/route-check.js — which Binance futures streams actually deliver?
 *
 * Binance's 2026-03-06 WebSocket upgrade split market data across routed paths
 * (/public, /market, /private) and decommissioned the legacy un-routed URLs on
 * 2026-04-23. The failure mode is silent and nasty: an un-routed socket opens
 * normally, ACKs SUBSCRIBE, lists the subscription back to you — and then never
 * sends a frame. book-recorder.js lost a day of liquidation data to exactly this.
 *
 * Two things this tool exists to prove, because both burned us:
 *   1. A SUBSCRIBE ack means NOTHING. The server accepts
 *      `btcusdt@totallyFakeStreamXYZ` and lists it. Only frames count.
 *   2. `stream.binancefuture.com` is NOT a production mirror despite appearing
 *      in the docs as a base URL — it is testnet. Its trade IDs sit ~7.4e9 away
 *      from production's. Never record from it. --verify-host proves this.
 *
 * Usage:
 *   node scripts/research/route-check.js                 # check the streams the recorder uses
 *   node scripts/research/route-check.js --secs 60       # longer window (quiet streams)
 *   node scripts/research/route-check.js --all           # sweep routed vs un-routed
 *   node scripts/research/route-check.js --verify-host   # prove fstream is production
 */

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = n => process.argv.includes(`--${n}`);

const SECS   = Number(arg('secs', 30));
const SYMBOL = (arg('symbol', process.env.BOOK_SYMBOL || 'btcusdt')).toLowerCase();
const BASE   = 'wss://fstream.binance.com';

// What book-recorder.js depends on. Keep in sync with its PUBLIC/MARKET streams.
const RECORDER = [
  ['public', `${SYMBOL}@depth20@100ms`, true],
  ['public', `${SYMBOL}@bookTicker`,    true],
  ['public', `${SYMBOL}@trade`,         true],
  ['market', '!forceOrder@arr',         true],
];

// Adds the un-routed legacy forms + cross-route negatives, to show the split.
const SWEEP = [
  ...RECORDER,
  ['market', `${SYMBOL}@aggTrade`,     true],
  ['market', `${SYMBOL}@markPrice@1s`, true],
  ['market', `${SYMBOL}@trade`,        false],  // trade is public-route only
  ['public', `${SYMBOL}@aggTrade`,     false],  // aggTrade is market-route only
  ['',       `${SYMBOL}@forceOrder`,   false],  // legacy un-routed: dead
  ['',       `${SYMBOL}@aggTrade`,     false],  // legacy un-routed: dead
];

function probe(route, stream, ms) {
  const url = route ? `${BASE}/${route}/ws/${stream}` : `${BASE}/ws/${stream}`;
  return new Promise(resolve => {
    let n = 0, first = null, err = null;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return resolve({ route, stream, url, n: 0, err: e.message }); }
    ws.addEventListener('error', e => { err = e.message || 'error'; });
    ws.addEventListener('message', ev => {
      n++;
      if (first === null) { try { first = JSON.parse(ev.data); } catch { first = {}; } }
    });
    setTimeout(() => { try { ws.close(); } catch {} resolve({ route, stream, url, n, first, err }); }, ms);
  });
}

async function verifyHost() {
  // Trade IDs are the tell: testnet runs an entirely separate ID space.
  const collect = (url, ms) => new Promise(res => {
    const out = [];
    const ws = new WebSocket(url);
    ws.addEventListener('message', ev => { try { out.push(JSON.parse(ev.data)); } catch {} });
    setTimeout(() => { try { ws.close(); } catch {} res(out); }, ms);
  });
  const [prod, alt, rest] = await Promise.all([
    collect(`${BASE}/public/ws/${SYMBOL}@trade`, 15_000),
    collect(`wss://stream.binancefuture.com/ws/${SYMBOL}@trade`, 15_000),
    fetch(`https://fapi.binance.com/fapi/v1/trades?symbol=${SYMBOL.toUpperCase()}&limit=1`).then(r => r.json()),
  ]);
  const last = a => (a.length ? a[a.length - 1] : null);
  const p = last(prod), a = last(alt), r = rest[0];
  console.log('\nHOST VERIFICATION (trade-id space vs REST truth)');
  console.log(`  REST fapi              id=${r?.id}`);
  console.log(`  fstream /public        id=${p?.t}  Δ=${p && r ? Number(p.t) - Number(r.id) : '?'}`);
  console.log(`  stream.binancefuture   id=${a?.t}  Δ=${a && r ? Number(a.t) - Number(r.id) : '?'}`);
  const drift = a && r ? Math.abs(Number(a.t) - Number(r.id)) : Infinity;
  console.log(drift > 1e6
    ? '  ⚠️  stream.binancefuture.com is TESTNET (separate id space) — never record from it.'
    : '  stream.binancefuture.com tracks production ids.');
}

(async () => {
  const cases = has('all') ? SWEEP : RECORDER;
  console.log(`route-check: ${cases.length} streams × ${SECS}s on ${BASE}\n`);
  const out = await Promise.all(cases.map(([r, s]) => probe(r, s, SECS * 1000)));

  let bad = 0;
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    const expected = cases[i][2];
    const live = o.n > 0;
    const ok = live === expected;
    if (!ok) bad++;
    const label = `/${o.route || '(legacy)'}/ws/${o.stream}`;
    console.log(`${ok ? '✅' : '❌'} ${label.padEnd(36)} msgs=${String(o.n).padEnd(7)} expected=${expected ? 'LIVE' : 'silent'}${o.err ? ` err=${o.err}` : ''}`);
  }

  const liq = out.find(o => o.stream.includes('forceOrder') && o.n > 0);
  if (liq?.first) console.log(`\nliquidation sample: ${JSON.stringify(liq.first).slice(0, 180)}`);
  else if (cases.some(c => c[1].includes('forceOrder') && c[2])) {
    console.log(`\nno liquidation frames in ${SECS}s — quiet market, or the /market route is down.`);
    console.log('re-run with --secs 120 before concluding anything.');
  }

  if (has('verify-host')) await verifyHost();

  console.log(bad === 0
    ? '\nAll streams behaved as expected.'
    : `\n⚠️  ${bad} stream(s) deviated from expectation — the routing contract may have changed again.`);
  process.exit(bad === 0 ? 0 : 1);
})();
