#!/usr/bin/env node
/**
 * Ace Trading System — Weekly War Report
 *
 * Posts an institutional-grade weekly preview to #btc-weekly-war-report
 * every Sunday at 14:00 UTC (09:00 EST / 10:00 EDT).
 *
 * Data sources (all public, zero auth required):
 *   - TradingView Desktop (CDP)  : price, OHLCV bars, LuxAlgo zones, CVD, OI, VWAP
 *   - Binance Futures REST API   : current funding rate
 *   - Alternative.me API         : Fear & Greed Index
 *   - Deribit public API         : BTC options expiry, max pain, notional OI
 *   - ForexFactory public feed   : high-impact USD economic calendar
 *
 * Usage: node scripts/weekly-war-report.js
 */

'use strict';

const CDP   = require(require('path').resolve(__dirname, '../tradingview-mcp/node_modules/chrome-remote-interface'));
const path  = require('path');
const fs    = require('fs');
const https = require('https');

const ROOT     = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

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

const WEBHOOK_URL = process.env.DISCORD_BTC_WEEKLY_WAR_REPORT;
if (!WEBHOOK_URL) {
  console.error('ERROR: DISCORD_BTC_WEEKLY_WAR_REPORT not set in .env');
  process.exit(1);
}

const CDP_PORT = 9222;

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'AceTradingBot/1.0', ...extraHeaders } },
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

// ─── Discord ──────────────────────────────────────────────────────────────────

