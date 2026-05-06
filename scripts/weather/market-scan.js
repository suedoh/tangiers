#!/usr/bin/env node
'use strict';

/**
 * weather/market-scan.js — Polymarket Weather Signal Poller
 *
 * Runs every 30 minutes via Windows Task Scheduler (Weathermen-Scan task).
 * For each active temperature market on Polymarket it:
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
 * Task Scheduler: see scripts/weather/schedule-windows.ps1
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const { loadEnv, ROOT, resolveWebhook } = require('../lib/env');
const { postWebhook }                   = require('../lib/discord');
const { getObserved, fetchGHCNObserved, fetchNWSObserved, getTemperatureForecast, normalCDF, thresholdProbability, leadTimeSigma } = require('../lib/forecasts');
const { analyzeSignal, deepAnalyzeSignal, fetchWUObservation, fetchWUDailyHistory } = require('../lib/weather-analysis');
const { getCityProfile } = require('../lib/city-profiles');
const { autoExit }      = require('./exit-monitor');
const {
  fetchWeatherMarkets,
  getMarketPrice,
  getNoTokenId,
  simulateSlippage,
  kellySizing,
  marketUrl,
} = require('../lib/polymarket');
const { computeLivePnl } = require('../lib/polymarket-orders');

loadEnv();

// Per-city model mean bias corrections (observedTemp - modelMeanF, derived from resolved trades).
// Applied as correctedMeanF = meanF + bias to calibrate probability calculations.
let BIAS_CORRECTIONS = {};
try {
  BIAS_CORRECTIONS = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../lib/bias-corrections.json'), 'utf8')
  );
} catch { /* absent or malformed — proceed with zero corrections */ }

if (process.env.PRIMARY === 'false') {
  console.log('[weather-scan] PRIMARY=false — skipping');
  process.exit(0);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const SIGNALS_HOOK  = resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK');
const BACKTEST_HOOK = resolveWebhook('WEATHER_DISCORD_BACKTEST_WEBHOOK');
const MIN_EDGE      = parseFloat(process.env.WEATHER_MIN_EDGE    || '0.08');  // 8%
const MIN_VOLUME    = parseFloat(process.env.WEATHER_MIN_VOLUME  || '200');   // $200 min volume
const BANKROLL      = parseFloat(process.env.WEATHER_BANKROLL   || '500');   // paper bankroll
const KELLY_FRAC    = parseFloat(process.env.WEATHER_KELLY_FRAC || '0.15');
const MAX_BET       = parseFloat(process.env.WEATHER_MAX_BET    || '100');
const MAX_SIDE_PRICE = parseFloat(process.env.WEATHER_MAX_SIDE_PRICE || '0.80');

// ─── Live execution config ─────────────────────────────────────────────────────
// DISABLED: live execution off pending further testing — re-enable by removing this override
const LIVE_EXECUTE   = false; // was: process.env.POLYMARKET_EXECUTE_ORDERS === 'true'
// DISABLED: AI analysis off to conserve credits until live trading resumes — re-enable by removing this override
const AI_ENABLED     = false; // was: true
const LIVE_BANKROLL  = parseFloat(process.env.POLYMARKET_LIVE_BANKROLL  || '100');
const LIVE_MAX_BET   = parseFloat(process.env.POLYMARKET_MAX_LIVE_BET   || '20');
const LIVE_TTL_MS    = (+process.env.POLYMARKET_ORDER_TTL_S || 1800) * 1000;
const LIVE_MIN_BALANCE  = parseFloat(process.env.POLYMARKET_MIN_BALANCE   || '20');
const LIVE_MIN_PROFIT        = parseFloat(process.env.POLYMARKET_MIN_WIN_PROFIT    || '2.00');
const LIVE_MIN_EDGE          = parseFloat(process.env.POLYMARKET_LIVE_MIN_EDGE       || '0.12'); // 12% — stricter than paper's 8%
const LIVE_MAX_POSITIONS     = parseInt(  process.env.POLYMARKET_LIVE_MAX_POSITIONS  || '10', 10); // max concurrent live slots
const LIVE_MIN_AI_CONFIDENCE = parseFloat(process.env.POLYMARKET_LIVE_MIN_CONFIDENCE || '0.70'); // min AI confidence for live order
const LIVE_MIN_PAYOUT_RATIO  = parseFloat(process.env.LIVE_MIN_PAYOUT_RATIO         || '0.33'); // win ≥33¢/$1 risked → NO price ≤75¢
const COOLDOWN_MS   = 4 * 60 * 60 * 1000; // 4 hours between signals on same market

// Cities excluded from signal generation.
// Reasons are documented — do not remove entries without verifying the underlying issue is resolved.
const BLOCKED_CITIES = new Set([
  'istanbul',     // Settlement station ambiguity: LTBA (163 ft) vs LTFM (2,057 ft) — ~1,900 ft elevation difference; unknown which Polymarket uses
  'singapore',    // Equatorial ~7°F mean daily range — threshold trades are structurally near-coinflips
  'kuala lumpur', // Same equatorial tight-spread issue as Singapore + largest city-to-airport offset in the set (45 miles)
  'nairobi',      // 5,327 ft altitude compresses range; extreme thresholds structurally high-risk; lowest model skill in tropical East Africa
  'lagos',        // Lowest model skill in the entire city set; wet-season cloud suppression makes temperature outcomes structurally unpredictable
  'wellington',   // Cook Strait persistent wind structurally suppresses temperature extremes — threshold trades near-coinflips, similar to Singapore
  'lucknow',      // 13% WR (8 trades) — poor GHCN-Daily coverage; mean-shift correction insufficient for structural data quality issues
  'london',       // 14% WR (7 trades) — settlement station ambiguity (Heathrow vs city); bias correction alone cannot fix station mismatch
  'cape town',    // 31.3% WR (16 trades) — persistent model underperformance; no clear structural fix identified
  'jeddah',       // 33.3% WR (12 trades) — desert heat extremes structurally mis-modeled; positive P&L is noise at this sample size
  'paris',        // 50.0% WR (26 trades) — zero predictive edge; settlement station (Orly/CDG) micro-climate diverges from GFS grid
]);

// Cities allowed to paper-trade but never execute live orders against the Polymarket account.
const PAPER_ONLY_CITIES = new Set([
  'madrid',       // 57.7% WR (26 trades) — recovering but still below live threshold; continue collecting data
  'chengdu',      // 52.0% WR (25 trades) — Sichuan Basin cloud/inversion dynamics degrade GFS skill; collecting more data
  'milan',        // 53.8% WR (26 trades) — Po Valley cold-air pooling poorly modeled; below live threshold
  'warsaw',       // 56.7% WR (30 trades) — below live threshold; collecting more data
  'munich',       // 59.3% WR (27 trades) — below live threshold; Alpine foehn effects may degrade GFS skill
  'sao paulo',    // 58.6% WR (29 trades) — below live threshold; Southern Hemisphere season inversion may confuse GFS
  'dallas',       // 58.3% WR (7W/5L) — below live threshold; collecting more data
]);

// Cities confirmed to settle via Weather Underground history page.
// WU shadow resolution only runs for cities in this list — avoids wasted
// API calls and noise in !performance for cities that use other oracles.
// To add a city: check a resolved trade from that city — if `wuStation` is
// non-null, WU is confirmed. Add the lowercase `parsed.city` value here.
const WU_VERIFIED_CITIES = new Set([
  // ── North America (WU confirmed from Gamma API event descriptions) ──
  'new york',       // KLGA confirmed via live event description fetch
  'los angeles',    // KLAX — US pattern confirmed
  'chicago',        // KORD — US pattern confirmed
  'miami',          // KMIA — US pattern confirmed
  'phoenix',        // KPHX — US pattern confirmed
  'seattle',        // KSEA — US pattern confirmed
  'boston',         // KBOS — US pattern confirmed
  'atlanta',        // KATL — US pattern confirmed
  'houston',        // KHOU — US pattern confirmed
  'dallas',         // KDFW — US pattern confirmed
  'denver',         // KDEN — US pattern confirmed
  'san francisco',  // KSFO — US pattern confirmed
  'austin',         // KAUS — US pattern confirmed
  'nashville',      // KBNA — US pattern confirmed
  'charlotte',      // KCLT — US pattern confirmed
  'tampa',          // KTPA — US pattern confirmed
  'washington dc',  // KDCA confirmed via live event description fetch
  // 'toronto'      — not yet added; confirm via first trade with non-null wuStation
  // ── Europe (conservative — add after trade record confirms wuStation) ──
  'london',         // EGLC confirmed via live event description fetch
  // paris, madrid, etc. — NOT added yet; confirm from trade data first
]);

const STATE_FILE         = path.join(ROOT, '.weather-state.json');
const TRADES_FILE        = path.join(ROOT, 'weather-trades.json');
const STATION_CACHE_FILE = path.join(__dirname, '.station-cache.json');
const CALIBRATION_FILE   = path.join(ROOT, 'scripts/lib/city-calibration.json');

// Rolling Brier score calibration window (days)
const CALIBRATION_WINDOW_DAYS = 30;

function log(msg) { console.log(`[${new Date().toISOString()}] [weather-scan] ${msg}`); }
function readState()    { try { return JSON.parse(fs.readFileSync(STATE_FILE,  'utf8')); } catch (e) { console.error('[weather-scan] readState error:', e.message);  return { cooldowns: {}, signals: {} }; } }
function writeState(s)  { try { fs.writeFileSync(STATE_FILE,  JSON.stringify(s, null, 2)); } catch (e) { console.error('[weather-scan] writeState error:', e.message);  } }
function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch (e) { console.error('[weather-scan] readTrades error:', e.message);   return []; } }
function writeTrades(t) { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); } catch (e) { console.error('[weather-scan] writeTrades error:', e.message); } }

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
function buildSignalCard(market, forecast, kelly, side, edge, modelProb, id, aiAnalysis = null, isLive = false) {
  const { parsed }   = market;
  const marketUnit   = parsed.coords?.unit || 'F'; // 'F' for US, 'C' for international
  const cityLabel    = parsed.city.replace(/\b\w/g, c => c.toUpperCase());
  const typeLabel    = parsed.type === 'low' ? 'LOW' : 'HIGH';
  const bucketLabel  = thresholdLabel(parsed, marketUnit);
  const icon         = side === 'yes' ? '🟢' : '🔴';
  const sideLabel    = side === 'yes' ? 'BUY YES' : 'BUY NO';

  const meanStr  = forecast.meanF != null
    ? (forecast.biasCorrF && forecast.rawMeanF != null
        ? `${dualTemp(forecast.rawMeanF, marketUnit)} → **${dualTemp(forecast.meanF, marketUnit)}** corrected (bias ${forecast.biasCorrF >= 0 ? '+' : ''}${forecast.biasCorrF.toFixed(2)}°F)`
        : dualTemp(forecast.meanF, marketUnit))
    : 'N/A';
  const sigmaStr = dualSigma(forecast.sigmaF, marketUnit);

  const sidePrice   = side === 'yes' ? market.yesPrice : market.noPrice;
  const payoutRatio = ((1 - sidePrice) / sidePrice).toFixed(2);
  const rrIcon      = parseFloat(payoutRatio) >= 1.5 ? '✅' : parseFloat(payoutRatio) >= 1.0 ? '⚠️' : parseFloat(payoutRatio) >= 0.50 ? '🟠' : '🔴';
  const rrLabel     = parseFloat(payoutRatio) >= 1.5 ? ''
    : parseFloat(payoutRatio) >= 1.0 ? ' — marginal payout'
    : parseFloat(payoutRatio) >= 0.50 ? ' — risk exceeds reward'
    : ' — HIGH RISK';
  const payoutLine  = `${rrIcon} Payout odds:  win ${pct(1 - sidePrice)} per $1 risked → **${payoutRatio}x**${rrLabel}`;

  const liquidityWarn = market.liquidity < 100
    ? `🚨 **THIN MARKET — AVOID MANUAL EXECUTION** — only ${usd(market.liquidity)} depth, any order will move the price`
    : market.liquidity < 400
    ? `⚠️ **LOW LIQUIDITY** — ${usd(market.liquidity)} depth, expect wide spread on manual trades`
    : null;

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
    const modelTemps = Object.values(forecast.models.models).map(mv => mv.forecast).filter(v => v != null);
    const spread = modelTemps.length >= 2 ? Math.max(...modelTemps) - Math.min(...modelTemps) : null;
    const spreadIcon = spread == null ? '' : spread > 8 ? ' ⚠️ HIGH' : spread > 5 ? ' ⚡ MOD' : '';
    if (spread != null) lines.push(`Model spread:    ${spread.toFixed(1)}°F${spreadIcon}`);
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
    `Per share:     **$${market.noPrice.toFixed(2)}/NO** · $${market.yesPrice.toFixed(2)}/YES`,
    `Model P(YES):  **${pct(modelProb)}** that temp is ${bucketLabel}`,
    `**Edge: ${edge > 0 ? '+' : ''}${(edge * 100).toFixed(1)}% → ${icon} ${sideLabel}**`,
    payoutLine,
    '',
    '**📐 KELLY SIZING**',
    `Kelly: ${kelly.kelly}% → Fractional (${Math.round(KELLY_FRAC * 100)}%): **${usd(kelly.dollars)}** (bankroll ${usd(BANKROLL)})`,
    ...(isLive ? [
      `Cap: ${usd(LIVE_MAX_BET)} max per trade (live)`,
      `Shares to buy: **${Math.floor(LIVE_MAX_BET / sidePrice)} ${side.toUpperCase()} shares** at $${sidePrice.toFixed(2)}/share`,
    ] : []),
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
    ...(liquidityWarn ? [liquidityWarn] : []),
    `🔗 [View market](${marketUrl(market)})`,
    `📌 *Paper trade only — execute manually at polymarket.com*`,
    `Sources: ${forecast.sources.join(' · ')}`,
    `\`\`\`ID: ${id}\`\`\``,
  );

  return lines.join('\n');
}

