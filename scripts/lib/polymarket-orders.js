'use strict';

/**
 * lib/polymarket-orders.js — Real Polymarket CLOB order execution
 *
 * Handles live order placement for NO+Range signals only.
 * All other signal types (YES of any direction) must never reach this module.
 *
 * Exports:
 *   placeNoOrder(conditionId, noTokenId, noPrice, dollars)  → OrderResult
 *   pollOrderFill(tradeId, orderId, ttlMs)                  → void (writes trades.json)
 *   cancelOrder(orderId)                                    → void
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const { loadEnv, ROOT, resolveWebhook } = require('./env');
const { postWebhook }                   = require('./discord');

loadEnv();

const CLOB_HOST  = 'https://clob.polymarket.com';
const TRADES_FILE = path.join(ROOT, 'weather-trades.json');
const SIGNALS_HOOK = resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK');

// Polygon USDC (bridged) — 6 decimals
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI     = [{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' }];

// ─── On-chain USDC balance check ─────────────────────────────────────────────

async function checkUsdcBalance(walletAddress) {
  const { createPublicClient, http } = require('viem');
  const { polygon } = require('viem/chains');
  const client = createPublicClient({ chain: polygon, transport: http() });
  const raw = await client.readContract({
    address: USDC_ADDRESS,
    abi:     USDC_ABI,
    functionName: 'balanceOf',
    args:    [walletAddress],
  });
  return Number(raw) / 1e6;
}

// ─── Lazy CLOB client (initialised once per process) ─────────────────────────

let _clobClient = null;

async function getClobClient() {
  if (_clobClient) return _clobClient;

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY not set');

  const { ClobClient, Chain } = require('@polymarket/clob-client');
  const { createWalletClient, http } = require('viem');
  const { privateKeyToAccount }      = require('viem/accounts');
  const { polygon }                  = require('viem/chains');

  const normalised = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account    = privateKeyToAccount(normalised);
  const wallet     = createWalletClient({ account, chain: polygon, transport: http() });

  // L1-only client just for key derivation
  const l1Client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet);
  const creds    = await l1Client.createOrDeriveApiKey();

  // Full client with both L1 signer and L2 creds
  _clobClient = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds);
  return _clobClient;
}

// ─── Shared trade file helpers ────────────────────────────────────────────────

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); }
  catch { return []; }
}

function writeTrades(trades) {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2)); }
  catch (e) { console.error('[polymarket-orders] writeTrades failed:', e.message); }
}

function patchLiveOrder(tradeId, patch) {
  const trades = readTrades();
  const idx    = trades.findIndex(t => t.id === tradeId);
  if (idx === -1) return;
  trades[idx].liveOrder = { ...(trades[idx].liveOrder || {}), ...patch };
  writeTrades(trades);
}

// ─── Order book — fetch best ask for a NO token ───────────────────────────────

function fetchBestAsk(noTokenId) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'clob.polymarket.com',
        path:     `/book?token_id=${noTokenId}`,
        method:   'GET',
        headers:  { 'User-Agent': 'Weathermen/1.0 (Tangiers)' },
      },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const book = JSON.parse(raw);
            // asks are sorted ascending by price — first ask is the best (lowest)
            const bestAsk = parseFloat(book.asks?.[0]?.price ?? 1);
            resolve(bestAsk);
          } catch { resolve(1); }
        });
      }
    );
    req.setTimeout(10_000, () => { req.destroy(); resolve(1); });
    req.on('error', () => resolve(1));
    req.end();
  });
}

// ─── Price snapping ───────────────────────────────────────────────────────────

// Polymarket standard tick size is 0.01 for most markets.
// Round price DOWN to nearest tick so we don't cross the spread.
function snapToTick(price, tick = 0.01) {
  return Math.round(Math.floor(price / tick) * tick * 10000) / 10000;
}

// ─── Main: place a NO limit buy order ────────────────────────────────────────

/**
 * Place a limit buy order for NO outcome tokens.
 *
 * @param {string} conditionId   Polymarket condition ID (for logging)
 * @param {string} noTokenId     Token ID for the NO outcome
 * @param {number} noPrice       Signal-time NO price (0-1) — used as fallback
 * @param {number} dollars       USD amount to spend
 * @returns {Promise<{ liveOrder: object }>}
 */
