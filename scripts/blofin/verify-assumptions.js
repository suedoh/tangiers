#!/usr/bin/env node
'use strict';

/**
 * scripts/blofin/verify-assumptions.js — Phase 0: close the inputs every
 * economic conclusion rests on. READ-ONLY. Places no orders, ever.
 *
 * Why this exists. The 2026-08-04 self-audit found that a single wrong inference
 * ("BloFin has no spot", drawn from one endpoint's response) had propagated into
 * a strategic conclusion. The same class of unverified assumption sits under the
 * numbers: **6bp taker / 2bp maker** was measured once, in the 2026-07-26 audit,
 * and has been carried through 292 research cells since without re-check. BloFin
 * exposes no fee-rate endpoint (every variant returns 152404), so the only honest
 * source is the account's own realised fills.
 *
 * Checks:
 *   1. PERP FEES from real fills — fee ÷ notional, split maker/taker. This is the
 *      number that sets every break-even in the research log.
 *   2. DEMO vs PROD funding — the carry engine reads demo; if demo funding is
 *      synthetic or clamped, its gate is measuring a fiction.
 *   3. SPOT FEES — cannot be measured without a spot fill, and this script will
 *      not place one. Reports the gap and what closes it.
 *
 * Egress note: binds to the en0 address when BLOFIN_BIND_IP is set, because the
 * host's default route runs through a VPN whose exit Cloudflare blocks (403).
 * See reference: the VPN regression of 2026-08-03.
 *
 * Usage: node scripts/blofin/verify-assumptions.js [--bind 172.18.7.153]
 */

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BIND = arg('bind', process.env.BLOFIN_BIND_IP || null);
const ENV = process.env.BLOFIN_ENV || 'demo';
const HOST_DEMO = 'demo-trading-openapi.blofin.com';
const HOST_PROD = 'openapi.blofin.com';
const HOST = ENV === 'prod' ? HOST_PROD : HOST_DEMO;

function req(host, p, signed = false) {
  const opts = { host, path: p, method: 'GET', family: 4, headers: { 'Content-Type': 'application/json', 'User-Agent': 'ace-verify/1.0' } };
  if (BIND) opts.localAddress = BIND;
  if (signed) {
    const ts = Date.now().toString(), nonce = crypto.randomUUID();
    const sig = Buffer.from(crypto.createHmac('sha256', process.env.BLOFIN_API_SECRET).update(p + 'GET' + ts + nonce).digest('hex'), 'utf8').toString('base64');
    Object.assign(opts.headers, {
      'ACCESS-KEY': process.env.BLOFIN_API_KEY, 'ACCESS-SIGN': sig,
      'ACCESS-TIMESTAMP': ts, 'ACCESS-NONCE': nonce, 'ACCESS-PASSPHRASE': process.env.BLOFIN_API_PASSPHRASE,
    });
  }
  return new Promise(res => {
    const r = https.request(opts, x => { let d = ''; x.on('data', c => (d += c)); x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ code: 'parse', raw: d.slice(0, 160) }); } }); });
    r.on('error', e => res({ code: 'err', msg: e.message }));
    r.setTimeout(25000, () => { r.destroy(); res({ code: 'timeout' }); });
    r.end();
  });
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

