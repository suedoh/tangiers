'use strict';

/**
 * Persistence + reconciliation for BloFin orders.
 *
 * Wraps the API client so every state transition (place / cancel / fill)
 * is written to MongoDB. The `recon` loop diffs exchange truth against
 * local state and heals drift.
 *
 * State machine (intentionally narrow for Phase B.3):
 *   live         — placed and known to exchange, on the book
 *   cancelled    — cancelled (by us or by exchange)
 *   filled       — fully filled
 *   disappeared  — exchange forgot it; needs B.5 fill-history lookup to
 *                  resolve filled-vs-cancelled-externally
 *
 * Every doc carries `env: 'demo'|'prod'` so a misconfigured machine
 * cannot mix order books. The unique index is (orderId, env).
 *
 * Schema is stable; if it changes later, bump SCHEMA_VERSION and migrate.
 */

const blofin = require('./blofin');
const db     = require('./db');

const SCHEMA_VERSION = 1;

let _indexesEnsured = false;
async function ensureIndexes() {
  if (_indexesEnsured) return;
  await db.connect();
  const col = db.blofinOrders();
  await col.createIndex({ orderId: 1, env: 1 }, { unique: true, name: 'orderId_env_uniq' });
  await col.createIndex({ state: 1 },                                      { name: 'state' });
  await col.createIndex({ signalId: 1 },                                   { name: 'signalId' });
  await col.createIndex({ instId: 1, state: 1 },                           { name: 'instId_state' });
  _indexesEnsured = true;
}

function env() { return blofin.isDemo() ? 'demo' : 'prod'; }
function now() { return new Date(); }

// ─── Write wrappers ──────────────────────────────────────────────────────────

/**
 * Place an order and persist it. Returns the BloFin response + the
 * Mongo document. Throws if either side fails — caller decides how to
 * recover (re-try, alert, etc.).
 *
 * On signature mismatch between place-then-persist (rare but possible
 * if the network drops between API ack and Mongo write), the order
 * exists on the exchange but not locally — reconciliation will detect
 * this as "exchange has order we don't know about" and create the
 * local record retroactively. See reconcileOnce().
 */
async function placeAndPersist(orderArgs, { signalId } = {}) {
  await ensureIndexes();
  const apiRes = await blofin.placeOrder(orderArgs);
  const orderId = apiRes?.orderId || apiRes?.[0]?.orderId;
  if (!orderId) throw new Error('placeOrder returned no orderId: ' + JSON.stringify(apiRes));

  const doc = {
    orderId,
    clientOrdId:    apiRes?.clientOrdId || apiRes?.[0]?.clientOrdId || null,
    signalId:       signalId || null,
    instId:         orderArgs.instId,
    side:           orderArgs.side,
    orderType:      orderArgs.orderType,
    size:           String(orderArgs.size),
    price:          orderArgs.price !== undefined ? String(orderArgs.price) : null,
    state:          'live',
    marginMode:     orderArgs.marginMode || 'isolated',
    positionSide:   orderArgs.positionSide || 'net',
    stopLossTriggerPrice:   orderArgs.stopLossTriggerPrice ?? null,
    takeProfitTriggerPrice: orderArgs.takeProfitTriggerPrice ?? null,
    env:            env(),
    schemaVersion:  SCHEMA_VERSION,
    createdAt:      now(),
    updatedAt:      now(),
    lastSyncedAt:   now(),
    cancelledAt:    null,
    filledAt:       null,
  };
  await db.blofinOrders().insertOne(doc);
  return { apiRes, doc };
}

/**
 * Persist an entry order discovered on the exchange after an ambiguous-write
 * timeout (the autotrade resilient-retry adopt path). The order is already
 * live/filled on BloFin; we attach our signalId and persist so the SL step
 * and reconciliation treat it as a tracked entry. Upsert by (orderId, env)
 * so it co-exists harmlessly if recon already retro-created the same order.
 */
async function persistAdoptedEntry(exOrder, signalId) {
  await ensureIndexes();
  const doc = {
    orderId:        exOrder.orderId,
    clientOrdId:    exOrder.clientOrderId || null,
    signalId:       signalId || null,
    instId:         exOrder.instId,
    side:           exOrder.side,
    orderType:      exOrder.orderType || 'market',
    size:           String(exOrder.size),
    price:          exOrder.price ?? null,
    state:          'live',
    marginMode:     exOrder.marginMode || 'isolated',
    positionSide:   exOrder.positionSide || 'net',
    stopLossTriggerPrice:   null,
    takeProfitTriggerPrice: null,
    env:            env(),
    schemaVersion:  SCHEMA_VERSION,
    createdAt:      now(),
    updatedAt:      now(),
    lastSyncedAt:   now(),
    cancelledAt:    null,
    filledAt:       null,
    adopted:        true,
  };
  await db.blofinOrders().updateOne(
    { orderId: doc.orderId, env: env() },
    { $setOnInsert: doc },
    { upsert: true },
  );
  return doc;
}

