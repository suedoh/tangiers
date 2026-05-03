#!/usr/bin/env node
'use strict';

/**
 * weather/settle.js — NOAA METAR settlement resolver
 *
 * Scans weather-trades.json for expired, unresolved signals and closes them
 * using official NOAA observations in priority order:
 *   1. GHCN-Daily CDO (primary — same station network Polymarket uses for US markets)
 *   2. NWS hourly METAR observations (secondary — near real-time airport obs)
 *   3. Open-Meteo ERA5 archive (gridded fallback)
 *
 * Tracks observedSource and modelBiasF per trade for calibration analysis.
 *
 * Flags:
 *   --dry        Preview resolutions without writing to weather-trades.json
 *   --force      Use 6h post-date buffer instead of 24h (NWS data available sooner)
 *   --id <id>    Resolve a single trade by ID regardless of date
 *
 * Run:
 *   node scripts/weather/settle.js
 *   node scripts/weather/settle.js --dry
 *   node scripts/weather/settle.js --force
 *   node scripts/weather/settle.js --id wx-abc123
 */

const path = require('path');
const fs   = require('fs');

const { loadEnv, ROOT, resolveWebhook } = require('../lib/env');
const { postWebhook }                   = require('../lib/discord');
const { fetchGHCNObserved, fetchNWSObserved, getObserved } = require('../lib/forecasts');
const { computeLivePnl }               = require('../lib/polymarket-orders');

loadEnv();

const DRY   = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const idIdx = process.argv.indexOf('--id');
const TARGET_ID = idIdx !== -1 ? process.argv[idIdx + 1] : null;

const TRADES_FILE   = path.join(ROOT, 'weather-trades.json');
const BACKTEST_HOOK = resolveWebhook('WEATHER_DISCORD_BACKTEST_WEBHOOK');

// How long to wait after the market date before attempting resolution.
// GHCN-Daily typically lags 1–3 days; NWS METAR is near real-time.
// --force drops to 6h so NWS can resolve same-day.
const BUFFER_MS = FORCE ? 6 * 3_600_000 : 24 * 3_600_000;

function log(msg) { console.log(`[${new Date().toISOString()}] [settle] ${msg}`); }
function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch (e) { console.error('[settle] readTrades error:', e.message); return []; } }
function writeTrades(t) { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); } catch (e) { console.error('[settle] writeTrades error:', e.message); } }
function pct(v)  { return v != null ? (v * 100).toFixed(1) + '%' : 'N/A'; }
function usd(v)  { return v != null ? '$' + Math.abs(v).toFixed(2) : '?'; }
function fToC(f) { return (f - 32) * 5 / 9; }

// ─── Observed value fetch — GHCN → NWS → ERA5 ────────────────────────────────

async function fetchObserved(trade) {
  const { parsed }   = trade;
  const coords       = parsed.coords || {};
  const wantHigh     = parsed.direction !== 'below';

  // 1. GHCN-Daily — authoritative, matches Polymarket settlement source
  if (coords.ghcnStation) {
    const ghcn = await fetchGHCNObserved(coords.ghcnStation, parsed.date).catch(() => null);
    if (ghcn) {
      const value = wantHigh ? ghcn.tmax : ghcn.tmin;
      if (value != null) return { value, source: ghcn.source };
    }
  }

  // 2. NWS hourly METAR — near real-time (available within hours)
  if (coords.nwsStation) {
    const nws = await fetchNWSObserved(coords.nwsStation, parsed.date, coords.tz).catch(() => null);
    if (nws) {
      const value = wantHigh ? nws.high : nws.low;
      if (value != null) return { value, source: nws.source, obsCount: nws.obsCount };
    }
  }

  // 3. Open-Meteo ERA5 archive — gridded fallback (always available)
  if (coords.lat != null && coords.lon != null) {
    const direction = parsed.direction === 'below' ? 'below' : 'above';
    const era5 = await getObserved(coords.lat, coords.lon, parsed.date, direction).catch(() => null);
    if (era5?.value != null) return { value: era5.value, source: 'Open-Meteo ERA5' };
  }

  return null;
}

// ─── Bucket hit logic ─────────────────────────────────────────────────────────

