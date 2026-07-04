#!/usr/bin/env node
'use strict';

/**
 * Re-walk the executed-hypothetical track over FULL Binance 30m history.
 *
 * Why this exists (refactors/2026-07-04-executed-track-ladder-rewalk.md):
 *   1. Four June records were labeled by the pre-guard walk (before the
 *      2026-07-02 "signalTs < bars[0].time" guard landed) — walked from
 *      mid-window bars and credited full-position tp3 at distant zone
 *      targets: +42.7R / +42.5R / +39.4R / +15.3R on a ladder whose honest
 *      ceiling is (rr1+rr2+rr3)/3.
 *   2. All other records carry the first-touch FULL-position payoff the
 *      ladder never pays (attribution cause 1).
 *
 * This script recomputes executedOutcome/executedPnlR/executedClosedAt for
 * every placed signal using lib/executed-walk.js (1/3-ladder payoff) over
 * complete 30m klines from Binance Futures — no CDP, no 7-day window limit.
 * Canonical fields (outcome/pnlR/closedAt) are never touched.
 *
 * Re-runnable; re-run before the D→E gate so long-lived ladders resolve on
 * full history instead of expiring at 0.
 *
 * Usage:
 *   node scripts/blofin/rewalk-executed.js            # dry-run (default)
 *   node scripts/blofin/rewalk-executed.js --apply    # backup + write
 */

const path = require('path');
const fs   = require('fs');

const { getKlinesRange }     = require('../lib/binance');
const { walkExecutedLadder } = require('../lib/executed-walk');

const ROOT        = path.resolve(__dirname, '..', '..');
const TRADES_FILE = path.join(ROOT, 'trades.json');
const APPLY       = process.argv.includes('--apply');
const EXPIRY_MS   = 30 * 24 * 60 * 60 * 1000; // same rule as trigger-check

async function main() {
  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const placed = trades.filter(t => t.executionStatus === 'placed' && t.firedAt);
  if (placed.length === 0) { console.log('no placed signals — nothing to do'); return; }

  const earliest = Math.min(...placed.map(t => new Date(t.firedAt).getTime()));
  console.log(`re-walking ${placed.length} placed signals from ${new Date(earliest).toISOString()}`);

  const klines = await getKlinesRange(earliest, Date.now(), '30m');
  if (klines.length === 0) throw new Error('no klines returned from Binance');
  console.log(`fetched ${klines.length} 30m bars (${new Date(klines[0].openTime).toISOString()} → ${new Date(klines[klines.length - 1].openTime).toISOString()})\n`);

  const bars = klines.map(k => ({ time: k.openTime / 1000, high: k.high, low: k.low }));

  let changed = 0;
  for (const t of placed) {
    const firedSec = new Date(t.firedAt).getTime() / 1000;
    const relevant = bars.filter(b => b.time > firedSec);
    const walk     = walkExecutedLadder(t, relevant);
    const age      = Date.now() - firedSec * 1000;

    let next;
    if (walk) {
      next = {
        executedOutcome:  walk.outcome,
        executedPnlR:     walk.pnlR,
        executedClosedAt: new Date(walk.closedBarTime * 1000).toISOString(),
      };
    } else if (age > EXPIRY_MS) {
      next = { executedOutcome: 'expired', executedPnlR: 0, executedClosedAt: new Date().toISOString() };
    } else {
      next = { executedOutcome: null, executedPnlR: null, executedClosedAt: null };
    }

    const diff = next.executedOutcome !== (t.executedOutcome ?? null)
              || next.executedPnlR    !== (t.executedPnlR ?? null);
    const tag  = diff ? 'CHANGE' : 'same  ';
    console.log(`${tag} ${t.id}  ${t.direction}  ${String(t.executedOutcome ?? 'null').padEnd(7)} ${String(t.executedPnlR ?? '-').padStart(7)}R  →  ${String(next.executedOutcome ?? 'null').padEnd(7)} ${String(next.executedPnlR ?? '-').padStart(7)}R`);

    if (diff && APPLY) {
      Object.assign(t, next);
      changed++;
    } else if (diff) {
      changed++;
    }
  }

  const resolved = placed
    .map(t => (APPLY ? t.executedPnlR : null))
    .filter(v => typeof v === 'number');
  console.log(`\n${changed} record(s) ${APPLY ? 'updated' : 'would change'}`);

  if (APPLY) {
    const bak = `${TRADES_FILE}.bak-rewalk-${Math.floor(Date.now() / 1000)}`;
    fs.copyFileSync(TRADES_FILE, bak);
    const tmp = TRADES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
    fs.renameSync(tmp, TRADES_FILE);
    const total = resolved.reduce((s, v) => s + v, 0);
    console.log(`backup: ${path.basename(bak)}`);
    console.log(`written. executed track now: n=${resolved.length} resolved, total ${total.toFixed(2)}R, mean ${(total / resolved.length).toFixed(2)}R/signal`);
  } else {
    console.log('dry-run — pass --apply to write (a timestamped .bak is taken first)');
  }
}

main().catch(e => { console.error(`rewalk-executed failed: ${e.message}`); process.exit(1); });
