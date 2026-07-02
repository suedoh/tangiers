#!/usr/bin/env node
'use strict';

/**
 * Phase D attribution — trades.json hypothetical vs BloFin exchange truth.
 *
 * For every executionStatus==='placed' signal: joins blofin_orders (Mongo)
 * to the exchange fills-history, sums exchange-computed fillPnl + fees per
 * signal, converts to R using the signal's own risk unit (filled size ×
 * planned stop distance), and diffs against trades.json pnlR.
 *
 * Untracked closing fills (SL-trigger market orders never enter the book)
 * are attributed by size+time matching against each signal's open remainder.
 * Signals whose entries netted against a pre-existing opposite position
 * (net-mode cross-cancellation) are flagged CROSS-NET — their fillPnl is
 * measured by the exchange against the OLD position's avg cost and is not
 * comparable per-signal.
 *
 * Classes:
 *   CLEAN        — tracked entry + exits fully attributable
 *   SL-UNTRACKED — remainder closed by a matched untracked fill (SL trigger)
 *   CROSS-NET    — entry reduced an opposite net position; per-signal R unreliable
 *   NO-HYPO      — executed on exchange but trades.json outcome is null
 *                  (unconfirmed signals never bar-walk — model mismatch)
 *
 * Usage: node scripts/audit/phase-d-attribution.js [--since 2026-06-16]
 * Read-only. Re-run at the D→E gate with a bigger cohort.
 */

const fs   = require('fs');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');
const db     = require('../lib/db');

const CONTRACT_BTC = 0.001;
const sinceArg = process.argv.indexOf('--since');
const SINCE = Date.parse(sinceArg > -1 ? process.argv[sinceArg + 1] : '2026-06-16T00:00:00Z');

