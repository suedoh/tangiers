#!/usr/bin/env node
'use strict';

/**
 * Poly BTC-5 — One-time outcome backfill against Binance Futures ground truth.
 *
 * Per audit 2026-05-24: TradingView CDP-based outcome reads had a ~3.2%
 * disagreement rate vs Binance Futures klines, plus 3.3% orphans where
 * outcome=null was never resolved. This script:
 *
 *   1. Iterates poly-btc-5-trades.json
 *   2. For every signaled bar, fetches the Binance 5-min kline by barOpen
 *   3. Overwrites outcome/correct fields if they disagree or are null
 *   4. Reports a summary
 *
 * Run companion script `backfill-reactions.js --fix-wrong` afterwards to
 * correct Discord emojis on signals whose stored outcome changed.
 *
 * Usage:
 *   node scripts/poly/btc-5/backfill-outcomes.js              # live
 *   node scripts/poly/btc-5/backfill-outcomes.js --dry-run    # report only
 */

const fs   = require('fs');
const path = require('path');

const { loadEnv, ROOT }   = require('../../lib/env');
const { getKlines5mRange } = require('../../lib/binance');

loadEnv();

const TRADES_FILE = path.join(ROOT, 'poly-btc-5-trades.json');
const DRY_RUN     = process.argv.includes('--dry-run');

function log(m) { console.log(`[${new Date().toISOString()}] [backfill-outcomes] ${m}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const signaled = trades.filter(t => t.signaled);
  log(`${trades.length} total bars, ${signaled.length} signaled`);

  // Fetch all needed klines in chunks of 1000 bars × 5 min = ~3.5 days each.
  const bars = signaled.map(t => new Date(t.barOpen).getTime()).sort((a, b) => a - b);
  if (bars.length === 0) { log('Nothing to backfill'); return; }

  const minMs = bars[0];
  const maxMs = bars[bars.length - 1] + 5 * 60 * 1000;
  const truth = new Map();

  let cursor = minMs;
  while (cursor < maxMs) {
    const chunkEnd = Math.min(cursor + 1000 * 5 * 60 * 1000, maxMs);
    const chunk = await getKlines5mRange(cursor, chunkEnd);
    if (chunk.length === 0) break;
    for (const k of chunk) {
      truth.set(k.openTime, k.close >= k.open ? 'UP' : 'DOWN');
    }
    cursor = chunk[chunk.length - 1].openTime + 5 * 60 * 1000;
    await sleep(120);
  }
  log(`Fetched ${truth.size} ground-truth klines`);

  let fixedWrong = 0, fixedOrphan = 0, agreed = 0, missing = 0;
  const changes = [];

  for (const t of signaled) {
    const ms = new Date(t.barOpen).getTime();
    const groundTruth = truth.get(ms);
    if (!groundTruth) { missing++; continue; }

    if (t.outcome === null) {
      // Orphan — never resolved
      fixedOrphan++;
      changes.push({ barOpen: t.barOpen, prediction: t.prediction, from: 'null', to: groundTruth });
      if (!DRY_RUN) {
        t.outcome  = groundTruth;
        t.correct  = t.prediction === groundTruth;
        t.closedAt = new Date().toISOString();
      }
    } else if (t.outcome !== groundTruth) {
      // Wrong label
      fixedWrong++;
      changes.push({ barOpen: t.barOpen, prediction: t.prediction, from: t.outcome, to: groundTruth, oldCorrect: t.correct });
      if (!DRY_RUN) {
        t.outcome = groundTruth;
        t.correct = t.prediction === groundTruth;
      }
    } else {
      agreed++;
    }
  }

  log(`Summary: agreed=${agreed} fixed_wrong=${fixedWrong} fixed_orphan=${fixedOrphan} missing_from_binance=${missing}`);
  if (changes.length > 0 && changes.length <= 80) {
    log('Changes:');
    for (const c of changes) {
      const tag = c.from === 'null' ? 'ORPHAN' : 'WRONG ';
      log(`  ${tag} ${c.barOpen}  pred=${c.prediction}  ${c.from} → ${c.to}`);
    }
  }

  if (!DRY_RUN && changes.length > 0) {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
    log(`Wrote ${TRADES_FILE}`);
  } else if (DRY_RUN) {
    log('DRY RUN — no changes written');
  } else {
    log('Nothing to change');
  }
}

main().catch(e => { console.error('[backfill-outcomes] Fatal:', e); process.exit(1); });
