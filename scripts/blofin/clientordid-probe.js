#!/usr/bin/env node
'use strict';

/**
 * Read-only-ish probe for the idempotent-retry design
 * (refactors/2026-06-24-autotrade-retry-design.md). Places ONE tiny limit
 * far below market with a deterministic clientOrdId, then verifies and cancels.
 * Never fills, never leaves state. Demo-only.
 *
 *   P1 — does BloFin accept a signalId-derived clientOrdId? echo it back?
 *   P2 — is the clientOrdId visible/queryable on getActiveOrders?
 *   P3 — does fills-history carry clientOrdId (resolve a filled-on-timeout entry)?
 *   P4 — signed-request latency distribution (is 10s right? is 22% real?)
 *
 * Usage:  node scripts/blofin/clientordid-probe.js
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');

const SYMBOL = 'BTC-USDT';
const SIZE   = '0.1';
const sleep  = ms => new Promise(r => setTimeout(r, ms));

// Mirror the production transform: signalId → exchange-legal clientOrdId.
// signalId format: `${Date.now()}-${type}-${mid}` e.g. "1782137423928-VAH-65080".
function clientOrdIdFromSignal(signalId) {
  return signalId.replace(/[^a-zA-Z0-9]/g, '');
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
  if (!blofin.isDemo()) { console.error('Refusing: BLOFIN_ENV=prod. Demo-only.'); process.exit(1); }

  const fakeSignalId = `${Date.now()}-VAH-65080`;
  const clientOrdId  = clientOrdIdFromSignal(fakeSignalId);

  console.log('─── BloFin clientOrdId probe ───');
  console.log('fake signalId:', fakeSignalId);
  console.log('clientOrdId:  ', clientOrdId, `(${clientOrdId.length} chars, alphanumeric)`);
  console.log('');

  const mark       = await getMarkPrice();
  const limitPrice = Math.floor(mark * 0.95 * 10) / 10;

  // ── P1: place with clientOrdId, inspect echo ──────────────────────────────
  console.log('[P1] Place limit buy with clientOrderId…');
  let orderId, p1echo;
  try {
    const res = await blofin.placeOrder({
      instId: SYMBOL, side: 'buy', orderType: 'limit', size: SIZE, price: limitPrice,
      marginMode: 'isolated', positionSide: 'net', clientOrderId: clientOrdId,
    });
    orderId = res?.orderId || res?.[0]?.orderId;
    p1echo  = res?.clientOrderId || res?.[0]?.clientOrderId;
    console.log('  raw response:', JSON.stringify(res));
    console.log('  ✓ accepted — orderId:', orderId, '| echoed clientOrderId:', p1echo || '(empty)');
  } catch (e) {
    console.error('  ✗ REJECTED:', e.message);
    console.error('  → clientOrdId charset/length not accepted as-is; transform needs revision.');
    process.exit(1);
  }

  await sleep(600);

  // ── P2: is clientOrdId visible on getActiveOrders? ────────────────────────
  console.log('[P2] Read active orders, look up by clientOrdId…');
  try {
    const orders = await blofin.getActiveOrders({ instId: SYMBOL });
    const byOid = (orders || []).find(o => o.orderId === orderId);
    const byCid = (orders || []).find(o => o.clientOrderId === clientOrdId);
    console.log('  clientOrderId on record :', byOid?.clientOrderId || '(empty)');
    console.log('  lookup BY clientOrderId :', byCid ? '✓ FOUND (resolves a resting order)' : '✗ not found');
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
  }

  // ── P3: can orders-history resolve BY clientOrderId? (the filled-entry path) ─
  console.log('[P3] orders-history lookup by clientOrderId (resolves filled-on-timeout entry)…');
  try {
    const hist = await blofin.getOrderHistory({ instId: SYMBOL, clientOrderId: clientOrdId, limit: 5 });
    const match = (hist || []).find(o => o.clientOrderId === clientOrdId);
    console.log('  orders-history returned:', (hist || []).length, 'record(s)');
    if ((hist || []).length) console.log('  record fields:', Object.keys(hist[0]).join(', '));
    console.log('  resolve BY clientOrderId:', match ? '✓ FOUND' : '✗ not found (order still resting — expected for unfilled limit)');
  } catch (e) {
    console.error('  ✗ FAIL (endpoint may differ):', e.message);
  }

  // ── Cancel (clean up) ─────────────────────────────────────────────────────
  console.log('[cleanup] Cancel probe order…');
  try { await blofin.cancelOrder(orderId, SYMBOL); console.log('  ✓ cancelled'); }
  catch (e) { console.error('  ✗ cancel FAIL — MANUAL CLEANUP NEEDED for', orderId, ':', e.message); }

  await sleep(400);
  try {
    const orders = await blofin.getActiveOrders({ instId: SYMBOL });
    console.log('  leftover probe orders:', (orders || []).filter(o => o.orderId === orderId).length);
  } catch {}

  // ── P4: signed-request latency distribution ───────────────────────────────
  console.log('[P4] Latency over 20 signed calls (getBalance)…');
  const lat = [];
  for (let i = 0; i < 20; i++) {
    const t0 = Date.now();
    try { await blofin.getBalance('futures'); lat.push(Date.now() - t0); }
    catch (e) { lat.push(-1); }
    await sleep(150);
  }
  const ok = lat.filter(x => x >= 0).sort((a, b) => a - b);
  const pct = p => ok.length ? ok[Math.min(ok.length - 1, Math.floor(p * ok.length))] : NaN;
  console.log('  n=' + ok.length, 'errors=' + lat.filter(x => x < 0).length);
  console.log(`  min=${ok[0]}ms  median=${pct(0.5)}ms  p90=${pct(0.9)}ms  max=${ok[ok.length-1]}ms`);
  console.log('  → current timeout is 10000ms; compare against p90/max above.');

  console.log('');
  console.log('─── Probe complete. ───');
}

main().catch(e => { console.error('unexpected:', e); process.exit(1); });
