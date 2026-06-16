'use strict';

/**
 * Signal-to-orders translation. Gated by BLOFIN_AUTOTRADE=true.
 *
 * Order layout per signal:
 *   • 1× market entry, full size, with attached SL at stop price
 *   • 3× reduce-only limit orders at TP1/TP2/TP3, each at 1/3 size
 *
 * As TPs fill, the position reduces. The attached SL continues to
 * cover whatever remains. Total reduce-only size = entry size, so
 * TP3 hitting closes the position to flat.
 *
 * Idempotency: keyed off signalId — re-firing the same signal is a
 * no-op. The lookup hits the (signalId) index on blofin_orders.
 *
 * Failure semantics: if the entry places but a TP rejects, we proceed
 * with the orders that DID place and log the rejection. We DO NOT
 * roll back the entry — Phase B.5's reconciliation will surface any
 * inconsistency and the operator can intervene. Better to have a
 * partially-laddered position than no position with the entry-SL
 * pair orphaned.
 *
 * Required env:
 *   BLOFIN_AUTOTRADE     'true' to enable; anything else = disabled
 *   ACCOUNT_EQUITY_USD   used for sizing (existing Tangiers env var)
 *   RISK_PER_TRADE_PCT   used for sizing (existing Tangiers env var)
 */

const blofin = require('./blofin');
const store  = require('./blofin-store');
const db     = require('./db');

// BloFin BTC-USDT-PERP contract specs (Phase A discovery):
//   contractValue 0.001 BTC, tickSize 0.1, lotSize 0.1, minSize 0.1
const CONTRACT_VALUE_BTC = 0.001;
const LOT_SIZE           = 0.1;
const MIN_SIZE           = 0.1;

const TIER_MULT = { A: 1.0, B: 0.7, C: 0.3 };

function isEnabled() {
  return process.env.BLOFIN_AUTOTRADE === 'true';
}

function tierKey(setupType) {
  if (!setupType) return null;
  const first = setupType.trim()[0];
  return TIER_MULT[first] ? first : null;
}

function quantizePrice(p) {
  return Math.round(p * 10) / 10;     // tickSize 0.1
}

function quantizeSize(s) {
  // Round down to lotSize so we never exceed risk budget.
  return Math.floor(s * 10) / 10;
}

/**
 * Returns { contracts, sizePerTp, rDollar, error? } given a signal.
 */
function sizingFor({ entry, stop, setupType }) {
  const tier = tierKey(setupType);
  if (!tier) return { error: `unknown setup tier: ${setupType}` };

  const equity   = Number(process.env.ACCOUNT_EQUITY_USD);
  const riskPct  = Number(process.env.RISK_PER_TRADE_PCT);
  if (!Number.isFinite(equity) || equity <= 0) {
    return { error: 'ACCOUNT_EQUITY_USD missing or non-positive' };
  }
  if (!Number.isFinite(riskPct) || riskPct <= 0) {
    return { error: 'RISK_PER_TRADE_PCT missing or non-positive' };
  }

  const rDollar      = equity * (riskPct / 100) * TIER_MULT[tier];
  const stopDistance = Math.abs(entry - stop);
  if (stopDistance <= 0) return { error: 'stop equals entry' };

  // Per-contract loss at stop:  stopDistance × contractValue (USDT).
  const lossPerContract = stopDistance * CONTRACT_VALUE_BTC;
  const rawContracts    = rDollar / lossPerContract;
  const contracts       = quantizeSize(rawContracts);
  const sizePerTp       = quantizeSize(contracts / 3);

  if (contracts < MIN_SIZE) {
    return { error: `sized to ${contracts.toFixed(2)} contracts — below minSize ${MIN_SIZE}` };
  }
  if (sizePerTp < MIN_SIZE) {
    return { error: `per-TP size ${sizePerTp.toFixed(2)} below minSize — stop too tight for 3-rung ladder` };
  }

  return { contracts, sizePerTp, rDollar };
}

/**
 * Main entry. Throws on hard failures (sizing, no equity); returns
 * `{ skipped: 'reason' }` on soft skips; returns `{ orders: [...] }`
 * on success.
 *
 * Caller pattern:
 *   autotrade({ ... }).catch(e => log('Autotrade error: ' + e.message));
 *
 * Errors are recoverable — the signal still fires on Discord and is
 * still logged to trades.json regardless.
 */
async function autotrade({
  signalId, direction, setupType,
  entry, stop, tp1, tp2, tp3,
  instId = 'BTC-USDT',
}) {
  if (!isEnabled())        return { skipped: 'BLOFIN_AUTOTRADE != true' };
  if (!blofin.isDemo())    return { skipped: 'refuses to run outside demo env' };
  if (!signalId)           throw new Error('autotrade: signalId required');
  if (direction !== 'long' && direction !== 'short') {
    throw new Error(`autotrade: bad direction: ${direction}`);
  }

  // Ensure Mongo connection + indexes before any read (idempotency lookup
  // hits blofin_orders.signalId).
  await store.ensureIndexes();

  // Idempotency — bail before any API call.
  const existing = await db.blofinOrders().findOne({ signalId, env: 'demo' });
  if (existing) return { skipped: `signal ${signalId} already traded (order ${existing.orderId})` };

  const sizing = sizingFor({ entry, stop, setupType });
  if (sizing.error) return { skipped: sizing.error };

  const { contracts, sizePerTp, rDollar } = sizing;
  const side       = direction === 'long' ? 'buy' : 'sell';
  const closeSide  = direction === 'long' ? 'sell' : 'buy';

  const orders = [];

  // 1. Market entry with attached SL covering full position.
  const entryResult = await store.placeAndPersist({
    instId,
    side,
    orderType:            'market',
    size:                 String(contracts),
    marginMode:           'isolated',
    positionSide:         'net',
    stopLossTriggerPrice: String(quantizePrice(stop)),
  }, { signalId });
  orders.push({ kind: 'entry', orderId: entryResult.doc.orderId });

  // 2-4. TP rungs as reduce-only limits at 1/3 size each.
  for (const [kind, tpPrice] of [['tp1', tp1], ['tp2', tp2], ['tp3', tp3]]) {
    if (tpPrice == null) continue;
    try {
      const tpResult = await store.placeAndPersist({
        instId,
        side:         closeSide,
        orderType:    'limit',
        size:         String(sizePerTp),
        price:        String(quantizePrice(tpPrice)),
        marginMode:   'isolated',
        positionSide: 'net',
        reduceOnly:   true,
      }, { signalId });
      orders.push({ kind, orderId: tpResult.doc.orderId });
    } catch (e) {
      // Surface but don't unwind — partial ladder is preferable to
      // orphaned entry-SL pair. B.5 will reconcile.
      orders.push({ kind, error: e.message });
    }
  }

  return { signalId, direction, contracts, sizePerTp, rDollar, orders };
}

module.exports = {
  isEnabled,
  sizingFor,
  autotrade,
};
