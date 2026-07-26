/**
 * Tests for the P3 parity-gate evaluator (scripts/audit/zone-parity-report.js).
 * Gate thresholds from refactors/2026-07-12-btc-exchange-native-migration-plan.md:
 *   ≥14 days · POC/VAH/VAL median |Δ| ≤ 0.10% of price, p95 ≤ 0.25%
 *   trigger agreement ≥ 95% · CVD-sign ≥ 99% · OI-trend ≥ 99%
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateGate } = require('../scripts/audit/zone-parity-report');

const DAY = 86_400_000;

// Build a synthetic parity line. Δ is applied to mkt levels as % of price.
function line(tMs, { deltaPct = 0, trigTv = null, trigMkt = null, cvdTv = 0, cvdMkt = 0, oiTv = 100, oiMkt = 100 } = {}) {
  const price = 60000;
  const d = price * deltaPct / 100;
  return {
    ts: new Date(tMs).toISOString(), price,
    tv:  { poc: 60000, vah: 61000, val: 59000, trigger: trigTv },
    mkt: { poc: 60000 + d, vah: 61000 + d, val: 59000 + d, trigger: trigMkt },
    cvdTv, cvdMkt, oiTv, oiMkt,
  };
}

test('evaluateGate passes on 15 days of near-perfect agreement', () => {
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  const lines = Array.from({ length: 30 }, (_, i) =>
    line(t0 + i * DAY / 2, { deltaPct: 0.01, cvdTv: i, cvdMkt: i * 2, oiTv: 100 + i, oiMkt: 200 + i }));
  const g = evaluateGate(lines);
  assert.equal(g.days >= 14, true);
  assert.equal(g.verdict, 'PASS');
  assert.ok(g.metrics.poc.median <= 0.10);
  assert.equal(g.metrics.triggerAgreementPct, 100); // all null-vs-null = agree
  assert.equal(g.metrics.cvdSignAgreementPct, 100); // both monotonic up
  assert.equal(g.metrics.oiTrendAgreementPct, 100);
});

test('evaluateGate reports INSUFFICIENT under 14 days', () => {
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  const lines = [line(t0), line(t0 + 2 * DAY)];
  assert.equal(evaluateGate(lines).verdict, 'INSUFFICIENT');
});

test('evaluateGate fails when POC median delta exceeds 0.10%', () => {
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  const lines = Array.from({ length: 30 }, (_, i) => line(t0 + i * DAY / 2, { deltaPct: 0.5 }));
  const g = evaluateGate(lines);
  assert.equal(g.verdict, 'FAIL');
  assert.ok(g.failures.some(f => f.includes('poc')));
});

test('evaluateGate scores trigger agreement on type+direction', () => {
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  const trig = { type: 'VAL', direction: 'long', mid: 59000 };
  const lines = [
    line(t0, { trigTv: trig, trigMkt: { ...trig } }),                                   // agree
    line(t0 + DAY, { trigTv: trig, trigMkt: null }),                                    // disagree
    line(t0 + 2 * DAY, { trigTv: null, trigMkt: null }),                                // agree
    line(t0 + 15 * DAY, { trigTv: trig, trigMkt: { ...trig, direction: 'short' } }),    // disagree
  ];
  const g = evaluateGate(lines);
  assert.equal(g.metrics.triggerAgreementPct, 50);
  assert.equal(g.verdict, 'FAIL'); // 50% < 95%
});

test('evaluateGate fails on CVD delta-sign disagreement', () => {
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  // cvdTv rises every step; cvdMkt falls every step → 0% sign agreement
  const lines = Array.from({ length: 30 }, (_, i) =>
    line(t0 + i * DAY / 2, { cvdTv: i, cvdMkt: -i }));
  const g = evaluateGate(lines);
  assert.equal(g.metrics.cvdSignAgreementPct, 0);
  assert.ok(g.failures.some(f => f.includes('cvd')));
});

test('evaluateGate fails on any native blind cycle, tolerates TV blindness', () => {
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  const lines = Array.from({ length: 30 }, (_, i) =>
    line(t0 + i * DAY / 2, { deltaPct: 0.01, cvdTv: i, cvdMkt: i * 2, oiTv: 100 + i, oiMkt: 200 + i }));
  // one TV-blind cycle: informational, must not gate
  lines[3].tv = { poc: null, vah: null, val: null, trigger: null };
  let g = evaluateGate(lines);
  assert.equal(g.metrics.tvBlindCycles, 1);
  assert.equal(g.metrics.nativeBlindCycles, 0);
  assert.ok(!g.failures.some(f => f.includes('native blind')));
  // one native-blind cycle: hard gate failure (spec 06 — 0 blind on native path)
  lines[5].mkt = { poc: null, vah: null, val: null, trigger: null };
  g = evaluateGate(lines);
  assert.equal(g.metrics.nativeBlindCycles, 1);
  assert.equal(g.verdict, 'FAIL');
  assert.ok(g.failures.some(f => f.includes('native blind cycles 1 > 0')));
});

test('evaluateGate reports non-gated pocFresh metric when present', () => {
  const t0 = Date.parse('2026-07-01T00:00:00Z');
  const lines = Array.from({ length: 30 }, (_, i) => {
    const l = line(t0 + i * DAY / 2, { deltaPct: 5 }); // stale max-row POC way off
    l.tv.pocFresh = l.mkt.poc;                          // fresh POC matches exactly
    return l;
  });
  const g = evaluateGate(lines);
  assert.equal(g.metrics.pocFresh.median, 0);           // fresh agrees
  assert.ok(g.failures.some(f => f.includes('poc')));   // gated (stale) poc fails
  assert.ok(!g.failures.some(f => f.includes('pocFresh'))); // fresh never gates
});