(async () => {
  console.log(`═══ PHASE 0 — VERIFY THE ASSUMPTIONS ═══   env=${ENV}  bind=${BIND || 'default route'}\n`);

  // ── 1. PERP FEES FROM REAL FILLS ──────────────────────────────────────────
  console.log('1. PERP FEES — measured from the account\'s own realised fills');
  let fills = [];
  for (let page = 0, before = null; page < 12; page++) {
    const p = `/api/v1/trade/fills-history?instId=BTC-USDT&limit=100` + (before ? `&before=${before}` : '');
    const j = await req(HOST, p, true);
    const d = Array.isArray(j.data) ? j.data : [];
    if (!d.length) break;
    fills.push(...d);
    const ids = d.map(x => Number(x.billId || x.tradeId || 0)).filter(Boolean);
    if (!ids.length) break;
    before = Math.min(...ids);
    if (d.length < 100) break;
    await new Promise(r => setTimeout(r, 120));
  }
  if (!fills.length) {
    console.log('   no fills returned — cannot verify. (403 through the VPN? pass --bind <en0 ip>)');
  } else {
    const rows = fills.map(f => {
      const px = Number(f.fillPrice ?? f.price), sz = Number(f.fillSize ?? f.size);
      const fee = Math.abs(Number(f.fee));
      const cv = 0.001;                                   // BTC-USDT contractValue
      const notional = px * sz * cv;
      return { rate: notional > 0 ? fee / notional : NaN, liq: (f.liquidity || f.execType || '').toLowerCase(), notional, ts: Number(f.ts) };
    }).filter(r => Number.isFinite(r.rate) && r.rate > 0 && r.rate < 0.01);
    const takerR = rows.filter(r => /t|taker/.test(r.liq)).map(r => r.rate);
    const makerR = rows.filter(r => /m|maker/.test(r.liq)).map(r => r.rate);
    console.log(`   fills analysed: ${rows.length}  (${new Date(Math.min(...rows.map(r => r.ts))).toISOString().slice(0,10)} → ${new Date(Math.max(...rows.map(r => r.ts))).toISOString().slice(0,10)})`);
    console.log(`   ALL fills      median ${(med(rows.map(r => r.rate)) * 1e4).toFixed(2)}bp   mean ${(mean(rows.map(r => r.rate)) * 1e4).toFixed(2)}bp`);
    if (takerR.length) console.log(`   taker (n=${takerR.length})   median ${(med(takerR) * 1e4).toFixed(2)}bp   ASSUMED 6.00bp`);
    if (makerR.length) console.log(`   maker (n=${makerR.length})   median ${(med(makerR) * 1e4).toFixed(2)}bp   ASSUMED 2.00bp`);
    const overall = med(rows.map(r => r.rate)) * 1e4;
    console.log(`   → ${Math.abs(overall - 6) < 1.2 ? '✅ consistent with the 6bp taker assumption'
      : '⚠️  DIVERGES from the assumption — every break-even in the research log shifts'}`);
  }

  // ── 2. DEMO vs PROD FUNDING ───────────────────────────────────────────────
  console.log('\n2. FUNDING FIDELITY — the carry engine gates on demo; is demo real?');
  const [dj, pj] = await Promise.all([
    req(HOST_DEMO, '/api/v1/market/funding-rate-history?instId=BTC-USDT&limit=100'),
    req(HOST_PROD, '/api/v1/market/funding-rate-history?instId=BTC-USDT&limit=100'),
  ]);
  const dmap = new Map((dj.data || []).map(x => [Number(x.fundingTime), Number(x.fundingRate)]));
  const pmap = new Map((pj.data || []).map(x => [Number(x.fundingTime), Number(x.fundingRate)]));
  const shared = [...dmap.keys()].filter(t => pmap.has(t));
  if (shared.length < 5) {
    console.log(`   only ${shared.length} shared settlements — inconclusive`);
  } else {
    const diffs = shared.map(t => Math.abs(dmap.get(t) - pmap.get(t)));
    const identical = diffs.filter(d => d < 1e-9).length;
    const dv = shared.map(t => dmap.get(t)), pv = shared.map(t => pmap.get(t));
    console.log(`   shared settlements: ${shared.length}`);
    console.log(`   demo  mean ${(mean(dv) * 1e4).toFixed(3)}bp   distinct values ${new Set(dv).size}`);
    console.log(`   prod  mean ${(mean(pv) * 1e4).toFixed(3)}bp   distinct values ${new Set(pv).size}`);
    console.log(`   identical rates: ${identical}/${shared.length}   max |Δ| ${(Math.max(...diffs) * 1e4).toFixed(3)}bp`);
    console.log(`   → ${identical / shared.length > 0.95 ? '✅ demo mirrors prod — gating on demo is sound'
      : new Set(dv).size <= 2 ? '🚨 demo funding is CLAMPED/synthetic — the engine must read PROD'
      : '⚠️  demo and prod differ — engine should read prod for the gate'}`);
  }

  // ── 3. SPOT FEES ──────────────────────────────────────────────────────────
  console.log('\n3. SPOT FEES — the open input');
  const spotFills = await req(HOST, '/api/v1/spot/trade/fills-history?instId=BTC-USDT&limit=100', true);
  const sf = Array.isArray(spotFills.data) ? spotFills.data : [];
  if (sf.length) {
    const rates = sf.map(f => Math.abs(Number(f.fee)) / (Number(f.fillPrice ?? f.price) * Number(f.fillSize ?? f.size))).filter(r => Number.isFinite(r) && r > 0);
    console.log(`   spot fills found: ${rates.length}  median ${(med(rates) * 1e4).toFixed(2)}bp`);
  } else {
    console.log(`   no spot fills in history (code=${spotFills.code}) — the account has never traded spot.`);
    console.log('   This CANNOT be closed read-only, and this script will not place an order.');
    console.log('   It closes itself the first time the carry engine fills a spot leg: the engine');
    console.log('   records the realised rate and the assumption is replaced by a measurement.');
    console.log('   Until then the honest range is:');
    console.log('     spot 2bp  → carry +4.80%/yr, CI [1.5, 7.8]   (assumption)');
    console.log('     spot 10bp → carry +3.03%/yr, CI [-0.3, 6.1]  (CI includes zero)');
  }

  console.log('\n═══ Nothing above placed an order. ═══');
})().catch(e => { console.error('verify-assumptions failed:', e.message); process.exit(1); });
