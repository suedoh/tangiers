#!/usr/bin/env node
'use strict';

/**
 * Phase B.6 smoke test: standalone TPSL conditional orders.
 *
 *   1. Capture current pending TPSL state
 *   2. Place a NEW standalone SL at a price far from market (won't fire)
 *   3. Assert: it appears in getPendingTPSL with correct fields
 *   4. Assert: persistTPSL stored a kind='sl_conditional' doc in Mongo
 *   5. Assert: findUnprotectedPositions returns [] for instruments where
 *      our SL covers them
 *   6. Cancel via cancelTPSL
 *   7. Assert: it's gone from the pending list
 *
 * Refuses to run when BLOFIN_ENV=prod. Does NOT touch existing positions
 * or pre-existing TPSL orders.
 *
 * Usage:  make blofin-sl-probe
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');
const store  = require('../lib/blofin-store');
const db     = require('../lib/db');

const SYMBOL = 'BTC-USDT';
const sleep  = ms => new Promise(r => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); throw new Error(msg); }
}

async function getMarkPrice() {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(Number(JSON.parse(d).price)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  if (!blofin.isDemo()) { console.error('Refusing: BLOFIN_ENV=prod'); process.exit(1); }

  console.log('─── BloFin SL-probe (Phase B.6) ───');
  console.log('env: demo · symbol:', SYMBOL);

  // [0] State capture — record pre-existing TPSL so we don't clean theirs up
  const before = await blofin.getPendingTPSL({ instId: SYMBOL });
  const beforeIds = new Set((before || []).map(o => o.tpslId));
  console.log('Pre-existing TPSL orders:', beforeIds.size);

  const mark = await getMarkPrice();
  // Trigger 10% above mark — well above any plausible move during the probe.
  const triggerPx = Math.round(mark * 1.10 * 10) / 10;
  console.log('mark:', mark, '· probe trigger:', triggerPx);
  console.log('');

  let tpslId;
  try {
    // [1/6] Place standalone SL via the new API method
    console.log('[1/6] placeTPSL (standalone)…');
    const res = await blofin.placeTPSL({
      instId: SYMBOL, side: 'buy', size: '0.1',
      slTriggerPrice: triggerPx, slOrderPrice: '-1', slTriggerPriceType: 'mark',
    });
    tpslId = res?.tpslId || res?.[0]?.tpslId;
    assert(tpslId, 'no tpslId returned: ' + JSON.stringify(res));
    console.log('  ✓ tpslId:', tpslId);

    await sleep(500);

    // [2/6] Verify via getPendingTPSL
    console.log('[2/6] getPendingTPSL verification…');
    const pending = await blofin.getPendingTPSL({ instId: SYMBOL });
    const ours = (pending || []).find(o => o.tpslId === tpslId);
    assert(ours,                                       'TPSL not in pending list');
    assert(Math.abs(Number(ours.slTriggerPrice) - triggerPx) < 0.5,
                                                        'trigger price mismatch');
    assert(ours.slTriggerPriceType === 'mark',          'trigger type mismatch');
    assert(ours.reduceOnly === 'true' || ours.reduceOnly === true,
                                                        'reduceOnly should be true');
    console.log('  ✓ slTriggerPrice=' + ours.slTriggerPrice + ' · type=' + ours.slTriggerPriceType);

    // [3/6] Persist to Mongo via store
    console.log('[3/6] persistTPSL → Mongo…');
    await store.persistTPSL({
      tpslId, signalId: 'sl-probe-' + Date.now(), instId: SYMBOL,
      side: 'buy', size: '0.1',
      slTriggerPrice: triggerPx, slTriggerPriceType: 'mark',
    });
    const local = await db.blofinOrders().findOne({ tpslId });
    assert(local,                                       'Mongo doc not found');
    assert(local.kind === 'sl_conditional',             'wrong kind: ' + local.kind);
    assert(local.state === 'live',                      'wrong state: ' + local.state);
    console.log('  ✓ kind=sl_conditional state=live tpslId=' + local.tpslId);

    // [4/6] findUnprotectedPositions — current SHORT 59.9 already has a manual
    //       SL we placed earlier (tpslId 10002057094) covering it. Our new
    //       SL is also covering it. So result should be EMPTY for BTC-USDT.
    console.log('[4/6] findUnprotectedPositions (expect empty)…');
    const unprotected = await store.findUnprotectedPositions();
    const btcUnprotected = unprotected.filter(u => u.instId === SYMBOL);
    assert(btcUnprotected.length === 0,
                                                        'BTC-USDT reported unprotected despite SL: ' + JSON.stringify(unprotected));
    console.log('  ✓ no unprotected positions (existing SLs cover ' + (unprotected.length === 0 ? 'all' : 'BTC') + ')');

    // [5/6] Cancel via cancelTPSL (array body)
    console.log('[5/6] cancelTPSL…');
    const cancelRes = await blofin.cancelTPSL([{ instId: SYMBOL, tpslId }]);
    console.log('  ✓ cancel response:', JSON.stringify(cancelRes).slice(0, 100));

    await sleep(500);

    // [6/6] Verify cancelled (gone from pending)
    console.log('[6/6] verify removed from pending…');
    const after = await blofin.getPendingTPSL({ instId: SYMBOL });
    const stillThere = (after || []).some(o => o.tpslId === tpslId);
    assert(!stillThere, 'TPSL still pending after cancel');
    console.log('  ✓ cancelled and removed');

    console.log('');
    console.log('─── All 6 assertions passed. Phase B.6 plumbing validated. ───');
  } finally {
    await db.disconnect();
  }
}

main().catch(async e => {
  console.error('FAIL:', e.message);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
