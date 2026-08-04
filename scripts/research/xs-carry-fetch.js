#!/usr/bin/env node
'use strict';

/**
 * scripts/research/xs-carry-fetch.js — corpus for cross-sectional funding carry
 * (spec 07 round 8).
 *
 * Universe: the 81 perps tradeable on BOTH BloFin and Binance. BloFin is the
 * execution venue but serves no funding history, so Binance provides the history
 * for the same instruments. Verified overlap, not assumed.
 *
 * Pulls, per symbol: full 8h funding-rate history + 8h klines. Cached; re-runs
 * are incremental-safe (skips symbols already complete).
 *
 * Output: .market-data-cache/xs-corpus.json
 *   { symbols: [...], rows: { SYM: [{t, r, close}] } }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(ROOT, '.market-data-cache');
const OUT = path.join(CACHE, 'xs-corpus.json');
const UNIVERSE = path.join(CACHE, 'xs-universe.json');
const START = Date.parse('2022-01-01');

function get(url, tries = 3) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: 30000, family: 4 }, r => {
      let b = ''; r.on('data', d => (b += d));
      r.on('end', () => {
        if (r.statusCode === 429 || r.statusCode >= 500) {
          return tries > 0
            ? setTimeout(() => get(url, tries - 1).then(res, rej), 2000)
            : rej(new Error(`http ${r.statusCode}`));
        }
        try { res(JSON.parse(b)); } catch (e) { rej(new Error(b.slice(0, 120))); }
      });
    });
    req.on('error', e => tries > 0 ? setTimeout(() => get(url, tries - 1).then(res, rej), 1500) : rej(e));
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function fundingHistory(sym) {
  const out = [];
  let cursor = START;
  for (let page = 0; page < 40; page++) {
    const b = await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${cursor}&limit=1000`);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b.map(x => ({ t: x.fundingTime, r: Number(x.fundingRate) })));
    if (b.length < 1000) break;
    cursor = b[b.length - 1].fundingTime + 1;
    await new Promise(r => setTimeout(r, 90));
  }
  return out;
}

async function klines8h(sym) {
  const out = [];
  let cursor = START;
  for (let page = 0; page < 40; page++) {
    const b = await get(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=8h&startTime=${cursor}&limit=1500`);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b.map(k => [k[0], Number(k[4])]));
    if (b.length < 1500) break;
    cursor = b[b.length - 1][0] + 1;
    await new Promise(r => setTimeout(r, 90));
  }
  return new Map(out);
}

(async () => {
  const symbols = JSON.parse(fs.readFileSync(UNIVERSE, 'utf8'));
  const corpus = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { symbols: [], rows: {} };
  let done = 0;
  for (const sym of symbols) {
    if (corpus.rows[sym]?.length) { done++; continue; }
    try {
      const [f, k] = [await fundingHistory(sym), await klines8h(sym)];
      const rows = f.map(x => ({ t: x.t, r: x.r, close: k.get(Math.floor(x.t / 288e5) * 288e5 - 288e5) ?? null }))
                    .filter(x => x.close != null && Number.isFinite(x.r));
      corpus.rows[sym] = rows;
      done++;
      console.error(`[xs-fetch] ${sym.padEnd(16)} ${String(rows.length).padStart(5)} settlements  (${done}/${symbols.length})`);
      fs.writeFileSync(OUT, JSON.stringify(corpus));
    } catch (e) {
      console.error(`[xs-fetch] ${sym} FAILED: ${e.message}`);
      corpus.rows[sym] = [];
    }
  }
  corpus.symbols = Object.keys(corpus.rows).filter(s => corpus.rows[s].length > 100);
  fs.writeFileSync(OUT, JSON.stringify(corpus));
  console.error(`[xs-fetch] done — ${corpus.symbols.length} symbols with >100 settlements → ${OUT}`);
})().catch(e => { console.error('xs-fetch failed:', e.message); process.exit(1); });
