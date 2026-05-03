#!/usr/bin/env node
'use strict';

/**
 * Polymarket BTC 15-min — On-Demand Analysis
 *
 * Called by the Discord bot (!analyze command) or manually.
 * Runs the full 15M→5M→1H sweep and posts the current bar's score,
 * regardless of threshold. Always posts — this is a "show me everything" read.
 *
 * Usage:
 *   node scripts/poly/btc-15/analyze.js
 *   node scripts/poly/btc-15/analyze.js --source "Manual | username"
 */

const path = require('path');

const { loadEnv, ROOT }            = require('../../lib/env');
const { acquireLock, releaseLock } = require('../../lib/lock');
const {
  cdpConnect, setSymbol, setTimeframe, waitForPrice,
  getStudyValues, getOHLCV, cdpEval, sleep,
} = require('../../lib/cdp');
const { postWebhook } = require('../../lib/discord');

loadEnv();

const SYMBOL       = 'BINANCE:BTCUSDT.P';
const SIGNALS_HOOK = process.env.POLY_BTC_15_SIGNALS_WEBHOOK;
const MARKET_URL   = process.env.POLY_BTC_15_MARKET_URL || 'https://polymarket.com';
const SOURCE       = process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : 'Manual';

function log(msg) { console.log(`[${new Date().toISOString()}] [poly-analyze] ${msg}`); }

// ─── Shared helpers (copied from trigger-check — keep in sync) ────────────────

const VRVP_EXPR = `(function(){
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
      try { var lv = s._data.last().value; if (lv) { poc = lv[1]; vah = lv[2]; val = lv[3]; } } catch(e) {}
      return { poc: poc, vah: vah, val: val };
    }
    return null;
  } catch(e) { return null; }
})()`;

function parseNum(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/,/g, '').replace(/−/g, '-'));
  return isNaN(n) ? null : n;
}

function parseStudies(studies) {
  const out = { vwap: null, oi: null, cvd: null };
  for (const s of (studies || [])) {
    const n = s.name || '', v = s.values || {};
    if (/(volume weighted average price|vwap)/i.test(n)) out.vwap = parseNum(v['VWAP']);
    if (/open interest/i.test(n))                        out.oi   = parseNum(v['Open Interest']);
    if (/(cumulative volume delta)/i.test(n))            out.cvd  = parseNum(v['CVD']);
  }
  return out;
}

function evaluate({ price, vwap, vrvp, oiCurrent, cvd15m, ohlcv5m, ohlcv1h, utcHour }) {
  const f = {};

  let cvdDir = null, cvdScore = 0;
  let momentumDir = null;
  if (ohlcv5m && ohlcv5m.length >= 3) {
    const c = ohlcv5m.slice(-3).map(b => b.close);
    if      (c[2] > c[1] && c[1] > c[0]) momentumDir = 'UP';
    else if (c[2] < c[1] && c[1] < c[0]) momentumDir = 'DOWN';
    else if (c[2] > c[0])                momentumDir = 'UP';
    else if (c[2] < c[0])                momentumDir = 'DOWN';
  }
  // No cvdPrev on on-demand — momentum-only scoring (max 1pt)
  if (momentumDir) { cvdDir = momentumDir; cvdScore = 1; }
  f.cvdDir = cvdDir; f.cvdScore = cvdScore; f.cvdStrong = false;

  let vwapDir = null;
  if (vwap && price) {
    const pct = (price - vwap) / vwap;
    if (pct >  0.0015) vwapDir = 'UP';
    if (pct < -0.0015) vwapDir = 'DOWN';
  }
  f.vwapDir = vwapDir;

  let structDir = null;
  if (ohlcv1h && ohlcv1h.length >= 3) {
    const b     = ohlcv1h.slice(-3);
    const hhhl  = b[2].high > b[1].high && b[1].high > b[0].high && b[2].low > b[1].low;
    const lllh  = b[2].low  < b[1].low  && b[1].low  < b[0].low  && b[2].high < b[1].high;
    const partUp = b[2].high > b[1].high || b[2].low > b[1].low;
    const partDn = b[2].low  < b[1].low  || b[2].high < b[1].high;
    if (hhhl)                       structDir = 'UP';
    else if (lllh)                  structDir = 'DOWN';
    else if (partUp && !partDn)     structDir = 'UP';
    else if (partDn && !partUp)     structDir = 'DOWN';
  }
  f.structDir = structDir;

  f.oiRising   = false; // OI trend not available on-demand without previous reading
  f.cleanAir   = true;
  if (vrvp && price) {
    const th = price * 0.003;
    for (const lvl of [vrvp.poc, vrvp.vah, vrvp.val]) {
      if (lvl && Math.abs(price - lvl) < th) { f.cleanAir = false; break; }
    }
  }
  f.goodSession = utcHour >= 8 && utcHour < 21;

  function scoreFor(dir) {
    let s = 0;
    if (f.cvdDir === dir)    s += f.cvdScore;
    if (f.vwapDir === dir)   s += 1;
    if (f.structDir === dir) s += 1;
    if (f.oiRising)          s += 1;
    if (f.cleanAir)          s += 1;
    if (f.goodSession)       s += 1;
    return s;
  }

  const upScore   = scoreFor('UP');
  const downScore = scoreFor('DOWN');
  const direction = upScore >= downScore ? 'UP' : 'DOWN';
  const score     = Math.max(upScore, downScore);

  return { score, direction, factors: f, upScore, downScore };
}

