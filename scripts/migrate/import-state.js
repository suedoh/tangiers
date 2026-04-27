#!/usr/bin/env node
'use strict';
// One-time import of all state JSON files into MongoDB.
// Safe to re-run — uses replaceOne with upsert:true.
const fs   = require('fs');
const path = require('path');
const { connect, disconnect, triggerState, triggerCooldowns, newsState, discordBotState } = require('../lib/db');

const ROOT = path.resolve(__dirname, '../../');

function readJSON(file, fallback) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function importBTCState() {
  const raw = readJSON('.trigger-state.json', {});
  const signalMessages = (raw._signal_messages || []).map(m => ({
    ...m, firedAt: m.firedAt ? new Date(m.firedAt) : null,
  }));

  await triggerState().replaceOne(
    { _id: 'btc' },
    { _id: 'btc', instrument: 'BTC', previousOI: raw._previousOI ?? null,
      lastCdpAlertAt: raw._lastCdpAlertAt ? new Date(raw._lastCdpAlertAt) : null, signalMessages },
    { upsert: true }
  );
  console.log('  BTC trigger_state ✓');

  let count = 0;
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith('_') || typeof val !== 'object' || !val.ts) continue;
    const isPending = key.startsWith('_pending_');
    const isWatch   = key.startsWith('_watch_');
    const entryType = isPending ? 'pending' : isWatch ? 'watch' : 'cooldown';
    const ttlMs     = isPending ? 90*60*1000 : isWatch ? 4*60*60*1000 : 60*60*1000;
    await triggerCooldowns().replaceOne(
      { instrument: 'BTC', levelKey: key },
      { instrument: 'BTC', levelKey: key, entryType, ts: new Date(val.ts),
        expiresAt: new Date(val.ts + ttlMs), direction: val.direction ?? null,
        levelType: val.levelType ?? null, levelMid: val.levelMid ?? null,
        levelLo: val.levelLo ?? null, levelHi: val.levelHi ?? null,
        baselineOI: val.baselineOI ?? null, baselineCVD: val.baselineCVD ?? null, sessionKey: null },
      { upsert: true }
    );
    count++;
  }
  console.log(`  BTC trigger_cooldowns: ${count} entries ✓`);
}

async function importBZState() {
  const raw = readJSON('.bz-trigger-state.json', {});
  const signalMessages = (raw._signal_messages || []).map(m => ({
    ...m, firedAt: m.firedAt ? new Date(m.firedAt) : null,
  }));

  await triggerState().replaceOne(
    { _id: 'bz' },
    { _id: 'bz', instrument: 'BZ', previousOI: null,
      lastCdpAlertAt: raw._lastCdpAlertAt ? new Date(raw._lastCdpAlertAt) : null, signalMessages },
    { upsert: true }
  );
  console.log('  BZ trigger_state ✓');

  const cooldowns = raw.cooldowns || {};
  let count = 0;
  for (const [label, sessionKey] of Object.entries(cooldowns)) {
    await triggerCooldowns().replaceOne(
      { instrument: 'BZ', levelKey: label },
      { instrument: 'BZ', levelKey: label, entryType: 'cooldown', ts: new Date(),
        expiresAt: new Date(Date.now() + 24*60*60*1000), sessionKey,
        direction: null, levelType: null, levelMid: null, levelLo: null, levelHi: null,
        baselineOI: null, baselineCVD: null },
      { upsert: true }
    );
    count++;
  }
  console.log(`  BZ trigger_cooldowns: ${count} entries ✓`);
}

async function importNewsState() {
  const raw = readJSON('.bz-news-state.json', { seenArticles: [], aisBaseline: null, aisHistory: [] });
  const aisHistory = (raw.aisHistory || []).map(h => ({ ts: h.ts ? new Date(h.ts) : null, score: h.score ?? null }));
  await newsState().replaceOne(
    { _id: 'bz_news' },
    { _id: 'bz_news', seenArticles: raw.seenArticles || [], aisBaseline: raw.aisBaseline ?? null, aisHistory },
    { upsert: true }
  );
  console.log(`  news_state: ${(raw.seenArticles || []).length} seen articles ✓`);
}

async function importDiscordBotState() {
  const raw = readJSON('.discord-bot-state.json', {});
  const channels = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'lastMessageId') continue;
    if (typeof v === 'object' && v.lastMessageId) channels[k] = { lastMessageId: v.lastMessageId };
  }
  await discordBotState().replaceOne(
    { _id: 'discord_channels' },
    { _id: 'discord_channels', channels },
    { upsert: true }
  );
  console.log(`  discord_bot_state: ${Object.keys(channels).length} channels ✓`);
}

async function main() {
  await connect();
  console.log('Connected. Importing state files...');
  await importBTCState();
  await importBZState();
  await importNewsState();
  await importDiscordBotState();
  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
