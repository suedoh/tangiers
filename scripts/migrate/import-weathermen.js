#!/usr/bin/env node
'use strict';
// One-time import of Weathermen JSON files into MongoDB.
// Safe to re-run — uses insertMany with ordered:false; duplicates skipped via unique index on id.
// Can be run independently of import-trades.js (weather_trades is its own collection).
//
// Collections written:
//   weather_trades    — weather signals (own collection; high-volume, distinct schema)
//   trigger_cooldowns — per-conditionId 4h cooldowns (instrument: "WM")
//   weathermen_state  — signals map { tradeId → discordMsgId } as singleton
//   weathermen_data   — per-city bias corrections seeded from bias-corrections.json

const fs   = require('fs');
const path = require('path');
const { connect, disconnect, weatherTrades, triggerCooldowns, weathermenData, weathermenState } = require('../lib/db');

const ROOT = path.resolve(__dirname, '../../');

function log(msg) { console.log(`  ${msg}`); }

function normalizeWeather(t) {
  return {
    ...t,
    firedAt:  t.firedAt  ? new Date(t.firedAt)  : null,
    closedAt: t.closedAt ? new Date(t.closedAt) : null,
  };
}

async function importTrades() {
  const filePath = path.join(ROOT, 'weather-trades.json');
  if (!fs.existsSync(filePath)) { log('weather-trades.json: file not found, skipping'); return; }
  const docs = JSON.parse(fs.readFileSync(filePath, 'utf8')).map(normalizeWeather);
  if (!docs.length) { log('weather-trades.json: empty, skipping'); return; }
  try {
    const result = await weatherTrades().insertMany(docs, { ordered: false });
    log(`weather-trades.json: inserted ${result.insertedCount} / ${docs.length}`);
  } catch (e) {
    const inserted = e.result?.nInserted ?? 0;
    log(`weather-trades.json: inserted ${inserted}, skipped ${docs.length - inserted} duplicates`);
  }
}

async function importCooldowns() {
  const filePath = path.join(ROOT, '.weather-state.json');
  if (!fs.existsSync(filePath)) { log('.weather-state.json: file not found, skipping cooldowns'); return; }
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cooldownMap = state.cooldowns || {};
  const entries = Object.entries(cooldownMap);
  if (!entries.length) { log('.weather-state.json#cooldowns: empty, skipping'); return; }
  const docs = entries.map(([conditionId, epochMs]) => ({
    conditionId,
    instrument: 'WM',
    expiresAt:  new Date(epochMs),
  }));
  try {
    const result = await triggerCooldowns().insertMany(docs, { ordered: false });
    log(`.weather-state.json#cooldowns: inserted ${result.insertedCount} / ${docs.length}`);
  } catch (e) {
    const inserted = e.result?.nInserted ?? 0;
    log(`.weather-state.json#cooldowns: inserted ${inserted}, skipped ${docs.length - inserted} duplicates`);
  }
}

async function importState() {
  const filePath = path.join(ROOT, '.weather-state.json');
  if (!fs.existsSync(filePath)) { log('.weather-state.json: file not found, skipping state'); return; }
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const signalsMap = state.signals || {};
  const count = Object.keys(signalsMap).length;
  if (!count) { log('.weather-state.json#signals: empty, skipping'); return; }
  await weathermenState().updateOne(
    { _id: 'signals' },
    { $set: { _id: 'signals', instrument: 'WM', data: signalsMap } },
    { upsert: true }
  );
  log(`.weather-state.json#signals: upserted singleton with ${count} entries`);
}

async function importBiasCorrections() {
  const filePath = path.join(ROOT, 'scripts/lib/bias-corrections.json');
  if (!fs.existsSync(filePath)) { log('bias-corrections.json: file not found, skipping'); return; }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const meta = raw._meta || {};
  const cities = Object.entries(raw).filter(([k]) => k !== '_meta');
  if (!cities.length) { log('bias-corrections.json: no city entries, skipping'); return; }
  const docs = cities.map(([city, biasF]) => ({
    _id:       `bias:${city}`,
    type:      'bias_correction',
    city,
    biasF,
    tradeCount: meta.tradeCount ?? null,
    updatedAt:  meta.generated ? new Date(meta.generated) : new Date(),
  }));
  let upserted = 0;
  for (const doc of docs) {
    await weathermenData().updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
    upserted++;
  }
  log(`bias-corrections.json: upserted ${upserted} city bias documents`);
}

async function main() {
  await connect();
  console.log('Connected. Importing Weathermen data...');
  await importTrades();
  await importCooldowns();
  await importState();
  await importBiasCorrections();
  console.log(`\nVerification counts:`);
  console.log(`  weather_trades:          ${await weatherTrades().countDocuments()}`);
  console.log(`  trigger_cooldowns (WM):  ${await triggerCooldowns().countDocuments({ instrument: 'WM' })}`);
  console.log(`  weathermen_state:        ${await weathermenState().countDocuments()}`);
  console.log(`  weathermen_data:         ${await weathermenData().countDocuments({ type: 'bias_correction' })} bias corrections`);
  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
