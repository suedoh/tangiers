#!/usr/bin/env node
// One-time import of trades.json (BTC) and bz-trades.json (BZ) into MongoDB.
// Safe to re-run — uses insertMany with ordered:false and ignores duplicate key errors.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, disconnect, trades } from '../lib/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

function normalizeBTC(t) {
  return {
    ...t,
    instrument: 'BTC',
    firedAt:     t.firedAt     ? new Date(t.firedAt)     : null,
    closedAt:    t.closedAt    ? new Date(t.closedAt)    : null,
    confirmedAt: t.confirmedAt ? new Date(t.confirmedAt) : null,
  };
}

function normalizeBZ(t) {
  return {
    ...t,
    instrument: 'BZ',
    firedAt:  t.firedAt  ? new Date(t.firedAt)  : null,
    closedAt: t.closedAt ? new Date(t.closedAt) : null,
  };
}

async function importFile(file, normalizeFn, label) {
  const filePath = path.join(ROOT, file);
  if (!fs.existsSync(filePath)) {
    console.log(`  ${label}: file not found, skipping`);
    return 0;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const docs = raw.map(normalizeFn);
  if (!docs.length) {
    console.log(`  ${label}: empty, skipping`);
    return 0;
  }
  try {
    const result = await trades().insertMany(docs, { ordered: false });
    console.log(`  ${label}: inserted ${result.insertedCount} / ${docs.length}`);
    return result.insertedCount;
  } catch (e) {
    // BulkWriteError — some inserted, some were duplicates
    const inserted = e.result?.nInserted ?? 0;
    const dupes = docs.length - inserted;
    console.log(`  ${label}: inserted ${inserted}, skipped ${dupes} duplicates`);
    return inserted;
  }
}

async function main() {
  await connect();
  console.log('Connected. Importing trades...');

  await importFile('trades.json',    normalizeBTC, 'BTC trades');
  await importFile('bz-trades.json', normalizeBZ,  'BZ trades');

  const total = await trades().countDocuments();
  console.log(`\nTotal documents in trades collection: ${total}`);

  await disconnect();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
