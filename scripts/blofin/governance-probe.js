#!/usr/bin/env node
'use strict';

/**
 * Spec 02 governance probe — same-direction book cap, fail-safe position
 * read, aggregate margin cap, skip alerting.
 *
 * Three modes (least to most invasive):
 *
 *   (default)      MOCKED — no exchange, no Mongo, no Discord. Exchange
 *                  reads are stubbed per scenario; every order-placement
 *                  primitive is stubbed to throw, so a governance bug that
 *                  reaches the money path fails the probe instead of
 *                  placing anything. Runs anywhere, safe during the
 *                  margin-locked live book.
 *
 *   --live-reads   Real getPositions/getBalance READS against demo; all
 *                  writes still stubbed to throw; Discord captured, not
 *                  posted. Documents what the guards decide on the REAL
 *                  book (incl. bad-instId read behavior — docs-vs-truth).
 *
 *   --live         FULL exchange exercise per spec 02 acceptance check 1:
 *                  places a small real long, fires synthetic same/opposite
 *                  signals, trips MARGIN_CAP_PCT=1, verifies the Discord
 *                  alert, cleans up. PLACES REAL DEMO ORDERS — do not run
 *                  while the operator's live book must not change.
 *                  ** PENDING MARGIN UNLOCK as of 2026-07-26. **
 *
 * Refuses to run outside BLOFIN_ENV=demo in any mode that touches the API.
 *
 * Usage:  make blofin-governance-probe          (mocked)
 *    or:  node scripts/blofin/governance-probe.js [--live-reads | --live]
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const fs      = require('fs');
const blofin  = require('../lib/blofin');
const store   = require('../lib/blofin-store');
const dailyR  = require('../lib/daily-r');
const discord = require('../lib/discord');
const at      = require('../lib/blofin-autotrade');

const SYMBOL = 'BTC-USDT';
const MODE = process.argv.includes('--live') ? 'live'
           : process.argv.includes('--live-reads') ? 'live-reads'
           : 'mocked';

let pass = 0;
function ok(cond, msg) {
  if (!cond) { console.error('  ✗', msg); throw new Error(msg); }
  pass++;
  console.log('  ✓', msg);
}

const SIGNAL = {
  setupType: 'A — Full Confluence',
  entry: 100000, stop: 99500, tp1: 100500, tp2: 101000, tp3: 102000,
};

let alerts = [];
let placements = [];

// Writes are ALWAYS stubbed outside --live mode. A guard bug then surfaces
// as a loud PROBE SAFETY error instead of a real order.
function stubWrites() {
  placements = [];
  blofin.placeOrder = async a => { placements.push(a); throw new Error('PROBE SAFETY: placeOrder reached'); };
  blofin.placeTPSL  = async a => { placements.push(a); throw new Error('PROBE SAFETY: placeTPSL reached'); };
  store.placeAndPersist = async a => { placements.push(a); throw new Error('PROBE SAFETY: placeAndPersist reached'); };
}

function captureDiscord() {
  alerts = [];
  discord.postWebhook = async (url, type, body) => { alerts.push({ type, body }); return 'probe-msg-id'; };
  if (!process.env.BLOFIN_RECON_WEBHOOK) {
    process.env.BLOFIN_RECON_WEBHOOK = 'https://discord.invalid/api/webhooks/probe';
  }
}

function resetRateLimit() {
  try { fs.rmSync(at.SKIP_ALERT_STATE, { force: true }); } catch (_) {}
}

function stubReads({ positions, positionsError, balance }) {
  blofin.getPositions = async () => {
    if (positionsError) throw new Error(positionsError);
    return positions || [];
  };
  blofin.getBalance      = async () => balance || [{ currency: 'USDT', balance: '1400', available: '1400', frozen: '100' }];
  blofin.getActiveOrders = async () => [];
  blofin.getOrderHistory = async () => [];
  store.mongoAvailable   = async () => false;
  dailyR.todayUtcR       = () => 0;
}

async function mockedScenarios() {
  console.log('─── governance-probe · MOCKED scenarios ───');
  process.env.BLOFIN_AUTOTRADE = 'true';
  if (!process.env.ACCOUNT_EQUITY_USD) process.env.ACCOUNT_EQUITY_USD = '1500';
  if (!process.env.RISK_PER_TRADE_PCT) process.env.RISK_PER_TRADE_PCT = '1.0';
  stubWrites();
  captureDiscord();

  console.log('[1] same-direction signal while a long is open → skip + detail + alert');
  resetRateLimit(); alerts = [];
  stubReads({ positions: [{ positions: '238.3' }] });
  let r = await at.autotrade({ ...SIGNAL, signalId: 'gov-probe-1', direction: 'long' });
  ok(r.skipped === 'same-direction position open (net 238.3) — book cap', `skip detail: "${r.skipped}"`);
  ok(placements.length === 0, 'no order placement attempted');
  ok(alerts.length === 1 && alerts[0].type === 'error', 'red signal-skipped-margin alert posted');

  console.log('[2] opposite-direction signal → existing guard message unchanged');
  resetRateLimit(); alerts = [];
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-probe-2', direction: 'short' });
  ok(r.skipped === 'opposite-direction position open (net 238.3) — one-direction book guard',
     `opposite guard message pinned: "${r.skipped}"`);
  ok(placements.length === 0, 'no order placement attempted');

  console.log('[3] position-read error → FAIL-SAFE skip (unlike the fail-open opposite guard)');
  resetRateLimit(); alerts = [];
  stubReads({ positionsError: 'simulated read stall (bad instId / API timeout)' });
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-probe-3', direction: 'long' });
  ok(r.skipped && /position read failed — fail-safe skip/.test(r.skipped), `fail-safe skip: "${r.skipped}"`);
  ok(placements.length === 0, 'no order placement attempted');
  ok(alerts.length === 1, 'fail-safe skip alerted');

  console.log('[4] margin cap trip with MARGIN_CAP_PCT=1');
  resetRateLimit(); alerts = [];
  process.env.MARGIN_CAP_PCT = '1';
  stubReads({ positions: [] });
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-probe-4', direction: 'long' });
  ok(r.skipped && /^margin cap: would use .*% > 1%$/.test(r.skipped), `margin-cap skip: "${r.skipped}"`);
  ok(placements.length === 0, 'no order placement attempted');
  ok(alerts.length === 1, 'margin-cap skip alerted');
  delete process.env.MARGIN_CAP_PCT;

  console.log('[5] falsification kill-file → skip + red alert (spec 08 / Agent-C contract)');
  resetRateLimit(); alerts = [];
  stubReads({ positions: [] });
  fs.writeFileSync(at.KILL_FILE, JSON.stringify({ reason: 'probe', weeks: 2 }));
  try {
    r = await at.autotrade({ ...SIGNAL, signalId: 'gov-probe-5', direction: 'long' });
    ok(r.skipped === 'falsification gate tripped', `skip detail: "${r.skipped}"`);
    ok(placements.length === 0, 'no order placement attempted');
    ok(alerts.length === 1 && alerts[0].type === 'error', 'red falsification-gate alert posted');
  } finally {
    fs.rmSync(at.KILL_FILE, { force: true });
  }

  resetRateLimit();
  console.log(`mocked scenarios: ${pass} assertions passed`);
}

async function liveReadScenarios() {
  console.log('─── governance-probe · LIVE-READS (writes stubbed) ───');
  if (!blofin.isDemo()) { console.error('Refusing: BLOFIN_ENV=prod.'); process.exit(1); }
  process.env.BLOFIN_AUTOTRADE = 'true';
  stubWrites();
  captureDiscord();
  store.mongoAvailable = async () => false;  // keep Mongo out of the probe
  dailyR.todayUtcR     = () => 0;

  const positions = await blofin.getPositions(SYMBOL);
  const net = (positions || []).reduce((s, p) => s + Number(p.positions || p.pos || 0), 0);
  console.log(`real book: net ${net} contracts on ${SYMBOL}`);

  for (const direction of ['long', 'short']) {
    resetRateLimit(); alerts = [];
    const r = await at.autotrade({ ...SIGNAL, signalId: `gov-probe-live-${direction}-${Date.now()}`, direction });
    console.log(`  ${direction}: ${r.skipped ? `skipped — ${r.skipped}` : r.dropped ? `reached money path (write-stubbed): ${r.dropped}` : JSON.stringify(r)}`);
    ok(placements.length === 0 || r.dropped, 'writes never landed (stub intact)');
  }

  // Docs-vs-truth: what does a bad instId do on the positions read?
  console.log('[bad-instId] getPositions("BTC-FAKE-USDT") behavior:');
  try {
    const res = await blofin.getPositions('BTC-FAKE-USDT');
    console.log(`  → resolved with ${Array.isArray(res) ? res.length + ' rows' : JSON.stringify(res).slice(0, 120)} (no throw — guard sees an empty/flat book)`);
  } catch (e) {
    console.log(`  → threw "${e.message.slice(0, 120)}" — guard takes the FAIL-SAFE skip path`);
  }
  console.log(`live-read scenarios complete (${pass} assertions).`);
}

async function liveScenarios() {
  console.log('─── governance-probe · LIVE (places real demo orders) ───');
  if (!blofin.isDemo()) { console.error('Refusing: BLOFIN_ENV=prod.'); process.exit(1); }
  if (process.env.BLOFIN_AUTOTRADE !== 'true') {
    console.error('Set BLOFIN_AUTOTRADE=true to exercise the live path.');
    process.exit(1);
  }

  // Pre-check: this mode needs a workable margin state and a flat-ish book.
  const positions = await blofin.getPositions(SYMBOL);
  const net = (positions || []).reduce((s, p) => s + Number(p.positions || p.pos || 0), 0);
  if (Math.abs(net) > 1) {
    console.error(`Refusing: net position ${net} already open — this mode opens/closes its own small book.`);
    console.error('PENDING MARGIN UNLOCK: flatten or free the live book first (operator decision, spec 01).');
    process.exit(1);
  }

  const https = require('https');
  const mark = await new Promise((resolve, reject) => {
    https.get('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(Number(JSON.parse(d).price)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
  const q = p => Math.round(p * 10) / 10;
  const mk = (id, direction) => ({
    signalId: id, direction, setupType: 'A — Full Confluence',
    entry: q(mark * (direction === 'long' ? 0.9995 : 1.0005)),
    stop:  q(mark * (direction === 'long' ? 0.995  : 1.005)),
    tp1:   q(mark * (direction === 'long' ? 1.005  : 0.995)),
    tp2:   q(mark * (direction === 'long' ? 1.01   : 0.99)),
    tp3:   q(mark * (direction === 'long' ? 1.02   : 0.98)),
  });
  const idA = 'gov-live-' + Date.now();

  try {
    console.log('[1] open a small real long via autotrade…');
    const rA = await at.autotrade(mk(idA, 'long'));
    ok(!rA.skipped && !rA.dropped && !rA.aborted, `entry placed: ${JSON.stringify(rA.orders?.map(o => o.kind))}`);

    console.log('[2] same-direction signal → skip + alert (check #blofin-recon for the red post)');
    resetRateLimit();
    const rB = await at.autotrade(mk('gov-live-same-' + Date.now(), 'long'));
    ok(rB.skipped && /same-direction position open \(net .*\) — book cap/.test(rB.skipped), `skip: "${rB.skipped}"`);

    console.log('[3] opposite-direction signal → existing guard message unchanged');
    const rC = await at.autotrade(mk('gov-live-opp-' + Date.now(), 'short'));
    ok(rC.skipped && /opposite-direction position open \(net .*\) — one-direction book guard/.test(rC.skipped),
       `skip: "${rC.skipped}"`);

    console.log('[4] margin cap trip with MARGIN_CAP_PCT=1 (needs the long closed first)');
    await cleanupLive(idA);
    process.env.MARGIN_CAP_PCT = '1';
    resetRateLimit();
    const rD = await at.autotrade(mk('gov-live-cap-' + Date.now(), 'long'));
    ok(rD.skipped && /^margin cap: would use .*% > 1%$/.test(rD.skipped), `skip: "${rD.skipped}"`);
    delete process.env.MARGIN_CAP_PCT;

    console.log(`live scenarios: ${pass} assertions passed`);
  } finally {
    delete process.env.MARGIN_CAP_PCT;
    await cleanupLive(idA);
    console.log('cleanup complete.');
  }
}

async function cleanupLive(signalId) {
  try {
    const pending = await blofin.getActiveOrders({ instId: SYMBOL });
    for (const o of pending || []) {
      try { await blofin.cancelOrder(o.orderId, SYMBOL); } catch (_) {}
    }
    const sls = await blofin.getPendingTPSL({ instId: SYMBOL });
    const items = (sls || []).map(o => ({ instId: SYMBOL, tpslId: o.tpslId }));
    if (items.length) await blofin.cancelTPSL(items);
    const positions = await blofin.getPositions(SYMBOL);
    for (const p of positions || []) {
      const sz = Math.abs(Number(p.positions || p.pos || 0));
      if (sz > 0) {
        await blofin.placeOrder({
          instId: SYMBOL, side: Number(p.positions || p.pos) > 0 ? 'sell' : 'buy',
          orderType: 'market', size: String(sz),
          marginMode: 'isolated', positionSide: 'net', reduceOnly: true,
        });
      }
    }
  } catch (e) {
    console.log('  (cleanup issue:', e.message, ')');
  }
}

(async () => {
  if (MODE === 'mocked')          await mockedScenarios();
  else if (MODE === 'live-reads') await liveReadScenarios();
  else                            await liveScenarios();
  console.log('─── governance-probe done. ───');
})().catch(e => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