function postToDiscord(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      if (res.statusCode === 204) { resolve(); return; }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => reject(new Error(`Discord HTTP ${res.statusCode}: ${d}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── CDP helpers ──────────────────────────────────────────────────────────────

async function cdpConnect() {
  let targets;
  try { targets = await CDP.List({ host: 'localhost', port: CDP_PORT }); }
  catch (e) { throw { code: 'CDP_UNAVAILABLE', message: e.message }; }

  const target = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
              || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
  if (!target) throw { code: 'NO_TARGET', message: 'No TradingView chart page found in CDP targets.' };

  const client = await CDP({ host: 'localhost', port: CDP_PORT, target: target.id });
  await client.Runtime.enable();
  return client;
}

async function cdpEval(client, expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: false });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
             || result.exceptionDetails.text || 'Unknown JS error';
    throw new Error(`CDP eval error: ${msg}`);
  }
  return result.result?.value ?? null;
}

// ─── TradingView expressions ──────────────────────────────────────────────────

const CHART_API = `window.TradingViewApi._activeChartWidgetWV.value()`;
const BARS_PATH = `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;

const GET_TF_EXPR = `(function(){
  try { return ${CHART_API}.resolution(); } catch(e) { return null; }
})()`;

const QUOTE_EXPR = `(function(){
  try {
    var api  = ${CHART_API};
    var bars = ${BARS_PATH};
    var q    = { symbol: null, last: null };
    try { q.symbol = api.symbol(); } catch(e) {}
    if (bars && typeof bars.lastIndex === 'function') {
      var v = bars.valueAt(bars.lastIndex());
      if (v) { q.last = v[4]; q.open = v[1]; q.high = v[2]; q.low = v[3]; }
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
        if (Object.keys(values).length === 0 && s._series && s._series.length > 0) {
          try {
            var ser = s._series[0];
            var bs  = typeof ser.bars === 'function' ? ser.bars() : ser.bars;
            if (bs && typeof bs.lastIndex === 'function') {
              var li  = bs.lastIndex();
              var v   = bs.valueAt(li);
              if (v) {
                var val = Array.isArray(v) ? (v[4] != null ? v[4] : v[1] != null ? v[1] : v[0]) : null;
                if (val != null && !isNaN(val)) values[name] = String(val);
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

function buildSetTFExpr(tf) {
  return `(function(){
    try { ${CHART_API}.setResolution('${tf}', function(){}); return true; }
    catch(e) { return false; }
  })()`;
}

// Returns array of { t, o, h, l, c } — newest bar last
function buildBarsExpr(count) {
  return `(function(){
    try {
      var bars   = ${BARS_PATH};
      var result = [];
      var li     = bars.lastIndex();
      var start  = Math.max(0, li - ${count} + 1);
      for (var i = start; i <= li; i++) {
        var v = bars.valueAt(i);
        // v[0]=time, v[1]=open, v[2]=high, v[3]=low, v[4]=close
        if (v && v[4] != null) result.push({ t: v[0], o: v[1], h: v[2], l: v[3], c: v[4] });
      }
      return result;
    } catch(e) { return []; }
  })()`;
}

function buildBoxesExpr(filter) {
  const f = JSON.stringify(filter || '');
  return `
(function() {
  try {
    var chart    = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources  = chart.model().model().dataSources();
    var filter   = ${f};
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
        var pc    = g._primitivesCollection;
        var items = [];
        try {
          var outer = pc.dwgboxes;
          if (outer) {
            var inner = outer.get('boxes');
            if (inner) {
              var coll = inner.get(false);
              if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0)
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

// Expected bar spacing in seconds per timeframe — used to validate bars loaded correctly
const TF_SPACING = { 'W': 604800, '1M': 2419200, '240': 14400, '60': 3600, '30': 1800 };

// Switch TF → poll until bars with correct spacing load → restore TF
async function fetchHTFBars(client, tf, count, originalTF) {
  try {
    await cdpEval(client, buildSetTFExpr(tf));
    const expected = TF_SPACING[tf];
    const deadline = Date.now() + 15000;
    let bars = [];
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const result = await cdpEval(client, buildBarsExpr(count));
      if (!Array.isArray(result) || result.length < 2) continue;
      if (expected) {
        // Validate bar spacing — stale TF data has wrong spacing
        const spacing = result[result.length - 1].t - result[result.length - 2].t;
        if (spacing < expected * 0.8 || spacing > expected * 1.35) {
          log(`fetchHTFBars(${tf}): spacing ${spacing}s != expected ~${expected}s — still loading`);
          continue;
        }
      }
      bars = result;
      break;
    }
    if (!bars.length) log(`fetchHTFBars(${tf}): bars invalid/empty after 15s timeout`);
    return bars;
  } catch (e) {
    log(`fetchHTFBars(${tf}) error: ${e.message}`);
    return [];
  } finally {
    try { await cdpEval(client, buildSetTFExpr(originalTF)); await new Promise(r => setTimeout(r, 800)); } catch {}
  }
}

function parseFloat_(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function parseStudies(studies) {
  const find = name => studies.find(s => s.name?.toLowerCase().includes(name.toLowerCase()));
  const cvdStudy  = find('Cumulative Volume Delta');
  const oiStudy   = find('Open Interest');
  const vwapStudy = find('Volume Weighted Average Price') || find('VWAP');
  return {
    cvd:  cvdStudy  ? parseFloat_(Object.values(cvdStudy.values  || {})[0]) : null,
    oi:   oiStudy   ? parseFloat_(Object.values(oiStudy.values   || {})[0]) : null,
    vwap: vwapStudy ? parseFloat_(Object.values(vwapStudy.values || {})[0]) : null,
  };
}

// ─── Compute helpers ──────────────────────────────────────────────────────────

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
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function analyseWeeklyCandle(bar) {
  const range = bar.h - bar.l;
  if (!range) return 'Doji — indecision';
  const bodyRatio = Math.abs(bar.c - bar.o) / range;
  const closePos  = (bar.c - bar.l) / range;
  const bull      = bar.c >= bar.o;
  const pct       = `${Math.round(bodyRatio * 100)}% body`;
  if (bodyRatio < 0.1)  return `Doji — equal buying and selling pressure`;
  if (bull && closePos > 0.65) return `Bullish — strong close near highs (${pct})`;
  if (!bull && closePos < 0.35) return `Bearish — strong close near lows (${pct})`;
  if (bull)  return `Bullish — closed ${closePos > 0.5 ? 'upper' : 'lower'} half of range (${pct})`;
  return `Bearish — closed ${closePos < 0.5 ? 'lower' : 'upper'} half of range (${pct})`;
}

function analyseWeeklyTrend(weeklyBars) {
  // Exclude the current (incomplete) bar — last bar in the array
  const complete = weeklyBars.slice(0, -1);
  if (complete.length < 3) return { trend: 'Unknown', detail: 'Insufficient weekly data' };
  const recent = complete.slice(-5);
  let hhCount = 0, hlCount = 0, llCount = 0, lhCount = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].h > recent[i-1].h) hhCount++;
    if (recent[i].l > recent[i-1].l) hlCount++;
    if (recent[i].l < recent[i-1].l) llCount++;
    if (recent[i].h < recent[i-1].h) lhCount++;
  }
  if (hhCount >= 2 && hlCount >= 1) return { trend: '📈 Uptrend', detail: 'HH/HL sequence intact on weekly chart' };
  if (llCount >= 2 && lhCount >= 1) return { trend: '📉 Downtrend', detail: 'LL/LH sequence intact on weekly chart' };
  return { trend: '➡️ Ranging', detail: 'No clear HH/HL or LL/LH — consolidation phase' };
}

function analyseMonthlyTrend(monthlyBars) {
  // Last 3 complete monthly bars
  const complete = monthlyBars.slice(0, -1);
  if (complete.length < 3) return '—';
  const last3 = complete.slice(-3);
  if (last3[2].c > last3[1].c && last3[1].c > last3[0].c)
    return '📈 Uptrend — 3 consecutive bullish monthly closes';
  if (last3[2].c < last3[1].c && last3[1].c < last3[0].c)
    return '📉 Downtrend — 3 consecutive bearish monthly closes';
  return '➡️ Mixed — no clear consecutive monthly trend';
}

// Returns { open, name } for the current quarter's opening price
function getQuarterOpen(monthlyBars) {
  const now = new Date();
  const currentMonth = now.getMonth(); // 0-indexed
  const quarterStartMonth = Math.floor(currentMonth / 3) * 3;
  const monthsBack = currentMonth - quarterStartMonth;
  // monthlyBars newest last; last bar = current month
  const idx = monthlyBars.length - 1 - monthsBack;
  if (idx < 0 || !monthlyBars[idx]) return null;
  const qNames = ['Q1', 'Q2', 'Q3', 'Q4'];
  return { open: monthlyBars[idx].o, name: `${qNames[Math.floor(currentMonth / 3)]} ${now.getFullYear()}` };
}

function computeBiasScore({ weeklyTrend, cvd, fundingRate, price, vwap, weeklyRSI, fearGreed }) {
  const scores = [];

  // Weekly structure (+2 / -2 / 0)
  if (weeklyTrend.includes('Uptrend'))
    scores.push({ label: 'Weekly Structure', icon: '🟢', text: 'Uptrend — HH/HL sequence', val: 2 });
  else if (weeklyTrend.includes('Downtrend'))
    scores.push({ label: 'Weekly Structure', icon: '🔴', text: 'Downtrend — LL/LH sequence', val: -2 });
  else
    scores.push({ label: 'Weekly Structure', icon: '🟡', text: 'Ranging — no clear bias', val: 0 });

  // CVD (+1 / -1 / 0)
  if (cvd != null) {
    if (cvd > 0)      scores.push({ label: 'CVD', icon: '🟢', text: `+${Math.round(cvd)} — buyers in control`, val: 1 });
    else if (cvd < 0) scores.push({ label: 'CVD', icon: '🔴', text: `${Math.round(cvd)} — sellers in control`, val: -1 });
    else              scores.push({ label: 'CVD', icon: '🟡', text: '~0 — neutral', val: 0 });
  }

  // Funding rate — contrarian signal (+1 if shorts over-leveraged, -1 if longs over-leveraged)
  if (fundingRate != null) {
    const pct = fundingRate * 100;
    if (pct > 0.05)       scores.push({ label: 'Funding Rate', icon: '🔴', text: `+${pct.toFixed(3)}%/8h — longs over-leveraged ⚠️`, val: -1 });
    else if (pct < -0.05) scores.push({ label: 'Funding Rate', icon: '🟢', text: `${pct.toFixed(3)}%/8h — shorts over-leveraged ⚠️`, val: 1 });
    else                  scores.push({ label: 'Funding Rate', icon: '🟡', text: `${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%/8h — neutral`, val: 0 });
  }

  // Price vs VWAP (+1 / -1)
  if (vwap != null && price != null) {
    if (price > vwap) scores.push({ label: 'Price vs VWAP', icon: '🟢', text: `Above VWAP ($${Math.round(vwap).toLocaleString()})`, val: 1 });
    else              scores.push({ label: 'Price vs VWAP', icon: '🔴', text: `Below VWAP ($${Math.round(vwap).toLocaleString()})`, val: -1 });
  }

  // Weekly RSI (+1 / -1 / 0)
  if (weeklyRSI != null) {
    if (weeklyRSI > 60)      scores.push({ label: 'Weekly RSI (14)', icon: '🟢', text: `${weeklyRSI.toFixed(0)} — bullish momentum`, val: 1 });
    else if (weeklyRSI < 40) scores.push({ label: 'Weekly RSI (14)', icon: '🔴', text: `${weeklyRSI.toFixed(0)} — bearish momentum`, val: -1 });
    else                     scores.push({ label: 'Weekly RSI (14)', icon: '🟡', text: `${weeklyRSI.toFixed(0)} — mid-range, neutral`, val: 0 });
  }

  // Fear & Greed — contrarian (+1 extreme fear, -1 extreme greed, 0 neutral)
  if (fearGreed?.value != null) {
    const fg = fearGreed.value;
    if (fg >= 75)      scores.push({ label: 'Fear & Greed', icon: '🔴', text: `${fg} — Extreme Greed (fade risk)`, val: -1 });
    else if (fg <= 25) scores.push({ label: 'Fear & Greed', icon: '🟢', text: `${fg} — Extreme Fear (contrarian buy)`, val: 1 });
    else               scores.push({ label: 'Fear & Greed', icon: '🟡', text: `${fg} — ${fearGreed.label}`, val: 0 });
  }

  const total = scores.reduce((s, x) => s + x.val, 0);
  const maxPossible = scores.reduce((s, x) => s + (x.val !== 0 ? Math.abs(x.val) : 1), 0) || 6;

  const biasLabel =
    total >= 4  ? 'STRONG BULLISH BIAS'  :
    total >= 2  ? 'BULLISH BIAS'         :
    total >= 1  ? 'MILDLY BULLISH'       :
    total <= -4 ? 'STRONG BEARISH BIAS'  :
    total <= -2 ? 'BEARISH BIAS'         :
    total <= -1 ? 'MILDLY BEARISH'       : 'NEUTRAL';

  const biasEmoji = total >= 2 ? '🟢' : total <= -2 ? '🔴' : '🟡';

  const verdict =
    total >= 3  ? 'Favour longs from demand zones. Be selective on shorts — only at major confluence resistance with confirmed order flow divergence.'
    : total >= 1 ? 'Lean long. Wait for clean setups with strong criteria confirmation. Avoid chasing.'
    : total <= -3 ? 'Favour shorts from supply zones. Be selective on longs — only at major confluence support with confirmed order flow divergence.'
    : total <= -1 ? 'Lean short. Wait for clean setups. Reduce size on longs.'
    : 'No directional edge. Trade both sides only at clear extremes. Reduce position size across the board.';

  return { scores, total, maxPossible, biasLabel, biasEmoji, verdict };
}

function buildScenarios(price, lwHigh, lwLow, lwOpen, monthlyHigh, quarterOpen, zones, biasTotal) {
  const isBull   = biasTotal >= 0;
  const nearSupp = zones.filter(z => z.high < price).sort((a, b) => b.high - a.high)[0];
  const nearRes  = zones.filter(z => z.low  > price).sort((a, b) => a.low  - b.low)[0];

  const suppLevel = nearSupp ? `$${Math.round(nearSupp.low).toLocaleString()}–$${Math.round(nearSupp.high).toLocaleString()}` : `$${Math.round(lwLow).toLocaleString()}`;
  const resLevel  = nearRes  ? `$${Math.round(nearRes.low).toLocaleString()}–$${Math.round(nearRes.high).toLocaleString()}`  : `$${Math.round(lwHigh).toLocaleString()}`;
  const qStr      = quarterOpen ? `$${Math.round(quarterOpen).toLocaleString()} (Q open)` : null;

  const bull = {
    label:        'BULL CASE',
    prob:         isBull ? '60%' : '40%',
    trigger:      `Price holds above $${Math.round(lwOpen).toLocaleString()} (LW open) on daily close`,
    play:         `Long entries from ${suppLevel} demand zone on Setup A/C confirmation`,
    targets:      `LWH sweep $${Math.round(lwHigh).toLocaleString()} → ${nearRes ? resLevel : `MH $${Math.round(monthlyHigh).toLocaleString()}`}`,
    invalidation: `Daily close below $${Math.round(lwLow).toLocaleString()} (LWL) negates`,
  };

  // Bear targets: list descending from closest to furthest below LW open
  // Q open may be between LW open and LWL — insert in correct order
  const bearLevels = [
    quarterOpen && quarterOpen < lwOpen && quarterOpen > lwLow
      ? { p: Math.round(quarterOpen), label: 'Q open' } : null,
    { p: Math.round(lwLow), label: 'LWL' },
    quarterOpen && quarterOpen < lwLow
      ? { p: Math.round(quarterOpen), label: 'Q open' } : null,
    { p: Math.round(lwLow - (lwHigh - lwLow) * 0.5), label: 'ext' },
  ].filter(Boolean).slice(0, 2);
  const bearTargets = bearLevels.map(l => `$${l.p.toLocaleString()}${l.label !== 'ext' ? ` (${l.label})` : ''}`).join(' → ');

  const bear = {
    label:        'BEAR CASE',
    prob:         isBull ? '40%' : '60%',
    trigger:      `Daily close below $${Math.round(lwOpen).toLocaleString()} (LW open)`,
    play:         `LWL $${Math.round(lwLow).toLocaleString()} becomes magnet — Setup B short on failed reclaim of $${Math.round(lwOpen).toLocaleString()}`,
    targets:      bearTargets,
    invalidation: `Reclaim of $${Math.round(lwOpen).toLocaleString()} on daily close negates`,
  };

  return isBull ? { primary: bull, secondary: bear } : { primary: bear, secondary: bull };
}

// ─── External APIs ────────────────────────────────────────────────────────────

async function fetchFundingRate() {
  try {
    const d = await httpGet('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
    const r = parseFloat(d.lastFundingRate);
    return isNaN(r) ? null : r;
  } catch (e) { log(`Funding rate error: ${e.message}`); return null; }
}

async function fetchFearAndGreed() {
  try {
    const d = await httpGet('https://api.alternative.me/fng/?limit=2');
    return {
      value:     parseInt(d.data?.[0]?.value),
      label:     d.data?.[0]?.value_classification,
      prevValue: parseInt(d.data?.[1]?.value),
    };
  } catch (e) { log(`Fear & Greed error: ${e.message}`); return null; }
}

// Compute max pain for the nearest Deribit weekly expiry (next Friday)
async function fetchOptionsData() {
  try {
    const now         = new Date();
    const daysTilFri  = ((5 - now.getDay()) + 7) % 7 || 7;
    const nextFriday  = new Date(now);
    nextFriday.setDate(now.getDate() + daysTilFri);

    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const expDay  = String(nextFriday.getDate()).padStart(2, '0');
    const expMon  = MONTHS[nextFriday.getMonth()];
    const expYr   = String(nextFriday.getFullYear()).slice(2);
    const prefix  = `BTC-${expDay}${expMon}${expYr}`;

    // Fetch all non-expired instruments + book summary in parallel
    const [instrResp, summaryResp] = await Promise.all([
      httpGet('https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false'),
      httpGet('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option'),
    ]);

    if (!instrResp?.result || !summaryResp?.result) return null;

    const expiring = instrResp.result.filter(i => i.instrument_name.startsWith(prefix));
    if (!expiring.length) {
      log(`No Deribit instruments found for prefix ${prefix}`);
      return null;
    }

    const summaryMap = {};
    for (const s of summaryResp.result) summaryMap[s.instrument_name] = s;

    // Build strike → { callOI, putOI } map
    const strikeMap = {};
    let underlyingPrice = 0;
    let oiCount = 0;

    for (const inst of expiring) {
      const parts  = inst.instrument_name.split('-');
      const strike = parseInt(parts[2]);
      const isCall = parts[3] === 'C';
      const s      = summaryMap[inst.instrument_name];
      const oi     = s?.open_interest ?? 0;
      if (s?.underlying_price) { underlyingPrice += s.underlying_price; oiCount++; }
      if (!strikeMap[strike]) strikeMap[strike] = { callOI: 0, putOI: 0 };
      if (isCall) strikeMap[strike].callOI += oi;
      else        strikeMap[strike].putOI  += oi;
    }

    const avgUnderlying = oiCount ? underlyingPrice / oiCount : 85000;
    const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);

    // Max pain: settlement price that minimises total options payout
    let minPayout = Infinity, maxPain = null;
    for (const settlement of strikes) {
      let payout = 0;
      for (const k of strikes) {
        payout += Math.max(settlement - k, 0) * strikeMap[k].callOI;
        payout += Math.max(k - settlement, 0) * strikeMap[k].putOI;
      }
      if (payout < minPayout) { minPayout = payout; maxPain = settlement; }
    }

    const totalOI = expiring.reduce((sum, i) => sum + (summaryMap[i.instrument_name]?.open_interest ?? 0), 0);
    const notionalUSD = totalOI * avgUnderlying;

    return {
      expiryLabel: nextFriday.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
      maxPain,
      notionalB: notionalUSD / 1e9,
      totalOI_BTC: Math.round(totalOI),
    };
  } catch (e) { log(`Options data error: ${e.message}`); return null; }
}

// High-impact USD events from ForexFactory public JSON feed
async function fetchEconomicCalendar() {
  try {
    const data = await httpGet('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!Array.isArray(data)) return [];

    // Next Monday through following Sunday
    const now   = new Date();
    const start = new Date(now); start.setDate(now.getDate() + 1);    // Mon
    const end   = new Date(now); end.setDate(now.getDate() + 7);      // Sun

    return data
      .filter(e => {
        if (e.country !== 'USD') return false;
        if (e.impact !== 'High' && e.impact !== 'Medium') return false;
        const d = new Date(e.date);
        return d >= start && d <= end;
      })
      .map(e => ({
        date:   new Date(e.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        time:   e.time  || '',
        title:  e.title || '',
        impact: e.impact,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) { log(`Calendar error: ${e.message}`); return []; }
}

// ─── Report formatting ────────────────────────────────────────────────────────

function $n(n) { return n != null ? `$${Math.round(n).toLocaleString()}` : '—'; }

function buildSummaryParagraph(d) {
  const { price, lwHigh, lwLow, lwOpen, lwClose, monthlyHigh, monthlyLow, monthlyOpen,
          quarterOpen, weeklyTrend, weeklyRSI, cvd, vwap, fundingRate,
          fearGreed, options, calendar, bias, zones4h } = d;

  const structureWord = weeklyTrend.trend.includes('Up') ? 'uptrend' : weeklyTrend.trend.includes('Down') ? 'downtrend' : 'sideways range';
  const biasWord      = bias.total >= 2 ? 'bullish' : bias.total <= -2 ? 'bearish' : 'neutral';
  const vwapWord      = vwap && price ? (price > vwap ? 'above' : 'below') : null;

  const fundingNote = (() => {
    if (fundingRate == null) return '';
    const p = fundingRate * 100;
    if (p > 0.05)  return ` Funding is elevated at +${p.toFixed(3)}%/8h — the market is over-leveraged long, meaning any downside move could be amplified by forced liquidations.`;
    if (p < -0.05) return ` Funding is negative at ${p.toFixed(3)}%/8h — shorts are over-leveraged and a short squeeze is possible on any sustained upward push.`;
    return ` Funding is neutral at ${p.toFixed(3)}%/8h, meaning no extreme positioning to be aware of.`;
  })();

  const fgNote = (() => {
    if (!fearGreed?.value) return '';
    const fg = fearGreed.value;
    const chg = fearGreed.prevValue ? (fg > fearGreed.prevValue ? `up from ${fearGreed.prevValue}` : `down from ${fearGreed.prevValue}`) : '';
    if (fg >= 75) return ` Sentiment has hit Extreme Greed at ${fg} (${chg}) — historically a caution zone where probability of a correction increases significantly.`;
    if (fg <= 25) return ` Sentiment is at Extreme Fear at ${fg} (${chg}) — historically one of the highest-probability long opportunities for patient buyers.`;
    return '';
  })();

  const optNote = options?.maxPain
    ? ` Friday's Deribit options expiry carries $${options.notionalB.toFixed(1)}B notional — max pain sits at ${$n(options.maxPain)}, giving market makers incentive to pin price near that level heading into Friday's close.`
    : '';

  const macroNote = (() => {
    const high = calendar.filter(e => e.impact === 'High');
    if (!high.length) return calendar.length
      ? ` There are minor macro events this week but no high-impact USD releases — price action will likely be technically driven.`
      : ` No major macro events this week — technically driven price action is expected.`;
    const top = high[0];
    return ` The key macro risk this week is ${top.title} on ${top.date} — be cautious of entering new positions in the hours immediately surrounding this release.`;
  })();

  const scenDirection = d.scenarios.primary.label === 'BULL CASE' ? 'bullish' : 'bearish';
  const scenNote = `The primary thesis is ${scenDirection} (${d.scenarios.primary.prob}): ${d.scenarios.primary.play}, targeting ${d.scenarios.primary.targets}. Invalidation: ${d.scenarios.primary.invalidation}.`;

  const zoneCount = zones4h.length;
  const zoneNote  = zoneCount
    ? ` LuxAlgo has drawn ${zoneCount} active supply/demand zones on the 4H chart — the closest levels above and below current price are the primary areas to watch for reactions and entry triggers.`
    : '';

  return `BTC enters the week in a ${structureWord} on the weekly timeframe, with the overall bias reading ${biasWord} at ${bias.total >= 0 ? '+' : ''}${bias.total}/${bias.maxPossible}.${vwapWord ? ` Price is currently ${vwapWord} the VWAP at ${$n(vwap)}, which ${vwapWord === 'above' ? 'supports the bullish read and suggests institutional positioning is net positive' : 'argues caution — institutions are underwater and selling into strength is the likely behaviour'}.` : ''}${fundingNote}${fgNote} Last week's range was ${$n(lwLow)}–${$n(lwHigh)} and both the LWH and LWL are live liquidity pools — price will seek to sweep at least one of them before the week closes.${optNote}${macroNote}${zoneNote} ${scenNote}`;
}

function formatReport(d) {
  const now       = new Date();
  const wkStart   = new Date(now); wkStart.setDate(now.getDate() + 1);
  const wkEnd     = new Date(now); wkEnd.setDate(now.getDate() + 7);
  const wkRange   = `${wkStart.toLocaleDateString('en-CA')} – ${wkEnd.toLocaleDateString('en-CA')}`;
  const monthName = now.toLocaleDateString('en-US', { month: 'short' });
  const SEP       = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const DASH      = '─'.repeat(38);

  // ── Reference levels ──
  const refLines = [
    `  ${(d.quarterOpen?.name || 'Quarter Open').padEnd(18)} ${$n(d.quarterOpen?.open).padEnd(12)} ← institutional regime pivot`,
    `  ${'Monthly Open  (' + monthName + ')' .padEnd(18)} ${$n(d.monthlyOpen)}`,
    `  ${'Monthly High  (' + monthName + ')' .padEnd(18)} ${$n(d.monthlyHigh)}`,
    `  ${'Monthly Low   (' + monthName + ')' .padEnd(18)} ${$n(d.monthlyLow)}`,
    `  ${DASH}`,
    `  ${'Last Week Open'.padEnd(18)} ${$n(d.lwOpen)}`,
    `  ${'Last Week High'.padEnd(18)} ${$n(d.lwHigh).padEnd(12)} ← LWH — liquidity pool above`,
    `  ${'Last Week Low' .padEnd(18)} ${$n(d.lwLow).padEnd(12)}  ← LWL — liquidity pool below`,
    `  ${'Last Week Close'.padEnd(18)} ${$n(d.lwClose)}`,
    `  ${DASH}`,
    `  ${'Current Price'.padEnd(18)} ${$n(d.price)}`,
  ].join('\n');

  // ── Key levels ──
  const p = d.price;
  const allLevels = [
    ...d.zones4h.map(z => ({
      price:  (z.high + z.low) / 2,
      label:  `LuxAlgo zone $${Math.round(z.low).toLocaleString()}–$${Math.round(z.high).toLocaleString()}`,
      stars:  '★',
      side:   z.low > p ? 'R' : z.high < p ? 'S' : 'AT',
    })),
    { price: d.lwHigh,          label: 'Last Week High — liquidity pool',              stars: '★★',  side: d.lwHigh  > p ? 'R' : 'S' },
    { price: d.lwLow,           label: 'Last Week Low — liquidity pool',               stars: '★★',  side: d.lwLow   > p ? 'R' : 'S' },
    { price: d.lwOpen,          label: 'Last Week Open — structural pivot',            stars: '★★',  side: d.lwOpen  > p ? 'R' : 'S' },
    { price: d.monthlyHigh,     label: 'Monthly High',                                 stars: '★★★', side: d.monthlyHigh > p ? 'R' : 'S' },
    { price: d.monthlyLow,      label: 'Monthly Low',                                  stars: '★★★', side: d.monthlyLow  > p ? 'R' : 'S' },
    d.quarterOpen
      ? { price: d.quarterOpen.open, label: `${d.quarterOpen.name} Open — institutional pivot`, stars: '★★★', side: d.quarterOpen.open > p ? 'R' : 'S' }
      : null,
  ].filter(Boolean);

  const resistance = allLevels.filter(l => l.side === 'R').sort((a, b) => a.price - b.price).slice(0, 5);
  const support    = allLevels.filter(l => l.side === 'S').sort((a, b) => b.price - a.price).slice(0, 5);
  const fmtLevel   = l => `  ${$n(l.price).padEnd(12)} ${l.stars.padEnd(5)} ${l.label}`;
  const resLines   = resistance.map(fmtLevel).join('\n') || '  None identified in current range';
  const suppLines  = support.map(fmtLevel).join('\n')    || '  None identified in current range';

  // ── Order flow ──
  const fr    = d.fundingRate;
  const frStr = fr == null ? '—'
    : Math.abs(fr * 100) < 0.02 ? `${(fr*100).toFixed(3)}%/8h — neutral`
    : fr > 0 ? `+${(fr*100).toFixed(3)}%/8h — long-heavy${Math.abs(fr*100) > 0.05 ? ' ⚠️' : ''}`
    : `${(fr*100).toFixed(3)}%/8h — short-heavy${Math.abs(fr*100) > 0.05 ? ' ⚠️' : ''}`;

  const fg    = d.fearGreed;
  const fgStr = fg ? `${fg.value} — ${fg.label} (${fg.value > fg.prevValue ? '↑' : fg.value < fg.prevValue ? '↓' : '→'} from ${fg.prevValue} last week)` : '—';

  // ── Macro calendar ──
  const calLines = d.calendar.length
    ? d.calendar.map(e => `  ${e.date.padEnd(16)} ${e.impact === 'High' ? '🔴' : '⚠️ '} ${e.title}${e.time ? ` — ${e.time} ET` : ''}`)
        .join('\n')
    : '  No high-impact USD events this week';
  const hasFOMC  = d.calendar.some(e => /fomc|federal funds/i.test(e.title));
  const fomcNote = hasFOMC ? '' : '\n  ⚡ No FOMC this week';

  // ── Options ──
  const optLines = d.options
    ? `  Expiry     ${d.options.expiryLabel} — $${d.options.notionalB.toFixed(1)}B notional open interest\n  Max Pain   ${$n(d.options.maxPain)} — market makers incentivised to pin price near this level`
    : '  Data unavailable (Deribit API did not respond)';

  // ── Bias score ──
  const biasLines = d.bias.scores.map(s =>
    `  ${s.icon}  ${s.label.padEnd(22)} ${s.text}${s.val !== 0 ? ` (${s.val > 0 ? '+' : ''}${s.val})` : ''}`
  ).join('\n');
  const totalStr = `${d.bias.total >= 0 ? '+' : ''}${d.bias.total} / ${d.bias.maxPossible}`;

  // ── Scenarios ──
  const { primary, secondary } = d.scenarios;
  const scenLines = [
    `  ${primary.label} — ${primary.prob} probability`,
    `  Trigger      ${primary.trigger}`,
    `  Play         ${primary.play}`,
    `  Targets      ${primary.targets}`,
    `  ✗ Invalid    ${primary.invalidation}`,
    ``,
    `  ${secondary.label} — ${secondary.prob} probability`,
    `  Trigger      ${secondary.trigger}`,
    `  Play         ${secondary.play}`,
    `  Targets      ${secondary.targets}`,
    `  ✗ Invalid    ${secondary.invalidation}`,
  ].join('\n');

  // ── Summary paragraph ──
  const summary = buildSummaryParagraph(d);

  return [
    `📋 **WEEKLY WAR REPORT** | BINANCE:BTCUSDT.P`,
    `Week of ${wkRange}`,
    SEP,
    ``,
    `**🗓️  REFERENCE LEVELS**`,
    refLines,
    ``,
    `**🏗️  MARKET STRUCTURE**`,
    `  Weekly Candle    ${d.weeklyCandle}`,
    `  Weekly Trend     ${d.weeklyTrend.trend} — ${d.weeklyTrend.detail}`,
    `  Monthly Trend    ${d.monthlyTrend}`,
    `  HTF Bias         ${d.bias.biasEmoji} ${d.bias.biasLabel}`,
    ``,
    `**📍  KEY LEVELS THIS WEEK**`,
    ``,
    `  RESISTANCE`,
    resLines,
    ``,
    `  SUPPORT`,
    suppLines,
    ``,
    `**📊  ORDER FLOW & SENTIMENT**`,
    `  CVD              ${d.cvd != null ? `${d.cvd >= 0 ? '+' : ''}${Math.round(d.cvd)} — ${d.cvd >= 0 ? 'buyers in control' : 'sellers in control'}` : '—'}`,
    `  Open Interest    ${d.oi != null ? `$${(d.oi).toFixed(1)}B` : '—'}`,
    `  Funding Rate     ${frStr}`,
    `  Fear & Greed     ${fgStr}`,
    `  Weekly RSI (14)  ${d.weeklyRSI != null ? d.weeklyRSI.toFixed(0) : '—'}`,
    ``,
    `**🎯  SCENARIO PLANNING**`,
    ``,
    scenLines,
    ``,
    `**📅  MACRO CALENDAR**`,
    ``,
    calLines,
    fomcNote,
    ``,
    `**🔮  BTC OPTIONS EXPIRY**`,
    ``,
    optLines,
    ``,
    `**🧭  WEEKLY BIAS SCORE**`,
    ``,
    biasLines,
    `  ${'─'.repeat(46)}`,
    `  Score  ${totalStr}   →   ${d.bias.biasEmoji} ${d.bias.biasLabel}`,
    `  ${d.bias.verdict}`,
    ``,
    SEP,
    ``,
    `**📝  WEEKLY SETUP SUMMARY**`,
    ``,
    summary,
    ``,
    SEP,
  ].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Weekly War Report starting...');

  // ── 1. TradingView data via CDP ────────────────────────────────────────────
  let client;
  let price = null, lwHigh = null, lwLow = null, lwOpen = null, lwClose = null;
  let monthlyHigh = null, monthlyLow = null, monthlyOpen = null, quarterOpen = null;
  let cvd = null, oi = null, vwap = null;
  let weeklyCandle = 'Data unavailable', weeklyTrend = { trend: 'Unknown', detail: '' };
  let monthlyTrend = 'Unknown', weeklyRSI = null, zones4h = [];

  try {
    client = await cdpConnect();
    log('CDP connected');

    const quote = await cdpEval(client, QUOTE_EXPR);
    if (!quote || quote.error) throw new Error(`Could not read price: ${quote?.error || 'null response'}`);
    price = quote.last;
    log(`Price: ${price}`);

    const originalTF = await cdpEval(client, GET_TF_EXPR) || '30';

    // 30m indicator readings
    const studies = await cdpEval(client, STUDY_VALUES_EXPR);
    const parsed  = parseStudies(studies || []);
    cvd  = parsed.cvd;
    oi   = parsed.oi;
    vwap = parsed.vwap;
    log(`CVD: ${cvd}, OI: ${oi}, VWAP: ${vwap}`);

    // 4H LuxAlgo zones
    await cdpEval(client, buildSetTFExpr('240'));
    await new Promise(r => setTimeout(r, 1500));
    zones4h = await cdpEval(client, buildBoxesExpr('LuxAlgo')) || [];
    log(`4H zones: ${zones4h.length}`);
    await cdpEval(client, buildSetTFExpr(originalTF));
    await new Promise(r => setTimeout(r, 800));

    // Weekly bars (20 bars = ~5 months of weekly history)
    const weeklyBars = await fetchHTFBars(client, 'W', 20, originalTF);
    log(`Weekly bars: ${weeklyBars.length}`);
    if (weeklyBars.length >= 2) {
      const lw = weeklyBars[weeklyBars.length - 2]; // last complete week
      lwHigh  = lw.h; lwLow = lw.l; lwOpen = lw.o; lwClose = lw.c;
      weeklyCandle = analyseWeeklyCandle(lw);
      weeklyTrend  = analyseWeeklyTrend(weeklyBars);
      weeklyRSI    = computeRSI(weeklyBars.map(b => b.c), 14);
    }

    // Monthly bars (12 bars = 12 months of history)
    const monthlyBars = await fetchHTFBars(client, '1M', 12, originalTF);
    log(`Monthly bars: ${monthlyBars.length}`);
    if (monthlyBars.length >= 2) {
      const cm     = monthlyBars[monthlyBars.length - 1]; // current month
      monthlyOpen  = cm.o;
      monthlyHigh  = cm.h;
      monthlyLow   = cm.l;
      quarterOpen  = getQuarterOpen(monthlyBars);
      monthlyTrend = analyseMonthlyTrend(monthlyBars);
    }

    log('TradingView data collection complete');
  } catch (e) {
    log(`TradingView error: ${e.message || JSON.stringify(e)}`);
  } finally {
    if (client) { try { await client.close(); } catch {} }
  }

  // ── 2. External APIs (parallel) ────────────────────────────────────────────
  log('Fetching external data...');
  const [fundingRate, fearGreed, options, calendar] = await Promise.all([
    fetchFundingRate(),
    fetchFearAndGreed(),
    fetchOptionsData(),
    fetchEconomicCalendar(),
  ]);
  log(`Funding: ${fundingRate}, F&G: ${fearGreed?.value}, MaxPain: ${options?.maxPain}, Events: ${calendar.length}`);

  // ── 3. Analysis ────────────────────────────────────────────────────────────
  const bias = computeBiasScore({
    weeklyTrend: weeklyTrend.trend, cvd, fundingRate,
    price, vwap, weeklyRSI, fearGreed,
  });

  const scenarios = buildScenarios(
    price, lwHigh, lwLow, lwOpen,
    monthlyHigh, quarterOpen?.open, zones4h, bias.total
  );

  // ── 4. Format ──────────────────────────────────────────────────────────────
  const reportData = {
    price, lwHigh, lwLow, lwOpen, lwClose,
    monthlyHigh, monthlyLow, monthlyOpen, quarterOpen,
    weeklyCandle, weeklyTrend, monthlyTrend,
    zones4h, cvd, oi, vwap, weeklyRSI,
    fundingRate, fearGreed, options, calendar,
    bias, scenarios,
  };

  const report = formatReport(reportData);
  console.log('\n' + report + '\n');

  // ── 5. Post to Discord (split at 3900 chars if needed) ────────────────────
  const MAX = 3900;
  const makeEmbed = (text, part) => ({
    description: text,
    color: 0x1A1A2E,  // deep navy — serious, institutional
    footer: { text: `Ace • BINANCE:BTCUSDT.P • Weekly War Report${part ? ` (${part})` : ''}` },
    timestamp: new Date().toISOString(),
  });

  if (report.length <= MAX) {
    await postToDiscord({ embeds: [makeEmbed(report, null)] });
  } else {
    // Find clean split point (end of a section, marked by ━━━ or blank line before a **)
    let splitAt = report.lastIndexOf('\n\n**', MAX);
    if (splitAt < 0) splitAt = report.lastIndexOf('\n', MAX);
    const p1 = report.slice(0, splitAt);
    const p2 = report.slice(splitAt + 1);
    await postToDiscord({ embeds: [makeEmbed(p1, '1/2')] });
    await new Promise(r => setTimeout(r, 600));
    await postToDiscord({ embeds: [makeEmbed(p2, '2/2')] });
  }

  log('Weekly War Report posted successfully');
}

main().catch(err => {
  console.error('weekly-war-report failed:', err.message);
  process.exit(1);
});