async function placeNoOrder(conditionId, noTokenId, noPrice, dollars) {
  // Hard safety: this function must ONLY be called for NO side.
  if (!noTokenId) throw new Error('placeNoOrder: noTokenId is required');

  const isDryRun = process.env.POLYMARKET_DRY_RUN === 'true';

  // Fetch fresh best-ask price (NO token ask = what you pay to buy NO)
  const askPrice   = await fetchBestAsk(noTokenId);
  const limitPrice = snapToTick(Math.min(askPrice, 0.99));
  const shares     = Math.round((dollars / limitPrice) * 100) / 100;

  const baseOrder = {
    orderId:      null,
    noTokenId,
    sizeDollars:  dollars,
    limitPrice,
    status:       isDryRun ? 'dry_run' : 'open',
    filledDollars: 0,
    filledShares:  0,
    placedAt:      new Date().toISOString(),
    filledAt:      null,
    cancelledAt:   null,
    error:         null,
    livePnlDollars: null,
  };

  if (isDryRun) {
    const fakeId = `dry-${Date.now()}`;
    console.log(`[polymarket-orders] DRY RUN — would place NO limit buy: ${shares} shares @ ${limitPrice} ($${dollars})`);
    console.log(`[polymarket-orders] conditionId=${conditionId} noTokenId=${noTokenId}`);
    return { liveOrder: { ...baseOrder, orderId: fakeId } };
  }

  // On-chain USDC balance check — catches depleted wallets before the CLOB rejects us silently
  try {
    const { privateKeyToAccount } = require('viem/accounts');
    const pk          = process.env.POLYMARKET_PRIVATE_KEY || '';
    const normalised  = pk.startsWith('0x') ? pk : `0x${pk}`;
    const address     = privateKeyToAccount(normalised).address;
    const minBalance  = parseFloat(process.env.POLYMARKET_MIN_BALANCE || '20');
    const usdcBalance = await checkUsdcBalance(address);
    console.log(`[polymarket-orders] on-chain USDC: $${usdcBalance.toFixed(2)}`);
    if (usdcBalance < minBalance) {
      const msg = `⚠️ **LOW USDC BALANCE — ORDER SKIPPED**\nOn-chain: **$${usdcBalance.toFixed(2)}** | Minimum: **$${minBalance}**\nDeposit USDC to Polygon wallet \`${address}\` to resume live trading.`;
      console.warn('[polymarket-orders] low USDC balance, skipping order');
      await postWebhook(SIGNALS_HOOK, 'error', msg, 'Weather • Live Order');
      return { liveOrder: { ...baseOrder, status: 'error', error: `low usdc balance: $${usdcBalance.toFixed(2)}` } };
    }
  } catch (err) {
    // Non-fatal — log and continue; the CLOB will reject if truly out of funds
    console.warn('[polymarket-orders] USDC balance check failed (non-fatal):', err.message);
  }

  try {
    const { Side, OrderType } = require('@polymarket/clob-client');
    const client = await getClobClient();

    const order = await client.createAndPostOrder(
      { tokenID: noTokenId, price: limitPrice, size: shares, side: Side.BUY },
      undefined,
      OrderType.GTC
    );

    const orderId = order?.orderID ?? order?.id ?? null;
    if (!orderId) throw new Error(`No orderId in response: ${JSON.stringify(order)}`);

    console.log(`[polymarket-orders] Order placed: ${orderId} — ${shares} NO shares @ ${limitPrice} ($${dollars})`);
    return { liveOrder: { ...baseOrder, orderId } };

  } catch (err) {
    console.error('[polymarket-orders] placeNoOrder failed:', err.message);
    return {
      liveOrder: { ...baseOrder, status: 'error', error: err.message },
    };
  }
}

// ─── Poll for fill ────────────────────────────────────────────────────────────

/**
 * Fire-and-forget fill poller. Checks order status every POLL_INTERVAL_S seconds,
 * updates weather-trades.json, cancels if TTL expires.
 *
 * @param {string} tradeId  Signal ID (wx-...) — used to locate trade in JSON
 * @param {string} orderId  Polymarket CLOB order ID
 * @param {number} ttlMs    Max wait before cancellation (milliseconds)
 */
