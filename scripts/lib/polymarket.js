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

// ─── City coordinates + metadata (legacy — used by parseQuestion fallback) ────

/**
 * Common Polymarket weather market cities.
 * nwsStation:  nearest ASOS station used by NWS (for US cities).
 * ghcnStation: NOAA GHCN-Daily station ID (without 'GHCND:' prefix).
 * tz:          IANA timezone.
 */
const CITY_COORDS = {
  // United States
  'new york':       { lat: 40.7128,  lon: -74.0060,  tz: 'America/New_York',    nwsStation: 'KNYC', ghcnStation: 'USW00094728' },
  'nyc':            { lat: 40.7128,  lon: -74.0060,  tz: 'America/New_York',    nwsStation: 'KNYC', ghcnStation: 'USW00094728' },
  'new york city':  { lat: 40.7128,  lon: -74.0060,  tz: 'America/New_York',    nwsStation: 'KNYC', ghcnStation: 'USW00094728' },
  'los angeles':    { lat: 34.0522,  lon: -118.2437, tz: 'America/Los_Angeles', nwsStation: 'KLAX', ghcnStation: 'USW00023174' },
  'la':             { lat: 34.0522,  lon: -118.2437, tz: 'America/Los_Angeles', nwsStation: 'KLAX', ghcnStation: 'USW00023174' },
  'chicago':        { lat: 41.8781,  lon: -87.6298,  tz: 'America/Chicago',     nwsStation: 'KORD', ghcnStation: 'USW00094846' },
  'miami':          { lat: 25.7617,  lon: -80.1918,  tz: 'America/New_York',    nwsStation: 'KMIA', ghcnStation: 'USW00012839' },
  'phoenix':        { lat: 33.4484,  lon: -112.0740, tz: 'America/Phoenix',     nwsStation: 'KPHX', ghcnStation: 'USW00023183' },
  'las vegas':      { lat: 36.1699,  lon: -115.1398, tz: 'America/Los_Angeles', nwsStation: 'KLAS', ghcnStation: 'USW00023169' },
  'seattle':        { lat: 47.6062,  lon: -122.3321, tz: 'America/Los_Angeles', nwsStation: 'KSEA', ghcnStation: 'USW00024233' },
  'boston':         { lat: 42.3601,  lon: -71.0589,  tz: 'America/New_York',    nwsStation: 'KBOS', ghcnStation: 'USW00014739' },
  'atlanta':        { lat: 33.7490,  lon: -84.3880,  tz: 'America/New_York',    nwsStation: 'KATL', ghcnStation: 'USW00013874' },
  'houston':        { lat: 29.7604,  lon: -95.3698,  tz: 'America/Chicago',     nwsStation: 'KHOU', ghcnStation: 'USW00012918' },
  'dallas':         { lat: 32.7767,  lon: -96.7970,  tz: 'America/Chicago',     nwsStation: 'KDFW', ghcnStation: 'USW00003927' },
  'denver':         { lat: 39.7392,  lon: -104.9903, tz: 'America/Denver',      nwsStation: 'KDEN', ghcnStation: 'USW00003017' },
  'minneapolis':    { lat: 44.9778,  lon: -93.2650,  tz: 'America/Chicago',     nwsStation: 'KMSP', ghcnStation: 'USW00014922' },
  'washington':     { lat: 38.9072,  lon: -77.0369,  tz: 'America/New_York',    nwsStation: 'KDCA', ghcnStation: 'USW00013743' },
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
  'austin':         { lat: 30.2672,  lon: -97.7431,  tz: 'America/Chicago',     nwsStation: 'KAUS', ghcnStation: 'USW00013904' },
  // International
  'london':         { lat: 51.5074,  lon: -0.1278,   tz: 'Europe/London',       nwsStation: null, ghcnStation: null },
  'paris':          { lat: 48.8566,  lon: 2.3522,    tz: 'Europe/Paris',        nwsStation: null, ghcnStation: null },
  'tokyo':          { lat: 35.6762,  lon: 139.6503,  tz: 'Asia/Tokyo',          nwsStation: null, ghcnStation: null },
  'hong kong':      { lat: 22.3193,  lon: 114.1694,  tz: 'Asia/Hong_Kong',      nwsStation: null, ghcnStation: null },
  'sydney':         { lat: -33.8688, lon: 151.2093,  tz: 'Australia/Sydney',    nwsStation: null, ghcnStation: null },
  'dubai':          { lat: 25.2048,  lon: 55.2708,   tz: 'Asia/Dubai',          nwsStation: null, ghcnStation: null },
  'toronto':        { lat: 43.6532,  lon: -79.3832,  tz: 'America/Toronto',     nwsStation: null, ghcnStation: null },
  'seoul':          { lat: 37.5665,  lon: 126.9780,  tz: 'Asia/Seoul',          nwsStation: null, ghcnStation: null },
  'madrid':         { lat: 40.4168,  lon: -3.7038,   tz: 'Europe/Madrid',       nwsStation: null, ghcnStation: null },
  'munich':         { lat: 48.1351,  lon: 11.5820,   tz: 'Europe/Berlin',       nwsStation: null, ghcnStation: null },
  'milan':          { lat: 45.4654,  lon: 9.1859,    tz: 'Europe/Rome',         nwsStation: null, ghcnStation: null },
  'amsterdam':      { lat: 52.3676,  lon: 4.9041,    tz: 'Europe/Amsterdam',    nwsStation: null, ghcnStation: null },
  'warsaw':         { lat: 52.2297,  lon: 21.0122,   tz: 'Europe/Warsaw',       nwsStation: null, ghcnStation: null },
  'helsinki':       { lat: 60.1699,  lon: 24.9384,   tz: 'Europe/Helsinki',     nwsStation: null, ghcnStation: null },
  'istanbul':       { lat: 41.0082,  lon: 28.9784,   tz: 'Europe/Istanbul',     nwsStation: null, ghcnStation: null },
  'moscow':         { lat: 55.7558,  lon: 37.6173,   tz: 'Europe/Moscow',       nwsStation: null, ghcnStation: null },
  'ankara':         { lat: 39.9334,  lon: 32.8597,   tz: 'Europe/Istanbul',     nwsStation: null, ghcnStation: null },
  'singapore':      { lat: 1.3521,   lon: 103.8198,  tz: 'Asia/Singapore',      nwsStation: null, ghcnStation: null },
  'jakarta':        { lat: -6.2088,  lon: 106.8456,  tz: 'Asia/Jakarta',        nwsStation: null, ghcnStation: null },
  'manila':         { lat: 14.5995,  lon: 120.9842,  tz: 'Asia/Manila',         nwsStation: null, ghcnStation: null },
  'kuala lumpur':   { lat: 3.1390,   lon: 101.6869,  tz: 'Asia/Kuala_Lumpur',   nwsStation: null, ghcnStation: null },
  'shanghai':       { lat: 31.2304,  lon: 121.4737,  tz: 'Asia/Shanghai',       nwsStation: null, ghcnStation: null },
  'beijing':        { lat: 39.9042,  lon: 116.4074,  tz: 'Asia/Shanghai',       nwsStation: null, ghcnStation: null },
  'taipei':         { lat: 25.0330,  lon: 121.5654,  tz: 'Asia/Taipei',         nwsStation: null, ghcnStation: null },
  'busan':          { lat: 35.1796,  lon: 129.0756,  tz: 'Asia/Seoul',          nwsStation: null, ghcnStation: null },
  'guangzhou':      { lat: 23.1291,  lon: 113.2644,  tz: 'Asia/Shanghai',       nwsStation: null, ghcnStation: null },
  'chengdu':        { lat: 30.5728,  lon: 104.0668,  tz: 'Asia/Shanghai',       nwsStation: null, ghcnStation: null },
  'wuhan':          { lat: 30.5928,  lon: 114.3055,  tz: 'Asia/Shanghai',       nwsStation: null, ghcnStation: null },
  'hong-kong':      { lat: 22.3193,  lon: 114.1694,  tz: 'Asia/Hong_Kong',      nwsStation: null, ghcnStation: null },
  'jeddah':         { lat: 21.4858,  lon: 39.1925,   tz: 'Asia/Riyadh',         nwsStation: null, ghcnStation: null },
  'karachi':        { lat: 24.8607,  lon: 67.0011,   tz: 'Asia/Karachi',        nwsStation: null, ghcnStation: null },
  'lucknow':        { lat: 26.8467,  lon: 80.9462,   tz: 'Asia/Kolkata',        nwsStation: null, ghcnStation: null },
  'wellington':     { lat: -41.2866, lon: 174.7756,  tz: 'Pacific/Auckland',    nwsStation: null, ghcnStation: null },
  'mexico city':    { lat: 19.4326,  lon: -99.1332,  tz: 'America/Mexico_City', nwsStation: null, ghcnStation: null },
  'buenos aires':   { lat: -34.6037, lon: -58.3816,  tz: 'America/Argentina/Buenos_Aires', nwsStation: null, ghcnStation: null },
  'sao paulo':      { lat: -23.5505, lon: -46.6333,  tz: 'America/Sao_Paulo',   nwsStation: null, ghcnStation: null },
  'cape town':      { lat: -33.9249, lon: 18.4241,   tz: 'Africa/Johannesburg', nwsStation: null, ghcnStation: null },
  'lagos':          { lat: 6.5244,   lon: 3.3792,    tz: 'Africa/Lagos',        nwsStation: null, ghcnStation: null },
  'chicago o\'hare': { lat: 41.9742, lon: -87.9073,  tz: 'America/Chicago',     nwsStation: 'KORD', ghcnStation: 'USW00094846' },
};

