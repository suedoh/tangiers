#!/usr/bin/env node
'use strict';

/**
 * BZ! — Session-Aware Zone Proximity Trigger
 *
 * Runs every minute via crontab. Self-exits during dead zones.
 * Active during: Asia (6pm–1am ET), London (2am–8am ET), NY (8am–2:30pm ET)
 *
 * What it does:
 *   1. Checks current ET time — exits silently if in dead zone (5pm–6pm ET)
 *   2. Connects to TradingView Desktop via CDP
 *   3. Reads price, ATR, supply/demand zones, CVD, OI, VWAP, Session VP
 *   4. Checks zone proximity using ATR-based buffer: max(atr14 × 0.35, 1.50)
 *   5. Session-based cooldown: one alert per zone per session
 *   6. Posts Approaching alert if near zone, triggers full analysis if close
 *   7. Restores original symbol before exiting
 *
 * Crontab: * * * * * TZ=America/New_York node /Users/vpm/trading/scripts/bz/trigger-check.js
 */

const path = require('path');
const fs   = require('fs');
const { spawnSync } = require('child_process');

const { loadEnv, ROOT }  = require('../lib/env');
const { acquireLock, releaseLock } = require('../lib/lock');
const {
  cdpConnect, getSymbol, setSymbol, setTimeframe, switchLayout, waitForPrice,
  getQuote, getStudyValues, getPineBoxes,
  getOHLCV, calcATR, sleep,
} = require('../lib/cdp');
const { classifyZones, isOnCooldown, setCooldown, zoneKey, currentSession } = require('../lib/zones');
const { postWebhook } = require('../lib/discord');

loadEnv();

if (process.env.TRADINGVIEW_ENABLED === 'false') {
  console.log('[bz-trigger] TRADINGVIEW_ENABLED=false — skipping');
  process.exit(0);
}
if (process.env.PRIMARY === 'false') {
  console.log('[bz-trigger] PRIMARY=false — secondary machine, skipping');
  process.exit(0);
}

const BZ_SYMBOL       = 'NYMEX:BZ1!';
const BZ_LAYOUT_ID    = process.env.BZ_LAYOUT_ID  || null;
const ACE_LAYOUT_ID   = process.env.ACE_LAYOUT_ID || null;
const BZ_SIGNALS_HOOK = process.env.BZ_DISCORD_SIGNALS_WEBHOOK;
const STATE_FILE      = path.join(ROOT, '.bz-trigger-state.json');
const ANALYZE_SCRIPT  = path.join(__dirname, 'analyze.js');
const NODE            = process.execPath;

// CDP error cooldown: avoid spamming if TradingView is closed
const CDP_ERROR_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

