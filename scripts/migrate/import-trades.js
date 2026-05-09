#!/usr/bin/env node
'use strict';
// One-time import of trade/forecast JSON files into MongoDB.
// Safe to re-run — uses insertMany with ordered:false and ignores duplicate key errors.
const fs   = require('fs');
const path = require('path');
const { connect, disconnect, trades, waveForecasts } = require('../lib/db');

const ROOT = path.resolve(__dirname, '../../');

// Extract a normalized factors object from BTC's criteria array.
// Stored alongside the original criteria array (which is preserved as-is)
// so weekly-report.js can run aggregation queries by factor name without
// substring-matching label strings.
function extractBTCFactors(criteria) {
  if (!Array.isArray(criteria)) return null;
  const find = (substr) => criteria.find(c => c.label?.includes(substr));
  return {
    cvd:         find('CVD')?.pass        ?? null,
    sessionVP:   find('Session VP')?.pass ?? null,
    vwap:        find('VWAP')?.pass       ?? null,
    oi:          find('OI')?.pass         ?? null,
    macd4h:      find('MACD')?.pass       ?? null,
    rsi12h:      find('RSI')?.pass        ?? null,
    weeklyTrend: find('Weekly')?.pass     ?? null,
  };
}

function normalizeBTC(t) {
  return {
    ...t,
    instrument:  'BTC',
    firedAt:     t.firedAt     ? new Date(t.firedAt)     : null,
    closedAt:    t.closedAt    ? new Date(t.closedAt)    : null,
    confirmedAt: t.confirmedAt ? new Date(t.confirmedAt) : null,
    factors:     extractBTCFactors(t.criteria),
  };
}

function normalizeBZ(t) {
  return {
    ...t,
    instrument: 'BZ',
    firedAt:    t.firedAt  ? new Date(t.firedAt)  : null,
    closedAt:   t.closedAt ? new Date(t.closedAt) : null,
  };
}

// Poly bar evaluations — every 5-min bar is logged regardless of signal.
// TTL: non-signaled records with a known outcome expire 7 days after closedAt
// (sparse index on `expiresAt` deletes them automatically).
// Signaled records and pending-outcome records have expiresAt:null and live forever.
function normalizePoly(t) {
  const closedAt = t.closedAt ? new Date(t.closedAt) : null;
  const ttlMs = 7 * 24 * 60 * 60 * 1000;
  const expiresAt = (!t.signaled && t.outcome && closedAt)
    ? new Date(closedAt.getTime() + ttlMs)
    : null;
  return {
    ...t,
    instrument: 'POLY-BTC-5',
    barOpen:    t.barOpen  ? new Date(t.barOpen)  : null,
    closedAt,
    expiresAt,
  };
}

// EW forecasts — separate collection (wave_forecasts), schema is locked
// per scripts/ew/storage.js to be identical to the future Mongo doc.
function normalizeEW(f) {
  return {
    ...f,
    generatedAt: f.generatedAt ? new Date(f.generatedAt) : null,
  };
}

// Weathermen hook — dormant on main until the weathermen branch lands.
// Schema verified at merge time; this normalizer is a safety net so the
// historical import file (if present at merge) flows through cleanly.
function normalizeWeathermen(t) {
  return {
    ...t,
    instrument: 'WEATHERMEN',
    firedAt:    t.firedAt  ? new Date(t.firedAt)  : null,
    closedAt:   t.closedAt ? new Date(t.closedAt) : null,
  };
}

// Idempotent importer: uses replaceOne+upsert keyed on `_id` (EW) or `id` (everything else).
// Re-running the migration picks up any normalizer changes — historical records get
// new derived fields (e.g. BTC factors) without manual cleanup.
async function importToCollection(file, collectionFn, normalizeFn, label) {
  const filePath = path.join(ROOT, file);
  if (!fs.existsSync(filePath)) { console.log(`  ${label}: file not found, skipping`); return 0; }
  const docs = JSON.parse(fs.readFileSync(filePath, 'utf8')).map(normalizeFn);
  if (!docs.length)              { console.log(`  ${label}: empty, skipping`); return 0; }
  const ops = docs.map(doc => {
    const filter = doc._id != null ? { _id: doc._id } : { id: doc.id };
    return { replaceOne: { filter, replacement: doc, upsert: true } };
  });
  const result = await collectionFn().bulkWrite(ops, { ordered: false });
  const upserted = result.upsertedCount || 0;
  const modified = result.modifiedCount || 0;
  const matched  = result.matchedCount  || 0;
  console.log(`  ${label}: ${upserted} new, ${modified} updated, ${matched - modified} unchanged (${docs.length} total)`);
  return upserted + modified;
}

async function main() {
  await connect();
  console.log('Connected. Importing trades + forecasts...');
  await importToCollection('trades.json',             trades,         normalizeBTC,        'BTC trades');
  await importToCollection('bz-trades.json',          trades,         normalizeBZ,         'BZ trades');
  await importToCollection('poly-btc-5-trades.json',  trades,         normalizePoly,       'Poly BTC-5 bar evals');
  await importToCollection('weathermen-trades.json',  trades,         normalizeWeathermen, 'Weathermen trades');
  await importToCollection('ew-forecasts.json',       waveForecasts,  normalizeEW,         'EW forecasts');
  console.log(`\nTotal in trades collection:         ${await trades().countDocuments()}`);
  console.log(`Total in wave_forecasts collection: ${await waveForecasts().countDocuments()}`);
  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
