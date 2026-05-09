#!/usr/bin/env node
'use strict';
// One-time index creation. Safe to re-run — createIndex is idempotent.
const { connect, disconnect, trades, waveForecasts, triggerState, triggerCooldowns } = require('../lib/db');

async function main() {
  await connect();
  console.log('Connected. Creating indexes...');

  // trades
  await trades().createIndex({ instrument: 1, outcome: 1 });
  await trades().createIndex({ instrument: 1, firedAt: -1 });
  await trades().createIndex({ instrument: 1, closedAt: -1 });
  await trades().createIndex({ instrument: 1, barOpen: -1 }, { sparse: true });
  await trades().createIndex({ instrument: 1, signaled: 1, firedAt: -1 }, { sparse: true });
  await trades().createIndex({ 'zone.high': 1, 'zone.low': 1 });
  await trades().createIndex({ id: 1 }, { unique: true, sparse: true });
  await trades().createIndex({ firedAt: -1 });
  // TTL on poly non-signaled bar evals — set by trigger-check.js once outcome is known
  await trades().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });
  console.log('  trades ✓');

  // wave_forecasts — EW pipeline (separate collection, schema-incompatible with trades)
  await waveForecasts().createIndex({ generatedAt: -1 });
  await waveForecasts().createIndex({ symbol: 1, generatedAt: -1 });
  await waveForecasts().createIndex({ scheduleSlot: 1, generatedAt: -1 });
  console.log('  wave_forecasts ✓');

  // trigger_state
  await triggerState().createIndex({ instrument: 1 }, { unique: true, sparse: true });
  console.log('  trigger_state ✓');

  // trigger_cooldowns — TTL index auto-deletes documents when current time >= expiresAt
  await triggerCooldowns().createIndex({ instrument: 1, levelKey: 1 }, { unique: true });
  await triggerCooldowns().createIndex({ instrument: 1, entryType: 1 });
  await triggerCooldowns().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log('  trigger_cooldowns ✓');

  console.log('  news_state ✓ (no extra indexes)');
  console.log('  discord_bot_state ✓ (no extra indexes)');

  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
