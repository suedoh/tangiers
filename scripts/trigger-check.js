#!/usr/bin/env node
/**
 * Ace Trading System — Stage 1 Trigger Check
 *
 * Runs every 30 minutes via macOS crontab.
 * Zero Claude/AI usage — calls TradingView CDP directly.
 * Zero subscription cost.
 *
 * What it does:
 *   1. Connects to TradingView Desktop via CDP (port 9222)
 *   2. Reads price, VRVP histogram (POC/VAH/VAL/HVNs/LVNs), CVD, OI, Session VP
 *   3. Checks VRVP level proximity as primary trigger
 *   4. If triggered: evaluates setup criteria + generates full trade plan
 *   5. Posts complete setup to Discord (entry, SL, TPs, criteria, alerts)
 *   6. On any error: posts actionable error message to Discord
 *
 * Primary trigger source: Visible Range Volume Profile (VRVP)
 *   VAL/VAH (value area boundaries) > HVN (high-volume nodes) > POC (point of control)
 *   LuxAlgo SMC zones are read for secondary context only.
 *
 * Requires: TradingView Desktop open on 🕵Ace layout (BINANCE:BTCUSDT.P)
 */

'use strict';

const CDP  = require('/Users/vpm/trading/tradingview-mcp/node_modules/chrome-remote-interface');
const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT        = path.resolve(__dirname, '..');
const ENV_FILE    = path.join(ROOT, '.env');
const NOTIFY      = path.join(ROOT, 'scripts', 'discord-notify.sh');
const STATE_FILE  = path.join(ROOT, '.trigger-state.json');
const TRADES_FILE = path.join(ROOT, 'trades.json');

const CDP_PORT         = 9222;
const COOLDOWN_MS      = 1 * 60 * 60 * 1000; // 1 hour between alerts per zone
const PENDING_TTL_MS   = 90 * 60 * 1000;     // 90-min window to catch confirmation after flat-OI alert
const OI_CONFIRM_PCT   = 0.005;              // OI must rise ≥ 0.5% from baseline to confirm
const CVD_CONFIRM_MULT = 1.5;               // CVD must grow ≥ 1.5× from baseline to confirm
const CVD_CONFIRM_MIN  = 200;               // CVD must also grow by at least this absolute amount
const EXPECTED_SYMBOL  = 'BINANCE:BTCUSDT.P';

// ─── Env ─────────────────────────────────────────────────────────────────────

if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const idx = l.indexOf('=');
      if (idx > 0) process.env[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
    });
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Discord ─────────────────────────────────────────────────────────────────

function notify(type, message, onMessageId) {
  try {
    const out = execFileSync('bash', [NOTIFY, type, message], { stdio: 'pipe', encoding: 'utf8' });
    // Parse MSG_ID:xxx line from notify script output
    const idMatch = (out || '').match(/^MSG_ID:(.+)$/m);
    const msgId = idMatch ? idMatch[1].trim() : null;
    log(`Discord [${type}] sent${msgId ? ` id=${msgId}` : ''}`);
    if (msgId && onMessageId) onMessageId(msgId);
  } catch (e) {
    log(`Discord notify failed: ${e.message}`);
  }
}

function errorAlert(what, where, fix) {
  const msg = `❌ **ERROR — Ace Trigger Check**\n**What:** ${what}\n**Where:** ${where}\n**Fix:** ${fix}`;
  notify('error', msg);
}

// ─── CDP Helpers ─────────────────────────────────────────────────────────────

async function cdpConnect() {
  let targets;
  try {
    targets = await CDP.List({ host: 'localhost', port: CDP_PORT });
  } catch (e) {
    throw { code: 'CDP_UNAVAILABLE', message: e.message };
  }

  const target = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
              || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));

  if (!target) {
    throw { code: 'NO_TARGET', message: 'No TradingView chart page found in CDP targets.' };
  }

  const client = await CDP({ host: 'localhost', port: CDP_PORT, target: target.id });
  await client.Runtime.enable();
  return { client, target };
}

async function cdpEval(client, expression) {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
             || result.exceptionDetails.text
             || 'Unknown JS error';
    throw new Error(`CDP eval error: ${msg}`);
  }
  return result.result?.value ?? null;
}

// ─── TradingView Data (inlined from MCP core/data.js) ────────────────────────

const CHART_API = `window.TradingViewApi._activeChartWidgetWV.value()`;
const BARS_PATH = `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;

const QUOTE_EXPR = `
(function() {
  try {
    var api  = ${CHART_API};
    var bars = ${BARS_PATH};
    var q    = { symbol: null, last: null, high: null, low: null };
    try { q.symbol = api.symbol(); } catch(e) {}
    if (bars && typeof bars.lastIndex === 'function') {
      var v = bars.valueAt(bars.lastIndex());
      if (v) { q.last = v[4]; q.high = v[2]; q.low = v[3]; q.open = v[1]; }
    }
    return q;
  } catch(e) { return { error: e.message }; }
})()`;

const STUDY_VALUES_EXPR = `
(function() {
  try {
    var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var results = [];
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      try {
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (!name) continue;
        var values = {};
        try {
          var dwv = s.dataWindowView();
          if (dwv) {
            var items = dwv.items();
            if (items) {
              for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item._value && item._value !== '\u2205' && item._title)
                  values[item._title] = item._value;
              }
            }
          }
        } catch(e) {}
        // Fallback for studies whose dataWindowView() returns empty (e.g. VWAP):
        // read the last bar value from _series directly.
        if (Object.keys(values).length === 0 && s._series && s._series.length > 0) {
          try {
            var ser = s._series[0];
            var bars = typeof ser.bars === 'function' ? ser.bars() : ser.bars;
            if (bars && typeof bars.lastIndex === 'function') {
              var li = bars.lastIndex();
              var v  = bars.valueAt(li);
              if (v) {
                var val = Array.isArray(v) ? (v[4] != null ? v[4] : v[1] != null ? v[1] : v[0]) : null;
                if (val != null && !isNaN(val)) values[name] = String(val);
              }
            }
          } catch(e) {}
        }
        if (Object.keys(values).length > 0) results.push({ name: name, values: values });
      } catch(e) {}
    }
    return results;
  } catch(e) { return []; }
})()`;

const GET_TF_EXPR = `
(function() {
  try { return window.TradingViewApi._activeChartWidgetWV.value().resolution(); }
  catch(e) { return null; }
})()`;

function buildSetTFExpr(tf) {
  return `(function() {
    try { window.TradingViewApi._activeChartWidgetWV.value().setResolution('${tf}', function(){}); return true; }
    catch(e) { return false; }
  })()`;
}

function buildClosesExpr(count) {
  return `(function() {
    try {
      var bars = ${BARS_PATH};
      var closes = [];
      var li = bars.lastIndex();
      var start = Math.max(0, li - ${count} + 1);
      for (var i = start; i <= li; i++) {
        var v = bars.valueAt(i);
        if (v && v[4] != null) closes.push(v[4]);
      }
      return closes;
    } catch(e) { return []; }
  })()`;
}

// Returns the last `count` bars as {time, open, high, low, close} objects.
// Used by bar-accurate outcome detection — checks high/low per bar rather than
// spot price, so wicks and intrabar order (stop before TP on same candle) are handled.
function buildOHLCVExpr(count) {
  return `(function() {
    try {
      var bars = ${BARS_PATH};
      var result = [];
      var li = bars.lastIndex();
      var start = Math.max(0, li - ${count} + 1);
      for (var i = start; i <= li; i++) {
        var v = bars.valueAt(i);
        if (v && v[4] != null) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4] });
      }
      return result;
    } catch(e) { return []; }
  })()`;
}

// ─── Change 4: Volume for Breakout Detection ─────────────────────────────────
// Returns the last `count` bar volumes (index 5 in bars array).
function buildVolumeExpr(count) {
  return `(function() {
    try {
      var bars = ${BARS_PATH};
      var vols = [];
      var li = bars.lastIndex();
      var start = Math.max(0, li - ${count} + 1);
      for (var i = start; i <= li; i++) {
        var v = bars.valueAt(i);
        if (v && v[5] != null) vols.push(v[5]);
      }
      return vols;
    } catch(e) { return []; }
  })()`;
}

function buildBoxesExpr(filter) {
  const f = JSON.stringify(filter || '');
  return `
(function() {
  try {
    var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var filter  = ${f};
    var allZones = [];
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      try {
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (!name || (filter && name.indexOf(filter) === -1)) continue;
        var g = s._graphics;
        if (!g || !g._primitivesCollection) continue;
        var pc = g._primitivesCollection;
        var items = [];
        try {
          var outer = pc.dwgboxes;
          if (outer) {
            var inner = outer.get('boxes');
            if (inner) {
              var coll = inner.get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0)
                coll._primitivesDataById.forEach(function(v, id) { items.push(v); });
            }
          }
        } catch(e) {}
        for (var i = 0; i < items.length; i++) {
          var v    = items[i];
          var high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1,v.y2)*100)/100 : null;
          var low  = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1,v.y2)*100)/100 : null;
          if (high != null && low != null) allZones.push({ high: high, low: low });
        }
      } catch(e) {}
    }
    // Deduplicate
    var seen = {};
    var zones = allZones.filter(function(z) {
      var k = z.high + ':' + z.low;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    zones.sort(function(a,b) { return b.high - a.high; });
    return zones;
  } catch(e) { return []; }
})()`;
}

// ─── Change 3: BOS/CHoCH Label Reader ────────────────────────────────────────
// Reads LuxAlgo (or other) Pine label.new() primitives from CDP.
// Returns array of { text, price, time } — the same graphics path as boxes
// but targeting dwglabels instead of dwgboxes.
function buildLabelsExpr(filter) {
  const f = JSON.stringify(filter || '');
  return `
