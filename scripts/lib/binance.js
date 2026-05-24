'use strict';

/**
 * Binance Futures REST helpers.
 *
 * Used as ground-truth source for outcome resolution in the Poly BTC-5
 * pipeline — TradingView CDP reads can race against the chart's tick refresh
 * and return the wrong bar. The public klines endpoint is authoritative for
 * a closed 5-min bar's open/close.
 */

const https = require('https');

function _get(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ace-trading-bot/1.0' } }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`binance http ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('binance timeout')); });
  });
}

/**
 * Fetch a single 5-min BTCUSDT.P kline by its open timestamp (ms).
 * Returns { open, high, low, close, volume, openTime, closeTime } or null.
 */
async function getKline5m(barOpenMs) {
  const endMs = barOpenMs + 5 * 60 * 1000 - 1;
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=${barOpenMs}&endTime=${endMs}&limit=2`;
  const arr = await _get(url);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const k = arr.find(x => x[0] === barOpenMs);
  if (!k) return null;
  return {
    openTime:  k[0],
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
    closeTime: k[6],
  };
}

/**
 * Return 'UP' if 5-min bar close >= open, 'DOWN' otherwise. null if the bar
 * isn't available yet (still in progress, or out of range).
 *
 * Polymarket BTC 5-min markets resolve on whether the bar moved up or down
 * (closing price relative to opening price). The >= tie-break matches
 * Polymarket's "UP" rule when open == close.
 */
async function btcDirection5m(barOpenMs) {
  const k = await getKline5m(barOpenMs);
  if (!k) return null;
  return k.close >= k.open ? 'UP' : 'DOWN';
}

/**
 * Fetch a range of 5-min klines in one request (max 1000 bars).
 * Returns array of normalized objects (same shape as getKline5m).
 */
async function getKlines5mRange(startMs, endMs) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const arr = await _get(url);
  if (!Array.isArray(arr)) return [];
  return arr.map(k => ({
    openTime:  k[0],
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
    closeTime: k[6],
  }));
}

module.exports = { getKline5m, btcDirection5m, getKlines5mRange };