// ─── City slug map (Polymarket event slug → metadata) ─────────────────────────

/**
 * Maps Polymarket event slug city name → coordinates + metadata.
 * unit: 'F' (North America) or 'C' (rest of world).
 * Slug names match the city portion of event slugs like:
 *   highest-temperature-in-{slug}-on-{month}-{day}-{year}
 */
const CITY_SLUGS = {
  'nyc':            { lat: 40.7128,  lon: -74.0060,  tz: 'America/New_York',    unit: 'F', nwsStation: 'KNYC', ghcnStation: 'USW00094728' },
  'los-angeles':    { lat: 34.0522,  lon: -118.2437, tz: 'America/Los_Angeles', unit: 'F', nwsStation: 'KLAX', ghcnStation: 'USW00023174' },
  'chicago':        { lat: 41.8781,  lon: -87.6298,  tz: 'America/Chicago',     unit: 'F', nwsStation: 'KORD', ghcnStation: 'USW00094846' },
  'miami':          { lat: 25.7617,  lon: -80.1918,  tz: 'America/New_York',    unit: 'F', nwsStation: 'KMIA', ghcnStation: 'USW00012839' },
  'phoenix':        { lat: 33.4484,  lon: -112.0740, tz: 'America/Phoenix',     unit: 'F', nwsStation: 'KPHX', ghcnStation: 'USW00023183' },
  'seattle':        { lat: 47.6062,  lon: -122.3321, tz: 'America/Los_Angeles', unit: 'F', nwsStation: 'KSEA', ghcnStation: 'USW00024233' },
  'boston':         { lat: 42.3601,  lon: -71.0589,  tz: 'America/New_York',    unit: 'F', nwsStation: 'KBOS', ghcnStation: 'USW00014739' },
  'atlanta':        { lat: 33.7490,  lon: -84.3880,  tz: 'America/New_York',    unit: 'F', nwsStation: 'KATL', ghcnStation: 'USW00013874' },
  'houston':        { lat: 29.7604,  lon: -95.3698,  tz: 'America/Chicago',     unit: 'F', nwsStation: 'KHOU', ghcnStation: 'USW00012918' },
  'dallas':         { lat: 32.7767,  lon: -96.7970,  tz: 'America/Chicago',     unit: 'F', nwsStation: 'KDFW', ghcnStation: 'USW00003927' },
  'denver':         { lat: 39.7392,  lon: -104.9903, tz: 'America/Denver',      unit: 'F', nwsStation: 'KDEN', ghcnStation: 'USW00003017' },
  'san-francisco':  { lat: 37.7749,  lon: -122.4194, tz: 'America/Los_Angeles', unit: 'F', nwsStation: 'KSFO', ghcnStation: 'USW00023234' },
  'austin':         { lat: 30.2672,  lon: -97.7431,  tz: 'America/Chicago',     unit: 'F', nwsStation: 'KAUS', ghcnStation: 'USW00013904' },
  'nashville':      { lat: 36.1627,  lon: -86.7816,  tz: 'America/Chicago',     unit: 'F', nwsStation: 'KBNA', ghcnStation: 'USW00013897' },
  'charlotte':      { lat: 35.2271,  lon: -80.8431,  tz: 'America/New_York',    unit: 'F', nwsStation: 'KCLT', ghcnStation: 'USW00013881' },
  'tampa':          { lat: 27.9506,  lon: -82.4572,  tz: 'America/New_York',    unit: 'F', nwsStation: 'KTPA', ghcnStation: 'USW00012842' },
  'toronto':        { lat: 43.6532,  lon: -79.3832,  tz: 'America/Toronto',     unit: 'C', nwsStation: null, ghcnStation: null },
  'london':         { lat: 51.5074,  lon: -0.1278,   tz: 'Europe/London',       unit: 'C', nwsStation: null, ghcnStation: null },
  'paris':          { lat: 48.8566,  lon: 2.3522,    tz: 'Europe/Paris',        unit: 'C', nwsStation: null, ghcnStation: null },
  'madrid':         { lat: 40.4168,  lon: -3.7038,   tz: 'Europe/Madrid',       unit: 'C', nwsStation: null, ghcnStation: null },
  'munich':         { lat: 48.1351,  lon: 11.5820,   tz: 'Europe/Berlin',       unit: 'C', nwsStation: null, ghcnStation: null },
  'milan':          { lat: 45.4654,  lon: 9.1859,    tz: 'Europe/Rome',         unit: 'C', nwsStation: null, ghcnStation: null },
  'amsterdam':      { lat: 52.3676,  lon: 4.9041,    tz: 'Europe/Amsterdam',    unit: 'C', nwsStation: null, ghcnStation: null },
  'warsaw':         { lat: 52.2297,  lon: 21.0122,   tz: 'Europe/Warsaw',       unit: 'C', nwsStation: null, ghcnStation: null },
  'helsinki':       { lat: 60.1699,  lon: 24.9384,   tz: 'Europe/Helsinki',     unit: 'C', nwsStation: null, ghcnStation: null },
  'istanbul':       { lat: 41.0082,  lon: 28.9784,   tz: 'Europe/Istanbul',     unit: 'C', nwsStation: null, ghcnStation: null },
  'moscow':         { lat: 55.7558,  lon: 37.6173,   tz: 'Europe/Moscow',       unit: 'C', nwsStation: null, ghcnStation: null },
  'ankara':         { lat: 39.9334,  lon: 32.8597,   tz: 'Europe/Istanbul',     unit: 'C', nwsStation: null, ghcnStation: null },
  'seoul':          { lat: 37.5665,  lon: 126.9780,  tz: 'Asia/Seoul',          unit: 'C', nwsStation: null, ghcnStation: null },
  'tokyo':          { lat: 35.6762,  lon: 139.6503,  tz: 'Asia/Tokyo',          unit: 'C', nwsStation: null, ghcnStation: null },
  'hong-kong':      { lat: 22.3193,  lon: 114.1694,  tz: 'Asia/Hong_Kong',      unit: 'C', nwsStation: null, ghcnStation: null },
  'shanghai':       { lat: 31.2304,  lon: 121.4737,  tz: 'Asia/Shanghai',       unit: 'C', nwsStation: null, ghcnStation: null },
  'beijing':        { lat: 39.9042,  lon: 116.4074,  tz: 'Asia/Shanghai',       unit: 'C', nwsStation: null, ghcnStation: null },
  'singapore':      { lat: 1.3521,   lon: 103.8198,  tz: 'Asia/Singapore',      unit: 'C', nwsStation: null, ghcnStation: null },
  'taipei':         { lat: 25.0330,  lon: 121.5654,  tz: 'Asia/Taipei',         unit: 'C', nwsStation: null, ghcnStation: null },
  'jakarta':        { lat: -6.2088,  lon: 106.8456,  tz: 'Asia/Jakarta',        unit: 'C', nwsStation: null, ghcnStation: null },
  'manila':         { lat: 14.5995,  lon: 120.9842,  tz: 'Asia/Manila',         unit: 'C', nwsStation: null, ghcnStation: null },
  'busan':          { lat: 35.1796,  lon: 129.0756,  tz: 'Asia/Seoul',          unit: 'C', nwsStation: null, ghcnStation: null },
  'kuala-lumpur':   { lat: 3.1390,   lon: 101.6869,  tz: 'Asia/Kuala_Lumpur',   unit: 'C', nwsStation: null, ghcnStation: null },
  'guangzhou':      { lat: 23.1291,  lon: 113.2644,  tz: 'Asia/Shanghai',       unit: 'C', nwsStation: null, ghcnStation: null },
  'chengdu':        { lat: 30.5728,  lon: 104.0668,  tz: 'Asia/Shanghai',       unit: 'C', nwsStation: null, ghcnStation: null },
  'wuhan':          { lat: 30.5928,  lon: 114.3055,  tz: 'Asia/Shanghai',       unit: 'C', nwsStation: null, ghcnStation: null },
  'dubai':          { lat: 25.2048,  lon: 55.2708,   tz: 'Asia/Dubai',          unit: 'C', nwsStation: null, ghcnStation: null },
  'jeddah':         { lat: 21.4858,  lon: 39.1925,   tz: 'Asia/Riyadh',         unit: 'C', nwsStation: null, ghcnStation: null },
  'karachi':        { lat: 24.8607,  lon: 67.0011,   tz: 'Asia/Karachi',        unit: 'C', nwsStation: null, ghcnStation: null },
  'lucknow':        { lat: 26.8467,  lon: 80.9462,   tz: 'Asia/Kolkata',        unit: 'C', nwsStation: null, ghcnStation: null },
  'sydney':         { lat: -33.8688, lon: 151.2093,  tz: 'Australia/Sydney',    unit: 'C', nwsStation: null, ghcnStation: null },
  'wellington':     { lat: -41.2866, lon: 174.7756,  tz: 'Pacific/Auckland',    unit: 'C', nwsStation: null, ghcnStation: null },
  'mexico-city':    { lat: 19.4326,  lon: -99.1332,  tz: 'America/Mexico_City', unit: 'C', nwsStation: null, ghcnStation: null },
  'buenos-aires':   { lat: -34.6037, lon: -58.3816,  tz: 'America/Argentina/Buenos_Aires', unit: 'C', nwsStation: null, ghcnStation: null },
  'sao-paulo':      { lat: -23.5505, lon: -46.6333,  tz: 'America/Sao_Paulo',   unit: 'C', nwsStation: null, ghcnStation: null },
  'cape-town':      { lat: -33.9249, lon: 18.4241,   tz: 'Africa/Johannesburg', unit: 'C', nwsStation: null, ghcnStation: null },
  'lagos':          { lat: 6.5244,   lon: 3.3792,    tz: 'Africa/Lagos',        unit: 'C', nwsStation: null, ghcnStation: null },
};

