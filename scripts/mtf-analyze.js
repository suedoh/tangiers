#!/usr/bin/env node
'use strict';

/**
 * Ace Trading System — Full MTF Analysis
 *
 * Runs a complete 12H→4H→1H→30M sweep in a single CDP session and
 * returns a formatted verdict. Zero Claude/AI — pure indicator synthesis.
 *
 * Usage:
 *   node mtf-analyze.js          → posts analysis to Discord + prints report
 *   node mtf-analyze.js --print  → prints report to stdout only (no Discord)
 *   node mtf-analyze.js --json   → prints raw JSON data object
 */

const CDP  = require('/Users/vpm/trading/tradingview-mcp/node_modules/chrome-remote-interface');
const path = require('path');
const fs   = require('fs');
const { execFileSync } = require('child_process');

const ROOT       = path.resolve(__dirname, '..');
const ENV_FILE   = path.join(ROOT, '.env');
const NOTIFY     = path.join(ROOT, 'scripts', 'discord-notify.sh');
const STATE_FILE = path.join(ROOT, '.trigger-state.json');
const CDP_PORT   = 9222;

// ─── Env ─────────────────────────────────────────────────────────────────────

if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0,i).trim()] = l.slice(i+1).trim(); });
}

// ─── CDP ─────────────────────────────────────────────────────────────────────

async function cdpConnect() {
  const targets = await CDP.List({ host: 'localhost', port: CDP_PORT });
  const target  = targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
  if (!target) throw new Error('No TradingView chart page found in CDP. Is TradingView Desktop open?');
  const client = await CDP({ host: 'localhost', port: CDP_PORT, target: target.id });
  await client.Runtime.enable();
  return client;
}

async function cdpEval(client, expr) {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: false });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'CDP eval error');
  return r.result?.value ?? null;
}

// ─── CDP Expressions ─────────────────────────────────────────────────────────

const BARS_PATH = `window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()`;

const QUOTE_EXPR = `(function(){
  try { var b=${BARS_PATH}; var v=b.valueAt(b.lastIndex()); return v ? {last:v[4],high:v[2],low:v[3],open:v[1]} : null; }
  catch(e) { return null; }
})()`;

const STUDY_VALUES_EXPR = `(function(){
  try {
    var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources=chart.model().model().dataSources(); var results=[];
    for(var si=0;si<sources.length;si++){
      var s=sources[si]; if(!s.metaInfo) continue;
      try {
        var meta=s.metaInfo(); var name=meta.description||meta.shortDescription||''; if(!name) continue;
        var values={};
        try { var dwv=s.dataWindowView(); if(dwv){ var items=dwv.items(); if(items) for(var i=0;i<items.length;i++){ var it=items[i]; if(it._value&&it._value!=='\u2205'&&it._title) values[it._title]=it._value; } } } catch(e){}
        if(Object.keys(values).length===0 && s._series && s._series.length>0){
          try { var ser=s._series[0]; var bars=typeof ser.bars==='function'?ser.bars():ser.bars; if(bars&&typeof bars.lastIndex==='function'){ var li=bars.lastIndex(); var v=bars.valueAt(li); if(v){ var val=Array.isArray(v)?(v[4]!=null?v[4]:v[1]!=null?v[1]:v[0]):null; if(val!=null&&!isNaN(val)) values[name]=String(val); } } } catch(e){}
        }
        if(Object.keys(values).length>0) results.push({name:name,values:values});
      } catch(e){}
    }
    return results;
  } catch(e) { return []; }
})()`;

const BOXES_EXPR = `(function(){
  try {
    var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources=chart.model().model().dataSources(); var allZones=[];
    for(var si=0;si<sources.length;si++){
      var s=sources[si]; if(!s.metaInfo) continue;
      try {
        var meta=s.metaInfo(); var name=meta.description||meta.shortDescription||'';
        if(name.indexOf('LuxAlgo')===-1) continue;
        var g=s._graphics; if(!g||!g._primitivesCollection) continue;
        var pc=g._primitivesCollection; var items=[];
        try { var outer=pc.dwgboxes; if(outer){ var inner=outer.get('boxes'); if(inner){ var coll=inner.get(false); if(coll&&coll._primitivesDataById&&coll._primitivesDataById.size>0) coll._primitivesDataById.forEach(function(v){ items.push(v); }); } } } catch(e){}
        for(var i=0;i<items.length;i++){ var v=items[i]; var hi=v.y1!=null&&v.y2!=null?Math.round(Math.max(v.y1,v.y2)*100)/100:null; var lo=v.y1!=null&&v.y2!=null?Math.round(Math.min(v.y1,v.y2)*100)/100:null; if(hi!=null&&lo!=null) allZones.push({high:hi,low:lo}); }
      } catch(e){}
    }
    var seen={}; var zones=allZones.filter(function(z){ var k=z.high+':'+z.low; if(seen[k]) return false; seen[k]=true; return true; });
    zones.sort(function(a,b){ return b.high-a.high; }); return zones;
  } catch(e) { return []; }
})()`;

