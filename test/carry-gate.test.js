/**
 * Tests for the carry engine's open/close gate (scripts/carry/monitor.js).
 *
 * The gate is the entire strategy — there is no forecast anywhere in this system,
 * just "does the payment beat the toll". These pin the economics so a future edit
 * cannot quietly loosen them, which is exactly how the old signal pipeline ended
 * up publishing 85% win rates on a 50% signal.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateGate, ROUND_TRIP, CAPITAL_MULT, MIN_HOLD_DAYS } =
  require('../scripts/carry/monitor');

/** Build a snapshot with a given annualised trailing carry. */
const snap = annualised => ({
  trailAnn: annualised,
  trailMean: annualised / (3 * 365),
  spot: 63000, mark: 63010, basis: 0.00016, nextFunding: 0.0001,
  posShare: 0.9, nRates: 90,
});

test('round-trip cost is 8bp — four passive legs', () => {
  // 2 perp maker (2bp) + 2 spot maker (2bp). Round 7 showed taker execution
  // turns the current regime negative, so passive fills are a precondition.
  assert.equal(Math.round(ROUND_TRIP * 1e4), 8);
});

test('a rich carry regime opens the trade', () => {
  // 2021 levels — 30%/yr.
  const g = evaluateGate(snap(0.30));
  assert.equal(g.open, true);
  assert.ok(g.netAnn > 0.20, `expected healthy net, got ${g.netAnn}`);
});

test('the 2026 regime (1.83%/yr) does NOT open the trade', () => {
  // This is the measured current-regime carry from round 7. The gate must
  // refuse it — net of cost it is indistinguishable from zero.
  const g = evaluateGate(snap(0.0183));
  assert.equal(g.open, false);
  assert.match(g.reason, /< required/);
});

test('negative carry never opens, however large in magnitude', () => {
  // Funding was negative on 33% of 2026 settlements. Short-perp PAYS then.
  const g = evaluateGate(snap(-0.50));
  assert.equal(g.open, false);
  assert.match(g.reason, /negative/);
});

test('cost is amortised over the minimum hold, not per cycle', () => {
  // The trade is a hold-duration business: at 3×8h holds round 7 measured
  // −95%/yr at taker fees purely because the fixed cost dominates.
  const g = evaluateGate(snap(0.10));
  const expectedCost = ROUND_TRIP * (365 / MIN_HOLD_DAYS);
  assert.ok(Math.abs(g.costAnn - expectedCost) < 1e-12);
});

test('return is stated on capital, not notional', () => {
  // Notional-based returns would flatter the strategy by the leverage factor.
  const carry = 0.20;
  const g = evaluateGate(snap(carry));
  const expected = (carry - ROUND_TRIP * (365 / MIN_HOLD_DAYS)) / CAPITAL_MULT;
  assert.ok(Math.abs(g.netAnn - expected) < 1e-12);
  assert.ok(CAPITAL_MULT > 1, 'spot leg must be fully funded');
});

test('the gate demands margin over break-even, not merely positive', () => {
  // A carry that only just covers cost must be refused — round 7 measured
  // 2026 net at +0.2%/yr, which is noise, not a business.
  const costAnn = ROUND_TRIP * (365 / MIN_HOLD_DAYS);
  const barelyPositive = costAnn + 0.001;
  const g = evaluateGate(snap(barelyPositive));
  assert.equal(g.open, false, 'a hair above break-even must not open');
});
