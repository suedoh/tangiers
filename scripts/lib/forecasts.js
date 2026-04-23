'use strict';

/**
 * lib/forecasts.js — Unified weather forecast interface
 *
 * Sources (all free, no API key required unless noted):
 *   1. Open-Meteo ensemble API  — 31-member GFS ensemble → direct probability
 *   2. Open-Meteo forecast API  — ECMWF AIFS (AI) + IFS + ICON + GFS + HRRR (US)
 *   3. NWS API                  — US-only, official observations + forecasts
 *   4. NOAA GHCN-Daily CDO API  — station-matched TMAX/TMIN historical base rates
 *                                  (same source Polymarket uses for settlement)
 *                                  Requires NCEI_TOKEN env var (free: ncei.noaa.gov)
 *   5. Open-Meteo archive API   — fallback historical base rates (gridded ERA5)
 *
 * Model weighting (per research — AIFS beats IFS by 5–20% on 2m temp at medium range;
 * IFS retains edge at extremes — weights shift dynamically when threshold is in
 * the top/bottom 10% of historical distribution):
 *
 *   Normal regime:   AIFS 35% · IFS 25% · ICON 20% · GFS 15% · HRRR 5% (US)
 *   Extreme regime:  AIFS 20% · IFS 45% · ICON 20% · GFS 10% · HRRR 5% (US)
 *
 * Primary export:
 *   getForecast(lat, lon, targetDate, thresholdF, direction, opts)
 *     → { ensemble, models, historical, consensus, sources, extremeFlag }
 */

const https = require('https');

const ENSEMBLE_API  = 'ensemble-api.open-meteo.com';
const FORECAST_API  = 'api.open-meteo.com';
const ARCHIVE_API   = 'archive-api.open-meteo.com';
const NWS_API       = 'api.weather.gov';
const NCEI_API      = 'www.ncei.noaa.gov';

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
  // z = (mean - threshold) / sigma
  // P(temp > threshold) = P(Z > -z) = normalCDF(z)  [since z is mean-relative, not threshold-relative]
  // P(temp < threshold) = 1 - normalCDF(z)
  const z = (forecastTemp - thresholdF) / sigmaF;
  return direction === 'above' ? normalCDF(z) : 1 - normalCDF(z);
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
 * Normal-regime model weights (per WeatherBench 2 + ECMWF scorecards):
 *   AIFS leads IFS by 5–20% on 2m temp RMSE at medium range.
 *   HRRR is 3km US-only (hourly updates) — strong for 0–2 day short-range.
 */
const MODEL_WEIGHTS_NORMAL = {
  ecmwf_aifs025: 0.35,  // ECMWF AI model — best average skill
  ecmwf_ifs025:  0.25,  // ECMWF physics-based — best for extremes
  icon_global:   0.20,  // DWD ICON — strong in Europe, solid globally
  gfs_seamless:  0.15,  // NOAA GFS — reference model
  gfs_hrrr:      0.05,  // NOAA HRRR — US only, 3km, high value short-range
};

/**
 * Extreme-threshold weights: when market threshold is in top/bottom 10%
 * historically, IFS is upweighted because AI models underperform at tails
 * (Bonavita 2024 GRL; Ben-Bouallègue et al. 2024).
 */
const MODEL_WEIGHTS_EXTREME = {
  ecmwf_aifs025: 0.20,  // downweighted — AI struggles at distribution tails
  ecmwf_ifs025:  0.45,  // upweighted — physics-based better for extremes
  icon_global:   0.20,
  gfs_seamless:  0.10,
  gfs_hrrr:      0.05,
};

/**
 * Fetches ECMWF AIFS, ECMWF IFS, ICON, GFS, and HRRR (US) from Open-Meteo.
 * Converts each forecast to a threshold-crossing probability via Normal CDF.
 *
 * @param {boolean} extremeThreshold  Use extreme-event model weights
 */
