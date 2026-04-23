#!/usr/bin/env node
'use strict';

/**
 * weather/market-scan.js — Polymarket Weather Signal Poller
 *
 * Runs every 15 minutes via crontab. For each active temperature market on
 * Polymarket it:
 *   1. Fetches active bucket markets via event slugs (city × next 5 days)
 *   2. Groups markets by event (city + date)
 *   3. Calls getTemperatureForecast() ONCE per event group
 *   4. Evaluates each bucket market against the model temperature distribution
 *   5. Signals the highest-edge bucket per event group (if edge ≥ MIN_EDGE)
 *   6. Tracks open positions and resolves settled markets automatically
 *
 * State: .weather-state.json (cooldowns, signal IDs)
 * Trades: weather-trades.json (all signals with outcomes)
 *
 * Crontab:
 *   \/15 * * * *  node /path/to/trading/scripts/weather/market-scan.js
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const { loadEnv, ROOT, resolveWebhook } = require('../lib/env');
const { postWebhook }                   = require('../lib/discord');
const { getObserved, getTemperatureForecast, normalCDF, thresholdProbability, leadTimeSigma } = require('../lib/forecasts');
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

const SIGNALS_HOOK  = resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK');
const BACKTEST_HOOK = resolveWebhook('WEATHER_DISCORD_BACKTEST_WEBHOOK');
const MIN_EDGE      = parseFloat(process.env.WEATHER_MIN_EDGE   || '0.08');  // 8%
const MIN_VOLUME    = parseFloat(process.env.WEATHER_MIN_VOLUME || '200');   // $200 min volume
const BANKROLL      = parseFloat(process.env.WEATHER_BANKROLL   || '500');   // paper bankroll
const KELLY_FRAC    = parseFloat(process.env.WEATHER_KELLY_FRAC || '0.15');
const MAX_BET       = parseFloat(process.env.WEATHER_MAX_BET    || '100');
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

function pct(v)   { return v != null ? (v * 100).toFixed(1) + '%' : 'N/A'; }
function usd(v)   { return v != null ? '$' + v.toFixed(2) : 'N/A'; }
function bar(p, len = 12) {
  const filled = Math.round(p * len);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, len - filled));
}

/**
 * Compute model probability for a single bucket market given mean+sigma.
 * direction='range' uses the probability mass between thresholdF and thresholdHighF.
 */
function bucketModelProb(parsed, meanF, sigmaF) {
  if (meanF == null) return null;

  let prob;
  if (parsed.direction === 'above') {
    prob = thresholdProbability(meanF, parsed.thresholdF, sigmaF, 'above');
  } else if (parsed.direction === 'below') {
    prob = thresholdProbability(meanF, parsed.thresholdF, sigmaF, 'below');
  } else if (parsed.direction === 'range') {
    // P(lo ≤ T ≤ hi) = P(T > lo) - P(T > hi)
    const pAboveLo = thresholdProbability(meanF, parsed.thresholdF,     sigmaF, 'above');
    const pAboveHi = thresholdProbability(meanF, parsed.thresholdHighF, sigmaF, 'above');
    prob = pAboveLo - pAboveHi;
  } else {
    return null;
  }

  // Clamp to [0.005, 0.995]
  return Math.min(0.995, Math.max(0.005, prob));
}

/**
 * Build a human-readable threshold label for the signal card.
 */
function thresholdLabel(parsed, unit = 'F') {
  const u = `°${unit}`;
  if (parsed.direction === 'above') return `≥${parsed.thresholdF}${u}`;
  if (parsed.direction === 'below') return `≤${parsed.thresholdF}${u}`;
  if (parsed.direction === 'range') return `${parsed.thresholdF}${u}–${parsed.thresholdHighF}${u}`;
  return `${parsed.thresholdF}${u}`;
}

/**
 * Build the Discord embed body for a weather signal.
 */