// ─── Per-city Brier score calibration ────────────────────────────────────────

function loadCityCalibration() {
  try { return JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8')); } catch { return {}; }
}

function saveCityCalibration(calib) {
  try { fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(calib, null, 2)); } catch (e) {
    log(`[calibration] write error: ${e.message}`);
  }
}

/**
 * Record a resolved trade for Brier score calibration.
 * Prunes entries older than CALIBRATION_WINDOW_DAYS automatically.
 *
 * @param {string} city         Lowercase city name
 * @param {number} forecastProb Model probability for the signal's side (0–1)
 * @param {boolean} won         Whether the signal resolved in our favour
 */
function updateCityCalibration(city, forecastProb, won) {
  if (!city || forecastProb == null) return;
  const calib   = loadCityCalibration();
  const cityKey = city.toLowerCase();

  if (!calib[cityKey]) calib[cityKey] = { recentTrades: [] };

  const cutoff = Date.now() - CALIBRATION_WINDOW_DAYS * 86_400_000;
  calib[cityKey].recentTrades = (calib[cityKey].recentTrades || []).filter(t => t.ts >= cutoff);

  calib[cityKey].recentTrades.push({
    ts:           Date.now(),
    forecastProb: Math.round(forecastProb * 1000) / 1000,
    outcome:      won ? 1 : 0,
    brierContrib: Math.round((forecastProb - (won ? 1 : 0)) ** 2 * 10000) / 10000,
  });

  // Recompute rolling Brier score (lower = better calibrated)
  const trades = calib[cityKey].recentTrades;
  const bs = trades.reduce((a, t) => a + t.brierContrib, 0) / trades.length;
  calib[cityKey].brierScore   = Math.round(bs * 10000) / 10000;
  calib[cityKey].winRate      = Math.round(trades.filter(t => t.outcome === 1).length / trades.length * 1000) / 10;
  calib[cityKey].n            = trades.length;
  calib[cityKey].updatedAt    = new Date().toISOString();

  saveCityCalibration(calib);
}

/**
 * Returns a Kelly multiplier for a city based on its rolling Brier score.
 * Requires ≥10 trades in the window to activate; otherwise returns 1.0.
 *
 * BS < 0.15 (well-calibrated)  → 1.1×
 * BS 0.15–0.25 (normal)        → 1.0×
 * BS 0.25–0.35 (degraded)      → 0.75×
 * BS > 0.35  (poor)            → 0.5×
 */
