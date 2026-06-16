'use strict';

/**
 * BloFin REST client — Phase A (read-only).
 *
 * Base URL is determined by BLOFIN_ENV ('demo' default | 'prod').
 * Signing follows BloFin's documented scheme:
 *   prehash = requestPath + METHOD + timestamp_ms + nonce + body
 *   sig     = base64(utf8-bytes-of( hex( HMAC-SHA256(secret, prehash) ) ))
 *
 * BloFin double-encodes — HMAC → hex string → base64 of those hex bytes —
 * which is NOT the same as OKX's single base64-of-raw-HMAC. Getting this
 * wrong silently produces a valid-looking signature that the exchange
 * rejects with code 50113.
 *
 * Required env: BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_API_PASSPHRASE
 * Optional env: BLOFIN_ENV ('demo' | 'prod', default 'demo')
 */

const crypto = require('crypto');
const https  = require('https');

const PROD_BASE = 'https://openapi.blofin.com';
const DEMO_BASE = 'https://demo-trading-openapi.blofin.com';

function baseUrl() {
  return (process.env.BLOFIN_ENV || 'demo') === 'prod' ? PROD_BASE : DEMO_BASE;
}

function isDemo() {
  return (process.env.BLOFIN_ENV || 'demo') !== 'prod';
}

function requireCreds() {
  const { BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_API_PASSPHRASE } = process.env;
  if (!BLOFIN_API_KEY || !BLOFIN_API_SECRET || !BLOFIN_API_PASSPHRASE) {
    throw new Error('BloFin credentials missing — set BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_API_PASSPHRASE in .env');
  }
  return { key: BLOFIN_API_KEY, secret: BLOFIN_API_SECRET, passphrase: BLOFIN_API_PASSPHRASE };
}

/**
 * Sign a request per BloFin spec. Returns the headers to attach.
 * `requestPath` MUST include the query string for GET requests.
 */
function sign(method, requestPath, body, secret) {
  const timestamp = Date.now().toString();
  const nonce     = crypto.randomUUID();
  const prehash   = requestPath + method.toUpperCase() + timestamp + nonce + (body || '');
  const hex       = crypto.createHmac('sha256', secret).update(prehash).digest('hex');
  const sig       = Buffer.from(hex, 'utf8').toString('base64');
  return { sig, timestamp, nonce };
}

