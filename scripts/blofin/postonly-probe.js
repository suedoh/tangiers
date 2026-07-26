#!/usr/bin/env node
'use strict';

/**
 * Spec 08.3 probe — `post_only` maker entries on BloFin. NEVER exercised
 * before; the docs-vs-truth table (CLAUDE.md) is exactly why this exists.
 * A maker entry would halve entry cost (6bp→2bp), but only if the exchange's
 * actual post-only semantics are safe. Three questions, answered empirically:
 *
 *   [1] RESTS?     Far-from-touch post-only limit (buy 10% below mark) —
 *                  must appear on orders-pending in state live.
 *   [2] CROSSING?  Post-only limit that crosses the book (buy 5% above
 *                  mark) — document ACTUAL behavior:
 *                    a. API rejects at placement (clean — best case)
 *                    b. accepted then exchange-cancelled (fine — detectable)
 *                    c. SILENT TAKER FILL (dangerous — post-only is a lie;
 *                       maker-entry mode must NOT be built on it). The probe
 *                       flattens the accidental position immediately.
 *   [3] CANCEL?    Standard cancel path works on a resting post-only order.
 *
 * The probe also tries the field-variant fallback: if orderType:'post_only'
 * is rejected as an invalid enum, it retries orderType:'limit' with
 * postOnly-style flags and reports which (if any) the server accepts.
 *
 * Only after this probe documents actual behavior may a maker-entry mode be
 * designed — and then only as its own spec-07 candidate variant (a resting
 * entry changes fill probability, which changes measured edge).
 *
 * PLACES REAL DEMO ORDERS (small: 0.1 contracts ≈ $10 notional).
 * Refuses without --confirm. Refuses when BLOFIN_ENV=prod.
 * ** PENDING MARGIN UNLOCK as of 2026-07-26 — do not run while the live
 * book must not change; a crossing post-only could take liquidity. **
 *
 * Usage:  node scripts/blofin/postonly-probe.js --confirm
 *    or:  make blofin-postonly-probe   (prints this gate unless CONFIRM=1)
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');

const SYMBOL = 'BTC-USDT';
const SIZE   = '0.1';   // minSize
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

const q = p => Math.floor(p * 10) / 10;

const findings = [];
function record(finding) {
  findings.push(finding);
  console.log('  →', finding);
}

// Direct passthrough — deliberately NOT via lib/blofin.placeOrder, so the
// probe controls the exact orderType string the server sees.
async function placeRaw(body) {
  const https = require('https');
  const crypto = require('crypto');
  const path = '/api/v1/trade/order';
  const bodyStr = JSON.stringify(body);
  const ts = Date.now().toString();
  const nonce = crypto.randomUUID();
  const prehash = path + 'POST' + ts + nonce + bodyStr;
  const hex = crypto.createHmac('sha256', process.env.BLOFIN_API_SECRET).update(prehash).digest('hex');
  const sig = Buffer.from(hex, 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(blofin.baseUrl() + path, {
      method: 'POST', family: 4, autoSelectFamily: false,
      headers: {
        'Content-Type': 'application/json',
        'ACCESS-KEY': process.env.BLOFIN_API_KEY,
        'ACCESS-SIGN': sig, 'ACCESS-TIMESTAMP': ts, 'ACCESS-NONCE': nonce,
        'ACCESS-PASSPHRASE': process.env.BLOFIN_API_PASSPHRASE,
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr); req.end();
  });
}

async function flattenAny() {
  try {
    const positions = await blofin.getPositions(SYMBOL);
    for (const p of positions || []) {
      const sz = Math.abs(Number(p.positions || p.pos || 0));
      if (sz > 0) {
        console.log(`  !! flattening accidental position of ${sz} contracts`);
        await blofin.placeOrder({
          instId: SYMBOL, side: Number(p.positions || p.pos) > 0 ? 'sell' : 'buy',
          orderType: 'market', size: String(sz),
          marginMode: 'isolated', positionSide: 'net', reduceOnly: true,
        });
      }
    }
  } catch (e) { console.log('  (flatten check failed:', e.message, ')'); }
}

async function cancelIfResting(orderId) {
  try { await blofin.cancelOrder(orderId, SYMBOL); } catch (_) {}
}

async function main() {
  if (!blofin.isDemo()) {
    console.error('Refusing to run: BLOFIN_ENV=prod. Probe is demo-only.');
    process.exit(1);
  }
  if (!process.argv.includes('--confirm') && process.env.CONFIRM !== '1') {
    console.log('─── BloFin postonly-probe — NOT RUN ───');
    console.log('This probe PLACES REAL DEMO ORDERS (post-only rest/cross/cancel).');
    console.log('** PENDING MARGIN UNLOCK (2026-07-26): the demo account is margin-locked');
    console.log('   by the live 238-contract position and the operator is deciding its');
    console.log('   fate — the book must not change. Run only after spec 01 resolves. **');
    console.log('');
    console.log('Run with:  node scripts/blofin/postonly-probe.js --confirm');
    process.exit(2);
  }

  console.log('─── BloFin postonly-probe ───');
  const mark = await getMarkPrice();
  console.log('mark:', mark);

  const results = { restProbe: null, crossProbe: null, cancelProbe: null };

  // ── [1] Far-from-touch post-only must REST ────────────────────────────────
  console.log('[1] post_only buy 10% below mark (must rest)…');
  const restPx = q(mark * 0.90);
  let restOrderId = null;
  const restRes = await placeRaw({
    instId: SYMBOL, marginMode: 'isolated', positionSide: 'net',
    side: 'buy', orderType: 'post_only', price: String(restPx), size: SIZE,
  });
  if (String(restRes.code) !== '0') {
    record(`orderType:'post_only' REJECTED at placement: code ${restRes.code} "${restRes.msg}" — post-only enum not accepted; maker-entry mode has no primitive to build on (or a different field spells it — extend probe)`);
    results.restProbe = 'enum-rejected';
  } else {
    const data = Array.isArray(restRes.data) ? restRes.data[0] : restRes.data;
    restOrderId = data?.orderId;
    await sleep(1200);
    const pending = await blofin.getActiveOrders({ instId: SYMBOL });
    const resting = (pending || []).find(o => String(o.orderId) === String(restOrderId));
    if (resting) {
      record(`far-from-touch post_only RESTS (orderId ${restOrderId}, state ${resting.state}, orderType "${resting.orderType}")`);
      results.restProbe = 'rests';
    } else {
      const hist = await blofin.getOrderHistory({ instId: SYMBOL, orderId: restOrderId, limit: 5 });
      const h = (hist || [])[0];
      record(`far-from-touch post_only did NOT rest — orders-history state: ${h?.state ?? 'not found'} — document before any reliance`);
      results.restProbe = `no-rest:${h?.state ?? 'unknown'}`;
    }
  }

  // ── [3] Cancel path on the resting order ──────────────────────────────────
  if (results.restProbe === 'rests') {
    console.log('[3] cancel the resting post-only order…');
    await blofin.cancelOrder(restOrderId, SYMBOL);
    await sleep(1000);
    const stillPending = await blofin.getActiveOrders({ instId: SYMBOL });
    const gone = !(stillPending || []).some(o => String(o.orderId) === String(restOrderId));
    record(gone ? 'cancel path works — order gone from orders-pending'
                : 'cancel accepted but order STILL PENDING — investigate before reliance');
    results.cancelProbe = gone ? 'works' : 'suspect';
  } else if (restOrderId) {
    await cancelIfResting(restOrderId);
  }

  // ── [2] CROSSING post-only — the dangerous case ───────────────────────────
  if (results.restProbe === 'rests') {
    console.log('[2] post_only buy 5% ABOVE mark (crosses the book)…');
    const crossPx = q(mark * 1.05);
    const crossRes = await placeRaw({
      instId: SYMBOL, marginMode: 'isolated', positionSide: 'net',
      side: 'buy', orderType: 'post_only', price: String(crossPx), size: SIZE,
    });
    if (String(crossRes.code) !== '0') {
      record(`crossing post_only REJECTED at placement: code ${crossRes.code} "${crossRes.msg}" — SAFE (case a)`);
      results.crossProbe = 'rejected';
    } else {
      const data = Array.isArray(crossRes.data) ? crossRes.data[0] : crossRes.data;
      const crossId = data?.orderId;
      await sleep(1500);
      const pending2 = await blofin.getActiveOrders({ instId: SYMBOL });
      const stillLive = (pending2 || []).find(o => String(o.orderId) === String(crossId));
      const hist2 = await blofin.getOrderHistory({ instId: SYMBOL, orderId: crossId, limit: 5 });
      const h2 = (hist2 || [])[0];
      const state = stillLive?.state ?? h2?.state ?? 'unknown';
      const filled = Number(h2?.filledSize ?? stillLive?.filledSize ?? 0);
      if (filled > 0) {
        record(`crossing post_only SILENTLY TOOK LIQUIDITY — state ${state}, filled ${filled} @ ${h2?.averagePrice} — DANGEROUS (case c): post-only is NOT honored; do NOT build maker-entry on this`);
        results.crossProbe = 'silent-taker';
        await flattenAny();
      } else if (String(state).toLowerCase() === 'canceled' || String(state).toLowerCase() === 'cancelled') {
        record(`crossing post_only accepted then exchange-CANCELLED (case b) — safe but placement success ≠ resting; verify-resting step required in any maker-entry mode`);
        results.crossProbe = 'accepted-then-cancelled';
      } else {
        record(`crossing post_only in unexpected state "${state}" (no fill) — cancelling defensively; document before reliance`);
        results.crossProbe = `unexpected:${state}`;
        await cancelIfResting(crossId);
      }
    }
  } else {
    console.log('[2] skipped — no resting primitive confirmed in [1]');
  }

  await flattenAny();

  console.log('');
  console.log('─── postonly-probe findings ───');
  findings.forEach(f => console.log('•', f));
  console.log('');
  console.log('verdict:', JSON.stringify(results));
  console.log('Paste this block into refactors/ before any maker-entry code exists (spec 08 acceptance 4).');
}

main().catch(async e => {
  console.error('FAIL:', e.message);
  await flattenAny();
  process.exit(1);
});