function isHit(observedF, parsed) {
  const { direction, thresholdF, thresholdHighF } = parsed;
  if (direction === 'above') return observedF >= thresholdF;
  if (direction === 'below') return observedF <= thresholdF;
  if (direction === 'range') return observedF >= thresholdF && observedF <= thresholdHighF;
  return observedF > thresholdF;
}

function bucketLabel(parsed) {
  const { direction, thresholdF, thresholdHighF } = parsed;
  if (direction === 'above') return `≥${thresholdF}°F`;
  if (direction === 'below') return `≤${thresholdF}°F`;
  if (direction === 'range') return `${thresholdF}–${thresholdHighF}°F`;
  return `${thresholdF}°F`;
}

// ─── Discord resolution card ──────────────────────────────────────────────────

async function postResolutionCard(trade, observed, hit, signalWon) {
  if (!BACKTEST_HOOK) return;

  const icon     = signalWon ? '✅' : '❌';
  const result   = signalWon ? 'WIN' : 'LOSS';
  const price    = trade.side === 'yes' ? trade.yesPrice : trade.noPrice;
  const bucket   = bucketLabel(trade.parsed);
  const obsC     = fToC(observed.value).toFixed(1);
  const hitLabel = hit ? 'HIT' : 'MISS';

  const biasF = trade.meanF != null ? (observed.value - trade.meanF).toFixed(1) : null;
  const biasStr = biasF != null
    ? `Model bias: **${biasF > 0 ? '+' : ''}${biasF}°F** (model ${parseFloat(biasF) > 0 ? 'under' : 'over'}predicted)`
    : '';

  const pnlStr = trade.pnlDollars != null
    ? `P&L: **${trade.pnlDollars >= 0 ? '+' : ''}${usd(trade.pnlDollars)}** (bet ${usd(trade.betDollars)} @ ${pct(price)})`
    : '';

  const livePnlStr = trade.liveOrder?.livePnlDollars != null
    ? `Live P&L: **${trade.liveOrder.livePnlDollars >= 0 ? '+' : ''}${usd(trade.liveOrder.livePnlDollars)}** (${trade.liveOrder.filledShares?.toFixed(2)} shares @ ${pct(trade.liveOrder.limitPrice)})`
    : '';

  const lines = [
    `${icon} **WEATHER RESOLVED — ${result}**`,
    `${trade.question}`,
    '',
    `Side: **${trade.side.toUpperCase()}** at ${pct(price)} | Bucket: ${bucket}`,
    `Observed: **${observed.value.toFixed(1)}°F (${obsC}°C)** → bucket ${hitLabel} → ${hit ? 'YES' : 'NO'} resolves ${trade.side === 'yes' ? (hit ? 'WIN' : 'LOSS') : (hit ? 'LOSS' : 'WIN')}`,
    `Source: ${observed.source}${observed.obsCount ? ` (${observed.obsCount} obs)` : ''}`,
    biasStr,
    pnlStr,
    livePnlStr,
    `\`ID: ${trade.id}\``,
  ].filter(Boolean);

  const alertType = signalWon ? 'long' : 'error';
  await postWebhook(BACKTEST_HOOK, alertType, lines.join('\n'), 'Weather • Settlement');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const modeStr = [DRY && '--dry', FORCE && '--force', TARGET_ID && `--id ${TARGET_ID}`]
    .filter(Boolean).join(' ') || 'default';
  log(`Settlement resolver starting (${modeStr})`);

  const trades = readTrades();
  const now    = Date.now();

  // Select candidates
  const candidates = trades.filter(trade => {
    if (trade.outcome !== null) return false;
    if (TARGET_ID) return trade.id === TARGET_ID;
    const dateMs = new Date(trade.parsed?.date).getTime();
    return (now - dateMs) >= BUFFER_MS;
  });

  log(`${candidates.length} trade(s) eligible for settlement`);

  let resolved = 0, skipped = 0;

  for (const trade of candidates) {
    log(`Attempting: ${trade.id} — ${trade.question.slice(0, 60)}`);

    const observed = await fetchObserved(trade);

    if (!observed || observed.value == null) {
      log(`  ↳ No observation data yet — skipping`);
      skipped++;
      continue;
    }

    const hit       = isHit(observed.value, trade.parsed);
    const signalWon = (trade.side === 'yes' && hit) || (trade.side === 'no' && !hit);
    const price     = trade.side === 'yes' ? trade.yesPrice : trade.noPrice;
    const pnl       = trade.betDollars > 0
      ? signalWon
        ? Math.round(trade.betDollars * (1 - price) / price * 100) / 100
        : -trade.betDollars
      : null;

    computeLivePnl(trade, signalWon);

    const logLine = `  ↳ ${observed.source}: ${observed.value.toFixed(1)}°F | bucket ${bucketLabel(trade.parsed)} → ${hit ? 'HIT' : 'MISS'} → ${signalWon ? 'WIN' : 'LOSS'}`;
    log(logLine);

    if (!DRY) {
      trade.outcome        = hit ? 'yes-resolved' : 'no-resolved';
      trade.observedTemp   = observed.value;
      trade.observedSource = observed.source;
      trade.signalResult   = signalWon ? 'win' : 'loss';
      trade.pnlDollars     = pnl;
      trade.closedAt       = new Date().toISOString();
      if (trade.meanF != null) {
        trade.modelBiasF = Math.round((observed.value - trade.meanF) * 10) / 10;
      }
      if (!trade.shadow) await postResolutionCard(trade, observed, hit, signalWon);
    } else {
      log(`  ↳ [DRY] would write: outcome=${hit ? 'yes-resolved' : 'no-resolved'} signalResult=${signalWon ? 'win' : 'loss'}`);
    }

    resolved++;
  }

  if (!DRY && resolved > 0) {
    // Remove resolved shadow trades — they've served their tracking purpose and shouldn't accumulate
    const toWrite = trades.filter(t => !(t.shadow && t.outcome !== null));
    const removed = trades.length - toWrite.length;
    writeTrades(toWrite);
    log(`Wrote ${resolved} resolution(s) to weather-trades.json${removed > 0 ? ` (removed ${removed} resolved shadow trade(s))` : ''}`);
  }

  // Summary
  const wins   = trades.filter(t => t.signalResult === 'win'  && !t.shadow).length;
  const losses = trades.filter(t => t.signalResult === 'loss' && !t.shadow).length;
  const total  = wins + losses;
  const wr     = total > 0 ? Math.round(100 * wins / total) : null;

  log(`Done. Resolved: ${resolved} | Skipped (no data): ${skipped} | Lifetime: ${wins}W/${losses}L${wr != null ? ` (${wr}% WR)` : ''}`);

  // Post a summary to backtest channel if multiple trades resolved
  if (!DRY && resolved >= 2 && BACKTEST_HOOK) {
    const resolvedThisRun = candidates.filter(t => t.signalResult != null);
    const wins_this_run   = resolvedThisRun.filter(t => t.signalResult === 'win').length;
    const losses_this_run = resolvedThisRun.length - wins_this_run;
    const pnl_this_run    = resolvedThisRun.reduce((a, t) => a + (t.pnlDollars || 0), 0);
    const livePnlTotal    = resolvedThisRun.reduce((a, t) => a + (t.liveOrder?.livePnlDollars ?? 0), 0);
    const hasLiveTrades   = resolvedThisRun.some(t => t.liveOrder?.livePnlDollars != null);
    const summary = [
      `🏁 **SETTLEMENT RUN — ${resolved} resolved**`,
      `${wins_this_run}W / ${losses_this_run}L | P&L: ${pnl_this_run >= 0 ? '+' : ''}${usd(pnl_this_run)}`,
      hasLiveTrades ? `Live P&L: ${livePnlTotal >= 0 ? '+' : ''}${usd(livePnlTotal)}` : '',
      skipped > 0 ? `${skipped} trade(s) skipped — GHCN/NWS data not yet available` : '',
      wr != null ? `Lifetime win rate: **${wr}%** (${wins}W / ${losses}L)` : '',
    ].filter(Boolean).join('\n');
    await postWebhook(BACKTEST_HOOK, 'info', summary, 'Weather • Settlement Summary');
  }
}

main().catch(err => {
  console.error('[settle] Fatal:', err);
  process.exit(1);
});
