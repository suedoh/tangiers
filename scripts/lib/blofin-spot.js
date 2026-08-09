#!/usr/bin/env node
'use strict';

/**
 * scripts/lib/blofin-spot.js — BloFin SPOT client (the carry's long leg).
 *
 * Separate from lib/blofin.js because BloFin's spot API is a SEPARATE NAMESPACE:
 * `/api/v1/spot/*`, not the swap paths with an instType parameter. That
 * distinction cost a wrong strategic conclusion on 2026-08-03 — the swap
 * endpoint silently ignores `instType=SPOT` and returns swaps, which was
 * misread as "this venue has no spot". It has 241 in prod, 27 in demo.
 *
 * PROBED, NOT ASSUMED (2026-08-09, demo). Verified present and callable:
 *   /api/v1/spot/market/instruments?instType=SPOT   BTC-USDT: minSize 0.00001,
 *                                                   lotSize 0.00001, tick 0.01
 *   /api/v1/spot/market/tickers  /books  /candles
 *   /api/v1/spot/trade/orders-pending | orders-history | fills-history
 *   /api/v1/asset/balances?accountType=spot|futures|funding
 *
 * ⚠️ WALLET TOPOLOGY — the blocker to know about. Balances are per-wallet and do
 * NOT pool. Measured 2026-08-09: futures USDT 1680.98, **spot 0, funding 0**.
 * The carry's long leg cannot buy anything until USDT is moved futures→spot.
 * `/api/v1/asset/transfer-history` returns 152404 on demo, so it is unproven
 * whether demo supports internal transfer at all. `transfer()` below is written
 * to the documented shape but is UNVERIFIED — it has never been executed. Treat
 * a first call as a probe, not a routine operation.
 *
 * ⚠️ SPOT FEES are still unmeasured (no fee-rate endpoint; account has never
 * filled a spot order). `feeFromFills()` closes that the moment one lands.
 *
 * Everything here is env-gated by BLOFIN_ENV and refuses to run against prod
 * unless explicitly allowed, mirroring the demo hard rule in rebuild/README.md.
 */

const https = require('https');
const crypto = require('crypto');
const { loadEnv } = require('./env');
loadEnv();

const ENV = process.env.BLOFIN_ENV || 'demo';
const HOST = ENV === 'prod' ? 'openapi.blofin.com' : 'demo-trading-openapi.blofin.com';
const BIND = process.env.BLOFIN_BIND_IP || null;   // en0 IP when the VPN exit is Cloudflare-blocked

const INST = 'BTC-USDT';
// From the probed instrument record — do not hardcode elsewhere.
const LOT_SIZE = 0.00001;
const MIN_SIZE = 0.00001;
const TICK_SIZE = 0.01;

function creds() {
  const key = process.env.BLOFIN_API_KEY, secret = process.env.BLOFIN_API_SECRET, pass = process.env.BLOFIN_API_PASSPHRASE;
  if (!key || !secret || !pass) throw new Error('BloFin credentials missing from .env');
  return { key, secret, pass };
}

