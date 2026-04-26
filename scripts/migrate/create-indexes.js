#!/usr/bin/env node
// One-time index creation. Safe to re-run — createIndex is idempotent.
import { connect, disconnect, trades, triggerState, triggerCooldowns, newsState, discordBotState } from '../lib/db.js';

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

  // trigger_cooldowns
  await triggerCooldowns().createIndex({ instrument: 1, levelKey: 1 }, { unique: true });
  await triggerCooldowns().createIndex({ instrument: 1, entryType: 1 });
  // TTL index — MongoDB auto-deletes documents when current time >= expiresAt
  await triggerCooldowns().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log('  trigger_cooldowns ✓');

  // news_state and discord_bot_state use _id only — no additional indexes needed
  console.log('  news_state ✓ (no extra indexes)');
  console.log('  discord_bot_state ✓ (no extra indexes)');

  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
