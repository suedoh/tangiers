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
const fs     = require('fs');
const path   = require('path');

const SCHEMA_VERSION = 1;

// Mongo-outage spool. When Mongo is unreachable, placed-order docs are
// appended here (NDJSON, one doc per line) instead of being lost — recon
// backfills them via flushSpool() once Mongo returns. Exists because the
// 2026-06-27→29 Docker outage turned every fully-qualified signal into a
// hard drop (+18R missed): the exchange placement was fine, only the
// bookkeeping needed Mongo. Exchange-side safety holds without Mongo —
// BloFin rejects duplicate clientOrderIds, and the SL verify step never
// touched Mongo in the first place.
const ROOT       = path.resolve(__dirname, '..', '..');
const SPOOL_FILE = path.join(ROOT, '.blofin-spool.ndjson');

const MONGO_RETRY_BACKOFF_MS = 60_000;
let _mongoDownUntil = 0;

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

/**
 * Non-throwing Mongo availability check with a 60s backoff so a single
 * autotrade call (entry + SL + 3 TPs) doesn't stack five connect timeouts
 * during an outage.
 */
async function mongoAvailable() {
  if (Date.now() < _mongoDownUntil) return false;
  try {
    await ensureIndexes();
    return true;
  } catch (e) {
    _mongoDownUntil = Date.now() + MONGO_RETRY_BACKOFF_MS;
    console.error(`[blofin-store] Mongo unavailable (backoff ${MONGO_RETRY_BACKOFF_MS / 1000}s): ${e.message}`);
    return false;
  }
}

function spoolDoc(doc) {
  try {
    fs.appendFileSync(SPOOL_FILE, JSON.stringify(doc) + '\n');
    return true;
  } catch (e) {
    // Order is live on the exchange but now unrecorded anywhere — recon's
    // retroactive pass is the last-resort net for this.
    console.error(`[blofin-store] SPOOL WRITE FAILED — order ${doc.orderId} placed but unrecorded: ${e.message}`);
    return false;
  }
}

/**
 * Backfill spooled docs into Mongo. Called at the top of every recon run.
 * Claim-by-rename before processing so a concurrent autotrade append can
 * never be lost: appends that land after the rename create a fresh spool
 * file, picked up next cycle. Crashed flushes leave .processing-* files,
 * which are recovered here first. Throws if Mongo is still down (nothing
 * is claimed in that case).
 */
async function flushSpool() {
  const dir  = path.dirname(SPOOL_FILE);
  const base = path.basename(SPOOL_FILE);

  const hasSpool = fs.existsSync(SPOOL_FILE);
  const leftovers = fs.readdirSync(dir).filter(f => f.startsWith(base + '.processing-'));
  if (!hasSpool && leftovers.length === 0) return { flushed: 0, errors: 0 };

  await ensureIndexes(); // Mongo still down → throw before claiming anything

  const claims = leftovers.map(f => path.join(dir, f));
  if (fs.existsSync(SPOOL_FILE)) {
    const claimed = SPOOL_FILE + '.processing-' + Date.now();
    fs.renameSync(SPOOL_FILE, claimed);
    claims.push(claimed);
  }

  let flushed = 0, errors = 0;
  for (const file of claims) {
    let fileClean = true;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const doc = JSON.parse(line);
        for (const k of ['createdAt', 'updatedAt', 'lastSyncedAt', 'cancelledAt', 'filledAt']) {
          if (doc[k]) doc[k] = new Date(doc[k]);
        }
        doc.lastSyncedAt = new Date();
        await db.blofinOrders().updateOne(
          { orderId: doc.orderId, env: doc.env },
          { $setOnInsert: doc },
          { upsert: true },
        );
        flushed++;
      } catch (e) {
        fileClean = false;
        errors++;
        console.error(`[blofin-store] spool flush error: ${e.message}`);
      }
    }
    if (fileClean) fs.unlinkSync(file);
  }
  return { flushed, errors };
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
  // Availability check BEFORE the placement, spool decision AFTER it.
  // Invariant: once blofin.placeOrder succeeds, this function never throws —
  // an order that is live on the exchange must always land in Mongo or the
  // spool, never in an exception.
  const mongoUp = await mongoAvailable();
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

  if (mongoUp) {
    try {
      await db.blofinOrders().insertOne(doc);
      return { apiRes, doc };
    } catch (e) {
      console.error(`[blofin-store] Mongo insert failed post-placement — spooling ${orderId}: ${e.message}`);
    }
  }
  doc.unsynced = true;
  spoolDoc(doc);
  return { apiRes, doc, unsynced: true };
}

/**
 * Persist an entry order discovered on the exchange after an ambiguous-write
 * timeout (the autotrade resilient-retry adopt path). The order is already
 * live/filled on BloFin; we attach our signalId and persist so the SL step
 * and reconciliation treat it as a tracked entry. Upsert by (orderId, env)
 * so it co-exists harmlessly if recon already retro-created the same order.
 */
