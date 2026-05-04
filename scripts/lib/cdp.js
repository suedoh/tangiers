'use strict';

/**
 * lib/cdp.js — Shared TradingView CDP helpers
 *
 * Provides connect/eval + all data-reading expressions used by BZ scripts.
 * BTC scripts continue to inline their own CDP code (untouched).
 */

const CDP = require(require('path').resolve(__dirname, '../../tradingview-mcp/node_modules/chrome-remote-interface'));

const CDP_PORT  = 9222;
const CHART_API = `window.TradingViewApi._activeChartWidgetWV.value()`;
const BARS_PATH = `${CHART_API}._chartWidget.model().mainSeries().bars()`;

// ─── Connection ──────────────────────────────────────────────────────────────

/**
 * Connect to TradingView Desktop via CDP.
 * @param {string} [symbolHint]  Optional substring to match against tab title/URL
 *                               e.g. 'BZ' targets the BZ1! tab, 'BTC' targets the BTC tab.
 *                               If omitted, connects to the first TradingView chart found.
 */
async function cdpConnect(symbolHint) {
  let targets;
  try {
    targets = await CDP.List({ host: 'localhost', port: CDP_PORT });
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: 'CDP_UNAVAILABLE' });
  }

  // Desktop app may use different types/URLs — cast a wide net
  const chartTargets = targets.filter(t =>
    /tradingview/i.test(t.url) || /tradingview/i.test(t.title)
  );

  if (!chartTargets.length) {
    // Log all targets so we can diagnose Desktop app CDP structure
    console.error('[cdp] All CDP targets:', JSON.stringify(targets.map(t => ({ type: t.type, title: t.title, url: t.url })), null, 2));
    throw Object.assign(new Error('No TradingView target found'), { code: 'NO_TARGET' });
  }

  if (symbolHint) {
    const hint = symbolHint.toUpperCase();

    // First try cheap title/URL match (works in browser; Desktop app may have generic titles)
    const byMeta = chartTargets.find(t => (t.title || '').toUpperCase().includes(hint))
                || chartTargets.find(t => (t.url  || '').toUpperCase().includes(hint));

    if (byMeta) {
      const client = await CDP({ host: 'localhost', port: CDP_PORT, target: byMeta.id });
      await client.Runtime.enable();
      return client;
    }

    // Desktop app fallback: probe each tab by reading its active symbol
    for (const t of chartTargets) {
      let probe;
      try {
        probe = await CDP({ host: 'localhost', port: CDP_PORT, target: t.id });
        await probe.Runtime.enable();
        const sym = await cdpEval(probe, GET_SYMBOL_EXPR);
        if (sym && sym.toUpperCase().includes(hint)) return probe;
        await probe.close();
      } catch { try { await probe?.close(); } catch {} }
    }

    throw Object.assign(
      new Error(`No TradingView tab found with symbol matching "${symbolHint}" — is the ${symbolHint} tab open?`),
      { code: 'NO_TARGET' }
    );
  }

  // No hint — use first chart tab
  const target = chartTargets[0];
  const client = await CDP({ host: 'localhost', port: CDP_PORT, target: target.id });
  await client.Runtime.enable();
  return client;
}

async function cdpEval(client, expression) {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise:  false,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
             || result.exceptionDetails.text
             || 'Unknown JS error';
    throw new Error(`CDP eval error: ${msg}`);
  }
  return result.result?.value ?? null;
}

// ─── Symbol / Timeframe ──────────────────────────────────────────────────────

const GET_SYMBOL_EXPR = `(function(){
  try { return ${CHART_API}.symbol(); } catch(e) { return null; }
})()`;

function buildSetSymbolExpr(sym) {
  return `(function(){
    try { ${CHART_API}.setSymbol(${JSON.stringify(sym)}, function(){}); return true; }
    catch(e) { return false; }
  })()`;
}

const GET_TF_EXPR = `(function(){
  try { return ${CHART_API}.resolution(); } catch(e) { return null; }
})()`;

function buildSetTFExpr(tf) {
  return `(function(){
    try { ${CHART_API}.setResolution(${JSON.stringify(tf)}, function(){}); return true; }
    catch(e) { return false; }
  })()`;
}

