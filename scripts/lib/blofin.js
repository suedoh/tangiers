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

/**
 * Resolve an interface name (e.g. 'en0') to its non-internal IPv4 address, for
 * `localAddress` binding. Returns undefined when unset or unresolvable, and the
 * caller then behaves exactly as before — an absent/renamed interface degrades
 * to the default route rather than breaking every BloFin call.
 *
 * Why this exists: this host's default route is periodically a ProtonVPN tunnel
 * whose exit IP Cloudflare blocks, which surfaces as `blofin http 403:
 * <!DOCTYPE html>` on signed AND unsigned, demo AND prod requests. Measured
 * 2026-09-06: 1/6 success over the tunnel, 6/6 over en0 in the same minute.
 * OFF BY DEFAULT — set BLOFIN_BIND_INTERFACE=en0 in .env to opt in.
 */
function bindLocalAddress() {
  const ifname = process.env.BLOFIN_BIND_INTERFACE;
  if (!ifname) return undefined;
  try {
    const nets = require('os').networkInterfaces()[ifname] || [];
    const v4 = nets.find(n => n.family === 'IPv4' && !n.internal);
    return v4 ? v4.address : undefined;
  } catch { return undefined; }
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
    // Force IPv4. This host's IPv6 route to BloFin's Cloudflare endpoint is
    // broken; node's default Happy Eyeballs (autoSelectFamily) races v6+v4 and
    // intermittently hangs ~5s on the dead v6 path, surfacing as 'blofin
    // timeout'. Proven 2026-06-25: default → timeout, family:4 → 200 in 1.5s.
    // dns.setDefaultResultOrder('ipv4first') alone is NOT enough — autoSelect
    // still attempts v6. (Docker/curl unaffected — different network paths.)
    const localAddress = bindLocalAddress();
    const req = https.request(url, {
      method, headers, family: 4, autoSelectFamily: false,
      ...(localAddress ? { localAddress } : {}),
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('blofin rate-limited (429)'));
        if (res.statusCode !== 200) return reject(new Error(`blofin http ${res.statusCode}: ${data.slice(0, 300)}`));
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { return reject(new Error(`blofin invalid JSON: ${data.slice(0,200)}`)); }
        if (parsed.code !== '0' && parsed.code !== 0) {
          // Batch endpoints (order placement) wrap the real rejection in
          // parsed.data[].code/msg — e.g. code 1 "All operations failed"
          // hides 102047 insufficient-margin underneath. Surfacing it is
          // the difference between a diagnosable drop and a mystery
          // (2026-07-04: two entry drops logged only the wrapper).
          const nested = Array.isArray(parsed.data)
            ? parsed.data
                .filter(d => d && (d.code !== undefined || d.msg))
                .map(d => ` [${d.code}: ${d.msg || ''}]`)
                .join('')
            : '';
          return reject(new Error(`blofin api error ${parsed.code}: ${parsed.msg || 'unknown'}${nested.slice(0, 300)}`));
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

// ─── Public market data (no auth) ────────────────────────────────────────────
//
// PROBED 2026-09-06 against demo-trading-openapi.blofin.com, en0-bound, before
// any of these were written — per the project rule that BloFin's docs are wrong
// until a probe says otherwise. Recorded verdicts:
//
//   path      `tickers` and `books` are PLURAL. Singular `/market/ticker` and
//             `/market/book` both return the Cloudflare landing page, not 152404,
//             so a wrong path here is indistinguishable from the VPN-egress 403 —
//             check the path before blaming the network.
//   shape     every one of these returns an ARRAY in `data`, even for a single
//             instId. Callers below unwrap to the first row.
//   fields    ticker is `bidPrice`/`askPrice`/`bidSize`/`askSize`/`last`/`ts` —
//             NOT OKX's `bidPx`/`askPx`, which is the vocabulary the docs' OKX
//             lineage suggests.
//   book      levels are 2-tuples `[price, size]`, NOT OKX's 4-tuple
//             `[price, size, liquidated, orders]`.
//
// Verbatim probe responses (BTC-USDT, demo, 2026-09-06T18:02Z):
//   tickers      {"instId":"BTC-USDT","last":"79718.4","askPrice":"79731",
//                 "bidPrice":"79730.8","high24h":...,"vol24h":...,"ts":"1788717722107"}
//   books&size=5 {"asks":[["79731","1940000000000"],...],
//                 "bids":[["79730.8","4000000000"],...],"ts":"1788717760928"}
//   mark-price   {"instId":"BTC-USDT","indexPrice":"79766.7","markPrice":"79731.1","ts":...}
//   funding-rate {"instId":"BTC-USDT","fundingRate":"0.000038104468186336",
//                 "fundingTime":"1788739200000","fundingInterval":"8"}

/** Best bid/ask + 24h stats for one instrument. Returns the single row, not the array. */
async function getTicker(instId) {
  const rows = await _request('GET', '/api/v1/market/tickers', { query: { instId }, signed: false });
  return (Array.isArray(rows) ? rows : [])[0] || null;
}

/**
 * L2 order book. `size` is levels per side (5 is plenty for a spread read).
 * Returns `{ asks, bids, ts }` where each level is `[price, size]`.
 */
async function getOrderBook(instId, size = 5) {
  const rows = await _request('GET', '/api/v1/market/books', { query: { instId, size }, signed: false });
  return (Array.isArray(rows) ? rows : [])[0] || null;
}

/**
 * Mark and index price. Worth reading separately from the ticker's `last`:
 * every SL this project places uses `slTriggerPriceType: 'mark'`, so mark — not
 * last — is the price that decides whether a stop fires.
 */
async function getMarkPrice(instId) {
  const rows = await _request('GET', '/api/v1/market/mark-price', { query: { instId }, signed: false });
  return (Array.isArray(rows) ? rows : [])[0] || null;
}

/**
 * Current funding rate and its interval. Recorded because BloFin's funding is
 * NOT Binance's: the carry research measured 6.22%/yr here against 11.67%/yr on
 * Binance, ~13pp apart and at one point opposite in sign. Never reuse Binance's
 * number for a BloFin position.
 */
async function getFundingRate(instId) {
  const rows = await _request('GET', '/api/v1/market/funding-rate', { query: { instId }, signed: false });
  return (Array.isArray(rows) ? rows : [])[0] || null;
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
  clientOrderId,
}) {
  const body = {
    instId, marginMode, side, positionSide, orderType,
    size: String(size),
  };
  if (price !== undefined)                  body.price = String(price);
  if (reduceOnly !== undefined)             body.reduceOnly = reduceOnly;
  if (stopLossTriggerPrice !== undefined)   body.stopLossTriggerPrice = String(stopLossTriggerPrice);
  if (takeProfitTriggerPrice !== undefined) body.takeProfitTriggerPrice = String(takeProfitTriggerPrice);
  // BloFin's field is `clientOrderId` (full "Order"), NOT the docs' `clientOrdId`.
  // Probed 2026-06-24: sending `clientOrdId` is silently ignored and the order
  // comes back with an empty clientOrderId. See the "docs are wrong" table.
  if (clientOrderId !== undefined)          body.clientOrderId = clientOrderId;
  return _request('POST', '/api/v1/trade/order', { body });
}

/** Cancel a single order by id. */
async function cancelOrder(orderId, instId) {
  const body = { orderId };
  if (instId) body.instId = instId;
  return _request('POST', '/api/v1/trade/cancel-order', { body });
}

/** List open/pending orders. `state` and `instId` are optional filters. */
/**
 * Cursor-paginated: a single orders-pending request returns ONE page
 * (default 20). With a stacked-ladder book the unpaginated read silently
 * truncated — live rungs fell off the page and recon falsely cancelled them
 * (2026-07-04, 4 corrupted docs + E11000 loop). Loops via `after` cursor,
 * dedupes defensively, and bails on no-progress so an API that ignores the
 * params degrades to the old single-page behavior instead of spinning.
 */
async function getActiveOrders({ instId, orderType, pageSize = 100 } = {}) {
  const out = [];
  const seen = new Set();
  let after;
  for (let page = 0; page < 10; page++) {
    const batch = await _request('GET', '/api/v1/trade/orders-pending', {
      query: { instId, orderType, limit: pageSize, after },
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    let added = 0;
    for (const o of batch) {
      const id = String(o.orderId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(o);
      added++;
    }
    if (added === 0 || batch.length < pageSize) break;
    after = batch[batch.length - 1].orderId;
  }
  return out;
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

/**
 * Order history (filled/cancelled orders — NOT resting). Unlike fills-history,
 * order records DO carry `clientOrderId`, so this is how a market entry that
 * filled-on-timeout is resolved by its deterministic clientOrderId. Resting
 * orders use getActiveOrders (orders-pending); this covers everything else.
 */
async function getOrderHistory({ instId, orderId, clientOrderId, after, before, limit } = {}) {
  return _request('GET', '/api/v1/trade/orders-history', {
    query: { instId, orderId, clientOrderId, after, before, limit },
  });
}

// ─── Conditional TP/SL orders (Phase B.6 — standalone, position-level) ───────
//
// IMPORTANT: BloFin's "attached" stopLossTriggerPrice on entry orders does NOT
// persist across position changes in net mode — it gets cancelled when TP
// rungs fill and shrink the position. Use these standalone endpoints instead
// for any SL/TP that must outlive partial closes.
//
// Field names use TPSL endpoint vocabulary (slTriggerPrice, etc.), NOT the
// attached-field vocab (stopLossTriggerPrice). Confirmed by API probe.

/**
 * Place a standalone conditional TP/SL order. Survives partial position
 * closes — independent of the entry order's lifecycle.
 *
 * For a SHORT position: side='buy', size=position, slTriggerPrice > entry
 * For a LONG position:  side='sell', size=position, slTriggerPrice < entry
 *
 * slOrderPrice='-1' means market-on-trigger (industry default for SL).
 * slTriggerPriceType='mark' resists wicks (industry default for futures).
 *
 * Returns `{ tpslId, clientOrderId }`.
 */
async function placeTPSL({
  instId,
  side,                              // close-side: 'buy' for short, 'sell' for long
  size,                              // contracts
  marginMode = 'isolated',
  positionSide = 'net',
  reduceOnly = true,                 // string 'true' per BloFin contract
  slTriggerPrice,
  slOrderPrice = '-1',               // -1 = market on trigger
  slTriggerPriceType = 'mark',       // 'mark' | 'last' | 'index'
  tpTriggerPrice,                    // optional — attach TP alongside SL in the same order
  tpOrderPrice = '-1',
  tpTriggerPriceType = 'mark',
}) {
  const body = {
    instId, marginMode, positionSide, side,
    size: String(size),
    reduceOnly: String(reduceOnly),
  };
  if (slTriggerPrice !== undefined) {
    body.slTriggerPrice = String(slTriggerPrice);
    body.slOrderPrice = String(slOrderPrice);
    body.slTriggerPriceType = slTriggerPriceType;
  }
  if (tpTriggerPrice !== undefined) {
    body.tpTriggerPrice = String(tpTriggerPrice);
    body.tpOrderPrice = String(tpOrderPrice);
    body.tpTriggerPriceType = tpTriggerPriceType;
  }
  return _request('POST', '/api/v1/trade/order-tpsl', { body });
}

/**
 * Read all pending TP/SL conditional orders. Cursor-paginated for the same
 * reason as getActiveOrders — one page truncates a fat book (latent today
 * at ~11 SLs, breaks at scale).
 */
async function getPendingTPSL({ instId, pageSize = 100 } = {}) {
  const out = [];
  const seen = new Set();
  let after;
  for (let page = 0; page < 10; page++) {
    const batch = await _request('GET', '/api/v1/trade/orders-tpsl-pending', {
      query: { instId, limit: pageSize, after },
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    let added = 0;
    for (const o of batch) {
      const id = String(o.tpslId ?? o.orderId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(o);
      added++;
    }
    if (added === 0 || batch.length < pageSize) break;
    after = batch[batch.length - 1].tpslId ?? batch[batch.length - 1].orderId;
  }
  return out;
}

/**
 * Cancel one or more TP/SL conditional orders. Body is an ARRAY of
 * {instId, tpslId} (BloFin's quirk — single-object body returns 152004).
 */
async function cancelTPSL(items) {
  const arr = Array.isArray(items) ? items : [items];
  return _request('POST', '/api/v1/trade/cancel-tpsl', { body: arr });
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
  getTicker,
  getOrderBook,
  getMarkPrice,
  getFundingRate,
  getBalance,
  getPositions,
  setPositionMode,
  setLeverage,
  placeOrder,
  cancelOrder,
  getActiveOrders,
  getTradeHistory,
  getOrderHistory,
  placeTPSL,
  getPendingTPSL,
  cancelTPSL,
  applyDemoMoney,
};
