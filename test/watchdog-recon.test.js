/**
 * Tests for the watchdog recon-health evaluator (scripts/ops/watchdog.js).
 *
 * Regression cover for audit A2 (refactors/btc-audit-2026-08-03.md): the old
 * matcher only knew `reconcile errors:` / `resolve errors:`, which a *thrown*
 * error never reaches — a Cloudflare 403 aborts the pass before any summary
 * line is written. On 2026-08-03, 40 of 124 recon cycles (32%) failed that way
 * while the watchdog reported recon=ok on every one of them.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateReconLog, RECON_WINDOW_PASSES, RECON_MAX_ERR_IN_WINDOW } =
  require('../scripts/ops/watchdog');

const T0 = Date.parse('2026-08-03T06:00:00.000Z');

const healthyPass = ts => `─── BloFin reconciliation ─── ${new Date(ts).toISOString()}
env:     demo
instId:  (all)

matched (still live):    0
disappeared (this pass): 0
resolved → filled:       0
resolved → cancelled:    0
retroactive (new local): 0

─── Done. ───
`;

// Verbatim shape of a real 403 pass from logs/blofin-recon.log.
const cloudflare403Pass = ts => `─── BloFin reconciliation ─── ${new Date(ts).toISOString()}
env:     demo
instId:  (all)

unexpected: Error: blofin http 403: <!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <link rel="shortcut icon" type="image/x-icon" href="https://s2.blofin.com/icons/blofin/favicon-v2.ico">
    at IncomingMessage.<anonymous> (/Users/vpm/trading/scripts/lib/blofin.js:93:51)
    at IncomingMessage.emit (node:events:531:35)
`;

const summaryErrPass = ts => `─── BloFin reconciliation ─── ${new Date(ts).toISOString()}
env:     demo
instId:  (all)

matched (still live):    2
reconcile errors: 3
resolve errors: 0

─── Done. ───
`;

/** Build a log tail of `n` passes ending `endTs`, 3 min apart; `errAt` = indices that failed. */
function buildLog(n, endTs, errAt = new Set(), maker = cloudflare403Pass) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ts = endTs - (n - 1 - i) * 180_000;
    out.push(errAt.has(i) ? maker(ts) : healthyPass(ts));
  }
  return out.join('');
}

test('all-healthy window is ok', () => {
  const r = evaluateReconLog(buildLog(20, T0), { nowMs: T0 + 5_000 });
  assert.equal(r.ok, true);
  assert.equal(r.errored, 0);
});

test('A2 REGRESSION: a Cloudflare 403 pass is detected as an error', () => {
  // The single most important case — this is what the old matcher missed.
  const errAt = new Set([...Array(RECON_WINDOW_PASSES).keys()]);
  const r = evaluateReconLog(buildLog(RECON_WINDOW_PASSES, T0, errAt), { nowMs: T0 + 5_000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /403/);
});

test('intermittent degradation (the observed 2026-08-03 pattern) strikes', () => {
  // 5 of 15 failed — recon "runs" and mostly succeeds, but a third of the
  // protection-invariant checks never happened.
  const errAt = new Set([2, 5, 6, 9, 13]);
  const r = evaluateReconLog(buildLog(15, T0, errAt), { nowMs: T0 + 5_000 });
  assert.equal(r.ok, false);
  assert.equal(r.errored, 5);
  assert.match(r.detail, /5\/15/);
});

test('a single blip does not strike', () => {
  const r = evaluateReconLog(buildLog(15, T0, new Set([7])), { nowMs: T0 + 5_000 });
  assert.equal(r.ok, true);
  assert.equal(r.errored, 1);
});

test('threshold is exactly RECON_MAX_ERR_IN_WINDOW', () => {
  const below = new Set([...Array(RECON_MAX_ERR_IN_WINDOW - 1).keys()]);
  const at    = new Set([...Array(RECON_MAX_ERR_IN_WINDOW).keys()]);
  assert.equal(evaluateReconLog(buildLog(15, T0, below), { nowMs: T0 + 5_000 }).ok, true);
  assert.equal(evaluateReconLog(buildLog(15, T0, at),    { nowMs: T0 + 5_000 }).ok, false);
});

test('does not regress the 2026-07-04 E11000 case (summary error lines)', () => {
  const errAt = new Set([1, 4, 8, 12]);
  const r = evaluateReconLog(buildLog(15, T0, errAt, summaryErrPass), { nowMs: T0 + 5_000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /reconcile errors: 3/);
});

test('only the most recent RECON_WINDOW_PASSES are considered', () => {
  // A long-past outage must not keep striking once recon recovered.
  const old = buildLog(30, T0 - RECON_WINDOW_PASSES * 180_000,
    new Set([...Array(30).keys()]));
  const recent = buildLog(RECON_WINDOW_PASSES, T0);
  const r = evaluateReconLog(old + recent, { nowMs: T0 + 5_000 });
  assert.equal(r.ok, true);
});

test('a pass in flight right now is tolerated, not counted as failed', () => {
  const inFlight = `─── BloFin reconciliation ─── ${new Date(T0).toISOString()}
env:     demo
instId:  (all)
`;
  const r = evaluateReconLog(buildLog(15, T0 - 180_000) + inFlight, { nowMs: T0 + 5_000 });
  assert.equal(r.ok, true);
});

test('a pass that started long ago and never completed is a failure', () => {
  const stalled = `─── BloFin reconciliation ─── ${new Date(T0).toISOString()}
env:     demo
instId:  (all)
`;
  const r = evaluateReconLog(buildLog(15, T0 - 180_000) + stalled, { nowMs: T0 + 600_000 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /hung|never completed/);
});

test('no recognisable pass boundary leaves freshness to decide', () => {
  const r = evaluateReconLog('some truncated garbage with no marker', { nowMs: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.passes, 0);
});