(function() {
  try {
    var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var filter  = ${f};
    var allLabels = [];
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      try {
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (!name || (filter && name.indexOf(filter) === -1)) continue;
        var g = s._graphics;
        if (!g || !g._primitivesCollection) continue;
        var pc = g._primitivesCollection;
        var items = [];
        try {
          var outer = pc.dwglabels;
          if (outer) {
            var inner = outer.get('labels');
            if (inner) {
              var coll = inner.get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0)
                coll._primitivesDataById.forEach(function(v, id) { items.push(v); });
            }
          }
        } catch(e) {}
        for (var i = 0; i < items.length; i++) {
          var v = items[i];
          var text = (v.text || v.labelText || '').trim();
          if (text) allLabels.push({ text: text, price: v.y, time: v.x });
        }
      } catch(e) {}
    }
    return allLabels;
  } catch(e) { return []; }
})()`;
}

// ─── VRVP Extractor ──────────────────────────────────────────────────────────
// Reads the Visible Range Volume Profile histogram from TradingView's native
// (non-Pine) study data layer. Returns raw histogram rows + POC/VAH/VAL.
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

      // POC / VAH / VAL — the study's developing-line data store
      var poc = null, vah = null, val = null;
      try {
        var lastVal = s._data.last().value;
        if (lastVal) { poc = lastVal[1]; vah = lastVal[2]; val = lastVal[3]; }
      } catch(e) {}

      // Full histogram rows
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

// ─── Indicator Parsers ────────────────────────────────────────────────────────

function parseFloat_(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function computeMACD(closes) {
  // Needs 60+ bars for reliable EMA warm-up; min 35
  if (!closes || closes.length < 35) return null;
  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
  let ema12 = closes[0], ema26 = closes[0];
  const macdLine = [];
  for (let i = 1; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    if (i >= 25) macdLine.push(ema12 - ema26);
  }
  if (macdLine.length < 9) return null;
  let signal = macdLine[0];
  for (let i = 1; i < macdLine.length; i++) signal = macdLine[i] * k9 + signal * (1 - k9);
  const macd = macdLine[macdLine.length - 1];
  const histogram = macd - signal;
  return { histogram, bullish: histogram > 0 };
}

function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── Change 1: HTF Trend Regime Filter ───────────────────────────────────────
// Determines weekly trend direction from close prices.
// Returns 'uptrend', 'downtrend', or 'neutral'.
// Uses 5 closes: if 3+ consecutive moves are up → uptrend; 3+ down → downtrend.
function analyseWeeklyTrend(closes) {
  if (!closes || closes.length < 4) return null;
  const last = closes.slice(-5);
  let up = 0, down = 0;
  for (let i = 1; i < last.length; i++) {
    if (last[i] > last[i - 1]) up++; else down++;
  }
  if (up >= 3) return 'uptrend';
  if (down >= 3) return 'downtrend';
  return 'neutral';
}

// Read/write previous OI to detect rising vs falling trend
function getOITrend(currentOI) {
  const state = readState();
  const prev = state._previousOI ?? null;
  state._previousOI = currentOI;
  writeState(state);
  if (prev === null || currentOI === null) return null;
  const diff = currentOI - prev;
  if (Math.abs(diff) < 0.05) return 'flat';
  return diff > 0 ? 'rising' : 'falling';
}

// Switch timeframe, wait for bars to load, return close prices, restore original TF
async function fetchHTFCloses(client, tf, count, originalTF) {
  try {
    await cdpEval(client, buildSetTFExpr(tf));
    await new Promise(r => setTimeout(r, 1200));
    const closes = await cdpEval(client, buildClosesExpr(count));
    return Array.isArray(closes) ? closes : [];
  } catch { return []; } finally {
    // Always restore — don't leave chart on wrong TF
    try {
      await cdpEval(client, buildSetTFExpr(originalTF));
      await new Promise(r => setTimeout(r, 600));
    } catch {}
  }
}

function parseStudies(studies) {
  const find = (name) => studies.find(s => s.name?.toLowerCase().includes(name.toLowerCase()));

  const cvdStudy    = find('Cumulative Volume Delta');
  const oiStudy     = find('Open Interest');
  const sessionStudy = find('Session Volume Profile');
  // ─── Change 5: VWAP Fix — try all known name variants ────────────────────
  const vwapStudy   = find('Volume Weighted Average Price')
                   || find('VWAP')
                   || find('vwap')
                   || find('Anchored VWAP')
                   || find('Anchored');

  const cvd = cvdStudy
    ? parseFloat_(Object.values(cvdStudy.values || {})[0])
    : null;

  const oi = oiStudy
    ? parseFloat_(Object.values(oiStudy.values || {})[0])
    : null;

  let sessionVP = null;
  if (sessionStudy?.values) {
    const up   = parseFloat_(sessionStudy.values['Up']);
    const down = parseFloat_(sessionStudy.values['Down']);
    if (up != null && down != null) sessionVP = { up, down };
  }

  // Try named keys first ('VWAP', 'Value'), then fall back to first value
  const vwap = vwapStudy
    ? parseFloat_(
        vwapStudy.values?.['VWAP']
        ?? vwapStudy.values?.['Value']
        ?? Object.values(vwapStudy.values || {})[0]
      )
    : null;

  return { cvd, oi, sessionVP, vwap };
}

// ─── Change 3 cont.: Parse BOS/CHoCH from LuxAlgo labels ─────────────────────
// Scans all labels for BOS / CHoCH text. Returns the most recent event with
// its price and bullish/bearish characterisation so evaluateSetup can use it
// as a structure-confirmation criterion.
function parseBosChoch(labels, price) {
  if (!labels || !labels.length) return null;
  const events = labels.filter(l => {
    const t = (l.text || '').toUpperCase().replace(/\s/g, '');
    return t.includes('BOS') || t.includes('CHOCH');
  });
  if (!events.length) return null;
  const last  = events[events.length - 1];
  const text  = last.text || '';
  // If label has a y-coordinate, compare to price. Otherwise infer from text.
  const isBullish = last.price != null
    ? last.price < price        // label drawn below price = bullish structure
    : text.includes('+') || text.toUpperCase().includes('BULL');
  const isBOS   = text.toUpperCase().replace(/\s/g, '').includes('BOS');
  const isCHoCH = text.toUpperCase().replace(/\s/g, '').includes('CHOCH');
  return { text, price: last.price, isBullish, isBOS, isCHoCH };
}

// ─── Trigger Formula ─────────────────────────────────────────────────────────

function checkProximity(price, zone) {
  const zoneWidth      = zone.high - zone.low;
  const buffer         = Math.max(price * 0.005, zoneWidth * 1.5);
  const insideZone     = price >= zone.low && price <= zone.high;
  const distToTop      = Math.abs(price - zone.high);
  const distToBottom   = Math.abs(price - zone.low);
  const minDist        = Math.min(distToTop, distToBottom);
  const triggered      = insideZone || minDist <= buffer;
  return { triggered, insideZone, minDist, buffer };
}

// ─── VRVP Level Computation ───────────────────────────────────────────────────
// Takes raw histogram from VRVP_EXPR and returns structured trading levels.
//
// POC  — single bucket with highest volume (the "fair value" magnet)
// VAH  — value area high (70% of volume traded below this)
// VAL  — value area low  (70% of volume traded above this)
// HVNs — clustered high-volume zones (> 1.5× avg vol) — natural S/R
// LVNs — clustered low-volume zones (< 0.35× avg vol) — air pockets / fast moves
//
// HVN direction logic:
//   Price approaching HVN from ABOVE → expect support → long
//   Price approaching HVN from BELOW → expect resistance → short

function computeVRVPLevels(data) {
  if (!data || !data.rows || data.rows.length < 5) return null;

  const rows = data.rows;
  const totalVol = rows.reduce((s, r) => s + r.tv, 0);
  const avgVol   = totalVol / rows.length;

  // POC: max volume row from histogram (more precise than _data store)
  const pocRow = rows.reduce((best, r) => r.tv > best.tv ? r : best, rows[0]);
  const poc = Math.round((pocRow.lo + pocRow.hi) / 2);

  // VAH/VAL from study _data store (authoritative)
  const vah = data.vah != null ? Math.round(data.vah) : null;
  const val = data.val != null ? Math.round(data.val) : null;

  // Identify HVN and LVN rows (exclude outermost 2 rows to avoid edge noise)
  const inner = rows.slice(2, -2);
  const hvnRows = inner.filter(r => r.tv > avgVol * 1.5);
  const lvnRows = inner.filter(r => r.tv < avgVol * 0.35);

  // Cluster adjacent rows (within 50 pts) into single zones
  function cluster(rws) {
    if (!rws.length) return [];
    const out = [];
    let cur = { lo: rws[0].lo, hi: rws[0].hi, maxVol: rws[0].tv, upVol: rws[0].uv, downVol: rws[0].dv };
    for (let i = 1; i < rws.length; i++) {
      if (rws[i].lo <= cur.hi + 50) {
        cur.hi      = rws[i].hi;
        cur.maxVol  = Math.max(cur.maxVol, rws[i].tv);
        cur.upVol  += rws[i].uv;
        cur.downVol += rws[i].dv;
      } else {
        out.push(cur);
        cur = { lo: rws[i].lo, hi: rws[i].hi, maxVol: rws[i].tv, upVol: rws[i].uv, downVol: rws[i].dv };
      }
    }
    out.push(cur);
    return out;
  }

  const hvns = cluster(hvnRows).sort((a, b) => b.maxVol - a.maxVol).slice(0, 6);
  const lvns = cluster(lvnRows).sort((a, b) => a.maxVol - b.maxVol).slice(0, 5);

  return { poc, vah, val, hvns, lvns, pocRow, avgVol };
}

// ─── VRVP Proximity Check ─────────────────────────────────────────────────────
// Finds the nearest actionable VRVP level and determines setup direction.
// Returns null if no level is within the proximity buffer.
//
// Priority: VAL/VAH (value area boundaries) > HVN > POC
// Buffer: 0.35% of price (tighter than SMC 0.5% — VRVP levels are precise)

function checkVRVPProximity(price, levels) {
  if (!levels) return null;
  const { poc, vah, val, hvns } = levels;
  const buf = price * 0.0035;
  const candidates = [];

  // VAL — value area low (demand, expect support)
  if (val != null) {
    const dist = Math.abs(price - val);
    if (dist <= buf * 1.5 || (price >= val - buf && price <= val + buf * 3)) {
      candidates.push({ type: 'VAL', mid: val, lo: val - 30, hi: val + 30, direction: 'long', dist, priority: 10 });
    }
  }

  // VAH — value area high (supply, expect resistance; or breakout long if price above)
  if (vah != null) {
    const dist = Math.abs(price - vah);
    if (dist <= buf * 1.5) {
      const dir = price > vah + buf ? 'long' : 'short'; // above VAH = breakout long
      candidates.push({ type: 'VAH', mid: vah, lo: vah - 30, hi: vah + 30, direction: dir, dist, priority: 10 });
    }
  }

  // HVNs — high-volume nodes (approach from above = long support, from below = short resistance)
  for (const hvn of (hvns || [])) {
    const mid    = (hvn.lo + hvn.hi) / 2;
    const inside = price >= hvn.lo && price <= hvn.hi;
    const distLo = Math.abs(price - hvn.lo);
    const distHi = Math.abs(price - hvn.hi);
    const dist   = inside ? 0 : Math.min(distLo, distHi);
    if (inside || dist <= buf) {
      // Approaching from above: long (support). From below: short (resistance).
      const dir = price > mid ? 'long' : 'short';
      candidates.push({ type: 'HVN', mid: Math.round(mid), lo: hvn.lo, hi: hvn.hi, direction: dir, dist, priority: 7, upVol: hvn.upVol, downVol: hvn.downVol });
    }
  }

  // POC — mean reversion magnet (only trigger if nothing higher priority nearby)
  if (poc != null) {
    const dist = Math.abs(price - poc);
    if (dist <= buf * 0.7) {
      const dir = price > poc ? 'long' : 'short';
      candidates.push({ type: 'POC', mid: poc, lo: poc - 30, hi: poc + 30, direction: dir, dist, priority: 5 });
    }
  }

  if (!candidates.length) return null;

  // Sort by priority first, then distance
  candidates.sort((a, b) => b.priority - a.priority || a.dist - b.dist);
  return candidates[0];
}

// ─── Setup Evaluation ────────────────────────────────────────────────────────

function evaluateSetup(price, trigger, indicators, levels) {
  const { cvd, oi, sessionVP, vwap, oiTrend, macd4h, rsi12h, weeklyTrend } = indicators;
  const direction = trigger.direction;
  const criteria  = [];

  // 1. VRVP level type and context
  const levelDesc = {
    HVN: `HVN $${Math.round(trigger.lo).toLocaleString()}–$${Math.round(trigger.hi).toLocaleString()} — ${direction === 'long' ? 'demand wall (price above, expect support)' : 'supply wall (price below, expect resistance)'}`,
    VAL: `VAL $${Math.round(trigger.mid).toLocaleString()} — value area low, institutional demand zone`,
    VAH: direction === 'long' ? `VAH $${Math.round(trigger.mid).toLocaleString()} — breakout above value area, bullish expansion` : `VAH $${Math.round(trigger.mid).toLocaleString()} — value area high, institutional supply zone`,
    POC: `POC $${Math.round(trigger.mid).toLocaleString()} — mean reversion to fair value`,
  }[trigger.type] || `Level at $${Math.round(trigger.mid).toLocaleString()}`;
  criteria.push({ label: levelDesc, pass: true, auto: true });

  // 2. VRVP delta at the level (up vol vs down vol)
  if (trigger.type === 'HVN' && trigger.upVol != null) {
    const totalLevelVol = (trigger.upVol || 0) + (trigger.downVol || 0);
    const upPct = totalLevelVol > 0 ? Math.round(trigger.upVol / totalLevelVol * 100) : 50;
    const levelBullish = upPct > 55;
    const levelBearish = upPct < 45;
    const aligned = (direction === 'long' && levelBullish) || (direction === 'short' && levelBearish);
    criteria.push({
      label: `HVN delta: ${upPct}% bull / ${100 - upPct}% bear — ${levelBullish ? 'buyers dominated' : levelBearish ? 'sellers dominated' : 'balanced'}`,
      pass: aligned ? true : (levelBullish || levelBearish) ? false : null,
      auto: !!aligned || levelBullish || levelBearish,
    });
  }

  // 3. CVD alignment
  if (cvd != null) {
    const aligned = direction === 'short' ? cvd < 0 : cvd > 0;
    criteria.push({
      label: `CVD ${cvd > 0 ? '+' : ''}${Math.round(cvd)} (${cvd < 0 ? 'bearish' : 'bullish'})`,
      pass: aligned, auto: true,
    });
  } else {
    criteria.push({ label: 'CVD: unavailable', pass: null, auto: false });
  }

  // 4. Session VP
  if (sessionVP) {
    const sessionBearish = sessionVP.down > sessionVP.up;
    const sessionBullish = sessionVP.up > sessionVP.down;
    const aligned = direction === 'short' ? sessionBearish : sessionBullish;
    criteria.push({
      label: `Session VP ${sessionVP.up}↑ / ${sessionVP.down}↓ (${sessionBearish ? 'bearish' : sessionBullish ? 'bullish' : 'neutral'})`,
      pass: aligned, auto: true,
    });
  }

  // 5. VWAP
  if (vwap != null) {
    const belowVwap = price < vwap;
    const aligned = direction === 'short' ? belowVwap : !belowVwap;
    criteria.push({
      label: `VWAP $${Math.round(vwap).toLocaleString()} — price is ${belowVwap ? 'below' : 'above'}`,
      pass: aligned, auto: true,
    });
  }

  // 6. OI trend
  if (oiTrend && oiTrend !== 'flat') {
    const oiRising = oiTrend === 'rising';
    const aligned = direction === 'long' ? oiRising : !oiRising;
    criteria.push({
      label: `OI ${oiTrend} — ${oiRising ? 'conviction' : 'caution/liquidation'}`,
      pass: aligned, auto: true,
    });
  } else if (oiTrend === 'flat') {
    criteria.push({ label: 'OI flat — no directional conviction yet', pass: null, auto: false });
  } else {
    criteria.push({ label: `OI ${oi != null ? oi.toFixed(2) : 'n/a'} — first run`, pass: null, auto: false });
  }

  // 7. 4H MACD
  if (macd4h) {
    const aligned = direction === 'long' ? macd4h.bullish : !macd4h.bullish;
    criteria.push({
      label: `4H MACD ${macd4h.bullish ? 'bullish' : 'bearish'} (hist ${macd4h.histogram > 0 ? '+' : ''}${Math.round(macd4h.histogram)})`,
      pass: aligned, auto: true,
    });
  } else {
    criteria.push({ label: '4H MACD — unavailable', pass: null, auto: false });
  }

  // 8. 12H RSI
  if (rsi12h != null) {
    const aboveMid = rsi12h > 50;
    const aligned = direction === 'long' ? aboveMid : !aboveMid;
    criteria.push({
      label: `12H RSI ${Math.round(rsi12h)} (${aboveMid ? 'above' : 'below'} 50)`,
      pass: aligned, auto: true,
    });
  } else {
    criteria.push({ label: '12H RSI — unavailable', pass: null, auto: false });
  }

  // 9. Weekly trend regime
  if (weeklyTrend && weeklyTrend !== 'neutral') {
    const trendAligned = (direction === 'long' && weeklyTrend === 'uptrend')
                      || (direction === 'short' && weeklyTrend === 'downtrend');
    criteria.push({
      label: `Weekly trend: ${weeklyTrend} — ${trendAligned ? 'with trend ✓' : 'COUNTER-TREND ⚠'}`,
      pass: trendAligned, auto: true,
    });
  } else if (weeklyTrend === 'neutral') {
    criteria.push({ label: 'Weekly trend: neutral / ranging', pass: null, auto: false });
  }

  // ─── Levels (TP targets from VRVP) ───────────────────────────────────────
  const buf = 0.002;
  let entry, stop, tp1Price, tp2Price, tp3Price;

  if (direction === 'short') {
    entry = Math.round(trigger.hi - (trigger.hi - trigger.lo) * 0.2);
    stop  = Math.round(trigger.hi * (1 + buf));
    const riskPts = stop - entry;
    // TPs: HVNs below current price, sorted closest first
    const targets = (levels?.hvns || [])
      .filter(h => h.hi < price - 100)
      .sort((a, b) => b.hi - a.hi);
    const valTarget = levels?.val != null && levels.val < price - 100 ? levels.val : null;
    tp1Price = Math.round(targets[0]?.hi ?? valTarget ?? (entry - riskPts));
    tp2Price = Math.round(targets[1]?.hi ?? (entry - riskPts * 2));
    tp3Price = Math.round(entry - riskPts * 3);
  } else {
    entry = Math.round(trigger.lo + (trigger.hi - trigger.lo) * 0.2);
    stop  = Math.round(trigger.lo * (1 - buf));
    const riskPts = entry - stop;
    // TPs: HVNs above current price, sorted closest first
    const targets = (levels?.hvns || [])
      .filter(h => h.lo > price + 100)
      .sort((a, b) => a.lo - b.lo);
    const vahTarget = levels?.vah != null && levels.vah > price + 100 ? levels.vah : null;
    tp1Price = Math.round(targets[0]?.lo ?? vahTarget ?? (entry + riskPts));
    tp2Price = Math.round(targets[1]?.lo ?? (entry + riskPts * 2));
    tp3Price = Math.round(entry + riskPts * 3);
  }

  const riskPts = Math.abs(entry - stop);
  const rr1 = riskPts > 0 ? (Math.abs(tp1Price - entry) / riskPts).toFixed(1) : '?';
  const rr2 = riskPts > 0 ? (Math.abs(tp2Price - entry) / riskPts).toFixed(1) : '?';
  const rr3 = riskPts > 0 ? (Math.abs(tp3Price - entry) / riskPts).toFixed(1) : '?';

  // --- Setup classification ---
  const autoPassed = criteria.filter(c => c.auto && c.pass === true).length;
  const autoFailed = criteria.filter(c => c.auto && c.pass === false).length;
  const autoTotal  = criteria.filter(c => c.auto).length;

  let setupType, probability;
  if (autoPassed === autoTotal && autoTotal >= 3) {
    setupType = 'A — Full Confluence'; probability = '~70%';
  } else if (autoPassed >= autoTotal * 0.6) {
    setupType = 'B — Partial Confluence'; probability = '~60%';
  } else {
    setupType = 'C — Low Confluence'; probability = '~48%';
  }

  return {
    direction, entry, stop, tp1Price, tp2Price, tp3Price,
    rr1, rr2, rr3, criteria, autoPassed, autoFailed, autoTotal,
    levelType: trigger.type, setupType, probability,
  };
}

// ─── Discord Message Formatter ────────────────────────────────────────────────

function formatSetupMessage(price, trigger, setup) {
  const { direction, entry, stop, tp1Price, tp2Price, tp3Price, rr1, rr2, rr3,
          criteria, autoPassed, autoTotal, levelType, setupType, probability } = setup;
  const dirLabel = direction === 'short' ? '🔴 SHORT' : '🟢 LONG';
  const triggerLine = direction === 'short'
    ? 'Wait for 30M bearish confirmation below level'
    : 'Wait for 30M bullish confirmation above level';
  const invalidation = direction === 'short'
    ? `4H close above $${stop.toLocaleString()}`
    : `4H close below $${stop.toLocaleString()}`;
  const levelStr = `$${Math.round(trigger.lo).toLocaleString()}–$${Math.round(trigger.hi).toLocaleString()}`;
  const alertLevels = [
    `$${Math.round(trigger.mid).toLocaleString()} (${levelType})`,
    `$${stop.toLocaleString()} (stop)`,
    `$${tp1Price.toLocaleString()} (TP1)`,
  ].join(' | ');

  const probNum = parseInt(probability, 10);
  const probLabel = probNum >= 70 ? 'High' : probNum >= 60 ? 'Moderate' : probNum >= 50 ? 'Low' : 'Poor';

  const criteriaLines = criteria.map(c => {
    const icon = c.pass === true ? '✅' : c.pass === false ? '❌' : '⚠️';
    return `${icon} ${c.label}`;
  }).join('\n');

  const ts = new Date().toLocaleString('en-US', { timeZone: 'UTC', hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return [
    `${dirLabel} SIGNAL | BINANCE:BTCUSDT.P | ${ts} UTC`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `**Price** $${Math.round(price).toLocaleString()} | **${levelType}** ${levelStr}`,
    `**Setup** ${setupType} | **Win Rate** ${probability} (${probLabel})`,
    ``,
    `**ENTRY**  $${entry.toLocaleString()}`,
    `**STOP**   $${stop.toLocaleString()}`,
    `**TP1**    $${tp1Price.toLocaleString()} — 1:${rr1}`,
    `**TP2**    $${tp2Price.toLocaleString()} — 1:${rr2}`,
    `**TP3**    $${tp3Price.toLocaleString()} — 1:${rr3}`,
    ``,
    `**TRIGGER**  ${triggerLine}`,
    ``,
    `**CRITERIA** (${autoPassed}/${autoTotal} auto-confirmed)`,
    criteriaLines,
    ``,
    `**INVALIDATION**  ${invalidation}`,
    ``,
    `**SET ALERTS**  ${alertLevels}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 React with 📊 for deep MTF analysis`,
  ].join('\n');
}

// ─── Cooldown / Alert State ───────────────────────────────────────────────────
//
// State file format (VRVP era):
//   { "hvn-72993": { ts: 1234567890, direction: "long", levelType: "HVN", levelMid: 72993, levelLo: 72780, levelHi: 73200 },
//     "_previousOI": 91.38 }
//
// Keys prefixed with "_" are internal (OI tracking etc.), not level entries.

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function isCoolingDown(zoneKey) {
  try {
    const entry = readState()[zoneKey];
    if (!entry) return false;
    const ts = typeof entry === 'number' ? entry : entry.ts; // handle legacy format
    return (Date.now() - ts) < COOLDOWN_MS;
  } catch { return false; }
}

function markAlerted(levelKey, direction, trigger) {
  const state = readState();
  state[levelKey] = {
    ts:        Date.now(),
    direction,
    levelType: trigger.type,
    levelMid:  trigger.mid,
    levelLo:   trigger.lo,
    levelHi:   trigger.hi,
  };
  writeState(state);
}

// When OI is flat or unknown at alert time, register the zone for automatic
// confirmation detection. On each subsequent tick, checkPendingConfirmation()
// compares current OI and CVD against the baseline captured here. When both
// confirm, it fires a TRIGGER CONFIRMED Discord alert without waiting for the
// next manual analysis run, bypassing the cooldown gate entirely.
function markPending(levelKey, direction, trigger, indicators) {
  const state = readState();
  const key = `_pending_${levelKey}`;
  state[key] = {
    ts:          Date.now(),
    direction,
    levelType:   trigger.type,
    levelMid:    trigger.mid,
    levelLo:     trigger.lo,
    levelHi:     trigger.hi,
    expires:     Date.now() + PENDING_TTL_MS,
    baselineOI:  indicators.oi,
    baselineCVD: indicators.cvd,
  };
  writeState(state);
  log(`Level ${levelKey} → pending confirmation (baseline OI: ${indicators.oi}, CVD: ${indicators.cvd})`);
}

// ─── Invalidation Check ───────────────────────────────────────────────────────
//
// Called every poll. For each alerted VRVP level in state, checks whether price
// has moved significantly (0.8%) THROUGH the level mid — meaning the level has
// been broken. Unlike LuxAlgo zones, VRVP levels don't disappear; we infer
// invalidation from price action.
//
// Verdict logic:
//   Real break   : CVD confirms break direction AND OI rising → continuation
//   High-vol break: volume > 2× avg AND OI rising → breakout mode
//   Stop hunt    : neither — ~63% reversal probability

function checkInvalidations(price, indicators) {
  const { cvd, oiTrend, volumes } = indicators;
  const state = readState();
  const messages = [];

  const vols      = Array.isArray(volumes) ? volumes : [];
  const recentVol = vols[vols.length - 1] || 0;
  const avgVol    = vols.length > 1
    ? vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1)
    : 0;
  const isHighVolBreak = avgVol > 0 && recentVol > avgVol * 2;

  for (const [key, entry] of Object.entries(state)) {
    if (key.startsWith('_')) continue;
    if (typeof entry !== 'object' || !entry.direction || !entry.levelMid) continue;

    const { direction, levelMid, levelLo, levelHi, levelType } = entry;

    // Has price broken significantly through the level? (0.8% beyond midpoint)
    const BREAK_PCT = 0.008;
    const isLevelBroken = direction === 'long'
      ? price < levelMid - levelMid * BREAK_PCT   // support broken — price fell through
      : price > levelMid + levelMid * BREAK_PCT;  // resistance broken — price pushed through

    if (!isLevelBroken) continue;

    const cvdConfirmsBreak = direction === 'long' ? (cvd != null && cvd < 0) : (cvd != null && cvd > 0);
    const oiExpanding      = oiTrend === 'rising';
    const isRealBreak      = (cvdConfirmsBreak && oiExpanding) || (isHighVolBreak && oiExpanding);
    const isBreakoutMode   = isHighVolBreak && oiExpanding && !cvdConfirmsBreak;

    log(`Level ${key} broken | price $${Math.round(price)} vs mid $${Math.round(levelMid)} | CVD confirms: ${cvdConfirmsBreak} | OI expanding: ${oiExpanding} | high-vol: ${isHighVolBreak} | verdict: ${isRealBreak ? (isBreakoutMode ? 'BREAKOUT' : 'REAL BREAK') : 'STOP HUNT'}`);

    if (isRealBreak) {
      const trades = readTrades();
      for (const t of trades) {
        if (t.outcome !== null) continue;
        if (Math.abs((t.zone?.mid ?? 0) - levelMid) < 50) {
          t.outcome = 'invalidated'; t.closedAt = new Date().toISOString(); t.pnlR = -1.0;
          log(`Trade for level ${key} marked invalidated`);
        }
      }
      writeTrades(trades);
    }

    const trig = { type: levelType || 'Level', mid: levelMid, lo: levelLo ?? levelMid - 30, hi: levelHi ?? levelMid + 30 };
    messages.push({
      msg:  formatInvalidationMessage(price, direction, trig, isRealBreak, cvd, cvdConfirmsBreak, oiTrend, oiExpanding, isBreakoutMode, recentVol, avgVol),
      type: isRealBreak ? 'info' : 'approaching',
    });

    delete state[key];

    if (!isRealBreak) {
      const stophuntMsg = formatStopHuntEscalation(price, direction, trig, cvd, oiTrend);
      messages.push({ msg: stophuntMsg, type: 'approaching' });

      const watchKey = `_watch_${key}`;
      state[watchKey] = { ts: Date.now(), direction, levelType, levelMid, levelLo, levelHi, expires: Date.now() + 4 * 60 * 60 * 1000 };
      state[key] = { ts: Date.now() - (COOLDOWN_MS - 30 * 60 * 1000), direction, levelType, levelMid, levelLo, levelHi };
      log(`Level ${key} → stop hunt | re-entry alert fired | cooldown reset to 30m`);
    }
  }

  writeState(state);
  return messages;
}

// ─── Stop Hunt Re-entry Alert Formatter ──────────────────────────────────────
function formatStopHuntEscalation(price, direction, trig, cvd, oiTrend) {
  const levelStr  = `$${Math.round(trig.lo).toLocaleString()}–$${Math.round(trig.hi).toLocaleString()}`;
  const dirLabel  = direction === 'long' ? 'LONG' : 'SHORT';
  const cvdLabel  = cvd != null ? `${cvd > 0 ? '+' : ''}${Math.round(cvd)} (${cvd < 0 ? 'bearish' : 'bullish'})` : 'n/a';
  const reclaim   = direction === 'long'
    ? `Watch for 30M bullish CVD + OI confirmation above $${Math.round(trig.lo).toLocaleString()}`
    : `Watch for 30M bearish CVD + OI confirmation below $${Math.round(trig.hi).toLocaleString()}`;
  const entryNote = direction === 'long'
    ? `Re-entry: ${trig.type} top $${Math.round(trig.hi).toLocaleString()} on order flow confirmation`
    : `Re-entry: ${trig.type} bottom $${Math.round(trig.lo).toLocaleString()} on order flow confirmation`;

  return [
    `🎯 STOP HUNT DETECTED — ${dirLabel} RE-ENTRY | BTCUSDT.P`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `**Price** $${Math.round(price).toLocaleString()} | **${trig.type}** ${levelStr}`,
    `${trig.type} swept with low conviction — probable stop hunt, ~63% reversal probability.`,
    ``,
    `**ORDER FLOW AT SWEEP**`,
    `CVD: ${cvdLabel} — ${direction === 'long' ? 'no bear conviction on the break' : 'no bull conviction on the break'}`,
    `OI: ${oiTrend ?? 'flat'} — ${oiTrend === 'rising' ? 'some positioning present' : 'no new positions — likely liquidation-driven'}`,
    ``,
    `**WATCH**  ${reclaim}`,
    `**RE-ENTRY**  ${entryNote}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 React with 📊 for deep MTF analysis`,
  ].join('\n');
}

function formatInvalidationMessage(price, direction, trig, isRealBreak, cvd, cvdConfirmsBreak, oiTrend, oiExpanding, isBreakoutMode, recentVol, avgVol) {
  const levelStr  = `$${Math.round(trig.lo).toLocaleString()}–$${Math.round(trig.hi).toLocaleString()}`;
  const dirLabel  = direction === 'long' ? 'LONG' : 'SHORT';

  const cvdIcon  = cvdConfirmsBreak ? '❌' : '✅';
  const oiIcon   = oiExpanding      ? '❌' : '✅';
  const cvdLabel = cvd != null ? `${cvd > 0 ? '+' : ''}${Math.round(cvd)} (${cvd < 0 ? 'bearish' : 'bullish'})` : 'unavailable';
  const oiLabel  = oiTrend ?? 'unavailable';
  const nextLevelStr = 'Check VRVP for next HVN/VAL/VAH';

  if (isRealBreak) {
    const breakoutNote = isBreakoutMode && recentVol && avgVol
      ? `⚡ HIGH-VOLUME BREAKOUT — vol ${Math.round(recentVol).toLocaleString()} (${(recentVol / avgVol).toFixed(1)}× avg). Level consumed as S/R flip.`
      : `Price broke through with institutional CVD + OI confirmation. Not a stop hunt.`;
    const breakoutAction = isBreakoutMode
      ? `Watch for ${direction === 'long' ? 'bearish' : 'bullish'} continuation — ${levelStr} now flipped ${direction === 'long' ? 'resistance' : 'support'}.`
      : `Identify the next key ${direction === 'long' ? 'demand' : 'supply'} zone on VRVP.`;

    return [
      `🚫 SIGNAL INVALIDATED${isBreakoutMode ? ' — BREAKOUT MODE' : ''} | BINANCE:BTCUSDT.P`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `**Price** $${Math.round(price).toLocaleString()} | **${trig.type}** ${levelStr} broken`,
      ``,
      `**VERDICT**  Real break — ${dirLabel} thesis is off`,
      breakoutNote,
      ``,
      `**ORDER FLOW AT BREAK**`,
      `${cvdIcon} CVD ${cvdLabel}`,
      `${oiIcon} OI ${oiLabel} — new positions, real conviction`,
      ``,
      `**NEXT LEVEL**  ${nextLevelStr}`,
      `**ACTION**  ${breakoutAction}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📊 React with 📊 for deep MTF analysis`,
    ].join('\n');
  } else {
    const watchAction = direction === 'long'
      ? `If price reclaims $${Math.round(trig.lo).toLocaleString()} with rising CVD → long still viable`
      : `If price reclaims $${Math.round(trig.hi).toLocaleString()} with falling CVD → short still viable`;
    return [
      `⚠️ LEVEL BROKEN — POSSIBLE STOP HUNT | BINANCE:BTCUSDT.P`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `**Price** $${Math.round(price).toLocaleString()} | **${trig.type}** ${levelStr} broken`,
      ``,
      `**VERDICT**  Ambiguous — possible stop hunt (~63% reversal probability)`,
      `Low conviction on the break. Institutional confirmation absent.`,
      ``,
      `**ORDER FLOW AT BREAK**`,
      `${cvdIcon} CVD ${cvdLabel}`,
      `${oiIcon} OI ${oiLabel} — ${oiExpanding ? 'new positioning present' : 'no new positioning / liquidation driven'}`,
      ``,
      `**WATCH**  ${watchAction}`,
      `**NEXT LEVEL**  ${nextLevelStr}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📊 React with 📊 for deep MTF analysis`,
    ].join('\n');
  }
}

// ─── Reclaim Watch ────────────────────────────────────────────────────────────
//
// After an ambiguous invalidation, watches for price to reclaim the zone with
// confirming order flow. Fires a RECLAIM CONFIRMED alert if:
//   - Price is back inside or within buffer of the original zone
//   - CVD is aligned with the original trade direction (bullish for long, bearish for short)
//   - OI is rising (new positioning, not a dead-cat bounce)
//
// Watch expires after 4 hours. If not reclaimed, the thesis is abandoned.

function checkReclaimWatch(price, indicators) {
  const { cvd, oiTrend } = indicators;
  const state = readState();
  const messages = [];

  for (const [key, watch] of Object.entries(state)) {
    if (!key.startsWith('_watch_')) continue;

    if (Date.now() > watch.expires) {
      log(`Reclaim watch ${key} expired — removing`);
      delete state[key];
      continue;
    }

    const { direction, levelMid, levelLo, levelHi, levelType } = watch;
    if (!levelMid) continue; // skip legacy entries without VRVP fields

    // Price returned near the level — within 0.5% of mid
    const nearLevel = Math.abs(price - levelMid) <= levelMid * 0.005;
    if (!nearLevel) continue;

    const cvdAligned = direction === 'long' ? (cvd != null && cvd > 0) : (cvd != null && cvd < 0);
    const oiAligned  = oiTrend === 'rising';

    if (cvdAligned && oiAligned) {
      const levelStr = `$${Math.round(levelLo ?? levelMid - 30).toLocaleString()}–$${Math.round(levelHi ?? levelMid + 30).toLocaleString()}`;
      const dirLabel = direction === 'long' ? 'LONG' : 'SHORT';
      const cvdLabel = `${cvd > 0 ? '+' : ''}${Math.round(cvd)} (${cvd < 0 ? 'bearish' : 'bullish'})`;
      log(`Reclaim confirmed: ${dirLabel} ${levelType} ${levelStr} | CVD ${cvdLabel} | OI ${oiTrend}`);

      const reclaimEntry = direction === 'long'
        ? `$${Math.round(levelHi ?? levelMid + 30).toLocaleString()} (${levelType ?? 'level'} top)`
        : `$${Math.round(levelLo ?? levelMid - 30).toLocaleString()} (${levelType ?? 'level'} bottom)`;
      const reclaimStop = direction === 'long'
        ? `$${Math.round((levelLo ?? levelMid - 30) * 0.998).toLocaleString()} (below level)`
        : `$${Math.round((levelHi ?? levelMid + 30) * 1.002).toLocaleString()} (above level)`;
      messages.push([
        `🔄 RECLAIM CONFIRMED | BINANCE:BTCUSDT.P`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `**Price** $${Math.round(price).toLocaleString()} | **${levelType ?? 'Level'}** ${levelStr}`,
        `Price returned to ${dirLabel} ${levelType ?? 'level'} with institutional backing. Original thesis back in play.`,
        ``,
        `**ORDER FLOW AT RECLAIM**`,
        `✅ CVD ${cvdLabel}`,
        `✅ OI ${oiTrend} — new positioning confirming the reclaim`,
        ``,
        `**ENTRY**   ${reclaimEntry}`,
        `**STOP**    ${reclaimStop}`,
        `**TRIGGER** 30M ${direction === 'long' ? 'bullish' : 'bearish'} close with CVD confirmation`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📊 React with 📊 for deep MTF analysis`,
      ].join('\n'));

      delete state[key];
      const levelKey = key.replace('_watch_', '');
      state[levelKey] = { ts: Date.now(), direction, levelType, levelMid, levelLo, levelHi };
    } else {
      log(`Reclaim watch ${key}: price near level but order flow not confirming (CVD aligned: ${cvdAligned}, OI aligned: ${oiAligned})`);
    }
  }

  writeState(state);
  return messages;
}

