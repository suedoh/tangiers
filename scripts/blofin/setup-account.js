#!/usr/bin/env node
'use strict';

/**
 * One-time BloFin futures account configuration.
 *
 *   1. Set position mode = 'net' (one-way; Tangiers never opens opposing
 *      positions, so hedge mode adds complexity for no gain).
 *   2. Set leverage = 10× isolated for BTC-USDT (default — override via
 *      `node setup-account.js <leverage>`). Isolated bounds per-trade
 *      loss to the margin posted on that trade.
 *
 * Idempotent: BloFin returns code=0 on already-correct settings.
 *
 * Usage:  make blofin-setup
 *    or:  node scripts/blofin/setup-account.js
 *    or:  node scripts/blofin/setup-account.js 20    (use 20× leverage)
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin = require('../lib/blofin');

const SYMBOL = 'BTC-USDT';

async function main() {
  const leverage = process.argv[2] ? Number(process.argv[2]) : 10;
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 150) {
    console.error(`Leverage must be in [1, 150]; got: ${process.argv[2]}`);
    process.exit(1);
  }

  console.log('─── BloFin account setup ───');
  console.log('env:      ', blofin.isDemo() ? 'demo' : 'PROD');
  console.log('symbol:   ', SYMBOL);
  console.log('leverage: ', leverage + '×');
  console.log('');

  console.log('[1/2] Position mode → net (one-way)…');
  try {
    await blofin.setPositionMode('net');
    console.log('  ✓ ok');
  } catch (e) {
    // "Already in this mode" is treated as success.
    if (/already|same/i.test(e.message)) console.log('  ✓ already in net mode');
    else { console.error('  ✗ FAIL:', e.message); process.exit(1); }
  }

  console.log(`[2/2] Leverage → ${leverage}× isolated for ${SYMBOL}…`);
  try {
    await blofin.setLeverage(SYMBOL, leverage, 'isolated');
    console.log('  ✓ ok');
  } catch (e) {
    console.error('  ✗ FAIL:', e.message);
    process.exit(1);
  }

  console.log('');
  console.log('─── Setup complete. Ready for order-probe. ───');
}

main().catch(e => { console.error('unexpected:', e); process.exit(1); });
