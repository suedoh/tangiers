#!/usr/bin/env node
'use strict';

/**
 * weather/analyze.js — On-demand single market deep dive
 *
 * Usage:
 *   node scripts/weather/analyze.js --condition 0xABC123
 *   node scripts/weather/analyze.js --url https://polymarket.com/event/some-market
 *   node scripts/weather/analyze.js --question "Will NYC high exceed 72F on April 24?"
 *
 * Called by the Discord bot via !analyze <url or question>.
 * Posts a detailed analysis card to #weather-signals.
 */

const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
const { postWebhook }   = require('../lib/discord');
const { getForecast, fetchNWS } = require('../lib/forecasts');
const {
  fetchWeatherMarkets,
  getMarketPrice,
  parseQuestion,
  cityCoords,
  kellySizing,
  marketUrl,
} = require('../lib/polymarket');

loadEnv();

const SIGNALS_HOOK = process.env.WEATHER_DISCORD_SIGNALS_WEBHOOK;
const BANKROLL     = parseFloat(process.env.WEATHER_BANKROLL   || '500');
const KELLY_FRAC   = parseFloat(process.env.WEATHER_KELLY_FRAC  || '0.15');
const MAX_BET      = parseFloat(process.env.WEATHER_MAX_BET     || '100');

function log(msg) { console.log(`[${new Date().toISOString()}] [weather-analyze] ${msg}`); }
function pct(v)   { return v != null ? (v * 100).toFixed(1) + '%' : 'N/A'; }
function usd(v)   { return v != null ? '$' + v.toFixed(2) : 'N/A'; }
function bar(p, len = 14) {
  const filled = Math.round(p * len);
  return '█'.repeat(filled) + '░'.repeat(len - filled);
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs() {
  const args  = process.argv.slice(2);
  const out   = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--condition') out.conditionId = args[++i];
    if (args[i] === '--url')       out.url          = args[++i];
    if (args[i] === '--question')  out.question     = args.slice(i + 1).join(' ');
    if (args[i] === '--source')    out.source       = args[++i];
  }
  return out;
}

// ─── Market resolution ────────────────────────────────────────────────────────

/**
 * Find a market by conditionId, URL slug, or question text.
 * Returns a market object or a bare parsed structure from a question.
 */
