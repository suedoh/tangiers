#!/usr/bin/env node
'use strict';

/**
 * scripts/ew/weekly-outlook.js — Sunday 22:00 UTC weekly outlook
 *
 * Recaps the week's count evolution, posts a backtest scoreboard,
 * and lays out the week-ahead bias. Includes a count-evolution
 * screenshot strip (one per day, up to 7) plus the latest 4H.
 */

const fs   = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/env');
loadEnv();

const storage = require('./storage');
const { postWithFiles } = require('./discord-upload');
const shared  = require('./reports-shared');

const PRIMARY        = process.env.PRIMARY === 'true';
const REPORT_WEBHOOK = process.env.BTC_EW_REPORT_WEBHOOK;

if (!PRIMARY) { console.log('[ew/weekly-outlook] skipping: PRIMARY != true'); process.exit(0); }
if (!REPORT_WEBHOOK || REPORT_WEBHOOK.startsWith('PENDING')) {
  console.error('[ew/weekly-outlook] BTC_EW_REPORT_WEBHOOK not set'); process.exit(1);
}

(async () => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekly = storage.getForecastsBetween(weekAgo.toISOString(), now.toISOString())
    .filter(f => f.symbol === 'BINANCE:BTCUSDT.P' && !f.ambiguous);

  if (weekly.length === 0) {
    console.log('[ew/weekly-outlook] no forecasts in week — skipping');
    process.exit(0);
  }

  const current = weekly[weekly.length - 1];

  // Week-in-review: pick one forecast per UTC day (the NY-open or earliest of day)
  const byDay = {};
  for (const f of weekly) {
    const day = f.generatedAt.slice(0, 10);
    if (!byDay[day] || f.scheduleSlot === 'NY-open') byDay[day] = f;
  }
  const days = Object.keys(byDay).sort();

  const weekInReviewLines = days.map(d => {
    const f = byDay[d];
    const tf4h = f.timeframes?.['4H']?.primary;
    const wave = tf4h?.currentWave || '?';
    const dir  = tf4h?.direction || '';
    const conf = tf4h?.confidence != null ? tf4h.confidence.toFixed(2) : '—';
    const stab = f.timeframes?.['4H']?.stability || 'new';
    return `• **${d}** — 4H wave ${wave} ${dir} (conf ${conf}, ${stab})`;
  }).join('\n');

  // Count evolution narrative
  const firstWave = byDay[days[0]]?.timeframes?.['4H']?.primary?.currentWave || '?';
  const lastWave  = byDay[days[days.length - 1]]?.timeframes?.['4H']?.primary?.currentWave || '?';
  const flips     = days.filter(d => byDay[d].timeframes?.['4H']?.stability === 'flipped').length;
  const refines   = days.filter(d => byDay[d].timeframes?.['4H']?.stability === 'refined').length;
  const evolution = `4H Minor count moved from **${firstWave}** to **${lastWave}** over the week. ${flips} flip(s), ${refines} refinement(s).`;

  // Backtest scoreboard
  const bt = computeWeeklyScoreboard(weekly);
  const calibration = storage.getCalibration();
  const calibHealth = renderCalibHealth(calibration);

  // Render
  const slots = {
    date: now.toISOString().slice(0, 10),
    weekInReview:        weekInReviewLines,
    countEvolution:      evolution,
    backtestScoreboard:  bt.summary,
    hitRateByTf:         bt.byTf,
    meanTimeToOutcome:   bt.mean,
    calibrationHealth:   calibHealth,
    weekAheadBias:       shared.biasLine(current),
    keyLevels:           shared.keyLevelsBlock(current),
    upsideTargets:       shared.targetsBlock(current, 'up'),
    downsideTargets:     shared.targetsBlock(current, 'down'),
  };

  const description = shared.renderTemplate('weekly-outlook.tmpl', slots);

  const embeds = [{
    title: `BTC EW Weekly Outlook — week ending ${slots.date}`,
    description,
    color: 0x5865f2,
    timestamp: now.toISOString(),
    footer: { text: 'Ace EW · weekly outlook · Sunday 22:00 UTC · informational only' },
  }];

  // Screenshot strip: one 4H screenshot per day (up to 6) + latest 1D and 1H
  const files = [];
  const usedNames = new Set();
  for (const d of days.slice(-6)) {
    const f = byDay[d];
    const p = f.chartScreenshots?.['4H'];
    if (p && fs.existsSync(p)) {
      const name = path.basename(p);
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      files.push({ path: p, name });
      embeds.push({ title: `4H · ${d}`, color: 0x5865f2, image: { url: 'attachment://' + name } });
    }
  }
  // Add latest 1D + 1H for context
  for (const tf of ['1D', '1H']) {
    const p = current.chartScreenshots?.[tf];
    if (p && fs.existsSync(p)) {
      const name = path.basename(p);
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      files.push({ path: p, name });
      embeds.push({ title: `latest ${tf}`, color: 0x5865f2, image: { url: 'attachment://' + name } });
    }
  }

  // Discord caps embeds at 10 per message
  const finalEmbeds = embeds.slice(0, 10);

  await postWithFiles(REPORT_WEBHOOK, finalEmbeds, files.slice(0, 10), { username: 'Ace EW Reports' });

  storage.withState(s => { s.lastWeeklyOutlookAt = now.toISOString(); });

  console.log(`[ew/weekly-outlook] posted (${weekly.length} forecasts in week, ${files.length} screenshots)`);
})().catch(e => {
  console.error('[ew/weekly-outlook] fatal:', e);
  process.exit(2);
});