// Slug → question-text city name mapping (for question parser augmentation)
const SLUG_TO_CITY_NAME = {
  'nyc':           'new york city',
  'los-angeles':   'los angeles',
  'san-francisco': 'san francisco',
  'hong-kong':     'hong kong',
  'kuala-lumpur':  'kuala lumpur',
  'buenos-aires':  'buenos aires',
  'sao-paulo':     'sao paulo',
  'cape-town':     'cape town',
  'mexico-city':   'mexico city',
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
 * Handles the new bucket format:
 *   "Will the highest temperature in New York City be 66°F or higher on April 24?"
 *   "Will the highest temperature in New York City be 60-61°F on April 24?"
 *   "Will the highest temperature in New York City be 47°F or below on April 24?"
 *   "Will the highest temperature in Seoul be 14°C or higher on April 24?"
 *   "Will the highest temperature in Seoul be between 10-11°C on April 24?"
 *
 * Also handles legacy format:
 *   "Will the high temperature in New York City exceed 72°F on April 24?"
 *   "Will NYC reach 80°F on April 26?"
 *   "Will the low temperature in Chicago fall below 32°F on April 25?"
 *
 * @param {string} question
 * @returns {{ city, coords, date, thresholdF, thresholdHighF, direction, type } | null}
 */
function parseQuestion(question) {
  if (!question) return null;
  const q = question.trim();

  // ── Determine high/low type ──────────────────────────────────────────────
  const type = /\b(low|lowest|overnight|minimum|min)\b/i.test(q) ? 'low' : 'high';

  // ── Extract date ─────────────────────────────────────────────────────────
  const dateMatch = q.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i
  );

  let date = null;
  if (dateMatch) {
    const monthKey = dateMatch[1].toLowerCase();
    const mm  = MONTH_MAP[monthKey];
    const dd  = String(dateMatch[2]).padStart(2, '0');
    const yyyy = dateMatch[3] || new Date().getFullYear();
    date = `${yyyy}-${mm}-${dd}`;
  }
  if (!date) return null;

  // ── New bucket format patterns ────────────────────────────────────────────
  // Pattern: "be X°F or higher" / "be X°C or higher"
  const aboveBucketMatch = q.match(/\bbe\s+(\d+(?:\.\d+)?)\s*°?\s*([FC])\s+or\s+higher\b/i);
  // Pattern: "be X°F or below" / "be X°C or below"
  const belowBucketMatch = q.match(/\bbe\s+(\d+(?:\.\d+)?)\s*°?\s*([FC])\s+or\s+(?:below|lower)\b/i);
  // Pattern: "be between X-Y°F" or "be X-Y°F" (range bucket)
  const rangeBucketMatch = q.match(/\bbe(?:\s+between)?\s+(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i);
  // Pattern: "be between X°F and Y°F"
  const rangeBucketMatch2 = q.match(/\bbe(?:\s+between)?\s+(\d+(?:\.\d+)?)\s*°?\s*([FC])\s+and\s+(\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i);
  // Pattern: "be X°C on" (no qualifier) — single 1-degree Celsius bucket e.g. "be 12°C on April 24"
  // Treat as range [X°C, X+1°C). °F equivalent done within.
  const singleCBucketMatch = !aboveBucketMatch && !belowBucketMatch && !rangeBucketMatch && !rangeBucketMatch2
    ? q.match(/\bbe\s+(\d+(?:\.\d+)?)\s*°?C\s+on\b/i)
    : null;

  let thresholdF = null;
  let thresholdHighF = null;
  let direction = null;

  if (aboveBucketMatch) {
    let val = parseFloat(aboveBucketMatch[1]);
    if (aboveBucketMatch[2].toUpperCase() === 'C') val = val * 9 / 5 + 32;
    thresholdF  = Math.round(val * 10) / 10;
    direction   = 'above';
  } else if (belowBucketMatch) {
    let val = parseFloat(belowBucketMatch[1]);
    if (belowBucketMatch[2].toUpperCase() === 'C') val = val * 9 / 5 + 32;
    thresholdF  = Math.round(val * 10) / 10;
    direction   = 'below';
  } else if (rangeBucketMatch) {
    let lo = parseFloat(rangeBucketMatch[1]);
    let hi = parseFloat(rangeBucketMatch[2]);
    if (rangeBucketMatch[3].toUpperCase() === 'C') {
      lo = lo * 9 / 5 + 32;
      hi = hi * 9 / 5 + 32;
    }
    thresholdF     = Math.round(lo * 10) / 10;
    thresholdHighF = Math.round(hi * 10) / 10;
    direction      = 'range';
  } else if (rangeBucketMatch2) {
    let lo = parseFloat(rangeBucketMatch2[1]);
    let hi = parseFloat(rangeBucketMatch2[3]);
    const unit = rangeBucketMatch2[2].toUpperCase();
    if (unit === 'C') {
      lo = lo * 9 / 5 + 32;
      hi = hi * 9 / 5 + 32;
    }
    thresholdF     = Math.round(lo * 10) / 10;
    thresholdHighF = Math.round(hi * 10) / 10;
    direction      = 'range';
  } else if (singleCBucketMatch) {
    // Single °C bucket: "be 12°C on April 24" → range [12°C, 13°C)
    const lo = parseFloat(singleCBucketMatch[1]);
    const hi = lo + 1;
    thresholdF     = Math.round((lo * 9 / 5 + 32) * 10) / 10;
    thresholdHighF = Math.round((hi * 9 / 5 + 32) * 10) / 10;
    direction      = 'range';
  } else {
    // ── Legacy format fallback ────────────────────────────────────────────
    const tempMatch = q.match(/(\d+(?:\.\d+)?)\s*°?\s*([FC])\b/i);
    if (!tempMatch) return null;

    let val = parseFloat(tempMatch[1]);
    if (tempMatch[2].toUpperCase() === 'C') val = val * 9 / 5 + 32;
    thresholdF = Math.round(val * 10) / 10;

    const belowWords = /\b(fall below|drop below|below|under|at most)\b/i;
    direction = belowWords.test(q) ? 'below' : 'above';
  }

  if (thresholdF == null || direction == null) return null;

  // ── Extract city name ────────────────────────────────────────────────────
  // Build an augmented lookup that includes slug-derived city names
  const cityKeys = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);

  // Also add slug-to-name mappings so we can match "New York City" from slug "nyc"
  const extraNames = Object.values(SLUG_TO_CITY_NAME);
  const allSearchNames = [
    ...cityKeys,
    ...extraNames.filter(n => !CITY_COORDS[n]),
  ].sort((a, b) => b.length - a.length);

  let city   = null;
  let coords = null;
  const qLower = q.toLowerCase();

  for (const key of allSearchNames) {
    if (qLower.includes(key)) {
      city   = key;
      coords = CITY_COORDS[key] || cityCoords(key);
      break;
    }
  }

  // If city matched a slug-derived name but no coords yet, search CITY_COORDS fuzzy
  if (city && !coords) {
    coords = cityCoords(city);
  }

  if (!city || !coords) return null;

  return {
    city,
    coords,
    date,
    thresholdF,
    thresholdHighF: thresholdHighF ?? null,
    direction,
    type,
  };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Build the event slug for a city + date.
 * e.g. citySlug='nyc', date='2026-04-24' →
 *      'highest-temperature-in-nyc-on-april-24-2026'
 */
function buildEventSlug(citySlug, date, type = 'highest') {
  const [yyyy, mm, dd] = date.split('-');
  const monthName = MONTH_NAMES[parseInt(mm, 10) - 1];
  const dayNum    = parseInt(dd, 10);
  const typeWord  = type === 'low' ? 'lowest' : 'highest';
  return `${typeWord}-temperature-in-${citySlug}-on-${monthName}-${dayNum}-${yyyy}`;
}

// ─── Market fetching (new: event-slug based) ──────────────────────────────────

/**
 * Fetch active weather/temperature binary markets from the Gamma API.
 * Uses event slugs to discover the ~11-bucket markets per city per date.
 *
 * @returns {Promise<MarketInfo[]>}
 */
async function fetchWeatherMarkets() {
  const now    = Date.now();
  const seen   = new Set();
  const markets = [];

  // Build list of (citySlug, date) pairs for the next 5 days
  const slugTasks = [];
  for (const citySlug of Object.keys(CITY_SLUGS)) {
    for (let d = 1; d <= 5; d++) {
      const targetMs = now + d * 86_400_000;
      const dateStr  = new Date(targetMs).toISOString().slice(0, 10);
      slugTasks.push({ citySlug, date: dateStr });
    }
  }

  // Fire all event-slug fetches in parallel
  const results = await Promise.allSettled(
    slugTasks.map(({ citySlug, date }) => {
      const eventSlug = buildEventSlug(citySlug, date, 'highest');
      return httpGet(GAMMA_API, `/events?slug=${eventSlug}`)
        .then(data => ({ citySlug, date, eventSlug, data }));
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { citySlug, date, eventSlug, data } = result.value;

    const events = Array.isArray(data) ? data : (data.events || []);
    if (events.length === 0) continue;

    const cityMeta = CITY_SLUGS[citySlug];

    for (const event of events) {
      const eventMarkets = event.markets || [];

      for (const m of eventMarkets) {
        const conditionId = m.conditionId || m.condition_id;
        if (!conditionId || seen.has(conditionId)) continue;
        seen.add(conditionId);

        // Parse outcomes + prices
        let outcomes, prices;
        try {
          outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          prices   = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        } catch { continue; }

        if (!Array.isArray(outcomes) || outcomes.length !== 2) continue;
        const yesIdx = outcomes.findIndex(o => /^yes$/i.test(String(o).trim()));
        const noIdx  = outcomes.findIndex(o => /^no$/i.test(String(o).trim()));
        if (yesIdx === -1 || noIdx === -1) continue;

        const yesPrice = parseFloat(prices?.[yesIdx]);
        const noPrice  = parseFloat(prices?.[noIdx]);
        if (isNaN(yesPrice) || isNaN(noPrice)) continue;

        // Skip already-settled markets
        if (yesPrice < 0.005 || yesPrice > 0.995) continue;

        // Must resolve in the future
        const endDate = m.endDate || m.end_date_iso || m.endDateIso;
        if (!endDate || new Date(endDate) <= new Date()) continue;

        const question = m.question || '';
        const parsed   = parseQuestion(question);
        if (!parsed) continue;

        // Enrich coords from slug metadata if parse was successful
        if (cityMeta && !parsed.coords) {
          parsed.coords = cityMeta;
        }
        // Always prefer slug metadata for coords (more authoritative)
        if (cityMeta) {
          parsed.coords = cityMeta;
        }

        const volume    = parseFloat(m.volume || 0);
        const liquidity = parseFloat(m.liquidity || 0);

        markets.push({
          conditionId,
          question,
          parsed,
          yesPrice,
          noPrice,
          volume,
          liquidity,
          endDate,
          eventSlug,
          slug:   m.slug || m.market_slug || null,
          tokens: m.tokens || null,
        });
      }
    }
  }

  return markets;
}

/**
 * Re-fetch the current YES price for a single market from the CLOB midbook.
 * Falls back gracefully if CLOB is unavailable.
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
 * Fetch the NO token ID for a market from the CLOB API.
 * The Gamma API does not return token IDs, so we must fetch them separately
 * from the CLOB when we need to place a live order.
 *
 * @param {string} conditionId
 * @returns {Promise<string|null>}  NO token_id, or null if unavailable
 */
async function getNoTokenId(conditionId) {
  try {
    const data   = await httpGet(CLOB_API, `/markets/${conditionId}`);
    const tokens = data.tokens || [];
    const no     = tokens.find(t => /^no$/i.test(t.outcome));
    return no?.token_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the Polymarket market URL using the event slug.
 */
function marketUrl(market) {
  if (market.eventSlug) return `https://polymarket.com/event/${market.eventSlug}`;
  if (market.slug)      return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/markets/${market.conditionId}`;
}

// ─── Kelly sizing ─────────────────────────────────────────────────────────────

/**
 * Calculate fractional Kelly position size for a binary prediction market.
 */
function kellySizing(modelProb, marketPrice, side, bankroll = 500, kellyFrac = 0.15, maxBet = 100) {
  const p = side === 'yes' ? marketPrice : 1 - marketPrice;
  const q = side === 'yes' ? modelProb   : 1 - modelProb;

  const edge  = q - p;
  const kelly = edge > 0 ? edge / (1 - p) : 0;
  const frac  = kelly * kellyFrac;
  const dollars = Math.min(frac * bankroll, maxBet);

  return {
    kelly:      Math.round(kelly * 1000) / 10,
    fractional: Math.round(frac * 1000) / 10,
    dollars:    Math.round(dollars * 100) / 100,
    side,
    edge:       Math.round(edge * 1000) / 10,
  };
}

module.exports = {
  fetchWeatherMarkets,
  getMarketPrice,
  getNoTokenId,
  parseQuestion,
  cityCoords,
  kellySizing,
  marketUrl,
  CITY_COORDS,
  CITY_SLUGS,
};
