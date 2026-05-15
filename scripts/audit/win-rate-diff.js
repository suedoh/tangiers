#!/usr/bin/env node
'use strict';

/**
 * win-rate-diff.js — pre/post comparison of BTC trade metrics.
 *
 * Reads a baseline snapshot JSON (produced by --snapshot) and the current Mongo
 * state, prints a side-by-side diff with Wilson CIs and a verdict (improved /
 * unchanged / regressed) per cohort.
 *
 * Usage:
 *   node scripts/audit/win-rate-diff.js --snapshot OUT.json           # save current state
 *   node scripts/audit/win-rate-diff.js --diff BASELINE.json          # diff current vs baseline
 *   node scripts/audit/win-rate-diff.js --diff BASELINE.json --since 2026-05-15
 *
 * The --since flag scopes "current" to trades fired on/after the given date,
 * so post-change behavior is measured cleanly without pre-change pollution.
 */

const fs = require('fs');
const path = require('path');
const { connect, trades, disconnect } = require('../lib/db');

const FIX_DATE = new Date('2026-04-26T22:29:21Z'); // confirmation race fix

const isWin  = t => ['tp1','tp2','tp3'].includes(t.outcome);
const isLoss = t => t.outcome === 'stop';

function wilson(k, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = k / n;
  const denom = 1 + z*z/n;
  const center = (p + z*z/(2*n)) / denom;
  const margin = (z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function summarise(label, ts) {
  const closed = ts.filter(t => isWin(t) || isLoss(t));
  if (closed.length === 0) return { label, n: 0 };
  const w = closed.filter(isWin).length;
  const [lo, hi] = wilson(w, closed.length);
  const totR = closed.reduce((s, t) => s + (t.pnlR || 0), 0);
  return {
    label,
    n: closed.length, wins: w, losses: closed.length - w,
    wr: w / closed.length, wrCI: [lo, hi],
    totR, avgR: totR / closed.length,
  };
}

function buildSnapshot(docs, sinceDate) {
  const scope = sinceDate ? docs.filter(t => new Date(t.firedAt) >= sinceDate) : docs;
  const conf = scope.filter(t => t.confirmed);
  const clean = conf.filter(t => {
    if (new Date(t.firedAt) < FIX_DATE) return false;
    if (!t.confirmedAt) return false;
    return (new Date(t.confirmedAt) - new Date(t.firedAt)) / 3600000 < 1;
  });
  const byDirZone = {};
  for (const dir of ['long','short']) {
    for (const zone of ['HVN','VAL','VAH']) {
      const sub = scope.filter(t => t.direction === dir && t.zone?.type === zone);
      if (sub.length < 3) continue;
      byDirZone[`${dir}_${zone}`] = summarise(`${dir} × ${zone}`, sub);
    }
  }
  const bySetup = {};
  for (const s of [...new Set(scope.map(t => t.setupType))]) {
    bySetup[s] = summarise(s, scope.filter(t => t.setupType === s));
  }
  return {
    snapshotAt: new Date().toISOString(),
    sinceDate: sinceDate ? sinceDate.toISOString() : null,
    totalSignals: scope.length,
    cohorts: {
      all:       summarise('ALL',        scope),
      confirmed: summarise('CONFIRMED',  conf),
      cleanFast: summarise('CLEAN-FAST', clean),
    },
    byDirZone,
    bySetup,
    anomalies: {
      unconfirmed_stops:     scope.filter(t => !t.confirmed && t.outcome === 'stop').length,
      confirmed_after_close: scope.filter(t => t.confirmed && t.confirmedAt && t.closedAt
                                          && new Date(t.confirmedAt) > new Date(t.closedAt)).length,
      slow_confirms_over_1h: scope.filter(t => t.confirmed && t.confirmedAt
                                          && (new Date(t.confirmedAt) - new Date(t.firedAt))/3600000 >= 1).length,
      zombie_setupType:      scope.filter(t => t.setupType === 'B — Reversal'
                                          || t.setupType === 'A — Trend Continuation').length,
    },
  };
}

function fmtCohort(c) {
  if (!c || !c.n) return 'n=0';
  return `n=${String(c.n).padStart(4)}  wr=${(c.wr*100).toFixed(1)}% [${(c.wrCI[0]*100).toFixed(1)}-${(c.wrCI[1]*100).toFixed(1)}]  avgR=${c.avgR.toFixed(2)}  totR=${c.totR.toFixed(1)}`;
}

function classify(baseC, curC) {
  if (!baseC?.n || !curC?.n) return 'n/a';
  // CIs overlap → unchanged; current CI entirely above baseline point → improved; entirely below → regressed
  if (curC.wrCI[0] > baseC.wr) return '✅ IMPROVED';
  if (curC.wrCI[1] < baseC.wr) return '❌ REGRESSED';
  return '   unchanged';
}

function printDiff(base, cur) {
  console.log(`\nBaseline taken: ${base.snapshotAt}`);
  console.log(`Current taken:  ${cur.snapshotAt}`);
  if (cur.sinceDate) console.log(`Current scoped to firedAt >= ${cur.sinceDate}`);
  console.log(`\nSignals: base=${base.totalSignals}  current=${cur.totalSignals}`);

  console.log('\n=== HEADLINE COHORTS ===');
  for (const k of ['all', 'confirmed', 'cleanFast']) {
    const b = base.cohorts[k];
    const c = cur.cohorts[k];
    console.log(`${k.toUpperCase().padEnd(11)} base: ${fmtCohort(b)}`);
    console.log(`${' '.repeat(11)} curr: ${fmtCohort(c)}   ${classify(b, c)}`);
  }

  console.log('\n=== ANOMALY COUNTS (should drop to 0 post-fix) ===');
  for (const k of Object.keys(base.anomalies)) {
    const b = base.anomalies[k];
    const c = cur.anomalies[k];
    const arrow = c === 0 && b > 0 ? '✅ zeroed' : c < b ? '↘ reduced' : c > b ? '⚠ increased' : '   same';
    console.log(`  ${k.padEnd(24)} base=${String(b).padStart(4)}  curr=${String(c).padStart(4)}  ${arrow}`);
  }

  console.log('\n=== DIRECTION × ZONE ===');
  const allKeys = new Set([...Object.keys(base.byDirZone), ...Object.keys(cur.byDirZone)]);
  for (const k of [...allKeys].sort()) {
    const b = base.byDirZone[k];
    const c = cur.byDirZone[k];
    console.log(`${k.padEnd(12)} base: ${fmtCohort(b)}`);
    console.log(`${' '.repeat(12)} curr: ${fmtCohort(c)}   ${classify(b, c)}`);
  }

  console.log('\n=== SETUP TYPE ===');
  const allSetups = new Set([...Object.keys(base.bySetup), ...Object.keys(cur.bySetup)]);
  for (const k of [...allSetups].sort()) {
    const b = base.bySetup[k];
    const c = cur.bySetup[k];
    console.log(`${k.padEnd(28)} base: ${fmtCohort(b)}`);
    console.log(`${' '.repeat(28)} curr: ${fmtCohort(c)}   ${classify(b, c)}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const snapshotIdx = argv.indexOf('--snapshot');
  const diffIdx     = argv.indexOf('--diff');
  const sinceIdx    = argv.indexOf('--since');
  const sinceDate   = sinceIdx >= 0 ? new Date(argv[sinceIdx + 1]) : null;

  await connect();
  const docs = await trades().find({ instrument: 'BTC' }).toArray();
  await disconnect();

  if (snapshotIdx >= 0) {
    const out = argv[snapshotIdx + 1];
    if (!out) { console.error('Usage: --snapshot <out.json>'); process.exit(1); }
    const snap = buildSnapshot(docs, sinceDate);
    fs.writeFileSync(out, JSON.stringify(snap, null, 2));
    console.log(`Snapshot written to ${out}  (n=${snap.totalSignals})`);
    return;
  }

  if (diffIdx >= 0) {
    const basePath = argv[diffIdx + 1];
    if (!basePath || !fs.existsSync(basePath)) { console.error(`Baseline not found: ${basePath}`); process.exit(1); }
    const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const cur  = buildSnapshot(docs, sinceDate);
    printDiff(base, cur);
    return;
  }

  console.log(`Usage:
  node scripts/audit/win-rate-diff.js --snapshot path/to/out.json
  node scripts/audit/win-rate-diff.js --diff path/to/baseline.json [--since YYYY-MM-DD]`);
}

main().catch(e => { console.error(e); process.exit(1); });
