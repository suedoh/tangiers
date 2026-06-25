#!/usr/bin/env node
'use strict';

/**
 * One-time backfill: stamp executionStatus on historical Phase-D BTC signals
 * so the Phase-D paper-vs-hypothetical comparison can separate executed
 * signals from bug-drops and pre-launch signals.
 *
 * Going forward, markExecution() in trigger-check.js stamps this live. This
 * script only labels the signals that fired BEFORE that tagging existed.
 *
 * Ground-truth derivation (no fragile log parsing):
 *   placed              — a blofin_orders doc exists for the signalId (env=demo)
 *   skipped(pre-launch) — fired before the autotrade hook shipped (commit 36a69a4)
 *   dropped             — post-launch, fully-qualified, but NO exchange order
 *                         (the API-timeout bug bucket)
 *
 * Safe: backs up trades.json first; idempotent (re-runnable); only touches
 * Phase-D-era records (firedAt >= 2026-06-15).
 *
 * Usage:  node scripts/blofin/backfill-execution-status.js [--dry]
 */

const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const fs   = require('fs');
const path = require('path');
const db   = require('../lib/db');

const TRADES_FILE  = path.join(ROOT, 'trades.json');
const PHASE_D_START = new Date('2026-06-15T00:00:00Z').getTime();
// Phase B.4 autotrade hook — commit 36a69a4, 2026-06-16 03:03:23 -0400.
const HOOK_LAUNCH   = new Date('2026-06-16T07:03:23Z').getTime();

async function main() {
  const dry = process.argv.includes('--dry');
  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));

  await db.connect();

  let placed = 0, dropped = 0, prelaunch = 0, skippedAlready = 0;
  for (const t of trades) {
    if (!t.firedAt || new Date(t.firedAt).getTime() < PHASE_D_START) continue;

    const hasOrder = await db.blofinOrders().countDocuments({ signalId: t.id, env: 'demo' });
    let status, detail;
    if (hasOrder > 0) {
      status = 'placed';  detail = `${hasOrder} exchange order doc(s)`;
    } else if (new Date(t.firedAt).getTime() < HOOK_LAUNCH) {
      status = 'skipped';  detail = 'pre-autotrade-launch (hook shipped 2026-06-16T07:03Z)';
    } else {
      status = 'dropped';  detail = 'no exchange order — autotrade did not place (API timeout era)';
    }

    if (status === 'placed') placed++;
    else if (status === 'dropped') dropped++;
    else prelaunch++;

    t.executionStatus = status;
    t.executionDetail = detail;
    if (!t.executionAt) t.executionAt = new Date().toISOString();
  }

  await db.disconnect();

  console.log(`Phase D backfill: placed=${placed} dropped=${dropped} skipped/pre-launch=${prelaunch}`);

  if (dry) { console.log('--dry: no write.'); return; }

  const backup = `${TRADES_FILE}.bak-execstatus-${Date.now()}`;
  fs.copyFileSync(TRADES_FILE, backup);
  const tmp = TRADES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, TRADES_FILE);
  console.log(`Wrote ${TRADES_FILE} (backup: ${path.basename(backup)})`);
}

main().catch(e => { console.error(e); process.exit(1); });
