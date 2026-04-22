'use strict';

/**
 * lib/polymarket.js — Polymarket market discovery + price fetch + question parser
 *
 * Uses the public Gamma API (no authentication required for read operations).
 * Phase A: read-only. Phase B will add order execution via CLOB API.
 *
 * Key exports:
 *   fetchWeatherMarkets()        → array of parsed MarketInfo objects
 *   getMarketPrice(conditionId)  → { yes: number, no: number } (0–1)
 *   parseQuestion(question)      → { city, date, thresholdF, direction, type } | null
 *   cityCoords(cityName)         → { lat, lon, tz, nwsStation } | null
 */

const https = require('https');

const GAMMA_API = 'gamma-api.polymarket.com';
const CLOB_API  = 'clob.polymarket.com';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(hostname, path, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers: { 'User-Agent': 'Weathermen/1.0 (Tangiers)' } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error(`JSON parse (${res.statusCode}): ${raw.slice(0, 150)}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${hostname}${path.slice(0, 80)}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${hostname}`)); });
    req.on('error', reject);
    req.end();
  });
}

// ─── City coordinates + metadata ──────────────────────────────────────────────

/**
 * Common Polymarket weather market cities.
 * nwsStation:  nearest ASOS station used by NWS (for US cities).
 * ghcnStation: NOAA GHCN-Daily station ID (without 'GHCND:' prefix).
 *              This is the same underlying station data Polymarket uses to
 *              settle US temperature markets. Register for a free NCEI token
 *              at ncei.noaa.gov to enable station-matched historical base rates.
 * tz:          IANA timezone.
 */