function _request(method, path, { query, body, signed = true, timeoutMs = 10000 } = {}) {
  // Build the query string AFTER filtering empties so a callsite passing
  // `{ instId: undefined }` doesn't leave a trailing `?` in the signed path.
  // BloFin's server normalizes the path before computing its own signature;
  // a trailing `?` here gives a 152409 "Signature verification failed".
  const parts = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    : [];
  const qs = parts.length ? '?' + parts.join('&') : '';
  const requestPath = path + qs;
  const url         = baseUrl() + requestPath;
  const bodyStr     = body ? JSON.stringify(body) : '';

  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ace-trading-bot/1.0' };
  if (signed) {
    const { key, secret, passphrase } = requireCreds();
    const { sig, timestamp, nonce }   = sign(method, requestPath, bodyStr, secret);
    headers['ACCESS-KEY']        = key;
    headers['ACCESS-SIGN']       = sig;
    headers['ACCESS-TIMESTAMP']  = timestamp;
    headers['ACCESS-NONCE']      = nonce;
    headers['ACCESS-PASSPHRASE'] = passphrase;
  }

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('blofin rate-limited (429)'));
        if (res.statusCode !== 200) return reject(new Error(`blofin http ${res.statusCode}: ${data.slice(0, 300)}`));
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { return reject(new Error(`blofin invalid JSON: ${data.slice(0,200)}`)); }
        if (parsed.code !== '0' && parsed.code !== 0) {
          return reject(new Error(`blofin api error ${parsed.code}: ${parsed.msg || 'unknown'}`));
        }
        resolve(parsed.data);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('blofin timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Public reads (no auth) ──────────────────────────────────────────────────

/** Symbol/instrument metadata. instId optional — omit to list all. */
async function getInstruments(instId) {
  return _request('GET', '/api/v1/market/instruments', { query: { instId }, signed: false });
}

// ─── Private reads ───────────────────────────────────────────────────────────

/** Account balance. accountType defaults to 'futures' (matches Tangiers BTC perp pipeline). */
async function getBalance(accountType = 'futures') {
  return _request('GET', '/api/v1/asset/balances', { query: { accountType } });
}

/** Open positions on the futures account. */
async function getPositions(instId) {
  return _request('GET', '/api/v1/account/positions', { query: { instId } });
}

// ─── Account configuration (one-time) ────────────────────────────────────────

/**
 * Switch the futures account between one-way and hedge mode.
 * User-facing values are 'net' / 'hedge'; BloFin's actual enum is
 * `net_mode` / `long_short_mode` (caller doesn't need to care).
 * Tangiers uses 'net' — never opens opposing positions.
 *
 * Path note: docs claim `/api/v1/trade/position-mode` (returns 152404).
 * Real path is `/api/v1/account/set-position-mode`.
 */
async function setPositionMode(positionMode) {
  const map = { net: 'net_mode', hedge: 'long_short_mode' };
  if (!(positionMode in map)) {
    throw new Error(`positionMode must be 'net' or 'hedge', got: ${positionMode}`);
  }
  return _request('POST', '/api/v1/account/set-position-mode', {
    body: { positionMode: map[positionMode] },
  });
}

/**
 * Set leverage for a specific instrument under a margin mode.
 * marginMode: 'isolated' bounds loss per trade; 'cross' shares margin.
 * Tangiers prefers isolated for bounded per-trade loss.
 *
 * Path: BloFin docs claim `/api/v1/trade/leverage` but the live path
 * follows the same `/api/v1/account/set-leverage` pattern as position-mode.
 */
async function setLeverage(instId, leverage, marginMode = 'isolated') {
  return _request('POST', '/api/v1/account/set-leverage', {
    body: { instId, leverage: String(leverage), marginMode },
  });
}

// ─── Order placement / management ────────────────────────────────────────────

/**
 * Generic order placement. Pass-through for all BloFin order fields.
 * For market entries with attached protection, include
 * `stopLossTriggerPrice` and `takeProfitTriggerPrice` (BloFin attaches
 * these directly to the entry — no separate stop order needed for SL).
 *
 * Returns `{ orderId, clientOrdId }`.
 */
async function placeOrder({
  instId,
  side,                // 'buy' | 'sell'
  orderType,           // 'market' | 'limit'
  size,                // string or number, in contracts (minSize 0.1 for BTC-USDT)
  price,               // required for limit orders
  marginMode = 'isolated',
  positionSide = 'net',
  reduceOnly,
  stopLossTriggerPrice,
  takeProfitTriggerPrice,
  clientOrdId,
}) {
  const body = {
    instId, marginMode, side, positionSide, orderType,
    size: String(size),
  };
  if (price !== undefined)                  body.price = String(price);
  if (reduceOnly !== undefined)             body.reduceOnly = reduceOnly;
  if (stopLossTriggerPrice !== undefined)   body.stopLossTriggerPrice = String(stopLossTriggerPrice);
  if (takeProfitTriggerPrice !== undefined) body.takeProfitTriggerPrice = String(takeProfitTriggerPrice);
  if (clientOrdId !== undefined)            body.clientOrdId = clientOrdId;
  return _request('POST', '/api/v1/trade/order', { body });
}

/** Cancel a single order by id. */
async function cancelOrder(orderId, instId) {
  const body = { orderId };
  if (instId) body.instId = instId;
  return _request('POST', '/api/v1/trade/cancel-order', { body });
}

/** List open/pending orders. `state` and `instId` are optional filters. */
async function getActiveOrders({ instId, orderType } = {}) {
  return _request('GET', '/api/v1/trade/orders-pending', { query: { instId, orderType } });
}

/**
 * Trade fills history. `orderId` filter scopes to a single order; without
 * it, returns all fills for `instId` (or all instruments if omitted).
 * Docs claim `/api/v1/trade/trade-history`; live path may differ — probe
 * if 152404.
 */
async function getTradeHistory({ instId, orderId, after, before, limit } = {}) {
  return _request('GET', '/api/v1/trade/fills-history', {
    query: { instId, orderId, after, before, limit },
  });
}

// ─── Demo-only writes ────────────────────────────────────────────────────────

/**
 * Top up the demo account with virtual funds. Demo env only.
 *
 * NOTE — BloFin's docs JSON example for this endpoint OMITS the `accountType`
 * field. The server requires it. When omitted, the error message is
 * `Parameter toAccount cannot be empty` (code 152001), which is misleading
 * — `toAccount` is not a real field on this endpoint, just a constant error
 * string the server returns when the required account-routing param is
 * missing. The right field name is `accountType`, matching the balance
 * endpoint's query param.
 *
 * `adjustType=0` adds; `=1` subtracts.
 */
async function applyDemoMoney(currency, amount, { accountType = 'futures', adjustType = 0 } = {}) {
  if (!isDemo()) throw new Error('applyDemoMoney refuses to run when BLOFIN_ENV=prod');
  return _request('POST', '/api/v1/asset/demo-apply-money', {
    body: {
      accountType,
      adjustType,
      demoApplyMoney: [{ currency, amountStr: String(amount) }],
    },
  });
}

module.exports = {
  baseUrl,
  isDemo,
  sign,
  getInstruments,
  getBalance,
  getPositions,
  setPositionMode,
  setLeverage,
  placeOrder,
  cancelOrder,
  getActiveOrders,
  getTradeHistory,
  applyDemoMoney,
};