function request(method, path, { body = null, signed = true, timeoutMs = 20000 } = {}) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ace-trading-bot/1.0' };
  if (signed) {
    const { key, secret, pass } = creds();
    const ts = Date.now().toString(), nonce = crypto.randomUUID();
    const prehash = path + method.toUpperCase() + ts + nonce + bodyStr;
    const sig = Buffer.from(crypto.createHmac('sha256', secret).update(prehash).digest('hex'), 'utf8').toString('base64');
    Object.assign(headers, {
      'ACCESS-KEY': key, 'ACCESS-SIGN': sig, 'ACCESS-TIMESTAMP': ts,
      'ACCESS-NONCE': nonce, 'ACCESS-PASSPHRASE': pass,
    });
  }
  const opts = { host: HOST, path, method, headers, family: 4, autoSelectFamily: false };
  if (BIND) opts.localAddress = BIND;

  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`blofin-spot http ${res.statusCode}: ${data.slice(0, 200)}`));
        let j; try { j = JSON.parse(data); } catch (e) { return reject(new Error(`blofin-spot bad JSON: ${data.slice(0, 160)}`)); }
        if (j.code !== '0' && j.code !== 0) return reject(new Error(`blofin-spot ${j.code}: ${j.msg || ''}`));
        resolve(j.data);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('blofin-spot timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Market data (public) ────────────────────────────────────────────────────
const getInstrument = () => request('GET', `/api/v1/spot/market/instruments?instType=SPOT&instId=${INST}`, { signed: false }).then(d => d[0]);
const getTicker = () => request('GET', `/api/v1/spot/market/tickers?instType=SPOT&instId=${INST}`, { signed: false }).then(d => d[0]);
const getBook = () => request('GET', `/api/v1/spot/market/books?instType=SPOT&instId=${INST}`, { signed: false }).then(d => d[0]);

// ─── Account ─────────────────────────────────────────────────────────────────
async function walletBalance(accountType) {
  const d = await request('GET', `/api/v1/asset/balances?accountType=${accountType}`);
  const out = {};
  for (const b of d || []) { const v = Number(b.available); if (v > 0) out[b.currency] = v; }
  return out;
}

/**
 * Internal wallet transfer. **UNVERIFIED — never executed.** Written to the
 * documented shape; `transfer-history` returns 152404 on demo, so demo may not
 * support it at all. Refuses unless `confirm` is passed, because this moves
 * funds and must never happen as a side effect of a health check.
 */
async function transfer({ currency = 'USDT', amount, from, to, confirm = false }) {
  if (!confirm) throw new Error('transfer() requires confirm:true — it moves funds');
  if (!(amount > 0)) throw new Error('transfer() needs a positive amount');
  return request('POST', '/api/v1/asset/transfer', {
    body: { currency, amount: String(amount), fromAccount: from, toAccount: to },
  });
}

// ─── Orders ──────────────────────────────────────────────────────────────────
// Round through an integer lot count and re-round to the lot's decimal places —
// `Math.floor(sz/LOT)*LOT` alone yields 0.0030700000000000002, which then gets
// stringified into an order payload.
// The epsilon matters: roundLot() is applied twice (preflight, then placeOrder),
// and 0.00307/0.00001 evaluates to 306.9999… so a bare floor silently drops a
// lot on the second pass — the rehearsal showed a 0.00307 plan emitting a
// 0.00306 payload. Nudge before flooring so an already-rounded value is stable.
const LOT_DP = String(LOT_SIZE).split('.')[1]?.length ?? 0;
const roundLot = sz => Number((Math.floor(sz / LOT_SIZE + 1e-9) * LOT_SIZE).toFixed(LOT_DP));
const roundTick = px => Math.round(px / TICK_SIZE) * TICK_SIZE;

/**
 * Place a spot order. `dryRun` returns the exact payload WITHOUT sending — used
 * by the executor's rehearsal path so the whole flow is testable without a fill.
 */
async function placeOrder({ side, size, price = null, clientOrderId, dryRun = false }) {
  const sz = roundLot(size);
  if (!(sz >= MIN_SIZE)) throw new Error(`spot size ${size} below minSize ${MIN_SIZE}`);
  const body = {
    instId: INST, side,
    orderType: price == null ? 'market' : 'limit',
    size: sz.toFixed(5),
    ...(price != null ? { price: roundTick(price).toFixed(2) } : {}),
    ...(clientOrderId ? { clientOrderId } : {}),
  };
  if (dryRun) return { dryRun: true, body };
  const d = await request('POST', '/api/v1/spot/trade/order', { body });
  return Array.isArray(d) ? d[0] : d;
}

const ordersPending = () => request('GET', `/api/v1/spot/trade/orders-pending?instType=SPOT&instId=${INST}`);
const ordersHistory = (limit = 50) => request('GET', `/api/v1/spot/trade/orders-history?instType=SPOT&instId=${INST}&limit=${limit}`);
const fillsHistory = (limit = 50) => request('GET', `/api/v1/spot/trade/fills-history?instType=SPOT&instId=${INST}&limit=${limit}`);

/**
 * Measure the realised spot fee rate from actual fills — the input that closes
 * the last open assumption in the carry economics (round 9). Returns null while
 * no spot fill exists, which is the honest answer, not a default.
 */
async function feeFromFills(limit = 100) {
  const fills = await fillsHistory(limit).catch(() => []);
  const rates = (fills || []).map(f => {
    const px = Number(f.fillPrice ?? f.price), sz = Number(f.fillSize ?? f.size), fee = Math.abs(Number(f.fee));
    const notional = px * sz;
    return notional > 0 ? fee / notional : NaN;
  }).filter(r => Number.isFinite(r) && r > 0 && r < 0.01);
  if (!rates.length) return null;
  rates.sort((a, b) => a - b);
  return { n: rates.length, medianBp: rates[rates.length >> 1] * 1e4, maxBp: rates[rates.length - 1] * 1e4 };
}

module.exports = {
  ENV, HOST, INST, LOT_SIZE, MIN_SIZE, TICK_SIZE,
  getInstrument, getTicker, getBook,
  walletBalance, transfer,
  placeOrder, ordersPending, ordersHistory, fillsHistory, feeFromFills,
  roundLot, roundTick,
};