function calcProbability(upScore, downScore) {
  const netEdge = Math.abs(upScore - downScore);
  return Math.min(88, 50 + netEdge * 9);
}

function buildEmbed(result, price, vwap, vrvp, source) {
  const { score, direction, factors, upScore, downScore } = result;
  const isUp  = direction === 'UP';
  const arrow = isUp ? '↑' : '↓';
  const emoji = isUp ? '🟢' : '🔴';
  const tier  = score >= 5 ? 'HIGH' : score >= 4 ? 'MODERATE' : 'LOW';
  const prob  = calcProbability(upScore, downScore);

  const now    = new Date();
  const barMin = Math.floor(now.getUTCMinutes() / 15) * 15;
  const barEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), barMin + 15, 0));
  const barLabel = `${String(now.getUTCHours()).padStart(2,'0')}:${String(barMin).padStart(2,'0')}–${barEnd.toISOString().slice(11, 16)} UTC`;

  const cvdLine = factors.cvdDir
    ? `${factors.cvdDir === direction ? '✅' : '❌'} CVD: 5M momentum ${factors.cvdDir === 'UP' ? 'bullish' : 'bearish'} (+${factors.cvdScore})`
    : `❌ CVD: no clear trend (+0)`;

  const lines = [
    `${emoji} **BTC ${direction} ${arrow} — ${prob}% probability**  *(${source})*`,
    `Bar: ${barLabel} · Score: ${score}/6 · Tier: ${tier}`,
    ``,
    cvdLine,
    `${factors.vwapDir === direction ? '✅' : '❌'} VWAP: ${vwap ? `$${vwap.toFixed(2)} (price ${isUp ? '+' : ''}${vwap ? (((price - vwap)/vwap)*100).toFixed(3) : '?'}%)` : 'unavailable'}`,
    `${factors.structDir === direction ? '✅' : '❌'} 1H structure: ${factors.structDir ? (factors.structDir === 'UP' ? 'higher highs/lows' : 'lower lows/highs') : 'no clear structure'}`,
    `${factors.oiRising ? '✅' : '⚠️'} OI: (on-demand read — no trend comparison available)`,
    `${factors.cleanAir ? '✅' : '❌'} Clean air: ${factors.cleanAir ? 'no major level within 0.3%' : `VRVP level nearby (POC=$${vrvp?.poc?.toFixed(2)})`}`,
    `${factors.goodSession ? '✅' : '❌'} Session: ${factors.goodSession ? 'active window (08–21 UTC)' : 'low-volume window'}`,
    ``,
    `**Price:** $${price.toFixed(2)}   **VRVP:** POC=$${vrvp?.poc?.toFixed(2) || '?'} VAH=$${vrvp?.vah?.toFixed(2) || '?'} VAL=$${vrvp?.val?.toFixed(2) || '?'}`,
    `[Market →](${MARKET_URL})`,
  ];

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SIGNALS_HOOK) {
    log('ERROR: POLY_BTC_15_SIGNALS_WEBHOOK not set');
    process.exit(1);
  }

  log(`Starting on-demand analysis (source="${SOURCE}")`);

  const lock = await acquireLock(30_000, 'poly-analyze');
  if (!lock) { log('Could not acquire lock'); return; }

  let client;

  try {
    client = await cdpConnect('BTC');
    await setSymbol(client, SYMBOL);

    await setTimeframe(client, '15');
    await waitForPrice(client);
    await sleep(500);

    const [studies15m, ohlcv15m, vrvp] = await Promise.all([
      getStudyValues(client),
      getOHLCV(client, 2),
      cdpEval(client, VRVP_EXPR),
    ]);

    const price = ohlcv15m[ohlcv15m.length - 1]?.close;
    if (!price) throw new Error('Could not read price');

    const { vwap, oi, cvd: cvd15m } = parseStudies(studies15m);

    await setTimeframe(client, '5');
    await waitForPrice(client);
    await sleep(400);
    const ohlcv5m = await getOHLCV(client, 4);

    await setTimeframe(client, '60');
    await waitForPrice(client);
    await sleep(400);
    const ohlcv1h = await getOHLCV(client, 4);

    await setTimeframe(client, '15');

    log(`price=$${price.toFixed(2)} vwap=${vwap?.toFixed(2)} cvd=${cvd15m?.toFixed(0)}`);

    const result = evaluate({ price, vwap, vrvp, oiCurrent: oi, cvd15m, ohlcv5m, ohlcv1h, utcHour: new Date().getUTCHours() });

    const embed  = buildEmbed(result, price, vwap, vrvp, SOURCE);
    const footer = `Poly BTC-15 • On-Demand • ${new Date().toUTCString().slice(5, 25)} UTC`;
    const type   = result.score >= 5 ? (result.direction === 'UP' ? 'long' : 'short') : result.score >= 4 ? 'approaching' : 'info';

    await postWebhook(SIGNALS_HOOK, type, embed, footer);
    log(`Analysis posted (score=${result.score} dir=${result.direction})`);

  } catch (e) {
    log(`Error: ${e.message}`);
    if (SIGNALS_HOOK) {
      await postWebhook(SIGNALS_HOOK, 'error',
        `❌ **Poly BTC-15 Analysis failed**\n**Source:** ${SOURCE}\n**Error:** ${e.message}\n**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout.`,
        'Poly BTC-15 • Analysis Error');
    }
    process.exit(1);
  } finally {
    try { if (client) await client.close(); } catch {}
    releaseLock('poly-analyze');
    log('Done');
  }
}

main().catch(e => { console.error('[poly-analyze] Fatal:', e.message); process.exit(1); });