async function resolveMarket(opts) {
  const markets = await fetchWeatherMarkets();

  // By conditionId
  if (opts.conditionId) {
    const m = markets.find(m => m.conditionId.toLowerCase() === opts.conditionId.toLowerCase());
    if (m) return m;
    throw new Error(`Market not found for conditionId: ${opts.conditionId}`);
  }

  // By URL slug
  if (opts.url) {
    const slugMatch = opts.url.match(/\/event\/([^/?#]+)/);
    if (slugMatch) {
      const slug = slugMatch[1];
      const m = markets.find(m => m.slug === slug);
      if (m) return m;
    }
    // Try conditionId from URL path
    const cidMatch = opts.url.match(/0x[a-fA-F0-9]{40,}/);
    if (cidMatch) {
      const m = markets.find(m => m.conditionId.toLowerCase() === cidMatch[0].toLowerCase());
      if (m) return m;
    }
    throw new Error(`Market not found for URL: ${opts.url}`);
  }

  // By question text (manual analysis without a Polymarket market)
  if (opts.question) {
    const parsed = parseQuestion(opts.question);
    if (!parsed) throw new Error(`Could not parse question: "${opts.question}"\nMake sure it includes a city, date, and temperature threshold.`);
    return {
      conditionId: null,
      question:    opts.question,
      parsed,
      yesPrice:    null,
      noPrice:     null,
      volume:      null,
      liquidity:   null,
      endDate:     parsed.date,
      slug:        null,
      tokens:      null,
    };
  }

  throw new Error('Provide --condition, --url, or --question');
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

async function analyze(opts) {
  log(`Resolving market...`);
  const market = await resolveMarket(opts);
  const { parsed } = market;

  log(`Market: "${market.question.slice(0, 80)}"`);
  log(`Location: ${parsed.city} (${parsed.coords.lat}, ${parsed.coords.lon})`);
  log(`Target: ${parsed.date} | Threshold: ${parsed.thresholdF}°F ${parsed.direction}`);

  // Refresh live price if market exists on Polymarket
  if (market.conditionId) {
    const live = await getMarketPrice(market.conditionId).catch(() => null);
    if (live) { market.yesPrice = live.yes; market.noPrice = live.no; }
  }

  // ── Full forecast fetch ───────────────────────────────────────────────────
  log(`Fetching forecasts...`);
  const forecast = await getForecast(
    parsed.coords.lat,
    parsed.coords.lon,
    parsed.date,
    parsed.thresholdF,
    parsed.direction,
    { includeNWS: !!parsed.coords.nwsStation }
  );

  const { ensemble: e, models: m, historical: h, nws, consensus } = forecast;

  // ── Edge + Kelly ──────────────────────────────────────────────────────────
  let side = null, edge = null, kelly = null;
  if (consensus != null && market.yesPrice != null) {
    const yesEdge = consensus - market.yesPrice;
    const noEdge  = (1 - consensus) - market.noPrice;
    side  = yesEdge >= noEdge ? 'yes' : 'no';
    edge  = side === 'yes' ? yesEdge : noEdge;
    kelly = kellySizing(consensus, market.yesPrice, side, BANKROLL, KELLY_FRAC, MAX_BET);
  }

  // ── Build detailed card ───────────────────────────────────────────────────
  const cityLabel = parsed.city.replace(/\b\w/g, c => c.toUpperCase());
  const typeLabel = parsed.type === 'low' ? 'LOW' : 'HIGH';
  const dirLabel  = parsed.direction === 'above' ? '>' : '<';
  const daysOut   = ((new Date(parsed.date) - Date.now()) / 86_400_000).toFixed(1);

  const lines = [
    `## 🔬 DEEP ANALYSIS — ${cityLabel} ${typeLabel} TEMP`,
    `**${market.question}**`,
    market.conditionId ? `🔗 [View on Polymarket](${marketUrl(market)})` : '*(no live market — standalone analysis)*',
    `📅 Resolves **${parsed.date}** (${daysOut} days away)`,
    '',
    '### 📡 FORECAST SOURCES',
  ];

  // GFS Ensemble block
  if (e) {
    const spread = e.spread != null ? ` | spread ±${e.spread.toFixed(1)}°F` : '';
    lines.push(
      `**GFS 31-member Ensemble**`,
      `  Mean: **${e.mean.toFixed(1)}°F**${spread}`,
      `  P(temp ${dirLabel} ${parsed.thresholdF}°F) = ${bar(e.prob)} **${pct(e.prob)}**`,
      `  (${e.memberCount} members above threshold: ${Math.round(e.prob * e.memberCount)}/${e.memberCount})`,
    );
  } else {
    lines.push(`**GFS Ensemble** — not available (>16 day range or API error)`);
  }

  lines.push('');

  // Multi-model deterministic
  if (m?.models && Object.keys(m.models).length > 0) {
    lines.push(`**Deterministic Models** (σ = ±${m.sigma?.toFixed(1) ?? '?'}°F lead-time uncertainty)`);
    const modelLabels = {
      ecmwf_ifs025: 'ECMWF IFS  ',
      icon_global:  'ICON Global',
      gfs_seamless: 'GFS Det.   ',
    };
    for (const [model, mv] of Object.entries(m.models)) {
      const label = modelLabels[model] || model;
      lines.push(`  ${label}  fcst **${mv.forecast.toFixed(1)}°F** → P = ${bar(mv.prob, 10)} **${pct(mv.prob)}**`);
    }
    lines.push(`  **Weighted consensus: ${pct(m.consensus)}**`);
  } else {
    lines.push(`**Deterministic Models** — not available`);
  }

  lines.push('');

  // Historical
  if (h) {
    lines.push(
      `**10-year Historical Base Rate**`,
      `  Avg ${typeLabel} on ${parsed.date.slice(5)}: **${h.historicalMean.toFixed(1)}°F**`,
      `  Hist. P(${dirLabel} ${parsed.thresholdF}°F): ${bar(h.prob, 10)} **${pct(h.prob)}** (${h.sampleSize} seasons)`,
    );
  } else {
    lines.push(`**Historical Base Rate** — not available`);
  }

  lines.push('');

  // NWS official (US only)
  if (nws) {
    const nwsHigh = nws.high != null ? `High: **${nws.high}°${nws.unit}**` : '';
    const nwsLow  = nws.low  != null ? `Low: **${nws.low}°${nws.unit}**`  : '';
    lines.push(
      `**NWS Official Forecast** (${parsed.coords.nwsStation || 'nearest station'})`,
      `  ${[nwsHigh, nwsLow].filter(Boolean).join(' | ')}`,
      nws.daytimeName ? `  Period: ${nws.daytimeName}` : '',
    );
    lines.push('');
  }

  // ── Consensus block ───────────────────────────────────────────────────────
  lines.push(
    '### 🎯 CONSENSUS',
    `Sources used: ${forecast.sources.join(', ')}`,
  );

  if (forecast.components.length > 1) {
    for (const c of forecast.components) {
      lines.push(`  ${c.source.padEnd(20)} ${bar(c.prob, 10)} ${pct(c.prob)} (wt ${Math.round(c.weight * 100)}%)`);
    }
  }
  lines.push(`  ${'─'.repeat(44)}`);
  lines.push(`  **FINAL CONSENSUS   ${bar(consensus, 10)} ${pct(consensus)}**`);
  lines.push('');

  // ── Market vs Model ───────────────────────────────────────────────────────
  if (market.yesPrice != null) {
    lines.push('### 💰 MARKET vs MODEL');
    lines.push(`Market:  YES ${pct(market.yesPrice)} / NO ${pct(market.noPrice)}`);
    lines.push(`Model:   **${pct(consensus)}** probability of YES resolution`);

    if (edge != null && Math.abs(edge) >= 0.03) {
      const icon    = side === 'yes' ? '🟢' : '🔴';
      const verdict = edge >= 0.08 ? '**STRONG EDGE**' : edge >= 0.05 ? 'Moderate edge' : 'Thin edge';
      lines.push(`Edge:    **${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}%** → ${icon} ${verdict}: BUY ${side.toUpperCase()}`);
      if (kelly) {
        lines.push('', '### 📐 KELLY SIZING (paper trade)');
        lines.push(`Kelly: ${kelly.kelly}% → Fractional (${Math.round(KELLY_FRAC * 100)}%): **${usd(kelly.dollars)}**`);
        lines.push(`Bankroll assumption: ${usd(BANKROLL)} | Cap: ${usd(MAX_BET)}`);
      }
    } else if (edge != null) {
      lines.push(`Edge:    ${(edge * 100).toFixed(1)}% — **below minimum threshold, no trade**`);
    }
  } else {
    lines.push('*No live market — pure forecast analysis*');
    lines.push(`Forecast: **${pct(consensus)}** probability of temp ${dirLabel} ${parsed.thresholdF}°F`);
  }

  lines.push('', `📌 *${opts.source ? `Triggered by: ${opts.source}` : 'Manual analysis'}*`);

  const card   = lines.filter(l => l !== undefined).join('\n');
  const footer = `Weather • ${cityLabel} • ${parsed.date} • ${new Date().toISOString().slice(0, 16)} UTC`;
  const type   = side === 'yes' ? 'long' : side === 'no' ? 'short' : 'info';

  if (SIGNALS_HOOK) {
    await postWebhook(SIGNALS_HOOK, type, card, footer);
    log('Analysis posted to Discord');
  } else {
    log('WEATHER_DISCORD_SIGNALS_WEBHOOK not set — printing to stdout');
    console.log('\n' + card + '\n');
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const opts = parseArgs();

if (!opts.conditionId && !opts.url && !opts.question) {
  console.error('Usage: analyze.js --condition 0xABC | --url https://... | --question "Will NYC..."');
  process.exit(1);
}

analyze(opts).catch(err => {
  console.error('[weather-analyze] Error:', err.message);
  if (SIGNALS_HOOK) {
    postWebhook(SIGNALS_HOOK, 'error',
      `❌ **Weather analysis failed**\n${err.message}`,
      'Weather • Error'
    ).then(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
