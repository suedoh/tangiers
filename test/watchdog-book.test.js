/**
 * Tests for the watchdog order-book-recorder evaluator (scripts/ops/watchdog.js).
 *
 * Regression cover for the 2026-08-14 → 2026-09-06 corpus outage. The recorder
 * stopped writing at 2026-08-14T04:01Z; the freshness check caught it in 24
 * minutes and posted 144 alerts over 12 days, and 23 days of unbackfillable
 * order-book history were lost anyway. These tests pin the two detection shapes
 * (no rows / empty rows) and the file-vs-state divergence that freshness alone
 * cannot see. The self-heal that actually closes the loop is exercised
 * separately — it shells out to pm2.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateBookRecorder, BOOK_STALE_MIN, BOOK_FILE_STALE_MIN, BOOK_EMPTY_RUN,
} = require('../scripts/ops/watchdog');

const NOW = Date.parse('2026-08-14T04:25:00.000Z');
const minsAgo = m => NOW - m * 60_000;

// Verbatim shape of the real state file, from the incident log line:
// "last wrote 24 min ago (writes every minute; 25396 rows, 6716 reconnects)".
const state = (over = {}) => ({
  pid: 76033, symbol: 'btcusdt',
  lastRowAt: minsAgo(1), lastRowMinute: '2026-08-14T04:24:00.000Z',
  rowsWritten: 25396, reconnects: 6716, liqSeen: 8, liqAllSeen: 1570,
  ...over,
});

// A healthy minute row, field-for-field as serialise() emits it.
const liveRow = (t, over = {}) => ({
  t, samples: 546, ticks: 7795, obi5: 0.0123, spread: 0.0142,
  trades: 928, tvol: 41.2, liqN: 0, liqAllN: 12, mark: 71234.5, ...over,
});
const gapRow  = t => ({ t, samples: 0, ticks: 0, gap: true });
const emptyRow = t => ({ t, samples: 0, ticks: 0, trades: 0, liqAllN: 3 });

const rows = (n, mk, endT = NOW) =>
  Array.from({ length: n }, (_, i) => mk(endT - (n - 1 - i) * 60_000));

const ok = { fileAgeMin: 1, newestFile: 'btcusdt-2026-08-14.ndjson' };

test('healthy recorder passes', () => {
  const r = evaluateBookRecorder(
    { state: state(), ...ok, tailRows: rows(40, liveRow) }, { nowMs: NOW });
  assert.equal(r.ok, true);
});

test('stale state is the 2026-08-14 shape and reports minutes', () => {
  const r = evaluateBookRecorder(
    { state: state({ lastRowAt: minsAgo(24) }), ...ok, tailRows: rows(40, liveRow) },
    { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.match(r.detail, /last wrote 24 min ago/);
  assert.match(r.detail, /25396 rows, 6716 reconnects/);
});

test('freshness threshold is not tripped just under the limit', () => {
  const r = evaluateBookRecorder(
    { state: state({ lastRowAt: minsAgo(BOOK_STALE_MIN - 1) }), ...ok, tailRows: rows(40, liveRow) },
    { nowMs: NOW });
  assert.equal(r.ok, true);
});

test('fresh state but stale day file — rows are not reaching disk', () => {
  const r = evaluateBookRecorder(
    { state: state(), fileAgeMin: BOOK_FILE_STALE_MIN + 5,
      newestFile: 'btcusdt-2026-08-14.ndjson', tailRows: rows(40, liveRow) },
    { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.match(r.detail, /not reaching disk/);
  assert.match(r.detail, /btcusdt-2026-08-14\.ndjson/);
});

test('rows arriving but structurally empty — the liq-feed-only failure', () => {
  // The depth and tick feeds are dead; the market-wide liquidation stream alone
  // keeps writeRow() firing every minute. Freshness reads this as healthy.
  const r = evaluateBookRecorder(
    { state: state(), ...ok, tailRows: rows(BOOK_EMPTY_RUN, emptyRow) }, { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.empty, true);
  assert.match(r.detail, /writing but the last 10 minutes carry no book data/);
});

test('explicit gap rows count as empty', () => {
  const r = evaluateBookRecorder(
    { state: state(), ...ok, tailRows: rows(BOOK_EMPTY_RUN, gapRow) }, { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.empty, true);
  assert.match(r.detail, /10 explicit gap rows/);
});

test('isolated empty minutes stay green — the corpus really contains these', () => {
  // The 19-day corpus has 24 scattered samples=0 rows and 393 gap rows; the
  // longest genuine run is 67 min but short runs are routine. A run shorter
  // than BOOK_EMPTY_RUN must never strike.
  const tail = rows(40, liveRow);
  tail[35] = emptyRow(tail[35].t);
  tail[37] = gapRow(tail[37].t);
  tail[39] = emptyRow(tail[39].t);
  const r = evaluateBookRecorder({ state: state(), ...ok, tailRows: tail }, { nowMs: NOW });
  assert.equal(r.ok, true);
});

test('a short tail cannot trigger the empty-run rule', () => {
  // Start-up, or a freshly rolled day file: fewer rows than the run length.
  const r = evaluateBookRecorder(
    { state: state(), ...ok, tailRows: rows(BOOK_EMPTY_RUN - 1, emptyRow) }, { nowMs: NOW });
  assert.equal(r.ok, true);
});

test('missing lastRowAt is a failure, not a pass', () => {
  const r = evaluateBookRecorder(
    { state: state({ lastRowAt: undefined }), ...ok, tailRows: rows(40, liveRow) },
    { nowMs: NOW });
  assert.equal(r.ok, false);
  assert.match(r.detail, /no usable lastRowAt/);
});

test('unreadable day file falls back to state-only evaluation', () => {
  // fileAgeMin null / no tail: freshness must still be judged.
  const good = evaluateBookRecorder(
    { state: state(), fileAgeMin: null, newestFile: null, tailRows: [] }, { nowMs: NOW });
  assert.equal(good.ok, true);
  const bad = evaluateBookRecorder(
    { state: state({ lastRowAt: minsAgo(60) }), fileAgeMin: null, newestFile: null, tailRows: [] },
    { nowMs: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.stale, true);
});