function getCityKellyMultiplier(city) {
  if (!city) return 1.0;
  const calib   = loadCityCalibration();
  const cityKey = city.toLowerCase();
  const entry   = calib[cityKey];
  if (!entry || (entry.n || 0) < 10) return 1.0;  // insufficient data
  const bs = entry.brierScore;
  if (bs < 0.15) return 1.1;
  if (bs < 0.25) return 1.0;
  if (bs < 0.35) return 0.75;
  return 0.5;
}

// ─── Resolution-source watchdog ──────────────────────────────────────────────

/**
 * Compares station IDs in fetched market coords against a cached snapshot.
 * Alerts to Discord if any city's resolution station has changed — catches
 * silent station switches like the Paris CDG→Le Bourget incident.
 */
async function checkStationChanges(markets) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(STATION_CACHE_FILE, 'utf8')); } catch { /* first run */ }

  const seen   = new Set();
  let   dirty  = false;
  const alerts = [];

  for (const market of markets) {
    const city   = market.parsed?.city?.toLowerCase();
    const coords = market.parsed?.coords || {};
    if (!city || seen.has(city)) continue;
    seen.add(city);

    const current = {
      ghcnStation: coords.ghcnStation ?? null,
      nwsStation:  coords.nwsStation  ?? null,
    };
    const cached = cache[city];

    if (cached &&
        (cached.ghcnStation !== current.ghcnStation ||
         cached.nwsStation  !== current.nwsStation)) {
      const msg = `⚠️ **STATION CHANGE DETECTED: ${city}**\n` +
        `Old GHCN: \`${cached.ghcnStation}\` → New: \`${current.ghcnStation}\`\n` +
        `Old NWS:  \`${cached.nwsStation}\` → New: \`${current.nwsStation}\`\n` +
        `Verify resolution source in Polymarket market rules before trading this city.`;
      log(`[station-watchdog] CHANGE for ${city}: GHCN ${cached.ghcnStation}→${current.ghcnStation}, NWS ${cached.nwsStation}→${current.nwsStation}`);
      alerts.push(msg);
    }

    cache[city] = current;
    dirty = true;
  }

  if (dirty) {
    try { fs.writeFileSync(STATION_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch (e) {
      log(`[station-watchdog] cache write error: ${e.message}`);
    }
  }

  for (const msg of alerts) {
    if (BACKTEST_HOOK) await postWebhook(BACKTEST_HOOK, 'error', msg, 'Weather • Station Watchdog').catch(() => null);
  }
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

    const targetMs      = new Date(trade.parsed.date).getTime();
    const nwsEligible   = now >= targetMs + 12 * 3_600_000;  // 12h: NWS METAR near real-time
    const era5Eligible  = now >= targetMs + 24 * 3_600_000;  // 24h: ERA5 archive available
    const ghcnEligible  = now >= targetMs + 36 * 3_600_000;  // 36h: GHCN posting latency

    if (!nwsEligible) continue;

    try {
      const coords   = trade.parsed.coords || {};
      const wantHigh = trade.parsed.direction !== 'below';

      // Path A: observed temperature — each source gated by its own availability window.
      // GHCN (Polymarket's source, 36h) → NWS METAR (near real-time, 12h) → ERA5 (24h).
      let value = null, observedSource = null;

      if (ghcnEligible && coords.ghcnStation) {
        const ghcn = await fetchGHCNObserved(coords.ghcnStation, trade.parsed.date).catch(() => null);
        if (ghcn) {
          const v = wantHigh ? ghcn.tmax : ghcn.tmin;
          if (v != null) { value = v; observedSource = ghcn.source; }
        }
      }
      if (value == null && nwsEligible && coords.nwsStation) {
        const nws = await fetchNWSObserved(coords.nwsStation, trade.parsed.date, coords.tz).catch(() => null);
        if (nws) {
          const v = wantHigh ? nws.high : nws.low;
          if (v != null) { value = v; observedSource = nws.source; }
        }
      }
      if (value == null && era5Eligible && coords.lat != null) {
        const era5 = await getObserved(coords.lat, coords.lon, trade.parsed.date, wantHigh ? 'above' : 'below').catch(() => null);
        if (era5?.value != null) { value = era5.value; observedSource = 'Open-Meteo ERA5'; }
      }

      // Oracle anomaly check: cross-reference resolution value against neighboring stations.
      // A single-station spike that disagrees with neighbors by >3°F is flagged — catches
      // CDG-style data tampering or sensor faults before they silently resolve a trade.
      if (value != null && nwsEligible) {
        const cityProfile   = getCityProfile(trade.parsed.city);
        const neighborSt    = cityProfile?.neighborStations || [];
        if (neighborSt.length > 0) {
          const neighborResults = await Promise.all(
            neighborSt.map(s => fetchNWSObserved(s, trade.parsed.date, coords.tz || 'America/New_York').catch(() => null))
          );
          const neighborValues = neighborResults
            .map(n => n ? (wantHigh ? n.high : n.low) : null)
            .filter(v => v != null);

          if (neighborValues.length > 0) {
            const sorted  = [...neighborValues].sort((a, b) => a - b);
            const median  = sorted[Math.floor(sorted.length / 2)];
            const gap     = Math.abs(value - median);
            if (gap > 3.0) {
              trade.suspiciousResolution = true;
              log(`[resolve] ${trade.id}: ORACLE ANOMALY — station ${value.toFixed(1)}°F vs neighbor median ${median.toFixed(1)}°F (gap ${gap.toFixed(1)}°F) — flagged for review`);
              if (BACKTEST_HOOK) {
                await postWebhook(BACKTEST_HOOK, 'error',
                  `⚠️ **ORACLE ANOMALY DETECTED** | \`${trade.id}\`\n` +
                  `${trade.question}\n` +
                  `Resolution station: **${value.toFixed(1)}°F** (${observedSource})\n` +
                  `Neighbor median: **${median.toFixed(1)}°F** (${neighborSt.join(', ')})\n` +
                  `Gap: **${gap.toFixed(1)}°F** — manual review recommended.`,
                  'Weather • Oracle Risk'
                ).catch(() => null);
              }
            }
          }
        }
      }

      // Path B: Polymarket settlement price — fallback when observation data unavailable.
      // Resolves as soon as the oracle posts (typically 12–24h after the event).
      if (value == null) {
        if (trade.conditionId) {
          const lp = await getMarketPrice(trade.conditionId).catch(() => null);
          if (lp && (lp.yes > 0.99 || lp.yes < 0.01)) {
            const hit       = lp.yes > 0.99;
            const signalWon = (trade.side === 'yes' && hit) || (trade.side === 'no' && !hit);

            trade.outcome        = hit ? 'yes-resolved' : 'no-resolved';
            trade.observedTemp   = null;
            trade.observedSource = 'polymarket-settlement';
            trade.signalResult   = signalWon ? 'win' : 'loss';
            trade.closedAt       = new Date().toISOString();

            if (trade.betDollars > 0) {
              const price = trade.side === 'yes' ? trade.yesPrice : trade.noPrice;
              trade.pnlDollars = signalWon
                ? Math.round(trade.betDollars * (1 - price) / price * 100) / 100
                : -trade.betDollars;
            }

            computeLivePnl(trade, signalWon);
            updateCityCalibration(trade.parsed?.city, (trade.modelProb || 50) / 100, signalWon);

            changed = true;
            log(`[resolve] ${trade.id}: Polymarket-settled ${hit ? 'YES' : 'NO'} — ${signalWon ? 'WIN' : 'LOSS'}`);

            if (BACKTEST_HOOK) {
              const icon = signalWon ? '✅' : '❌';
              const body = [
                `${icon} **WEATHER SIGNAL RESOLVED — ${signalWon ? 'WIN' : 'LOSS'}**`,
                `${trade.question}`,
                `Signal: ${trade.side.toUpperCase()} at ${pct(trade.side === 'yes' ? trade.yesPrice : trade.noPrice)}`,
                `Settled: Polymarket oracle → **${hit ? 'YES' : 'NO'}**`,
                trade.betDollars > 0
                  ? `P&L: **${trade.pnlDollars >= 0 ? '+' : ''}${usd(trade.pnlDollars)}** (bet ${usd(trade.betDollars)})`
                  : '',
                trade.liveOrder?.livePnlDollars != null
                  ? `Live P&L: **${trade.liveOrder.livePnlDollars >= 0 ? '+' : ''}${usd(trade.liveOrder.livePnlDollars)}** (${trade.liveOrder.filledShares?.toFixed(2)} shares @ ${pct(trade.liveOrder.limitPrice)})`
                  : '',
                `\`ID: ${trade.id}\``,
              ].filter(Boolean).join('\n');
              await postWebhook(BACKTEST_HOOK, signalWon ? 'long' : 'error', body, 'Weather • Outcome');
            }
            continue;
          } else if (lp) {
            log(`[resolve] ${trade.id}: market not settled yet (YES=${lp.yes.toFixed(3)}) — waiting`);
          } else {
            log(`[resolve] ${trade.id}: Polymarket price fetch failed — will retry next cycle`);
          }
        }

        const hoursAgo = ((now - targetMs) / 3_600_000).toFixed(1);
        log(`[resolve] ${trade.id}: no data yet (${hoursAgo}h past date) — GHCN/NWS/ERA5 unavailable`);
        continue;
      }

      // Resolve via observed temperature (Path A)
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

      computeLivePnl(trade, signalWon);
      updateCityCalibration(trade.parsed?.city, (trade.modelProb || 50) / 100, signalWon);

      // ── WU Shadow Resolution (parallel tracking, never changes signalResult) ──
      // Fetch the same WU station Polymarket uses for settlement and record what
      // outcome *would* have been under WU data. Used only for comparison in
      // !performance — zero impact on win/loss records or P&L.
      if (trade.wuStation && ghcnEligible && WU_VERIFIED_CITIES.has(trade.parsed?.city?.toLowerCase())) {
        try {
          const wuHistory = await fetchWUDailyHistory(trade.wuStation, trade.parsed.date).catch(() => null);
          if (wuHistory) {
            const wuTemp = wantHigh ? wuHistory.high : wuHistory.low;
            if (wuTemp != null) {
              let wuHit;
              if (trade.parsed.direction === 'above')      wuHit = wuTemp >= trade.parsed.thresholdF;
              else if (trade.parsed.direction === 'below') wuHit = wuTemp <= trade.parsed.thresholdF;
              else if (trade.parsed.direction === 'range') wuHit = wuTemp >= trade.parsed.thresholdF && wuTemp <= trade.parsed.thresholdHighF;
              else                                         wuHit = wuTemp > trade.parsed.thresholdF;
              const wuSignalWon = (trade.side === 'yes' && wuHit) || (trade.side === 'no' && !wuHit);
              trade.wuShadow = {
                station:          trade.wuStation,
                tempF:            Math.round(wuTemp * 10) / 10,
                outcome:          wuHit ? 'yes-resolved' : 'no-resolved',
                signalResult:     wuSignalWon ? 'win' : 'loss',
                agreesWithPrimary: wuSignalWon === signalWon,
              };
              if (!trade.wuShadow.agreesWithPrimary) {
                log(`[wu-shadow] ${trade.id}: DIVERGES — primary ${signalWon ? 'WIN' : 'LOSS'} (${value.toFixed(1)}°F via ${observedSource}) vs WU ${wuSignalWon ? 'WIN' : 'LOSS'} (${wuTemp.toFixed(1)}°F via ${trade.wuStation})`);
                if (BACKTEST_HOOK) {
                  await postWebhook(BACKTEST_HOOK, 'error',
                    `⚠️ **WU SHADOW DIVERGENCE** | \`${trade.id}\`\n` +
                    `${trade.question}\n` +
                    `Primary: **${value.toFixed(1)}°F** (${observedSource}) → ${signalWon ? '✅ WIN' : '❌ LOSS'}\n` +
                    `WU (${trade.wuStation}): **${wuTemp.toFixed(1)}°F** → ${wuSignalWon ? '✅ WIN' : '❌ LOSS'}\n` +
                    `Gap: ${Math.abs(value - wuTemp).toFixed(1)}°F — settlement may differ from our resolution.`,
                    'Weather • WU Shadow'
                  ).catch(() => null);
                }
              } else {
                log(`[wu-shadow] ${trade.id}: agrees — WU ${wuTemp.toFixed(1)}°F (${trade.wuStation}) = ${wuSignalWon ? 'WIN' : 'LOSS'}`);
              }
            }
          }
        } catch (wuErr) {
          log(`[wu-shadow] ${trade.id}: WU fetch error — ${wuErr.message}`);
        }
      }

      changed = true;
      const bucketLbl = thresholdLabel(trade.parsed);
      log(`[resolve] ${trade.id}: ${trade.parsed.city} ${trade.parsed.date} ${bucketLbl} — observed ${value.toFixed(1)}°F → ${signalWon ? 'WIN' : 'LOSS'}`);

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
          trade.liveOrder?.livePnlDollars != null
            ? `Live P&L: **${trade.liveOrder.livePnlDollars >= 0 ? '+' : ''}${usd(trade.liveOrder.livePnlDollars)}** (${trade.liveOrder.filledShares?.toFixed(2)} shares @ ${pct(trade.liveOrder.limitPrice)})`
            : '',
          `\`ID: ${trade.id}\``,
        ].filter(Boolean).join('\n');

        await postWebhook(BACKTEST_HOOK, signalWon ? 'long' : 'error', body, 'Weather • Outcome');
      }
    } catch (err) {
      log(`[resolve] Error on ${trade.id}: ${err.message}`);
    }
  }

  return changed;
}

