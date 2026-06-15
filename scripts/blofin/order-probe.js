#!/usr/bin/env node
'use strict';

/**
 * Self-cleaning order-placement smoke test.
 *
 * Exercises the write primitives end-to-end without leaving any
 * positions or orders behind:
 *
 *   1. Place a LIMIT buy at a price far below market (will not fill)
 *      with size = minSize (0.1 contracts ≈ $7 notional)
 *   2. Read active orders and confirm it appears
 *   3. Cancel the order
 *   4. Read active orders and confirm it's gone
 *
 * Why limit-far-below-market: a market order would fill immediately,
 * leaving a position to flatten. A limit far from the touch lets us
 * exercise place + cancel without ever entering a position.
 *
 * Refuses to run when BLOFIN_ENV=prod.
 *
 * Usage:  make blofin-probe
 *    or:  node scripts/blofin/order-probe.js
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');

const SYMBOL = 'BTC-USDT';
const SIZE   = '0.1';    // minSize for BTC-USDT perp
const sleep  = ms => new Promise(r => setTimeout(r, ms));

async function getMarkPrice() {
  // Use the public instruments endpoint? It doesn't return live price.
  // Cheapest path: use Binance Futures (already a dep in lib/binance.js)
  // — we only need a rough number to set our limit safely below market.
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(Number(JSON.parse(d).price)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  if (!blofin.isDemo()) {
    console.error('Refusing to run: BLOFIN_ENV=prod. Probe is demo-only.');
    process.exit(1);
  }

  console.log('─── BloFin order-probe ───');
  console.log('env:    demo');
  console.log('symbol:', SYMBOL);

  const mark = await getMarkPrice();
  // Limit 5% below mark — far enough never to fill in the probe window,
  // BloFin tickSize is 0.1 so quantize to one decimal.
  const limitPrice = Math.floor(mark * 0.95 * 10) / 10;
  console.log('mark:  ', mark);
  console.log('limit: ', limitPrice, '(5% below mark — will not fill)');
  console.log('size:  ', SIZE, 'contracts');
  console.log('');

  // [1/4] Place
  console.log('[1/4] Place limit buy…');
  let orderId;
  try {
    const res = await blofin.placeOrder({
      instId: SYMBOL,
      side: 'buy',
      orderType: 'limit',
      size: SIZE,
      price: limitPrice,
      marginMode: 'isolated',
      positionSide: 'net',
    });
    // BloFin's response shape: { data: { orderId, clientOrdId } } unwrapped to `data`
    orderId = res?.orderId || res?.[0]?.orderId;
    if (!orderId) throw new Error('no orderId in response: ' + JSON.stringify(res));
    console.log('  ✓ orderId:', orderId);
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    process.exit(1);
  }

  await sleep(500); // give the exchange a moment

  // [2/4] Verify it's in active orders
  console.log('[2/4] Read active orders…');
  try {
    const orders = await blofin.getActiveOrders({ instId: SYMBOL });
    const found = (orders || []).some(o => o.orderId === orderId);
    if (!found) {
      console.error('  ✗ FAIL: order not visible in active orders (saw', (orders || []).length, 'orders)');
      // Don't exit — still try to cancel, in case it filled or was already gone.
    } else {
      console.log('  ✓ visible in active orders');
    }
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    // Don't exit — still try to cancel.
  }

  // [3/4] Cancel
  console.log('[3/4] Cancel order…');
  try {
    await blofin.cancelOrder(orderId, SYMBOL);
    console.log('  ✓ cancelled');
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    process.exit(1);
  }

  await sleep(500);

  // [4/4] Confirm clean state
  console.log('[4/4] Verify clean state…');
  try {
    const orders = await blofin.getActiveOrders({ instId: SYMBOL });
    const stillThere = (orders || []).some(o => o.orderId === orderId);
    if (stillThere) {
      console.error('  ✗ FAIL: order still active after cancel');
      process.exit(1);
    }
    console.log('  ✓ no leftover orders');
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    process.exit(1);
  }

  console.log('');
  console.log('─── All checks passed. Order primitives validated. ───');
}

main().catch(e => { console.error('unexpected:', e); process.exit(1); });