async function fetchAllFills() {
  // `after` pages toward OLDER records by tradeId (OKX-style; probed 2026-07-02).
  let all = [], cursor;
  for (let page = 0; page < 30; page++) {
    const rows = await blofin.getTradeHistory({ instId: 'BTC-USDT', limit: 100, after: cursor }) || [];
    if (!rows.length) break;
    all = all.concat(rows);
    cursor = rows[rows.length - 1].tradeId;
    if (Number(rows[rows.length - 1].ts) < SINCE) break;
  }
  return all
    .filter(f => Number(f.ts) >= SINCE)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

function r2(x) { return Math.round(x * 100) / 100; }

async function main() {
  await db.connect();
  const trades = JSON.parse(fs.readFileSync(path.join(ROOT, 'trades.json'), 'utf8'));
  const placed = trades.filter(t => t.executionStatus === 'placed'
    && new Date(t.firedAt).getTime() >= SINCE);

  const fills = await fetchAllFills();
  const docs  = await db.blofinOrders().find({ env: 'demo', signalId: { $ne: null } }).toArray();
  const docsBySignal = new Map();
  for (const d of docs) {
    if (!docsBySignal.has(d.signalId)) docsBySignal.set(d.signalId, []);
    docsBySignal.get(d.signalId).push(d);
  }
  const trackedOrderIds = new Set(docs.map(d => d.orderId));
  const orderToSignal   = new Map(docs.map(d => [d.orderId, d.signalId]));

  // Split fills: tracked (joinable by orderId) vs untracked (SL triggers,
  // probe cleanups, manual actions).
  const tracked = [], untracked = [];
  for (const f of fills) (trackedOrderIds.has(f.orderId) ? tracked : untracked).push(f);

  // Per-signal accumulation from tracked fills.
  const sig = new Map();
  for (const t of placed) {
    sig.set(t.id, {
      t, pnl: 0, fees: 0, entrySize: 0, closedSize: 0,
      entryPnl: 0, notes: [], class: 'CLEAN', matchedUntracked: [],
    });
  }
  for (const f of tracked) {
    const s = sig.get(orderToSignal.get(f.orderId));
    if (!s) continue; // probe signals etc.
    const isEntry = (docsBySignal.get(s.t.id) || []).find(d => d.orderId === f.orderId && d.orderType === 'market' && !d.kind);
    s.pnl  += Number(f.fillPnl);
    s.fees += Number(f.fee);
    if (isEntry) {
      s.entrySize += Number(f.fillSize);
      s.entryPnl  += Number(f.fillPnl);
      // A market ENTRY should open exposure at pnl≈0. Nonzero entry pnl means
      // the exchange netted it against an existing opposite position.
      if (Math.abs(Number(f.fillPnl)) > 0.05) s.class = 'CROSS-NET';
    } else {
      s.closedSize += Number(f.fillSize);
    }
  }

  // Attribute untracked closing fills to signals by size/time: candidate must
  // close in the signal's direction (buy closes short), match the signal's
  // open remainder within one lot (0.1), and land after the entry.
  for (const f of untracked) {
    const size = Number(f.fillSize);
    const candidates = [...sig.values()].filter(s => {
      const rem = r2(s.entrySize - s.closedSize);
      const closesDir = s.t.direction === 'short' ? f.side === 'buy' : f.side === 'sell';
      return closesDir && rem > 0 && Math.abs(rem - size) <= 0.35
        && Number(f.ts) > new Date(s.t.firedAt).getTime();
    }).sort((a, b) => new Date(a.t.firedAt) - new Date(b.t.firedAt));
    if (candidates.length) {
      const s = candidates[0];
      s.pnl  += Number(f.fillPnl);
      s.fees += Number(f.fee);
      s.closedSize += size;
      s.matchedUntracked.push(f.orderId);
      if (s.class === 'CLEAN') s.class = 'SL-UNTRACKED';
    }
  }

  // Table
  console.log('signalId'.padEnd(28), 'dir'.padEnd(6), 'tj_out'.padEnd(12), 'tjR'.padEnd(6),
    'exch$'.padEnd(9), 'fees$'.padEnd(7), 'exR'.padEnd(7), 'ΔR'.padEnd(7), 'class');
  console.log('-'.repeat(105));

  let nCompared = 0, sumTjR = 0, sumExR = 0, sumDelta = 0, sumAbsDelta = 0;
  let cohortPnl = 0, cohortFees = 0;
  const rows = [];

  for (const s of sig.values()) {
    const t = s.t;
    const stopDist = Math.abs(t.entry - t.stop);
    const rDollar  = s.entrySize * stopDist * CONTRACT_BTC; // risk unit at ACTUAL filled size
    const exR      = rDollar > 0 ? (s.pnl - s.fees) / rDollar : null;
    const noHypo   = t.pnlR == null;
    const cls      = noHypo ? (s.class === 'CLEAN' ? 'NO-HYPO' : s.class + '+NO-HYPO') : s.class;
    const remainder = r2(s.entrySize - s.closedSize);

    cohortPnl  += s.pnl;
    cohortFees += s.fees;

    const comparable = !noHypo && !cls.startsWith('CROSS-NET');
    let delta = null;
    if (comparable && exR != null) {
      delta = exR - t.pnlR;
      nCompared++; sumTjR += t.pnlR; sumExR += exR; sumDelta += delta; sumAbsDelta += Math.abs(delta);
    }

    rows.push({ id: t.id, cls, remainder });
    console.log(t.id.padEnd(28), t.direction.padEnd(6), String(t.outcome).padEnd(12),
      String(t.pnlR ?? '—').padEnd(6),
      s.pnl.toFixed(2).padEnd(9), s.fees.toFixed(2).padEnd(7),
      (exR != null ? exR.toFixed(2) : '—').padEnd(7),
      (delta != null ? (delta >= 0 ? '+' : '') + delta.toFixed(2) : '—').padEnd(7),
      cls + (remainder > 0.3 ? ` (open remainder ${remainder})` : ''));
  }

  console.log('-'.repeat(105));
  console.log(`Comparable pairs (CLEAN/SL-UNTRACKED with hypo): n=${nCompared}`);
  if (nCompared) {
    console.log(`  trades.json ΣR: ${sumTjR.toFixed(2)}   exchange ΣR (net of fees): ${sumExR.toFixed(2)}`);
    console.log(`  mean ΔR/signal: ${(sumDelta / nCompared).toFixed(2)}   mean |ΔR|: ${(sumAbsDelta / nCompared).toFixed(2)}`);
    console.log(`  cohort-level gap: ${sumTjR !== 0 ? ((sumExR - sumTjR) / Math.abs(sumTjR) * 100).toFixed(0) + '%' : 'n/a'} vs trades.json`);
  }
  console.log(`Placed-cohort exchange dollars: pnl $${cohortPnl.toFixed(2)}  fees $${cohortFees.toFixed(2)}  net $${(cohortPnl - cohortFees).toFixed(2)}`);

  const untrackedUnmatched = untracked.filter(f =>
    ![...sig.values()].some(s => s.matchedUntracked.includes(f.orderId)));
  const umPnl = untrackedUnmatched.reduce((a, f) => a + Number(f.fillPnl), 0);
  const umFee = untrackedUnmatched.reduce((a, f) => a + Number(f.fee), 0);
  console.log(`Unmatched untracked fills (probes, legacy-position trims): ${untrackedUnmatched.length}  pnl $${umPnl.toFixed(2)}  fees $${umFee.toFixed(2)}`);

  await db.disconnect();
}

main().catch(async e => {
  console.error('FAIL:', e.message);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
