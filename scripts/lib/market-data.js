/**
 * market-data.js — exchange-native indicator engine (Binance Futures REST).
 *
 * P0 of refactors/2026-07-12-btc-exchange-native-migration-plan.md.
 * Computes the quantities the BTC pipeline currently scrapes from
 * TradingView: volume profile (POC/VAH/VAL + histogram rows in the exact
 * VRVP_EXPR shape trigger-check.js already consumes), CVD, session VP, VWAP.
 *
 * Design rules:
 *   - Pure functions over bar arrays — no hidden I/O, unit-testable
 *     (test/market-data.test.js, known-answer fixtures).
 *   - Network is injectable (`fetcher`) so tests never touch Binance.
 *   - Profile volume is spread across each bar's H–L span proportional to
 *     row overlap (TV's method — validated by P1 calibration against the
 *     live chart histogram).
 *   - Value area: 70%, greedy single-row expansion from POC (larger
 *     neighbor first). TV's exact expansion variant is validated in P1.
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const BINANCE_FAPI = 'https://fapi.binance.com';

const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000,
  '1w': 604_800_000,
};

// ─── HTTP (default fetcher) ───────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'AceTradingBot/1.0' } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ─── Bar parsing ──────────────────────────────────────────────────────────────

// Binance kline array → bar object.
// [openTime, o, h, l, c, vol, closeTime, quoteVol, trades, takerBuyBase, ...]
function parseKline(k) {
  return {
    t: k[0],
    o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]),
    v: parseFloat(k[5]), tb: parseFloat(k[9]),
  };
}

// ─── Indicators ───────────────────────────────────────────────────────────────

// Cumulative volume delta: taker buys minus taker sells = 2×takerBuy − volume.
function computeCVD(bars) {
  return bars.reduce((sum, b) => sum + (2 * b.tb - b.v), 0);
}

// Volume-weighted average price (hlc3), anchored at bars[0].
function computeVWAP(bars) {
  let pv = 0, vol = 0;
  for (const b of bars) { pv += ((b.h + b.l + b.c) / 3) * b.v; vol += b.v; }
  return vol > 0 ? pv / vol : null;
}

// Session volume split by bar direction (flat bars count as up, like TV).
function computeSessionVP(bars) {
  let up = 0, down = 0;
  for (const b of bars) { if (b.c >= b.o) up += b.v; else down += b.v; }
  return { up, down, total: up + down };
}

// Average True Range — simple mean of the last `period` true ranges (same
// method as lib/cdp.js calcATR, over exchange bar objects). Null if <2 bars.
function computeATR(bars, period = 14) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ─── Bar slicing ──────────────────────────────────────────────────────────────

// Completed bars only: drops any bar whose interval has not fully elapsed.
// Binance returns the in-progress kline as the last element; confirming or
// walking outcomes on it recreates audit defect D4 (confirmation on prices
// that never closed). Pure — `now` injectable for tests.
function completedBars(bars, interval, now = Date.now()) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`Unknown interval: ${interval}`);
  return (bars || []).filter(b => b.t + stepMs <= now);
}

// Current UTC-day slice (Binance session boundary = 00:00 UTC). Feed the
// result to computeVWAP / computeSessionVP for session-anchored values —
// matches TV's default Session anchor on the crypto perp chart.
function sessionBars(bars, now = Date.now()) {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  return (bars || []).filter(b => b.t >= dayStart);
}

// ─── Volume profile ───────────────────────────────────────────────────────────

// Builds a VRVP_EXPR-compatible histogram: { poc, vah, val, rows } where
// rows = [{lo, hi, uv, dv, tv}] ascending. Each bar's volume is spread across
// the rows its H–L range overlaps, proportional to overlap — TV's method
// (P1 calibration falsified point-bucketing at hlc3: POC off 1.9% on the
// exact visible window while VAL matched to 0.002%). up = takerBuy share,
// down = remainder.
function buildVolumeProfile(bars, { rowSize }) {
  if (!bars || bars.length === 0 || !rowSize) return null;

  let minL = Infinity;
  for (const b of bars) if (b.l < minL) minL = b.l;
  const gridLo = Math.floor(minL / rowSize) * rowSize;

  // Top row: highest bucket any bar actually touches (a wide bar whose high
  // sits exactly on a grid line does NOT need the bucket above it; a
  // zero-range bar on a grid line does).
  const topIdx = b => b.h > b.l
    ? Math.ceil((b.h - gridLo) / rowSize) - 1
    : Math.floor((b.h - gridLo) / rowSize);
  let nRows = 0;
  for (const b of bars) nRows = Math.max(nRows, topIdx(b) + 1);

  const rows = Array.from({ length: nRows }, (_, i) => ({
    lo: gridLo + i * rowSize, hi: gridLo + (i + 1) * rowSize, uv: 0, dv: 0, tv: 0,
  }));

  for (const b of bars) {
    const iLo = Math.floor((b.l - gridLo) / rowSize);
    const iHi = topIdx(b);
    if (iHi === iLo || b.h <= b.l) {
      const r = rows[Math.min(iLo, nRows - 1)];
      r.uv += b.tb; r.dv += b.v - b.tb; r.tv += b.v;
      continue;
    }
    const span = b.h - b.l;
    for (let i = iLo; i <= iHi; i++) {
      const overlap = Math.min(b.h, rows[i].hi) - Math.max(b.l, rows[i].lo);
      if (overlap <= 0) continue;
      const frac = overlap / span;
      rows[i].uv += b.tb * frac;
      rows[i].dv += (b.v - b.tb) * frac;
      rows[i].tv += b.v * frac;
    }
  }

  const totalVol = rows.reduce((s, r) => s + r.tv, 0);
  if (totalVol <= 0) return null;

  // POC: center of the max-volume row
  let pocIdx = 0;
  for (let i = 1; i < nRows; i++) if (rows[i].tv > rows[pocIdx].tv) pocIdx = i;
  const poc = Math.round((rows[pocIdx].lo + rows[pocIdx].hi) / 2);

  // 70% value area: greedy expansion from POC, larger neighbor first
  const target = totalVol * 0.7;
  let loIdx = pocIdx, hiIdx = pocIdx, captured = rows[pocIdx].tv;
  while (captured < target && (loIdx > 0 || hiIdx < nRows - 1)) {
    const below = loIdx > 0 ? rows[loIdx - 1].tv : -1;
    const above = hiIdx < nRows - 1 ? rows[hiIdx + 1].tv : -1;
    if (below >= above) { loIdx--; captured += rows[loIdx].tv; }
    else { hiIdx++; captured += rows[hiIdx].tv; }
  }

  return { poc, vah: rows[hiIdx].hi, val: rows[loIdx].lo, rows, totalVol };
}

// ─── Klines fetch (paginated) ─────────────────────────────────────────────────

async function fetchKlines({ symbol, interval, startTime, endTime, limit = 1500, fetcher = httpGet }) {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`Unknown interval: ${interval}`);

  const bars = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const url = `${BINANCE_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}` +
                `&startTime=${cursor}&endTime=${endTime}&limit=${limit}`;
    const raw = await fetcher(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw) bars.push(parseKline(k));
    if (raw.length < limit) break;
    cursor = bars[bars.length - 1].t + stepMs;
  }
  return bars;
}

// ─── Point-in-time fetches ────────────────────────────────────────────────────

// Last traded price — /fapi/v1/ticker/price. Null on malformed response;
// network errors propagate (never signal off missing data).
async function fetchLastPrice({ symbol, fetcher = httpGet }) {
  const d = await fetcher(`${BINANCE_FAPI}/fapi/v1/ticker/price?symbol=${symbol}`);
  const p = parseFloat(d && d.price);
  return isNaN(p) ? null : p;
}

// Current open interest in COINS — /fapi/v1/openInterest. Same unit as the
// parse-num-expanded CDP study read (see trigger-check.js fetchOIBinance
// history: mixing units into _previousOI produced phantom OI trends).
async function fetchOpenInterest({ symbol, fetcher = httpGet }) {
  const d = await fetcher(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${symbol}`);
  const oi = parseFloat(d && d.openInterest);
  return isNaN(oi) ? null : oi;
}

// ─── Incremental klines cache ─────────────────────────────────────────────────

// Keeps a rolling window of bars in a JSON cache file. First call fetches the
// full window; subsequent calls re-fetch only from the last cached bar
// (inclusive — it was incomplete when cached) and prune bars that fell out of
// the window. Never signals off stale data: any fetch error propagates.
async function loadKlinesCached({ symbol, interval, windowMs, cacheFile, fetcher = httpGet, now = Date.now() }) {
  const windowStart = now - windowMs;

  let cached = null;
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (j && j.symbol === symbol && j.interval === interval && Array.isArray(j.bars) && j.bars.length) {
      cached = j.bars;
    }
  } catch {} // missing/corrupt cache → full refetch

  let bars;
  if (!cached) {
    bars = await fetchKlines({ symbol, interval, startTime: windowStart, endTime: now, fetcher });
  } else {
    const lastT = cached[cached.length - 1].t;
    const fresh = await fetchKlines({ symbol, interval, startTime: lastT, endTime: now, fetcher });
    bars = cached.filter(b => b.t < lastT).concat(fresh);
  }
  bars = bars.filter(b => b.t >= windowStart);

  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, symbol, interval, bars }));
  return bars;
}

module.exports = {
  parseKline,
  computeCVD,
  computeVWAP,
  computeSessionVP,
  computeATR,
  completedBars,
  sessionBars,
  buildVolumeProfile,
  fetchKlines,
  fetchLastPrice,
  fetchOpenInterest,
  loadKlinesCached,
  httpGet,
  INTERVAL_MS,
};