function buildSetTFExpr(tf) {
  return `(function(){try{window.TradingViewApi._activeChartWidgetWV.value().setResolution('${tf}',function(){});return true;}catch(e){return false;}})()`;
}

function buildClosesExpr(count) {
  return `(function(){try{var bars=${BARS_PATH};var closes=[];var li=bars.lastIndex();var start=Math.max(0,li-${count}+1);for(var i=start;i<=li;i++){var v=bars.valueAt(i);if(v&&v[4]!=null)closes.push(v[4]);}return closes;}catch(e){return[];}})()`;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function pf(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function parseStudies(studies) {
  const find = name => studies.find(s => s.name?.toLowerCase().includes(name.toLowerCase()));

  const cvdS   = find('Cumulative Volume Delta');
  const oiS    = find('Open Interest');
  const vpSess = find('Session Volume Profile');
  const vpVis  = find('Visible Range Volume Profile');
  const vwapS  = find('Volume Weighted Average Price') || find('VWAP');
  const volS   = studies.find(s => s.name?.toLowerCase() === 'volume'); // exact match avoids VRVP
  // If added to layout: RSI and MACD read directly; falls back to computed-from-closes if absent
  const rsiS   = find('Relative Strength Index') || find('RSI');
  const macdS  = find('MACD');

  const cvd  = cvdS  ? pf(Object.values(cvdS.values  || {})[0]) : null;
  const oi   = oiS   ? pf(Object.values(oiS.values   || {})[0]) : null;
  const vwap = vwapS ? pf(Object.values(vwapS.values || {})[0]) : null;
  const vol  = volS  ? pf(Object.values(volS.values  || {})[0]) : null;

  // Session Volume Profile: Up/Down ratio — fastest single read for intraday bias
  let sessionVP = null;
  if (vpSess?.values) {
    const up = pf(vpSess.values['Up']), down = pf(vpSess.values['Down']);
    if (up != null && down != null) sessionVP = { up, down };
  }

  // Visible Range Volume Profile: Up/Down (overall range bias) + POC
  let vrvp = null;
  if (vpVis?.values) {
    const up  = pf(vpVis.values['Up']);
    const down = pf(vpVis.values['Down']);
    if (up != null && down != null) vrvp = { up, down, bullish: up > down };
  }

  // RSI from chart indicator if present (e.g. if added to Ace layout)
  let rsiFromChart = null;
  if (rsiS?.values) {
    const val = Object.values(rsiS.values)[0];
    rsiFromChart = pf(val);
  }

  // MACD histogram from chart indicator if present
  let macdFromChart = null;
  if (macdS?.values) {
    const hist = pf(macdS.values['Histogram'] ?? macdS.values['Hist'] ?? Object.values(macdS.values)[0]);
    if (hist != null) macdFromChart = { histogram: hist, bullish: hist > 0 };
  }

  return { cvd, oi, vwap, vol, sessionVP, vrvp, rsiFromChart, macdFromChart };
}

function computeMACD(closes) {
  if (!closes || closes.length < 35) return null;
  const k12=2/13, k26=2/27, k9=2/10;
  let ema12=closes[0], ema26=closes[0]; const ml=[];
  for(let i=1;i<closes.length;i++){ema12=closes[i]*k12+ema12*(1-k12);ema26=closes[i]*k26+ema26*(1-k26);if(i>=25)ml.push(ema12-ema26);}
  if(ml.length<9)return null;
  let sig=ml[0]; for(let i=1;i<ml.length;i++)sig=ml[i]*k9+sig*(1-k9);
  const hist=ml[ml.length-1]-sig; return { histogram:hist, bullish:hist>0 };
}

function computeRSI(closes, period=14) {
  if(!closes||closes.length<period+1)return null;
  let g=0,l=0; for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d;}
  let ag=g/period,al=l/period;
  for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?-d:0))/period;}
  return al===0?100:100-100/(1+ag/al);
}

