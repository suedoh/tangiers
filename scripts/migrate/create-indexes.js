#!/usr/bin/env node
'use strict';
// One-time index creation. Safe to re-run — createIndex is idempotent.
const { connect, disconnect, trades, triggerState, triggerCooldowns, weatherTrades } = require('../lib/db');

async function main() {
  await connect();
  console.log('Connected. Creating indexes...');

  // trades
  await trades().createIndex({ instrument: 1, outcome: 1 });
  await trades().createIndex({ instrument: 1, firedAt: -1 });
  await trades().createIndex({ instrument: 1, closedAt: -1 });
  await trades().createIndex({ 'zone.high': 1, 'zone.low': 1 });
  await trades().createIndex({ id: 1 }, { unique: true, sparse: true });
  await trades().createIndex({ firedAt: -1 });
  console.log('  trades ✓');

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

  // weather_trades — high-volume, distinct schema; indexes for common query patterns
  await weatherTrades().createIndex({ id: 1 }, { unique: true, sparse: true });
  await weatherTrades().createIndex({ firedAt: -1 });
  await weatherTrades().createIndex({ 'parsed.city': 1, firedAt: -1 });
  await weatherTrades().createIndex({ signalResult: 1, firedAt: -1 });
  await weatherTrades().createIndex({ 'parsed.direction': 1, side: 1 });
  await weatherTrades().createIndex({ aiDecision: 1, firedAt: -1 });
  await weatherTrades().createIndex({ outcome: 1 });
  console.log('  weather_trades ✓');

  // weathermen_data / weathermen_state — small collections, _id lookups only
  console.log('  weathermen_data ✓ (no extra indexes, _id lookups only)');
  console.log('  weathermen_state ✓ (no extra indexes, _id lookups only)');

  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