async function getSymbol(client)      { return cdpEval(client, GET_SYMBOL_EXPR); }
async function getTimeframe(client)   { return cdpEval(client, GET_TF_EXPR); }

/**
 * Switch symbol and wait until TradingView confirms it loaded.
 * Polls getSymbol() every 300ms — much more reliable than a fixed sleep.
 */
async function setSymbol(client, sym, timeoutMs = 8000) {
  await cdpEval(client, buildSetSymbolExpr(sym));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const current = await getSymbol(client);
    // TradingView may return "NYMEX:BZ1!" or just "BZ1!" depending on version
    if (current && (current === sym || current.endsWith(sym.split(':')[1]))) return;
  }
  throw new Error(`Symbol switch to ${sym} timed out after ${timeoutMs}ms`);
}

/**
 * Switch timeframe and wait until TradingView confirms it loaded.
 */
async function setTimeframe(client, tf, timeoutMs = 5000) {
  await cdpEval(client, buildSetTFExpr(tf));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const current = await getTimeframe(client);
    if (current === tf || String(current) === String(tf)) return;
  }
  // Non-fatal — some TF representations differ (e.g. '60' vs '1H'), just add a safety pause
  await sleep(800);
}

/**
/**
 * Poll getQuote until a valid price is returned.
 * Ensures bars are actually loaded after a symbol/layout switch.
 */
async function waitForPrice(client, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      const q = await getQuote(client);
      if (q?.last && q.last > 0) return q;
    } catch {}
  }
  throw new Error('Timed out waiting for price data to load');
}

// ─── Quote ───────────────────────────────────────────────────────────────────

const QUOTE_EXPR = `(function(){
  try {
    var api  = ${CHART_API};
    var bars = ${BARS_PATH};
    var q    = { symbol: null, last: null, open: null, high: null, low: null };
    try { q.symbol = api.symbol(); } catch(e) {}
    if (bars && typeof bars.lastIndex === 'function') {
      var v = bars.valueAt(bars.lastIndex());
      if (v) { q.open = v[1]; q.high = v[2]; q.low = v[3]; q.last = v[4]; }
    }
    return q;
  } catch(e) { return { error: e.message }; }
})()`;

async function getQuote(client) { return cdpEval(client, QUOTE_EXPR); }

// ─── Study Values ────────────────────────────────────────────────────────────

const STUDY_VALUES_EXPR = `(function(){
  try {
    var chart   = ${CHART_API}._chartWidget;
    var sources = chart.model().model().dataSources();
    var results = [];
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      try {
        var meta   = s.metaInfo();
        var name   = meta.description || meta.shortDescription || '';
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
        if (Object.keys(values).length === 0 && s._series && s._series.length > 0) {
          try {
            var ser  = s._series[0];
            var bars = typeof ser.bars === 'function' ? ser.bars() : ser.bars;
            if (bars && typeof bars.lastIndex === 'function') {
              var li  = bars.lastIndex();
              var val = bars.valueAt(li);
              if (val) {
                var n = Array.isArray(val) ? (val[4]??val[1]??val[0]) : null;
                if (n != null && !isNaN(n)) values[name] = String(n);
              }
            }
          } catch(e) {}
        }
        if (Object.keys(values).length > 0) results.push({ name, values });
      } catch(e) {}
    }
    return results;
  } catch(e) { return []; }
})()`;

async function getStudyValues(client) { return cdpEval(client, STUDY_VALUES_EXPR); }

// ─── Pine Boxes (supply/demand zones) ────────────────────────────────────────

function buildBoxesExpr(filter) {
  const f = JSON.stringify(filter || '');
  return `(function(){
    try {
      var chart   = ${CHART_API}._chartWidget;
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
          var items = [];
          try {
            var outer = g._primitivesCollection.dwgboxes;
            if (outer) {
              var inner = outer.get('boxes');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById)
                  coll._primitivesDataById.forEach(function(v) { items.push(v); });
              }
            }
          } catch(e) {}
          for (var i = 0; i < items.length; i++) {
            var v    = items[i];
            var high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1,v.y2)*100)/100 : null;
            var low  = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1,v.y2)*100)/100 : null;
            if (high != null && low != null) allZones.push({ high, low });
          }
        } catch(e) {}
      }
      var seen  = {};
      var zones = allZones.filter(function(z) {
        var k = z.high + ':' + z.low;
        if (seen[k]) return false; seen[k] = true; return true;
      });
      zones.sort(function(a,b) { return b.high - a.high; });
      return zones;
    } catch(e) { return []; }
  })()`;
}

