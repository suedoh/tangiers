#!/usr/bin/env node
'use strict';

/**
 * scripts/ew/backtest.js — EW forecast lifecycle tracker
 *
 * Runs every 4H bar close + 10 min (i.e. 5 min after run.js completes).
 * For each open forecast × {1D,4H,1H} × {primary,alternate}, checks
 * current price against the three invalidation tiers and the target ladder.
 * Posts state-transition events to #btc-ew-backtest with the original
 * generation-time screenshot re-attached for context.
 *
 * Updates calibration buckets in .ew-state.json.
 *
 * Reads current price via Binance Futures public API (no TradingView /
 * CDP needed — cheaper, doesn't compete for the mutex).
 */

const path = require('path');
const https = require('https');
const { loadEnv } = require('../lib/env');

loadEnv();

const storage   = require('./storage');
const formatter = require('./formatter');
const { postWithFiles, postEmbedsOnly } = require('./discord-upload');

const PRIMARY            = process.env.PRIMARY === 'true';
const BACKTEST_WEBHOOK   = process.env.BTC_EW_BACKTEST_WEBHOOK;

// ─── Guards ──────────────────────────────────────────────────────────────────

if (!PRIMARY) { console.log('[ew/backtest] skipping: PRIMARY != true'); process.exit(0); }
if (!BACKTEST_WEBHOOK || BACKTEST_WEBHOOK.startsWith('PENDING')) {
  console.error('[ew/backtest] BTC_EW_BACKTEST_WEBHOOK not set — aborting'); process.exit(1);
}

// ─── Binance price fetch ─────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'AceTradingBot/1.1 (EW-backtest)' } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
      }
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Read current price + recent OHLC since `sinceMs`. Returns:
 *   { price: <last>, high: <max high since>, low: <min low since> }
 *
 * We need the high/low to detect intra-window crossings (price might have
 * touched the invalidation level then come back). Uses 5-min klines.
 */