// ─── Pending Confirmation Watch ──────────────────────────────────────────────
//
// When an initial zone alert fires with flat OI (no conviction yet), the zone
// is written to state as "_pending_<zoneKey>". Every subsequent tick (now every
// 10 minutes) this function checks whether OI has risen ≥ 0.5% AND CVD has
// grown ≥ 1.5× (minimum +200 absolute) from the values saved at alert time.
//
// When both conditions are met it means institutional money started moving
// AFTER the initial alert — exactly the scenario that caused today's missed
// trade. The function fires a TRIGGER CONFIRMED Discord alert with a Claude
// prompt embedded, bypasses the normal cooldown gate, and resets the cooldown
// so the zone does not fire a third time immediately.
//
// Pending watch expires after 90 minutes. If not confirmed in that window the
// zone is removed (the move didn't materialise).

function checkPendingConfirmation(price, indicators) {
  const { cvd, oi } = indicators;
  const state = readState();
  const results = [];

  for (const [key, pending] of Object.entries(state)) {
    if (!key.startsWith('_pending_')) continue;

    // Expire stale watches
    if (Date.now() > pending.expires) {
      log(`Pending confirmation ${key} expired — removing`);
      delete state[key];
      continue;
    }

    const { direction, levelType, levelMid, levelLo, levelHi, baselineOI, baselineCVD } = pending;
    const high = levelHi ?? levelMid + 30;
    const low  = levelLo ?? levelMid - 30;

    // OI confirmation: must have risen ≥ 0.5% from the baseline snapshot
    const oiConfirmed = oi != null && baselineOI != null && baselineOI > 0
      && (oi - baselineOI) / baselineOI >= OI_CONFIRM_PCT;

    // CVD confirmation: must be directionally aligned, grown ≥ 1.5× AND grown
    // by at least CVD_CONFIRM_MIN absolute units (prevents trivial passes when
    // baseline CVD is near zero)
    const cvdAligned  = direction === 'long' ? (cvd != null && cvd > 0) : (cvd != null && cvd < 0);
    const cvdDelta    = cvd != null && baselineCVD != null ? Math.abs(cvd - baselineCVD) : 0;
    const cvdGrown    = cvdAligned
      && cvdDelta >= CVD_CONFIRM_MIN
      && Math.abs(cvd ?? 0) >= Math.abs(baselineCVD ?? 0) * CVD_CONFIRM_MULT;

    log(`Pending ${key}: OI ${baselineOI}→${oi} confirmed=${oiConfirmed} | CVD ${baselineCVD}→${cvd} delta=${Math.round(cvdDelta)} confirmed=${cvdGrown}`);

    if (!oiConfirmed || !cvdGrown) continue;

    // ── Both confirmed — fire the alert ──────────────────────────────────────
    const zoneStr  = `$${Math.round(low).toLocaleString()}–$${Math.round(high).toLocaleString()}`;
    const dirLabel = direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
    const oiPct    = baselineOI > 0 ? ((oi - baselineOI) / baselineOI * 100).toFixed(2) : '?';
    const cvdBase  = baselineCVD != null ? (baselineCVD > 0 ? '+' : '') + Math.round(baselineCVD) : 'n/a';
    const cvdNow   = cvd        != null ? (cvd        > 0 ? '+' : '') + Math.round(cvd)        : 'n/a';
    const cvdDeltaStr = cvdDelta > 0 ? `+${Math.round(cvdDelta)}` : Math.round(cvdDelta);

    const msg = [
      `${dirLabel} TRIGGER CONFIRMED | BINANCE:BTCUSDT.P`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `**Price** $${Math.round(price).toLocaleString()} | **Zone** ${zoneStr}`,
      `Flat OI at initial alert has now confirmed. Institutional flow entered after the signal — this is the real entry.`,
      ``,
      `**CONFIRMATION ORDER FLOW**`,
      `✅ OI: ${baselineOI?.toFixed(2)}K → ${oi?.toFixed(2)}K (+${oiPct}%) — new ${direction} positions opening`,
      `✅ CVD: ${cvdBase} → ${cvdNow} (Δ ${cvdDeltaStr}) — conviction surge confirmed`,
      ``,
      `**ENTRY**  Pullback to zone top $${Math.round(high).toLocaleString()} or aggressive at market`,
      `**STOP**   $${Math.round(low * (1 - 0.002)).toLocaleString()} (below zone low)`,
      `**ACTION** Check 30M for CHoCH — if not fired yet, it is imminent`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📊 React with 📊 for deep MTF analysis`,
    ].join('\n');

    // Remove pending state, refresh the level's cooldown timestamp
    delete state[key];
    const levelKey = key.replace('_pending_', '');
    state[levelKey] = { ts: Date.now(), direction, levelType, levelMid, levelLo: low, levelHi: high };

    results.push({ msg, direction });
    log(`Pending ${key} CONFIRMED — firing ${dirLabel} alert`);
  }

  writeState(state);
  return results;
}

// ─── Confirmation Tracking ────────────────────────────────────────────────────
//
// A signal fires when price APPROACHES a VRVP level with order flow alignment.
// The actual trade trigger is "wait for 30M close above entry" — this function
// detects when that close happens and stamps the trade as confirmed.
//
// Confirmed trades are separated from unconfirmed in the weekly report.
// This is the single most important filter: if confirmed signals have a much
// higher win rate than all signals, the confirmation bar is doing real work.
//
// Confirmation logic:
//   Long:  a 30M bar closes ABOVE entry price  (close > entry)
//   Short: a 30M bar closes BELOW entry price  (close < entry)
//
// The bar must be AFTER firedAt. CVD is checked from current indicators —
// not per-bar — which is a simplification, but directional CVD is the most
// persistent of the indicators and directionally correct at confirmation time.

async function checkConfirmation(client, indicators) {
  const trades = readTrades();
  const unconfirmed = trades.filter(t => !t.confirmed && t.outcome === null);
  if (unconfirmed.length === 0) return;

  // Fetch recent 30M bars (already on 30M from outcome check above)
  const bars = await cdpEval(client, buildOHLCVExpr(96)).catch(() => []); // 48h of 30M bars
  if (!bars || bars.length === 0) return;

  let changed = false;

  for (const t of unconfirmed) {
    const signalTs = new Date(t.firedAt).getTime() / 1000;
    const relevantBars = bars.filter(b => b.time > signalTs);
    if (relevantBars.length === 0) continue;

    const cvdAligned = t.direction === 'long'
      ? (indicators.cvd != null && indicators.cvd > 0)
      : (indicators.cvd != null && indicators.cvd < 0);

    for (const bar of relevantBars) {
      const closeConfirms = t.direction === 'long'
        ? bar.close > t.entry
        : bar.close < t.entry;

      if (closeConfirms && cvdAligned) {
        t.confirmed      = true;
        t.confirmedAt    = new Date(bar.time * 1000).toISOString();
        t.confirmedPrice = bar.close;
        changed = true;
        log(`Trade ${t.id} CONFIRMED — 30M close ${bar.close} ${t.direction === 'long' ? 'above' : 'below'} entry ${t.entry}`);
        break;
      }
    }
  }

  if (changed) writeTrades(trades);
}

// ─── Trade Log ───────────────────────────────────────────────────────────────
//
// trades.json schema (array of trade objects):
// {
//   id:             "1744000000000-HVN-72993"    unique: ts + level type + mid
//   firedAt:        ISO timestamp
//   direction:      "long" | "short"
//   setupType:      "A — Full Confluence" etc.
//   price:          72800                          price when alert fired
//   zone:           { mid: 72993, high: 73200, low: 72780, type: "HVN" }
//   entry:          72826
//   stop:           70329
//   tp1:            71580,  tp2: 73400,  tp3: 71881
//   rr1:            "2.2",  rr2: "6.9",  rr3: "3.0"
//   criteria:       [ { label, pass, auto } ... ]  snapshot of criteria at signal time
//   indicators:     { cvd, oi, oiTrend, vwap, macd4hBullish, rsi12h }
//   confirmed:      false | true   — 30M close above entry with +CVD happened
//   confirmedAt:    null | ISO timestamp
//   confirmedPrice: null | number
//   outcome:        null | "tp1" | "tp2" | "tp3" | "stop" | "invalidated" | "expired"
//   closedAt:       null | ISO timestamp
//   pnlR:           null | number   (R-multiple: 1.0 = hit TP1, -1.0 = stopped out, etc.)
// }

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; }
}

function writeTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function logTrade(price, trigger, setup) {
  const trades = readTrades();
  const id = `${Date.now()}-${trigger.type}-${Math.round(trigger.mid)}`;
  trades.push({
    id,
    firedAt:    new Date().toISOString(),
    direction:  setup.direction,
    setupType:  setup.setupType,
    probability: setup.probability,
    price:      Math.round(price),
    zone:       { mid: trigger.mid, high: trigger.hi, low: trigger.lo, type: trigger.type },
    entry:      setup.entry,
    stop:       setup.stop,
    tp1:        setup.tp1Price, tp2: setup.tp2Price, tp3: setup.tp3Price,
    rr1:        setup.rr1,     rr2: setup.rr2,      rr3: setup.rr3,
    criteria:   setup.criteria.map(c => ({ label: c.label, pass: c.pass, auto: c.auto })),
    indicators: {
      cvd:           setup._cvd     ?? null,
      oi:            setup._oi      ?? null,
      oiTrend:       setup._oiTrend ?? null,
      vwap:          setup._vwap    ?? null,
      macd4hBullish: setup._macd4h  != null ? setup._macd4h.bullish : null,
      rsi12h:        setup._rsi12h  != null ? Math.round(setup._rsi12h) : null,
    },
    // Confirmation tracking — did the 30M trigger bar actually close above entry?
    // Populated by checkConfirmation() on subsequent polls, not at signal time.
    confirmed:       false,
    confirmedAt:     null,
    confirmedPrice:  null,
    outcome:  null,
    closedAt: null,
    pnlR:     null,
  });
  writeTrades(trades);
  log(`Trade logged: ${id}`);
}

// ─── Bar-accurate outcome detection ──────────────────────────────────────────
//
// Replaces spot-price polling. For each open trade, fetches 30M OHLCV bars
// from the bar AFTER the signal fired up to now, then walks bar-by-bar:
//
//   Long:  if bar.low <= stop  → LOSS  (stop hit before TP on ambiguous bars)
//          elif bar.high >= tp1/tp2/tp3 → WIN at highest TP reached
//
//   Short: if bar.high >= stop → LOSS
//          elif bar.low <= tp1/tp2/tp3  → WIN at lowest TP reached
//
// On a bar where BOTH stop and a TP are crossed (a big candle), stop wins —
// conservative but honest. This prevents phantom TP hits on stop-out candles.
//
// Bars since signal: capped at 336 (7 days × 48 × 30M bars) — more than enough
// for any trade to resolve. Older open trades expire after 30 days as before.

async function updateOutcomes(client) {
  const trades = readTrades();
  let changed = false;

  // Collect open trades that need checking
  const open = trades.filter(t => t.outcome === null);
  if (open.length === 0) return;

  // Switch to 30M and fetch enough bars to cover all open trades
  // (we always work on the 30M timeframe for outcome detection)
  const originalTF = await cdpEval(client, GET_TF_EXPR).catch(() => '30');
  await cdpEval(client, buildSetTFExpr('30'));
  await new Promise(r => setTimeout(r, 800));

  // Fetch last 336 bars (7 days of 30M) — raw OHLCV
  const bars = await cdpEval(client, buildOHLCVExpr(336)).catch(() => []);

  // Restore original timeframe
  if (originalTF && originalTF !== '30') {
    await cdpEval(client, buildSetTFExpr(originalTF));
  }

  if (!bars || bars.length === 0) {
    log('updateOutcomes: no bar data returned — skipping this cycle');
    return;
  }

  for (const t of trades) {
    if (t.outcome !== null) continue;

    // Expire after 30 days
    const age = Date.now() - new Date(t.firedAt).getTime();
    if (age > 30 * 24 * 60 * 60 * 1000) {
      t.outcome  = 'expired';
      t.closedAt = new Date().toISOString();
      t.pnlR     = 0;
      changed    = true;
      log(`Trade ${t.id} expired (30 days, no outcome)`);
      continue;
    }

    // Only look at bars that closed AFTER the signal fired
    const signalTs = new Date(t.firedAt).getTime() / 1000; // seconds
    const relevantBars = bars.filter(b => b.time > signalTs);
    if (relevantBars.length === 0) continue;

    const stop = t.stop;
    const tp1  = t.tp1;
    const tp2  = t.tp2;
    const tp3  = t.tp3;
    const rr1  = parseFloat(t.rr1);
    const rr2  = parseFloat(t.rr2);
    const rr3  = parseFloat(t.rr3);

    let outcome = null;
    let pnlR    = null;
    let closedBarTime = null;

    for (const bar of relevantBars) {
      if (t.direction === 'long') {
        const stopHit = bar.low  <= stop;
        const tp3Hit  = bar.high >= tp3;
        const tp2Hit  = bar.high >= tp2;
        const tp1Hit  = bar.high >= tp1;

        if (stopHit && !tp1Hit) {
          // Stop hit, no TP reached on this bar
          outcome = 'stop'; pnlR = -1.0; closedBarTime = bar.time; break;
        } else if (tp3Hit) {
          outcome = 'tp3'; pnlR = rr3; closedBarTime = bar.time; break;
        } else if (tp2Hit) {
          outcome = 'tp2'; pnlR = rr2; closedBarTime = bar.time; break;
        } else if (tp1Hit) {
          outcome = 'tp1'; pnlR = rr1; closedBarTime = bar.time; break;
        } else if (stopHit) {
          // Both stop and tp1+ hit on same bar — stop wins (conservative)
          outcome = 'stop'; pnlR = -1.0; closedBarTime = bar.time; break;
        }
      } else {
        const stopHit = bar.high >= stop;
        const tp3Hit  = bar.low  <= tp3;
        const tp2Hit  = bar.low  <= tp2;
        const tp1Hit  = bar.low  <= tp1;

        if (stopHit && !tp1Hit) {
          outcome = 'stop'; pnlR = -1.0; closedBarTime = bar.time; break;
        } else if (tp3Hit) {
          outcome = 'tp3'; pnlR = rr3; closedBarTime = bar.time; break;
        } else if (tp2Hit) {
          outcome = 'tp2'; pnlR = rr2; closedBarTime = bar.time; break;
        } else if (tp1Hit) {
          outcome = 'tp1'; pnlR = rr1; closedBarTime = bar.time; break;
        } else if (stopHit) {
          outcome = 'stop'; pnlR = -1.0; closedBarTime = bar.time; break;
        }
      }
    }

    if (outcome !== null) {
      t.outcome  = outcome;
      t.pnlR     = pnlR;
      t.closedAt = closedBarTime
        ? new Date(closedBarTime * 1000).toISOString()
        : new Date().toISOString();
      changed = true;
      log(`Trade ${t.id} closed: ${outcome} | R: ${pnlR} | bar: ${t.closedAt}`);
    }
  }

  if (changed) writeTrades(trades);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Stage 1 trigger check starting...');

  let client;

  // 1. Connect to CDP
  try {
    const { client: c } = await cdpConnect();
    client = c;
    log('CDP connected to TradingView');
  } catch (err) {
    if (err.code === 'CDP_UNAVAILABLE') {
      errorAlert(
        'Cannot reach TradingView Desktop (CDP port 9222 not responding)',
        'CDP connection attempt',
        'Open TradingView Desktop. If already open, restart it. Ensure Claude Desktop is running (it starts the MCP server).'
      );
    } else if (err.code === 'NO_TARGET') {
      errorAlert(
        'TradingView is running but no chart page found',
        'CDP target selection',
        'Open a chart in TradingView Desktop. Ensure the 🕵Ace layout is loaded.'
      );
    } else {
      errorAlert(`CDP error: ${err.message}`, 'CDP connection', 'Check TradingView Desktop is open and functioning.');
    }
    process.exit(1);
  }

  let price, studies;

  try {
    // 2. Get current price
    const quote = await cdpEval(client, QUOTE_EXPR);
    if (!quote || quote.error) throw { code: 'NO_QUOTE', msg: quote?.error || 'null response' };

    if (quote.symbol && !quote.symbol.includes('BTCUSDT')) {
      errorAlert(
        `Wrong chart symbol: got "${quote.symbol}", expected BINANCE:BTCUSDT.P`,
        'Quote symbol check',
        'Open TradingView Desktop and switch to the 🕵Ace layout (BINANCE:BTCUSDT.P).'
      );
      await client.close();
      process.exit(1);
    }

    price = quote.last;
    if (!price) throw { code: 'NO_PRICE', msg: 'last/close price is null' };
    log(`Price: $${Math.round(price).toLocaleString()}`);

    // 3. Get VRVP data — PRIMARY TRIGGER SOURCE
    const vrvpRaw = await cdpEval(client, VRVP_EXPR);
    studies = [];
    studies._vrvpRaw = vrvpRaw;
    if (!vrvpRaw || vrvpRaw.error || !vrvpRaw.rows?.length) {
      log(`VRVP unavailable: ${vrvpRaw?.error || 'no data'} — check Visible Range Volume Profile is on chart`);
    } else {
      log(`VRVP: ${vrvpRaw.rows.length} histogram rows | POC ~$${Math.round(vrvpRaw.poc ?? 0).toLocaleString()} | VAH ~$${Math.round(vrvpRaw.vah ?? 0).toLocaleString()} | VAL ~$${Math.round(vrvpRaw.val ?? 0).toLocaleString()}`);
    }

    // 4. Get study values (CVD, OI, Session VP, VWAP)
    const studyData = await cdpEval(client, STUDY_VALUES_EXPR);
    const studyArr = Array.isArray(studyData) ? studyData : [];
    studyArr._vrvpRaw    = studies._vrvpRaw;
    studies = studyArr;
    log(`Studies: ${studies.length} indicators read`);

    // 4.5. Get recent volumes (12 bars) for breakout detection
    const volumeData = await cdpEval(client, buildVolumeExpr(12));
    studies._volumes = Array.isArray(volumeData) ? volumeData : [];

    // 5. Check VRVP proximity to decide if HTF data is needed
    const vrvpLevelsPrelim = computeVRVPLevels(studies._vrvpRaw);
    const anyTriggered = !!checkVRVPProximity(price, vrvpLevelsPrelim);

    if (anyTriggered) {
      const originalTF = await cdpEval(client, GET_TF_EXPR) || '30';
      log(`VRVP trigger detected — fetching HTF data (current TF: ${originalTF})`);

      const closes4h = await fetchHTFCloses(client, '240', 60, originalTF);
      studies._macd4h = computeMACD(closes4h);
      log(`4H MACD: ${studies._macd4h ? (studies._macd4h.bullish ? 'bullish' : 'bearish') + ` hist ${Math.round(studies._macd4h.histogram)}` : 'unavailable'}`);

      const closes12h = await fetchHTFCloses(client, '720', 30, originalTF);
      studies._rsi12h = computeRSI(closes12h);
      log(`12H RSI: ${studies._rsi12h != null ? Math.round(studies._rsi12h) : 'unavailable'}`);

      const weeklyCloses = await fetchHTFCloses(client, 'W', 10, originalTF);
      studies._weeklyTrend = analyseWeeklyTrend(weeklyCloses);
      log(`Weekly trend: ${studies._weeklyTrend ?? 'unavailable'} (${weeklyCloses.length} weekly closes)`);
    }

  } catch (err) {
    if (err.code === 'NO_QUOTE' || err.code === 'NO_PRICE') {
      errorAlert(
        `Could not read price data: ${err.msg || err.message}`,
        'quote_get via CDP',
        'TradingView may still be loading. Wait 30 seconds and check the chart is fully loaded.'
      );
    } else {
      errorAlert(
        `Data read failed: ${err.message || JSON.stringify(err)}`,
        'CDP data collection',
        'Check TradingView Desktop is open on the 🕵Ace layout with VRVP visible.'
      );
    }
    try { await client.close(); } catch {}
    process.exit(1);
  }

  await client.close();

  // 6. Parse indicators
  const indicators = parseStudies(studies);
  indicators.oiTrend     = getOITrend(indicators.oi);
  indicators.macd4h      = studies._macd4h     ?? null;
  indicators.rsi12h      = studies._rsi12h     ?? null;
  indicators.weeklyTrend = studies._weeklyTrend ?? null;
  indicators.volumes     = studies._volumes    ?? [];
  indicators.vrvpLevels  = computeVRVPLevels(studies._vrvpRaw);
  log(`CVD: ${indicators.cvd} | OI: ${indicators.oi} (${indicators.oiTrend ?? 'no trend yet'}) | VWAP: ${indicators.vwap} | Weekly: ${indicators.weeklyTrend ?? 'n/a'}`);

  // Always update outcomes on open trades (bar-accurate — uses CDP)
  await updateOutcomes(client);

  // Track 30M confirmation closes for unconfirmed open trades
  await checkConfirmation(client, indicators);

  // 7. Check if any alerted levels have been broken
  const invalidations = checkInvalidations(price, indicators);
  for (const { msg, type } of invalidations) {
    notify(type, msg);
  }

  // 8. Check reclaim watch (post-stop-hunt levels)
  const reclaims = checkReclaimWatch(price, indicators);
  for (const msg of reclaims) {
    const type = msg.includes('LONG') ? 'long' : 'short';
    notify(type, msg);
  }

  // 8.5. Check pending confirmations (flat OI at alert time, watching for confirmation)
  const confirmations = checkPendingConfirmation(price, indicators);
  for (const { msg, direction } of confirmations) {
    notify(direction, msg);
  }

  // 9. VRVP proximity trigger
  let triggered = false;
  const trigger = checkVRVPProximity(price, indicators.vrvpLevels);

  if (trigger) {
    const levelKey = `${trigger.type.toLowerCase()}-${Math.round(trigger.mid)}`;

    if (isCoolingDown(levelKey)) {
      log(`Level ${levelKey} triggered but cooling down — skipping`);
    } else {
      log(`TRIGGER: ${trigger.type} $${Math.round(trigger.lo).toLocaleString()}–$${Math.round(trigger.hi).toLocaleString()} | direction: ${trigger.direction} | dist $${Math.round(trigger.dist).toLocaleString()}`);

      const setup = evaluateSetup(price, trigger, indicators, indicators.vrvpLevels);
      setup._cvd     = indicators.cvd;
      setup._oi      = indicators.oi;
      setup._oiTrend = indicators.oiTrend;
      setup._vwap    = indicators.vwap;
      setup._macd4h  = indicators.macd4h;
      setup._rsi12h  = indicators.rsi12h;

      // Regime filter — suppress counter-trend signals
      if (indicators.weeklyTrend === 'uptrend' && trigger.direction === 'short') {
        log(`Regime filter: weekly uptrend suppressing SHORT at ${levelKey}`);
        const levelStr = `$${Math.round(trigger.lo).toLocaleString()}–$${Math.round(trigger.hi).toLocaleString()}`;
        notify('info', [
          `📊 ${trigger.type} APPROACHED — TREND FILTER ACTIVE | BTCUSDT.P`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `**Price** $${Math.round(price).toLocaleString()} | **${trigger.type}** ${levelStr}`,
          ``,
          `**REGIME: WEEKLY UPTREND — SHORT SUPPRESSED**`,
          `Weekly structure is bullish. ${trigger.type} at ${levelStr} is more likely to break than hold.`,
          ``,
          `**WATCH FOR**  Breakout close above $${Math.round(trigger.hi).toLocaleString()} → long continuation`,
          `**FLIP TRIGGER**  4H close below $${Math.round(trigger.lo).toLocaleString()} would change regime`,
          ``,
          `**CRITERIA**`,
          setup.criteria.map(c => `${c.pass === true ? '✅' : c.pass === false ? '❌' : '⚠️'} ${c.label}`).join('\n'),
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `📊 React with 📊 for deep MTF analysis`,
        ].join('\n'));
        markAlerted(levelKey, trigger.direction, trigger);
        triggered = true;

      } else if (indicators.weeklyTrend === 'downtrend' && trigger.direction === 'long') {
        log(`Regime filter: weekly downtrend suppressing LONG at ${levelKey}`);
        const levelStr = `$${Math.round(trigger.lo).toLocaleString()}–$${Math.round(trigger.hi).toLocaleString()}`;
        notify('info', [
          `📊 ${trigger.type} APPROACHED — TREND FILTER ACTIVE | BTCUSDT.P`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `**Price** $${Math.round(price).toLocaleString()} | **${trigger.type}** ${levelStr}`,
          ``,
          `**REGIME: WEEKLY DOWNTREND — LONG SUPPRESSED**`,
          `Weekly structure is bearish. ${trigger.type} at ${levelStr} is more likely to break than hold.`,
          ``,
          `**WATCH FOR**  Break close below $${Math.round(trigger.lo).toLocaleString()} → short continuation`,
          `**FLIP TRIGGER**  4H close above $${Math.round(trigger.hi).toLocaleString()} would change regime`,
          ``,
          `**CRITERIA**`,
          setup.criteria.map(c => `${c.pass === true ? '✅' : c.pass === false ? '❌' : '⚠️'} ${c.label}`).join('\n'),
          `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `📊 React with 📊 for deep MTF analysis`,
        ].join('\n'));
        markAlerted(levelKey, trigger.direction, trigger);
        triggered = true;

      } else {
        // Fire the signal
        const message = formatSetupMessage(price, trigger, setup);
        notify(setup.direction, message, (msgId) => {
          const st = readState();
          if (!Array.isArray(st._signal_messages)) st._signal_messages = [];
          st._signal_messages.push({
            id:        msgId,
            firedAt:   Date.now(),
            levelKey,
            direction: setup.direction,
            analyzed:  false,
          });
          // Keep only last 20 signal messages
          if (st._signal_messages.length > 20) st._signal_messages = st._signal_messages.slice(-20);
          writeState(st);
          log(`Stored signal message id=${msgId} for reaction polling`);
        });
        markAlerted(levelKey, setup.direction, trigger);
        logTrade(price, trigger, setup);
        if (!indicators.oiTrend || indicators.oiTrend === 'flat') {
          markPending(levelKey, setup.direction, trigger, indicators);
        }
        triggered = true;
      }
    }
  }

  if (!triggered) {
    // Show nearest VRVP level for status
    const lvls = indicators.vrvpLevels;
    let nearestStr = 'VRVP unavailable';
    if (lvls) {
      const candidates = [
        lvls.val != null ? { label: 'VAL', price: lvls.val } : null,
        lvls.vah != null ? { label: 'VAH', price: lvls.vah } : null,
        lvls.poc != null ? { label: 'POC', price: lvls.poc } : null,
        ...(lvls.hvns || []).map((h, i) => ({ label: `HVN${i + 1}`, price: (h.lo + h.hi) / 2 })),
      ].filter(Boolean);
      const nearest = candidates.reduce((best, c) => {
        const d = Math.abs(price - c.price);
        return d < best.dist ? { label: c.label, price: c.price, dist: d } : best;
      }, { label: '', price: 0, dist: Infinity });
      if (nearest.label) nearestStr = `Nearest: ${nearest.label} $${Math.round(nearest.price).toLocaleString()} ($${Math.round(nearest.dist).toLocaleString()} away)`;
    }
    log(`No trigger. Price $${Math.round(price).toLocaleString()}. ${nearestStr}`);
  }

  log('Stage 1 complete.');
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

main().catch(err => {
  log(`FATAL: ${err.message || err}`);
  try {
    notify('error', [
      '❌ **ERROR — Ace Trigger Check crashed**',
      `**What:** Unhandled exception: ${err.message}`,
      '**Where:** trigger-check.js main()',
      '**Fix:** Check logs/trigger-check.log for the full stack trace.',
    ].join('\n'));
  } catch {}
  process.exit(1);
});
