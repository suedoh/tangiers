#!/usr/bin/env node
'use strict';

/**
 * BloFin connectivity + auth health check.
 *
 * Phase A exit criterion: this script reads account state from the demo
 * environment using credentials in .env. If this succeeds, the signing
 * scheme and creds are correct and Phase B (paper-trade execution) can
 * start.
 *
 * Usage:  node scripts/blofin/status.js
 *   or:   make blofin-status
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');

function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(d);
}

async function main() {
  console.log('─── BloFin status check ───');
  console.log('env:        ', blofin.isDemo() ? 'demo' : 'PROD');
  console.log('base url:   ', blofin.baseUrl());
  console.log('');

  // 1) Public — confirms network + base URL
  console.log('[1/3] Public instruments (no auth)…');
  try {
    const inst = await blofin.getInstruments('BTC-USDT');
    const row  = Array.isArray(inst) ? inst[0] : inst;
    if (!row) throw new Error('empty response');
    console.log('  ✓ BTC-USDT:', row.instType || '?', 'tickSize=' + (row.tickSize || '?'), 'minSz=' + (row.minSize || '?'));
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    process.exit(1);
  }

  // 2) Private — confirms signing + creds
  console.log('[2/3] Account balance (signed)…');
  try {
    const rows = await blofin.getBalance('futures');
    const funded = (rows || []).filter(r => Number(r.balance) > 0);
    if (funded.length === 0) {
      console.log('  ✓ auth ok, no futures balance yet (top up with `make blofin-fund` or the BloFin UI)');
    } else {
      funded.forEach(r => {
        console.log(`  ✓ ${r.currency}: balance=${fmt(r.balance)}  available=${fmt(r.available)}  frozen=${fmt(r.frozen)}`);
      });
    }
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    console.error('  (auth error code 50113 → signing wrong; check secret + double-encoding)');
    process.exit(1);
  }

  // 3) Positions — confirms account-scoped private reads
  console.log('[3/3] Open positions (signed)…');
  try {
    const pos = await blofin.getPositions();
    if (!Array.isArray(pos) || pos.length === 0) {
      console.log('  ✓ no open positions');
    } else {
      pos.forEach(p => {
        console.log(`  ✓ ${p.instId} ${p.positionSide || ''} size=${p.positions || p.pos || '?'} entry=${fmt(p.averagePrice)} uPnL=${fmt(p.unrealizedPnl)}`);
      });
    }
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    process.exit(1);
  }

  console.log('');
  console.log('─── All checks passed. Phase A exit criterion met. ───');
}

main().catch(e => { console.error('unexpected:', e); process.exit(1); });
