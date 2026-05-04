#!/usr/bin/env node
'use strict';

/**
 * scripts/ew/daily-brief.js — institutional morning brief
 *
 * Cron: 12:15 UTC (~5 min after the NY-open run + backtest cycle).
 * Reads the most recent scheduled forecast, renders the daily-brief
 * template, posts to #btc-ew-report with the latest 1D/4H/1H screenshots.
 */

const fs   = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/env');
loadEnv();

const storage = require('./storage');
const { postWithFiles, postEmbedsOnly } = require('./discord-upload');
const shared  = require('./reports-shared');

const PRIMARY_DISABLED = process.env.PRIMARY === 'false';
const REPORT_WEBHOOK   = process.env.BTC_EW_REPORT_WEBHOOK;

if (PRIMARY_DISABLED) { console.log('[ew/daily-brief] skipping: PRIMARY=false'); process.exit(0); }
if (!REPORT_WEBHOOK || REPORT_WEBHOOK.startsWith('PENDING')) {
  console.error('[ew/daily-brief] BTC_EW_REPORT_WEBHOOK not set'); process.exit(1);
}

(async () => {
  const now = new Date();

  // Most recent scheduled forecast (prefer NY-open slot if one exists today)
  const forecasts = storage.loadForecasts();
  const today = now.toISOString().slice(0, 10);
  let current = null;
  for (let i = forecasts.length - 1; i >= 0; i--) {
    const f = forecasts[i];
    if (f.symbol !== 'BINANCE:BTCUSDT.P') continue;
    if (f.generatedAt.slice(0, 10) !== today) break;
    if (f.scheduleSlot === 'NY-open') { current = f; break; }
    if (!current) current = f;
  }
  if (!current) {
    console.log('[ew/daily-brief] no forecast today — skipping');
    process.exit(0);
  }

  // Previous brief's reference forecast (yesterday's NY-open or last available)
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let previous = null;
  for (let i = forecasts.length - 1; i >= 0; i--) {
    const f = forecasts[i];
    if (f.symbol !== 'BINANCE:BTCUSDT.P') continue;
    if (f._id === current._id) continue;
    if (f.generatedAt.slice(0, 10) === yesterday) { previous = f; break; }
  }

  // Render
  const slots = {
    date:        today,
    source:      `forecast ${current._id.slice(0, 8)} (${current.scheduleSlot || 'on-demand'})`,
    forecastId:  current._id,
    biasLine:    shared.biasLine(current),
    degree1D:    current.timeframes?.['1D']?.degree || 'Intermediate',
    degree4H:    current.timeframes?.['4H']?.degree || 'Minor',
    degree1H:    current.timeframes?.['1H']?.degree || 'Minute',
    wave1D:      current.timeframes?.['1D']?.primary?.currentWave || 'unclear',
    wave4H:      current.timeframes?.['4H']?.primary?.currentWave || 'unclear',
    wave1H:      current.timeframes?.['1H']?.primary?.currentWave || 'unclear',
    count1DBlock: shared.countBlock(current.timeframes?.['1D']),
    count4HBlock: shared.countBlock(current.timeframes?.['4H']),
    count1HBlock: shared.countBlock(current.timeframes?.['1H']),
    keyLevels:    shared.keyLevelsBlock(current),
    upsideTargets:   shared.targetsBlock(current, 'up'),
    downsideTargets: shared.targetsBlock(current, 'down'),
    whatChanged:  shared.whatChangedBlock(current, previous),
    outlook:      shared.outlookBlock(current),
  };

  const description = shared.renderTemplate('daily-brief.tmpl', slots);

  const embeds = [{
    title: `BTC EW Daily Brief — ${today}`,
    description,
    color: current.confluenceFlag === 'aligned-bullish' ? 0x57f287
         : current.confluenceFlag === 'aligned-bearish' ? 0xed4245
         : 0xfee75c,
    timestamp: now.toISOString(),
    footer: { text: 'Ace EW · daily brief · 12:15 UTC · informational only' },
  }];

  // Attach screenshots from the current forecast
  const files = [];
  const shotMap = {};
  for (const tf of ['1D', '4H', '1H']) {
    const p = current.chartScreenshots?.[tf];
    if (p && fs.existsSync(p)) {
      const name = path.basename(p);
      files.push({ path: p, name });
      shotMap[tf] = name;
    }
  }
  if (shotMap['4H']) embeds[0].image = { url: 'attachment://' + shotMap['4H'] };
  for (const tf of ['1D', '1H']) {
    if (shotMap[tf]) embeds.push({
      title: `${tf} pane`, color: embeds[0].color,
      image: { url: 'attachment://' + shotMap[tf] },
    });
  }

  await postWithFiles(REPORT_WEBHOOK, embeds, files, { username: 'Ace EW Reports' });

  storage.withState(s => { s.lastDailyBriefAt = now.toISOString(); });

  console.log(`[ew/daily-brief] posted brief for ${today} (forecast ${current._id})`);
})().catch(e => {
  console.error('[ew/daily-brief] fatal:', e);
  process.exit(2);
});