async function persistAdoptedEntry(exOrder, signalId) {
  const mongoUp = await mongoAvailable();
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
  if (mongoUp) {
    try {
      await db.blofinOrders().updateOne(
        { orderId: doc.orderId, env: env() },
        { $setOnInsert: doc },
        { upsert: true },
      );
      return doc;
    } catch (e) {
      console.error(`[blofin-store] adopted-entry upsert failed — spooling ${doc.orderId}: ${e.message}`);
    }
  }
  doc.unsynced = true;
  spoolDoc(doc);
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

  const out = { filled: [], cancelled: [], resurrected: [], errors: [] };

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
      } else if (order.kind === 'sl_conditional') {
        // TPSL ids don't appear in orders-history and a triggered SL
        // legitimately vanishes from the TPSL namespace — keep the
        // no-fills→cancelled rule for conditionals.
        await db.blofinOrders().updateOne(
          { orderId: order.orderId, env: env() },
          { $set: { state: 'cancelled', cancelledAt: now(), updatedAt: now() } },
        );
        out.cancelled.push(order.orderId);
      } else {
        // No fills — require positive confirmation before cancelling.
        // 2026-07-04: a page-truncated pending read marked live resting
        // rungs disappeared, and the same-pass no-fills→cancelled rule
        // corrupted the book. A genuinely completed order ALWAYS appears
        // in orders-history; absence means it is still resting.
        const hist = (await blofin.getOrderHistory({
          instId: order.instId, orderId: order.orderId, limit: 10,
        }) || []).find(o => String(o.orderId) === String(order.orderId));
        const st = String(hist?.state || '').toLowerCase();

        if (hist && st.includes('fill') && !st.includes('cancel')) {
          // Belt-and-braces: fills-history missed it but order-history says
          // filled — trust the order record's aggregate fields.
          await db.blofinOrders().updateOne(
            { orderId: order.orderId, env: env() },
            { $set: {
                state:     'filled',
                fillPrice: hist.averagePrice != null ? String(hist.averagePrice) : null,
                fillSize:  hist.filledSize != null ? String(hist.filledSize) : null,
                filledAt:  now(),
                updatedAt: now(),
              } },
          );
          out.filled.push({
            orderId:  order.orderId,
            instId:   order.instId,
            side:     order.side,
            signalId: order.signalId,
            fillPrice: Number(hist.averagePrice) || null,
            fillSize:  Number(hist.filledSize) || null,
          });
        } else if (hist) {
          // Positive confirmation: exchange history says cancelled.
          await db.blofinOrders().updateOne(
            { orderId: order.orderId, env: env() },
            { $set: { state: 'cancelled', cancelledAt: now(), updatedAt: now() } },
          );
          out.cancelled.push(order.orderId);
        } else if ((order.reconMisses || 0) >= 2) {
          // Not pending, no fills, no history, three passes in a row —
          // give up so a truly-gone order can't ping-pong forever.
          await db.blofinOrders().updateOne(
            { orderId: order.orderId, env: env() },
            { $set: { state: 'cancelled', cancelledAt: now(), updatedAt: now() } },
          );
          out.cancelled.push(order.orderId);
        } else {
          // Still resting — the pending read that missed it was truncated
          // or flaky. Exchange truth wins: back to live; the next paginated
          // pending read should match it.
          await db.blofinOrders().updateOne(
            { orderId: order.orderId, env: env() },
            { $set: { state: 'live', updatedAt: now(), lastSyncedAt: now() },
              $inc: { reconMisses: 1 } },
          );
          out.resurrected.push(order.orderId);
        }
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

  // Standalone SL conditionals live in the TPSL namespace, NOT orders-pending.
  // Diffing them against getActiveOrders (pre-2026-07-02 behaviour) marked
  // every live SL disappeared→cancelled in Mongo minutes after placement —
  // harmless for safety (findUnprotectedPositions reads the exchange), but it
  // corrupted the book the Phase-D attribution join relies on.
  const pendingTPSL = await blofin.getPendingTPSL({ instId });
  const tpslById    = new Map((pendingTPSL || []).map(o => [o.tpslId, o]));

  const localOpen = await listLocalOpen(instId);
  const localById = new Map(localOpen.map(o => [o.orderId, o]));

  const report = { matched: 0, disappeared: [], retroactive: [], resurrected: [], errors: [] };

  // Local → exchange
  for (const local of localOpen) {
    const stillOnExchange = local.kind === 'sl_conditional'
      ? tpslById.has(local.tpslId || local.orderId)
      : exchangeById.has(local.orderId);
    if (stillOnExchange) {
      await db.blofinOrders().updateOne(
        { orderId: local.orderId, env: env() },
        { $set: { lastSyncedAt: now(), reconMisses: 0 } },
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
      // A doc may exist in a non-live state while the exchange still shows
      // the order resting — the 2026-07-04 page-truncation incident falsely
      // cancelled live rungs, then insertOne E11000-looped every pass when
      // they re-entered the page. Exchange truth wins: resurrect.
      const existing = await getLocalByOrderId(ex.orderId);
      if (existing) {
        if (existing.state !== 'live') {
          await db.blofinOrders().updateOne(
            { orderId: ex.orderId, env: env() },
            { $set: { state: 'live', updatedAt: now(), lastSyncedAt: now() } },
          );
          report.resurrected.push({ orderId: ex.orderId, priorState: existing.state });
        }
        continue;
      }
      await db.blofinOrders().insertOne({
        orderId:        ex.orderId,
        // BloFin's field is clientOrderId (probed 2026-06-24); clientOrdId is
        // the docs' vocabulary and is never populated in responses.
        clientOrdId:    ex.clientOrderId || ex.clientOrdId || null,
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
  report.resurrected.push(
    ...(resolved.resurrected || []).map(orderId => ({ orderId, priorState: 'disappeared' })),
  );
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
  const mongoUp = await mongoAvailable();
  const doc = {
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
  };
  if (mongoUp) {
    try {
      await db.blofinOrders().insertOne(doc);
      return doc;
    } catch (e) {
      console.error(`[blofin-store] TPSL insert failed — spooling ${tpslId}: ${e.message}`);
    }
  }
  doc.unsynced = true;
  spoolDoc(doc);
  return doc;
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
  mongoAvailable,
  flushSpool,
  placeAndPersist,
  persistAdoptedEntry,
  cancelAndPersist,
  listLocalOpen,
  getLocalByOrderId,
  resolveDisappeared,
  reconcileOnce,
  persistTPSL,
  findUnprotectedPositions,
  SPOOL_FILE,
};