async function getPineBoxes(client, filter) { return cdpEval(client, buildBoxesExpr(filter)); }

// ─── Pine Labels (BOS / CHoCH) ───────────────────────────────────────────────

function buildLabelsExpr(filter) {
  const f = JSON.stringify(filter || '');
  return `(function(){
    try {
      var chart   = ${CHART_API}._chartWidget;
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
          var items = [];
          try {
            var outer = g._primitivesCollection.dwglabels;
            if (outer) {
              var inner = outer.get('labels');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById)
                  coll._primitivesDataById.forEach(function(v) { items.push(v); });
              }
            }
          } catch(e) {}
          for (var i = 0; i < items.length; i++) {
            var v    = items[i];
            var text = (v.text || v.labelText || '').trim();
            if (text) allLabels.push({ text, price: v.y, time: v.x });
          }
        } catch(e) {}
      }
      return allLabels;
    } catch(e) { return []; }
  })()`;
}

async function getPineLabels(client, filter) { return cdpEval(client, buildLabelsExpr(filter)); }

// ─── OHLCV Bars (for ATR calculation) ────────────────────────────────────────

function buildOHLCVExpr(count) {
  return `(function(){
    try {
      var bars   = ${BARS_PATH};
      var result = [];
      var li     = bars.lastIndex();
      var start  = Math.max(0, li - ${count} + 1);
      for (var i = start; i <= li; i++) {
        var v = bars.valueAt(i);
        if (v && v[4] != null) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4] });
      }
      return result;
    } catch(e) { return []; }
  })()`;
}

async function getOHLCV(client, count = 20) { return cdpEval(client, buildOHLCVExpr(count)); }

// ─── ATR Calculator ──────────────────────────────────────────────────────────

/**
 * Calculate 14-period ATR from OHLCV bars array.
 * Returns { atr14, buffer } where buffer = max(atr14 * 0.35, 1.50)
 */
function calcATR(bars, period = 14) {
  if (!bars || bars.length < 2) return { atr14: 2.0, buffer: 1.50 };

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i];
    const prev = bars[i - 1];
    trs.push(Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low  - prev.close),
    ));
  }

  const slice = trs.slice(-period);
  const atr14 = slice.reduce((a, b) => a + b, 0) / slice.length;
  const buffer = Math.max(atr14 * 0.35, 1.50);

  return { atr14: Math.round(atr14 * 100) / 100, buffer: Math.round(buffer * 100) / 100 };
}

// ─── Screenshot ──────────────────────────────────────────────────────────────

/**
 * Capture a PNG screenshot of the active TradingView chart and write it to
 * disk. Uses CDP's native Page.captureScreenshot — no MCP, no external deps.
 *
 * Refuses files >9 MB (Discord webhook attachment cap is 10 MB; we keep
 * a safety margin). On too-large or write failure, throws so callers can
 * fall back to text-only posts.
 *
 * @param {*} client     CDP client from cdpConnect()
 * @param {string} outPath Absolute path where the PNG should be written.
 *                         Caller is responsible for ensuring the directory exists.
 * @returns {Promise<string>} The absolute path written.
 */
async function captureScreenshot(client, outPath) {
  await client.Page.enable();
  const { data } = await client.Page.captureScreenshot({
    format: 'png',
    captureBeyondViewport: false,
  });
  if (!data) throw new Error('Page.captureScreenshot returned no data');

  const buf = Buffer.from(data, 'base64');
  if (buf.length > 9 * 1024 * 1024) {
    throw Object.assign(
      new Error(`Screenshot too large: ${buf.length} bytes (>9MB cap for Discord)`),
      { code: 'SCREENSHOT_TOO_LARGE' }
    );
  }

  const fs   = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  cdpConnect, cdpEval,
  getSymbol, setSymbol,
  getTimeframe, setTimeframe,
  waitForPrice,
  getQuote, getStudyValues,
  getPineBoxes, getPineLabels,
  getOHLCV, calcATR,
  captureScreenshot,
  sleep,
};