const CITY_COORDS = {
  // United States
  'new york':       { lat: 40.7128,  lon: -74.0060,  tz: 'America/New_York',    nwsStation: 'KNYC', ghcnStation: 'USW00094728' }, // Central Park
  'nyc':            { lat: 40.7128,  lon: -74.0060,  tz: 'America/New_York',    nwsStation: 'KNYC', ghcnStation: 'USW00094728' },
  'new york city':  { lat: 40.7128,  lon: -74.0060,  tz: 'America/New_York',    nwsStation: 'KNYC', ghcnStation: 'USW00094728' },
  'los angeles':    { lat: 34.0522,  lon: -118.2437, tz: 'America/Los_Angeles', nwsStation: 'KLAX', ghcnStation: 'USW00023174' }, // LAX
  'la':             { lat: 34.0522,  lon: -118.2437, tz: 'America/Los_Angeles', nwsStation: 'KLAX', ghcnStation: 'USW00023174' },
  'chicago':        { lat: 41.8781,  lon: -87.6298,  tz: 'America/Chicago',     nwsStation: 'KORD', ghcnStation: 'USW00094846' }, // O'Hare
  'miami':          { lat: 25.7617,  lon: -80.1918,  tz: 'America/New_York',    nwsStation: 'KMIA', ghcnStation: 'USW00012839' },
  'phoenix':        { lat: 33.4484,  lon: -112.0740, tz: 'America/Phoenix',     nwsStation: 'KPHX', ghcnStation: 'USW00023183' },
  'las vegas':      { lat: 36.1699,  lon: -115.1398, tz: 'America/Los_Angeles', nwsStation: 'KLAS', ghcnStation: 'USW00023169' },
  'seattle':        { lat: 47.6062,  lon: -122.3321, tz: 'America/Los_Angeles', nwsStation: 'KSEA', ghcnStation: 'USW00024233' },
  'boston':         { lat: 42.3601,  lon: -71.0589,  tz: 'America/New_York',    nwsStation: 'KBOS', ghcnStation: 'USW00014739' },
  'atlanta':        { lat: 33.7490,  lon: -84.3880,  tz: 'America/New_York',    nwsStation: 'KATL', ghcnStation: 'USW00013874' },
  'houston':        { lat: 29.7604,  lon: -95.3698,  tz: 'America/Chicago',     nwsStation: 'KHOU', ghcnStation: 'USW00012918' }, // Hobby
  'dallas':         { lat: 32.7767,  lon: -96.7970,  tz: 'America/Chicago',     nwsStation: 'KDFW', ghcnStation: 'USW00003927' },
  'denver':         { lat: 39.7392,  lon: -104.9903, tz: 'America/Denver',      nwsStation: 'KDEN', ghcnStation: 'USW00003017' },
  'minneapolis':    { lat: 44.9778,  lon: -93.2650,  tz: 'America/Chicago',     nwsStation: 'KMSP', ghcnStation: 'USW00014922' },
  'washington':     { lat: 38.9072,  lon: -77.0369,  tz: 'America/New_York',    nwsStation: 'KDCA', ghcnStation: 'USW00013743' }, // Reagan
  'dc':             { lat: 38.9072,  lon: -77.0369,  tz: 'America/New_York',    nwsStation: 'KDCA', ghcnStation: 'USW00013743' },
  'san francisco':  { lat: 37.7749,  lon: -122.4194, tz: 'America/Los_Angeles', nwsStation: 'KSFO', ghcnStation: 'USW00023234' },
  'sf':             { lat: 37.7749,  lon: -122.4194, tz: 'America/Los_Angeles', nwsStation: 'KSFO', ghcnStation: 'USW00023234' },
  'new orleans':    { lat: 29.9511,  lon: -90.0715,  tz: 'America/Chicago',     nwsStation: 'KMSY', ghcnStation: 'USW00012916' },
  'detroit':        { lat: 42.3314,  lon: -83.0458,  tz: 'America/Detroit',     nwsStation: 'KDTW', ghcnStation: 'USW00094847' },
  'portland':       { lat: 45.5231,  lon: -122.6765, tz: 'America/Los_Angeles', nwsStation: 'KPDX', ghcnStation: 'USW00024229' },
  'nashville':      { lat: 36.1627,  lon: -86.7816,  tz: 'America/Chicago',     nwsStation: 'KBNA', ghcnStation: 'USW00013897' },
  'charlotte':      { lat: 35.2271,  lon: -80.8431,  tz: 'America/New_York',    nwsStation: 'KCLT', ghcnStation: 'USW00013881' },
  'tampa':          { lat: 27.9506,  lon: -82.4572,  tz: 'America/New_York',    nwsStation: 'KTPA', ghcnStation: 'USW00012842' },
  'orlando':        { lat: 28.5383,  lon: -81.3792,  tz: 'America/New_York',    nwsStation: 'KMCO', ghcnStation: 'USW00012815' },
  // International — GHCN IDs where available (no NWS/GHCN for non-US)
  'london':         { lat: 51.5074,  lon: -0.1278,   tz: 'Europe/London',       nwsStation: null, ghcnStation: null },
  'paris':          { lat: 48.8566,  lon: 2.3522,    tz: 'Europe/Paris',        nwsStation: null, ghcnStation: null },
  'tokyo':          { lat: 35.6762,  lon: 139.6503,  tz: 'Asia/Tokyo',          nwsStation: null, ghcnStation: null },
  'hong kong':      { lat: 22.3193,  lon: 114.1694,  tz: 'Asia/Hong_Kong',      nwsStation: null, ghcnStation: null },
  'sydney':         { lat: -33.8688, lon: 151.2093,  tz: 'Australia/Sydney',    nwsStation: null, ghcnStation: null },
  'dubai':          { lat: 25.2048,  lon: 55.2708,   tz: 'Asia/Dubai',          nwsStation: null, ghcnStation: null },
  'toronto':        { lat: 43.6532,  lon: -79.3832,  tz: 'America/Toronto',     nwsStation: null, ghcnStation: null },
  'chicago o\'hare': { lat: 41.9742, lon: -87.9073,  tz: 'America/Chicago',     nwsStation: 'KORD', ghcnStation: 'USW00094846' },
};

/**
 * Look up coordinates for a city name (case-insensitive, fuzzy prefix match).
 * @param {string} name
 * @returns {{ lat, lon, tz, nwsStation } | null}
 */
function cityCoords(name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  if (CITY_COORDS[key]) return CITY_COORDS[key];
  // Fuzzy: check if any known city starts with or contains the search term
  const match = Object.keys(CITY_COORDS).find(k => k.startsWith(key) || key.startsWith(k));
  return match ? CITY_COORDS[match] : null;
}