/**
 * Cancel an order and update local state. Idempotent: re-cancelling a
 * cancelled order is a local no-op (the API call still fires; BloFin
 * returns the standard "order doesn't exist" error which we surface).
 */
async function cancelAndPersist(orderId, instId) {
  await ensureIndexes();
  const apiRes = await blofin.cancelOrder(orderId, instId);
  await db.blofinOrders().updateOne(
    { orderId, env: env() },
    { $set: { state: 'cancelled', updatedAt: now(), cancelledAt: now() } },
  );
  return apiRes;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

async function listLocalOpen(instId) {
  await ensureIndexes();
  const filter = { env: env(), state: 'live' };
  if (instId) filter.instId = instId;
  return db.blofinOrders().find(filter).toArray();
}

async function getLocalByOrderId(orderId) {
  await ensureIndexes();
  return db.blofinOrders().findOne({ orderId, env: env() });
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Single-pass reconciliation between local state and BloFin's active
 * orders. Returns a summary report; mutates Mongo as needed.
 *
 *   1. For every local 'live' order:
 *        - if still on exchange → bump lastSyncedAt
 *        - if NOT on exchange   → mark 'disappeared' (B.5 will resolve
 *                                  filled-vs-externally-cancelled via
 *                                  fills-history lookup)
 *   2. For every exchange-active order not in local:
 *        - create a retroactive local record. This catches the
 *          place-succeeded-but-Mongo-write-failed race plus any orders
 *          placed by other clients (UI, another script).
 */
/**
 * Resolve orders in 'disappeared' state by querying fills-history.
 *   - Fills exist  → state='filled', record avg fillPrice and total fillSize
 *   - No fills     → state='cancelled' (externally cancelled or expired)
 *
 * Called as the final step of reconcileOnce; can also be invoked directly.
 */
async function resolveDisappeared({ instId } = {}) {
  await ensureIndexes();
  const filter = { env: env(), state: 'disappeared' };
  if (instId) filter.instId = instId;
  const candidates = await db.blofinOrders().find(filter).toArray();

  const out = { filled: [], cancelled: [], errors: [] };

  for (const order of candidates) {
    try {
      const fills = await blofin.getTradeHistory({
        instId: order.instId, orderId: order.orderId, limit: 100,
      });

      if (fills && fills.length > 0) {
        let totalSize = 0, weightedPrice = 0;
        let latestTs = 0;
        for (const f of fills) {
          const sz = Number(f.fillSize);
          const px = Number(f.fillPrice);
          if (Number.isFinite(sz) && Number.isFinite(px)) {
            totalSize     += sz;
            weightedPrice += sz * px;
          }
          const ts = Number(f.ts || f.fillTime || 0);
          if (ts > latestTs) latestTs = ts;
        }
        const avgPrice = totalSize > 0 ? (weightedPrice / totalSize) : null;

        await db.blofinOrders().updateOne(
          { orderId: order.orderId, env: env() },
          { $set: {
              state:        'filled',
              fillPrice:    avgPrice != null ? String(avgPrice) : null,
              fillSize:     String(totalSize),
              filledAt:     latestTs ? new Date(latestTs) : now(),
              updatedAt:    now(),
            } },
        );
        out.filled.push({
          orderId:  order.orderId,
          instId:   order.instId,
          side:     order.side,
          signalId: order.signalId,
          fillPrice: avgPrice,
          fillSize:  totalSize,
        });
      } else {
        // No fills found — externally cancelled (or expired)
        await db.blofinOrders().updateOne(
          { orderId: order.orderId, env: env() },
          { $set: { state: 'cancelled', cancelledAt: now(), updatedAt: now() } },
        );
        out.cancelled.push(order.orderId);
      }
    } catch (e) {
      out.errors.push({ orderId: order.orderId, error: e.message });
    }
  }

  return out;
}

async function reconcileOnce({ instId } = {}) {
  await ensureIndexes();
  const exchangeOrders = await blofin.getActiveOrders({ instId });
  const exchangeById   = new Map((exchangeOrders || []).map(o => [o.orderId, o]));

  const localOpen = await listLocalOpen(instId);
  const localById = new Map(localOpen.map(o => [o.orderId, o]));

  const report = { matched: 0, disappeared: [], retroactive: [], errors: [] };

  // Local → exchange
  for (const local of localOpen) {
    if (exchangeById.has(local.orderId)) {
      await db.blofinOrders().updateOne(
        { orderId: local.orderId, env: env() },
        { $set: { lastSyncedAt: now() } },
      );
      report.matched++;
    } else {
      await db.blofinOrders().updateOne(
        { orderId: local.orderId, env: env() },
        { $set: { state: 'disappeared', updatedAt: now() } },
      );
      report.disappeared.push(local.orderId);
    }
  }

  // Exchange → local (catch retroactive)
  for (const ex of exchangeOrders || []) {
    if (localById.has(ex.orderId)) continue;
    try {
      await db.blofinOrders().insertOne({
        orderId:        ex.orderId,
        clientOrdId:    ex.clientOrdId || null,
        signalId:       null,
        instId:         ex.instId,
        side:           ex.side,
        orderType:      ex.orderType,
        size:           ex.size,
        price:          ex.price ?? null,
        state:          'live',
        marginMode:     ex.marginMode || 'isolated',
        positionSide:   ex.positionSide || 'net',
        stopLossTriggerPrice:   ex.stopLossTriggerPrice ?? null,
        takeProfitTriggerPrice: ex.takeProfitTriggerPrice ?? null,
        env:            env(),
        schemaVersion:  SCHEMA_VERSION,
        createdAt:      now(),
        updatedAt:      now(),
        lastSyncedAt:   now(),
        cancelledAt:    null,
        filledAt:       null,
        retroactive:    true,
      });
      report.retroactive.push(ex.orderId);
    } catch (e) {
      report.errors.push({ orderId: ex.orderId, error: e.message });
    }
  }

  // Resolve any orders that landed in 'disappeared' (either this pass or
  // a prior one) so the local state catches up to fill/cancel truth.
  const resolved = await resolveDisappeared({ instId });
  report.filled            = resolved.filled;        // full fill detail objects
  report.cancelled         = resolved.cancelled;     // orderId list
  report.resolvedFilled    = resolved.filled.length;
  report.resolvedCancelled = resolved.cancelled.length;
  report.resolveErrors     = resolved.errors;

  // Position-protection invariant — every open position MUST have an
  // active SL. This is the Phase B.6 safety net: catches drift if the
  // autotrade SL placement somehow slipped past verification, or if a
  // position got opened outside the system (e.g. UI).
  try {
    report.unprotectedPositions = await findUnprotectedPositions();
  } catch (e) {
    report.errors.push({ orderId: 'findUnprotectedPositions', error: e.message });
    report.unprotectedPositions = [];
  }

  return report;
}

/**
 * Persist a standalone TPSL conditional order (different orderId namespace —
 * BloFin returns `tpslId`, not `orderId`). Stored in the same collection
 * with `kind: 'sl_conditional'` so reconcileOnce can find them.
 */
async function persistTPSL({ tpslId, signalId, instId, side, size, slTriggerPrice, slTriggerPriceType }) {
  await ensureIndexes();
  return db.blofinOrders().insertOne({
    orderId:          tpslId,            // reuse the field for indexing
    tpslId,                              // explicit too, for clarity
    kind:             'sl_conditional',
    signalId:         signalId || null,
    instId,
    side,
    orderType:        'conditional',
    size:             String(size),
    price:            null,
    state:            'live',
    marginMode:       'isolated',
    positionSide:     'net',
    slTriggerPrice:   String(slTriggerPrice),
    slTriggerPriceType,
    env:              env(),
    schemaVersion:    SCHEMA_VERSION,
    createdAt:        now(),
    updatedAt:        now(),
    lastSyncedAt:     now(),
    cancelledAt:      null,
    filledAt:         null,
  });
}

/**
 * Position-protection invariant check. For each open position on the
 * exchange, confirms a live SL exists in `blofin_orders_tpsl`. Returns a
 * list of unprotected (instId, size) pairs — empty when all positions
 * are covered. Caller decides what to do (Discord page, auto-flatten).
 */
async function findUnprotectedPositions() {
  await ensureIndexes();
  const positions = await blofin.getPositions();
  const out = [];
  for (const pos of positions || []) {
    const sz = Math.abs(Number(pos.positions || pos.pos || 0));
    if (sz === 0) continue;
    const pendingSL = await blofin.getPendingTPSL({ instId: pos.instId });
    const hasSL = (pendingSL || []).some(o => Number(o.slTriggerPrice) > 0);
    if (!hasSL) out.push({ instId: pos.instId, size: sz, side: Number(pos.positions || pos.pos) > 0 ? 'long' : 'short', avgPrice: pos.averagePrice });
  }
  return out;
}

module.exports = {
  ensureIndexes,
  placeAndPersist,
  persistAdoptedEntry,
  cancelAndPersist,
  listLocalOpen,
  getLocalByOrderId,
  resolveDisappeared,
  reconcileOnce,
  persistTPSL,
  findUnprotectedPositions,
};
