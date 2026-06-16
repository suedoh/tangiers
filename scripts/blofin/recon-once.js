#!/usr/bin/env node
'use strict';

/**
 * Single-pass reconciliation between local Mongo state and BloFin's
 * exchange truth. Prints a summary.
 *
 * Usage:  make blofin-recon-once
 *    or:  node scripts/blofin/recon-once.js [BTC-USDT]
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');
const store  = require('../lib/blofin-store');
const db     = require('../lib/db');

async function main() {
  const instId = process.argv[2] || undefined;

  console.log('─── BloFin reconciliation ───');
  console.log('env:    ', blofin.isDemo() ? 'demo' : 'PROD');
  console.log('instId: ', instId || '(all)');
  console.log('');

  const report = await store.reconcileOnce({ instId });

  console.log(`matched (still live):    ${report.matched}`);
  console.log(`disappeared (need B.5):  ${report.disappeared.length}` + (report.disappeared.length ? ' — ' + report.disappeared.join(', ') : ''));
  console.log(`retroactive (new local): ${report.retroactive.length}` + (report.retroactive.length ? ' — ' + report.retroactive.join(', ') : ''));
  if (report.errors.length) {
    console.log(`errors: ${report.errors.length}`);
    report.errors.forEach(e => console.log('  ', e.orderId, '→', e.error));
  }

  console.log('');
  console.log('─── Done. ───');
  await db.disconnect();
}

main().catch(async e => {
  console.error('unexpected:', e);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
