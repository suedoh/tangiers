#!/usr/bin/env node
'use strict';

/**
 * weather/market-scan.js — Polymarket Weather Signal Poller
 *
 * Runs every 15 minutes via crontab. For each active temperature market on
 * Polymarket it:
 *   1. Fetches multi-source weather forecasts (Open-Meteo ensemble + models + historical)
 *   2. Calculates edge vs. the market-implied probability
 *   3. Posts a Discord signal if edge ≥ MIN_EDGE (default 8%)
 *   4. Tracks open positions and resolves settled markets automatically
 *
 * State: .weather-state.json (cooldowns, signal IDs)
 * Trades: weather-trades.json (all signals with outcomes)
 *
 * Crontab:
 *   \/15 * * * *  node /path/to/trading/scripts/weather/market-scan.js
 */

const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

const { loadEnv, ROOT }        = require('../lib/env');
const { postWebhook }          = require('../lib/discord');
const { getForecast, getObserved } = require('../lib/forecasts');
const {
  fetchWeatherMarkets,
  getMarketPrice,
  kellySizing,
  marketUrl,
} = require('../lib/polymarket');

loadEnv();

if (process.env.PRIMARY === 'false') {
  console.log('[weather-scan] PRIMARY=false — skipping');
  process.exit(0);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SIGNALS_HOOK  = process.env.WEATHER_DISCORD_SIGNALS_WEBHOOK;
const BACKTEST_HOOK = process.env.WEATHER_DISCORD_BACKTEST_WEBHOOK;
const MIN_EDGE      = parseFloat(process.env.WEATHER_MIN_EDGE  || '0.08');  // 8%
const MIN_VOLUME    = parseFloat(process.env.WEATHER_MIN_VOLUME || '200');  // $200 min volume
const BANKROLL      = parseFloat(process.env.WEATHER_BANKROLL   || '500');  // paper bankroll
const KELLY_FRAC    = parseFloat(process.env.WEATHER_KELLY_FRAC  || '0.15');
const MAX_BET       = parseFloat(process.env.WEATHER_MAX_BET     || '100');
const COOLDOWN_MS   = 4 * 60 * 60 * 1000; // 4 hours between signals on same market

const STATE_FILE  = path.join(ROOT, '.weather-state.json');
const TRADES_FILE = path.join(ROOT, 'weather-trades.json');

function log(msg) { console.log(`[${new Date().toISOString()}] [weather-scan] ${msg}`); }
function readState()    { try { return JSON.parse(fs.readFileSync(STATE_FILE,  'utf8')); } catch { return { cooldowns: {}, signals: {} }; } }
function writeState(s)  { try { fs.writeFileSync(STATE_FILE,  JSON.stringify(s, null, 2)); } catch {} }
function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } }
function writeTrades(t) { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); } catch {} }

function signalId() {
  return 'wx-' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : 'N/A'; }
