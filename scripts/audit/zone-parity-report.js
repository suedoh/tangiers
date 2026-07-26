#!/usr/bin/env node
/**
 * zone-parity-report.js — P3 gate evaluation for the exchange-native migration
 * (refactors/2026-07-12-btc-exchange-native-migration-plan.md).
 *
 * Reads logs/zone-parity.jsonl (written every cycle by the P2 sidecar in
 * trigger-check.js) and scores the quantified go/no-go gate:
 *
 *   ≥14 days of samples
 *   POC/VAH/VAL: median |Δ| ≤ 0.10% of price, p95 ≤ 0.25%
 *   Trigger-decision agreement ≥ 95%
 *   CVD delta-sign agreement ≥ 99%
 *   OI trend-sign agreement  ≥ 99%
 *
 * Usage: node scripts/audit/zone-parity-report.js
 * Exit code: 0 PASS · 1 FAIL · 2 INSUFFICIENT
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const LOG_FILE = path.join(ROOT, 'logs', 'zone-parity.jsonl');

const GATE = {
  minDays: 14,
  levelMedianPct: 0.10,
  levelP95Pct: 0.25,
  triggerAgreementPct: 95,
  cvdSignAgreementPct: 99,
  oiTrendAgreementPct: 99,
  nativeBlindMax: 0, // spec 06 gate: 0 blind cycles on the exchange-native path
};

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

function signAgreement(lines, keyA, keyB) {
  let agree = 0, total = 0;
  for (let i = 1; i < lines.length; i++) {
    const a1 = lines[i - 1][keyA], a2 = lines[i][keyA];
    const b1 = lines[i - 1][keyB], b2 = lines[i][keyB];
    if (a1 == null || a2 == null || b1 == null || b2 == null) continue;
    const dA = Math.sign(a2 - a1), dB = Math.sign(b2 - b1);
    if (dA === 0 && dB === 0) { agree++; total++; continue; }
    if (dA === 0 || dB === 0) { total++; continue; } // one flat, one moved = disagree
    total++;
    if (dA === dB) agree++;
  }
  return total ? { pct: agree / total * 100, n: total } : { pct: null, n: 0 };
}

function evaluateGate(lines) {
  if (!lines.length) return { verdict: 'INSUFFICIENT', days: 0, metrics: {}, failures: ['no samples'] };

  const days = (Date.parse(lines[lines.length - 1].ts) - Date.parse(lines[0].ts)) / 86_400_000;
  const metrics = {};
  const failures = [];

  // Level deltas as % of price
  for (const lvl of ['poc', 'vah', 'val']) {
    const deltas = lines
      .filter(l => l.tv?.[lvl] != null && l.mkt?.[lvl] != null && l.price)
      .map(l => Math.abs(l.tv[lvl] - l.mkt[lvl]) / l.price * 100)
      .sort((a, b) => a - b);
    const median = quantile(deltas, 0.5);
    const p95 = quantile(deltas, 0.95);
    metrics[lvl] = { median, p95, n: deltas.length };
    if (median == null) failures.push(`${lvl}: no samples`);
    else {
      if (median > GATE.levelMedianPct) failures.push(`${lvl} median ${median.toFixed(3)}% > ${GATE.levelMedianPct}%`);
      if (p95 > GATE.levelP95Pct) failures.push(`${lvl} p95 ${p95.toFixed(3)}% > ${GATE.levelP95Pct}%`);
    }
  }

  // pocFresh: TV's data-store POC vs computed — informational only (never
  // gates). Quantifies how much of any gated-POC disagreement is TV's own
  // stale histogram rows rather than a real methodology gap.
  {
    const deltas = lines
      .filter(l => l.tv?.pocFresh != null && l.mkt?.poc != null && l.price)
      .map(l => Math.abs(l.tv.pocFresh - l.mkt.poc) / l.price * 100)
      .sort((a, b) => a - b);
    metrics.pocFresh = { median: quantile(deltas, 0.5), p95: quantile(deltas, 0.95), n: deltas.length };
  }

  // Trigger agreement: both null, or same type+direction. Scored on LIVE
  // cycles only (spec 06: "decision agreement on live cycles") — a TV-blind
  // cycle says nothing about methodology agreement, and post-cutover the TV
  // shadow will be blind whenever the chart is closed.
  const live = lines.filter(l => l.tv?.poc != null || l.tv?.vah != null);
  let agree = 0;
  for (const l of live) {
    const a = l.tv?.trigger, b = l.mkt?.trigger;
    if (!a && !b) { agree++; continue; }
    if (a && b && a.type === b.type && a.direction === b.direction) agree++;
  }
  metrics.triggerAgreementPct = live.length ? agree / live.length * 100 : null;
  metrics.triggerAgreementN = live.length;
  if (metrics.triggerAgreementPct != null && metrics.triggerAgreementPct < GATE.triggerAgreementPct)
    failures.push(`trigger agreement ${metrics.triggerAgreementPct.toFixed(1)}% < ${GATE.triggerAgreementPct}%`);

  // Blind cycles. The exchange-native side must NEVER be blind — spec 06
  // gate item (rebuild/06-exchange-native-data.md): 0 blind cycles on the
  // native path. TV blindness is informational only (it is the defect class
  // being retired — 14.9% of cycles per audit D10).
  metrics.nativeBlindCycles = lines.filter(l => l.mkt?.poc == null && l.mkt?.vah == null).length;
  metrics.tvBlindCycles     = lines.filter(l => l.tv?.poc == null && l.tv?.vah == null).length;
  if (metrics.nativeBlindCycles > GATE.nativeBlindMax)
    failures.push(`native blind cycles ${metrics.nativeBlindCycles} > ${GATE.nativeBlindMax}`);

  // CVD / OI: sign of change between consecutive samples must match
  const cvd = signAgreement(lines, 'cvdTv', 'cvdMkt');
  metrics.cvdSignAgreementPct = cvd.pct;
  if (cvd.pct != null && cvd.pct < GATE.cvdSignAgreementPct)
    failures.push(`cvd sign agreement ${cvd.pct.toFixed(1)}% < ${GATE.cvdSignAgreementPct}%`);

  const oi = signAgreement(lines, 'oiTv', 'oiMkt');
  metrics.oiTrendAgreementPct = oi.pct;
  if (oi.pct != null && oi.pct < GATE.oiTrendAgreementPct)
    failures.push(`oi trend agreement ${oi.pct.toFixed(1)}% < ${GATE.oiTrendAgreementPct}%`);

  const verdict = days < GATE.minDays ? 'INSUFFICIENT' : failures.length ? 'FAIL' : 'PASS';
  return { verdict, days, samples: lines.length, metrics, failures };
}

function main() {
  let raw;
  try { raw = fs.readFileSync(LOG_FILE, 'utf8'); }
  catch { console.error(`No parity log at ${LOG_FILE} — is the P2 sidecar running?`); process.exit(2); }

  const lines = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const g = evaluateGate(lines);

  console.log(`Zone parity gate — ${g.samples} samples over ${g.days.toFixed(1)} days\n`);
  for (const lvl of ['poc', 'vah', 'val']) {
    const m = g.metrics[lvl];
    console.log(`  ${lvl.toUpperCase().padEnd(4)} median ${m.median?.toFixed(4) ?? '—'}%  p95 ${m.p95?.toFixed(4) ?? '—'}%  (n=${m.n}, gate ≤${GATE.levelMedianPct}/${GATE.levelP95Pct})`);
  }
  if (g.metrics.pocFresh?.n)
    console.log(`  POC(fresh) median ${g.metrics.pocFresh.median?.toFixed(4)}%  p95 ${g.metrics.pocFresh.p95?.toFixed(4)}%  (n=${g.metrics.pocFresh.n}, informational)`);
  console.log(`  Trigger agreement  ${g.metrics.triggerAgreementPct?.toFixed(1) ?? '—'}% on ${g.metrics.triggerAgreementN} live cycles (gate ≥${GATE.triggerAgreementPct}%)`);
  console.log(`  Blind cycles       native ${g.metrics.nativeBlindCycles} (gate ≤${GATE.nativeBlindMax}) · tv ${g.metrics.tvBlindCycles} (informational)`);
  console.log(`  CVD sign agreement ${g.metrics.cvdSignAgreementPct?.toFixed(1) ?? '—'}% (gate ≥${GATE.cvdSignAgreementPct}%)`);
  console.log(`  OI trend agreement ${g.metrics.oiTrendAgreementPct?.toFixed(1) ?? '—'}% (gate ≥${GATE.oiTrendAgreementPct}%)`);
  console.log(`\nVerdict: ${g.verdict}`);
  if (g.failures.length) for (const f of g.failures) console.log(`  ✗ ${f}`);

  process.exit(g.verdict === 'PASS' ? 0 : g.verdict === 'FAIL' ? 1 : 2);
}

if (require.main === module) main();

module.exports = { evaluateGate, GATE };
