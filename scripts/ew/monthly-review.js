#!/usr/bin/env node
'use strict';

/**
 * scripts/ew/monthly-review.js — 1st of month, 14:00 UTC
 *
 * Macro-degree review covering the past 30 days. Forward outlook for
 * the coming month. Includes ~4 screenshots showing the month's structural
 * arc.
 */

const fs   = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/env');
loadEnv();

const storage = require('./storage');
const { postWithFiles } = require('./discord-upload');
const shared  = require('./reports-shared');

const PRIMARY_DISABLED = process.env.PRIMARY === 'false';
const REPORT_WEBHOOK   = process.env.BTC_EW_REPORT_WEBHOOK;

if (PRIMARY_DISABLED) { console.log('[ew/monthly-review] skipping: PRIMARY=false'); process.exit(0); }
if (!REPORT_WEBHOOK || REPORT_WEBHOOK.startsWith('PENDING')) {
  console.error('[ew/monthly-review] BTC_EW_REPORT_WEBHOOK not set'); process.exit(1);
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

(async () => {
  const now = new Date();
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),     1));
  const monthLabel     = `${MONTHS[lastMonthStart.getUTCMonth()]} ${lastMonthStart.getUTCFullYear()}`;
  const nextMonthLabel = `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;

  const monthForecasts = storage.getForecastsBetween(lastMonthStart.toISOString(), thisMonthStart.toISOString())
    .filter(f => f.symbol === 'BINANCE:BTCUSDT.P' && !f.ambiguous);

  if (monthForecasts.length === 0) {
    console.log(`[ew/monthly-review] no forecasts in ${monthLabel} — skipping`);
    process.exit(0);
  }

  const first = monthForecasts[0];
  const last  = monthForecasts[monthForecasts.length - 1];
  const current = storage.getLatestForecast(f => f.symbol === 'BINANCE:BTCUSDT.P' && !f.ambiguous) || last;

  // Monthly arc
  const arc1D = `1D Intermediate count moved from **${first.timeframes?.['1D']?.primary?.currentWave || '?'}** ` +
                `(${first.timeframes?.['1D']?.primary?.direction || ''}) ` +
                `to **${last.timeframes?.['1D']?.primary?.currentWave || '?'}** ` +
                `(${last.timeframes?.['1D']?.primary?.direction || ''}).`;

  // Cycle commentary — heuristic: if the 1D count progressed one or more wave positions,
  // that hints at Primary-degree progress; if it flipped multiple times, structure is unclear.
  const dailyFlips = monthForecasts.filter((_, i) => {
    if (i === 0) return false;
    const prev = monthForecasts[i - 1];
    const curr = monthForecasts[i];
    return prev.timeframes?.['1D']?.primary?.direction !== curr.timeframes?.['1D']?.primary?.direction;
  }).length;
  const cycleNote = dailyFlips <= 1
    ? 'Daily structure progressed cleanly — Primary-degree count appears to be unfolding without major reinterpretation.'
    : `Daily count flipped ${dailyFlips} times — Primary-degree structure remains contested. Treat all forward forecasts with elevated caution.`;

  // Backtest health
  const bt = computeMonthlyHealth(monthForecasts);
  const calibTable = renderCalibrationTable(storage.getCalibration());

  // Forward outlook
  const outlook = shared.outlookBlock(current);

  const slots = {
    monthLabel,
    nextMonthLabel,
    monthlyArc:       arc1D,
    cycleDegree:      cycleNote,
    backtestHealth:   bt.summary,
    forecastsGenerated: String(monthForecasts.length),
    hitRate:          bt.hitRate,
    calibrationTable: calibTable,
    forwardOutlook:   outlook,
    keyLevels:        shared.keyLevelsBlock(current),
  };

  const description = shared.renderTemplate('monthly-review.tmpl', slots);

  const embeds = [{
    title: `BTC EW Monthly Cycle Review — ${monthLabel}`,
    description,
    color: 0xeb459e,
    timestamp: now.toISOString(),
    footer: { text: 'Ace EW · monthly review · 1st of month 14:00 UTC · informational only' },
  }];

  // ~4 screenshots: weekly markers (every 7 days)
  const files = [];
  const usedNames = new Set();
  const stride = Math.max(1, Math.floor(monthForecasts.length / 4));
  for (let i = 0; i < monthForecasts.length; i += stride) {
    const f = monthForecasts[i];
    const p = f.chartScreenshots?.['1D'] || f.chartScreenshots?.['4H'];
    if (p && fs.existsSync(p)) {
      const name = path.basename(p);
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      files.push({ path: p, name });
      embeds.push({
        title: `${f.generatedAt.slice(0, 10)}`,
        color: 0xeb459e,
        image: { url: 'attachment://' + name },
      });
    }
    if (files.length >= 4) break;
  }
  if (embeds[0]) {
    const main = embeds.slice(1).find(e => e.image);
    if (main) embeds[0].image = main.image;
  }

  await postWithFiles(REPORT_WEBHOOK, embeds.slice(0, 10), files.slice(0, 10), { username: 'Ace EW Reports' });

  storage.withState(s => { s.lastMonthlyReviewAt = now.toISOString(); });

  console.log(`[ew/monthly-review] posted for ${monthLabel} (${monthForecasts.length} forecasts)`);
})().catch(e => {
  console.error('[ew/monthly-review] fatal:', e);
  process.exit(2);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeMonthlyHealth(forecasts) {
  let n = 0, hits = 0;
  for (const f of forecasts) {
    for (const tf of ['1D', '4H', '1H']) {
      const tb = f.timeframes?.[tf];
      if (!tb || !tb.primary) continue;
      n++;
      if (f.outcomes?.[tf]?.primary?.hit) hits++;
    }
  }
  return {
    summary: `Forecasts evaluated: ${n}   ·   primary-count hit rate: ${n ? Math.round(hits / n * 100) : 0}%`,
    hitRate: n ? `${Math.round(hits / n * 100)}% (${hits}/${n})` : '—',
  };
}

function renderCalibrationTable(calibration) {
  if (!calibration || Object.keys(calibration).length === 0) return '_cold start — insufficient data_';
  const lines = [];
  for (const key of Object.keys(calibration).sort()) {
    const buckets = calibration[key];
    const cells = ['50', '60', '70', '80', '90'].map(b => {
      const v = buckets[b];
      if (!v || v.n === 0) return `${b}: —`;
      return `${b}: ${(v.hits / v.n * 100).toFixed(0)}%`;
    });
    lines.push(`• ${key}: ${cells.join(' · ')}`);
  }
  return lines.join('\n');
}