// ─── Question parser ──────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Parse a Polymarket weather question into structured fields.
 *
 * Handles patterns like:
 *   "Will the high temperature in New York City exceed 72°F on April 24?"
 *   "Will NYC reach 80°F on April 26?"
 *   "Will the low temperature in Chicago fall below 32°F on April 25?"
 *   "Will Los Angeles hit 90°F on May 1?"
 *
 * @param {string} question
 * @returns {{ city, date, thresholdF, direction, type } | null}
 */
function parseQuestion(question) {
  if (!question) return null;
  const q = question.trim();

  // ── Extract threshold temperature ────────────────────────────────────────
  const tempMatch = q.match(/(\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i);
  if (!tempMatch) return null;

  let thresholdF = parseFloat(tempMatch[1]);
  if (tempMatch[2].toUpperCase() === 'C') {
    thresholdF = thresholdF * 9 / 5 + 32; // Convert C→F
  }

  // ── Extract direction ────────────────────────────────────────────────────
  const aboveWords = /\b(exceed|above|over|reach|hit|top|surpass|at least)\b/i;
  const belowWords = /\b(fall below|drop below|below|under|at most)\b/i;
  const direction  = belowWords.test(q) ? 'below' : 'above';
  const type       = /\b(low|overnight|minimum|min)\b/i.test(q) ? 'low' : 'high';

  // ── Extract date ─────────────────────────────────────────────────────────
  // Patterns: "April 24", "Apr 24", "April 24, 2026", "on the 24th of April"
  const dateMatch = q.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i
  );

  let date = null;
  if (dateMatch) {
    const monthKey = dateMatch[1].toLowerCase();
    const mm = MONTH_MAP[monthKey];
    const dd = String(dateMatch[2]).padStart(2, '0');
    const yyyy = dateMatch[3] || new Date().getFullYear();
    date = `${yyyy}-${mm}-${dd}`;
  }

  if (!date) return null; // can't identify resolution date

  // ── Extract city name ────────────────────────────────────────────────────
  // Strategy: look for known city names in the question text
  let city = null;
  let coords = null;

  // Check all known cities (longest match first to prefer "New York City" over "New York")
  const cityKeys = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  for (const key of cityKeys) {
    if (q.toLowerCase().includes(key)) {
      city   = key;
      coords = CITY_COORDS[key];
      break;
    }
  }

  if (!city || !coords) return null;

  return { city, coords, date, thresholdF: Math.round(thresholdF * 10) / 10, direction, type };
}

// ─── Market fetching ──────────────────────────────────────────────────────────

/**
 * Fetch active weather/temperature binary markets from the Gamma API.
 * Filters to: active, not closed, binary (Yes/No), resolves in the future,
 * and has a parseable temperature question.
 *
 * @returns {Promise<MarketInfo[]>}
 */
async function fetchWeatherMarkets() {
  const queries = [
    '/markets?active=true&closed=false&limit=100&tag_slug=temperature',
    '/markets?active=true&closed=false&limit=100&tag_slug=weather',
  ];

  const seen    = new Set();
  const markets = [];

  for (const q of queries) {
    let raw;
    try { raw = await httpGet(GAMMA_API, q); }
    catch { continue; } // silently skip failed queries

    const list = Array.isArray(raw) ? raw : (raw.markets || raw.results || []);

    for (const m of list) {
      const conditionId = m.conditionId || m.condition_id;
      if (!conditionId || seen.has(conditionId)) continue;
      seen.add(conditionId);

      // Skip multi-outcome (neg_risk) markets — more complex, out of scope for Phase A
      if (m.negRisk || m.neg_risk) continue;

      // Parse outcomes + prices
      let outcomes, prices;
      try {
        outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
        prices   = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      } catch { continue; }

      // Must be binary (Yes / No)
      if (!Array.isArray(outcomes) || outcomes.length !== 2) continue;
      const yesIdx = outcomes.findIndex(o => /^yes$/i.test(String(o).trim()));
      const noIdx  = outcomes.findIndex(o => /^no$/i.test(String(o).trim()));
      if (yesIdx === -1 || noIdx === -1) continue;

      const yesPrice = parseFloat(prices?.[yesIdx]);
      const noPrice  = parseFloat(prices?.[noIdx]);
      if (isNaN(yesPrice) || isNaN(noPrice)) continue;
      if (yesPrice < 0.01 || yesPrice > 0.99) continue; // no liquidity at extremes

      // Must resolve in the future
      const endDate = m.endDate || m.end_date_iso || m.endDateIso;
      if (!endDate || new Date(endDate) <= new Date()) continue;

      const question = m.question || '';
      const parsed   = parseQuestion(question);
      if (!parsed) continue; // can't determine location/threshold

      const volume    = parseFloat(m.volume || 0);
      const liquidity = parseFloat(m.liquidity || 0);

      markets.push({
        conditionId,
        question,
        parsed,           // { city, coords, date, thresholdF, direction, type }
        yesPrice,
        noPrice,
        volume,
        liquidity,
        endDate,
        slug:   m.slug || m.market_slug || null,
        tokens: m.tokens || null,        // used by CLOB for execution in Phase B
      });
    }
  }

  return markets;
}

