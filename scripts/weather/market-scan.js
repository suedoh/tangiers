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
const MIN_EDGE           = parseFloat(process.env.WEATHER_MIN_EDGE           || '0.08');  // 8%
const YES_RANGE_MIN_EDGE = parseFloat(process.env.WEATHER_YES_RANGE_MIN_EDGE || '0.20');  // 20% for YES+range (historically 10.7% WR pre-correction)
const MIN_VOLUME    = parseFloat(process.env.WEATHER_MIN_VOLUME || '200');   // $200 min volume
const BANKROLL      = parseFloat(process.env.WEATHER_BANKROLL   || '500');   // paper bankroll
const KELLY_FRAC    = parseFloat(process.env.WEATHER_KELLY_FRAC || '0.15');
const MAX_BET       = parseFloat(process.env.WEATHER_MAX_BET    || '100');

// ─── Live execution config ─────────────────────────────────────────────────────
const LIVE_EXECUTE   = process.env.POLYMARKET_EXECUTE_ORDERS === 'true';
const LIVE_BANKROLL  = parseFloat(process.env.POLYMARKET_LIVE_BANKROLL  || '100');
const LIVE_MAX_BET   = parseFloat(process.env.POLYMARKET_MAX_LIVE_BET   || '10');
const LIVE_TTL_MS    = (+process.env.POLYMARKET_ORDER_TTL_S || 1800) * 1000;
const LIVE_MIN_BALANCE  = parseFloat(process.env.POLYMARKET_MIN_BALANCE   || '20');
const LIVE_MIN_PROFIT   = parseFloat(process.env.POLYMARKET_MIN_WIN_PROFIT || '2.00');
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
]);

const STATE_FILE  = path.join(ROOT, '.weather-state.json');
const TRADES_FILE = path.join(ROOT, 'weather-trades.json');

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
function buildSignalCard(market, forecast, kelly, side, edge, modelProb, id, aiAnalysis = null) {
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

  // Pre-compute available capital once per scan cycle.
  // AI analysis is skipped when capital is fully deployed — no point spending tokens
  // on signals we can't enter. Paper signals still fire; aiDecision stored as null
  // so calibration stats exclude these trades.
  const deployedNow = LIVE_EXECUTE
    ? trades.filter(t => ['open', 'filled', 'partial_expired'].includes(t.liveOrder?.status))
            .reduce((sum, t) => sum + (t.liveOrder.sizeDollars || 0), 0)
    : 0;
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

    // Score each bucket market in this group
    let bestMarket          = null;
    let bestEdge            = -Infinity;
    let bestSide            = null;
    let bestModelProb       = null;
    let bestEffectiveMinEdge = MIN_EDGE;
    const shadowCandidates  = [];

    for (const market of groupMarkets) {
      const { conditionId, parsed: mp } = market;

      // Cooldown: don't re-signal same market within 4 hours.
      // Price-move re-evaluation only applies AFTER the cooldown has expired —
      // it does not bypass the cooldown window.
      const lastSignal = state.cooldowns?.[conditionId] || 0;
      const cooledDown = (now - lastSignal) >= COOLDOWN_MS;

      const existingTrade = trades.find(t => t.conditionId === conditionId && t.outcome === null);
      if (existingTrade && !cooledDown) continue;
      if (existingTrade && cooledDown) {
        const priceDiff = Math.abs(market.yesPrice - existingTrade.yesPrice);
        if (priceDiff < 0.10) continue;
        log(`Market ${conditionId} price moved ${(priceDiff * 100).toFixed(1)}pts after cooldown — re-evaluating`);
      }

      const modelProb = bucketModelProb(mp, correctedMeanF, forecast.sigmaF);
      if (modelProb == null) continue;

      const yesEdge = modelProb - market.yesPrice;
      const noEdge  = (1 - modelProb) - market.noPrice;

      const side = yesEdge >= noEdge ? 'yes' : 'no';
      const edge = Math.max(yesEdge, noEdge);

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

      if (edge > bestEdge) {
        bestEdge             = edge;
        bestMarket           = market;
        bestSide             = side;
        bestModelProb        = modelProb;
        bestEffectiveMinEdge = MIN_EDGE;
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

    if (bestMarket == null || bestEdge < bestEffectiveMinEdge) {
      if (bestMarket != null) {
        log(`${groupKey}: best edge ${(bestEdge * 100).toFixed(1)}% below ${(bestEffectiveMinEdge * 100).toFixed(0)}% threshold (${bestSide}+${bestMarket.parsed?.direction}) — skip`);
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
      meanF:                correctedMeanF,
      sigmaF:               forecast.sigmaF,
      ensembleSpread:       forecast.ensemble?.spread      ?? null,
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
    };

    // ── AI quality filter (skipped when capital fully deployed) ───────────
    let aiAnalysis;

    if (!capitalAvailable) {
      // No capital to deploy — skip token spend, fire paper signal only.
      // aiDecision: null marks these trades as non-AI so calibration excludes them.
      aiAnalysis = { decision: 'take', sizeMultiplier: 1.0, confidence: null, reasoning: null, flags: [], stage: null, summary: null, steps: null, deepSkipped: true };
      log('  AI skipped — capital fully deployed');
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
    const card  = buildSignalCard(bestMarket, { ...forecast, meanF: correctedMeanF, rawMeanF: forecast.meanF, biasCorrF }, kelly, bestSide, bestEdge, bestModelProb, id, aiAnalysis);
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
      correctedMeanF:  correctedMeanF != null ? Math.round(correctedMeanF * 10) / 10 : null,
      biasCorrF:       biasCorrF !== 0 ? biasCorrF : undefined,
      sigmaF:          Math.round(forecast.sigmaF * 10) / 10,
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
      const noToken = (bestMarket.tokens || []).find(t => /^no$/i.test(t.outcome));
      if (noToken) {
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
                const result = await placeNoOrder(conditionId, noToken.token_id, bestMarket.noPrice, liveDollars);
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
        } // end if (activeLiveOrder) else
      } else {
        log(`${id}: NO token not found in bestMarket.tokens — skipping live order`);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

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
