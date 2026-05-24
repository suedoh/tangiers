'use strict';

/**
 * Polymarket CLOB helpers — token discovery + order-book reads.
 *
 * Used by poly/btc-5 to capture entry-price context per signal so we can
 * compute realized $-EV per trade, not just win rate (audit Tier A1,
 * 2026-05-24). Read-only; no auth needed for public market data.
 *
 * All functions return null on failure rather than throwing — the cron path
 * must never block on Polymarket availability.
 */

const https = require('https');

function _get(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ace-trading-bot/1.0' } }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`polymarket http ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('polymarket timeout')); });
  });
}

/**
 * Resolve event slug → CLOB token IDs for the binary outcome (Up / Down).
 * Polymarket convention: outcomes JSON is ["Up", "Down"], clobTokenIds aligns
 * by position. Returns { upTokenId, downTokenId, slug, question } or null.
 */
async function fetchMarketTokens(slug) {
  try {
    const arr = await _get(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
    const evt = Array.isArray(arr) ? arr[0] : null;
    const mkt = evt?.markets?.[0];
    if (!mkt?.clobTokenIds) return null;

    const tokens   = JSON.parse(mkt.clobTokenIds);
    const outcomes = mkt.outcomes ? JSON.parse(mkt.outcomes) : ['Up', 'Down'];
    if (!Array.isArray(tokens) || tokens.length !== 2) return null;

    // Defensive: align by outcome label rather than trusting position.
    const upIdx = outcomes.findIndex(o => /up/i.test(o));
    const dnIdx = outcomes.findIndex(o => /down/i.test(o));
    if (upIdx < 0 || dnIdx < 0) return null;

    return {
      upTokenId:   String(tokens[upIdx]),
      downTokenId: String(tokens[dnIdx]),
      slug:        evt.slug,
      question:    mkt.question,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the best bid/ask for one CLOB token. Returns null on any failure
 * (HTTP error, empty book, timeout). The signal pipeline must never block
 * on Polymarket — null entry-price fields are acceptable.
 *
 * spreadBps uses (ask - bid) / mid; large values indicate thin / wide books.
 */
async function fetchOrderBook(tokenId) {
  try {
    const data = await _get(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    const asks = (data.asks || []).slice().map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
    const bids = (data.bids || []).slice().map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
    asks.sort((a, b) => a.price - b.price);
    bids.sort((a, b) => b.price - a.price);
    if (asks.length === 0 || bids.length === 0) return null;

    const ask = asks[0].price;
    const bid = bids[0].price;
    if (!(ask > 0) || !(bid > 0)) return null;
    const mid = (ask + bid) / 2;

    return {
      bid,
      ask,
      mid,
      spreadBps: mid > 0 ? Math.round(((ask - bid) / mid) * 10000) : null,
      depthAsk:  asks[0].size,
      ts:        Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Polymarket creates exactly one Bitcoin Up/Down market per 5-min bar; the
 * slug embeds the bar open time as a Unix-seconds integer:
 *   btc-updown-5m-<epochSeconds>
 * Computing it from the bar avoids relying on the (search-based, sometimes
 * empty) Gamma discovery query.
 */
function slugForBar(barOpenMs) {
  return `btc-updown-5m-${Math.floor(barOpenMs / 1000)}`;
}

module.exports = { fetchMarketTokens, fetchOrderBook, slugForBar };