function log(msg) { console.log(`[${new Date().toISOString()}] [bz-trigger] ${msg}`); }
function readState()   { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

// ─── Session gate ─────────────────────────────────────────────────────────────

function getETHour() {
  // UTC-4 (EDT, summer 2026)
  return (new Date().getUTCHours() - 4 + 24) % 24;
}

function getETMinute() {
  return new Date().getUTCMinutes();
}

function shouldRun() {
  const etHour = getETHour();
  const etMin  = getETMinute();

  // NYMEX daily close: 5:00pm–6:00pm ET — always skip
  if (etHour === 17) return { run: false, reason: 'NYMEX daily close (17:00–18:00 ET)' };

  // Post-settle: 2:30pm–5:00pm ET — only run every 15 minutes
  if (etHour >= 14 && etHour < 17) {
    if (etHour === 14 && etMin < 30) return { run: true }; // before 2:30pm = still NY
    if (etMin % 15 !== 0) return { run: false, reason: 'post-settle throttle (run every 15min)' };
    return { run: true };
  }

  // Active sessions: Asia, London, NY — run every minute
  return { run: true };
}

// ─── Parse study values ───────────────────────────────────────────────────────

function parseStudies(studies) {
  const out = { vwap: null, vwapUpper: null, vwapLower: null, cvd: null, oi: null, sessionUp: 0, sessionDown: 0 };
  for (const s of (studies || [])) {
    const n = s.name || '';
    const v = s.values || {};
    if (/vwap/i.test(n)) {
      out.vwap      = parseFloat(v['VWAP']) || null;
      out.vwapUpper = parseFloat(v['Upper Band #1']) || null;
      out.vwapLower = parseFloat(v['Lower Band #1']) || null;
    }
    if (/cumulative volume delta/i.test(n)) {
      const raw = v['CVD'] || '';
      const neg = raw.includes('−') || raw.startsWith('-');
      const num = parseFloat(raw.replace(/[^0-9.]/g, '')) || 0;
      out.cvd = neg ? -num : num;
    }
    if (/open interest/i.test(n)) {
      const raw = v['Open Interest'] || '';
      out.oi = parseFloat(raw.replace(/[^0-9.]/g, '')) || null;
    }
    if (/session volume profile/i.test(n)) {
      out.sessionUp   = parseInt(v['Up']   || '0', 10) || 0;
      out.sessionDown = parseInt(v['Down'] || '0', 10) || 0;
    }
  }
  return out;
}

// ─── Format approaching alert ─────────────────────────────────────────────────

function buildApproachingAlert(price, zone, side, ind, distance, buffer, session) {
  const dir      = side === 'demand' ? 'LONG' : 'SHORT';
  const emoji    = side === 'demand' ? '🟢' : '🔴';
  const sessVPPct= ind.sessionUp + ind.sessionDown > 0
    ? Math.round(100 * ind.sessionUp / (ind.sessionUp + ind.sessionDown))
    : 50;

  return [
    `⚠️ **APPROACHING ${dir} ZONE — BZ! | ${session}**`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `${emoji} **Zone:** $${zone.low.toFixed(2)} – $${zone.high.toFixed(2)} (${side.toUpperCase()})`,
    `📍 **Price:** $${price.toFixed(2)}   Distance: $${distance.toFixed(2)}   Buffer: $${buffer.toFixed(2)}`,
    ``,
    `**Indicators**`,
    ind.vwap     ? `VWAP 4H:   $${ind.vwap.toFixed(2)}  ${price > ind.vwap ? '↑ Bullish' : '↓ Bearish'}` : '',
    ind.cvd      ? `CVD:       ${ind.cvd.toFixed(0)}  ${ind.cvd > 0 ? '↑' : '↓'}` : '',
    ind.oi       ? `OI:        ${(ind.oi/1000).toFixed(1)}K` : '',
    `Sess VP:   ${sessVPPct}% Up`,
    ``,
    `Full analysis running — post to follow.`,
    `React 📊 on the analysis card for a live update.`,
  ].filter(Boolean).join('\n');
}

// ─── Run full analysis (spawns analyze.js) ────────────────────────────────────

function runFullAnalysis(source, context) {
  log(`Spawning analyze.js | source="${source}"`);
  const args = [ANALYZE_SCRIPT, '--source', source];
  if (context) args.push('--context', context);
  const result = spawnSync(NODE, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error) log(`analyze.js spawn error: ${result.error.message}`);
  else log(`analyze.js exited ${result.status}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const gate = shouldRun();
  if (!gate.run) {
    log(`Skipping: ${gate.reason}`);
    return;
  }

  const session    = currentSession().split('-').slice(3).join('-'); // e.g. "asia"
  const sessionLabel = session.charAt(0).toUpperCase() + session.slice(1) + ' Session';
  const lockHolder = 'bz-trigger';

  const lock = await acquireLock(10_000, lockHolder);
  if (!lock) {
    log('Could not acquire lock — another script is running, skipping this cycle');
    return;
  }

  let client;
  let originalSymbol;
  let switchedLayout = false;

  try {
    const state = readState();

    // CDP error cooldown check
    if (state._lastCdpError && Date.now() - state._lastCdpError < CDP_ERROR_COOLDOWN_MS) {
      log('In CDP error cooldown — skipping');
      return;
    }

    client = await cdpConnect();
    originalSymbol = await getSymbol(client);

    const alreadyOnBZ = originalSymbol === BZ_SYMBOL || (originalSymbol || '').endsWith('BZ1!');
    if (!alreadyOnBZ) {
      if (BZ_LAYOUT_ID) {
        await client.Page.enable();
        await switchLayout(client, BZ_LAYOUT_ID, BZ_SYMBOL);
        switchedLayout = true;
      } else {
        await setSymbol(client, BZ_SYMBOL);
      }
    }

    await setTimeframe(client, '240');

    const quote  = await waitForPrice(client);
    const [studies, boxes, ohlcv] = await Promise.all([
      getStudyValues(client),
      getPineBoxes(client, 'LuxAlgo'),
      getOHLCV(client, 20),
    ]);

    const price = quote.last;
    if (!price) throw new Error('Could not read price');

    const { atr14, buffer } = calcATR(ohlcv);
    const ind = parseStudies(studies);

    log(`price=$${price.toFixed(2)} atr14=${atr14} buffer=${buffer} zones=${boxes.length}`);

    // Clear CDP error state on success
    if (state._lastCdpError) { delete state._lastCdpError; writeState(state); }

    // Classify zones against price
    const classified = classifyZones(boxes, price, buffer);
    const triggered  = classified.filter(z => z.inBuffer);

    if (triggered.length === 0) {
      log('No zones in proximity this cycle');
      return;
    }

    for (const zone of triggered) {
      const key   = zoneKey(zone);
      const side  = zone.side === 'above' ? 'supply' : zone.side === 'inside' ? 'inside' : 'demand';
      const label = `${side}:${key}`;

      if (isOnCooldown(state, label)) {
        log(`Zone ${key} (${side}) on cooldown for this session`);
        continue;
      }

      log(`TRIGGERED: ${side} zone $${zone.low}–$${zone.high} | distance=$${zone.distance} | buffer=$${buffer}`);

      // Mark cooldown immediately to prevent duplicate alerts
      setCooldown(state, label);
      writeState(state);

      // Post approaching alert
      const approaching = buildApproachingAlert(price, zone, side, ind, zone.distance, buffer, sessionLabel);
      if (BZ_SIGNALS_HOOK) {
        const footer = `BZ! • NYMEX:BZ1! • ${new Date().toUTCString().slice(5, 25)} UTC`;
        const msgId  = await postWebhook(BZ_SIGNALS_HOOK, 'approaching', approaching, footer);
        log(`Approaching alert posted${msgId ? ' id=' + msgId : ''}`);

        // Store for 📊 reaction polling
        if (!Array.isArray(state._signal_messages)) state._signal_messages = [];
        state._signal_messages.push({ id: msgId, firedAt: Date.now(), label: 'approaching', analyzed: false });
        if (state._signal_messages.length > 20) state._signal_messages = state._signal_messages.slice(-20);
        writeState(state);
      }

      // Spawn full analysis (restores symbol itself)
      const analysisSrc = `Zone Proximity | ${side} $${zone.low}–$${zone.high} | ${sessionLabel}`;
      runFullAnalysis(analysisSrc, null);

      // Only trigger once per cycle even if multiple zones in range
      break;
    }

  } catch (e) {
    log(`Error: ${e.message}`);
    const code = e.code || '';
    if (code === 'CDP_UNAVAILABLE' || code === 'NO_TARGET' || /ECONNREFUSED|connect/i.test(e.message)) {
      const state = readState();
      state._lastCdpError = Date.now();
      writeState(state);
      if (BZ_SIGNALS_HOOK) {
        const state2 = readState();
        const lastAlert = state2._lastCdpAlertAt || 0;
        if (Date.now() - lastAlert > CDP_ERROR_COOLDOWN_MS) {
          state2._lastCdpAlertAt = Date.now();
          writeState(state2);
          await postWebhook(BZ_SIGNALS_HOOK, 'error',
            `❌ **BZ! Monitor — TradingView Unreachable**\n**What:** CDP connection failed\n**Fix:** Open TradingView Desktop and switch to the 🕵Ace layout`,
            'BZ! • System Error');
        }
      }
    }
  } finally {
    try {
      if (client) {
        if (switchedLayout && ACE_LAYOUT_ID) {
          await client.Page.enable();
          await switchLayout(client, ACE_LAYOUT_ID);
        } else if (!switchedLayout && originalSymbol && originalSymbol !== BZ_SYMBOL) {
          await setSymbol(client, originalSymbol);
        }
      }
    } catch {}
    try { if (client) await client.close(); } catch {}
    releaseLock(lockHolder);
  }
}

main().catch(e => { console.error('[bz-trigger] Fatal:', e.message); });