function buildSignalCard(market, forecast, kelly, side, edge, modelProb, id) {
  const { parsed }  = market;
  const cityLabel   = parsed.city.replace(/\b\w/g, c => c.toUpperCase());
  const typeLabel   = parsed.type === 'low' ? 'LOW' : 'HIGH';
  const bucketLabel = thresholdLabel(parsed);
  const icon        = side === 'yes' ? '🟢' : '🔴';
  const sideLabel   = side === 'yes' ? 'BUY YES' : 'BUY NO';

  const meanStr  = forecast.meanF != null ? `${forecast.meanF.toFixed(1)}°F` : 'N/A';
  const sigmaStr = `±${forecast.sigmaF.toFixed(1)}°F`;

  const lines = [
    `## 🌡️ WEATHER SIGNAL — ${cityLabel} ${typeLabel} TEMP`,
    `**${market.question}**`,
    '',
    '**📊 MODEL TEMPERATURE FORECAST**',
    `Model mean:      **${meanStr}** ${sigmaStr} uncertainty`,
  ];

  if (forecast.ensemble) {
    const e = forecast.ensemble;
    lines.push(`GFS Ensemble:    ${bar(e.prob)}  **${pct(e.prob)}** above 72°F ref (${e.memberCount} members)`);
  }
  if (forecast.models?.models) {
    for (const [model, mv] of Object.entries(forecast.models.models)) {
      const label = {
        ecmwf_aifs025: 'AIFS   ',
        ecmwf_ifs025:  'IFS    ',
        icon_global:   'ICON   ',
        gfs_seamless:  'GFS    ',
        gfs_hrrr:      'HRRR   ',
      }[model] || model;
      lines.push(`${label}         fcst ${mv.forecast.toFixed(1)}°F`);
    }
  }

  lines.push(
    '',
    `**🎯 BUCKET ANALYSIS: ${bucketLabel}**`,
    `Model P(bucket): ${bar(modelProb)}  **${pct(modelProb)}**`,
    `${'─'.repeat(44)}`,
    '',
    '**💰 MARKET vs MODEL**',
    `Market price:  **${pct(market.yesPrice)} YES** / ${pct(market.noPrice)} NO`,
    `Model P(YES):  **${pct(modelProb)}** that temp is ${bucketLabel}`,
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
    `Sources: ${forecast.sources.join(' · ')}`,
    `\`\`\`ID: ${id}\`\`\``,
  );

  return lines.join('\n');
}

// ─── Outcome resolution ───────────────────────────────────────────────────────

/**
 * Check if any open trades have resolved and update their outcomes.
 */
