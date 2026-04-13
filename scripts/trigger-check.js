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

const ROOT       = path.resolve(__dirname, '..');
const ENV_FILE   = path.join(ROOT, '.env');
const NOTIFY     = path.join(ROOT, 'scripts', 'discord-notify.sh');
const STATE_FILE = path.join(ROOT, '.trigger-state.json');
const LOG_FILE   = path.join(ROOT, 'logs', 'trigger-check.log');

const CDP_PORT         = 9222;
const COOLDOWN_MS      = 2 * 60 * 60 * 1000; // 2 hours between alerts per zone
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
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
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
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  const prev = state._previousOI ?? null;
  state._previousOI = currentOI;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
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
    `\`Ace signal fired: ${direction.toUpperCase()} at $${Math.round(price).toLocaleString()}, ${zoneType} zone $${Math.round(zone.low).toLocaleString()}–$${Math.round(zone.high).toLocaleString()}. Run full MTF analysis and give me your read on whether to take this trade.\``,
  ].join('\n');
}

// ─── Cooldown State ───────────────────────────────────────────────────────────

function isCoolingDown(zoneKey) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return state[zoneKey] && (Date.now() - state[zoneKey]) < COOLDOWN_MS;
  } catch { return false; }
}

function markAlerted(zoneKey) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  state[zoneKey] = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

  // 7. Check each zone for proximity trigger
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

    // 7. Evaluate setup + format message
    const setup = evaluateSetup(price, zone, indicators, zones);
    const message = formatSetupMessage(price, zone, setup);

    notify(setup.direction, message);
    markAlerted(zoneKey);

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