// ─── Stats helpers ───────────────────────────────────────────────────────────

function computeWeeklyScoreboard(forecasts) {
  let n = 0, hits = 0, invalidated = 0;
  const byTf = {};
  const durations = [];

  for (const f of forecasts) {
    for (const tf of ['1D', '4H', '1H']) {
      const tb = f.timeframes?.[tf];
      if (!tb || !tb.primary) continue;
      n++;
      byTf[tf] = byTf[tf] || { n: 0, hits: 0 };
      byTf[tf].n++;
      const o = f.outcomes?.[tf]?.primary || {};
      if (o.hit) {
        hits++;
        byTf[tf].hits++;
        if (o.hitAt) durations.push(new Date(o.hitAt) - new Date(f.generatedAt));
      } else if (o.invalidatedAt) {
        invalidated++;
      }
    }
  }
  const mean = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const fmtMs = ms => {
    if (ms == null) return '—';
    const m = Math.floor(ms / 60_000); const h = Math.floor(m / 60); const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m`;
  };
  return {
    summary: `Forecasts: **${forecasts.length}**   ·   targets hit: **${hits}**   ·   invalidated: **${invalidated}**`,
    byTf:    Object.entries(byTf).map(([k, v]) => `${k} ${v.n > 0 ? Math.round(v.hits / v.n * 100) : 0}% (${v.hits}/${v.n})`).join(' · '),
    mean:    fmtMs(mean),
  };
}

function renderCalibHealth(calibration) {
  if (!calibration || Object.keys(calibration).length === 0) return 'cold-start (insufficient data)';
  const flagged = [];
  for (const key of Object.keys(calibration)) {
    for (const bucket of ['50', '60', '70', '80', '90']) {
      const v = calibration[key]?.[bucket];
      if (!v || v.n < 5) continue;
      const realized = v.hits / v.n * 100;
      if (Math.abs(realized - parseInt(bucket)) > 15) {
        flagged.push(`${key}@${bucket}=${realized.toFixed(0)}%`);
      }
    }
  }
  if (flagged.length === 0) return 'within tolerance (no buckets diverge >15%)';
  return `**${flagged.length} bucket(s) flagged:** ${flagged.slice(0, 5).join(', ')}`;
}
