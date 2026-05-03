'use strict';

/**
 * lib/polymarket.js — Polymarket market discovery helper
 *
 * Queries the Gamma API to find the currently active BTC 5-min prediction market.
 * Called by poly/btc-5/trigger-check.js once per hour to auto-update the market URL.
 */

const https = require('https');

const GAMMA_API = 'https://gamma-api.polymarket.com/markets';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ace-trading-bot/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Query Gamma API for the active BTC 5-min market.
 * @returns {Promise<string|null>}  Polymarket event URL, or null if not found
 */
async function discoverActiveMarket() {
  try {
    const { status, body } = await httpsGet(
      `${GAMMA_API}?search=btc+5+minutes&active=true&closed=false&limit=20`
    );
    if (status !== 200) return null;

    const data = JSON.parse(body);
    const arr  = Array.isArray(data) ? data : (data.markets || data.results || []);

    const match = arr.find(m => {
      const slug     = (m.slug || '').toLowerCase();
      const question = (m.question || '').toLowerCase();
      const isBtc    = slug.includes('btc') || question.includes('btc') || question.includes('bitcoin');
      const is5m     = slug.includes('5m') || slug.includes('5-m') ||
                       question.includes('5 min') || question.includes('5min');
      return isBtc && is5m;
    });

    if (!match || !match.slug) return null;
    return `https://polymarket.com/event/${match.slug}`;
  } catch {
    return null;
  }
}

module.exports = { discoverActiveMarket };
