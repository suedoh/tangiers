#!/usr/bin/env node
'use strict';

/**
 * Top up the BloFin demo account with virtual USDT.
 *
 * Refuses to run when BLOFIN_ENV=prod (guarded in lib/blofin.js too).
 * Prints balance before and after so the deposit is visibly accounted for.
 *
 * Usage:
 *   node scripts/blofin/fund-demo.js              # default: 10000 USDT
 *   node scripts/blofin/fund-demo.js 50000        # custom amount
 *   node scripts/blofin/fund-demo.js 5000 BTC     # alt currency
 *   make blofin-fund
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');

function fmt(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function printBalance(label, bal) {
  const funded = (bal || []).filter(r => Number(r.balance) > 0);
  if (funded.length === 0) {
    console.log(`  ${label}: (empty)`);
    return;
  }
  funded.forEach(r => {
    console.log(`  ${label}: ${r.currency} balance=${fmt(r.balance)} available=${fmt(r.available)}`);
  });
}

async function main() {
  const amount   = process.argv[2] ? Number(process.argv[2]) : 10000;
  const currency = process.argv[3] || 'USDT';

  if (!blofin.isDemo()) {
    console.error('Refusing to run: BLOFIN_ENV=prod. Demo top-ups only.');
    process.exit(1);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(`Invalid amount: ${process.argv[2]}`);
    process.exit(1);
  }

  console.log(`─── BloFin demo top-up ───`);
  console.log(`amount:   ${amount} ${currency}`);
  console.log(`env:      demo`);
  console.log('');

  console.log('Before:');
  try { printBalance('  futures', await blofin.getBalance('futures')); }
  catch (e) { console.error('  failed to read balance:', e.message); process.exit(1); }

  console.log('');
  console.log('Applying…');
  try {
    const res = await blofin.applyDemoMoney(currency, amount);
    console.log('  ✓ response:', JSON.stringify(res));
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    process.exit(1);
  }

  console.log('');
  console.log('After:');
  try { printBalance('  futures', await blofin.getBalance('futures')); }
  catch (e) { console.error('  failed to read balance:', e.message); process.exit(1); }

  console.log('');
  console.log('─── Done. ───');
}

main().catch(e => { console.error('unexpected:', e); process.exit(1); });