// ─── Per-TF Fetch ─────────────────────────────────────────────────────────────

async function fetchTF(client, tf, closeCount) {
  await cdpEval(client, buildSetTFExpr(tf));
  await new Promise(r => setTimeout(r, 1500));
  const rawStudies = await cdpEval(client, STUDY_VALUES_EXPR) || [];
  const zones      = await cdpEval(client, BOXES_EXPR)        || [];
  const parsed     = parseStudies(Array.isArray(rawStudies) ? rawStudies : []);

  // Use chart-native RSI/MACD if present on the layout (zero extra cost).
  // Fall back to computing from closes only when not on chart — so adding
  // RSI/MACD to the Ace layout automatically improves accuracy here.
  let macd = parsed.macdFromChart ?? null;
  let rsi  = parsed.rsiFromChart  ?? null;

  if ((macd === null || rsi === null) && closeCount > 0) {
    const closes = await cdpEval(client, buildClosesExpr(closeCount)) || [];
    if (rsi  === null && closeCount >= 14) rsi  = computeRSI(closes);
    if (macd === null && closeCount >= 35) macd = computeMACD(closes);
  }

  return { tf, ...parsed, zones, macd, rsi };
}

// ─── Synthesis ────────────────────────────────────────────────────────────────

function nearestZones(zones, price) {
  return {
    supply: zones.filter(z => z.low  > price).sort((a,b) => a.low  - b.low )[0] || null,
    demand: zones.filter(z => z.high < price).sort((a,b) => b.high - a.high)[0] || null,
    inside: zones.find(z => price >= z.low && price <= z.high)                   || null,
  };
}

function evaluateSetupA(tfs, price, oiDelta) {
  const d4h  = tfs['240'] || {};
  const d12h = tfs['720'] || {};
  const d30m = tfs['30']  || {};
  const d1h  = tfs['60']  || {};

  const z30m = nearestZones(d30m.zones || [], price);
  const z1h  = nearestZones(d1h.zones  || [], price);
  const atZone = !!(z30m.inside || z1h.inside
    || (z30m.demand && Math.abs(price - z30m.demand.high) < price * 0.006)
    || (z1h.demand  && Math.abs(price - z1h.demand.high)  < price * 0.006));

  const allAboveVwap = ['720','240','60','30'].every(k =>
    tfs[k]?.vwap != null ? price > tfs[k].vwap : true
  );

  const macro12hBullish = (d12h.sessionVP ? d12h.sessionVP.up > d12h.sessionVP.down : true)
                       && (d12h.rsi != null ? d12h.rsi > 50 : true);
  const macro4hBullish  = d4h.macd ? d4h.macd.bullish
                        : (d4h.cvd != null ? d4h.cvd > 0 : null);

  const criteria = [
    { label: '4H MACD bullish',       pass: d4h.macd  ? d4h.macd.bullish : null,
      note: d4h.macd ? `hist ${d4h.macd.histogram>0?'+':''}${Math.round(d4h.macd.histogram)}` : 'computed from closes' },
    { label: '12H RSI > 50',           pass: d12h.rsi != null ? d12h.rsi > 50 : null,
      note: d12h.rsi != null ? `RSI ${Math.round(d12h.rsi)}` : 'computed from closes' },
    { label: 'Price in 1H/30M demand zone', pass: atZone,    note: null },
    { label: '4H CVD aligned (long)',  pass: d4h.cvd != null ? d4h.cvd > 0 : null,
      note: d4h.cvd != null ? `${d4h.cvd>0?'+':''}${Math.round(d4h.cvd)}` : null },
    { label: 'OI rising',              pass: oiDelta != null ? oiDelta > 0 : null,
      note: oiDelta != null ? `Δ${oiDelta>0?'+':''}${oiDelta.toFixed(2)}K` : 'first run — check next tick' },
    { label: 'Price above VWAP (all TFs)', pass: allAboveVwap, note: `30M VWAP $${d30m.vwap?Math.round(d30m.vwap).toLocaleString():'?'}` },
    { label: '12H + 4H macro aligned', pass: macro12hBullish && macro4hBullish != null ? (macro12hBullish && macro4hBullish) : null,
      note: null },
  ];

  const passed  = criteria.filter(c => c.pass === true).length;
  const failed  = criteria.filter(c => c.pass === false).length;
  const unknown = criteria.filter(c => c.pass === null).length;
  return { criteria, passed, failed, unknown };
}