function usd(v) { return v != null ? '$' + v.toFixed(2) : 'N/A'; }
function bar(p, len = 12) {
  const filled = Math.round(p * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

/**
 * Build the Discord embed body for a weather signal.
 */
function buildSignalCard(market, forecast, kelly, side, edge, id) {
  const { parsed } = market;
  const cityLabel  = parsed.city.replace(/\b\w/g, c => c.toUpperCase());
  const typeLabel  = parsed.type === 'low' ? 'LOW' : 'HIGH';
  const dirLabel   = parsed.direction === 'above' ? '>' : '<';
  const icon       = side === 'yes' ? '🟢' : '🔴';
  const sideLabel  = side === 'yes' ? 'BUY YES' : 'BUY NO';

  const f  = forecast;
  const e  = f.ensemble;
  const m  = f.models;
  const h  = f.historical;

  const lines = [
    `## 🌡️ WEATHER SIGNAL — ${cityLabel} ${typeLabel} TEMP`,
    `**${market.question}**`,
    '',
    '**📊 MODEL CONSENSUS**',
  ];

  if (e) {
    const memberBar = bar(e.prob);
    lines.push(`GFS Ensemble   ${memberBar}  **${pct(e.prob)}** (${e.memberCount} members, mean ${e.mean.toFixed(1)}°F)`);
  }
  if (m?.models) {
    for (const [model, mv] of Object.entries(m.models)) {
      const label = model === 'ecmwf_ifs025' ? 'ECMWF IFS    '
                  : model === 'icon_global'   ? 'ICON Global  '
                  : 'GFS Det.     ';
      lines.push(`${label}  ${bar(mv.prob)}  **${pct(mv.prob)}** (fcst ${mv.forecast.toFixed(1)}°F, σ ${mv.sigma.toFixed(1)}°F)`);
    }
  }
  if (h) {
    lines.push(`10yr History   ${bar(h.prob)}  **${pct(h.prob)}** (${h.sampleSize} seasons, avg ${h.historicalMean.toFixed(1)}°F)`);
  }

  lines.push(
    `${'─'.repeat(44)}`,
    `**CONSENSUS       ${bar(f.consensus)}  ${pct(f.consensus)}**`,
    '',
    '**💰 MARKET vs MODEL**',
    `Market price: **${pct(market.yesPrice)} YES** / ${pct(market.noPrice)} NO`,
    `Model says:   **${pct(f.consensus)}** that temp ${dirLabel} ${parsed.thresholdF}°F`,
    `**Edge: ${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}% → ${icon} ${sideLabel}**`,
    '',
    '**📐 KELLY SIZING**',
    `Kelly: ${kelly.kelly}% → Fractional (${Math.round(KELLY_FRAC * 100)}%): **${usd(kelly.dollars)}** (bankroll ${usd(BANKROLL)})`,
    `Cap: ${usd(MAX_BET)} max per trade`,
    '',
    `⏱️ Resolves: **${parsed.date}**`,
    `📊 Volume: ${usd(market.volume)} | Liquidity: ${usd(market.liquidity)}`,
    `🔗 [View market](${marketUrl(market)})`,
    `📌 *Paper trade only — execute manually at polymarket.com*`,
    `\`\`\`ID: ${id}\`\`\``,
  );

  return lines.join('\n');
}

// ─── Outcome resolution ───────────────────────────────────────────────────────

/**
 * Check if any open trades have resolved and update their outcomes.
 */
async function resolveOutcomes(trades, state) {
  const now     = Date.now();
  let   changed = false;

  for (const trade of trades) {
    if (trade.outcome !== null) continue;

    const resDate = new Date(trade.parsed.date);
    // Only resolve if the target date is at least 1 day in the past (data lag)
    if (now < resDate.getTime() + 36 * 3_600_000) continue;

    try {
      const { value } = await getObserved(
        trade.parsed.coords.lat,
        trade.parsed.coords.lon,
        trade.parsed.date,
        trade.parsed.direction
      );

      if (value == null) continue;

      const hit = trade.parsed.direction === 'above'
        ? value > trade.parsed.thresholdF
        : value < trade.parsed.thresholdF;

      // Did our signal win?
      const signalWon = (trade.side === 'yes' && hit) || (trade.side === 'no' && !hit);

      trade.outcome      = hit ? 'yes-resolved' : 'no-resolved';
      trade.observedTemp = value;
      trade.signalResult = signalWon ? 'win' : 'loss';
      trade.closedAt     = new Date().toISOString();

      // Approximate P&L: if we bet $X on YES at price p and it hits, profit = X*(1-p)/p
      if (trade.betDollars > 0) {
        const price = trade.side === 'yes' ? trade.yesPrice : trade.noPrice;
        trade.pnlDollars = signalWon
          ? Math.round(trade.betDollars * (1 - price) / price * 100) / 100
          : -trade.betDollars;
      }

      changed = true;
      log(`Resolved ${trade.id}: ${trade.parsed.city} ${trade.parsed.date} — observed ${value.toFixed(1)}°F → ${signalWon ? 'WIN' : 'LOSS'}`);

      // Post outcome to backtest channel
      if (BACKTEST_HOOK) {
        const icon = signalWon ? '✅' : '❌';
        const body = [
          `${icon} **WEATHER SIGNAL RESOLVED — ${signalWon ? 'WIN' : 'LOSS'}**`,
          `${trade.question}`,
          `Signal: ${trade.side.toUpperCase()} at ${pct(trade.side === 'yes' ? trade.yesPrice : trade.noPrice)}`,
          `Observed: **${value.toFixed(1)}°F** (threshold ${trade.parsed.thresholdF}°F ${trade.parsed.direction})`,
          trade.betDollars > 0
            ? `P&L: **${trade.pnlDollars >= 0 ? '+' : ''}${usd(trade.pnlDollars)}** (bet ${usd(trade.betDollars)})`
            : '',
          `\`ID: ${trade.id}\``,
        ].filter(Boolean).join('\n');

        await postWebhook(BACKTEST_HOOK, signalWon ? 'long' : 'error', body, 'Weather • Outcome');
      }
    } catch (err) {
      log(`Error resolving ${trade.id}: ${err.message}`);
    }
  }

  return changed;
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function main() {
  log('Starting market scan...');

  if (!SIGNALS_HOOK) {
    log('WEATHER_DISCORD_SIGNALS_WEBHOOK not set — signals will only be logged, not posted to Discord');
  }

  const state  = readState();
  const trades = readTrades();

  // ── Step 1: resolve any settled positions ─────────────────────────────────
  const resolved = await resolveOutcomes(trades, state);
  if (resolved) writeTrades(trades);

  // ── Step 2: fetch active Polymarket weather markets ───────────────────────
  let markets;
  try {
    markets = await fetchWeatherMarkets();
    log(`Fetched ${markets.length} active weather markets`);
  } catch (err) {
    log(`Failed to fetch markets: ${err.message}`);
    if (SIGNALS_HOOK) {
      await postWebhook(SIGNALS_HOOK, 'error',
        `❌ **Weather scan failed — market fetch error**\n${err.message}`,
        'Weather • Error');
    }
    process.exit(1);
  }

  // Filter by minimum volume
  const candidates = markets.filter(m => m.volume >= MIN_VOLUME);
  log(`${candidates.length} markets meet volume threshold ($${MIN_VOLUME})`);

  // ── Step 3: evaluate each market ─────────────────────────────────────────
  let signalsFired = 0;
  const now = Date.now();

  for (const market of candidates) {
    const { conditionId, parsed } = market;

    // Skip markets resolving today (data may already be final, edge unreliable)
    const daysToResolution = (new Date(parsed.date) - now) / 86_400_000;
    if (daysToResolution < 0.25) continue;
    if (daysToResolution > 10)   continue; // beyond reliable ensemble window

    // Cooldown: don't re-signal same market within 4 hours
    const lastSignal = state.cooldowns?.[conditionId] || 0;
    if (now - lastSignal < COOLDOWN_MS) continue;

    // Already have an open trade for this market? Skip unless price has moved significantly.
    const existingTrade = trades.find(t => t.conditionId === conditionId && t.outcome === null);
    if (existingTrade) {
      // Only re-signal if market price has moved >10 pts since original signal
      const priceDiff = Math.abs(market.yesPrice - existingTrade.yesPrice);
      if (priceDiff < 0.10) continue;
      log(`Market ${conditionId} price moved ${(priceDiff * 100).toFixed(1)}pts — re-evaluating`);
    }

    log(`Evaluating: "${market.question.slice(0, 70)}..."`);

    // Fetch forecast
    let forecast;
    try {
      forecast = await getForecast(
        parsed.coords.lat,
        parsed.coords.lon,
        parsed.date,
        parsed.thresholdF,
        parsed.direction,
        { includeNWS: !!parsed.coords.nwsStation }
      );
    } catch (err) {
      log(`Forecast error for ${conditionId}: ${err.message}`);
      continue;
    }

    if (forecast.consensus == null) {
      log(`No consensus probability for ${conditionId} — skipping`);
      continue;
    }

    // Refresh price from CLOB (fresher than Gamma outcomePrices)
    const livePrice = await getMarketPrice(conditionId).catch(() => null);
    if (livePrice) {
      market.yesPrice = livePrice.yes;
      market.noPrice  = livePrice.no;
    }

    // ── Edge calculation ──────────────────────────────────────────────────
    const yesEdge = forecast.consensus - market.yesPrice;
    const noEdge  = (1 - forecast.consensus) - market.noPrice;

    const side = yesEdge >= noEdge ? 'yes' : 'no';
    const edge = side === 'yes' ? yesEdge : noEdge;

    if (edge < MIN_EDGE) {
      log(`Edge ${(edge * 100).toFixed(1)}% below threshold — skip`);
      continue;
    }

    // ── Kelly sizing ──────────────────────────────────────────────────────
    const kelly = kellySizing(forecast.consensus, market.yesPrice, side, BANKROLL, KELLY_FRAC, MAX_BET);

    // ── Build and post signal ─────────────────────────────────────────────
    const id   = signalId();
    const card = buildSignalCard(market, forecast, kelly, side, edge, id);
    const footer = `Weather • ${parsed.city} • ${parsed.date} • ${new Date().toISOString().slice(0, 16)} UTC`;

    let msgId = null;
    if (SIGNALS_HOOK) {
      msgId = await postWebhook(SIGNALS_HOOK, side === 'yes' ? 'long' : 'short', card, footer);
    }

    // Log to backtest channel
    if (BACKTEST_HOOK) {
      const shortLog = [
        `📋 **SIGNAL LOGGED** | ${side.toUpperCase()} | Edge ${(edge * 100).toFixed(1)}%`,
        `${market.question}`,
        `Model: ${pct(forecast.consensus)} | Market: ${pct(market.yesPrice)} YES`,
        `Suggested: ${usd(kelly.dollars)} on ${side.toUpperCase()}`,
        `\`ID: ${id}\``,
      ].join('\n');
      await postWebhook(BACKTEST_HOOK, 'info', shortLog, `Weather • ${parsed.date}`);
    }

    // Save trade record
    const tradeRecord = {
      id,
      conditionId,
      question:    market.question,
      parsed,
      side,
      edge:        Math.round(edge * 1000) / 10,
      yesPrice:    market.yesPrice,
      noPrice:     market.noPrice,
      modelProb:   Math.round(forecast.consensus * 1000) / 10,
      betDollars:  kelly.dollars,
      firedAt:     new Date().toISOString(),
      discordMsgId: msgId,
      sources:     forecast.sources,
      outcome:     null,
      observedTemp: null,
      signalResult: null,
      pnlDollars:   null,
      closedAt:    null,
    };

    // Replace existing open trade if price moved
    if (existingTrade) {
      const idx = trades.findIndex(t => t.id === existingTrade.id);
      if (idx !== -1) trades[idx] = { ...trades[idx], supersededBy: id, outcome: 'superseded' };
    }
    trades.push(tradeRecord);
    writeTrades(trades);

    // Set cooldown
    if (!state.cooldowns) state.cooldowns = {};
    state.cooldowns[conditionId] = now;
    if (!state.signals) state.signals = {};
    if (msgId) state.signals[id] = msgId;
    writeState(state);

    log(`Signal fired: ${id} | ${side.toUpperCase()} | edge ${(edge * 100).toFixed(1)}% | $${kelly.dollars}`);
    signalsFired++;
  }

  log(`Scan complete. ${signalsFired} signal(s) fired.`);
}

main().catch(err => {
  console.error('[weather-scan] Fatal error:', err);
  process.exit(1);
});