async function fetchModels(lat, lon, targetDate, thresholdF, direction, extremeThreshold = false) {
  const field  = direction === 'below' ? 'temperature_2m_min' : 'temperature_2m_max';
  const models = ['ecmwf_aifs025', 'ecmwf_ifs025', 'icon_global', 'gfs_seamless', 'gfs_hrrr'];
  const sigma  = leadTimeSigma(targetDate);

  const path = `/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=${field}&temperature_unit=fahrenheit&timezone=auto` +
    `&start_date=${targetDate}&end_date=${targetDate}` +
    `&models=${models.join(',')}`;

  try {
    const data  = await httpGet(FORECAST_API, path);
    const daily = data.daily || {};

    const results  = {};
    const weights  = extremeThreshold ? MODEL_WEIGHTS_EXTREME : MODEL_WEIGHTS_NORMAL;

    for (const model of models) {
      const key = `${field}_${model}`;
      const val = (daily[key] || [])[0];
      if (val != null && !isNaN(val)) {
        results[model] = {
          forecast: val,
          prob:     thresholdProbability(val, thresholdF, sigma, direction),
          sigma,
          weight:   weights[model],
          ai:       model.includes('aifs'),
        };
      }
    }

    if (Object.keys(results).length === 0) return null;

    // Weighted consensus (normalise so missing models don't alter total)
    let totalWeight = 0, weightedProb = 0;
    for (const [model, mv] of Object.entries(results)) {
      const w = weights[model] || 0;
      weightedProb += mv.prob * w;
      totalWeight  += w;
    }

    return {
      models:        results,
      consensus:     totalWeight > 0 ? weightedProb / totalWeight : null,
      sigma,
      extremeMode:   extremeThreshold,
    };
  } catch {
    return null;
  }
}

// ─── 3. NOAA GHCN-Daily station-matched historical base rates ─────────────────

/**
 * Fetches daily TMAX or TMIN from NOAA's GHCN-Daily dataset via the CDO API.
 * This is the same underlying data source Polymarket uses for US market settlement,
 * making it a more faithful historical baseline than gridded ERA5.
 *
 * Requires NCEI_TOKEN env var (free: https://www.ncdc.noaa.gov/cdo-web/token).
 * Falls back to Open-Meteo archive silently if token is absent.
 *
 * @param {string} ghcnStation  e.g. 'USW00094728' (no 'GHCND:' prefix)
 * @param {string} targetDate   'YYYY-MM-DD'
 * @param {number} thresholdF
 * @param {'above'|'below'} direction
 */
async function fetchGHCNBaseRate(ghcnStation, targetDate, thresholdF, direction) {
  const token = process.env.NCEI_TOKEN;
  if (!token || !ghcnStation) return null;

  const [, mm, dd] = targetDate.split('-');
  const currentYear = new Date().getFullYear();
  const startYear   = currentYear - 12;   // 12 seasons for robust sample
  const endYear     = currentYear - 1;

  // NOAA CDO API: fetch 12 years of the exact calendar date
  // datatypeid: TMAX or TMIN (tenths of °C — divide by 10 to get °C, then convert to °F)
  const datatype = direction === 'below' ? 'TMIN' : 'TMAX';

  // Build date range requests year-by-year to avoid CDO 1-year result limit
  // CDO returns max ~1000 records; fetching month window around the date is safer
  const mmdd        = `${mm}-${dd}`;
  const startDate   = `${startYear}-${mm}-01`;
  const endDateReq  = `${endYear}-${mm}-${String(Math.min(parseInt(dd) + 4, 28)).padStart(2, '0')}`;

  const path = `/cdo-web/api/v2/data` +
    `?datasetid=GHCND&stationid=GHCND:${ghcnStation}` +
    `&datatypeid=${datatype}&units=standard` +
    `&startdate=${startDate}&enddate=${endDateReq}` +
    `&limit=1000`;

  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: NCEI_API,
        path,
        method:  'GET',
        headers: { 'token': token, 'User-Agent': 'Weathermen/1.0 (Tangiers)' },
      }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error(`NCEI JSON parse error`)); }
          } else {
            reject(new Error(`NCEI HTTP ${res.statusCode}`));
          }
        });
      });
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('NCEI timeout')); });
      req.on('error', reject);
      req.end();
    });

    const results = data.results || [];

    // Filter to entries matching this calendar day (allow ±1 day for leap years)
    const sameDayObs = results.filter(r => {
      const d = (r.date || '').slice(5, 10); // 'MM-DD'
      return d === mmdd;
    });

    if (sameDayObs.length < 3) return null;

    // GHCN TMAX/TMIN values are in tenths of °C → convert to °F
    const tempsF = sameDayObs
      .map(r => (r.value / 10) * 9 / 5 + 32)
      .filter(v => !isNaN(v) && v > -100 && v < 150);

    if (tempsF.length < 3) return null;

    const aboveCount = tempsF.filter(v =>
      direction === 'above' ? v > thresholdF : v < thresholdF
    ).length;

    const mean = tempsF.reduce((a, b) => a + b, 0) / tempsF.length;
    const sorted = [...tempsF].sort((a, b) => a - b);
    const thresholdPercentile = sorted.filter(v => v <= thresholdF).length / sorted.length;

    return {
      prob:                aboveCount / tempsF.length,
      sampleSize:          tempsF.length,
      historicalMean:      mean,
      thresholdPercentile, // 0–1: where the threshold sits in the historical distribution
      source:              'GHCN-Daily',
      station:             ghcnStation,
    };
  } catch {
    return null; // silently fall back to Open-Meteo archive
  }
}

