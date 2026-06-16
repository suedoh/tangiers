#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test of the persisted-order lifecycle:
 *
 *   1. Place a limit-far-below-market via placeAndPersist
 *   2. Assert: Mongo has a doc with state='live'
 *   3. Assert: reconcileOnce reports 1 matched, 0 disappeared
 *   4. Cancel via cancelAndPersist
 *   5. Assert: Mongo doc state='cancelled', cancelledAt set
 *   6. Assert: reconcileOnce reports 0/0/0 (nothing to do)
 *
 * Cleans up after itself. Refuses to run when BLOFIN_ENV=prod.
 *
 * Usage:  make blofin-store-probe
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');
const store  = require('../lib/blofin-store');
const db     = require('../lib/db');

const SYMBOL = 'BTC-USDT';
const SIZE   = '0.1';
const sleep  = ms => new Promise(r => setTimeout(r, ms));

async function getMarkPrice() {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(Number(JSON.parse(d).price)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ ASSERTION FAILED:', msg); throw new Error(msg); }
}

async function main() {
  if (!blofin.isDemo()) {
    console.error('Refusing to run: BLOFIN_ENV=prod. Probe is demo-only.');
    process.exit(1);
  }

  console.log('─── BloFin store-probe ───');
  console.log('env:    demo');
  console.log('symbol:', SYMBOL);

  const mark = await getMarkPrice();
  const limitPrice = Math.floor(mark * 0.95 * 10) / 10;
  console.log('mark:  ', mark, '· limit:', limitPrice);
  console.log('');

  // [1/6] Place via persistence wrapper
  console.log('[1/6] placeAndPersist…');
  const { apiRes, doc } = await store.placeAndPersist({
    instId: SYMBOL,
    side: 'buy',
    orderType: 'limit',
    size: SIZE,
    price: limitPrice,
    marginMode: 'isolated',
    positionSide: 'net',
  }, { signalId: 'probe-' + Date.now() });
  const orderId = doc.orderId;
  console.log('  ✓ orderId:', orderId, '· local state:', doc.state);

  // [2/6] Mongo round-trip
  console.log('[2/6] Mongo read-back…');
  const fromDb = await store.getLocalByOrderId(orderId);
  assert(fromDb !== null,                'doc not found in Mongo');
  assert(fromDb.state === 'live',        `expected state=live, got ${fromDb.state}`);
  assert(fromDb.env === 'demo',          `expected env=demo, got ${fromDb.env}`);
  assert(fromDb.signalId?.startsWith('probe-'), 'signalId missing');
  console.log('  ✓ state=live, env=demo, signalId=' + fromDb.signalId);

  await sleep(500);

  // [3/6] Reconcile (should find match)
  console.log('[3/6] reconcileOnce (expect 1 matched)…');
  let r = await store.reconcileOnce({ instId: SYMBOL });
  assert(r.matched >= 1,                 `expected ≥1 matched, got ${r.matched}`);
  assert(r.disappeared.length === 0,     `unexpected disappeared: ${r.disappeared}`);
  console.log('  ✓ matched=' + r.matched + '  disappeared=0  retroactive=' + r.retroactive.length);

  // [4/6] Cancel via wrapper
  console.log('[4/6] cancelAndPersist…');
  await store.cancelAndPersist(orderId, SYMBOL);
  console.log('  ✓ cancel ok');

  await sleep(500);

  // [5/6] State transition reached Mongo
  console.log('[5/6] Mongo state transition…');
  const afterCancel = await store.getLocalByOrderId(orderId);
  assert(afterCancel.state === 'cancelled',  `expected cancelled, got ${afterCancel.state}`);
  assert(afterCancel.cancelledAt instanceof Date, 'cancelledAt not set');
  console.log('  ✓ state=cancelled, cancelledAt set');

  // [6/6] Reconcile is a no-op now
  console.log('[6/6] reconcileOnce after cancel (expect 0/0/0)…');
  r = await store.reconcileOnce({ instId: SYMBOL });
  assert(r.matched === 0,                'no live local orders should remain');
  assert(r.disappeared.length === 0,     'no disappeared');
  assert(r.retroactive.length === 0,     'no retroactive');
  console.log('  ✓ clean');

  console.log('');
  console.log('─── All assertions passed. Phase B.3 exit criterion met. ───');
  await db.disconnect();
}

main().catch(async e => {
  console.error('FAIL:', e.message);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
