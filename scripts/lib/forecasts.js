'use strict';

/**
 * lib/forecasts.js — Unified weather forecast interface
 *
 * Sources (all free, no API key required unless noted):
 *   1. Open-Meteo ensemble API  — 31-member GFS ensemble → direct probability
 *   2. Open-Meteo forecast API  — ECMWF IFS + ICON + GFS deterministic models
 *   3. NWS API                  — US-only, official observations + forecasts
 *   4. Open-Meteo archive API   — 10-year historical base rates for same calendar date
 *
 * Primary export:
 *   getForecast(lat, lon, targetDate, thresholdF, direction, opts)
 *     → { ensemble, models, historical, consensus, sources }
 */

const https = require('https');

const ENSEMBLE_API  = 'ensemble-api.open-meteo.com';
const FORECAST_API  = 'api.open-meteo.com';
const ARCHIVE_API   = 'archive-api.open-meteo.com';
const NWS_API       = 'api.weather.gov';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(hostname, path, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { 'User-Agent': 'Weathermen/1.0 (Tangiers)' } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error(`JSON parse error (${res.statusCode}): ${raw.slice(0, 200)}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${hostname}${path.slice(0, 80)}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${hostname}`)); });
    req.on('error', reject);
    req.end();
  });
}

// ─── Normal CDF (Abramowitz & Stegun approximation) ──────────────────────────