// ─── Probability Engine ───────────────────────────────────────────────────────
//
// Starts from Setup A's empirical 62% base win rate (smc-setups.md).
// Each criterion is weighted by how predictive it is of a winning trade,
// based on market microstructure research and the Ace strategy rules:
//
//   CVD aligned        — highest weight: "divergence overrides all other readings"
//   OI rising          — second highest: new money entering = real conviction
//   Price at zone      — required for the setup to exist at all
//   12H+4H macro       — structural foundation; trading against it is the #1 mistake
//   MACD / RSI / VWAP  — confirming signals, meaningful but individually lower weight
//
// Bonuses from Ace indicators not in the 7 criteria:
//   Session VP 1H/4H bullish  → intraday flow supporting the trade
//   VRVP consensus bullish     → range-wide volume supports the level
//   CVD positive across all 4 TFs → institutional conviction is broad
//   OI delta > 1%             → strong new-money inflow, not just noise
//
// Failures are penalised 1.5× harder than confirmations are rewarded —
// asymmetric because a single hard fail (OI flat, CVD diverging) has
// historically been sufficient to invalidate an otherwise clean setup.
//
// Output is clamped to [28%, 91%] — nothing in trading is certain.

function calculateProbability(setupA, tfs, price, oiDelta) {
  let prob = 0.62; // Setup A base rate

  // Per-criterion weights: { pass: reward, fail: penalty (negative) }
  const WEIGHTS = {
    '4H CVD aligned (long)':          { pass: +0.07, fail: -0.11 }, // priority signal
    'OI rising':                       { pass: +0.06, fail: -0.09 }, // conviction check
    'Price in 1H/30M demand zone':     { pass: +0.05, fail: -0.08 }, // setup foundation
    '12H + 4H macro aligned':          { pass: +0.05, fail: -0.08 }, // structural bias
    '4H MACD bullish':                 { pass: +0.04, fail: -0.06 },
    'Price above VWAP (all TFs)':      { pass: +0.04, fail: -0.06 },
    '12H RSI > 50':                    { pass: +0.03, fail: -0.04 },
  };

  for (const c of setupA.criteria) {
    const w = WEIGHTS[c.label];
    if (!w) continue;
    if (c.pass === true)  prob += w.pass;
    if (c.pass === false) prob += w.fail; // w.fail is already negative
    // unknown (null) = no adjustment — honest about missing data
  }

  // ── Ace indicator bonuses ────────────────────────────────────────────────
  const d12h = tfs['720'] || {};
  const d4h  = tfs['240'] || {};
  const d1h  = tfs['60']  || {};
  const d30m = tfs['30']  || {};

  // Session VP — 1H and 4H are more predictive than 30M (30M flips often)
  if (d1h.sessionVP?.up  > d1h.sessionVP?.down)  prob += 0.02;
  if (d4h.sessionVP?.up  > d4h.sessionVP?.down)  prob += 0.02;
  if (d12h.sessionVP?.up > d12h.sessionVP?.down) prob += 0.01;
  if (d30m.sessionVP?.down > d30m.sessionVP?.up) prob -= 0.01; // mild 30M headwind

  // VRVP consensus — volume-weighted range bias
  if (d12h.vrvp?.bullish) prob += 0.01;
  if (d4h.vrvp?.bullish)  prob += 0.01;

  // CVD positive across all 4 TFs = broad institutional conviction
  const cvdBullishCount = ['720','240','60','30'].filter(k => (tfs[k]?.cvd ?? -1) > 0).length;
  if (cvdBullishCount === 4) prob += 0.03;
  else if (cvdBullishCount === 3) prob += 0.01;
  else if (cvdBullishCount <= 1) prob -= 0.02; // CVD broadly bearish = warning

  // OI rising strongly (> 1% from baseline) = real new money, not noise
  if (oiDelta != null && d30m.oi != null && d30m.oi > oiDelta) {
    const oiPct = oiDelta / (d30m.oi - oiDelta);
    if      (oiPct >= 0.02) prob += 0.03; // > 2% surge
    else if (oiPct >= 0.01) prob += 0.02; // > 1% meaningful
    else if (oiPct <  0)    prob -= 0.02; // OI falling = liquidation risk
  }

  return Math.round(Math.min(0.91, Math.max(0.28, prob)) * 100);
}

