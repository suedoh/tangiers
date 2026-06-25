#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test for the signal-to-orders pipeline.
 *
 * Constructs a synthetic A-tier long signal at a price 5% BELOW the
 * current BTC mark, with a stop 0.5% under that and TPs above. Why
 * below mark: a market BUY at a price below mark fills immediately —
 * which is exactly the path we want to validate end-to-end without
 * waiting for a real signal to fire.
 *
 * Cleans up at the end: cancels the three TP limits and closes the
 * position with a reduce-only market order. Refuses to run unless
 * BLOFIN_ENV=demo.
 *
 * Set BLOFIN_AUTOTRADE=true in your shell to actually exercise it —
 * this is gated so accidentally running the probe in a normal shell
 * is a no-op.
 *
 * Usage:  BLOFIN_AUTOTRADE=true make blofin-autotrade-probe
 *    or:  BLOFIN_AUTOTRADE=true node scripts/blofin/autotrade-probe.js
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin    = require('../lib/blofin');
const store     = require('../lib/blofin-store');
const autotrade = require('../lib/blofin-autotrade');
const db        = require('../lib/db');

const SYMBOL = 'BTC-USDT';
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
  if (!cond) { console.error('  ✗', msg); throw new Error(msg); }
}

async function cleanup(signalId) {
  // Cancel any open orders for this signal.
  const docs = await db.blofinOrders().find({ signalId, env: 'demo' }).toArray();
  for (const d of docs) {
    if (d.state === 'live') {
      try { await store.cancelAndPersist(d.orderId, SYMBOL); } catch (_) { /* swallow */ }
    }
  }
  // Cancel any standalone SL conditional (Phase B.6 — separate tpslId namespace).
  try {
    const pendingSL = await blofin.getPendingTPSL({ instId: SYMBOL });
    const items = (pendingSL || []).map(o => ({ instId: SYMBOL, tpslId: o.tpslId }));
    if (items.length) await blofin.cancelTPSL(items);
  } catch (_) { /* swallow */ }
  // Flatten any position from the entry that may have filled.
  try {
    const positions = await blofin.getPositions(SYMBOL);
    for (const p of positions || []) {
      const sz = Math.abs(Number(p.positions || p.pos || 0));
      if (sz > 0) {
        const closeSide = Number(p.positions || p.pos) > 0 ? 'sell' : 'buy';
        await blofin.placeOrder({
          instId: SYMBOL,
          side: closeSide,
          orderType: 'market',
          size: String(sz),
          marginMode: 'isolated',
          positionSide: 'net',
          reduceOnly: true,
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

  console.log('─── BloFin autotrade-probe ───');
  console.log('env: demo · autotrade: enabled');

  // Default Tangiers env if unset
  if (!process.env.ACCOUNT_EQUITY_USD) process.env.ACCOUNT_EQUITY_USD = '1500';
  if (!process.env.RISK_PER_TRADE_PCT) process.env.RISK_PER_TRADE_PCT = '1.0';
  console.log(`equity=$${process.env.ACCOUNT_EQUITY_USD}  risk%=${process.env.RISK_PER_TRADE_PCT}`);

  const mark    = await getMarkPrice();
  const entry   = quantize(mark * 0.95);            // 5% below mark — market BUY fills instantly
  const stop    = quantize(entry * 0.995);           // 0.5% under entry
  const tp1     = quantize(entry * 1.005);           // +0.5%
  const tp2     = quantize(entry * 1.01);            // +1.0%
  const tp3     = quantize(entry * 1.02);            // +2.0%
  const signalId = 'autotrade-probe-' + Date.now();

  console.log(`signalId: ${signalId}`);
  console.log(`entry=${entry}  stop=${stop}  tp1=${tp1}  tp2=${tp2}  tp3=${tp3}`);
  console.log('');

  let result;
  try {
    // [1/5] Sizing dry-run (no orders placed)
    console.log('[1/5] sizing math…');
    const sizing = autotrade.sizingFor({ entry, stop, setupType: 'A — Full Confluence' });
    assert(!sizing.error, `sizing error: ${sizing.error}`);
    console.log(`  ✓ ${sizing.contracts} contracts total, ${sizing.sizePerTp} per TP, R=$${sizing.rDollar.toFixed(2)}`);

    // [2/5] Fire the autotrade
    console.log('[2/5] autotrade()…');
    result = await autotrade.autotrade({
      signalId, direction: 'long', setupType: 'A — Full Confluence',
      entry, stop, tp1, tp2, tp3,
    });
    assert(!result.skipped, `autotrade skipped: ${result.skipped}`);
    assert(!result.dropped, `autotrade dropped: ${result.dropped}`);
    // Post-B.6: entry + standalone SL + tp1/tp2/tp3 = 5 orders.
    assert(result.orders.length === 5, `expected 5 orders, got ${result.orders.length}`);
    result.orders.forEach(o => console.log(`  ✓ ${o.kind}: ${o.orderId || o.tpslId || ('ERROR — ' + o.error)}`));

    await sleep(800);

    // [3/5] Mongo has all 5 orders linked to signalId (entry + sl + 3 TPs)
    console.log('[3/5] Mongo — 5 orders linked to signalId…');
    const linked = await db.blofinOrders().find({ signalId, env: 'demo' }).toArray();
    assert(linked.length === 5, `expected 5 docs, got ${linked.length}`);
    console.log(`  ✓ ${linked.length} docs (entry + sl + tp1 + tp2 + tp3)`);

    // [4/5] Idempotency — re-firing same signal is a no-op
    console.log('[4/5] idempotency check…');
    const second = await autotrade.autotrade({
      signalId, direction: 'long', setupType: 'A — Full Confluence',
      entry, stop, tp1, tp2, tp3,
    });
    assert(second.skipped && /already traded/.test(second.skipped),
      `expected idempotent skip, got: ${JSON.stringify(second)}`);
    console.log(`  ✓ skipped: ${second.skipped}`);

    // [5/5] reconcileOnce
    console.log('[5/5] reconcileOnce…');
    const r = await store.reconcileOnce({ instId: SYMBOL });
    console.log(`  ✓ matched=${r.matched}  disappeared=${r.disappeared.length}  retroactive=${r.retroactive.length}`);

    console.log('');
    console.log('─── Assertions passed — cleaning up. ───');
  } finally {
    await cleanup(signalId);
    console.log('cleanup complete.');
    await db.disconnect();
  }
}

function quantize(p) { return Math.round(p * 10) / 10; }

main().catch(async e => {
  console.error('FAIL:', e.message);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
