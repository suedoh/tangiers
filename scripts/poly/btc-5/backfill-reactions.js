#!/usr/bin/env node
'use strict';

/**
 * Poly BTC-5 — Backfill ✅/❌ reactions on historical signal messages.
 *
 * Pages through #poly-btc-5-signals channel history, matches each embed to a
 * resolved trade in poly-btc-5-trades.json by bar timestamp (decoded from the
 * Discord message snowflake ID), and adds the appropriate reaction.
 *
 * Messages that already carry ✅ or ❌ are skipped — safe to re-run.
 *
 * Usage:
 *   node scripts/poly/btc-5/backfill-reactions.js           # live
 *   node scripts/poly/btc-5/backfill-reactions.js --dry-run
 *
 * Required env: DISCORD_BOT_TOKEN, POLY_BTC_5_SIGNALS_CHANNEL_ID
 */

const fs   = require('fs');
const path = require('path');

const { loadEnv, ROOT }                    = require('../../lib/env');
const { addReaction, removeOwnReaction, getChannelMessages } = require('../../lib/discord');

loadEnv();

const BOT_TOKEN   = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID  = process.env.POLY_BTC_5_SIGNALS_CHANNEL_ID;
const TRADES_FILE = path.join(ROOT, 'poly-btc-5-trades.json');
const DRY_RUN     = process.argv.includes('--dry-run');
const FIX_WRONG   = process.argv.includes('--fix-wrong'); // when set, replace mismatched ✅/❌

function log(msg) { console.log(`[${new Date().toISOString()}] [backfill] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Discord snowflake → Unix ms (creation timestamp encoded in the high 42 bits)
function snowflakeToMs(id) {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}

// The trigger-check cron fires 1 minute after each 5-min bar opens, so the
// Discord message timestamp ≈ barOpen + ~60s. Subtract 60s and floor to the
// nearest 5-min mark to recover the bar open.
//
// Earlier versions of this script subtracted 90s, which landed the floor on
// the PREVIOUS bar in every case — verified against `_signal_messages` state:
// the -90s decoder was wrong on 20/20 samples; the -60s decoder is right on
// 20/20. A `prevBar` fallback used to compensate but only made the match
// wronger (lookup matched the bar 10 min before the real signal). See audit
// refactors/2026-05-24-poly-btc-5-label-audit.md.
function msToBarOpen(ms) {
  const approx = ms - 60 * 1000;
  const d      = new Date(approx);
  const barMin = Math.floor(d.getUTCMinutes() / 5) * 5;
  return new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), barMin, 0, 0
  )).toISOString();
}

async function main() {
  if (!BOT_TOKEN)  { log('ERROR: DISCORD_BOT_TOKEN not set'); process.exit(1); }
  if (!CHANNEL_ID) { log('ERROR: POLY_BTC_5_SIGNALS_CHANNEL_ID not set'); process.exit(1); }
  if (DRY_RUN)     log('DRY RUN — reactions will be logged but not posted');

  let trades = [];
  try {
    trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch (e) {
    log(`Cannot read trades file: ${e.message}`);
    process.exit(1);
  }

  // Build lookup: barOpen ISO string → trade entry (resolved signals only)
  const tradeByBar = new Map();
  for (const t of trades) {
    if (t.signaled && t.outcome !== null && t.correct !== null) {
      tradeByBar.set(t.barOpen, t);
    }
  }
  log(`Trades: ${trades.length} total, ${tradeByBar.size} resolved signals`);

  // Stop paging once messages are older than our oldest trade (+ 10-min buffer)
  let oldestTradeMs = Infinity;
  for (const bar of tradeByBar.keys()) {
    const ms = new Date(bar).getTime();
    if (ms < oldestTradeMs) oldestTradeMs = ms;
  }

  let before;
  let checked = 0, reacted = 0, fixed = 0, skipped = 0, errors = 0;

  while (true) {
    const messages = await getChannelMessages(BOT_TOKEN, CHANNEL_ID, { limit: 100, before });
    if (!messages.length) { log('No more messages in channel'); break; }

    log(`Page: ${messages.length} msgs  newest=${messages[0].id}  oldest=${messages[messages.length - 1].id}`);

    for (const msg of messages) {
      checked++;

      // Only process embed messages (all signal posts are embeds; skip plain text/errors)
      if (!msg.embeds?.length) { skipped++; continue; }

      const existingEmojis = (msg.reactions || []).map(r => r.emoji?.name ?? '');
      const hasCheck = existingEmojis.includes('✅');
      const hasCross = existingEmojis.includes('❌');

      // Decode bar time from message snowflake. The -60s decoder is exact for
      // trigger-check.js posts (always fires 1 min after bar open). No fallback
      // — earlier "try prev bar" fallback was matching messages to bars 5 min
      // before the signal, posting outcomes of the wrong bar.
      const msgMs   = snowflakeToMs(msg.id);
      const barOpen = msToBarOpen(msgMs);
      const trade   = tradeByBar.get(barOpen);

      if (!trade) {
        // No matching resolved signal — unresolved bar, error embed, or market-discovery notice
        skipped++;
        continue;
      }

      const correctEmoji = trade.correct ? '✅' : '❌';
      const wrongEmoji   = trade.correct ? '❌' : '✅';
      const hasCorrect   = trade.correct ? hasCheck : hasCross;
      const hasWrong     = trade.correct ? hasCross : hasCheck;

      // Case A: already has the right one (and no wrong one) — done
      if (hasCorrect && !hasWrong) { skipped++; continue; }

      // Case B: has the WRONG emoji — only fix if --fix-wrong was passed
      if (hasWrong && !FIX_WRONG) {
        log(`  mismatch (skipped, pass --fix-wrong): msg=${msg.id}  bar=${trade.barOpen}  has=${wrongEmoji}  should=${correctEmoji}`);
        skipped++;
        continue;
      }

      log(`${DRY_RUN ? '[dry] ' : ''}${hasWrong ? '🔧FIX' : '   '} ${correctEmoji}  msg=${msg.id}  bar=${trade.barOpen}  correct=${trade.correct}`);

      if (!DRY_RUN) {
        if (hasWrong) {
          const removed = await removeOwnReaction(BOT_TOKEN, CHANNEL_ID, msg.id, wrongEmoji);
          if (!removed) {
            log(`  ⚠ could not remove ${wrongEmoji} from ${msg.id} (bot may not own that reaction)`);
            // Continue anyway — addReaction below still posts the correct one
          }
          await sleep(350);
        }
        const ok = await addReaction(BOT_TOKEN, CHANNEL_ID, msg.id, correctEmoji);
        if (ok) {
          if (hasWrong) fixed++; else reacted++;
          await sleep(350); // stay well under Discord's 5 reactions/sec per-channel limit
        } else {
          log(`  ⚠ reaction failed for ${msg.id}`);
          errors++;
        }
      } else {
        if (hasWrong) fixed++; else reacted++;
      }
    }

    const oldestInBatch   = messages[messages.length - 1].id;
    const oldestInBatchMs = snowflakeToMs(oldestInBatch);

    if (oldestInBatchMs < oldestTradeMs - 10 * 60 * 1000) {
      log('Oldest batch message predates all trades — stopping');
      break;
    }

    before = oldestInBatch;
    await sleep(500); // rate-limit buffer between page fetches
  }

  log(`Done — checked: ${checked}  reacted(new): ${reacted}  fixed(wrong→right): ${fixed}  skipped: ${skipped}  errors: ${errors}`);
}

main().catch(e => { console.error('[backfill] Fatal:', e.message); process.exit(1); });
