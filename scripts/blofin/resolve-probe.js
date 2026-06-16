#!/usr/bin/env node
'use strict';

/**
 * Phase B.5 smoke test: place a market entry that fills instantly,
 * run reconcileOnce, assert state transitions through
 * live → disappeared → filled with fillPrice + fillSize populated.
 *
 * Self-cleans the resulting position. Refuses to run unless
 * BLOFIN_ENV=demo.
 *
 * Usage:  make blofin-resolve-probe
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');
const store  = require('../lib/blofin-store');
const db     = require('../lib/db');

const SYMBOL = 'BTC-USDT';
const SIZE   = '0.1';   // minSize — keep cost minimal
const sleep  = ms => new Promise(r => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); throw new Error(msg); }
}

async function flattenAny() {
  try {
    const positions = await blofin.getPositions(SYMBOL);
    for (const p of positions || []) {
      const sz = Math.abs(Number(p.positions || p.pos || 0));
      if (sz > 0) {
        const closeSide = Number(p.positions || p.pos) > 0 ? 'sell' : 'buy';
        await blofin.placeOrder({
          instId: SYMBOL, side: closeSide, orderType: 'market',
          size: String(sz), marginMode: 'isolated', positionSide: 'net', reduceOnly: true,
        });
      }
    }
  } catch (_) { /* swallow */ }
}

async function main() {
  if (!blofin.isDemo()) { console.error('Refusing: BLOFIN_ENV=prod'); process.exit(1); }

  console.log('─── BloFin resolve-probe ───');
  console.log('env: demo');

  let orderId;
  try {
    // [1/5] Place market entry — fills instantly
    console.log('[1/5] placeAndPersist (market buy)…');
    const { doc } = await store.placeAndPersist({
      instId: SYMBOL, side: 'buy', orderType: 'market', size: SIZE,
      marginMode: 'isolated', positionSide: 'net',
    }, { signalId: 'resolve-probe-' + Date.now() });
    orderId = doc.orderId;
    console.log('  ✓ orderId:', orderId, '· local state:', doc.state);

    await sleep(800);

    // [2/5] Pre-recon: state still 'live' in Mongo
    console.log('[2/5] pre-recon Mongo state…');
    let local = await store.getLocalByOrderId(orderId);
    assert(local.state === 'live', `expected live, got ${local.state}`);
    console.log('  ✓ live');

    // [3/5] reconcileOnce — single call should resolve through to 'filled'
    console.log('[3/5] reconcileOnce…');
    const r = await store.reconcileOnce({ instId: SYMBOL });
    console.log(`  ✓ matched=${r.matched}  disappeared=${r.disappeared.length}  resolvedFilled=${r.resolvedFilled}  resolvedCancelled=${r.resolvedCancelled}`);
    assert(r.disappeared.length >= 1, 'expected ≥1 disappeared in this pass');
    assert(r.resolvedFilled >= 1,     'expected ≥1 resolved to filled');

    // [4/5] Final state: filled with fillPrice + fillSize
    console.log('[4/5] post-recon Mongo state…');
    local = await store.getLocalByOrderId(orderId);
    assert(local.state === 'filled',  `expected filled, got ${local.state}`);
    assert(local.fillPrice != null,   'fillPrice should be set');
    assert(local.fillSize != null,    'fillSize should be set');
    assert(local.filledAt instanceof Date, 'filledAt should be a Date');
    console.log(`  ✓ state=filled fillPrice=${local.fillPrice} fillSize=${local.fillSize}`);

    // [5/5] Re-running recon is a no-op
    console.log('[5/5] second reconcileOnce (expect no work)…');
    const r2 = await store.reconcileOnce({ instId: SYMBOL });
    assert(r2.disappeared.length === 0,    'no new disappeared');
    assert(r2.resolvedFilled === 0,        'no new resolution');
    console.log('  ✓ clean');

    console.log('');
    console.log('─── Assertions passed — flattening position. ───');
  } finally {
    await flattenAny();
    await db.disconnect();
  }
}

main().catch(async e => {
  console.error('FAIL:', e.message);
  await flattenAny().catch(() => {});
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
