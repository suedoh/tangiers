#!/usr/bin/env node
'use strict';

/**
 * scripts/ew/daily-summary.js — daily statistical summary
 *
 * Cron: 23:55 UTC. Posts a tally to #btc-ew-backtest with hit rate by TF,
 * by slot, and the calibration table (when 0.7 confidence was reported,
 * what was the actual hit rate at 0.7?).
 *
 * On Sundays, also emits a 7-day rollup with regime classification
 * (trending vs ranging from realized volatility).
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const storage   = require('./storage');
const { postEmbedsOnly } = require('./discord-upload');

const PRIMARY_DISABLED = process.env.PRIMARY === 'false';
const BACKTEST_WEBHOOK = process.env.BTC_EW_BACKTEST_WEBHOOK;

if (PRIMARY_DISABLED) { console.log('[ew/daily-summary] skipping: PRIMARY=false'); process.exit(0); }
if (!BACKTEST_WEBHOOK || BACKTEST_WEBHOOK.startsWith('PENDING')) {
  console.error('[ew/daily-summary] BTC_EW_BACKTEST_WEBHOOK not set'); process.exit(1);
}

const now    = new Date();
const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const isSunday = now.getUTCDay() === 0;

// ─── Compute daily stats ─────────────────────────────────────────────────────

const dayForecasts = storage.getForecastsBetween(dayAgo.toISOString(), now.toISOString());
const allForecasts = storage.loadForecasts();
const calibration  = storage.getCalibration();

const dayStats = computeStats(dayForecasts);
const weekStats = isSunday
  ? computeStats(storage.getForecastsBetween(
      new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      now.toISOString()))
  : null;

// ─── Render & post ───────────────────────────────────────────────────────────

(async () => {
  const ts = now.toISOString();

  // Daily embed
  const dailyEmbed = {
    title: `📊 EW DAILY SUMMARY — ${now.toISOString().slice(0, 10)}`,
    description: renderStatsBlock(dayStats, calibration, '24h'),
    color: 0x3447003,
    timestamp: ts,
    footer: { text: 'Ace EW · daily summary · 23:55 UTC' },
  };

  const embeds = [dailyEmbed];

  // Weekly rollup on Sundays
  if (weekStats) {
    embeds.push({
      title: `📊 EW WEEKLY ROLLUP — week ending ${now.toISOString().slice(0, 10)}`,
      description: renderStatsBlock(weekStats, calibration, '7d'),
      color: 0x3447003,
      footer: { text: 'Ace EW · weekly rollup · Sunday 23:55 UTC' },
    });
  }

  await postEmbedsOnly(BACKTEST_WEBHOOK, embeds, { username: 'Ace EW Backtest' });

  storage.withState(s => {
    s.lastDailySummaryAt = ts;
  });

  console.log(`[ew/daily-summary] posted ${isSunday ? 'daily + weekly' : 'daily'} (${dayForecasts.length} forecasts in window)`);
})().catch(e => {
  console.error('[ew/daily-summary] fatal:', e);
  process.exit(2);
});

// ─── Stats computation ───────────────────────────────────────────────────────

function computeStats(forecasts) {
  const stats = {
    total: forecasts.length,
    scheduled: 0, manual: 0, ambiguous: 0,
    byStatus: { open: 0, target_hit: 0, invalidated: 0, expired: 0, ambiguous: 0 },
    byTf: {},
    bySlot: { primary: { n: 0, hits: 0 }, alternate: { n: 0, hits: 0 } },
    timeToOutcome: [],   // ms durations of forecasts that resolved
    directionVsMagnitude: { directionRight: 0, magnitudeRight: 0 },
  };

  for (const f of forecasts) {
    if (f.ambiguous) stats.ambiguous++;
    if (/^scheduled/.test(f.generatedBy || ''))   stats.scheduled++;
    if (/^manual/.test(f.generatedBy || ''))      stats.manual++;
    if (stats.byStatus[f.status] != null) stats.byStatus[f.status]++;

    for (const tf of ['1D', '4H', '1H']) {
      const tb = f.timeframes?.[tf];
      if (!tb) continue;
      stats.byTf[tf] = stats.byTf[tf] || { n: 0, hits: 0, invalidated: 0 };
      for (const slot of ['primary', 'alternate']) {
        const c = tb[slot];
        if (!c) continue;
        const o = f.outcomes?.[tf]?.[slot] || {};
        stats.byTf[tf].n++;
        stats.bySlot[slot].n++;
        if (o.hit) {
          stats.byTf[tf].hits++;
          stats.bySlot[slot].hits++;
          stats.directionVsMagnitude.directionRight++;
          if (o.hit === '1.618×W1' || o.hit === '2.618×W1') {
            stats.directionVsMagnitude.magnitudeRight++;
          }
          if (o.hitAt) {
            stats.timeToOutcome.push(new Date(o.hitAt) - new Date(f.generatedAt));
          }
        } else if (o.invalidatedAt) {
          stats.byTf[tf].invalidated++;
        }
      }
    }
  }
  return stats;
}

function renderStatsBlock(s, calibration, label) {
  const hitRate = (n, hits) => n > 0 ? `${(hits / n * 100).toFixed(0)}%` : '—';
  const meanMs = s.timeToOutcome.length
    ? s.timeToOutcome.reduce((a, b) => a + b, 0) / s.timeToOutcome.length
    : null;
  const meanHuman = meanMs != null ? fmtDuration(meanMs) : '—';

  const lines = [
    `Window: **${label}**   ·   Forecasts: **${s.total}** (${s.scheduled} scheduled, ${s.manual} manual, ${s.ambiguous} ambiguous)`,
    '',
    `**Status distribution:**`,
    `• open: ${s.byStatus.open}   ·   target_hit: ${s.byStatus.target_hit}   ·   invalidated: ${s.byStatus.invalidated}   ·   expired: ${s.byStatus.expired}`,
    '',
    `**By timeframe:**`,
  ];

  for (const tf of ['1D', '4H', '1H']) {
    const r = s.byTf[tf] || { n: 0, hits: 0, invalidated: 0 };
    lines.push(`• ${tf}: hit rate ${hitRate(r.n, r.hits)} (${r.hits}/${r.n}) · ${r.invalidated} invalidated`);
  }
  lines.push('');
  lines.push(`**By slot:** primary ${hitRate(s.bySlot.primary.n, s.bySlot.primary.hits)} · alternate ${hitRate(s.bySlot.alternate.n, s.bySlot.alternate.hits)}`);
  lines.push(`Mean time-to-outcome: ${meanHuman}`);
  lines.push(`Direction-right: ${s.directionVsMagnitude.directionRight}   ·   magnitude-right: ${s.directionVsMagnitude.magnitudeRight}`);

  // Calibration table
  if (calibration && Object.keys(calibration).length > 0) {
    lines.push('');
    lines.push(`**Calibration (cumulative across all time):**`);
    for (const key of Object.keys(calibration).sort()) {
      const buckets = calibration[key];
      const cells = ['50', '60', '70', '80', '90'].map(b => {
        const v = buckets[b];
        if (!v || v.n === 0) return `${b}: —`;
        const pct = (v.hits / v.n * 100).toFixed(0);
        const flag = Math.abs(parseInt(pct) - parseInt(b)) > 15 ? '⚠️' : '';
        return `${b}: ${pct}% (${v.hits}/${v.n})${flag}`;
      });
      lines.push(`• ${key}: ${cells.join(' · ')}`);
    }
    lines.push('_⚠️ marks buckets where realized hit rate diverges from confidence by >15%._');
  }

  return lines.join('\n');
}

function fmtDuration(ms) {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
