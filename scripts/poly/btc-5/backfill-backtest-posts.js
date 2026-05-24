#!/usr/bin/env node
'use strict';

/**
 * Poly BTC-5 — One-shot backfill of #poly-btc-5-backtest with historical
 * resolved signals.
 *
 * Use after wiring up POLY_BTC_5_BACKTEST_WEBHOOK to pre-populate the channel
 * with the most recent N days of resolved signals. Live posting happens
 * automatically in trigger-check.js as outcomes resolve going forward — this
 * script only fills the gap from before the channel was wired up.
 *
 * Posts oldest → newest so the channel reads chronologically.
 *
 * Usage:
 *   node scripts/poly/btc-5/backfill-backtest-posts.js              # last 7d
 *   node scripts/poly/btc-5/backfill-backtest-posts.js --days 14    # last 14d
 *   node scripts/poly/btc-5/backfill-backtest-posts.js --dry-run    # report only
 */

const fs   = require('fs');
const path = require('path');

const { loadEnv, ROOT } = require('../../lib/env');
const { postWebhook }   = require('../../lib/discord');

loadEnv();

const WEBHOOK     = process.env.POLY_BTC_5_BACKTEST_WEBHOOK;
const TRADES_FILE = path.join(ROOT, 'poly-btc-5-trades.json');
const DRY_RUN     = process.argv.includes('--dry-run');

const daysIdx = process.argv.indexOf('--days');
const DAYS    = daysIdx >= 0 ? parseInt(process.argv[daysIdx + 1], 10) || 7 : 7;

function log(m) { console.log(`[${new Date().toISOString()}] [backfill-backtest] ${m}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Duplicated from trigger-check.js — small enough that sharing through a
// module isn't worth coupling the live cron entrypoint to this one-shot.
function formatBacktestLine(ev) {
  const f = ev.factors || {};
  const dir = ev.prediction;
  const tags = [];
  if (f.cvdDir === dir)    tags.push(f.cvdScore === 2 ? 'CVD²' : 'CVD');
  if (f.vwapDir === dir)   tags.push('VWAP');
  if (f.structDir === dir) tags.push('1H');
  if (f.cleanAir)          tags.push('Clean');
  if (f.goodSession)       tags.push('Session');

  const time   = new Date(ev.barOpen).toISOString().slice(11, 16);
  const emoji  = ev.correct ? '✅' : '❌';
  const score  = `${ev.score}/6`;
  const price  = ev.price ? `$${Math.round(ev.price).toLocaleString()}` : '';
  return `${emoji} \`${time} UTC\` · **${dir}** ${score} · ${price} · ${tags.join('+')}`;
}

async function main() {
  if (!WEBHOOK) { log('ERROR: POLY_BTC_5_BACKTEST_WEBHOOK not set in .env'); process.exit(1); }

  const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const eligible = trades
    .filter(t => t.signaled && t.outcome !== null && new Date(t.barOpen).getTime() >= cutoff)
    .sort((a, b) => new Date(a.barOpen) - new Date(b.barOpen));

  log(`${eligible.length} resolved signals in last ${DAYS} day(s)  (oldest ${eligible[0]?.barOpen}, newest ${eligible.slice(-1)[0]?.barOpen})`);
  if (DRY_RUN) {
    for (const ev of eligible.slice(0, 5)) log(`[dry] ${formatBacktestLine(ev)}`);
    log(`... (${eligible.length - 5} more)`);
    log('DRY RUN — no posts made');
    return;
  }

  let posted = 0, failed = 0;
  for (const ev of eligible) {
    const line = formatBacktestLine(ev);
    try {
      await postWebhook(WEBHOOK, ev.correct ? 'long' : 'short', line, 'Poly BTC-5 • Backtest (backfill)');
      posted++;
    } catch (e) {
      failed++;
      log(`post failed for ${ev.barOpen}: ${e.message}`);
    }
    await sleep(700); // ~1.4/sec — well under Discord's 5/sec webhook limit
  }

  log(`Done — posted: ${posted}  failed: ${failed}`);
}

main().catch(e => { console.error('[backfill-backtest] Fatal:', e); process.exit(1); });
