#!/usr/bin/env node
'use strict';
// One-time import of trades.json (BTC) and bz-trades.json (BZ) into MongoDB.
// Safe to re-run — uses insertMany with ordered:false and ignores duplicate key errors.
const fs   = require('fs');
const path = require('path');
const { connect, disconnect, trades } = require('../lib/db');

const ROOT = path.resolve(__dirname, '../../');

function normalizeBTC(t) {
  return {
    ...t,
    instrument:  'BTC',
    firedAt:     t.firedAt     ? new Date(t.firedAt)     : null,
    closedAt:    t.closedAt    ? new Date(t.closedAt)    : null,
    confirmedAt: t.confirmedAt ? new Date(t.confirmedAt) : null,
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

async function importFile(file, normalizeFn, label) {
  const filePath = path.join(ROOT, file);
  if (!fs.existsSync(filePath)) { console.log(`  ${label}: file not found, skipping`); return 0; }
  const docs = JSON.parse(fs.readFileSync(filePath, 'utf8')).map(normalizeFn);
  if (!docs.length)              { console.log(`  ${label}: empty, skipping`); return 0; }
  try {
    const result = await trades().insertMany(docs, { ordered: false });
    console.log(`  ${label}: inserted ${result.insertedCount} / ${docs.length}`);
    return result.insertedCount;
  } catch (e) {
    const inserted = e.result?.nInserted ?? 0;
    console.log(`  ${label}: inserted ${inserted}, skipped ${docs.length - inserted} duplicates`);
    return inserted;
  }
}

async function main() {
  await connect();
  console.log('Connected. Importing trades...');
  await importFile('trades.json',    normalizeBTC, 'BTC trades');
  await importFile('bz-trades.json', normalizeBZ,  'BZ trades');
  console.log(`\nTotal in trades collection: ${await trades().countDocuments()}`);
  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