// ─── 5. NWS official forecast (US only) ──────────────────────────────────────

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

// ─── 6. Historical base rates — Open-Meteo archive fallback (gridded ERA5) ────

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
 * Step 1: Fetch historical base rate first (GHCN preferred, archive fallback).
 *         Use thresholdPercentile to detect extreme thresholds.
 * Step 2: Fetch ensemble + deterministic models in parallel, with extreme-mode
 *         weights if the threshold sits in the top/bottom 10% historically.
 * Step 3: Build weighted consensus.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} targetDate     'YYYY-MM-DD'
 * @param {number} thresholdF     Temperature threshold in °F
 * @param {'above'|'below'} direction
 * @param {{ includeNWS?: boolean, ghcnStation?: string }} opts
 *   ghcnStation: GHCN station ID without 'GHCND:' prefix (e.g. 'USW00094728')
 * @returns {Promise<ForecastResult>}
 */
async function getForecast(lat, lon, targetDate, thresholdF, direction = 'above', opts = {}) {

  // ── Step 1: Get historical base rate to detect extreme threshold ───────────
  // Try GHCN-Daily (station-matched, same source as Polymarket settlement) first.
  // Fall back to Open-Meteo gridded archive if no token or station provided.
  let historical = null;
  if (opts.ghcnStation) {
    historical = await fetchGHCNBaseRate(opts.ghcnStation, targetDate, thresholdF, direction)
      .catch(() => null);
  }
  if (!historical) {
    historical = await fetchHistoricalBaseRate(lat, lon, targetDate, thresholdF, direction)
      .catch(() => null);
  }

  // Detect extreme threshold: top/bottom 10% of historical distribution.
  // When true, model weights shift to favour IFS over AI models (per Bonavita 2024 GRL).
  const threshPercentile = historical?.thresholdPercentile ?? null;
  const extremeThreshold = threshPercentile != null &&
    (threshPercentile >= 0.90 || threshPercentile <= 0.10);

  // ── Step 2: Fetch ensemble + deterministic + NWS in parallel ──────────────
  const [ensembleResult, modelsResult, nwsResult] = await Promise.allSettled([
    fetchEnsemble(lat, lon, targetDate, thresholdF, direction),
    fetchModels(lat, lon, targetDate, thresholdF, direction, extremeThreshold),
    opts.includeNWS !== false ? fetchNWS(lat, lon, targetDate) : Promise.resolve(null),
  ]);

  const ensemble = ensembleResult.status === 'fulfilled' ? ensembleResult.value : null;
  const models   = modelsResult.status   === 'fulfilled' ? modelsResult.value   : null;
  const nws      = nwsResult.status      === 'fulfilled' ? nwsResult.value      : null;

  // ── Step 3: Weighted consensus ─────────────────────────────────────────────
  // Component weights:
  //   Ensemble 40% (direct probability from 31 members — most reliable)
  //   Multi-model 35% (weighted deterministic consensus)
  //   Historical 25% (climatological prior — de-weighted when forecast available)
  const components = [];
  if (ensemble?.prob   != null) components.push({ prob: ensemble.prob,    weight: 0.40, source: 'GFS Ensemble' });
  if (models?.consensus != null) components.push({ prob: models.consensus, weight: 0.35, source: extremeThreshold ? 'Multi-Model (extreme mode)' : 'Multi-Model' });
  if (historical?.prob  != null) components.push({ prob: historical.prob,  weight: 0.25, source: historical.source === 'GHCN-Daily' ? `GHCN-Daily (${historical.sampleSize} seasons, station ${historical.station})` : `${historical.sampleSize}-yr ERA5 base rate` });

  let consensus = null;
  if (components.length > 0) {
    const totalW = components.reduce((a, c) => a + c.weight, 0);
    consensus = components.reduce((a, c) => a + c.prob * c.weight, 0) / totalW;
  }

  // Last resort: historical only (too far out for ensemble/models)
  if (consensus === null && historical?.prob != null) {
    consensus = historical.prob;
  }

  const sources = [];
  if (ensemble)   sources.push(`GFS Ensemble (${ensemble.memberCount} members)`);
  if (models) {
    const modelNames = Object.keys(models.models).map(m => ({
      ecmwf_aifs025: 'AIFS', ecmwf_ifs025: 'IFS', icon_global: 'ICON',
      gfs_seamless: 'GFS', gfs_hrrr: 'HRRR',
    }[m] || m)).join(' · ');
    sources.push(`${modelNames}${extremeThreshold ? ' [extreme weights]' : ''}`);
  }
  if (historical) sources.push(historical.source === 'GHCN-Daily' ? `GHCN-Daily station ${historical.station}` : `Open-Meteo ERA5 archive`);
  if (nws)        sources.push('NWS official forecast');

  return {
    ensemble,
    models,
    historical,
    nws,
    consensus,
    components,
    sources,
    extremeThreshold,
    thresholdPercentile: threshPercentile,
  };
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

/**
 * Get raw temperature mean and spread for a location/date without committing
 * to a specific threshold or direction. Useful for evaluating an entire event
 * group (multiple bucket markets sharing the same city+date).
 *
 * Returns:
 *   meanF   — ensemble mean temperature in °F (null if ensemble unavailable)
 *   sigmaF  — ensemble spread in °F, or leadTimeSigma fallback
 *   ensemble — raw ensemble result (may be null)
 *   models  — raw models result (may be null)
 *   sources — string array of active data sources
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} targetDate  'YYYY-MM-DD'
 * @returns {Promise<{ meanF: number|null, sigmaF: number, ensemble: object|null, models: object|null, sources: string[] }>}
 */
async function getTemperatureForecast(lat, lon, targetDate) {
  // Use a dummy threshold + direction just to trigger the API calls;
  // we only care about mean/spread, not a specific probability.
  const dummyThreshold  = 72;
  const dummyDirection  = 'above';

  const [ensembleRes, modelsRes] = await Promise.allSettled([
    fetchEnsemble(lat, lon, targetDate, dummyThreshold, dummyDirection),
    fetchModels(lat, lon, targetDate, dummyThreshold, dummyDirection, false),
  ]);

  const ensemble = ensembleRes.status === 'fulfilled' ? ensembleRes.value : null;
  const models   = modelsRes.status   === 'fulfilled' ? modelsRes.value   : null;

  // Mean: prefer ensemble mean (31 members), fall back to multi-model average
  let meanF = null;
  if (ensemble?.mean != null) {
    meanF = ensemble.mean;
  } else if (models?.models) {
    const vals = Object.values(models.models).map(mv => mv.forecast).filter(v => v != null);
    if (vals.length > 0) {
      meanF = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }

  // Sigma: use ensemble spread if available, else lead-time heuristic
  const sigmaF = (ensemble?.spread != null && ensemble.spread > 0)
    ? ensemble.spread
    : leadTimeSigma(targetDate);

  const sources = [];
  if (ensemble) sources.push(`GFS Ensemble (${ensemble.memberCount} members)`);
  if (models) {
    const modelNames = Object.keys(models.models).map(m => ({
      ecmwf_aifs025: 'AIFS', ecmwf_ifs025: 'IFS', icon_global: 'ICON',
      gfs_seamless: 'GFS', gfs_hrrr: 'HRRR',
    }[m] || m)).join(' · ');
    sources.push(modelNames);
  }

  return { meanF, sigmaF, ensemble, models, sources };
}

module.exports = { getForecast, getObserved, fetchNWS, normalCDF, thresholdProbability, getTemperatureForecast, leadTimeSigma };
