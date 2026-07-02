#!/usr/bin/env node
'use strict';

/**
 * Degraded-mode (Mongo-down) autotrade smoke test.
 *
 * Validates the 2026-07-02 resilience fix: with MongoDB unreachable, a
 * fully-qualified signal must still place entry + verified SL + 3 TPs on
 * the exchange, spool all 5 docs to .blofin-spool.ndjson, and report
 * unsynced=true — instead of hard-dropping (the Jun 27–29 failure mode,
 * 11 drops / +18R missed).
 *
 * REFUSES to run if Mongo is reachable — in that case the normal path is
 * in play and you want `make blofin-autotrade-probe` instead. To exercise
 * this probe deliberately: `docker compose stop mongodb`, run it, then
 * `docker compose start mongodb` and run recon to flush the spool.
 *
 * Cleanup is Mongo-free by necessity: cancels TP limits via the exchange
 * order list, cancels pending TPSLs, flattens any position. The spool file
 * is intentionally LEFT IN PLACE — the follow-up assertion of the fix is
 * that the next recon run flushes it and resolves the docs.
 *
 * Usage:  BLOFIN_AUTOTRADE=true node scripts/blofin/degraded-probe.js
 *    or:  BLOFIN_AUTOTRADE=true make blofin-degraded-probe
 */

const fs = require('fs');
const { loadEnv } = require('../lib/env');
loadEnv();

const blofin    = require('../lib/blofin');
const store     = require('../lib/blofin-store');
const autotrade = require('../lib/blofin-autotrade');

const SYMBOL = 'BTC-USDT';
const sleep  = ms => new Promise(r => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('  ✗', msg); throw new Error(msg); }
}

function quantize(p) { return Math.round(p * 10) / 10; }