// ─── Report Formatter ─────────────────────────────────────────────────────────

function fmt$(n) { return n != null ? `$${Math.round(n).toLocaleString()}` : '?'; }

function buildReport(tfs, price, oiDelta) {
  const setupA      = evaluateSetupA(tfs, price, oiDelta);
  const probability = calculateProbability(setupA, tfs, price, oiDelta);
  const TF_KEYS = ['720','240','60','30'];
  const TF_LBLS = { '720':'12H','240':'4H','60':'1H','30':'30M' };

  // MTF grid — every indicator on the Ace layout gets a column
  const gridLines = TF_KEYS.map(k => {
    const d = tfs[k] || {};

    const vwapI  = d.vwap != null ? (price > d.vwap ? '✅' : '❌') : '⚠️';
    const cvdI   = d.cvd  != null ? (d.cvd  > 0     ? '✅' : '❌') : '⚠️';
    const cvdStr = d.cvd  != null ? ` ${d.cvd>0?'+':''}${Math.round(d.cvd)}` : '';
    const oiStr  = d.oi   != null ? ` OI ${d.oi.toFixed(1)}K` : '';

    // Session VP — intraday bias (fastest read per CLAUDE.md)
    const svp = d.sessionVP
      ? ` | SessVP ${d.sessionVP.up}↑/${d.sessionVP.down}↓ ${d.sessionVP.up > d.sessionVP.down ? '✅' : '❌'}`
      : '';

    // VRVP — overall range consensus
    const vrvp = d.vrvp
      ? ` | VRVP ${d.vrvp.up.toFixed(0)}↑/${d.vrvp.down.toFixed(0)}↓ ${d.vrvp.bullish ? '✅' : '❌'}`
      : '';

    // Volume — raw candle activity
    const volStr = d.vol != null ? ` | Vol ${d.vol.toFixed(1)}K` : '';

    // RSI/MACD only on the TFs that use them (12H for RSI, 4H for MACD)
    const extra = k === '720' && d.rsi  != null ? ` | RSI ${Math.round(d.rsi)} ${d.rsi > 50 ? '✅' : '❌'}`
                : k === '240' && d.macd != null ? ` | MACD ${d.macd.bullish ? '✅' : '❌'} (${d.macd.histogram>0?'+':''}${Math.round(d.macd.histogram)})`
                : '';

    return `**${TF_LBLS[k]}**: VWAP ${vwapI} | CVD ${cvdI}${cvdStr}${oiStr}${svp}${vrvp}${volStr}${extra}`;
  });

  // Criteria
  const critLines = setupA.criteria.map(c => {
    const icon = c.pass===true?'✅':c.pass===false?'❌':'⚠️';
    return `${icon} ${c.label}${c.note ? ` — ${c.note}` : ''}`;
  });

  // Probability label
  const probLabel = probability >= 70 ? 'High'
                  : probability >= 60 ? 'Moderate'
                  : probability >= 50 ? 'Low'
                  : 'Poor';

  // Verdict
  const confirmedDenominator = setupA.criteria.length - setupA.unknown;
  let verdict, vType;
  if (setupA.failed === 0 && setupA.passed >= 5) {
    verdict = `🟢 **LONG — Setup A confirmed** | **${probability}% probability** (${probLabel}) | ${setupA.passed}/${confirmedDenominator} criteria`;
    vType = 'long';
  } else if (setupA.failed >= 3) {
    verdict = `⛔ **SKIP** | **${probability}% probability** (${probLabel}) | ${setupA.failed} criteria failing`;
    vType = 'info';
  } else {
    verdict = `⚠️ **WAIT — setup forming** | **${probability}% probability** (${probLabel}) | ${setupA.passed}/${confirmedDenominator} confirmed`;
    vType = 'approaching';
  }

  // Trade plan + EV
  const z30m = nearestZones(tfs['30']?.zones || [], price);
  const zone  = z30m.inside || z30m.demand;
  let plan = '';
  if (vType !== 'info' && zone) {
    const entry = Math.round(zone.high * 0.997);
    const stop  = Math.round(zone.low  * 0.998);
    const risk  = Math.max(entry - stop, 1);
    const supply = (tfs['30']?.zones || []).filter(z => z.low > price).sort((a,b) => a.low-b.low)[0];
    const tp1   = supply ? Math.round(supply.low) : entry + risk;
    const tp2   = entry + risk * 2;
    const tp3   = entry + risk * 3;
    const rr1   = (Math.abs(tp1 - entry) / risk);
    const rr2   = (Math.abs(tp2 - entry) / risk);
    const rr3   = (Math.abs(tp3 - entry) / risk);
    const p     = probability / 100;

    // Expected Value = (win_prob × reward_R) − (loss_prob × 1R)
    // Calculated at TP2 as the primary target (partial exits at TP1/TP3)
    const ev2   = ((p * rr2) - ((1 - p) * 1.0)).toFixed(2);
    const evStr = parseFloat(ev2) > 0 ? `+${ev2}R` : `${ev2}R`;

    plan = [
      ``,
      `**TRADE PLAN** | Win rate ${probability}% | EV at TP2: **${evStr}**`,
      `Entry ${fmt$(entry)} | Stop ${fmt$(stop)} | Risk ${fmt$(risk)}/contract`,
      `TP1 ${fmt$(tp1)} (1:${rr1.toFixed(1)}) | TP2 ${fmt$(tp2)} (1:${rr2.toFixed(1)}) | TP3 ${fmt$(tp3)} (1:${rr3.toFixed(1)})`,
      `Trigger  30M CHoCH above ${fmt$(zone.high)}`,
    ].join('\n');
  }

  const ts  = new Date().toLocaleString('en-US', { timeZone: 'UTC', hour12: false, month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  const oiS = oiDelta != null ? `OI ${oiDelta>0?'↑':'↓'}${Math.abs(oiDelta).toFixed(2)}K` : 'OI Δ n/a (first run)';

  const text = [
    `📊 **MTF ANALYSIS — BTCUSDT** | **${fmt$(price)}** | ${ts} UTC | ${oiS}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ...gridLines,
    ``,
    `**SETUP A CRITERIA**`,
    ...critLines,
    ``,
    verdict,
    plan,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');

  return { text, vType, setupA, price };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runMTFAnalysis() {
  const client = await cdpConnect();
  try {
    // Read previous OI from trigger-check state for delta calculation
    let prevOI = null;
    try { prevOI = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))._previousOI ?? null; } catch {}

    // Sweep all four timeframes in one CDP session
    //   12H: 30 closes for RSI-14 (with warm-up)
    //   4H:  60 closes for MACD (26 EMA + signal + buffer)
    //   1H/30M: indicator values + zones only
    const tfs = {};
    tfs['720'] = await fetchTF(client, '720', 30);
    tfs['240'] = await fetchTF(client, '240', 60);
    tfs['60']  = await fetchTF(client, '60',  0);
    tfs['30']  = await fetchTF(client, '30',  0);

    // Final price read on 30M (most current)
    const quote = await cdpEval(client, QUOTE_EXPR);
    const price = quote?.last;
    if (!price) throw new Error('Could not read price from chart');

    // OI delta vs trigger-check.js baseline
    const currentOI = tfs['30'].oi;
    const oiDelta   = (prevOI != null && currentOI != null) ? currentOI - prevOI : null;

    return buildReport(tfs, price, oiDelta);
  } finally {
    await client.close();
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const args    = process.argv.slice(2);
  const doPost  = !args.includes('--print') && !args.includes('--json');
  const doJson  = args.includes('--json');

  runMTFAnalysis()
    .then(report => {
      if (doJson) { console.log(JSON.stringify(report, null, 2)); return; }
      console.log(report.text);
      if (doPost) {
        try {
          execFileSync('bash', [NOTIFY, report.vType, report.text], { stdio: 'pipe' });
          console.log(`[mtf-analyze] Posted to Discord as [${report.vType}]`);
        } catch(e) { console.error('[mtf-analyze] Discord post failed:', e.message); }
      }
    })
    .catch(e => {
      console.error('[mtf-analyze] Error:', e.message);
      process.exit(1);
    });
}

module.exports = { runMTFAnalysis };