async function readPriceWindow(sinceMs) {
  const tickerData = await httpGet('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT');
  const price = Number(tickerData.price);

  // Klines API: limit max 1500
  const since = Math.max(sinceMs, Date.now() - 7 * 24 * 60 * 60 * 1000);  // cap at 7 days
  const klinesUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=${since}&limit=1500`;
  const klines = await httpGet(klinesUrl);

  let hi = price, lo = price;
  if (Array.isArray(klines)) {
    for (const k of klines) {
      const high = Number(k[2]);
      const low  = Number(k[3]);
      if (high > hi) hi = high;
      if (low  < lo) lo = low;
    }
  }
  return { price, high: hi, low: lo };
}

// ─── Crossing detection ──────────────────────────────────────────────────────

/**
 * Did price cross `level` in `direction` during [sinceMs, now]?
 *   - For an up-impulse (W's go up), invalidation is BELOW; we look for low ≤ level
 *   - For a down-impulse, invalidation is ABOVE; we look for high ≥ level
 *
 * Direction string examples: 'up', 'down', 'up (corrective)', 'down (corrective)'.
 */
function crossedDown(level, window) { return window.low  <= level; }
function crossedUp  (level, window) { return window.high >= level; }

function isUpDirection(directionStr) {
  return /^up/i.test(directionStr || '');
}

// ─── Time formatting ─────────────────────────────────────────────────────────

function fmtDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// ─── Event evaluation ────────────────────────────────────────────────────────

/**
 * Evaluate a single (forecast, tf, slot) combination against the price window.
 * Returns an array of state-transition events. May be empty if nothing fired.
 *
 * Emits events for:
 *   - hard invalidation hit  → 'invalidated_hard'
 *   - soft invalidation hit  → 'invalidated_soft' (only if hard hasn't already fired)
 *   - truncation level hit   → 'truncation_warning'
 *   - target hit (1.0×, 1.618×, 2.618×) → 'target_hit' (one event per new level)
 */
function evaluateSlot(forecast, tf, slot, count, window, now) {
  const events = [];
  if (!count || !count.invalidations) return events;

  const direction = count.direction || '';
  const isUp = isUpDirection(direction);
  const inv  = count.invalidations;
  const targets = count.targets || {};

  // Track outcomes already recorded (so we don't re-fire the same event)
  if (!forecast.outcomes) forecast.outcomes = {};
  if (!forecast.outcomes[tf]) forecast.outcomes[tf] = {};
  if (!forecast.outcomes[tf][slot]) forecast.outcomes[tf][slot] = {};
  const o = forecast.outcomes[tf][slot];

  // Hard invalidation
  if (!o.invalidatedAt && inv.hard != null) {
    const hit = isUp ? crossedDown(inv.hard, window) : crossedUp(inv.hard, window);
    if (hit) {
      o.invalidationLevel = 'hard';
      o.invalidatedAt = now.toISOString();
      events.push({
        type: 'invalidated_hard',
        tf, slot,
        level: inv.hard,
        currentPrice: window.price,
        hitAt: o.invalidatedAt,
        timeOpen: fmtDuration(now - new Date(forecast.generatedAt)),
        originalConfidence: count.confidence,
      });
      return events;  // hard kills the count; no further events for this slot
    }
  }

  // Soft invalidation (only if not already in invalidated state)
  if (!o.invalidatedAt && !o.softFlippedAt && inv.soft != null) {
    const hit = isUp ? crossedDown(inv.soft, window) : crossedUp(inv.soft, window);
    if (hit) {
      o.softFlippedAt = now.toISOString();
      events.push({
        type: 'invalidated_soft',
        tf, slot,
        level: inv.soft,
        currentPrice: window.price,
        hitAt: o.softFlippedAt,
        timeOpen: fmtDuration(now - new Date(forecast.generatedAt)),
        originalConfidence: count.confidence,
      });
    }
  }

  // Truncation
  if (!o.truncationAt && inv.truncation != null) {
    const hit = isUp ? crossedUp(inv.truncation, window) : crossedDown(inv.truncation, window);
    if (hit) {
      o.truncationAt = now.toISOString();
      events.push({
        type: 'truncation_warning',
        tf, slot,
        level: inv.truncation,
        currentPrice: window.price,
        hitAt: o.truncationAt,
        timeOpen: fmtDuration(now - new Date(forecast.generatedAt)),
        originalConfidence: count.confidence,
      });
    }
  }

  // Targets — fire for each newly-hit target, in ascending Fib order
  if (!o.targets) o.targets = {};
  const targetOrder = ['1.0×W1', '1.618×W1', '2.618×W1', 'C-target'];
  for (const k of targetOrder) {
    if (targets[k] == null) continue;
    if (o.targets[k]) continue;  // already hit
    const level = targets[k];
    const hit = isUp ? crossedUp(level, window) : crossedDown(level, window);
    if (hit) {
      o.targets[k] = now.toISOString();
      o.hit = k;
      o.hitAt = now.toISOString();
      events.push({
        type: 'target_hit',
        tf, slot,
        target: k,
        level,
        currentPrice: window.price,
        hitAt: o.hitAt,
        timeOpen: fmtDuration(now - new Date(forecast.generatedAt)),
        originalConfidence: count.confidence,
      });
    }
  }

  return events;
}

/**
 * Determine the new overall status of a forecast given its outcomes map.
 * Hierarchy: target_hit > invalidated > expired > open
 */
function deriveStatus(forecast, now) {
  const exp = new Date(forecast.expiresAt);
  if (now >= exp) return 'expired';

  let anyTargetHit = false;
  let allInvalidated = true;

  for (const tf of ['1D', '4H', '1H']) {
    for (const slot of ['primary', 'alternate']) {
      const o = forecast.outcomes?.[tf]?.[slot] || {};
      if (o.hit) anyTargetHit = true;
      if (!o.invalidatedAt) allInvalidated = false;
    }
  }
  if (anyTargetHit) return 'target_hit';
  if (allInvalidated) return 'invalidated';
  return 'open';
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const now = new Date();
  const state = storage.loadState();
  const sinceMs = state.lastBacktestAt
    ? Math.max(new Date(state.lastBacktestAt).getTime() - 60_000, 0)
    : now.getTime() - 24 * 60 * 60 * 1000;  // first run: lookback 24h

  let window;
  try {
    window = await readPriceWindow(sinceMs);
  } catch (e) {
    console.error('[ew/backtest] price fetch failed:', e.message);
    process.exit(2);
  }

  const open = storage.getOpenForecasts(now);
  console.log(`[ew/backtest] open forecasts: ${open.length}, price ${window.price}, window high ${window.high} / low ${window.low}`);

  let totalEvents = 0;
  for (const forecast of open) {
    const allEvents = [];
    for (const tf of ['1D', '4H', '1H']) {
      const tfBlock = forecast.timeframes?.[tf];
      if (!tfBlock) continue;
      for (const slot of ['primary', 'alternate']) {
        const count = tfBlock[slot];
        if (!count) continue;
        const events = evaluateSlot(forecast, tf, slot, count, window, now);
        allEvents.push(...events);
      }
    }

    // Persist per-forecast updates and post events
    if (allEvents.length > 0) {
      // Update status
      forecast.status = deriveStatus(forecast, now);
      storage.updateForecast(forecast._id, {
        outcomes: forecast.outcomes,
        status:   forecast.status,
      });

      // For each event, post + update calibration
      for (const ev of allEvents) {
        await postEvent(forecast, ev);
        const isHit = ev.type === 'target_hit';
        if (ev.type === 'target_hit' || ev.type === 'invalidated_hard') {
          storage.incrementCalibration(ev.tf, ev.slot, ev.originalConfidence || 0, isHit);
        }
      }
      totalEvents += allEvents.length;
    } else if (now >= new Date(forecast.expiresAt)) {
      // Auto-expire
      storage.updateForecast(forecast._id, { status: 'expired' });
    }
  }

  // Persist state
  storage.withState(s => {
    s.lastBacktestAt = now.toISOString();
    // Refresh openForecastIds with currently-open ones
    const stillOpen = storage.getOpenForecasts(now).map(f => f._id);
    s.openForecastIds = stillOpen;
  });

  console.log(`[ew/backtest] events posted: ${totalEvents}`);
  process.exit(0);
})().catch(e => {
  console.error('[ew/backtest] fatal:', e);
  process.exit(3);
});

// ─── Posting ─────────────────────────────────────────────────────────────────

async function postEvent(forecast, event) {
  const payload = formatter.formatBacktestEvent(forecast, event);

  // Re-attach the original generation-time screenshot (the TF-specific one)
  const fs = require('fs');
  const screenshotPath = forecast.chartScreenshots?.[event.tf];
  const files = [];
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    const name = path.basename(screenshotPath);
    files.push({ path: screenshotPath, name });
    payload.embeds[0].image = { url: 'attachment://' + name };
  }

  try {
    if (files.length > 0) {
      await postWithFiles(BACKTEST_WEBHOOK, payload.embeds, files, { username: 'Ace EW Backtest' });
    } else {
      await postEmbedsOnly(BACKTEST_WEBHOOK, payload.embeds, { username: 'Ace EW Backtest' });
    }
  } catch (e) {
    console.error(`[ew/backtest] post failed for ${event.type}: ${e.message}`);
  }
}
