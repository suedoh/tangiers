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
 * Hour-based for fine-grained near-term accuracy: 0.8°F same-day → 5.5°F at 10d+.
 * Uses end-of-day UTC so same-day markets don't go negative.
 */
function leadTimeSigma(targetDate) {
  const endOfDay = new Date(targetDate + 'T23:59:59Z');
  const hoursOut = Math.max(0, (endOfDay - Date.now()) / 3_600_000);
  if (hoursOut <=   6) return 0.8;
  if (hoursOut <=  12) return 1.2;
  if (hoursOut <=  24) return 2.0;
  if (hoursOut <=  48) return 2.8;
  if (hoursOut <=  72) return 3.5;
  if (hoursOut <= 168) return 4.5;
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
      .filter(v => v != null && !isNaN(v) && v > -60 && v < 150);  // bounds-check: reject obviously corrupt members

    if (members.length < 5) return null; // not enough members

    const aboveCount = members.filter(v =>
      direction === 'above' ? v > thresholdF : v < thresholdF
    ).length;

    const prob = aboveCount / members.length;
    const mean = members.reduce((a, b) => a + b, 0) / members.length;
    // Use sample variance (n-1) so spread isn't systematically underestimated for small ensembles
    const variance = members.length > 1
      ? members.reduce((a, v) => a + (v - mean) ** 2, 0) / (members.length - 1)
      : 0;
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
  const datatype    = direction === 'below' ? 'TMIN' : 'TMAX';
  const mmdd        = `${mm}-${dd}`;

  // CDO API enforces a 1-year maximum date range per request.
  // Fetch each of the past 12 years individually in parallel, using a
  // ±5-day window around the target calendar date to guarantee a hit
  // even if the station missed the exact day (maintenance, QC flags).
  const years = [];
  for (let y = currentYear - 12; y <= currentYear - 1; y++) years.push(y);

  function nceiGet(startDate, endDate) {
    const path = `/cdo-web/api/v2/data` +
      `?datasetid=GHCND&stationid=GHCND:${ghcnStation}` +
      `&datatypeid=${datatype}&units=standard` +
      `&startdate=${startDate}&enddate=${endDate}&limit=31`;
    return new Promise((resolve, reject) => {
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
            catch { resolve(null); }
          } else {
            resolve(null); // non-fatal — skip this year
          }
        });
      });
      req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  try {
    // Build narrow window per year (±5 days, clamped to month boundaries)
    const ddInt      = parseInt(dd, 10);
    const lo         = String(Math.max(1, ddInt - 5)).padStart(2, '0');
    const hiRaw      = ddInt + 5;
    // Clamp to the actual last day of the target month so dates 29–31 don't lose
    // historical observations. new Date(y, m, 0) returns the last day of month m-1,
    // which equals the last day of parseInt(mm, 10) when month is 1-indexed.
    const daysInMonth = new Date(currentYear, parseInt(mm, 10), 0).getDate();
    const hi         = String(Math.min(daysInMonth, hiRaw)).padStart(2, '0');

    const yearRequests = years.map(y =>
      nceiGet(`${y}-${mm}-${lo}`, `${y}-${mm}-${hi}`)
    );
    const yearResults = await Promise.all(yearRequests);

    // Collect all observations matching the exact calendar date
    const allObs = yearResults.flatMap(data => (data?.results || []));
    const sameDayObs = allObs.filter(r => (r.date || '').slice(5, 10) === mmdd);

    if (sameDayObs.length < 3) return null;

    // values are already in °F because we request units=standard
    const tempsF = sameDayObs
      .map(r => r.value)
      .filter(v => v != null && !isNaN(v) && v > -60 && v < 150);

    if (tempsF.length < 3) return null;

    const aboveCount = tempsF.filter(v =>
      direction === 'above' ? v > thresholdF : v < thresholdF
    ).length;

    const mean = tempsF.reduce((a, b) => a + b, 0) / tempsF.length;
    const sorted = [...tempsF].sort((a, b) => a - b);
    const thresholdPercentile = sorted.filter(v => v <= thresholdF).length / sorted.length;

    const variance = tempsF.reduce((a, v) => a + (v - mean) ** 2, 0) / tempsF.length;
    const historicalSigma = Math.sqrt(variance);

    return {
      prob:                aboveCount / tempsF.length,
      sampleSize:          tempsF.length,
      historicalMean:      mean,
      historicalSigma,     // std dev of TMAX across same calendar date — use as sigma fallback
      thresholdPercentile, // 0–1: where the threshold sits in the historical distribution
      source:              'GHCN-Daily',
      station:             ghcnStation,
    };
  } catch {
    return null; // silently fall back to Open-Meteo archive
  }
}