async function getMarkPrice() {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(Number(JSON.parse(d).price)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function cleanup() {
  // Mongo-free: exchange truth only.
  try {
    const open = await blofin.getActiveOrders({ instId: SYMBOL });
    for (const o of open || []) {
      try { await blofin.cancelOrder(o.orderId, SYMBOL); } catch (_) { /* swallow */ }
    }
  } catch (_) { /* swallow */ }
  try {
    const pendingSL = await blofin.getPendingTPSL({ instId: SYMBOL });
    const items = (pendingSL || []).map(o => ({ instId: SYMBOL, tpslId: o.tpslId }));
    if (items.length) await blofin.cancelTPSL(items);
  } catch (_) { /* swallow */ }
  try {
    const positions = await blofin.getPositions(SYMBOL);
    for (const p of positions || []) {
      const sz = Math.abs(Number(p.positions || p.pos || 0));
      if (sz > 0) {
        const closeSide = Number(p.positions || p.pos) > 0 ? 'sell' : 'buy';
        await blofin.placeOrder({
          instId: SYMBOL, side: closeSide, orderType: 'market', size: String(sz),
          marginMode: 'isolated', positionSide: 'net', reduceOnly: true,
        });
      }
    }
  } catch (e) {
    console.log('  (cleanup: position read/flatten skipped —', e.message, ')');
  }
}

async function main() {
  if (!blofin.isDemo()) { console.error('Refusing: BLOFIN_ENV=prod'); process.exit(1); }
  if (!autotrade.isEnabled()) {
    console.error('Set BLOFIN_AUTOTRADE=true to exercise the autotrade path.');
    process.exit(1);
  }

  console.log('─── BloFin degraded-mode probe (Mongo down) ───');

  if (!process.env.ACCOUNT_EQUITY_USD) process.env.ACCOUNT_EQUITY_USD = '1500';
  if (!process.env.RISK_PER_TRADE_PCT) process.env.RISK_PER_TRADE_PCT = '1.0';

  // [0/5] Preconditions — Mongo must actually be down.
  console.log('[0/5] Mongo reachability (expect DOWN)…');
  const mongoUp = await store.mongoAvailable();
  if (mongoUp) {
    console.error('  ✗ Mongo is reachable — this probe validates the outage path.');
    console.error('    Use `make blofin-autotrade-probe` for the normal path, or');
    console.error('    `docker compose stop mongodb` to exercise this one.');
    process.exit(1);
  }
  console.log('  ✓ Mongo unreachable — degraded path armed');

  const spoolBefore = fs.existsSync(store.SPOOL_FILE)
    ? fs.readFileSync(store.SPOOL_FILE, 'utf8').split('\n').filter(Boolean).length
    : 0;

  const mark    = await getMarkPrice();
  // Near-mark geometry: since the 2026-07-02 ladder-repricing fix, a planned
  // entry far below mark correctly ABORTS (all rungs inside fill) — that path
  // is covered by autotrade-probe scenario C. Here we want the full 5-order
  // placement to exercise the spool.
  const entry   = quantize(mark * 0.9995);
  const stop    = quantize(entry * 0.995);
  const tp1     = quantize(entry * 1.005);
  const tp2     = quantize(entry * 1.01);
  const tp3     = quantize(entry * 1.02);
  const signalId = 'degraded-probe-' + Date.now();
  console.log(`signalId: ${signalId}  entry=${entry}  stop=${stop}`);

  try {
    // [1/5] Fire the autotrade with Mongo down
    console.log('[1/5] autotrade() with Mongo down…');
    const result = await autotrade.autotrade({
      signalId, direction: 'long', setupType: 'A — Full Confluence',
      entry, stop, tp1, tp2, tp3,
    });
    assert(!result.skipped, `autotrade skipped: ${result.skipped}`);
    assert(!result.dropped, `autotrade DROPPED — the fix did not hold: ${result.dropped}`);
    assert(!result.aborted, `autotrade aborted: ${result.aborted}`);
    const placedOrders = result.orders.filter(o => o.orderId || o.tpslId);
    assert(placedOrders.length === 5, `expected 5 orders, got ${placedOrders.length}`);
    assert(result.unsynced === true, 'expected unsynced=true in degraded mode');
    placedOrders.forEach(o => console.log(`  ✓ ${o.kind}: ${o.orderId || o.tpslId || ('ERROR — ' + o.error)}`));

    // [2/5] Spool has all 5 docs for this signal
    console.log('[2/5] spool contains 5 docs for signalId…');
    const lines = fs.readFileSync(store.SPOOL_FILE, 'utf8').split('\n').filter(Boolean);
    const mine  = lines.map(l => JSON.parse(l)).filter(d => d.signalId === signalId);
    assert(mine.length === 5, `expected 5 spooled docs, got ${mine.length} (spool grew ${lines.length - spoolBefore})`);
    const kinds = mine.map(d => d.kind || d.orderType).sort();
    console.log(`  ✓ 5 docs spooled (${kinds.join(', ')})`);

    // [3/5] SL is live on the exchange (verify-or-flatten held without Mongo)
    console.log('[3/5] SL verified on exchange…');
    const pendingSL = await blofin.getPendingTPSL({ instId: SYMBOL });
    const sl = (pendingSL || []).find(o => Math.abs(Number(o.slTriggerPrice) - stop) < 0.5);
    assert(sl, 'standalone SL not found in pending TPSL');
    console.log(`  ✓ SL live: tpslId=${sl.tpslId} trigger=${sl.slTriggerPrice}`);

    await sleep(1200);

    // [4/5] Degraded idempotency — re-fire resolves via exchange, not Mongo
    console.log('[4/5] degraded idempotency (exchange-side lookup)…');
    const second = await autotrade.autotrade({
      signalId, direction: 'long', setupType: 'A — Full Confluence',
      entry, stop, tp1, tp2, tp3,
    });
    assert(second.skipped && /degraded idempotency/.test(second.skipped),
      `expected degraded-idempotency skip, got: ${JSON.stringify(second)}`);
    console.log(`  ✓ skipped: ${second.skipped}`);

    // [5/5] Cleanup is Mongo-free
    console.log('[5/5] cleanup (exchange-only)…');
  } finally {
    await cleanup();
    console.log('  ✓ cleanup complete (spool intentionally left for recon to flush)');
  }

  console.log('');
  console.log('─── Degraded-mode probe passed. ───');
  console.log('Next: restore Mongo, run `make blofin-recon-once`, confirm the spool flushes.');
}

main().catch(e => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
