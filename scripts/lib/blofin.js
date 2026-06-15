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
  const qs = query
    ? '?' + Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
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

module.exports = {
  baseUrl,
  isDemo,
  sign,
  getInstruments,
  getBalance,
  getPositions,
};