/**
 * Re-fetch the current YES price for a single market from the CLOB midbook.
 * Falls back to the Gamma outcomePrices if CLOB is unavailable.
 *
 * @param {string} conditionId
 * @returns {Promise<{ yes: number, no: number } | null>}
 */
async function getMarketPrice(conditionId) {
  try {
    const data = await httpGet(CLOB_API, `/markets/${conditionId}`);
    const tokens = data.tokens || [];
    const yes    = tokens.find(t => /^yes$/i.test(t.outcome));
    const no     = tokens.find(t => /^no$/i.test(t.outcome));
    if (!yes || !no) return null;

    // Get midpoint from orderbook
    const [yesBook, noBook] = await Promise.all([
      httpGet(CLOB_API, `/book?token_id=${yes.token_id}`).catch(() => null),
      httpGet(CLOB_API, `/book?token_id=${no.token_id}`).catch(() => null),
    ]);

    const mid = (book) => {
      if (!book) return null;
      const bestBid = parseFloat(book.bids?.[0]?.price ?? 0);
      const bestAsk = parseFloat(book.asks?.[0]?.price ?? 1);
      return (bestBid + bestAsk) / 2;
    };

    const yesMid = mid(yesBook);
    const noMid  = mid(noBook);
    if (yesMid == null || noMid == null) return null;

    return { yes: yesMid, no: noMid };
  } catch {
    return null;
  }
}

/**
 * Build the Polymarket market URL from a slug or conditionId.
 */
function marketUrl(market) {
  if (market.slug) return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/markets/${market.conditionId}`;
}

// ─── Kelly sizing ─────────────────────────────────────────────────────────────

/**
 * Calculate fractional Kelly position size for a binary prediction market.
 *
 * For a YES bet at price p where our model says true probability is q:
 *   edge      = q - p
 *   kelly_pct = edge / (1 - p)   ← fraction of bankroll
 *
 * @param {number} modelProb   Our estimated true probability (0–1)
 * @param {number} marketPrice Market-implied probability (0–1)
 * @param {'yes'|'no'} side
 * @param {number} bankroll    In USD
 * @param {number} kellyFrac   Fractional Kelly multiplier (default 0.15)
 * @param {number} maxBet      Hard cap in USD (default 100)
 * @returns {{ kelly, fractional, dollars, side, edge }}
 */
function kellySizing(modelProb, marketPrice, side, bankroll = 500, kellyFrac = 0.15, maxBet = 100) {
  const p = side === 'yes' ? marketPrice : 1 - marketPrice;
  const q = side === 'yes' ? modelProb   : 1 - modelProb;

  const edge  = q - p;
  const kelly = edge > 0 ? edge / (1 - p) : 0;
  const frac  = kelly * kellyFrac;
  const dollars = Math.min(frac * bankroll, maxBet);

  return {
    kelly:      Math.round(kelly * 1000) / 10,   // percent
    fractional: Math.round(frac * 1000) / 10,    // percent
    dollars:    Math.round(dollars * 100) / 100,
    side,
    edge:       Math.round(edge * 1000) / 10,    // percent
  };
}

module.exports = {
  fetchWeatherMarkets,
  getMarketPrice,
  parseQuestion,
  cityCoords,
  kellySizing,
  marketUrl,
  CITY_COORDS,
};
