#!/usr/bin/env node
'use strict';

/**
 * scripts/ew/run.js — Scheduled EW analysis entry point
 *
 * Invoked by:
 *   - cron 6×/day at 4H bar closes + 5 min (00:05, 04:05, 08:05, 12:05, 16:05, 20:05 UTC)
 *   - manually via `make ew`
 *   - via the !ew Discord handler (passes --manual --user=...)
 *
 * Posts the result to #btc-ew-signals and persists to ew-forecasts.json.
 *
 * Architecture conformance:
 *   - PRIMARY=true and TRADINGVIEW_ENABLED=true required (matches all CDP scripts)
 *   - Uses scripts/lib/cdp.js (no MCP)
 *   - Loads .env via scripts/lib/env.js
 *   - Errors post to #btc-ew-signals as `error` alert and exit non-zero
 */

const path = require('path');
const { loadEnv } = require('../lib/env');

loadEnv();

const { runProtocol } = require('./protocol');
const formatter      = require('./formatter');
const { postWithFiles } = require('./discord-upload');
const storage        = require('./storage');

// ─── Guards ──────────────────────────────────────────────────────────────────

const PRIMARY             = process.env.PRIMARY === 'true';
const TRADINGVIEW_ENABLED = process.env.TRADINGVIEW_ENABLED === 'true';
const SIGNALS_WEBHOOK     = process.env.BTC_EW_SIGNALS_WEBHOOK;

function exitGuard(reason) {
  console.log(`[ew/run] skipping: ${reason}`);
  process.exit(0);
}

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isManual = args.includes('--manual');
const userArg  = args.find(a => a.startsWith('--user='));
const userName = userArg ? userArg.slice('--user='.length) : null;

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  if (!PRIMARY)             return exitGuard('PRIMARY != true');
  if (!TRADINGVIEW_ENABLED) return exitGuard('TRADINGVIEW_ENABLED != true');
  if (!SIGNALS_WEBHOOK || SIGNALS_WEBHOOK.startsWith('PENDING')) {
    console.error('[ew/run] BTC_EW_SIGNALS_WEBHOOK not set in .env — aborting');
    process.exit(1);
  }

  const generatedBy = isManual
    ? `manual:!ew${userName ? ` by @${userName}` : ''}`
    : 'scheduled';

  let forecast;
  try {
    forecast = await runProtocol({ generatedBy });
  } catch (e) {
    console.error('[ew/run] runProtocol failed:', e.message);
    await postError(`EW analysis failed: ${e.message}`);
    process.exit(2);
  }

  // Build screenshot list for multipart upload (file basenames for inline refs)
  const fileList = [];
  const shotMap  = {};   // tf → basename (for formatter)
  for (const tf of ['1D', '4H', '1H']) {
    const p = forecast.chartScreenshots && forecast.chartScreenshots[tf];
    if (p) {
      const name = path.basename(p);
      fileList.push({ path: p, name });
      shotMap[tf] = name;
    }
  }

  // Build embeds
  const payload = forecast.ambiguous
    ? formatter.formatAmbiguous(forecast, shotMap)
    : formatter.formatActive(forecast, shotMap);

  // Post to #btc-ew-signals
  let messageId = null;
  try {
    messageId = await postWithFiles(SIGNALS_WEBHOOK, payload.embeds, fileList, {
      username: 'Ace EW',
    });
  } catch (e) {
    console.error('[ew/run] discord post failed:', e.message);
  }

  forecast.discordMessageId = messageId;

  // Persist
  try {
    storage.appendForecast(forecast);
    storage.withState(state => {
      state.lastRunAt = forecast.generatedAt;
      if (!state.openForecastIds) state.openForecastIds = [];
      if (forecast.status === 'open') state.openForecastIds.push(forecast._id);
    });
  } catch (e) {
    console.error('[ew/run] storage failed:', e.message);
  }

  const tag = forecast.ambiguous ? 'AMBIGUOUS' : 'POSTED';
  console.log(`[ew/run] ${tag} forecast=${forecast._id} slot=${forecast.scheduleSlot} confluence=${forecast.confluenceFlag} msg=${messageId || 'none'}`);
  process.exit(0);
})();

// ─── Error helper ────────────────────────────────────────────────────────────

async function postError(text) {
  if (!SIGNALS_WEBHOOK || SIGNALS_WEBHOOK.startsWith('PENDING')) return;
  const ts = new Date().toISOString();
  const embeds = [{
    title: '❌ EW analysis error',
    description: text,
    color: 0xed4245,
    timestamp: ts,
    footer: { text: 'Ace EW · run.js · check logs/ew-run.log' },
  }];
  try {
    const { postEmbedsOnly } = require('./discord-upload');
    await postEmbedsOnly(SIGNALS_WEBHOOK, embeds, { username: 'Ace EW' });
  } catch (e) {
    console.error('[ew/run] error post failed:', e.message);
  }
}
