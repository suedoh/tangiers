/**
 * Known-answer tests for the spec-06 additions to scripts/lib/market-data.js
 * (rebuild/06-exchange-native-data.md — native-path completeness for the
 * trigger-check.js cutover). Companion to test/market-data.test.js (P0 suite,
 * commit 7706b31) — same style: node:test + assert, injected fetchers, no
 * network.
 *
 * Run: node --test scripts/tests/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeATR,
  completedBars,
  sessionBars,
  fetchLastPrice,
  fetchOpenInterest,
  INTERVAL_MS,
} = require('../lib/market-data');

// ─── INTERVAL_MS coverage for the trigger's HTF sweep ─────────────────────────

test('INTERVAL_MS covers every interval the BTC trigger needs', () => {
  // 5m zones/CVD, 30m canonical bars, 4h MACD, 12h RSI, 1w weekly trend
  assert.equal(INTERVAL_MS['5m'], 300_000);
  assert.equal(INTERVAL_MS['30m'], 1_800_000);
  assert.equal(INTERVAL_MS['4h'], 14_400_000);
  assert.equal(INTERVAL_MS['12h'], 43_200_000);
  assert.equal(INTERVAL_MS['1w'], 604_800_000);
});

// ─── computeATR ───────────────────────────────────────────────────────────────

test('computeATR is the mean of the last `period` true ranges', () => {
  // bar1→bar2 TR = max(110−100, |110−105|, |100−105|) = 10
  // bar2→bar3 TR = max(120−110, |120−108|, |110−108|) = 12
  const bars = [
    { h: 106, l: 101, c: 105 },
    { h: 110, l: 100, c: 108 },
    { h: 120, l: 110, c: 115 },
  ];
  assert.equal(computeATR(bars, 14), 11); // (10+12)/2 — fewer TRs than period
  assert.equal(computeATR(bars, 1), 12);  // last TR only
});

test('computeATR uses prev close when it gaps outside the bar range', () => {
  // gap down: prev c=200, bar h=110 l=100 → TR = max(10, |110−200|=90, |100−200|=100) = 100
  const bars = [{ h: 210, l: 190, c: 200 }, { h: 110, l: 100, c: 105 }];
  assert.equal(computeATR(bars, 14), 100);
});

test('computeATR returns null with fewer than 2 bars', () => {
  assert.equal(computeATR([], 14), null);
  assert.equal(computeATR([{ h: 1, l: 1, c: 1 }], 14), null);
});

// ─── completedBars ────────────────────────────────────────────────────────────

test('completedBars drops the in-progress kline (audit D4)', () => {
  const t0 = 1_700_000_000_000; // grid-aligned fixture
  const bars = [
    { t: t0 },                  // closed
    { t: t0 + 1_800_000 },      // closed exactly at `now`
    { t: t0 + 3_600_000 },      // forming — Binance returns it as last element
  ];
  const now = t0 + 3_600_000;
  assert.deepEqual(completedBars(bars, '30m', now).map(b => b.t), [t0, t0 + 1_800_000]);
});

test('completedBars keeps a bar whose close lands exactly on now', () => {
  const bars = [{ t: 0 }];
  assert.equal(completedBars(bars, '30m', 1_800_000).length, 1);
  assert.equal(completedBars(bars, '30m', 1_799_999).length, 0);
});

test('completedBars throws on unknown interval', () => {
  assert.throws(() => completedBars([], '7m'), /Unknown interval/);
});

// ─── sessionBars ──────────────────────────────────────────────────────────────

test('sessionBars keeps only bars from the current UTC day', () => {
  const dayStart = 1_700_006_400_000; // exactly divisible by 86_400_000
  const bars = [
    { t: dayStart - 300_000 },  // yesterday's last 5m bar
    { t: dayStart },            // session open
    { t: dayStart + 300_000 },
  ];
  const now = dayStart + 3_600_000;
  assert.deepEqual(sessionBars(bars, now).map(b => b.t), [dayStart, dayStart + 300_000]);
});

test('sessionBars of empty/absent input is empty', () => {
  assert.deepEqual(sessionBars([], 1_700_006_400_000), []);
  assert.deepEqual(sessionBars(null, 1_700_006_400_000), []);
});

// ─── fetchLastPrice ───────────────────────────────────────────────────────────

test('fetchLastPrice parses ticker price and hits the right endpoint', async () => {
  let called;
  const p = await fetchLastPrice({
    symbol: 'BTCUSDT',
    fetcher: async url => { called = url; return { symbol: 'BTCUSDT', price: '64123.40' }; },
  });
  assert.equal(p, 64123.4);
  assert.match(called, /\/fapi\/v1\/ticker\/price\?symbol=BTCUSDT$/);
});

test('fetchLastPrice returns null on malformed response', async () => {
  assert.equal(await fetchLastPrice({ symbol: 'BTCUSDT', fetcher: async () => ({}) }), null);
  assert.equal(await fetchLastPrice({ symbol: 'BTCUSDT', fetcher: async () => 'nope' }), null);
});

test('fetchLastPrice propagates fetch errors (never signal off missing data)', async () => {
  await assert.rejects(
    fetchLastPrice({ symbol: 'BTCUSDT', fetcher: async () => { throw new Error('down'); } }),
    /down/
  );
});

// ─── fetchOpenInterest ────────────────────────────────────────────────────────

test('fetchOpenInterest returns raw coins from /fapi/v1/openInterest', async () => {
  let called;
  const oi = await fetchOpenInterest({
    symbol: 'BTCUSDT',
    fetcher: async url => { called = url; return { openInterest: '107008.987', symbol: 'BTCUSDT' }; },
  });
  assert.equal(oi, 107008.987);
  assert.match(called, /\/fapi\/v1\/openInterest\?symbol=BTCUSDT$/);
});

test('fetchOpenInterest returns null on malformed response', async () => {
  assert.equal(await fetchOpenInterest({ symbol: 'BTCUSDT', fetcher: async () => ({ code: -1121 }) }), null);
});
