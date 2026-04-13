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
 *   2. Reads price, supply/demand zones, CVD, OI, Session VP
 *   3. Checks zone proximity trigger formula
 *   4. If triggered: evaluates setup criteria + generates full trade plan
 *   5. Posts complete setup to Discord (entry, SL, TPs, criteria, alerts)
 *   6. On any error: posts actionable error message to Discord
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

function notify(type, message) {
  try {
    execFileSync('bash', [NOTIFY, type, message], { stdio: 'pipe' });
    log(`Discord [${type}] sent`);
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
  const vwapStudy   = find('Volume Weighted Average Price') || find('VWAP');

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

  const vwap = vwapStudy
    ? parseFloat_(Object.values(vwapStudy.values || {})[0])
    : null;

  return { cvd, oi, sessionVP, vwap };
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

// ─── Setup Evaluation ────────────────────────────────────────────────────────

function evaluateSetup(price, zone, indicators, allZones) {
  const { cvd, oi, sessionVP, vwap, oiTrend, macd4h, rsi12h } = indicators;

  const isSupply    = price < zone.low;   // zone above price
  const isDemand    = price > zone.high;  // zone below price
  const direction   = isSupply ? 'short' : 'long';

  // --- Criteria ---
  const criteria = [];

  // 1. Price location
  criteria.push({
    label: isSupply ? 'Price approaching supply zone'
         : isDemand ? 'Price approaching demand zone'
         : 'Price inside zone',
    pass: true, auto: true,
  });

  // 2. CVD alignment
  if (cvd != null) {
    const aligned = direction === 'short' ? cvd < 0 : cvd > 0;
    criteria.push({
      label: `CVD ${cvd > 0 ? '+' : ''}${Math.round(cvd)} (${cvd < 0 ? 'bearish' : 'bullish'})`,
      pass: aligned, auto: true,
    });
  } else {
    criteria.push({ label: 'CVD: unavailable', pass: null, auto: false });
  }

  // 3. Session VP
  if (sessionVP) {
    const ratio = sessionVP.up / (sessionVP.down || 1);
    const sessionBearish = sessionVP.down > sessionVP.up;
    const sessionBullish = sessionVP.up > sessionVP.down;
    const aligned = direction === 'short' ? sessionBearish : sessionBullish;
    criteria.push({
      label: `Session VP ${sessionVP.up}↑ / ${sessionVP.down}↓ (${sessionBearish ? 'bearish' : sessionBullish ? 'bullish' : 'neutral'})`,
      pass: aligned, auto: true,
    });
  }

  // 4. VWAP position
  if (vwap != null) {
    const belowVwap = price < vwap;
    const aboveVwap = price > vwap;
    const aligned = direction === 'short' ? belowVwap : aboveVwap;
    criteria.push({
      label: `VWAP $${Math.round(vwap).toLocaleString()} — price is ${belowVwap ? 'below' : 'above'}`,
      pass: aligned, auto: true,
    });
  }

  // 5. OI trend
  if (oiTrend && oiTrend !== 'flat') {
    const oiRising = oiTrend === 'rising';
    const aligned = direction === 'long' ? oiRising : !oiRising;
    criteria.push({
      label: `OI ${oiTrend} — ${oiRising ? 'conviction' : 'caution/liquidation'}`,
      pass: aligned, auto: true,
    });
  } else if (oiTrend === 'flat') {
    criteria.push({ label: `OI flat — no directional conviction`, pass: null, auto: false });
  } else {
    criteria.push({ label: `OI ${oi != null ? oi.toFixed(2) : 'n/a'} — first run, trend available next poll`, pass: null, auto: false });
  }

  // 6. 4H MACD
  if (macd4h) {
    const aligned = direction === 'long' ? macd4h.bullish : !macd4h.bullish;
    criteria.push({
      label: `4H MACD ${macd4h.bullish ? 'bullish' : 'bearish'} (hist ${macd4h.histogram > 0 ? '+' : ''}${Math.round(macd4h.histogram)})`,
      pass: aligned, auto: true,
    });
  } else {
    criteria.push({ label: '4H MACD — unavailable', pass: null, auto: false, note: 'Check chart manually' });
  }

  // 7. 12H RSI
  if (rsi12h != null) {
    const rsiRounded = Math.round(rsi12h);
    const aboveMid = rsi12h > 50;
    const aligned = direction === 'long' ? aboveMid : !aboveMid;
    criteria.push({
      label: `12H RSI ${rsiRounded} (${aboveMid ? 'above' : 'below'} 50)`,
      pass: aligned, auto: true,
    });
  } else {
    criteria.push({ label: '12H RSI — unavailable', pass: null, auto: false, note: 'Check chart manually' });
  }

  // --- Levels ---
  const buf = 0.002; // 0.2% stop buffer
  let entry, stop, tp1Price, tp2Price, tp3Price;

  if (direction === 'short') {
    entry    = Math.round(zone.low + (zone.high - zone.low) * 0.3);
    stop     = Math.round(zone.high * (1 + buf));
    const riskPts = stop - entry;
    // TPs: demand zones below current price, sorted closest first
    const targets = allZones
      .filter(z => z.high < price - 100)
      .sort((a, b) => b.high - a.high);
    tp1Price = Math.round(targets[0]?.high ?? (entry - riskPts));
    tp2Price = Math.round(targets[1]?.high ?? (entry - riskPts * 2));
    tp3Price = Math.round(entry - riskPts * 3);
  } else {
    entry    = Math.round(zone.high - (zone.high - zone.low) * 0.3);
    stop     = Math.round(zone.low * (1 - buf));
    const riskPts = entry - stop;
    // TPs: supply zones above current price, sorted closest first
    const targets = allZones
      .filter(z => z.low > price + 100)
      .sort((a, b) => a.low - b.low);
    tp1Price = Math.round(targets[0]?.low ?? (entry + riskPts));
    tp2Price = Math.round(targets[1]?.low ?? (entry + riskPts * 2));
    tp3Price = Math.round(entry + riskPts * 3);
  }

  const riskPts = Math.abs(entry - stop);
  const rr1 = riskPts > 0 ? (Math.abs(tp1Price - entry) / riskPts).toFixed(1) : '?';
  const rr2 = riskPts > 0 ? (Math.abs(tp2Price - entry) / riskPts).toFixed(1) : '?';
  const rr3 = riskPts > 0 ? (Math.abs(tp3Price - entry) / riskPts).toFixed(1) : '?';

  // --- Confirm count ---
  const autoPassed = criteria.filter(c => c.auto && c.pass === true).length;
  const autoFailed = criteria.filter(c => c.auto && c.pass === false).length;
  const autoTotal  = criteria.filter(c => c.auto).length;

  // --- Setup classification ---
  // Setup C (Liquidity Grab): all auto criteria pass including VWAP → ~70%
  // Setup A (Trend Continuation): majority pass → ~62%
  // Setup B (Reversal at Major Level): partial confirmation → ~52%
  let setupType, probability;
  if (autoPassed === autoTotal && autoTotal >= 3) {
    setupType = 'C — Liquidity Grab'; probability = '~70%';
  } else if (autoPassed >= autoTotal * 0.6) {
    setupType = 'A — Trend Continuation'; probability = '~62%';
  } else {
    setupType = 'B — Reversal'; probability = '~52%';
  }

  return {
    direction, entry, stop, tp1Price, tp2Price, tp3Price,
    rr1, rr2, rr3, criteria,
    autoPassed, autoFailed, autoTotal,
    zoneType: isSupply ? 'Supply' : isDemand ? 'Demand' : 'Inside',
    setupType, probability,
  };
}

// ─── Discord Message Formatter ────────────────────────────────────────────────

function formatSetupMessage(price, zone, setup) {
  const { direction, entry, stop, tp1Price, tp2Price, tp3Price, rr1, rr2, rr3, criteria, autoPassed, autoTotal, zoneType, setupType, probability } = setup;
  const dirLabel = direction === 'short' ? '🔴 SHORT' : '🟢 LONG';
  const trigger  = direction === 'short'
    ? 'Wait for 30M CHoCH below current price'
    : 'Wait for 30M CHoCH above current price';
  const invalidation = direction === 'short'
    ? `4H close above $${stop.toLocaleString()}`
    : `4H close below $${stop.toLocaleString()}`;
  const alertLevels = [
    `$${Math.round(direction === 'short' ? zone.low : zone.high).toLocaleString()} (zone edge)`,
    `$${stop.toLocaleString()} (stop)`,
    `$${tp1Price.toLocaleString()} (TP1)`,
  ].join(' | ');

  const criteriaLines = criteria.map(c => {
    const icon = c.pass === true ? '✅' : c.pass === false ? '❌' : '⚠️';
    return `${icon} ${c.label}${c.note ? ` — ${c.note}` : ''}`;
  }).join('\n');

  return [
    `${dirLabel} SIGNAL | BINANCE:BTCUSDT.P`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `**Price** $${Math.round(price).toLocaleString()} | **${zoneType} Zone** $${Math.round(zone.low).toLocaleString()}–$${Math.round(zone.high).toLocaleString()}`,
    `**Setup** ${setupType} | **Win Rate** ${probability}`,
    ``,
    `**ENTRY**  $${entry.toLocaleString()}`,
    `**STOP**   $${stop.toLocaleString()}`,
    `**TP1**    $${tp1Price.toLocaleString()} — 1:${rr1}`,
    `**TP2**    $${tp2Price.toLocaleString()} — 1:${rr2}`,
    `**TP3**    $${tp3Price.toLocaleString()} — 1:${rr3}`,
    ``,
    `**TRIGGER**  ${trigger}`,
    ``,
    `**CRITERIA** (${autoPassed}/${autoTotal} auto-confirmed)`,
    criteriaLines,
    ``,
    `**INVALIDATION**  ${invalidation}`,
    ``,
    `**SET ALERTS**  ${alertLevels}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `\`You are analysing BINANCE:BTCUSDT.P using the TradingView MCP server. Switch to the 🕵Ace layout. A ${direction.toUpperCase()} signal just fired at $${Math.round(price).toLocaleString()} in the ${zoneType.toLowerCase()} zone $${Math.round(zone.low).toLocaleString()}–$${Math.round(zone.high).toLocaleString()} (${setupType}, ${probability} win rate). Run the full 12H→4H→1H→30M analysis from strategies/mtf-analysis.md. Evaluate all setup criteria in strategies/smc-setups.md and give me a clear take/skip/wait verdict with your reasoning. Post your verdict to Discord via: bash /Users/vpm/trading/scripts/discord-notify.sh ${direction} "your message here".\``,
  ].join('\n');
}

// ─── Cooldown / Alert State ───────────────────────────────────────────────────
//
// State file format:
//   { "71750-71580": { ts: 1234567890, direction: "long", high: 71750, low: 71580 },
//     "_previousOI": 91.38 }
//
// Keys prefixed with "_" are internal (OI tracking etc.), not zone entries.

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

function markAlerted(zoneKey, direction, zone) {
  const state = readState();
  state[zoneKey] = { ts: Date.now(), direction, high: zone.high, low: zone.low };
  writeState(state);
}

// When OI is flat or unknown at alert time, register the zone for automatic
// confirmation detection. On each subsequent tick, checkPendingConfirmation()
// compares current OI and CVD against the baseline captured here. When both
// confirm, it fires a TRIGGER CONFIRMED Discord alert without waiting for the
// next manual analysis run, bypassing the cooldown gate entirely.
function markPending(zoneKey, direction, zone, indicators) {
  const state = readState();
  const key = `_pending_${zoneKey}`;
  state[key] = {
    ts:          Date.now(),
    direction,
    high:        zone.high,
    low:         zone.low,
    expires:     Date.now() + PENDING_TTL_MS,
    baselineOI:  indicators.oi,
    baselineCVD: indicators.cvd,
  };
  writeState(state);
  log(`Zone ${zoneKey} → pending confirmation (baseline OI: ${indicators.oi}, CVD: ${indicators.cvd})`);
}

// ─── Invalidation Check ───────────────────────────────────────────────────────
//
// Called every poll. Compares previously alerted zones against current active
// zones. If a zone has disappeared (LuxAlgo mitigated it), evaluates CVD + OI
// to determine whether it was a real institutional break or a stop hunt.
//
// Verdict logic (based on market microstructure research):
//   Real break   : CVD confirms break direction AND OI rising → ~68–72% continuation
//   Ambiguous    : CVD contradicts OR OI flat/falling → ~63% reversal probability
//
// In both cases the zone is removed from state (cooldown reset), so if LuxAlgo
// redraws the zone, a fresh alert can fire. Zones that survive a stop hunt are
// proven levels — resetting the cooldown is correct.

function checkInvalidations(currentZones, price, indicators) {
  const { cvd, oiTrend } = indicators;
  const state = readState();
  const messages = [];

  for (const [key, entry] of Object.entries(state)) {
    if (key.startsWith('_')) continue;
    if (typeof entry !== 'object' || !entry.direction) continue; // legacy entry

    // Is this zone still active?
    const stillActive = currentZones.some(z =>
      Math.abs(z.high - entry.high) < 10 && Math.abs(z.low - entry.low) < 10
    );
    if (stillActive) continue;

    // Zone is gone — determine verdict
    const { direction, high, low } = entry;
    // Real break: CVD moves against the trade AND OI expands (new conviction positions)
    const cvdConfirmsBreak = direction === 'long' ? (cvd != null && cvd < 0) : (cvd != null && cvd > 0);
    const oiExpanding      = oiTrend === 'rising';
    const isRealBreak      = cvdConfirmsBreak && oiExpanding;

    log(`Zone ${key} mitigated | CVD confirms break: ${cvdConfirmsBreak} | OI expanding: ${oiExpanding} | verdict: ${isRealBreak ? 'REAL BREAK' : 'AMBIGUOUS'}`);

    // Mark any open trade for this zone as invalidated in the trade log
    if (isRealBreak) {
      const trades = readTrades();
      for (const t of trades) {
        if (t.outcome !== null) continue;
        if (Math.abs(t.zone.high - high) < 10 && Math.abs(t.zone.low - low) < 10) {
          t.outcome  = 'invalidated';
          t.closedAt = new Date().toISOString();
          t.pnlR     = -1.0; // treated as a loss — stop thesis failed
          log(`Trade for zone ${key} marked invalidated`);
        }
      }
      writeTrades(trades);
    }

    messages.push(formatInvalidationMessage(price, direction, { high, low }, isRealBreak, cvd, cvdConfirmsBreak, oiTrend, oiExpanding, currentZones));

    // Remove the alerted zone entry.
    // If ambiguous, add to watch list so the next polls can detect a reclaim.
    // If real break, no watch needed.
    delete state[key];
    if (!isRealBreak) {
      const watchKey = `_watch_${key}`;
      state[watchKey] = {
        ts: Date.now(),
        direction,
        high,
        low,
        expires: Date.now() + 4 * 60 * 60 * 1000, // watch for 4 hours
      };
      log(`Zone ${key} added to reclaim watch list (expires in 4h)`);
    }
  }

  writeState(state);
  return messages;
}

function formatInvalidationMessage(price, direction, zone, isRealBreak, cvd, cvdConfirmsBreak, oiTrend, oiExpanding, allZones) {
  const zoneStr   = `$${Math.round(zone.low).toLocaleString()}–$${Math.round(zone.high).toLocaleString()}`;
  const dirLabel  = direction === 'long' ? 'LONG' : 'SHORT';

  const cvdIcon  = cvdConfirmsBreak ? '❌' : '✅';
  const oiIcon   = oiExpanding      ? '❌' : '✅';
  const cvdLabel = cvd != null ? `${cvd > 0 ? '+' : ''}${Math.round(cvd)} (${cvd < 0 ? 'bearish' : 'bullish'})` : 'unavailable';
  const oiLabel  = oiTrend ?? 'unavailable';

  // Find next level in the direction of the break
  const nextZone = direction === 'long'
    ? allZones.filter(z => z.high < zone.low - 50).sort((a, b) => b.high - a.high)[0]
    : allZones.filter(z => z.low  > zone.high + 50).sort((a, b) => a.low  - b.low )[0];
  const nextLevelStr = nextZone
    ? `$${Math.round(nextZone.low).toLocaleString()}–$${Math.round(nextZone.high).toLocaleString()} ($${Math.round(Math.min(Math.abs(price - nextZone.high), Math.abs(price - nextZone.low))).toLocaleString()} away)`
    : 'No next zone found';

  if (isRealBreak) {
    return [
      `🚫 SIGNAL INVALIDATED | BINANCE:BTCUSDT.P`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Original ${dirLabel} zone ${zoneStr} has been mitigated.`,
      ``,
      `**VERDICT**  Real break — ${dirLabel} thesis is off`,
      `Price broke through with institutional confirmation. Not a stop hunt.`,
      ``,
      `**ORDER FLOW AT BREAK**`,
      `${cvdIcon} CVD ${cvdLabel}`,
      `${oiIcon} OI ${oiLabel} — new positions, real conviction`,
      ``,
      `**NEXT LEVEL**  ${nextLevelStr}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `\`You are analysing BINANCE:BTCUSDT.P using the TradingView MCP server. Switch to the 🕵Ace layout. A ${dirLabel} zone ${zoneStr} was just confirmed broken — rising OI and ${direction === 'long' ? 'bearish' : 'bullish'} CVD both confirmed the move. Run the full 12H→4H→1H→30M analysis from strategies/mtf-analysis.md. Identify the next key ${direction === 'long' ? 'demand' : 'supply'} zone, assess whether a new setup in either direction is forming, and post your verdict to Discord via: bash /Users/vpm/trading/scripts/discord-notify.sh info "your message here".\``,
    ].join('\n');
  } else {
    const watchAction = direction === 'long'
      ? `If price reclaims $${Math.round(zone.low).toLocaleString()} with rising CVD → long still viable`
      : `If price reclaims $${Math.round(zone.high).toLocaleString()} with falling CVD → short still viable`;
    return [
      `⚠️ ZONE REMOVED | BINANCE:BTCUSDT.P`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Original ${dirLabel} zone ${zoneStr} has been mitigated.`,
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
      `\`You are analysing BINANCE:BTCUSDT.P using the TradingView MCP server. Switch to the 🕵Ace layout. A ${dirLabel} zone ${zoneStr} was just mitigated with flat/falling OI and ${cvd != null && cvd > 0 ? 'bullish' : 'bearish'} CVD — this is a probable stop hunt (~63% reversal probability). Run the 30M analysis from strategies/mtf-analysis.md. Check whether price is forming a reclaim above $${Math.round(direction === 'long' ? zone.low : zone.high).toLocaleString()} with rising CVD. If yes, confirm as a long setup. If not, assess downside. Post your verdict to Discord via: bash /Users/vpm/trading/scripts/discord-notify.sh info "your message here".\``,
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

function checkReclaimWatch(currentZones, price, indicators) {
  const { cvd, oiTrend } = indicators;
  const state = readState();
  const messages = [];

  for (const [key, watch] of Object.entries(state)) {
    if (!key.startsWith('_watch_')) continue;

    // Expire old watches
    if (Date.now() > watch.expires) {
      log(`Reclaim watch ${key} expired — removing`);
      delete state[key];
      continue;
    }

    const { direction, high, low } = watch;
    const zone = { high, low };
    const proximity = checkProximity(price, zone);

    if (!proximity.triggered) continue;

    // Price is back near the zone — check order flow confirms the reclaim
    const cvdAligned = direction === 'long' ? (cvd != null && cvd > 0) : (cvd != null && cvd < 0);
    const oiAligned  = oiTrend === 'rising';

    if (cvdAligned && oiAligned) {
      const zoneStr  = `$${Math.round(low).toLocaleString()}–$${Math.round(high).toLocaleString()}`;
      const dirLabel = direction === 'long' ? 'LONG' : 'SHORT';
      const cvdLabel = `${cvd > 0 ? '+' : ''}${Math.round(cvd)} (${cvd < 0 ? 'bearish' : 'bullish'})`;
      log(`Reclaim confirmed: ${dirLabel} zone ${zoneStr} | CVD ${cvdLabel} | OI ${oiTrend}`);

      messages.push([
        `🔄 RECLAIM CONFIRMED | BINANCE:BTCUSDT.P`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Price has returned to ${dirLabel} zone ${zoneStr} with institutional backing.`,
        `The earlier break was a stop hunt. Original thesis back in play.`,
        ``,
        `**ORDER FLOW AT RECLAIM**`,
        `✅ CVD ${cvdLabel}`,
        `✅ OI ${oiTrend} — new positioning confirming the reclaim`,
        ``,
        `**ACTION**  Re-evaluate entry. Wait for 30M CHoCH in ${direction} direction.`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `\`You are analysing BINANCE:BTCUSDT.P using the TradingView MCP server. Switch to the 🕵Ace layout. A ${dirLabel} zone ${zoneStr} that was previously swept as a stop hunt has now been reclaimed — price is back in zone with rising OI and ${direction === 'long' ? 'bullish' : 'bearish'} CVD. Run the 30M analysis from strategies/mtf-analysis.md. Check for CHoCH formation. Give me a take/skip verdict and post it to Discord via: bash /Users/vpm/trading/scripts/discord-notify.sh ${direction} "your message here".\``,
      ].join('\n'));

      // Remove watch, set a fresh cooldown so it doesn't immediately re-trigger
      delete state[key];
      const zoneKey = key.replace('_watch_', '');
      state[zoneKey] = { ts: Date.now(), direction, high, low };
    } else {
      log(`Reclaim watch ${key}: price near zone but order flow not confirming (CVD aligned: ${cvdAligned}, OI aligned: ${oiAligned})`);
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

    const { direction, high, low, baselineOI, baselineCVD } = pending;

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
      `Zone ${zoneStr} — flat OI at alert time has now confirmed.`,
      `Institutional flow entered AFTER the initial alert. This is the real entry.`,
      ``,
      `**CONFIRMATION ORDER FLOW**`,
      `✅ OI: ${baselineOI?.toFixed(2)}K → ${oi?.toFixed(2)}K (+${oiPct}%) — new ${direction} positions opening`,
      `✅ CVD: ${cvdBase} → ${cvdNow} (Δ ${cvdDeltaStr}) — conviction surge confirmed`,
      ``,
      `**PRICE** $${Math.round(price).toLocaleString()} | **ZONE** ${zoneStr}`,
      ``,
      `**ENTRY**  Pullback to zone top $${Math.round(high).toLocaleString()} or aggressive at market`,
      `**STOP**   Below zone low $${Math.round(low * (1 - 0.002)).toLocaleString()}`,
      `**ACTION** Check 30M for CHoCH — if not fired yet, it is imminent`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `\`You are analysing BINANCE:BTCUSDT.P using the TradingView MCP server. Switch to the 🕵Ace layout. A ${direction.toUpperCase()} zone ${zoneStr} has just received institutional confirmation — OI rose ${oiPct}% and CVD surged from ${cvdBase} to ${cvdNow} since the initial zone alert. This is the delayed confirmation that was missing at first alert. Run the 30M analysis from strategies/mtf-analysis.md focusing on: (1) has 30M CHoCH fired at the zone? (2) is OI still rising? Give a take/late-entry/skip verdict and post to Discord via: bash /Users/vpm/trading/scripts/discord-notify.sh ${direction} "your message here".\``,
    ].join('\n');

    // Remove pending state, refresh the zone's cooldown timestamp
    delete state[key];
    const zoneKey = key.replace('_pending_', '');
    state[zoneKey] = { ts: Date.now(), direction, high, low };

    results.push({ msg, direction });
    log(`Pending ${key} CONFIRMED — firing ${dirLabel} alert`);
  }

  writeState(state);
  return results;
}

// ─── Trade Log ───────────────────────────────────────────────────────────────
//
// trades.json schema (array of trade objects):
// {
//   id:        "1744000000000-70823-70470"   unique: ts + zone
//   firedAt:   ISO timestamp
//   direction: "long" | "short"
//   setupType: "A — Trend Continuation" etc.
//   price:     70775                          price when alert fired
//   zone:      { high: 70823, low: 70470 }
//   entry:     70717
//   stop:      70329
//   tp1:       71580,  tp2: 73400,  tp3: 71881
//   rr1:       "2.2",  rr2: "6.9",  rr3: "3.0"
//   criteria:  [ { label, pass, auto } ... ]  snapshot of criteria at signal time
//   indicators: { cvd, oi, oiTrend, vwap, macd4hBullish, rsi12h }
//   outcome:   null | "tp1" | "tp2" | "tp3" | "stop" | "invalidated" | "expired"
//   closedAt:  null | ISO timestamp
//   pnlR:      null | number   (R-multiple: 1.0 = hit TP1, -1.0 = stopped out, etc.)
// }

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; }
}

function writeTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function logTrade(price, zone, setup) {
  const trades = readTrades();
  const id = `${Date.now()}-${Math.round(zone.high)}-${Math.round(zone.low)}`;
  trades.push({
    id,
    firedAt:    new Date().toISOString(),
    direction:  setup.direction,
    setupType:  setup.setupType,
    probability: setup.probability,
    price:      Math.round(price),
    zone:       { high: zone.high, low: zone.low },
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
    outcome:  null,
    closedAt: null,
    pnlR:     null,
  });
  writeTrades(trades);
  log(`Trade logged: ${id}`);
}

// Check open trades against current price and mark outcomes automatically.
// Called every poll — only processes trades where outcome is still null.
// R-multiples: TP1=rr1, TP2=rr2, TP3=rr3, stop=-1.0
function updateOutcomes(currentPrice) {
  const trades = readTrades();
  let changed = false;

  for (const t of trades) {
    if (t.outcome !== null) continue;

    // Expire trades older than 30 days with no outcome — treat as no-trade
    const age = Date.now() - new Date(t.firedAt).getTime();
    if (age > 30 * 24 * 60 * 60 * 1000) {
      t.outcome  = 'expired';
      t.closedAt = new Date().toISOString();
      t.pnlR     = 0;
      changed    = true;
      log(`Trade ${t.id} expired (30 days, no outcome)`);
      continue;
    }

    const price = currentPrice;
    if (t.direction === 'long') {
      if (price <= t.stop) {
        t.outcome = 'stop'; t.pnlR = -1.0;
      } else if (price >= t.tp3) {
        t.outcome = 'tp3'; t.pnlR = parseFloat(t.rr3);
      } else if (price >= t.tp2) {
        t.outcome = 'tp2'; t.pnlR = parseFloat(t.rr2);
      } else if (price >= t.tp1) {
        t.outcome = 'tp1'; t.pnlR = parseFloat(t.rr1);
      }
    } else {
      if (price >= t.stop) {
        t.outcome = 'stop'; t.pnlR = -1.0;
      } else if (price <= t.tp3) {
        t.outcome = 'tp3'; t.pnlR = parseFloat(t.rr3);
      } else if (price <= t.tp2) {
        t.outcome = 'tp2'; t.pnlR = parseFloat(t.rr2);
      } else if (price <= t.tp1) {
        t.outcome = 'tp1'; t.pnlR = parseFloat(t.rr1);
      }
    }

    if (t.outcome !== null) {
      t.closedAt = new Date().toISOString();
      changed    = true;
      log(`Trade ${t.id} closed: ${t.outcome} | R: ${t.pnlR}`);
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

  let price, zones, studies;

  try {
    // 2. Get current price
    const quote = await cdpEval(client, QUOTE_EXPR);
    if (!quote || quote.error) throw { code: 'NO_QUOTE', msg: quote?.error || 'null response' };

    // Verify we're on the right chart
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

    // 3. Get supply/demand zones
    zones = await cdpEval(client, buildBoxesExpr('LuxAlgo'));
    if (!Array.isArray(zones) || zones.length === 0) {
      log('No LuxAlgo zones found — sending info alert');
      notify('info', `📊 No active zones | BTC $${Math.round(price).toLocaleString()} | Ace chart may need LuxAlgo SMC visible`);
      await client.close();
      return;
    }
    log(`Zones: ${zones.length} active`);

    // 4. Get study values
    const studyData = await cdpEval(client, STUDY_VALUES_EXPR);
    studies = Array.isArray(studyData) ? studyData : [];
    log(`Studies: ${studies.length} indicators read`);

    // 5. Check proximity early to decide if we need HTF data
    const anyTriggered = zones.some(z => checkProximity(price, z).triggered);
    if (anyTriggered) {
      // Read current TF so we can restore it
      const originalTF = await cdpEval(client, GET_TF_EXPR) || '30';
      log(`Trigger detected — fetching 4H/12H data (current TF: ${originalTF})`);

      // Fetch 4H closes for MACD (60 bars: 26 EMA warm-up + signal + buffer)
      const closes4h = await fetchHTFCloses(client, '240', 60, originalTF);
      studies._macd4h = computeMACD(closes4h);
      log(`4H MACD: ${studies._macd4h ? (studies._macd4h.bullish ? 'bullish' : 'bearish') + ` hist ${Math.round(studies._macd4h.histogram)}` : 'unavailable'}`);

      // Fetch 12H closes for RSI (30 bars: 14-period + warm-up)
      const closes12h = await fetchHTFCloses(client, '720', 30, originalTF);
      studies._rsi12h = computeRSI(closes12h);
      log(`12H RSI: ${studies._rsi12h != null ? Math.round(studies._rsi12h) : 'unavailable'}`);
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
        'Check TradingView Desktop is open on the 🕵Ace layout with LuxAlgo SMC visible.'
      );
    }
    try { await client.close(); } catch {}
    process.exit(1);
  }

  await client.close();

  // 6. Parse indicators + enrich with HTF data
  const indicators = parseStudies(studies);
  indicators.oiTrend = getOITrend(indicators.oi);
  indicators.macd4h  = studies._macd4h ?? null;
  indicators.rsi12h  = studies._rsi12h ?? null;
  log(`CVD: ${indicators.cvd} | OI: ${indicators.oi} (${indicators.oiTrend ?? 'no trend yet'}) | VWAP: ${indicators.vwap}`);

  // Always update outcomes on open trades — runs every poll, no CDP needed
  updateOutcomes(price);

  // 7. Check if any previously alerted zones have been mitigated
  const invalidations = checkInvalidations(zones, price, indicators);
  for (const msg of invalidations) {
    const type = msg.startsWith('🚫') ? 'info' : 'approaching';
    notify(type, msg);
  }

  // 8. Check if any watched zones (post-stop-hunt) have been reclaimed
  const reclaims = checkReclaimWatch(zones, price, indicators);
  for (const msg of reclaims) {
    // Direction is embedded in the message — use 'long'/'short' based on content
    const type = msg.includes('LONG') ? 'long' : 'short';
    notify(type, msg);
  }

  // 8.5. Check pending confirmations — zones that fired with flat OI and are
  // waiting for OI/CVD to move. Bypasses the cooldown gate. Fires at most once
  // per zone (removes the _pending_ key on match and resets cooldown).
  const confirmations = checkPendingConfirmation(price, indicators);
  for (const { msg, direction } of confirmations) {
    notify(direction, msg);
  }

  // 9. Check each zone for proximity trigger
  let triggered = false;

  for (const zone of zones) {
    const { triggered: hit, insideZone, minDist, buffer } = checkProximity(price, zone);
    if (!hit) continue;

    const zoneKey = `${Math.round(zone.high)}-${Math.round(zone.low)}`;

    if (isCoolingDown(zoneKey)) {
      log(`Zone ${zoneKey} triggered but cooling down — skipping`);
      continue;
    }

    const distStr = insideZone
      ? 'INSIDE ZONE'
      : `$${Math.round(minDist).toLocaleString()} away`;

    log(`TRIGGER: Zone ${zoneKey} | ${distStr} | buffer $${Math.round(buffer).toLocaleString()}`);

    // Evaluate setup + format message
    const setup = evaluateSetup(price, zone, indicators, zones);
    // Snapshot indicator values onto setup for trade log
    setup._cvd    = indicators.cvd;
    setup._oi     = indicators.oi;
    setup._oiTrend = indicators.oiTrend;
    setup._vwap   = indicators.vwap;
    setup._macd4h = indicators.macd4h;
    setup._rsi12h = indicators.rsi12h;

    const message = formatSetupMessage(price, zone, setup);

    notify(setup.direction, message);
    markAlerted(zoneKey, setup.direction, zone);
    logTrade(price, zone, setup);

    // If OI was flat or not yet trending at alert time, register a pending
    // confirmation watch. The next tick(s) will compare OI and CVD against
    // this baseline and fire a TRIGGER CONFIRMED alert when both move.
    if (!indicators.oiTrend || indicators.oiTrend === 'flat') {
      markPending(zoneKey, setup.direction, zone, indicators);
    }

    triggered = true;
    break; // one alert at a time
  }

  if (!triggered) {
    // Find nearest zone for status message
    const nearest = zones.reduce((best, z) => {
      const dist = Math.min(Math.abs(price - z.high), Math.abs(price - z.low));
      return dist < best.dist ? { zone: z, dist } : best;
    }, { zone: null, dist: Infinity });

    const nearestStr = nearest.zone
      ? `Nearest zone: $${Math.round(nearest.zone.low).toLocaleString()}–$${Math.round(nearest.zone.high).toLocaleString()} ($${Math.round(nearest.dist).toLocaleString()} away)`
      : 'No zones found';

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
