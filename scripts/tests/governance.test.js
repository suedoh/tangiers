#!/usr/bin/env node
'use strict';

/**
 * Rebuild specs 02 (book governance) + 08 (execution layer) unit +
 * integration asserts.
 * Run: node scripts/tests/governance.test.js
 *
 * No exchange, no Mongo, no Discord — blofin/store/daily-r/discord are
 * monkey-patched on their module-export objects (blofin-autotrade reads
 * them by property at call time). Every order-placement primitive is
 * stubbed to record-and-throw, so a governance bug that reaches the money
 * path fails the test instead of placing anything.
 */

const assert = require('assert');
const fs     = require('fs');

// Env BEFORE requiring the module under test.
process.env.BLOFIN_AUTOTRADE     = 'true';
process.env.BLOFIN_ENV           = 'demo';
process.env.ACCOUNT_EQUITY_USD   = '1500';
process.env.RISK_PER_TRADE_PCT   = '1.0';
process.env.BLOFIN_LEVERAGE      = '10';
process.env.BLOFIN_RECON_WEBHOOK = 'https://discord.invalid/api/webhooks/test'; // captured by mock, never hit

const blofin  = require('../lib/blofin');
const store   = require('../lib/blofin-store');
const dailyR  = require('../lib/daily-r');
const discord = require('../lib/discord');
const at      = require('../lib/blofin-autotrade');

let alerts     = [];   // captured discord.postWebhook calls
let placements = [];   // captured order-placement attempts (must stay empty on skips)

function armMocks({ positions, positionsError, balance } = {}) {
  alerts = [];
  placements = [];
  blofin.getPositions = async () => {
    if (positionsError) throw new Error(positionsError);
    return positions || [];
  };
  blofin.getBalance = async () =>
    balance || [{ currency: 'USDT', balance: '1400', available: '1400', frozen: '100' }];
  blofin.getActiveOrders = async () => [];
  blofin.getOrderHistory = async () => [];
  blofin.placeOrder = async a => { placements.push(a); throw new Error('TEST SAFETY: placeOrder must not be reached'); };
  blofin.placeTPSL  = async a => { placements.push(a); throw new Error('TEST SAFETY: placeTPSL must not be reached'); };
  store.mongoAvailable  = async () => false;           // idempotency via (mocked) exchange lookup
  store.placeAndPersist = async (args) => { placements.push(args); throw new Error('TEST SAFETY: placeAndPersist must not be reached'); };
  dailyR.todayUtcR = () => 0;
  discord.postWebhook = async (url, type, body, footer) => { alerts.push({ type, body, footer }); return 'msg-id'; };
  try { fs.rmSync(at.SKIP_ALERT_STATE, { force: true }); } catch (_) {}
}

const SIGNAL = {
  signalId: 'gov-test-1', setupType: 'A — Full Confluence',
  entry: 100000, stop: 99500, tp1: 100500, tp2: 101000, tp3: 102000,
};