async function resolveOutcomes(trades) {
  const now     = Date.now();
  let   changed = false;

  for (const trade of trades) {
    if (trade.outcome !== null) continue;

    const resDate = new Date(trade.parsed.date);
    if (now < resDate.getTime() + 36 * 3_600_000) continue;

    try {
      const { value } = await getObserved(
        trade.parsed.coords.lat,
        trade.parsed.coords.lon,
        trade.parsed.date,
        trade.parsed.direction === 'below' ? 'below' : 'above'
      );

      if (value == null) continue;

      let hit;
      if (trade.parsed.direction === 'above') {
        hit = value >= trade.parsed.thresholdF;
      } else if (trade.parsed.direction === 'below') {
        hit = value <= trade.parsed.thresholdF;
      } else if (trade.parsed.direction === 'range') {
        hit = value >= trade.parsed.thresholdF && value <= trade.parsed.thresholdHighF;
      } else {
        hit = value > trade.parsed.thresholdF;
      }

      const signalWon = (trade.side === 'yes' && hit) || (trade.side === 'no' && !hit);

      trade.outcome      = hit ? 'yes-resolved' : 'no-resolved';
      trade.observedTemp = value;
      trade.signalResult = signalWon ? 'win' : 'loss';
      trade.closedAt     = new Date().toISOString();

      if (trade.betDollars > 0) {
        const price = trade.side === 'yes' ? trade.yesPrice : trade.noPrice;
        trade.pnlDollars = signalWon
          ? Math.round(trade.betDollars * (1 - price) / price * 100) / 100
          : -trade.betDollars;
      }

      changed = true;
      const bucketLbl = thresholdLabel(trade.parsed);
      log(`Resolved ${trade.id}: ${trade.parsed.city} ${trade.parsed.date} ${bucketLbl} — observed ${value.toFixed(1)}°F → ${signalWon ? 'WIN' : 'LOSS'}`);

      if (BACKTEST_HOOK) {
        const icon = signalWon ? '✅' : '❌';
        const body = [
          `${icon} **WEATHER SIGNAL RESOLVED — ${signalWon ? 'WIN' : 'LOSS'}**`,
          `${trade.question}`,
          `Signal: ${trade.side.toUpperCase()} at ${pct(trade.side === 'yes' ? trade.yesPrice : trade.noPrice)}`,
          `Observed: **${value.toFixed(1)}°F** (bucket ${bucketLbl})`,
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
  const resolved = await resolveOutcomes(trades);
  if (resolved) writeTrades(trades);

  // ── Step 2: fetch active Polymarket weather markets (event-slug based) ────
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

  // ── Step 3: group markets by event (city + date) ──────────────────────────
  const now = Date.now();
  const eventGroups = new Map(); // key: 'city|date' → array of markets

  for (const market of candidates) {
    const { parsed } = market;

    // Skip markets resolving today or beyond reliable ensemble window
    const daysToResolution = (new Date(parsed.date) - now) / 86_400_000;
    if (daysToResolution < 0.25) continue;
    if (daysToResolution > 10)   continue;

    const groupKey = `${parsed.city}|${parsed.date}`;
    if (!eventGroups.has(groupKey)) eventGroups.set(groupKey, []);
    eventGroups.get(groupKey).push(market);
  }

  log(`${eventGroups.size} event groups to evaluate`);

  // ── Step 4: evaluate each event group ────────────────────────────────────
  let signalsFired = 0;

  for (const [groupKey, groupMarkets] of eventGroups) {
    const firstMarket = groupMarkets[0];
    const { parsed }  = firstMarket;
    const coords      = parsed.coords;

    if (!coords) {
      log(`No coords for group ${groupKey} — skipping`);
      continue;
    }

    // Fetch temperature forecast ONCE per event group
    let forecast;
    try {
      forecast = await getTemperatureForecast(coords.lat, coords.lon, parsed.date);
    } catch (err) {
      log(`Forecast error for ${groupKey}: ${err.message}`);
      continue;
    }

    log(`${groupKey}: mean=${forecast.meanF != null ? forecast.meanF.toFixed(1) + '°F' : 'N/A'} σ=${forecast.sigmaF.toFixed(1)}°F (${forecast.sources.join(', ')})`);

    // Score each bucket market in this group
    let bestMarket    = null;
    let bestEdge      = -Infinity;
    let bestSide      = null;
    let bestModelProb = null;

    for (const market of groupMarkets) {
      const { conditionId, parsed: mp } = market;

      // Cooldown: don't re-signal same market within 4 hours
      const lastSignal = state.cooldowns?.[conditionId] || 0;
      if (now - lastSignal < COOLDOWN_MS) continue;

      // Skip if we already have an open non-superseded trade for this market
      // (unless price has moved >10pts)
      const existingTrade = trades.find(t => t.conditionId === conditionId && t.outcome === null);
      if (existingTrade) {
        const priceDiff = Math.abs(market.yesPrice - existingTrade.yesPrice);
        if (priceDiff < 0.10) continue;
        log(`Market ${conditionId} price moved ${(priceDiff * 100).toFixed(1)}pts — re-evaluating`);
      }

      const modelProb = bucketModelProb(mp, forecast.meanF, forecast.sigmaF);
      if (modelProb == null) continue;

      const yesEdge = modelProb - market.yesPrice;
      const noEdge  = (1 - modelProb) - market.noPrice;

      const side = yesEdge >= noEdge ? 'yes' : 'no';
      const edge = Math.max(yesEdge, noEdge);

      if (edge > bestEdge) {
        bestEdge      = edge;
        bestMarket    = market;
        bestSide      = side;
        bestModelProb = modelProb;
      }
    }

    if (bestMarket == null || bestEdge < MIN_EDGE) {
      if (bestMarket != null) {
        log(`${groupKey}: best edge ${(bestEdge * 100).toFixed(1)}% below threshold — skip`);
      }
      continue;
    }

    // ── Signal the best bucket in this event group ──────────────────────────
    const { conditionId, parsed: mp } = bestMarket;
    log(`Signalling: "${bestMarket.question.slice(0, 80)}" edge=${(bestEdge * 100).toFixed(1)}% side=${bestSide}`);

    // Refresh price from CLOB
    const livePrice = await getMarketPrice(conditionId).catch(() => null);
    if (livePrice) {
      bestMarket.yesPrice = livePrice.yes;
      bestMarket.noPrice  = livePrice.no;
    }

    const kelly = kellySizing(bestModelProb, bestMarket.yesPrice, bestSide, BANKROLL, KELLY_FRAC, MAX_BET);
    const id    = signalId();
    const card  = buildSignalCard(bestMarket, forecast, kelly, bestSide, bestEdge, bestModelProb, id);
    const footer = `Weather • ${mp.city} • ${mp.date} • ${new Date().toISOString().slice(0, 16)} UTC`;

    let msgId = null;
    if (SIGNALS_HOOK) {
      msgId = await postWebhook(SIGNALS_HOOK, bestSide === 'yes' ? 'long' : 'short', card, footer);
    }

    if (BACKTEST_HOOK) {
      const shortLog = [
        `📋 **SIGNAL LOGGED** | ${bestSide.toUpperCase()} | Edge ${(bestEdge * 100).toFixed(1)}%`,
        `${bestMarket.question}`,
        `Model P: ${pct(bestModelProb)} | Market: ${pct(bestMarket.yesPrice)} YES`,
        `Suggested: ${usd(kelly.dollars)} on ${bestSide.toUpperCase()}`,
        `\`ID: ${id}\``,
      ].join('\n');
      await postWebhook(BACKTEST_HOOK, 'info', shortLog, `Weather • ${mp.date}`);
    }

    // Save trade record
    const existingTrade = trades.find(t => t.conditionId === conditionId && t.outcome === null);
    const tradeRecord = {
      id,
      conditionId,
      question:      bestMarket.question,
      parsed:        mp,
      eventSlug:     bestMarket.eventSlug || null,
      side:          bestSide,
      edge:          Math.round(bestEdge * 1000) / 10,
      yesPrice:      bestMarket.yesPrice,
      noPrice:       bestMarket.noPrice,
      modelProb:     Math.round(bestModelProb * 1000) / 10,
      meanF:         forecast.meanF != null ? Math.round(forecast.meanF * 10) / 10 : null,
      sigmaF:        Math.round(forecast.sigmaF * 10) / 10,
      betDollars:    kelly.dollars,
      firedAt:       new Date().toISOString(),
      discordMsgId:  msgId,
      sources:       forecast.sources,
      outcome:       null,
      observedTemp:  null,
      signalResult:  null,
      pnlDollars:    null,
      closedAt:      null,
    };

    if (existingTrade) {
      const idx = trades.findIndex(t => t.id === existingTrade.id);
      if (idx !== -1) trades[idx] = { ...trades[idx], supersededBy: id, outcome: 'superseded' };
    }
    trades.push(tradeRecord);
    writeTrades(trades);

    if (!state.cooldowns) state.cooldowns = {};
    state.cooldowns[conditionId] = now;
    if (!state.signals) state.signals = {};
    if (msgId) state.signals[id] = msgId;
    writeState(state);

    log(`Signal fired: ${id} | ${bestSide.toUpperCase()} | edge ${(bestEdge * 100).toFixed(1)}% | $${kelly.dollars}`);
    signalsFired++;
  }

  log(`Scan complete. ${signalsFired} signal(s) fired.`);
}

main().catch(err => {
  console.error('[weather-scan] Fatal error:', err);
  process.exit(1);
});
