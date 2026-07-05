'use strict';

/** Run: node scripts/lib/parse-num.test.js */

const assert = require('assert');
const { parseStudyNum } = require('./parse-num');

// The two audit defects:
assert.strictEqual(parseStudyNum('−1.92K'), -1920, 'Unicode minus + K suffix');
assert.strictEqual(parseStudyNum('−980'), -980, 'Unicode minus, no suffix');
assert.strictEqual(parseStudyNum('1.92K'), 1920, 'K expands');
assert.strictEqual(parseStudyNum('6.23M'), 6230000, 'M expands');
assert.strictEqual(parseStudyNum('1.5B'), 1.5e9, 'B expands');

// Scale coherence across a K boundary (old parser: 980 vs 1.02 — garbage delta)
assert.ok(parseStudyNum('1.02M') > parseStudyNum('980K'), 'cross-boundary ordering');

// Formats that must keep working:
assert.strictEqual(parseStudyNum('62,921.50'), 62921.5, 'comma thousands');
assert.strictEqual(parseStudyNum('$62,921.50'), 62921.5, 'currency prefix');
assert.strictEqual(parseStudyNum('-123.4'), -123.4, 'ASCII minus');
assert.strictEqual(parseStudyNum('980'), 980, 'plain integer');
assert.strictEqual(parseStudyNum(42.5), 42.5, 'number passthrough');

// Suffix false-positive guard:
assert.strictEqual(parseStudyNum('106.84 BTC'), 106.84, 'B of BTC is not billions');
assert.strictEqual(parseStudyNum('24 Mio'), 24, 'M of Mio is not millions');

// Junk:
assert.strictEqual(parseStudyNum(null), null);
assert.strictEqual(parseStudyNum('∅'), null, 'empty-set glyph');
assert.strictEqual(parseStudyNum('n/a'), null);
assert.strictEqual(parseStudyNum(NaN), null);

console.log('parse-num.test.js: all assertions passed');
