/**
 * Tests for settleAutotrades (scripts/trigger-check.js).
 *
 * Regression cover for audit A1 (refactors/btc-audit-2026-08-03.md): autotrade
 * was fired without being awaited, and finishCron() calls process.exit(). The
 * promise carries the executionStatus stamp, the dead-letter alert, and the
 * standalone-SL placement that follows the entry fill — so an exit mid-flight
 * can leave a filled entry with no stop and no record. 3 of the 13 signals
 * after cb38c94 landed unstamped (0 of the 173 before it, Fisher p=2.7e-4).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { settleAutotrades } = require('../scripts/trigger-check');

/** A pending record shaped like the live call site builds. */
function pending(signalId, promise) {
  const rec = { signalId, settled: false };
  rec.promise = promise.finally(() => { rec.settled = true; });
  return rec;
}
const after = (ms, v) => new Promise(res => setTimeout(() => res(v), ms));

test('empty list settles immediately', async () => {
  const r = await settleAutotrades([], { timeoutMs: 50 });
  assert.deepEqual(r.unsettled, []);
  assert.equal(r.settled, 0);
});

test('waits for in-flight calls instead of abandoning them', async () => {
  let done = false;
  const p = pending('sig-1', after(60).then(() => { done = true; }));
  const r = await settleAutotrades([p], { timeoutMs: 5_000 });
  assert.equal(done, true, 'the autotrade chain must have run to completion');
  assert.equal(r.settled, 1);
  assert.deepEqual(r.unsettled, []);
});

test('a rejected chain still counts as settled — not as unknown state', async () => {
  // markExecution('dropped') already ran inside the caller's .catch; the
  // signal is recorded, so it must not be double-marked here.
  const p = pending('sig-1', Promise.reject(new Error('boom')).catch(() => {}));
  const r = await settleAutotrades([p], { timeoutMs: 5_000 });
  assert.equal(r.settled, 1);
  assert.deepEqual(r.unsettled, []);
});

test('reports the signalIds still in flight at the deadline', async () => {
  const quick = pending('sig-fast', after(10));
  const slow  = pending('sig-slow', after(5_000));
  const r = await settleAutotrades([quick, slow], { timeoutMs: 100 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.unsettled, ['sig-slow']);
  assert.equal(r.settled, 1);
});

test('all hung → every signalId is reported unsettled', async () => {
  const a = pending('a', after(5_000));
  const b = pending('b', after(5_000));
  const r = await settleAutotrades([a, b], { timeoutMs: 60 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.unsettled.sort(), ['a', 'b']);
});

test('does not time out when everything finishes just inside the deadline', async () => {
  const p = pending('sig-1', after(40));
  const r = await settleAutotrades([p], { timeoutMs: 1_000 });
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.unsettled, []);
});
