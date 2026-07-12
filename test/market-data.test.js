/**
 * Known-answer tests for scripts/lib/market-data.js — the exchange-native
 * indicator engine (P0 of refactors/2026-07-12-btc-exchange-native-migration-plan.md).
 *
 * Run: npm test  (node --test test/)
 *
 * All fixtures are hand-computable. No network: fetch tests use an injected
 * fake fetcher. Live-API verification is a separate probe (make zone-probe).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  parseKline,
  computeCVD,
  computeVWAP,
  computeSessionVP,
  buildVolumeProfile,
  fetchKlines,
  loadKlinesCached,
} = require('../scripts/lib/market-data');

// ─── parseKline ───────────────────────────────────────────────────────────────

test('parseKline maps Binance kline array to bar object', () => {
  // [openTime, o, h, l, c, vol, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore]
  const raw = [1700000000000, '100.5', '110.25', '99.75', '105.0', '42.5', 1700000299999, '4462.5', 123, '30.5', '3202.5', '0'];
  assert.deepEqual(parseKline(raw), {
    t: 1700000000000, o: 100.5, h: 110.25, l: 99.75, c: 105.0, v: 42.5, tb: 30.5,
  });
});

// ─── computeCVD ───────────────────────────────────────────────────────────────

test('computeCVD sums (2×takerBuy − volume) across bars', () => {
  // bar1: 2×7−10 = +4; bar2: 2×5−20 = −10 → cumulative −6
  const bars = [
    { v: 10, tb: 7 },
    { v: 20, tb: 5 },
  ];
  assert.equal(computeCVD(bars), -6);
});

test('computeCVD of empty array is 0', () => {
  assert.equal(computeCVD([]), 0);
});

// ─── computeVWAP ──────────────────────────────────────────────────────────────

test('computeVWAP is volume-weighted hlc3 anchored at first bar', () => {
  // bar1 hlc3 = (110+90+100)/3 = 100, v=10 → 1000
  // bar2 hlc3 = (220+180+200)/3 = 200, v=10 → 2000
  // vwap = 3000 / 20 = 150
  const bars = [
    { h: 110, l: 90,  c: 100, v: 10 },
    { h: 220, l: 180, c: 200, v: 10 },
  ];
  assert.equal(computeVWAP(bars), 150);
});

test('computeVWAP returns null with no volume', () => {
  assert.equal(computeVWAP([{ h: 1, l: 1, c: 1, v: 0 }]), null);
});

// ─── computeSessionVP ─────────────────────────────────────────────────────────

test('computeSessionVP splits volume by bar direction', () => {
  const bars = [
    { o: 1, c: 2, v: 5 },   // up bar
    { o: 2, c: 1, v: 3 },   // down bar
    { o: 2, c: 2, v: 4 },   // flat counts as up (c >= o)
  ];
  assert.deepEqual(computeSessionVP(bars), { up: 9, down: 3, total: 12 });
});

// ─── buildVolumeProfile ───────────────────────────────────────────────────────

// Craft bars whose hlc3 lands in known buckets. rowSize=10, range 100–150.
// Bucket volumes: [100–110): 5, [110–120): 30, [120–130): 40, [130–140): 15, [140–150): 10
// (bar h/l chosen so min(l)=100, max(h)=150 fixes the range; hlc3 = target bucket center)
function fixtureBars() {
  // hlc3 = (h+l+c)/3; choose h=l=c=center so hlc3 = center exactly
  const bar = (center, v, tb) => ({ t: 0, o: center, h: center, l: center, c: center, v, tb });
  return [
    { ...bar(105, 5, 3),  l: 100 },      // pins range low at 100
    bar(115, 30, 20),
    bar(125, 40, 10),
    bar(135, 15, 15),
    { ...bar(145, 10, 2), h: 150 },      // pins range high at 150
  ];
}

test('buildVolumeProfile buckets volume at hlc3 with up/down split', () => {
  const p = buildVolumeProfile(fixtureBars(), { rowSize: 10 });
  assert.equal(p.rows.length, 5);
  // rows ascending, VRVP_EXPR-compatible shape
  assert.deepEqual(Object.keys(p.rows[0]).sort(), ['dv', 'hi', 'lo', 'tv', 'uv']);
  assert.deepEqual(p.rows.map(r => r.tv), [5, 30, 40, 15, 10]);
  // hlc3 of bar 0 = (100+105+105)/3 = 103.33 → still bucket [100,110)
  assert.deepEqual(p.rows.map(r => [r.lo, r.hi]), [[100, 110], [110, 120], [120, 130], [130, 140], [140, 150]]);
  // up = takerBuy, down = v − takerBuy
  assert.equal(p.rows[1].uv, 20);
  assert.equal(p.rows[1].dv, 10);
});

test('buildVolumeProfile POC is center of max-volume row', () => {
  const p = buildVolumeProfile(fixtureBars(), { rowSize: 10 });
  assert.equal(p.poc, 125);
});

test('buildVolumeProfile VAH/VAL via 70% value-area greedy expansion', () => {
  // total = 100, target = 70. Start POC row [120,130) = 40.
  // Neighbors: below 30 vs above 15 → add below → 70 ≥ 70 → stop.
  // VA rows = [110,130) → VAL = 110, VAH = 130.
  const p = buildVolumeProfile(fixtureBars(), { rowSize: 10 });
  assert.equal(p.val, 110);
  assert.equal(p.vah, 130);
});

test('buildVolumeProfile handles empty buckets in range', () => {
  // Two bars far apart → gap buckets exist with tv=0 (mirrors TV row grid)
  const bar = (center, v, tb) => ({ t: 0, o: center, h: center, l: center, c: center, v, tb });
  const p = buildVolumeProfile([bar(100, 10, 5), bar(140, 10, 5)], { rowSize: 10 });
  assert.equal(p.rows.length, 5); // 100,110,120,130,140
  assert.deepEqual(p.rows.map(r => r.tv), [10, 0, 0, 0, 10]);
});

test('buildVolumeProfile returns null for insufficient data', () => {
  assert.equal(buildVolumeProfile([], { rowSize: 10 }), null);
});

// ─── fetchKlines (paginated, injected fetcher) ────────────────────────────────

test('fetchKlines paginates until short page and concatenates', async () => {
  const calls = [];
  // Fake Binance: page 1 = 1500 bars from startTime, page 2 = 10 bars, done.
  const fakeFetcher = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const start = parseInt(u.searchParams.get('startTime'));
    const limit = parseInt(u.searchParams.get('limit'));
    const n = calls.length === 1 ? limit : 10;
    return Array.from({ length: n }, (_, i) => {
      const t = start + i * 300000; // 5m spacing
      return [t, '1', '1', '1', '1', '1', t + 299999, '1', 1, '0.5', '0.5', '0'];
    });
  };

  const bars = await fetchKlines({
    symbol: 'BTCUSDT', interval: '5m',
    startTime: 1700000000000, endTime: 1700000000000 + 1510 * 300000,
    fetcher: fakeFetcher,
  });

  assert.equal(calls.length, 2);
  assert.equal(bars.length, 1510);
  // page 2 must start after page 1's last bar (no overlap)
  assert.equal(bars[1500].t, 1700000000000 + 1500 * 300000);
  // all parsed to bar objects
  assert.equal(bars[0].tb, 0.5);
});

// ─── loadKlinesCached (incremental) ───────────────────────────────────────────

test('loadKlinesCached fetches full window once, then only the tail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-'));
  const cacheFile = path.join(dir, 'klines-5m.json');
  const BAR = 300000;
  // 1700000400000 is exactly divisible by 300000 — keeps the fake fetcher's
  // bar grid aligned with the window edges so counts are exact.
  const now = 1700000400000 + 100 * BAR;
  const windowMs = 50 * BAR;

  let fetchedRanges = [];
  const fakeFetcher = async (url) => {
    const u = new URL(url);
    const start = parseInt(u.searchParams.get('startTime'));
    const end = parseInt(u.searchParams.get('endTime'));
    fetchedRanges.push([start, end]);
    const out = [];
    for (let t = Math.ceil(start / BAR) * BAR; t <= end; t += BAR) {
      out.push([t, '1', '1', '1', '1', '1', t + BAR - 1, '1', 1, '0.5', '0.5', '0']);
    }
    return out;
  };

  // First load: full window
  const bars1 = await loadKlinesCached({ symbol: 'BTCUSDT', interval: '5m', windowMs, cacheFile, fetcher: fakeFetcher, now });
  assert.equal(bars1.length, 51); // inclusive aligned grid over 50-bar window
  assert.equal(fetchedRanges.length, 1);
  assert.equal(fetchedRanges[0][0], now - windowMs);

  // Second load 2 bars later: only fetches from last cached bar, prunes old
  fetchedRanges = [];
  const now2 = now + 2 * BAR;
  const bars2 = await loadKlinesCached({ symbol: 'BTCUSDT', interval: '5m', windowMs, cacheFile, fetcher: fakeFetcher, now: now2 });
  assert.equal(fetchedRanges.length, 1);
  assert.ok(fetchedRanges[0][0] >= now - BAR, 'tail fetch starts at last cached bar, not window start');
  assert.equal(bars2.length, 51); // window slid: same bar count, pruned front
  assert.equal(bars2[0].t, now2 - windowMs);

  fs.rmSync(dir, { recursive: true, force: true });
});
