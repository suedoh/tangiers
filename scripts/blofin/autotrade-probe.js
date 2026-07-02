#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test for the signal-to-orders pipeline.
 *
 * Since 2026-07-02 (Phase D attribution fixes) this covers four behaviours:
 *   [unit] repriceLadder — burned-rung detection + size redistribution
 *   [A]    near-mark entry → fill fetched, no trim, all rungs survive,
 *          5 orders (entry + verified SL + 3 TPs), 5 Mongo docs
 *   [B]    one-direction book guard — opposite-direction signal skipped
 *          while A's position is open
 *   [C]    burned-rung abort — planned entry 5% below mark (the pre-fix
 *          probe geometry) means the fill lands beyond every rung: the
 *          entry must be flattened and the result tagged aborted
 *
 * Cleans up fully. Refuses to run unless BLOFIN_ENV=demo.
 *
 * Usage:  BLOFIN_AUTOTRADE=true make blofin-autotrade-probe
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

function quantize(p) { return Math.round(p * 10) / 10; }

// Count only order-bearing entries (fill/trim/burned_rungs are annotations).
function orderCount(result) {
  return (result.orders || []).filter(o => o.orderId || o.tpslId).length;
}

async function cleanup(signalId) {
  const docs = await db.blofinOrders().find({ signalId, env: 'demo' }).toArray();
  for (const d of docs) {
    if (d.state === 'live' && d.kind !== 'sl_conditional') {
      try { await store.cancelAndPersist(d.orderId, SYMBOL); } catch (_) { /* swallow */ }
    }
  }
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

function unitTests() {
  console.log('[unit] repriceLadder…');
  const { repriceLadder } = autotrade;

  // All rungs beyond fill → survive with equal thirds + remainder on last.
  let r = repriceLadder({ direction: 'long', fill: 100000, stopDist: 500, total: 40,
    tps: [['tp1', 100500], ['tp2', 101000], ['tp3', 102000]] });
  assert(r.rungs.length === 3 && r.burned.length === 0, 'expected 3 survivors');
  assert(Math.abs(r.rungs.reduce((s, x) => s + x.size, 0) - 40) < 0.01, 'sizes must sum to total');

  // Fill ran through tp1+tp2 → burned; tp3 takes the whole size.
  r = repriceLadder({ direction: 'long', fill: 101100, stopDist: 500, total: 40,
    tps: [['tp1', 100500], ['tp2', 101000], ['tp3', 102000]] });
  assert(r.burned.join(',') === 'tp1,tp2' && r.rungs.length === 1, 'expected tp1,tp2 burned');
  assert(r.rungs[0].size === 40, 'survivor absorbs full size');

  // Short mirror: fill below all rungs → all burned.
  r = repriceLadder({ direction: 'short', fill: 95000, stopDist: 500, total: 40,
    tps: [['tp1', 99500], ['tp2', 99000], ['tp3', 98000]] });
  assert(r.rungs.length === 0 && r.burned.length === 3, 'expected all rungs burned (short)');

  // minGap boundary: rung exactly at fill+minGap survives.
  const gap = Math.max(100000 * 0.0005, 500 * 0.1);
  r = repriceLadder({ direction: 'long', fill: 100000, stopDist: 500, total: 30,
    tps: [['tp1', 100000 + gap]] });
  assert(r.rungs.length === 1, 'rung at exactly minGap must survive');

  console.log('  ✓ 4 unit cases pass');
}

async function main() {
  if (!blofin.isDemo()) { console.error('Refusing: BLOFIN_ENV=prod'); process.exit(1); }
  if (!autotrade.isEnabled()) {
    console.error('Set BLOFIN_AUTOTRADE=true to exercise the autotrade path.');
    process.exit(1);
  }

  console.log('─── BloFin autotrade-probe ───');
  if (!process.env.ACCOUNT_EQUITY_USD) process.env.ACCOUNT_EQUITY_USD = '1500';
  if (!process.env.RISK_PER_TRADE_PCT) process.env.RISK_PER_TRADE_PCT = '1.0';

  unitTests();

  const mark = await getMarkPrice();
  const idA  = 'autotrade-probe-' + Date.now();
  const idB  = 'autotrade-probe-guard-' + Date.now();
  const idC  = 'autotrade-probe-burn-' + Date.now();

  try {
    // ── Scenario A: near-mark entry, full happy path ─────────────────────────
    const entryA = quantize(mark * 0.9995);   // fills ≈ mark, ~0.05% chase
    const stopA  = quantize(entryA * 0.995);
    console.log(`[A] near-mark entry (entry=${entryA} stop=${stopA})…`);
    const resA = await autotrade.autotrade({
      signalId: idA, direction: 'long', setupType: 'A — Full Confluence',
      entry: entryA, stop: stopA,
      tp1: quantize(entryA * 1.005), tp2: quantize(entryA * 1.01), tp3: quantize(entryA * 1.02),
    });
    assert(!resA.skipped && !resA.dropped && !resA.aborted, `A failed: ${JSON.stringify(resA)}`);
    assert(orderCount(resA) === 5, `expected 5 orders, got ${orderCount(resA)}`);
    const fillNote = resA.orders.find(o => o.kind === 'fill');
    assert(fillNote && resA.fill > 0, 'fill price must be captured');
    assert(!resA.orders.some(o => o.kind === 'trim'), 'no trim expected at 0.05% chase');
    assert(!resA.orders.some(o => o.kind === 'burned_rungs'), 'no burned rungs expected');
    console.log(`  ✓ 5 orders · fill=${resA.fill} (planned ${entryA}) · no trim · no burns`);

    await sleep(800);

    console.log('[A] Mongo — 5 docs linked…');
    const linked = await db.blofinOrders().find({ signalId: idA, env: 'demo' }).toArray();
    assert(linked.length === 5, `expected 5 docs, got ${linked.length}`);
    console.log('  ✓ 5 docs (entry + sl + 3 tp)');

    // ── Scenario B: one-direction book guard ────────────────────────────────
    console.log('[B] opposite-direction guard (short while long is open)…');
    const resB = await autotrade.autotrade({
      signalId: idB, direction: 'short', setupType: 'B — Partial Confluence',
      entry: quantize(mark * 1.0005), stop: quantize(mark * 1.005),
      tp1: quantize(mark * 0.995), tp2: quantize(mark * 0.99), tp3: quantize(mark * 0.98),
    });
    assert(resB.skipped && /book guard/.test(resB.skipped), `expected guard skip, got: ${JSON.stringify(resB)}`);
    console.log(`  ✓ skipped: ${resB.skipped}`);

    // ── Idempotency (unchanged behaviour) ───────────────────────────────────
    console.log('[A2] idempotency re-fire…');
    const resA2 = await autotrade.autotrade({
      signalId: idA, direction: 'long', setupType: 'A — Full Confluence',
      entry: entryA, stop: stopA,
      tp1: quantize(entryA * 1.005), tp2: quantize(entryA * 1.01), tp3: quantize(entryA * 1.02),
    });
    assert(resA2.skipped && /already traded/.test(resA2.skipped), `expected idempotent skip: ${JSON.stringify(resA2)}`);
    console.log(`  ✓ skipped: ${resA2.skipped}`);

    // Close scenario A before C so the guard doesn't interfere.
    await cleanup(idA);
    await sleep(500);

    // ── Scenario C: burned-rung abort (pre-fix probe geometry) ──────────────
    const entryC = quantize(mark * 0.95); // fill ≈ mark = 5% beyond every rung
    console.log(`[C] burned-rung abort (entry=${entryC}, fill will be ≈${Math.round(mark)})…`);
    const resC = await autotrade.autotrade({
      signalId: idC, direction: 'long', setupType: 'A — Full Confluence',
      entry: entryC, stop: quantize(entryC * 0.995),
      tp1: quantize(entryC * 1.005), tp2: quantize(entryC * 1.01), tp3: quantize(entryC * 1.02),
    });
    assert(resC.aborted && /TP rungs inside fill/.test(resC.aborted), `expected burn abort, got: ${JSON.stringify(resC)}`);
    await sleep(800);
    const posAfter = await blofin.getPositions(SYMBOL);
    const netAfter = (posAfter || []).reduce((s, p) => s + Number(p.positions || p.pos || 0), 0);
    assert(Math.abs(netAfter) < 0.3, `position must be flat after burn abort, net=${netAfter}`);
    console.log(`  ✓ aborted + flattened: ${resC.aborted}`);

    // ── Reconcile ────────────────────────────────────────────────────────────
    console.log('[recon] reconcileOnce…');
    const r = await store.reconcileOnce({ instId: SYMBOL });
    console.log(`  ✓ matched=${r.matched}  disappeared=${r.disappeared.length}  retroactive=${r.retroactive.length}`);

    console.log('');
    console.log('─── All scenarios passed — cleaning up. ───');
  } finally {
    await cleanup(idA);
    await cleanup(idC);
    console.log('cleanup complete.');
    await db.disconnect();
  }
}

main().catch(async e => {
  console.error('FAIL:', e.message);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