(async () => {
  // ── Pure: assessDirectionGuard ─────────────────────────────────────────────
  assert.strictEqual(at.assessDirectionGuard({ direction: 'long',  net: 0 }), null, 'flat book: long allowed');
  assert.strictEqual(at.assessDirectionGuard({ direction: 'short', net: 0 }), null, 'flat book: short allowed');

  let g = at.assessDirectionGuard({ direction: 'long', net: -5 });
  assert.strictEqual(g.skip, 'opposite-direction position open (net -5) — one-direction book guard',
    'opposite guard message pinned (existing behaviour, must not change)');
  assert.strictEqual(g.kind, 'opposite-direction');
  g = at.assessDirectionGuard({ direction: 'short', net: 5 });
  assert.strictEqual(g.kind, 'opposite-direction', 'short vs net long is opposite');

  g = at.assessDirectionGuard({ direction: 'long', net: 238.3 });
  assert.strictEqual(g.skip, 'same-direction position open (net 238.3) — book cap',
    'same-direction guard message per spec 02.1');
  assert.strictEqual(g.kind, 'same-direction');
  g = at.assessDirectionGuard({ direction: 'short', net: -2.5 });
  assert.strictEqual(g.kind, 'same-direction', 'short vs net short is same-direction');

  // ── Pure: assessMarginCap ──────────────────────────────────────────────────
  assert.strictEqual(at.assessMarginCap({ marginInUse: 100, equity: 1500, orderMargin: 300, capPct: 30 }),
    null, 'under cap (26.7% < 30%) passes');
  let c = at.assessMarginCap({ marginInUse: 100, equity: 1500, orderMargin: 300, capPct: 1 });
  assert.strictEqual(c.skip, 'margin cap: would use 26.7% > 1%', 'cap detail per spec 02.2');
  c = at.assessMarginCap({ marginInUse: 1528, equity: 1570, orderMargin: 50, capPct: 30 });
  assert.ok(c && /margin cap: would use 100\.5% > 30%/.test(c.skip), '2026-07-26 incident book trips the cap');
  assert.strictEqual(at.assessMarginCap({ marginInUse: NaN, equity: 1500, orderMargin: 300, capPct: 30 }),
    null, 'unevaluable inputs fail open (only 2.1 is fail-safe)');

  // ── Pure: config readers ───────────────────────────────────────────────────
  process.env.MAX_POSITIONS_PER_DIRECTION = '3';
  assert.strictEqual(at.maxPositionsPerDirection(), 1, 'values ≠ 1 clamp to 1 (only 1 supported)');
  process.env.MAX_POSITIONS_PER_DIRECTION = '1';
  assert.strictEqual(at.maxPositionsPerDirection(), 1);
  delete process.env.MARGIN_CAP_PCT;
  assert.strictEqual(at.marginCapPct(), 30, 'MARGIN_CAP_PCT defaults to 30');
  process.env.MARGIN_CAP_PCT = '15';
  assert.strictEqual(at.marginCapPct(), 15);
  delete process.env.MARGIN_CAP_PCT;

  // ── Integration: same-direction skip + alert, nothing placed ──────────────
  armMocks({ positions: [{ positions: '238.3' }] });
  let r = await at.autotrade({ ...SIGNAL, direction: 'long' });
  assert.strictEqual(r.skipped, 'same-direction position open (net 238.3) — book cap');
  assert.strictEqual(placements.length, 0, 'no placement on same-direction skip');
  assert.strictEqual(alerts.length, 1, 'same-direction skip alerts');
  assert.strictEqual(alerts[0].type, 'error', 'alert is red');
  assert.ok(alerts[0].body.includes('signal-skipped-margin'), 'alert carries the spec class name');
  assert.ok(alerts[0].body.includes('book cap'), 'alert carries the reason');

  // ── Integration: opposite-direction message unchanged, alerted ────────────
  armMocks({ positions: [{ positions: '238.3' }] });
  r = await at.autotrade({ ...SIGNAL, direction: 'short' });
  assert.strictEqual(r.skipped, 'opposite-direction position open (net 238.3) — one-direction book guard',
    'existing opposite guard message unchanged');
  assert.strictEqual(placements.length, 0);
  assert.strictEqual(alerts.length, 1, 'opposite skip also alerts (skips are never silent now)');

  // ── Integration: position-read error ⇒ FAIL-SAFE skip (spec 02.1) ─────────
  armMocks({ positionsError: 'simulated stalled position read' });
  r = await at.autotrade({ ...SIGNAL, direction: 'long' });
  assert.ok(r.skipped && /position read failed — fail-safe skip/.test(r.skipped),
    `expected fail-safe skip, got: ${JSON.stringify(r)}`);
  assert.ok(/simulated stalled position read/.test(r.skipped), 'skip detail carries the read error');
  assert.strictEqual(placements.length, 0, 'no placement when the book is unreadable');
  assert.strictEqual(alerts.length, 1, 'fail-safe skip alerts');

  // ── Integration: margin cap trip with MARGIN_CAP_PCT=1 ────────────────────
  process.env.MARGIN_CAP_PCT = '1';
  armMocks({ positions: [] });   // flat book — direction guards pass
  r = await at.autotrade({ ...SIGNAL, direction: 'long' });
  assert.strictEqual(r.skipped, 'margin cap: would use 26.7% > 1%',
    `expected margin-cap skip, got: ${JSON.stringify(r)}`);
  assert.strictEqual(placements.length, 0, 'no placement on margin-cap skip');
  assert.strictEqual(alerts.length, 1, 'margin-cap skip alerts');
  delete process.env.MARGIN_CAP_PCT;

  // ── Integration: under default cap, the money path IS reached ─────────────
  // (proves the cap doesn't over-block; the placement stub records + throws,
  // so the run ends in `dropped` after retries — that is the stub working.)
  armMocks({ positions: [] });
  r = await at.autotrade({ ...SIGNAL, direction: 'long' });
  assert.ok(r.dropped, `expected dropped via safety stub, got: ${JSON.stringify(r)}`);
  assert.ok(placements.length >= 1, 'entry placement attempted when under cap');

  // ── Alert rate limit: one per skip-kind per 30 min ────────────────────────
  armMocks({ positions: [{ positions: '10' }] });
  await at.autotrade({ ...SIGNAL, direction: 'long' });
  await at.autotrade({ ...SIGNAL, signalId: 'gov-test-2', direction: 'long' });
  assert.strictEqual(alerts.length, 1, 'second same-kind alert suppressed inside 30 min');
  fs.rmSync(at.SKIP_ALERT_STATE, { force: true });
  await at.autotrade({ ...SIGNAL, signalId: 'gov-test-3', direction: 'long' });
  assert.strictEqual(alerts.length, 2, 'alert fires again once the rate-limit window is cleared');

  // ═══ Spec 08 — execution layer ═══════════════════════════════════════════

  // ── Pure: sizingFor is flat — no tier multipliers anywhere ────────────────
  const src = fs.readFileSync(require.resolve('../lib/blofin-autotrade'), 'utf8');
  assert.ok(!/tierMult|TIER_MULT/i.test(src), 'tierMult absent from the code (spec 08 acceptance 2)');

  let s = at.sizingFor({ entry: 100000, stop: 99500, equity: 1500 });
  assert.strictEqual(s.rDollar, 15, 'rDollar = equity × riskPct, no multiplier');
  assert.strictEqual(s.contracts, 30, '15 / (500 × 0.001) = 30 contracts');
  s = at.sizingFor({ entry: 100000, stop: 99500, equity: 750 });
  assert.strictEqual(s.contracts, 15, 'sizing scales linearly with equity — no tier steps');
  assert.ok(at.sizingFor({ entry: 100000, stop: 100000, equity: 1500 }).error, 'stop=entry errors');
  assert.ok(at.sizingFor({ entry: 100000, stop: 99500, equity: 0 }).error, 'no equity errors');

  // ── Pure: resolveEquity = min(live, cap) ──────────────────────────────────
  let e = at.resolveEquity(800, 1500);
  assert.strictEqual(e.equity, 800, 'live below cap → live');
  assert.strictEqual(e.source, 'live balance');
  e = at.resolveEquity(5000, 1500);
  assert.strictEqual(e.equity, 1500, 'live above cap → cap (demo top-up cannot double risk)');
  assert.strictEqual(e.source, 'env cap');
  e = at.resolveEquity(NaN, 1500);
  assert.strictEqual(e.equity, 1500, 'failed balance read falls open to the cap');
  assert.ok(at.resolveEquity(800, NaN).error, 'missing ACCOUNT_EQUITY_USD errors');

  // ── Pure: computeFeeR — measured schedule, legs weighted by rung size ─────
  const fee = at.computeFeeR({
    fill: 100000, stop: 99500, entryContracts: 30, liveContracts: 30, rDollar: 15,
    rungs: [{ price: 100500, size: 10 }, { price: 101000, size: 10 }, { price: 102000, size: 10 }],
  });
  assert.strictEqual(fee.entryUsd, 1.8,    'entry: $3,000 notional × 6bp taker');
  assert.strictEqual(fee.tpExitUsd, 0.607, 'TP legs: Σ(rung notional × 2bp maker)');
  assert.strictEqual(fee.stopExitUsd, 1.791, 'stop: $2,985 notional × 6bp taker');
  assert.strictEqual(fee.tpPathR, 0.16,    '(1.8+0.607)/15 R on the full-TP path');
  assert.strictEqual(fee.stopPathR, 0.239, '(1.8+1.791)/15 R on the stop path');
  // Uneven rungs weight correctly: one fat rung ≠ three thin ones at different prices.
  const feeW = at.computeFeeR({
    fill: 100000, stop: 99500, entryContracts: 30, liveContracts: 30, rDollar: 15,
    rungs: [{ price: 102000, size: 30 }],
  });
  assert.strictEqual(feeW.tpExitUsd, 0.612, 'single 30-lot rung at 102000 = 3060 × 2bp');

  // ── Integration: confirmedPrice is the sizing basis (Agent-A contract) ────
  armMocks({ positions: [] });
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-test-basis', direction: 'long',
    entry: 100000, stop: 99000, confirmedPrice: 101000 });
  assert.ok(r.dropped, 'reached money path (write-stubbed)');
  assert.strictEqual(placements[0].size, '7.5',
    'sized off |confirmedPrice − stop| = 2000 → 15/2 = 7.5 contracts');

  armMocks({ positions: [] });
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-test-nobasis', direction: 'long',
    entry: 100000, stop: 99000 });
  assert.strictEqual(placements[0].size, '15',
    'no confirmedPrice → plan-entry fallback: |100000−99000| → 15 contracts');

  // ── Integration: equity marked to live balance, min()'d with the cap ──────
  armMocks({ positions: [],
    balance: [{ currency: 'USDT', balance: '750', available: '750', frozen: '50' }] });
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-test-liveeq', direction: 'long' });
  assert.strictEqual(placements[0].size, '16',
    'live equity 800 < cap 1500 → rDollar 8 → 16 contracts');

  armMocks({ positions: [],
    balance: [{ currency: 'USDT', balance: '4900', available: '4900', frozen: '100' }] });
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-test-capeq', direction: 'long' });
  assert.strictEqual(placements[0].size, '30',
    'live equity 5000 > cap 1500 → capped rDollar 15 → 30 contracts');

  // ── Integration: kill-file ⇒ skip "falsification gate tripped" + red alert ─
  armMocks({ positions: [] });
  fs.writeFileSync(at.KILL_FILE, JSON.stringify({ reason: 'test', weeks: 2 }));
  try {
    r = await at.autotrade({ ...SIGNAL, signalId: 'gov-test-kill', direction: 'long' });
    assert.strictEqual(r.skipped, 'falsification gate tripped', 'kill-file skip detail per contract');
    assert.strictEqual(placements.length, 0, 'no placement while gate is tripped');
    assert.strictEqual(alerts.length, 1, 'kill-file skip alerts');
    assert.strictEqual(alerts[0].type, 'error', 'kill-file alert is red');
    assert.ok(alerts[0].body.includes('.autotrade-disabled.json'), 'alert names the kill file');
  } finally {
    fs.rmSync(at.KILL_FILE, { force: true });
  }
  armMocks({ positions: [] });
  r = await at.autotrade({ ...SIGNAL, signalId: 'gov-test-rearm', direction: 'long' });
  assert.ok(r.dropped, 'deleting the kill file re-arms the money path');

  try { fs.rmSync(at.SKIP_ALERT_STATE, { force: true }); } catch (_) {}
  console.log('governance.test.js: all assertions passed');
})().catch(e => {
  console.error('governance.test.js FAILED:', e.message);
  process.exit(1);
});
