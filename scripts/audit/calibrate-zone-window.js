#!/usr/bin/env node
/**
 * calibrate-zone-window.js — P1 of the exchange-native migration
 * (refactors/2026-07-12-btc-exchange-native-migration-plan.md)
 *
 * Measures what the live Ace chart's VRVP is actually computing over, then
 * finds the fixed Binance-kline window + row size that best reproduces it:
 *
 *   1. Reads the chart's visible range, VRVP histogram (rows + POC/VAH/VAL)
 *      and price via CDP (lock-guarded, read-only, no TF switches).
 *   2. Fetches Binance 5m klines over the exact visible range and over
 *      candidate clean windows (7/14/21/30/45/60/90d capped at visible span).
 *   3. Builds profiles via lib/market-data.js with the TV row size and
 *      scores each candidate by worst-of POC/VAH/VAL delta (% of price).
 *   4. Writes the winner to config/btc-zones.json (calibrate-then-freeze).
 *
 * Usage: node scripts/audit/calibrate-zone-window.js [--dry-run]
 *   --dry-run: print the table, don't write config.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { cdpConnect, cdpEval, getQuote } = require('../lib/cdp');
const { acquireLock, releaseLock } = require('../lib/lock');
const { fetchKlines, buildVolumeProfile } = require('../lib/market-data');

const ROOT = path.resolve(__dirname, '../..');
const CONFIG_FILE = path.join(ROOT, 'config', 'btc-zones.json');
const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Same extraction as trigger-check.js VRVP_EXPR (kept in sync by the P2
// parity sidecar — any drift shows up in the parity log immediately).
const VRVP_EXPR = `
(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      var name = '';
      try { name = s.metaInfo().description || ''; } catch(e) { continue; }
      if (name !== 'Visible Range Volume Profile') continue;
      var poc = null, vah = null, val = null;
      try {
        var lastVal = s._data.last().value;
        if (lastVal) { poc = lastVal[1]; vah = lastVal[2]; val = lastVal[3]; }
      } catch(e) {}
      var rows = [];
      try {
        var hhists = s.graphics().hhists();
        var histBars = hhists.get('histBars2');
        if (histBars && histBars._primitivesDataById) {
          histBars._primitivesDataById.forEach(function(v) {
            if (v.priceLow != null && v.rate) {
              rows.push({
                lo: Math.round(v.priceLow * 10) / 10,
                hi: Math.round(v.priceHigh * 10) / 10,
                uv: v.rate[0] || 0,
                dv: v.rate[1] || 0,
                tv: (v.rate[0] || 0) + (v.rate[1] || 0)
              });
            }
          });
          rows.sort(function(a, b) { return a.lo - b.lo; });
        }
      } catch(e) {}
      return { poc: poc, vah: vah, val: val, rows: rows };
    }
    return null;
  } catch(e) { return { error: e.message }; }
})()`;

const VISIBLE_RANGE_EXPR = `
(function() {
  try {
    var r = window.TradingViewApi.activeChart().getVisibleRange();
    return { from: r.from, to: r.to };
  } catch(e) { return { error: e.message }; }
})()`;

async function readChart() {
  const lock = await acquireLock(30_000, 'zone-calibrate');
  if (!lock) throw new Error('Could not acquire TradingView lock');
  let client;
  try {
    client = await cdpConnect('BTCUSDT');
    const [range, vrvp, quote] = [
      await cdpEval(client, VISIBLE_RANGE_EXPR),
      await cdpEval(client, VRVP_EXPR),
      await getQuote(client),
    ];
    if (!range || range.error) throw new Error(`visible range: ${range?.error || 'null'}`);
    if (!vrvp || vrvp.error || !vrvp.rows?.length) throw new Error(`VRVP: ${vrvp?.error || 'no rows'}`);
    if (!quote?.last) throw new Error('no price');
    return { range, vrvp, price: quote.last };
  } finally {
    if (client) { try { await client.close(); } catch {} }
    releaseLock(lock);
  }
}

function pct(a, b, price) { return Math.abs(a - b) / price * 100; }

async function main() {
  log('Reading live Ace chart (read-only)...');
  const { range, vrvp, price } = await readChart();

  const fromMs = range.from * 1000, toMs = range.to * 1000;
  const visibleDays = (toMs - fromMs) / 86_400_000;
  // TV row size: median row height from the live histogram
  const heights = vrvp.rows.map(r => r.hi - r.lo).sort((a, b) => a - b);
  const rowSize = heights[Math.floor(heights.length / 2)];

  log(`Visible range: ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()} (${visibleDays.toFixed(1)}d)`);
  log(`TV: rows=${vrvp.rows.length} rowSize≈${rowSize.toFixed(1)} POC=${vrvp.poc} VAH=${vrvp.vah} VAL=${vrvp.val} price=${price}`);

  // Candidates: exact visible span + clean windows near it
  const cleanDays = [7, 14, 21, 30, 45, 60, 90].filter(d => d <= visibleDays * 1.5);
  const candidates = [
    { name: `visible (${visibleDays.toFixed(1)}d)`, days: visibleDays },
    ...cleanDays.map(d => ({ name: `${d}d`, days: d })),
  ];

  const now = Date.now();
  const results = [];
  for (const cand of candidates) {
    const startTime = Math.round(now - cand.days * 86_400_000);
    const bars = await fetchKlines({ symbol: 'BTCUSDT', interval: '5m', startTime, endTime: now });
    const p = buildVolumeProfile(bars, { rowSize });
    if (!p) { log(`${cand.name}: no profile`); continue; }
    const dPoc = pct(p.poc, vrvp.poc, price);
    const dVah = pct(p.vah, vrvp.vah, price);
    const dVal = pct(p.val, vrvp.val, price);
    results.push({ ...cand, bars: bars.length, poc: p.poc, vah: p.vah, val: p.val,
                   dPoc, dVah, dVal, worst: Math.max(dPoc, dVah, dVal) });
  }

  console.log('\nwindow          bars    POC      VAH      VAL      ΔPOC%   ΔVAH%   ΔVAL%   worst%');
  for (const r of results) {
    console.log(`${r.name.padEnd(15)} ${String(r.bars).padStart(6)}  ${String(r.poc).padStart(7)}  ${String(r.vah).padStart(7)}  ${String(r.val).padStart(7)}  ${r.dPoc.toFixed(3).padStart(6)}  ${r.dVah.toFixed(3).padStart(6)}  ${r.dVal.toFixed(3).padStart(6)}  ${r.worst.toFixed(3).padStart(6)}`);
  }

  // Freeze: best CLEAN window (never the raw visible span — determinism is the point)
  const clean = results.filter(r => !r.name.startsWith('visible'));
  if (!clean.length) throw new Error('no clean-window candidates produced a profile');
  const winner = clean.reduce((b, r) => r.worst < b.worst ? r : b, clean[0]);
  log(`\nWinner: ${winner.name} (worst Δ ${winner.worst.toFixed(3)}% of price)`);

  const config = {
    instrument: 'BTCUSDT',
    interval: '5m',
    windowDays: winner.days,
    rowSize,
    valueAreaPct: 0.7,
    calibration: {
      at: new Date().toISOString(),
      chartVisibleDays: +visibleDays.toFixed(2),
      tvRows: vrvp.rows.length,
      tv: { poc: vrvp.poc, vah: vrvp.vah, val: vrvp.val, price },
      winner: { poc: winner.poc, vah: winner.vah, val: winner.val, worstDeltaPct: +winner.worst.toFixed(4) },
    },
  };

  if (DRY_RUN) { log('Dry run — config not written'); return; }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  log(`Config frozen → ${path.relative(ROOT, CONFIG_FILE)}`);
}

main().catch(e => { console.error('calibrate-zone-window failed:', e.message); process.exit(1); });