// ─── Scan lock (prevents concurrent instances from Task Scheduler overlap) ────

const SCAN_LOCK_FILE  = path.join(ROOT, '.market-scan.lock');
const SCAN_LOCK_TTL_MS = 35 * 60 * 1000; // 35 min — longer than the 30-min schedule

function acquireScanLock() {
  try {
    if (fs.existsSync(SCAN_LOCK_FILE)) {
      const ts = parseInt(fs.readFileSync(SCAN_LOCK_FILE, 'utf8'), 10);
      if (Date.now() - ts < SCAN_LOCK_TTL_MS) {
        log('Lock held by another instance — exiting');
        return false;
      }
      log('Stale lock found — overwriting');
    }
    fs.writeFileSync(SCAN_LOCK_FILE, String(Date.now()));
    return true;
  } catch (e) {
    log(`Lock acquire failed: ${e.message} — proceeding without lock`);
    return true;
  }
}

function releaseScanLock() {
  try { fs.unlinkSync(SCAN_LOCK_FILE); } catch { /* ignore */ }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function main() {
  log('Starting market scan...');

  if (!SIGNALS_HOOK) {
    log('WEATHER_DISCORD_SIGNALS_WEBHOOK not set — signals will only be logged, not posted to Discord');
  }

  const state  = readState();
  const trades = readTrades();

  // ── Circuit breaker: halt if daily paper losses exceed configured limit ───
  // Resets at UTC midnight. Checked before any new signals are fired.
  const todayISO = new Date().toISOString().slice(0, 10);
  const todayPnl = trades
    .filter(t => t.closedAt?.startsWith(todayISO) && !t.shadow && t.pnlDollars != null)
    .reduce((sum, t) => sum + t.pnlDollars, 0);
  const CIRCUIT_BREAKER_LIMIT = -(BANKROLL * parseFloat(process.env.WEATHER_CIRCUIT_BREAKER_PCT || '0.10'));
  if (todayPnl < CIRCUIT_BREAKER_LIMIT) {
    log(`CIRCUIT BREAKER: daily P&L $${todayPnl.toFixed(2)} below limit $${CIRCUIT_BREAKER_LIMIT.toFixed(2)} — halting scan for today`);
    if (BACKTEST_HOOK) {
      await postWebhook(BACKTEST_HOOK, 'error',
        `🚨 **CIRCUIT BREAKER TRIGGERED**\nDaily paper P&L: **$${todayPnl.toFixed(2)}** (limit: $${CIRCUIT_BREAKER_LIMIT.toFixed(2)})\nNo new signals will fire until UTC midnight.\nSet \`WEATHER_CIRCUIT_BREAKER_PCT\` to adjust (default 10%).`,
        'Weather • Risk Control');
    }
    process.exit(0);
  }
  if (todayPnl !== 0) log(`Daily P&L check: $${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(2)} (circuit breaker at $${CIRCUIT_BREAKER_LIMIT.toFixed(2)})`);

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

  // Resolution-source watchdog: alert if any city's settlement station has changed
  await checkStationChanges(markets).catch(err => log(`[station-watchdog] error: ${err.message}`));

  // Filter by minimum volume
  const candidates = markets.filter(m => m.volume >= MIN_VOLUME);
  log(`${candidates.length} markets meet volume threshold ($${MIN_VOLUME})`);

  // ── Step 3: group markets by event (city + date) ──────────────────────────
  const now = Date.now();
  const eventGroups = new Map(); // key: 'city|date' → array of markets

  for (const market of candidates) {
    const { parsed } = market;

    // Skip markets resolving too soon or beyond reliable ensemble window.
    // <2h: observation noise dominates, forecast no longer informative.
    // >7d: beyond the reliable temperature ensemble horizon.
    const daysToResolution = (new Date(parsed.date) - now) / 86_400_000;
    if (daysToResolution < 0.083) continue;  // 2h minimum
    if (daysToResolution > 7)     continue;  // 7-day reliable horizon

    const groupKey = `${parsed.city}|${parsed.date}`;
    if (!eventGroups.has(groupKey)) eventGroups.set(groupKey, []);
    eventGroups.get(groupKey).push(market);
  }

  log(`${eventGroups.size} event groups to evaluate`);

  // Pre-compute available capital once per scan cycle.
  // AI analysis is skipped when capital is fully deployed — no point spending tokens
  // on signals we can't enter. Paper signals still fire; aiDecision stored as null
  // so calibration stats exclude these trades.
  const activeLiveOrders  = LIVE_EXECUTE
    ? trades.filter(t => ['open', 'filled', 'partial_expired'].includes(t.liveOrder?.status))
    : [];
  const deployedNow       = activeLiveOrders.reduce((sum, t) => sum + (t.liveOrder.sizeDollars || 0), 0);
  const livePositionCount = activeLiveOrders.length;
  const capitalAvailable = !LIVE_EXECUTE || Math.round((LIVE_BANKROLL - deployedNow) * 100) / 100 > LIVE_MIN_BALANCE;
  if (!capitalAvailable) log(`AI analysis disabled this cycle — capital fully deployed ($${deployedNow.toFixed(2)} of $${LIVE_BANKROLL}, reserve $${LIVE_MIN_BALANCE})`);

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

    // Skip cities with known structural issues (settlement ambiguity, tight distribution, low model skill)
    if (BLOCKED_CITIES.has(parsed.city.toLowerCase())) {
      log(`${groupKey}: city '${parsed.city}' is blocked — skipping`);
      continue;
    }

    // Group-level cooldown: if ANY bucket in this city+date already has an open
    // trade within the cooldown window, skip the whole group. This prevents
    // re-signalling the same city/date when the best bucket shifts slightly,
    // which wastes AI tokens and floods Discord with duplicate alerts.
    const groupLastSignal = state.cooldowns?.[groupKey] || 0;
    const groupCooledDown = (now - groupLastSignal) >= COOLDOWN_MS;
    const groupHasOpenTrade = trades.some(t =>
      t.outcome === null &&
      t.parsed?.city?.toLowerCase() === parsed.city.toLowerCase() &&
      t.parsed?.date === parsed.date
    );
    if (groupHasOpenTrade && !groupCooledDown) {
      log(`${groupKey}: open trade exists within cooldown window — skipping group`);
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

    // Apply per-city bias correction: shift model mean to match historical settlement temperatures.
    // biasCorrF = mean(observedTemp - modelMeanF) over resolved trades for this city.
    const cityKey        = parsed.city.toLowerCase();
    const biasCorrF      = typeof BIAS_CORRECTIONS[cityKey] === 'number' ? BIAS_CORRECTIONS[cityKey] : 0;
    const correctedMeanF = forecast.meanF != null
      ? Math.round((forecast.meanF + biasCorrF) * 10) / 10
      : null;

    const sigmaSource = forecast.historical
      ? `GHCN-Daily ${forecast.historical.station} (${forecast.historical.sampleSize}yr σ)`
      : forecast.ensemble
        ? 'GFS ensemble spread'
        : 'lead-time heuristic';
    const biasNote = biasCorrF !== 0 && forecast.meanF != null
      ? ` (bias ${biasCorrF >= 0 ? '+' : ''}${biasCorrF.toFixed(2)}°F → corrected ${correctedMeanF.toFixed(1)}°F)`
      : '';
    log(`${groupKey}: mean=${forecast.meanF != null ? forecast.meanF.toFixed(1) + '°F' : 'N/A'}${biasNote} σ=${forecast.sigmaF.toFixed(1)}°F [${sigmaSource}] (${forecast.sources.join(', ')})`);

    // ── Inter-model spread filter ──────────────────────────────────────────────
    // When models fundamentally disagree on the regime, the Gaussian CDF is unreliable.
    // >8°F spread: skip entirely (models on different atmospheric solutions).
    // 5–8°F spread: widen sigma by 15% to reflect genuine regime uncertainty.
    const interModelSpread = forecast.interModelSpread;
    const SPREAD_SKIP_F  = parseFloat(process.env.WEATHER_SPREAD_SKIP_F  || '8');
    const SPREAD_WIDEN_F = parseFloat(process.env.WEATHER_SPREAD_WIDEN_F || '5');
    if (interModelSpread != null) {
      if (interModelSpread > SPREAD_SKIP_F) {
        log(`${groupKey}: inter-model spread ${interModelSpread.toFixed(1)}°F > ${SPREAD_SKIP_F}°F threshold — models disagree on regime, skipping`);
        continue;
      }
      if (interModelSpread > SPREAD_WIDEN_F) {
        const widenedSigma = Math.round(forecast.sigmaF * 1.15 * 10) / 10;
        log(`${groupKey}: inter-model spread ${interModelSpread.toFixed(1)}°F — sigma widened from ${forecast.sigmaF.toFixed(1)}°F to ${widenedSigma.toFixed(1)}°F`);
        forecast = { ...forecast, sigmaF: widenedSigma };
      }
    }

    // Score each bucket market in this group
    let bestMarket          = null;
    let bestEdge            = -Infinity;
    let bestSide            = null;
    let bestModelProb       = null;
    const shadowCandidates  = [];
    const tailCandidates    = [];

    for (const market of groupMarkets) {
      const { conditionId, parsed: mp } = market;

      // Cooldown: don't re-signal same market within 4 hours.
      // Price-move re-evaluation only applies AFTER the cooldown has expired —
      // it does not bypass the cooldown window.
      const lastSignal = state.cooldowns?.[conditionId] || 0;
      const cooledDown = (now - lastSignal) >= COOLDOWN_MS;

      const existingTrade = trades.find(t => t.conditionId === conditionId && t.outcome === null && !t.shadow);
      if (existingTrade && !cooledDown) continue;

      const modelProb = bucketModelProb(mp, correctedMeanF, forecast.sigmaF);
      if (modelProb == null) continue;

      const yesEdge = modelProb - market.yesPrice;
      const noEdge  = (1 - modelProb) - market.noPrice;

      const side = yesEdge >= noEdge ? 'yes' : 'no';
      const edge = Math.max(yesEdge, noEdge);

      // Flip-flop guard: when re-evaluating a cooled-down market with an existing open trade,
      // require stricter price movement to re-signal in the opposite direction.
      // Prevents oscillation when the model mean hovers near the bucket boundary.
      if (existingTrade && cooledDown) {
        const priceDiff = Math.abs(market.yesPrice - existingTrade.yesPrice);
        const lastSide  = state.lastSignalSide?.[conditionId];
        const isFlip    = lastSide && lastSide !== side;
        const minMove   = isFlip ? 0.15 : 0.10;
        if (priceDiff < minMove) continue;
        log(`Market ${conditionId} price moved ${(priceDiff * 100).toFixed(1)}pts after cooldown${isFlip ? ' (DIRECTION FLIP — required 15%)' : ''} — re-evaluating`);
      }

      // YES+range: fully blocked (13% WR all-time, structural model-accuracy problem).
      // Shadow-log candidates meeting the sigma+bias filter for future validation —
      // zero AI cost, no Discord post, no paper trade.
      if (side === 'yes' && mp.direction === 'range') {
        if (forecast.sigmaF < 0.75 && Math.abs(biasCorrF) < 2.0 && yesEdge > MIN_EDGE) {
          shadowCandidates.push({ market, modelProb, yesEdge });
        }
        continue;
      }

      // YES+above: fully blocked (44% WR all-time; 11% WR when σ≥1.5°F or bias<-2°F).
      // Shadow-log candidates meeting σ<1.5°F AND bias>-2°F — 78% WR on n=9 trades.
      if (side === 'yes' && mp.direction === 'above') {
        if (forecast.sigmaF < 1.5 && biasCorrF > -2.0 && yesEdge > MIN_EDGE) {
          shadowCandidates.push({ market, modelProb, yesEdge });
        }
        continue;
      }

      // NO+below: fully blocked (14% WR across 14 trades — model consistently wrong on
      // below-threshold NO bets; market pricing of cold extremes is more reliable than GFS).
      if (side === 'no' && mp.direction === 'below') {
        continue;
      }

      // Tail under-pricing: collect YES buckets priced ≤ TAIL_MAX_PRICE where model
      // doesn't actively predict impossibility (modelProb > 5%). Fired as a fixed small
      // bet regardless of Kelly; priced separately from the main signal path.
      // Default OFF — enable with WEATHER_TAIL_ENABLED=true.
      if (process.env.WEATHER_TAIL_ENABLED === 'true') {
        const TAIL_MAX_PRICE = parseFloat(process.env.WEATHER_TAIL_MAX_PRICE || '0.10');
        if (market.yesPrice <= TAIL_MAX_PRICE && modelProb > 0.05 && side !== 'no') {
          tailCandidates.push({ market, modelProb, tailEdge: modelProb - market.yesPrice });
        }
      }

      if (edge > bestEdge) {
        bestEdge      = edge;
        bestMarket    = market;
        bestSide      = side;
        bestModelProb = modelProb;
      }
    }

    // Write shadow records before checking for a real winner — no AI, no Discord.
    if (shadowCandidates.length > 0) {
      for (const sc of shadowCandidates) {
        const shadowRecord = {
          id:            `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          shadow:        true,
          conditionId:   sc.market.conditionId,
          question:      sc.market.question,
          parsed:        sc.market.parsed,
          eventSlug:     sc.market.eventSlug,
          side:          'yes',
          edge:          Math.round(sc.yesEdge * 1000) / 10,
          yesPrice:      sc.market.yesPrice,
          noPrice:       sc.market.noPrice,
          modelProb:     Math.round(sc.modelProb * 1000) / 10,
          meanF:         forecast.meanF,
          correctedMeanF,
          biasCorrF,
          sigmaF:        forecast.sigmaF,
          firedAt:       new Date().toISOString(),
          outcome:       null,
          signalResult:  null,
          observedTemp:  null,
          pnlDollars:    null,
        };
        trades.push(shadowRecord);
        log(`Shadow YES+${sc.market.parsed?.direction}: ${sc.market.parsed?.city} σ=${forecast.sigmaF.toFixed(2)}°F bias=${biasCorrF.toFixed(2)}°F edge=${(sc.yesEdge * 100).toFixed(1)}%`);
      }
      writeTrades(trades);
    }

    if (bestMarket == null || bestEdge < MIN_EDGE) {
      if (bestMarket != null) {
        log(`${groupKey}: best edge ${(bestEdge * 100).toFixed(1)}% below ${(MIN_EDGE * 100).toFixed(0)}% threshold (${bestSide}+${bestMarket.parsed?.direction}) — skip`);
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

    // Skip if side price too high — poor risk/reward
    if (marketPrice >= MAX_SIDE_PRICE) {
      log(`${groupKey}: ${bestSide.toUpperCase()} price ${(marketPrice * 100).toFixed(0)}¢ ≥ ceiling ${(MAX_SIDE_PRICE * 100).toFixed(0)}¢ — skip (poor R:R)`);
      continue;
    }

    const stage1Signal = {
      question:             bestMarket.question,
      direction:            mp.direction,
      bucketLabel:          thresholdLabel(mp),
      side:                 bestSide,
      edge:                 bestEdge,
      marketPrice,
      modelProb:            bestModelProb,
      meanF:                correctedMeanF,
      sigmaF:               forecast.sigmaF,
      ensembleSpread:       forecast.ensemble?.spread      ?? null,
      interModelSpread:     interModelSpread               ?? null,
      memberCount:          forecast.ensemble?.memberCount ?? null,
      membersOnSide:        forecast.ensemble
        ? Math.round((bestSide === 'yes'
            ? bestModelProb
            : 1 - bestModelProb) * (forecast.ensemble.memberCount || 0))
        : null,
      daysToResolution,
      historicalMean:       forecast.historical?.mean ?? null,            // fetchGHCNStats remaps historicalMean → mean
      thresholdPercentile:  forecast.historical?.thresholdPercentile ?? null,
      sources:              forecast.sources,
      thresholdF:           mp.thresholdF,
      thresholdHighF:       mp.thresholdHighF ?? null,
    };

    // ── AI quality filter (skipped when capital fully deployed) ───────────
    let aiAnalysis;

    if (!capitalAvailable || !AI_ENABLED) {
      // No capital to deploy, or AI globally disabled — skip token spend, fire paper signal only.
      // aiDecision: null marks these trades as non-AI so calibration excludes them.
      aiAnalysis = { decision: 'take', sizeMultiplier: 1.0, confidence: null, reasoning: null, flags: [], stage: null, summary: null, steps: null, deepSkipped: true };
      log(!AI_ENABLED ? '  AI skipped — disabled (conserving credits)' : '  AI skipped — capital fully deployed');
    } else {
      const stage1Result = await analyzeSignal(stage1Signal);
      log(`  Stage 1 (Haiku): decision=${stage1Result.decision} confidence=${stage1Result.confidence != null ? (stage1Result.confidence * 100).toFixed(0) + '%' : 'N/A'} size=${stage1Result.sizeMultiplier}× | ${stage1Result.reasoning || 'no reasoning'}`);

      aiAnalysis = stage1Result;

      // ── Stage 2: Sonnet deep analysis (fires on take or reduce only) ────
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
      continue;  // suppressed — don't count as a fired signal
    }

    // Apply size multiplier from AI assessment + city calibration multiplier
    const cityCalibMult   = getCityKellyMultiplier(mp.city);
    if (cityCalibMult !== 1.0) log(`${groupKey}: city Kelly multiplier ${cityCalibMult}× (Brier score calibration)`);
    const baseKelly       = kellySizing(bestModelProb, bestMarket.yesPrice, bestSide, BANKROLL, KELLY_FRAC, MAX_BET);
    const adjustedDollars = Math.round(baseKelly.dollars * aiAnalysis.sizeMultiplier * cityCalibMult * 100) / 100;
    const kelly           = { ...baseKelly, dollars: adjustedDollars };

    // Skip if Kelly is $0 after live price refresh — means the market moved against us
    // between edge calculation and the CLOB price fetch (common in illiquid bucket markets).
    if (kelly.dollars === 0) {
      log(`${groupKey}: Kelly=$0 after price refresh (modelProb=${(bestModelProb*100).toFixed(1)}% vs yesPrice=${(bestMarket.yesPrice*100).toFixed(0)}¢) — skipping`);
      continue;
    }

    const id    = signalId();
    const card  = buildSignalCard(bestMarket, { ...forecast, meanF: correctedMeanF, rawMeanF: forecast.meanF, biasCorrF }, kelly, bestSide, bestEdge, bestModelProb, id, aiAnalysis, LIVE_EXECUTE);
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
    const existingTrade = trades.find(t => t.conditionId === conditionId && t.outcome === null && !t.shadow);
    const tradeRecord = {
      id,
      conditionId,
      question:        bestMarket.question,
      parsed:          mp,
      eventSlug:       bestMarket.eventSlug || null,
      wuStation:       bestMarket.wuStation || null,
      side:            bestSide,
      edge:            Math.round(bestEdge * 1000) / 10,
      yesPrice:        bestMarket.yesPrice,
      noPrice:         bestMarket.noPrice,
      modelProb:       Math.round(bestModelProb * 1000) / 10,
      meanF:           forecast.meanF != null ? Math.round(forecast.meanF * 10) / 10 : null,
      correctedMeanF:  correctedMeanF != null ? Math.round(correctedMeanF * 10) / 10 : null,
      biasCorrF:       biasCorrF !== 0 ? biasCorrF : undefined,
      sigmaF:          Math.round(forecast.sigmaF * 10) / 10,
      interModelSpread:    interModelSpread != null ? Math.round(interModelSpread * 10) / 10 : null,
      cityCalibMultiplier: cityCalibMult !== 1.0 ? cityCalibMult : undefined,
      betDollars:      kelly.dollars,
      aiDecision:       aiAnalysis.stage === null ? null : aiAnalysis.decision,
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

    // ── Live order execution: NO+Range only ────────────────────────────────────
    if (LIVE_EXECUTE && bestSide === 'no' && mp.direction === 'range' && aiAnalysis.decision === 'take' && !PAPER_ONLY_CITIES.has(mp.city?.toLowerCase())) {
      const { placeNoOrder, pollOrderFill } = require('../lib/polymarket-orders');
      // Gamma API does not return token IDs — fetch NO token from CLOB
      const noTokenId = await getNoTokenId(conditionId);
      if (noTokenId) {
        // Duplicate live order guard: skip if a live position already exists for this market
        // (open = order pending fill, filled = position open awaiting settlement).
        // Prevents double-exposure when a superseded trade triggered a re-signal.
        const activeLiveOrder = trades.find(t =>
          t.conditionId === conditionId &&
          (t.liveOrder?.status === 'open' || t.liveOrder?.status === 'filled')
        );
        if (activeLiveOrder) {
          log(`${id}: live order skipped — active live position already exists for ${conditionId} (${activeLiveOrder.id}, status=${activeLiveOrder.liveOrder.status})`);
          await postWebhook(
            SIGNALS_HOOK, 'info',
            `⚠️ **LIVE ORDER SKIPPED — POSITION EXISTS** | \`${id}\`\n` +
            `Active live order on same market: \`${activeLiveOrder.id}\` (${activeLiveOrder.liveOrder.status})\n` +
            `Paper signal logged. Exit or settle the existing position first.`,
            `Weather • Live • ${mp.date}`
          );
        } else if (bestEdge < LIVE_MIN_EDGE) {
          // ── Guardrail 1: edge below live minimum ─────────────────────────
          log(`${id}: live order skipped — edge ${(bestEdge * 100).toFixed(1)}% below LIVE_MIN_EDGE ${(LIVE_MIN_EDGE * 100).toFixed(0)}% (paper signal active)`);
          await postWebhook(
            SIGNALS_HOOK, 'info',
            `📉 **LIVE ORDER SKIPPED — EDGE TOO LOW** | \`${id}\`\n` +
            `Edge: **${(bestEdge * 100).toFixed(1)}%** | Live minimum: **${(LIVE_MIN_EDGE * 100).toFixed(0)}%**\n` +
            `Paper signal posted. Tune \`POLYMARKET_LIVE_MIN_EDGE\` to adjust.`,
            `Weather • Live • ${mp.date}`
          );
        } else if (((1 - noPrice) / noPrice) < LIVE_MIN_PAYOUT_RATIO) {
          // ── Guardrail 1b: R:R too poor — price may have drifted since signal ──
          const livePayout      = (1 - noPrice) / noPrice;
          const riskPerDollarWon = (noPrice / (1 - noPrice)).toFixed(2);
          log(`${id}: live order skipped — NO price ${pct(noPrice)} → ${livePayout.toFixed(2)}x payout < min ${LIVE_MIN_PAYOUT_RATIO} (risk $${riskPerDollarWon} per $1 won)`);
          await postWebhook(
            SIGNALS_HOOK, 'error',
            `📉 **LIVE SKIPPED — POOR R:R** | \`${id}\`\n` +
            `${bestMarket.question}\n` +
            `NO at **${pct(noPrice)}** → risk **$${riskPerDollarWon} per $1 won** (min: ${LIVE_MIN_PAYOUT_RATIO}x)\n` +
            `Market may have moved since signal fired. Check price before entering manually.`,
            `Weather • Live • ${mp.date}`
          );
        } else if (livePositionCount >= LIVE_MAX_POSITIONS) {
          // ── Guardrail 2: concurrent position cap ──────────────────────────
          log(`${id}: live order skipped — ${livePositionCount} active positions at cap LIVE_MAX_POSITIONS=${LIVE_MAX_POSITIONS} (paper signal active)`);
          await postWebhook(
            SIGNALS_HOOK, 'info',
            `🚦 **LIVE ORDER SKIPPED — POSITION CAP** | \`${id}\`\n` +
            `Active live positions: **${livePositionCount}** | Cap: **${LIVE_MAX_POSITIONS}**\n` +
            `Paper signal posted. Wait for a position to settle or raise \`POLYMARKET_LIVE_MAX_POSITIONS\`.`,
            `Weather • Live • ${mp.date}`
          );
        } else if (aiAnalysis.confidence == null || aiAnalysis.confidence < LIVE_MIN_AI_CONFIDENCE) {
          // ── Guardrail 3: AI confidence below minimum ──────────────────────
          const confStr = aiAnalysis.confidence != null
            ? `${(aiAnalysis.confidence * 100).toFixed(0)}%`
            : 'null (AI skipped)';
          log(`${id}: live order skipped — AI confidence ${confStr} below LIVE_MIN_AI_CONFIDENCE ${(LIVE_MIN_AI_CONFIDENCE * 100).toFixed(0)}% (paper signal active)`);
          await postWebhook(
            SIGNALS_HOOK, 'info',
            `🤖 **LIVE ORDER SKIPPED — LOW AI CONFIDENCE** | \`${id}\`\n` +
            `AI confidence: **${confStr}** | Minimum: **${(LIVE_MIN_AI_CONFIDENCE * 100).toFixed(0)}%**\n` +
            `Paper signal posted. Tune \`POLYMARKET_LIVE_MIN_CONFIDENCE\` or wait for higher-conviction setup.`,
            `Weather • Live • ${mp.date}`
          );
        } else {

        // Capital accountability: sum all active live orders (open + filled positions not yet settled)
        const deployed = trades
          .filter(t => ['open', 'filled', 'partial_expired'].includes(t.liveOrder?.status))
          .reduce((sum, t) => sum + (t.liveOrder.sizeDollars || 0), 0);
        const available = Math.round((LIVE_BANKROLL - deployed) * 100) / 100;

        if (available < LIVE_MIN_BALANCE) {
          log(`${id}: live order skipped — available $${available} below minimum $${LIVE_MIN_BALANCE} (deployed $${deployed.toFixed(2)} of $${LIVE_BANKROLL})`);
          await postWebhook(
            SIGNALS_HOOK, 'error',
            `⚠️ **LIVE ORDER SKIPPED — LOW BALANCE** | \`${id}\`\n` +
            `Available: **$${available}** | Deployed: **$${deployed.toFixed(2)}** | Bankroll: **$${LIVE_BANKROLL}**\n` +
            `Minimum reserve is $${LIVE_MIN_BALANCE}. Free up capital or raise \`POLYMARKET_MIN_BALANCE\`.`,
            `Weather • Live • ${mp.date}`
          );
        } else {
          const liveKelly  = kellySizing(bestModelProb, bestMarket.yesPrice, 'no', LIVE_BANKROLL, KELLY_FRAC, LIVE_MAX_BET);
          const kellyDollars = Math.min(
            Math.round(liveKelly.dollars * (aiAnalysis.sizeMultiplier ?? 1) * 100) / 100,
            available - LIVE_MIN_BALANCE
          );

          // Minimum win profit check: at current noPrice, what would we win?
          // If below LIVE_MIN_PROFIT, scale up to the minimum required bet.
          // If that exceeds LIVE_MAX_BET or available capital, skip the trade.
          const noPrice         = bestMarket.noPrice;
          const minRequiredBet  = Math.ceil(LIVE_MIN_PROFIT * noPrice / (1 - noPrice) * 100) / 100;
          const liveDollars     = Math.max(kellyDollars, minRequiredBet);
          const estWinProfit    = Math.round(liveDollars * (1 - noPrice) / noPrice * 100) / 100;

          if (estWinProfit < LIVE_MIN_PROFIT || liveDollars > LIVE_MAX_BET || liveDollars > available - LIVE_MIN_BALANCE) {
            log(`${id}: live order skipped — est. win $${estWinProfit} < min $${LIVE_MIN_PROFIT} even at $${liveDollars} (NO price ${(noPrice * 100).toFixed(0)}¢)`);
            await postWebhook(
              SIGNALS_HOOK, 'info',
              `📉 **LIVE ORDER SKIPPED — POOR R:R** | \`${id}\`\n` +
              `NO price: **${(noPrice * 100).toFixed(0)}¢** | Would need **$${minRequiredBet}** to win $${LIVE_MIN_PROFIT}\n` +
              `Cap: $${LIVE_MAX_BET} | Available: $${(available - LIVE_MIN_BALANCE).toFixed(2)} | Paper signal still active.`,
              `Weather • Live • ${mp.date}`
            );
          } else if (liveDollars > 0) {
            (async () => {
              try {
                // Slippage simulation: reject if estimated order book slippage > 2.5%
                const LIVE_MAX_SLIPPAGE = parseFloat(process.env.POLYMARKET_MAX_SLIPPAGE || '0.025');
                const slippage = await simulateSlippage(conditionId, 'no', liveDollars).catch(() => null);
                if (slippage != null && slippage > LIVE_MAX_SLIPPAGE) {
                  log(`${id}: live order skipped — simulated slippage ${(slippage * 100).toFixed(1)}% > ${(LIVE_MAX_SLIPPAGE * 100).toFixed(1)}% limit`);
                  await postWebhook(
                    SIGNALS_HOOK, 'info',
                    `🌊 **LIVE ORDER SKIPPED — HIGH SLIPPAGE** | \`${id}\`\n` +
                    `Estimated slippage: **${(slippage * 100).toFixed(1)}%** (limit ${(LIVE_MAX_SLIPPAGE * 100).toFixed(1)}%)\n` +
                    `Thin order book at $${liveDollars} — paper signal still active.`,
                    `Weather • Live • ${mp.date}`
                  );
                  return;
                }
                const result = await placeNoOrder(conditionId, noTokenId, bestMarket.noPrice, liveDollars);
                // Merge liveOrder into the trade record we just pushed
                const liveIdx = trades.findIndex(t => t.id === id);
                if (liveIdx !== -1) {
                  trades[liveIdx].liveOrder = result.liveOrder;
                  writeTrades(trades);
                }
                const isDryRun = process.env.POLYMARKET_DRY_RUN === 'true';
                const tag      = isDryRun ? '[DRY RUN] ' : '';
                if (result.liveOrder.status === 'error') {
                  await postWebhook(
                    SIGNALS_HOOK, 'error',
                    `❌ **LIVE ORDER FAILED** | \`${id}\`\n` +
                    `${bestMarket.question.slice(0, 100)}\n` +
                    `Error: ${result.liveOrder.error}`,
                    `Weather • Live • ${mp.date}`
                  );
                } else {
                  await postWebhook(
                    SIGNALS_HOOK, 'short',
                    `🔴 **LIVE ORDER PLACED** | \`${id}\`\n` +
                    `${bestMarket.question.slice(0, 100)}\n` +
                    `✅ ${tag}NO limit buy — $${liveDollars} @ ${result.liveOrder.limitPrice} | ` +
                    `Available after: $${(available - liveDollars).toFixed(2)} | orderId: \`${result.liveOrder.orderId}\``,
                    `Weather • Live • ${mp.date}`
                  );
                  // Fire-and-forget fill polling (non-blocking)
                  if (result.liveOrder.status === 'open') {
                    setImmediate(() => pollOrderFill(id, result.liveOrder.orderId, LIVE_TTL_MS));
                  }
                }
              } catch (err) {
                console.error(`[market-scan] live order failed for ${id}:`, err.message);
                await postWebhook(
                  SIGNALS_HOOK, 'error',
                  `❌ **LIVE ORDER EXCEPTION** | \`${id}\`\n${err.message.slice(0, 200)}`,
                  `Weather • Live • ${mp.date}`
                );
              }
            })();
          }
        } // end if (available < LIVE_MIN_BALANCE) else
        } // end guardrails else (capital + order block)
      } else {
        log(`${id}: NO token not found on CLOB for conditionId=${conditionId} — skipping live order`);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    if (!state.cooldowns) state.cooldowns = {};
    state.cooldowns[conditionId] = now;  // per-bucket cooldown (price-move re-eval after expiry)
    state.cooldowns[groupKey]    = now;  // group-level cooldown (prevents same city+date re-signal)
    if (!state.lastSignalSide) state.lastSignalSide = {};
    state.lastSignalSide[conditionId] = bestSide;  // flip-flop guard: track last fired direction
    if (!state.signals) state.signals = {};
    if (msgId) state.signals[id] = msgId;
    writeState(state);

    log(`Signal fired: ${id} | ${bestSide.toUpperCase()} | edge ${(bestEdge * 100).toFixed(1)}% | $${kelly.dollars}`);
    signalsFired++;

    // ── Tail under-pricing signals (same group, different markets) ─────────────
    if (process.env.WEATHER_TAIL_ENABLED === 'true' && tailCandidates.length > 0) {
      const TAIL_MIN_BET = parseFloat(process.env.WEATHER_TAIL_MIN_BET || '2.00');
      const TAIL_MAX_BET = parseFloat(process.env.WEATHER_TAIL_MAX_BET || '5.00');
      const tailBet      = Math.min(Math.max(TAIL_MIN_BET, TAIL_MIN_BET), TAIL_MAX_BET);

      for (const tc of tailCandidates) {
        if (tc.market.conditionId === conditionId) continue;  // same market as main signal — skip

        const existingTail = trades.find(t => t.conditionId === tc.market.conditionId && t.outcome === null);
        if (existingTail) continue;  // already open

        const tailId      = signalId();
        const tailMp      = tc.market.parsed;
        const tailPrice   = tc.market.yesPrice;
        const tailCard    = [
          `🎯 **TAIL BUY** | YES @ ${(tailPrice * 100).toFixed(0)}¢ (model: ${(tc.modelProb * 100).toFixed(0)}%)`,
          `${tc.market.question}`,
          `Edge: ${(tc.tailEdge * 100).toFixed(1)}% | Bet: $${tailBet.toFixed(2)} fixed (no Kelly)`,
          `\`ID: ${tailId}\``,
        ].join('\n');

        if (SIGNALS_HOOK) await postWebhook(SIGNALS_HOOK, 'long', tailCard, `Weather • Tail • ${tailMp?.city} • ${tailMp?.date}`);

        const tailRecord = {
          id:           tailId,
          conditionId:  tc.market.conditionId,
          question:     tc.market.question,
          parsed:       tailMp,
          eventSlug:    tc.market.eventSlug || null,
          side:         'yes',
          signalType:   'tail',
          edge:         Math.round(tc.tailEdge * 1000) / 10,
          yesPrice:     tailPrice,
          noPrice:      tc.market.noPrice,
          modelProb:    Math.round(tc.modelProb * 1000) / 10,
          meanF:        forecast.meanF != null ? Math.round(forecast.meanF * 10) / 10 : null,
          correctedMeanF: correctedMeanF != null ? Math.round(correctedMeanF * 10) / 10 : null,
          sigmaF:       Math.round(forecast.sigmaF * 10) / 10,
          betDollars:   tailBet,
          firedAt:      new Date().toISOString(),
          sources:      forecast.sources,
          outcome:      null,
          observedTemp: null,
          signalResult: null,
          pnlDollars:   null,
          closedAt:     null,
        };
        trades.push(tailRecord);
        writeTrades(trades);
        log(`Tail signal fired: ${tailId} | YES @ ${(tailPrice * 100).toFixed(0)}¢ | model ${(tc.modelProb * 100).toFixed(0)}% | $${tailBet}`);
      }
    }
  }

  log(`Scan complete. ${signalsFired} signal(s) fired.`);
}

if (!acquireScanLock()) process.exit(0);

main()
  .catch(err => {
    console.error('[weather-scan] Fatal error:', err);
    process.exit(1);
  })
  .finally(releaseScanLock);