function normalCDF(z) {
  const t = 1 / (1 + 0.2315419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

/**
 * P(temp > threshold) using Normal CDF given forecast temp and uncertainty σ.
 * direction: 'above' → P(X > threshold); 'below' → P(X < threshold)
 */
function thresholdProbability(forecastTemp, thresholdF, sigmaF, direction) {
  const z = (forecastTemp - thresholdF) / sigmaF;
  return direction === 'above' ? 1 - normalCDF(z) : normalCDF(z);
}

/**
 * Estimate forecast uncertainty (σ in °F) based on lead time.
 * Short-range: ~2°F, medium: ~3.5°F, long: ~5°F
 */
function leadTimeSigma(targetDate) {
  const daysOut = Math.max(0, (new Date(targetDate) - Date.now()) / 86_400_000);
  if (daysOut <= 1)  return 2.0;
  if (daysOut <= 3)  return 3.0;
  if (daysOut <= 7)  return 4.0;
  return 5.5;
}

// ─── 1. GFS 31-member ensemble ────────────────────────────────────────────────

/**
 * Returns P(daily_max > thresholdF) from the 31-member GFS ensemble.
 * Falls back gracefully if the date is beyond the ~16-day window.
 */
async function fetchEnsemble(lat, lon, targetDate, thresholdF, direction) {
  const field = direction === 'below' ? 'temperature_2m_min' : 'temperature_2m_max';
  const path = `/v1/ensemble?latitude=${lat}&longitude=${lon}` +
    `&daily=${field}&temperature_unit=fahrenheit&timezone=auto` +
    `&start_date=${targetDate}&end_date=${targetDate}&models=gfs_seamless`;

  try {
    const data = await httpGet(ENSEMBLE_API, path);
    const daily = data.daily || {};

    // Collect all member values for the target date (index 0 since range is 1 day)
    const members = Object.keys(daily)
      .filter(k => k.startsWith(field + '_member'))
      .map(k => daily[k][0])
      .filter(v => v != null && !isNaN(v));

    if (members.length < 5) return null; // not enough members

    const aboveCount = members.filter(v =>
      direction === 'above' ? v > thresholdF : v < thresholdF
    ).length;

    const prob = aboveCount / members.length;
    const mean = members.reduce((a, b) => a + b, 0) / members.length;
    const variance = members.reduce((a, v) => a + (v - mean) ** 2, 0) / members.length;
    const spread = Math.sqrt(variance);

    return { prob, memberCount: members.length, mean, spread };
  } catch (err) {
    return null; // ensemble not available (too far out, or API error)
  }
}

// ─── 2. Multi-model deterministic forecasts ───────────────────────────────────

/**
 * Fetches ECMWF IFS, ICON, and GFS deterministic forecasts from Open-Meteo.
 * Converts each to a probability using Normal CDF + lead-time σ.
 */
async function fetchModels(lat, lon, targetDate, thresholdF, direction) {
  const field = direction === 'below' ? 'temperature_2m_min' : 'temperature_2m_max';
  const models = ['ecmwf_ifs025', 'icon_global', 'gfs_seamless'];
  const sigma  = leadTimeSigma(targetDate);

  const path = `/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=${field}&temperature_unit=fahrenheit&timezone=auto` +
    `&start_date=${targetDate}&end_date=${targetDate}` +
    `&models=${models.join(',')}`;

  try {
    const data = await httpGet(FORECAST_API, path);
    const daily = data.daily || {};

    const results = {};
    for (const model of models) {
      // Multi-model response uses field names like temperature_2m_max_ecmwf_ifs025
      // or just temperature_2m_max when a single model is queried
      const key = `${field}_${model}`;
      const val = (daily[key] || daily[field] || [])[0];
      if (val != null && !isNaN(val)) {
        results[model] = {
          forecast: val,
          prob: thresholdProbability(val, thresholdF, sigma, direction),
          sigma,
        };
      }
    }

    if (Object.keys(results).length === 0) return null;

    // Weighted consensus: ECMWF 40%, ICON 30%, GFS 30%
    const weights = { ecmwf_ifs025: 0.40, icon_global: 0.30, gfs_seamless: 0.30 };
    let totalWeight = 0, weightedProb = 0;
    for (const [model, w] of Object.entries(weights)) {
      if (results[model]) {
        weightedProb  += results[model].prob * w;
        totalWeight   += w;
      }
    }

    return {
      models: results,
      consensus: totalWeight > 0 ? weightedProb / totalWeight : null,
      sigma,
    };
  } catch (err) {
    return null;
  }
}

// ─── 3. NWS official forecast (US only) ──────────────────────────────────────

/**
 * Fetches the NWS grid forecast for a US lat/lon.
 * Returns the high/low temperature for the target date.
 */
async function fetchNWS(lat, lon, targetDate) {
  try {
    // Step 1: resolve grid point
    const point = await httpGet(NWS_API, `/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
    const forecastUrl = point?.properties?.forecast;
    if (!forecastUrl) return null;

    const urlObj = new URL(forecastUrl);
    const forecast = await httpGet(NWS_API, urlObj.pathname + urlObj.search);
    const periods  = forecast?.properties?.periods || [];

    // Find the period matching targetDate
    const target = new Date(targetDate + 'T12:00:00');
    const targetStr = targetDate; // 'YYYY-MM-DD'

    const matching = periods.filter(p => {
      const start = new Date(p.startTime);
      return start.toISOString().startsWith(targetStr);
    });

    if (matching.length === 0) return null;

    const daytime  = matching.find(p => p.isDaytime);
    const nighttime = matching.find(p => !p.isDaytime);

    return {
      high: daytime?.temperature   ?? null,
      low:  nighttime?.temperature ?? null,
      unit: daytime?.temperatureUnit ?? 'F',
      daytimeName: daytime?.name,
    };
  } catch {
    return null;
  }
}

// ─── 4. Historical base rates (Open-Meteo archive, past 10 years) ─────────────

/**
 * Fetches the past 10 years of same-calendar-date temps and calculates
 * the historical probability that the threshold was exceeded.
 */
async function fetchHistoricalBaseRate(lat, lon, targetDate, thresholdF, direction) {
  const [, mm, dd] = targetDate.split('-');
  const field = direction === 'below' ? 'temperature_2m_min' : 'temperature_2m_max';

  const years = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 10; y < currentYear; y++) years.push(y);

  // Fetch all years in one call using a date range per year is expensive;
  // instead batch by fetching the same date across multiple years via archive.
  // Open-Meteo archive supports multi-year queries with start/end date.
  const startYear = currentYear - 10;
  const endYear   = currentYear - 1;

  const path = `/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&daily=${field}&temperature_unit=fahrenheit&timezone=auto` +
    `&start_date=${startYear}-01-01&end_date=${endYear}-12-31`;

  try {
    const data = await httpGet(ARCHIVE_API, path, 20_000);
    const dates  = data.daily?.time  || [];
    const values = data.daily?.[field] || [];

    // Find entries matching this month/day
    const sameDayValues = dates
      .map((d, i) => ({ d, v: values[i] }))
      .filter(({ d }) => d.slice(5) === `${mm}-${dd}`)
      .map(({ v }) => v)
      .filter(v => v != null && !isNaN(v));

    if (sameDayValues.length < 3) return null;

    const aboveCount = sameDayValues.filter(v =>
      direction === 'above' ? v > thresholdF : v < thresholdF
    ).length;

    const prob = aboveCount / sameDayValues.length;
    const mean = sameDayValues.reduce((a, b) => a + b, 0) / sameDayValues.length;

    return { prob, sampleSize: sameDayValues.length, historicalMean: mean };
  } catch {
    return null;
  }
}

// ─── Master forecast function ─────────────────────────────────────────────────

/**
 * Get a full multi-source probability estimate for a temperature threshold market.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} targetDate   'YYYY-MM-DD'
 * @param {number} thresholdF   Temperature threshold in °F
 * @param {'above'|'below'} direction
 * @param {{ includeNWS?: boolean }} opts
 * @returns {Promise<ForecastResult>}
 */
async function getForecast(lat, lon, targetDate, thresholdF, direction = 'above', opts = {}) {
  const [ensembleResult, modelsResult, historicalResult, nwsResult] = await Promise.allSettled([
    fetchEnsemble(lat, lon, targetDate, thresholdF, direction),
    fetchModels(lat, lon, targetDate, thresholdF, direction),
    fetchHistoricalBaseRate(lat, lon, targetDate, thresholdF, direction),
    opts.includeNWS !== false ? fetchNWS(lat, lon, targetDate) : Promise.resolve(null),
  ]);

  const ensemble   = ensembleResult.status   === 'fulfilled' ? ensembleResult.value   : null;
  const models     = modelsResult.status     === 'fulfilled' ? modelsResult.value     : null;
  const historical = historicalResult.status === 'fulfilled' ? historicalResult.value : null;
  const nws        = nwsResult.status        === 'fulfilled' ? nwsResult.value        : null;

  // ── Compute consensus probability ─────────────────────────────────────────
  // Weights: ensemble 40% (most reliable), models 35%, historical 25%
  // Historical is de-weighted when ensemble/models are available.
  const components = [];

  if (ensemble?.prob != null)   components.push({ prob: ensemble.prob,   weight: 0.40, source: 'GFS Ensemble' });
  if (models?.consensus != null) components.push({ prob: models.consensus, weight: 0.35, source: 'Multi-Model' });
  if (historical?.prob != null) components.push({ prob: historical.prob,  weight: 0.25, source: 'Historical' });

  let consensus = null;
  if (components.length > 0) {
    const totalW = components.reduce((a, c) => a + c.weight, 0);
    consensus = components.reduce((a, c) => a + c.prob * c.weight, 0) / totalW;
  }

  // If only historical available (e.g., too far out), use it directly
  if (consensus === null && historical?.prob != null) {
    consensus = historical.prob;
  }

  const sources = [];
  if (ensemble)   sources.push(`GFS Ensemble (${ensemble.memberCount} members)`);
  if (models)     sources.push('ECMWF IFS · ICON · GFS deterministic');
  if (historical) sources.push(`${historical.sampleSize}-yr historical base rate`);
  if (nws)        sources.push('NWS official forecast');

  return { ensemble, models, historical, nws, consensus, components, sources };
}

/**
 * Fetch the actual observed temperature for a past date (for outcome resolution).
 * @param {number} lat
 * @param {number} lon
 * @param {string} date  'YYYY-MM-DD'
 * @param {'above'|'below'} direction
 * @returns {Promise<{high: number|null, low: number|null}>}
 */
async function getObserved(lat, lon, date, direction = 'above') {
  const field = direction === 'below' ? 'temperature_2m_min' : 'temperature_2m_max';
  const path = `/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&daily=${field}&temperature_unit=fahrenheit&timezone=auto` +
    `&start_date=${date}&end_date=${date}`;

  try {
    const data = await httpGet(ARCHIVE_API, path);
    const val = (data.daily?.[field] || [])[0];
    return { value: val ?? null, field };
  } catch {
    return { value: null, field };
  }
}

module.exports = { getForecast, getObserved, fetchNWS, normalCDF, thresholdProbability };