/**
 * Fetch raw historical temperature statistics for a GHCN station/date,
 * without committing to a specific threshold.
 * Used by getTemperatureForecast() to calibrate sigma for bucket markets.
 *
 * @param {string} ghcnStation  e.g. 'USW00094728' (no 'GHCND:' prefix)
 * @param {string} targetDate   'YYYY-MM-DD'
 * @returns {Promise<{ mean: number, sigma: number, sampleSize: number, source: string, station: string } | null>}
 */
async function fetchGHCNStats(ghcnStation, targetDate) {
  // Use a mid-range dummy threshold that won't skew the fetch
  const result = await fetchGHCNBaseRate(ghcnStation, targetDate, 60, 'above').catch(() => null);
  if (!result) return null;
  return {
    mean:                result.historicalMean,
    sigma:               result.historicalSigma,
    sampleSize:          result.sampleSize,
    source:              result.source,
    station:             result.station,
    thresholdPercentile: result.thresholdPercentile,  // required for extreme-mode detection in getTemperatureForecast()
  };
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

// ─── Settlement observation helpers ───────────────────────────────────────────

/**
 * Convert a local calendar date to a UTC time range covering the full local day.
 * Uses simplified DST detection (April–October = DST for US cities).
 */
function localDayUtcRange(date, tz) {
  const DST = { 'America/New_York': 4, 'America/Chicago': 5, 'America/Denver': 6, 'America/Los_Angeles': 7, 'America/Phoenix': 7, 'America/Anchorage': 8, 'Pacific/Honolulu': 10 };
  const STD = { 'America/New_York': 5, 'America/Chicago': 6, 'America/Denver': 7, 'America/Los_Angeles': 8, 'America/Phoenix': 7, 'America/Anchorage': 9, 'Pacific/Honolulu': 10 };
  const [y, m, d] = date.split('-').map(Number);
  const hoursAhead = (m >= 4 && m <= 10 ? DST : STD)[tz] ?? 5;
  const startUTC = new Date(Date.UTC(y, m - 1, d, hoursAhead, 0, 0));
  const endUTC   = new Date(startUTC.getTime() + 24 * 3_600_000);
  return [
    startUTC.toISOString().slice(0, 19) + '+00:00',
    endUTC.toISOString().slice(0, 19) + '+00:00',
  ];
}

/**
 * Fetch actual observed TMAX/TMIN for a specific date from NOAA GHCN-Daily.
 * Primary settlement data source — same station network Polymarket uses for US markets.
 * Data is available 1–3 days after the observation date.
 *
 * @param {string} ghcnStation  e.g. 'USW00094728' (no 'GHCND:' prefix)
 * @param {string} date         'YYYY-MM-DD'
 * @returns {Promise<{tmax: number|null, tmin: number|null, source: string} | null>}
 */
async function fetchGHCNObserved(ghcnStation, date) {
  const token = process.env.NCEI_TOKEN;
  if (!token || !ghcnStation) return null;

  const path = `/cdo-web/api/v2/data` +
    `?datasetid=GHCND&stationid=GHCND:${ghcnStation}` +
    `&datatypeid=TMAX,TMIN&units=standard` +
    `&startdate=${date}&enddate=${date}&limit=10`;

  return new Promise(resolve => {
    const req = https.request({
      hostname: NCEI_API,
      path,
      method:  'GET',
      headers: { token, 'User-Agent': 'Weathermen/1.0 (Tangiers)' },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        try {
          const results = JSON.parse(raw).results || [];
          let tmax = null, tmin = null;
          for (const r of results) {
            if (r.datatype === 'TMAX' && r.value != null) tmax = r.value;
            if (r.datatype === 'TMIN' && r.value != null) tmin = r.value;
          }
          resolve((tmax != null || tmin != null) ? { tmax, tmin, source: `GHCN-Daily/${ghcnStation}` } : null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Fetch daily high/low from NWS hourly METAR observations.
 * Near-real-time (available within hours of observation). Returns temps in °F.
 *
 * @param {string} nwsStation  ICAO code e.g. 'KNYC'
 * @param {string} date        'YYYY-MM-DD' (local calendar date)
 * @param {string} timezone    IANA timezone e.g. 'America/New_York'
 * @returns {Promise<{high: number, low: number, obsCount: number, source: string} | null>}
 */
async function fetchNWSObserved(nwsStation, date, timezone = 'America/New_York') {
  if (!nwsStation) return null;
  const [startStr, endStr] = localDayUtcRange(date, timezone);
  const apiPath = `/stations/${nwsStation}/observations` +
    `?start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}`;
  try {
    const data   = await httpGet(NWS_API, apiPath, 15_000);
    const tempsC = (data?.features || [])
      .map(f => {
        const t = f?.properties?.temperature;
        if (t?.value == null || isNaN(t.value)) return null;
        // NWS always reports degC; skip if unexpected unit to avoid double-conversion
        if (t.unitCode && !t.unitCode.includes('degC')) return null;
        return t.value;
      })
      .filter(v => v != null && v > -60 && v < 60);
    if (tempsC.length < 3) return null;
    const tempsF = tempsC.map(c => c * 9 / 5 + 32);
    return {
      high:     Math.max(...tempsF),
      low:      Math.min(...tempsF),
      obsCount: tempsF.length,
      source:   `NWS METAR/${nwsStation}`,
    };
  } catch { return null; }
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
 *   meanF      — ensemble mean temperature in °F (null if ensemble unavailable)
 *   sigmaF     — sigma in °F: ensemble spread → GHCN historical σ → leadTimeSigma fallback
 *   ensemble   — raw ensemble result (may be null)
 *   models     — raw models result (may be null)
 *   historical — GHCN station stats (mean, sigma, sampleSize) — null if token/station absent
 *   sources    — string array of active data sources
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} targetDate  'YYYY-MM-DD'
 * @param {{ ghcnStation?: string }} opts
 *   ghcnStation: NOAA GHCN-Daily station ID (no 'GHCND:' prefix, e.g. 'USW00094728').
 *   When provided and NCEI_TOKEN is set, fetches 12-season historical sigma for this
 *   calendar date — more accurate than leadTimeSigma() heuristic for US cities.
 * @returns {Promise<{ meanF: number|null, sigmaF: number, ensemble: object|null, models: object|null, historical: object|null, sources: string[] }>}
 */
async function getTemperatureForecast(lat, lon, targetDate, opts = {}) {
  // Use a dummy threshold + direction just to trigger the API calls;
  // we only care about mean/spread, not a specific probability.
  const dummyThreshold  = 72;
  const dummyDirection  = 'above';

  const [ensembleRes, modelsRes, ghcnRes] = await Promise.allSettled([
    fetchEnsemble(lat, lon, targetDate, dummyThreshold, dummyDirection),
    fetchModels(lat, lon, targetDate, dummyThreshold, dummyDirection, false),
    opts.ghcnStation ? fetchGHCNStats(opts.ghcnStation, targetDate) : Promise.resolve(null),
  ]);

  const ensemble   = ensembleRes.status === 'fulfilled' ? ensembleRes.value : null;
  const models     = modelsRes.status   === 'fulfilled' ? modelsRes.value   : null;
  const historical = ghcnRes.status     === 'fulfilled' ? ghcnRes.value     : null;

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

  // Sigma: Bayesian combination when ensemble spread and GHCN historical σ are both
  // available and the two means agree (within 1 σ). Treats each as an independent
  // precision source: 1/σ² + 1/σ² → tighter posterior when sources converge.
  // When means diverge (outlier forecast), falls back to the wider σ to stay conservative.
  const sigEns  = ensemble?.spread  != null && ensemble.spread  > 0.5 ? ensemble.spread  : null;
  const sigHist = historical?.sigma != null && historical.sigma > 0.5 ? historical.sigma : null;

  let sigmaF;
  if (sigEns != null && sigHist != null) {
    const meanDiff    = meanF != null && historical.mean != null ? Math.abs(meanF - historical.mean) : Infinity;
    const sourcesAgree = meanDiff < Math.max(sigEns, sigHist);
    if (sourcesAgree) {
      sigmaF = 1 / Math.sqrt(1 / sigEns ** 2 + 1 / sigHist ** 2);
    } else {
      sigmaF = Math.max(sigEns, sigHist); // outlier forecast — don't narrow
    }
  } else if (sigEns  != null) {
    sigmaF = sigEns;
  } else if (sigHist != null) {
    sigmaF = sigHist;
  } else {
    sigmaF = leadTimeSigma(targetDate);
  }

  // Inter-model spread: max-min across the deterministic model forecasts.
  // High spread (>5°F) indicates models disagree on the atmospheric regime — a signal
  // to widen sigma or skip the trade. Returned for use by the scanner.
  let interModelSpread = null;
  if (models?.models) {
    const modelTemps = Object.values(models.models).map(mv => mv.forecast).filter(v => v != null);
    if (modelTemps.length >= 2) {
      interModelSpread = Math.max(...modelTemps) - Math.min(...modelTemps);
    }
  }

  const sources = [];
  if (ensemble) sources.push(`GFS Ensemble (${ensemble.memberCount} members)`);
  if (models) {
    const modelNames = Object.keys(models.models).map(m => ({
      ecmwf_aifs025: 'AIFS', ecmwf_ifs025: 'IFS', icon_global: 'ICON',
      gfs_seamless: 'GFS', gfs_hrrr: 'HRRR',
    }[m] || m)).join(' · ');
    sources.push(modelNames);
  }
  if (historical) sources.push(`GHCN-Daily station ${historical.station} (${historical.sampleSize} seasons)`);

  return { meanF, sigmaF, ensemble, models, historical, sources, interModelSpread };
}

module.exports = { getForecast, getObserved, fetchGHCNObserved, fetchNWSObserved, fetchNWS, normalCDF, thresholdProbability, getTemperatureForecast, fetchGHCNStats, leadTimeSigma };
