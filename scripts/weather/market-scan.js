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
const { getObserved, fetchGHCNObserved, fetchNWSObserved, getTemperatureForecast, normalCDF, thresholdProbability, leadTimeSigma } = require('../lib/forecasts');
const { analyzeSignal, deepAnalyzeSignal, fetchWUObservation } = require('../lib/weather-analysis');
const { getCityProfile } = require('../lib/city-profiles');
const { autoExit }      = require('./exit-monitor');
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

// ─── Temperature unit helpers ─────────────────────────────────────────────────

function fToC(f) { return (f - 32) * 5 / 9; }

/**
 * Format a temperature showing both °F and °C.
 * marketUnit ('F'|'C') determines which appears first — matching the market's native unit.
 * e.g. US city:            "64.7°F (18.2°C)"
 *      International city: "18.2°C (64.7°F)"
 */
function dualTemp(f, marketUnit = 'F') {
  const c = fToC(f);
  return marketUnit === 'C'
    ? `${c.toFixed(1)}°C (${f.toFixed(1)}°F)`
    : `${f.toFixed(1)}°F (${c.toFixed(1)}°C)`;
}

/**
 * Format a temperature delta (σ) in both units.
 * Sigma converts by scaling only (×5/9) — no offset.
 */
function dualSigma(sigmaF, marketUnit = 'F') {
  const sigmaC = sigmaF * 5 / 9;
  return marketUnit === 'C'
    ? `±${sigmaC.toFixed(1)}°C (±${sigmaF.toFixed(1)}°F)`
    : `±${sigmaF.toFixed(1)}°F (±${sigmaC.toFixed(1)}°C)`;
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
 * Build a threshold label showing both °F and °C.
 * marketUnit determines which appears first (primary = the market's native unit).
 */
function thresholdLabel(parsed, marketUnit = 'F') {
  const f1 = parsed.thresholdF;
  const f2 = parsed.thresholdHighF;
  const c1 = fToC(f1);
  const c2 = f2 != null ? fToC(f2) : null;

  if (parsed.direction === 'above') {
    return marketUnit === 'C'
      ? `≥${c1.toFixed(1)}°C (≥${f1.toFixed(1)}°F)`
      : `≥${f1.toFixed(1)}°F (≥${c1.toFixed(1)}°C)`;
  }
  if (parsed.direction === 'below') {
    return marketUnit === 'C'
      ? `≤${c1.toFixed(1)}°C (≤${f1.toFixed(1)}°F)`
      : `≤${f1.toFixed(1)}°F (≤${c1.toFixed(1)}°C)`;
  }
  if (parsed.direction === 'range' && c2 != null) {
    return marketUnit === 'C'
      ? `${c1.toFixed(1)}–${c2.toFixed(1)}°C (${f1.toFixed(1)}–${f2.toFixed(1)}°F)`
      : `${f1.toFixed(1)}–${f2.toFixed(1)}°F (${c1.toFixed(1)}–${c2.toFixed(1)}°C)`;
  }
  return marketUnit === 'C'
    ? `${c1.toFixed(1)}°C (${f1.toFixed(1)}°F)`
    : `${f1.toFixed(1)}°F (${c1.toFixed(1)}°C)`;
}

/**
 * Build the Discord embed body for a weather signal.
 * @param {object} [aiAnalysis]  Optional AI assessment from analyzeSignal()
 */
function buildSignalCard(market, forecast, kelly, side, edge, modelProb, id, aiAnalysis = null) {
  const { parsed }   = market;
  const marketUnit   = parsed.coords?.unit || 'F'; // 'F' for US, 'C' for international
  const cityLabel    = parsed.city.replace(/\b\w/g, c => c.toUpperCase());
  const typeLabel    = parsed.type === 'low' ? 'LOW' : 'HIGH';
  const bucketLabel  = thresholdLabel(parsed, marketUnit);
  const icon         = side === 'yes' ? '🟢' : '🔴';
  const sideLabel    = side === 'yes' ? 'BUY YES' : 'BUY NO';

  const meanStr  = forecast.meanF != null ? dualTemp(forecast.meanF, marketUnit) : 'N/A';
  const sigmaStr = dualSigma(forecast.sigmaF, marketUnit);

  const lines = [
    `## 🌡️ WEATHER SIGNAL — ${cityLabel} ${typeLabel} TEMP`,
    `**${market.question}**`,
    '',
    '**📊 MODEL TEMPERATURE FORECAST**',
    `Model mean:      **${meanStr}** ${sigmaStr} uncertainty`,
  ];

  if (forecast.historical) {
    const h = forecast.historical;
    lines.push(`GHCN climatology: hist mean ${dualTemp(h.mean, marketUnit)} · hist σ ${dualSigma(h.sigma, marketUnit)} (${h.sampleSize} seasons, station ${h.station})`);
  }
  if (forecast.ensemble) {
    const e = forecast.ensemble;
    const refTemp = dualTemp(72, marketUnit);
    lines.push(`GFS Ensemble:    ${bar(e.prob)}  **${pct(e.prob)}** above ${refTemp} ref (${e.memberCount} members)`);
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
      lines.push(`${label}         fcst ${dualTemp(mv.forecast, marketUnit)}`);
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
  );

  // AI analysis section
  if (aiAnalysis && (aiAnalysis.reasoning || aiAnalysis.flags?.length || aiAnalysis.decision !== 'take' || aiAnalysis.confidence != null || aiAnalysis.stage === 2)) {
    const decisionIcon = aiAnalysis.decision === 'take'   ? '✅'
                       : aiAnalysis.decision === 'reduce' ? '⚠️'
                       : '🚫';
    const decisionStr = aiAnalysis.decision === 'take'   ? `TAKE (${aiAnalysis.sizeMultiplier}× Kelly)`
                      : aiAnalysis.decision === 'reduce' ? `REDUCE → ${aiAnalysis.sizeMultiplier}× Kelly`
                      : 'SKIP';
    const confStr = aiAnalysis.confidence != null ? ` | Confidence: ${(aiAnalysis.confidence * 100).toFixed(0)}%` : '';
    const flagStr = aiAnalysis.flags?.length ? `🏷️ ${aiAnalysis.flags.join(' · ')}` : '';

    if (aiAnalysis.stage === 2 && aiAnalysis.steps) {
      // ── Deep analysis (5-step) card section ───────────────────────────
      lines.push(
        '',
        '**🔬 DEEP ANALYSIS (5-Step)**',
        `${decisionIcon} ${decisionStr}${confStr}`,
        aiAnalysis.summary ? `*"${aiAnalysis.summary}"*` : '',
        '',
        `**Step 1 — Models:**        ${aiAnalysis.steps.models       || '—'}`,
        `**Step 2 — Synoptic:**      ${aiAnalysis.steps.synoptic     || '—'}`,
        `**Step 3 — Microclimate:**  ${aiAnalysis.steps.microclimate || '—'}`,
        `**Step 4 — Observations:**  ${aiAnalysis.steps.observations || '—'}`,
        `**Step 5 — Pricing:**       ${aiAnalysis.steps.pricing      || '—'}`,
        flagStr,
        aiAnalysis.reasoning ? `*Stage 1 note: "${aiAnalysis.reasoning}"*` : '',
      );
    } else {
      // ── Standard Stage 1 only card section ────────────────────────────
      lines.push(
        '',
        '**🤖 AI ANALYSIS**',
        `${decisionIcon} ${decisionStr}${confStr}`,
        aiAnalysis.reasoning ? `*"${aiAnalysis.reasoning}"*` : '',
        flagStr,
      );
    }
  }

  lines.push(
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
      const coords  = trade.parsed.coords || {};
      const wantHigh = trade.parsed.direction !== 'below';

      // Fetch in priority order: GHCN (Polymarket's source) → NWS METAR → ERA5
      let value = null, observedSource = null;

      if (coords.ghcnStation) {
        const ghcn = await fetchGHCNObserved(coords.ghcnStation, trade.parsed.date).catch(() => null);
        if (ghcn) {
          const v = wantHigh ? ghcn.tmax : ghcn.tmin;
          if (v != null) { value = v; observedSource = ghcn.source; }
        }
      }
      if (value == null && coords.nwsStation) {
        const nws = await fetchNWSObserved(coords.nwsStation, trade.parsed.date, coords.tz).catch(() => null);
        if (nws) {
          const v = wantHigh ? nws.high : nws.low;
          if (v != null) { value = v; observedSource = nws.source; }
        }
      }
      if (value == null && coords.lat != null) {
        const era5 = await getObserved(coords.lat, coords.lon, trade.parsed.date, wantHigh ? 'above' : 'below').catch(() => null);
        if (era5?.value != null) { value = era5.value; observedSource = 'Open-Meteo ERA5'; }
      }

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

      trade.outcome        = hit ? 'yes-resolved' : 'no-resolved';
      trade.observedTemp   = value;
      trade.observedSource = observedSource;
      trade.signalResult   = signalWon ? 'win' : 'loss';
      trade.closedAt       = new Date().toISOString();
      if (trade.meanF != null) trade.modelBiasF = Math.round((value - trade.meanF) * 10) / 10;

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

  // ── Step 1.5: auto-exit open paper trades that hit exit conditions ─────────
  const exited = await autoExit(trades).catch(err => {
    log(`[exit-monitor] error: ${err.message}`);
    return false;
  });
  if (exited) writeTrades(trades);

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

    // Fetch temperature forecast ONCE per event group.
    // Pass ghcnStation so GHCN-Daily historical σ is used for sigma calibration
    // when NCEI_TOKEN is set (US cities only; international silently falls back).
    let forecast;
    try {
      forecast = await getTemperatureForecast(coords.lat, coords.lon, parsed.date, {
        ghcnStation: coords.ghcnStation || null,
      });
    } catch (err) {
      log(`Forecast error for ${groupKey}: ${err.message}`);
      continue;
    }

    const sigmaSource = forecast.historical
      ? `GHCN-Daily ${forecast.historical.station} (${forecast.historical.sampleSize}yr σ)`
      : forecast.ensemble
        ? 'GFS ensemble spread'
        : 'lead-time heuristic';
    log(`${groupKey}: mean=${forecast.meanF != null ? forecast.meanF.toFixed(1) + '°F' : 'N/A'} σ=${forecast.sigmaF.toFixed(1)}°F [${sigmaSource}] (${forecast.sources.join(', ')})`);

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

    // ── Stage 1: Haiku pre-screen ─────────────────────────────────────────
    const daysToResolution = (new Date(mp.date) - now) / 86_400_000;
    const marketPrice      = bestSide === 'yes' ? bestMarket.yesPrice : bestMarket.noPrice;
    const stage1Signal = {
      question:             bestMarket.question,
      direction:            mp.direction,
      bucketLabel:          thresholdLabel(mp),
      side:                 bestSide,
      edge:                 bestEdge,
      marketPrice,
      modelProb:            bestModelProb,
      meanF:                forecast.meanF,
      sigmaF:               forecast.sigmaF,
      ensembleSpread:       forecast.ensemble?.spread      ?? null,
      memberCount:          forecast.ensemble?.memberCount ?? null,
      membersOnSide:        forecast.ensemble
        ? Math.round((bestSide === 'yes'
            ? bestModelProb
            : 1 - bestModelProb) * (forecast.ensemble.memberCount || 0))
        : null,
      daysToResolution,
      historicalMean:       forecast.historical?.historicalMean ?? null,  // note: legacy field name
      thresholdPercentile:  forecast.historical?.thresholdPercentile ?? null,
      sources:              forecast.sources,
    };

    const stage1Result = await analyzeSignal(stage1Signal);
    log(`  Stage 1 (Haiku): decision=${stage1Result.decision} confidence=${stage1Result.confidence != null ? (stage1Result.confidence * 100).toFixed(0) + '%' : 'N/A'} size=${stage1Result.sizeMultiplier}× | ${stage1Result.reasoning || 'no reasoning'}`);

    // ── Stage 2: Sonnet deep analysis (fires on take or reduce only) ──────
    let aiAnalysis = stage1Result;

    if (stage1Result.decision !== 'skip' && process.env.WEATHER_DEEP_ANALYSIS === 'true') {
      const nwsObs = parsed.coords?.nwsStation
        ? await fetchNWSObserved(parsed.coords.nwsStation, mp.date, parsed.coords.tz || 'America/New_York').catch(() => null)
        : null;
      const wuObs = parsed.coords?.lat != null
        ? await fetchWUObservation(parsed.coords.lat, parsed.coords.lon).catch(() => null)
        : null;
      const cityProfile = getCityProfile(mp.city);

      aiAnalysis = await deepAnalyzeSignal(
        {
          ...stage1Signal,
          stageOneDecision:       stage1Result.decision,
          stageOneSizeMultiplier: stage1Result.sizeMultiplier,
        },
        {
          perModels:       forecast.models?.models  ?? {},
          nwsObs,
          wuObs,
          cityProfile,
          historicalSigma: forecast.historical?.sigma ?? null,
        },
        stage1Result,
      );

      const stageLabel = aiAnalysis.stage === 2 ? 'Sonnet' : 'Haiku (Stage 2 fallback)';
      log(`  Stage 2 (${stageLabel}): decision=${aiAnalysis.decision} confidence=${aiAnalysis.confidence != null ? (aiAnalysis.confidence * 100).toFixed(0) + '%' : 'N/A'} size=${aiAnalysis.sizeMultiplier}×`);
      if (aiAnalysis.summary) log(`    Summary: ${aiAnalysis.summary.slice(0, 120)}`);
    }

    // If AI says skip, log to backtest but don't post a signal card
    if (aiAnalysis.decision === 'skip') {
      log(`  AI suppressed signal for ${groupKey}`);
      if (BACKTEST_HOOK) {
        const skipLog = [
          `🚫 **SIGNAL SUPPRESSED BY AI** | ${bestSide.toUpperCase()} | Edge ${(bestEdge * 100).toFixed(1)}%`,
          `${bestMarket.question}`,
          `Reason: ${aiAnalysis.reasoning || 'AI quality filter'}`,
          aiAnalysis.flags.length ? `Flags: ${aiAnalysis.flags.join(' · ')}` : '',
          `Model P: ${pct(bestModelProb)} | Market: ${pct(bestMarket.yesPrice)} YES`,
        ].filter(Boolean).join('\n');
        await postWebhook(BACKTEST_HOOK, 'info', skipLog, `Weather • AI Skip • ${mp.date}`);
      }
      signalsFired++;
      continue;
    }

    // Apply size multiplier from AI assessment
    const baseKelly      = kellySizing(bestModelProb, bestMarket.yesPrice, bestSide, BANKROLL, KELLY_FRAC, MAX_BET);
    const adjustedDollars = Math.round(baseKelly.dollars * aiAnalysis.sizeMultiplier * 100) / 100;
    const kelly           = { ...baseKelly, dollars: adjustedDollars };

    // Skip if Kelly is $0 after live price refresh — means the market moved against us
    // between edge calculation and the CLOB price fetch (common in illiquid bucket markets).
    if (kelly.dollars === 0) {
      log(`${groupKey}: Kelly=$0 after price refresh (modelProb=${(bestModelProb*100).toFixed(1)}% vs yesPrice=${(bestMarket.yesPrice*100).toFixed(0)}¢) — skipping`);
      continue;
    }

    const id    = signalId();
    const card  = buildSignalCard(bestMarket, forecast, kelly, bestSide, bestEdge, bestModelProb, id, aiAnalysis);
    const footer = `Weather • ${mp.city} • ${mp.date} • ${new Date().toISOString().slice(0, 16)} UTC`;

    let msgId = null;
    if (SIGNALS_HOOK) {
      msgId = await postWebhook(SIGNALS_HOOK, bestSide === 'yes' ? 'long' : 'short', card, footer);
    }

    if (BACKTEST_HOOK) {
      const shortLog = [
        `📋 **SIGNAL LOGGED** | ${bestSide.toUpperCase()} | Edge ${(bestEdge * 100).toFixed(1)}%${aiAnalysis.decision === 'reduce' ? ` | ⚠️ AI REDUCED to ${aiAnalysis.sizeMultiplier}×` : ''}`,
        `${bestMarket.question}`,
        `Model P: ${pct(bestModelProb)} | Market: ${pct(bestMarket.yesPrice)} YES`,
        `Suggested: ${usd(kelly.dollars)} on ${bestSide.toUpperCase()}`,
        aiAnalysis.reasoning ? `AI: ${aiAnalysis.reasoning}` : '',
        `\`ID: ${id}\``,
      ].filter(Boolean).join('\n');
      await postWebhook(BACKTEST_HOOK, 'info', shortLog, `Weather • ${mp.date}`);
    }

    // Save trade record
    const existingTrade = trades.find(t => t.conditionId === conditionId && t.outcome === null);
    const tradeRecord = {
      id,
      conditionId,
      question:        bestMarket.question,
      parsed:          mp,
      eventSlug:       bestMarket.eventSlug || null,
      side:            bestSide,
      edge:            Math.round(bestEdge * 1000) / 10,
      yesPrice:        bestMarket.yesPrice,
      noPrice:         bestMarket.noPrice,
      modelProb:       Math.round(bestModelProb * 1000) / 10,
      meanF:           forecast.meanF != null ? Math.round(forecast.meanF * 10) / 10 : null,
      sigmaF:          Math.round(forecast.sigmaF * 10) / 10,
      betDollars:      kelly.dollars,
      aiDecision:       aiAnalysis.decision,
      aiConfidence:     aiAnalysis.confidence,
      aiSizeMultiplier: aiAnalysis.sizeMultiplier,
      aiReasoning:      aiAnalysis.reasoning,
      aiFlags:          aiAnalysis.flags,
      aiStage:          aiAnalysis.stage         ?? 1,
      aiSummary:        aiAnalysis.summary        ?? null,
      aiSteps:          aiAnalysis.steps          ?? null,
      aiDeepSkipped:    aiAnalysis.deepSkipped    ?? true,
      firedAt:         new Date().toISOString(),
      discordMsgId:    msgId,
      sources:         forecast.sources,
      outcome:         null,
      observedTemp:    null,
      signalResult:    null,
      pnlDollars:      null,
      closedAt:        null,
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