async function pollOrderFill(tradeId, orderId, ttlMs) {
  if (process.env.POLYMARKET_DRY_RUN === 'true') return;
  if (!orderId || orderId.startsWith('dry-')) return;

  const intervalMs = (+process.env.POLYMARKET_POLL_INTERVAL_S || 300) * 1000;
  const deadline   = Date.now() + ttlMs;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    try {
      const client = await getClobClient();
      const order  = await client.getOrder(orderId);

      const originalSize = parseFloat(order.original_size ?? 0);
      const sizeMatched  = parseFloat(order.size_matched ?? 0);
      const status       = (order.status ?? '').toLowerCase();

      if (status === 'matched' || (originalSize > 0 && sizeMatched >= originalSize)) {
        // Fully filled
        const filledShares  = sizeMatched;
        const filledDollars = Math.round(filledShares * parseFloat(order.price ?? 0) * 100) / 100;
        patchLiveOrder(tradeId, {
          status:        'filled',
          filledShares,
          filledDollars,
          filledAt:      new Date().toISOString(),
        });
        await postWebhook(SIGNALS_HOOK, 'info',
          `**LIVE ORDER FILLED** | ${tradeId}\n` +
          `Filled: ${filledShares} NO shares @ ${order.price} ($${filledDollars})`,
          'Weather • Live Order'
        );
        return;
      }

      if (status === 'canceled' || status === 'cancelled') {
        patchLiveOrder(tradeId, {
          status:       'cancelled',
          filledShares: sizeMatched,
          filledDollars: Math.round(sizeMatched * parseFloat(order.price ?? 0) * 100) / 100,
          cancelledAt:  new Date().toISOString(),
        });
        return;
      }

      // Still live — update partial progress if any
      if (sizeMatched > 0) {
        patchLiveOrder(tradeId, { filledShares: sizeMatched });
      }

    } catch (err) {
      console.error(`[polymarket-orders] poll ${orderId} error:`, err.message);
    }
  }

  // TTL expired — cancel the order
  try {
    const client = await getClobClient();
    await client.cancelOrder({ orderID: orderId });
    console.log(`[polymarket-orders] Order ${orderId} cancelled (TTL expired)`);

    const trades = readTrades();
    const trade  = trades.find(t => t.id === tradeId);
    const partial = trade?.liveOrder?.filledShares ?? 0;

    patchLiveOrder(tradeId, {
      status:      partial > 0 ? 'partial_expired' : 'cancelled',
      cancelledAt: new Date().toISOString(),
    });

    await postWebhook(SIGNALS_HOOK, 'error',
      `**LIVE ORDER EXPIRED** | ${tradeId}\n` +
      `Order ${orderId} cancelled after TTL — partial fill: ${partial} shares`,
      'Weather • Live Order'
    );
  } catch (err) {
    console.error(`[polymarket-orders] cancelOrder ${orderId} failed:`, err.message);
    patchLiveOrder(tradeId, { status: 'error', error: `cancel failed: ${err.message}` });
  }
}

// ─── Cancel helper (for manual use) ──────────────────────────────────────────

async function cancelOrder(orderId) {
  if (!orderId || orderId.startsWith('dry-')) return;
  const client = await getClobClient();
  await client.cancelOrder({ orderID: orderId });
}

// ─── Live P&L computation (called by resolveOutcomes in market-scan.js) ───────

/**
 * Compute live P&L for a resolved trade that had a live order filled.
 * Updates liveOrder.livePnlDollars in-place.
 *
 * @param {object} trade  Trade record with liveOrder sub-object
 * @param {boolean} won   true if NO won (temp was NOT in range)
 */
function computeLivePnl(trade, won) {
  if (!trade.liveOrder || trade.liveOrder.status !== 'filled') return;
  const { filledShares, limitPrice } = trade.liveOrder;
  if (!filledShares || !limitPrice) return;

  trade.liveOrder.livePnlDollars = won
    ? Math.round(filledShares * (1 - limitPrice) * 100) / 100
    : -Math.round(filledShares * limitPrice * 100) / 100;
}

module.exports = {
  placeNoOrder,
  pollOrderFill,
  cancelOrder,
  computeLivePnl,
};
