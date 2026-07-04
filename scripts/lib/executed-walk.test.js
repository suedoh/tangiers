'use strict';

/**
 * Unit tests for the executed-hypothetical ladder walk.
 * Run: node scripts/lib/executed-walk.test.js
 */

const assert = require('assert');
const { walkExecutedLadder, ladderRungs } = require('./executed-walk');

// Long plan: entry 100, stop 90 (risk 10), tps at 1R/2R/3R.
const LONG = { direction: 'long', entry: 100, stop: 90, tp1: 110, tp2: 120, tp3: 130 };
// Short plan mirroring the June defect shape: tp3 is a distant zone (42.5R).
const SHORT = { direction: 'short', entry: 65684, stop: 65827, tp1: 65398, tp2: 65255, tp3: 59610 };

function bar(time, high, low) { return { time, high, low }; }

// 1. Straight stop, no rungs banked → -1R.
assert.deepStrictEqual(
  walkExecutedLadder(LONG, [bar(1, 105, 89)]),
  { outcome: 'stop', pnlR: -1, closedBarTime: 1 },
  'straight stop pays -1R'
);

// 2. tp1 banked, then stop → 1/3·1R − 2/3·1R = −0.33R (not full rr1).
assert.deepStrictEqual(
  walkExecutedLadder(LONG, [bar(1, 111, 99), bar(2, 112, 89)]),
  { outcome: 'stop', pnlR: -0.33, closedBarTime: 2 },
  'tp1-then-stop nets banked rung minus remainder'
);

// 3. Full tp3 run → (1+2+3)/3 = 2R, NOT 3R (cause-1 payoff fix).
assert.deepStrictEqual(
  walkExecutedLadder(LONG, [bar(1, 111, 99), bar(2, 121, 105), bar(3, 131, 110)]),
  { outcome: 'tp3', pnlR: 2, closedBarTime: 3 },
  'perfect tp3 ladder pays 2R'
);

// 4. One giant bar through all three rungs banks all three at once.
assert.deepStrictEqual(
  walkExecutedLadder(LONG, [bar(1, 131, 95)]),
  { outcome: 'tp3', pnlR: 2, closedBarTime: 1 },
  'single bar through all rungs pays full ladder'
);

// 5. Same-bar ambiguity: stop wins, rungs in that bar do NOT bank.
assert.deepStrictEqual(
  walkExecutedLadder(LONG, [bar(1, 131, 89)]),
  { outcome: 'stop', pnlR: -1, closedBarTime: 1 },
  'stop-first on ambiguous bar'
);

// 6. Still open (no level touched) → null.
assert.strictEqual(walkExecutedLadder(LONG, [bar(1, 105, 95)]), null, 'open ladder returns null');

// 7. Short direction + distant tp3: full run pays (2 + 3 + 42.47…)/3 ≈ 15.83R,
//    never the phantom 42.5R the first-touch walk credited.
const shortRun = walkExecutedLadder(SHORT, [
  bar(1, 65700, 65390),  // tp1
  bar(2, 65400, 65250),  // tp2
  bar(3, 65300, 59600),  // tp3
]);
assert.strictEqual(shortRun.outcome, 'tp3');
assert.ok(Math.abs(shortRun.pnlR - 15.83) < 0.01, `distant-tp3 ladder pays ~15.83R, got ${shortRun.pnlR}`);

// 8. Short: rungs banked then stop → 1/3·2R + 1/3·3R − 1/3·1R = +1.33R labeled 'stop'.
const shortStop = walkExecutedLadder(SHORT, [
  bar(1, 65700, 65390),  // tp1 (2R)
  bar(2, 65400, 65250),  // tp2 (3R)
  bar(3, 65900, 65300),  // stop
]);
assert.deepStrictEqual(shortStop, { outcome: 'stop', pnlR: 1.33, closedBarTime: 3 });

// 9. Unusable plans → null.
assert.strictEqual(walkExecutedLadder({ direction: 'long', entry: 100, stop: 100, tp1: 110 }, [bar(1, 111, 99)]), null, 'zero risk distance');
assert.strictEqual(ladderRungs({ direction: 'long', entry: 100, stop: 90 }), null, 'no TPs');

// 10. Two-rung plan splits 1/2 each.
const twoRung = walkExecutedLadder(
  { direction: 'long', entry: 100, stop: 90, tp1: 110, tp2: 120, tp3: null },
  [bar(1, 121, 99)]
);
assert.deepStrictEqual(twoRung, { outcome: 'tp2', pnlR: 1.5, closedBarTime: 1 }, '2-rung ladder: (1+2)/2');

console.log('executed-walk.test.js: all 10 assertions passed');
