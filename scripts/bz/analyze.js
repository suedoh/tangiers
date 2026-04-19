#!/usr/bin/env node
'use strict';

/**
 * BZ! — Full MTF Analysis Engine
 *
 * Connects to TradingView via CDP, runs a 4H→1H→30M sweep on NYMEX:BZ1!,
 * synthesizes zones + indicators into a complete trade plan, and posts a
 * Catalyst card to ##bz-signals.
 *
 * Called by:
 *   discord-bot (via !analyze [context] in ##bz-signals)
 *   news-watch.js (AIS or RSS trigger, context auto-generated)
 *
 * Args:
 *   --context "text"   Optional trigger context for sentiment classification
 *   --source  "text"   Source label (e.g. "Manual | @KobeissiLetter", "Reuters RSS")
 *   --print            Print card to stdout only, skip Discord post
 */

const path = require('path');
const fs   = require('fs');

const { loadEnv, ROOT }  = require('../lib/env');
const { acquireLock, releaseLock } = require('../lib/lock');
const {
  cdpConnect, getSymbol, setSymbol, setTimeframe, waitForPrice,
  getQuote, getStudyValues, getPineBoxes, getPineLabels,
  getOHLCV, calcATR, sleep,
} = require('../lib/cdp');
const { classifyZones, nearestZones, zoneKey } = require('../lib/zones');
const { classifySentiment }  = require('../lib/sentiment');
const { postWebhook }        = require('../lib/discord');

loadEnv();

const BZ_SYMBOL         = 'NYMEX:BZ1!';
const BZ_SIGNALS_HOOK   = process.env.BZ_DISCORD_SIGNALS_WEBHOOK;
const BZ_BACKTEST_HOOK  = process.env.BZ_DISCORD_BACKTEST_WEBHOOK;
const GEO_FLAG          = process.env.BZ_GEOPOLITICAL_FLAG === 'active';
const STATE_FILE        = path.join(ROOT, '.bz-trigger-state.json');
const TRADES_FILE       = path.join(ROOT, 'bz-trades.json');

function log(msg) { console.log(`[${new Date().toISOString()}] [bz-analyze] ${msg}`); }

function readState()   { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }
function readTrades()  { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } }
function writeTrades(t){ try { fs.writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); } catch {} }

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs() {
  const args    = process.argv.slice(2);
  const get     = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  return {
    context: get('--context') || null,
    source:  get('--source')  || 'Manual Trigger',
    print:   args.includes('--print'),
  };
}

// ─── Session label ───────────────────────────────────────────────────────────

function sessionLabel() {
  const etHour = (new Date().getUTCHours() - 4 + 24) % 24;
  if (etHour >= 18 || etHour < 2)  return 'Asia Session';
  if (etHour >= 2  && etHour < 8)  return 'London Session';
  if (etHour >= 8  && etHour < 15) return 'NY Session';
  return 'Post-Session';
}

// ─── Parse study values into structured object ───────────────────────────────

function parseStudies(studies) {
  const out = { vwap: null, vwapUpper: null, vwapLower: null, cvd: null, oi: null, sessionUp: null, sessionDown: null };
  for (const s of (studies || [])) {
    const n = s.name || '';
    const v = s.values || {};
    if (/vwap/i.test(n)) {
      out.vwap      = parseFloat(v['VWAP'] || v[Object.keys(v)[0]]) || null;
      out.vwapUpper = parseFloat(v['Upper Band #1']) || null;
      out.vwapLower = parseFloat(v['Lower Band #1']) || null;
    }
    if (/cumulative volume delta/i.test(n)) {
      const raw = v['CVD'] || '';
      const num = parseFloat(raw.replace(/[KkMm]/g, m => m.toLowerCase() === 'k' ? 'e3' : 'e6').replace(/[^0-9.e+\-]/g, ''));
      out.cvd = isNaN(num) ? null : raw.includes('−') || raw.startsWith('-') ? -Math.abs(num) : num;
    }
    if (/open interest/i.test(n)) {
      const raw = v['Open Interest'] || '';
      const num = parseFloat(raw.replace(/[KkMm]/g, m => m.toLowerCase() === 'k' ? 'e3' : 'e6').replace(/[^0-9.e+\-]/g, ''));
      out.oi = isNaN(num) ? null : num;
    }
    if (/session volume profile/i.test(n)) {
      out.sessionUp   = parseInt(v['Up']   || '0', 10) || 0;
      out.sessionDown = parseInt(v['Down'] || '0', 10) || 0;
    }
  }
  return out;
}

// ─── Extract most recent BOS/CHoCH labels above/below price ─────────────────

function extractStructureLevels(labels, price) {
  const bos   = labels.filter(l => l.text === 'BOS'   && l.price != null).map(l => l.price);
  const choch = labels.filter(l => l.text === 'CHoCH' && l.price != null).map(l => l.price);

  const recentBosAbove  = bos.filter(p => p > price).sort((a,b) => a-b)[0]  || null;
  const recentBosBelow  = bos.filter(p => p < price).sort((a,b) => b-a)[0]  || null;
  const recentChochAbove= choch.filter(p => p > price).sort((a,b) => a-b)[0]|| null;
  const recentChochBelow= choch.filter(p => p < price).sort((a,b) => b-a)[0]|| null;

  return { recentBosAbove, recentBosBelow, recentChochAbove, recentChochBelow };
}

// ─── Setup evaluation ────────────────────────────────────────────────────────

function evaluateSetup(price, indicators4h, indicators1h, zones4h, zones1h, zones30m, labels4h, sentiment) {
  const { vwap, vwapUpper, vwapLower, cvd, oi, sessionUp, sessionDown } = indicators4h;
  const sessionTotal = (sessionUp || 0) + (sessionDown || 0);
  const sessionUpPct = sessionTotal > 0 ? sessionUp / sessionTotal : 0.5;

  // Determine bias: long if price above 4H VWAP, short if below
  const bias = vwap ? (price > vwap ? 'long' : 'short') : 'neutral';

  // Nearest zones from each TF
  const classified4h  = classifyZones(zones4h,  price, 2.0);
  const classified30m = classifyZones(zones30m, price, 2.0);
  const { supply: supply4h, demand: demand4h }   = nearestZones(classified4h,  price);
  const { supply: supply30m, demand: demand30m } = nearestZones(classified30m, price);

  // Quality score (0–5 technical + catalyst modifier)
  let score = 0;
  const reasons = { pro: [], con: [] };

  // 1. VWAP position
  if (vwap) {
    if (bias === 'long'  && price > vwap) { score++; reasons.pro.push(`Price above 4H VWAP ($${vwap.toFixed(2)})`); }
    if (bias === 'short' && price < vwap) { score++; reasons.pro.push(`Price below 4H VWAP ($${vwap.toFixed(2)})`); }
    else reasons.con.push(`4H VWAP not yet reclaimed ($${vwap?.toFixed(2)})`);
  }

  // 2. CVD direction
  if (cvd != null) {
    if (bias === 'long'  && cvd > 0) { score++; reasons.pro.push('CVD positive — buyers in control'); }
    else if (bias === 'long')        { reasons.con.push(`CVD negative (${cvd.toFixed(0)}) — institutions still selling`); }
    if (bias === 'short' && cvd < 0) { score++; reasons.pro.push('CVD negative — sellers in control'); }
  }

  // 3. OI trend (static reading — positive score if OI > 45K suggesting conviction)
  if (oi != null && oi > 45000) { score++; reasons.pro.push(`OI ${(oi/1000).toFixed(1)}K — sufficient open interest`); }
  else reasons.con.push('OI data unavailable or low');

  // 4. Session VP ratio
  if (sessionUpPct > 0.60 && bias === 'long')  { score++; reasons.pro.push(`Session VP ${Math.round(sessionUpPct*100)}% Up — buyers dominating`); }
  if (sessionUpPct < 0.40 && bias === 'short') { score++; reasons.pro.push(`Session VP ${Math.round((1-sessionUpPct)*100)}% Down — sellers dominating`); }
  else if (bias === 'long') reasons.con.push(`Session VP only ${Math.round(sessionUpPct*100)}% Up — sellers still dominant`);

  // 5. Structure — demand zone proximity for long, supply for short
  if (bias === 'long' && demand4h) {
    const dist = price - demand4h.high;
    if (dist < 5) { score++; reasons.pro.push(`Price near 4H demand zone ($${demand4h.low}–$${demand4h.high})`); }
  }
  if (bias === 'short' && supply4h) {
    const dist = supply4h.low - price;
    if (dist < 5) { score++; reasons.pro.push(`Price near 4H supply zone ($${supply4h.low}–$${supply4h.high})`); }
  }

  // 6. Geopolitical flag bonus
  if (GEO_FLAG && bias === 'long') { score++; reasons.pro.push('Active geopolitical flag — supply disruption premium'); }

  // Apply sentiment modifier
  const modifier = sentiment?.modifier || 0;
  const finalScore = Math.min(score + modifier, 6);

  // Determine entry, SL, TPs
  let entry = null, sl = null, tp1 = null, tp2 = null, tp3 = null;
  let rr1 = null, rr2 = null, rr3 = null;

  if (bias === 'long') {
    entry = vwap ? Math.round(vwap * 100) / 100 : Math.round(price * 100) / 100;
    sl    = vwapLower ? Math.round((vwapLower - 0.50) * 100) / 100 : Math.round((entry - 3.50) * 100) / 100;
    const risk = entry - sl;

    // TP1 = nearest CHoCH above entry (from 4H labels)
    const struct = extractStructureLevels(labels4h, price);
    tp1 = struct.recentChochAbove || (supply4h ? supply4h.low - 0.50 : entry + risk * 1.5);
    tp2 = supply4h ? supply4h.mid : entry + risk * 3.0;
    tp3 = supply30m && supply30m.high > tp2 ? supply30m.high : entry + risk * 5.0;

    if (risk > 0) {
      rr1 = Math.round(((tp1 - entry) / risk) * 10) / 10;
      rr2 = Math.round(((tp2 - entry) / risk) * 10) / 10;
      rr3 = Math.round(((tp3 - entry) / risk) * 10) / 10;
    }
  }

  if (bias === 'short') {
    entry = vwap ? Math.round(vwap * 100) / 100 : Math.round(price * 100) / 100;
    sl    = vwapUpper ? Math.round((vwapUpper + 0.50) * 100) / 100 : Math.round((entry + 3.50) * 100) / 100;
    const risk = sl - entry;

    const struct = extractStructureLevels(labels4h, price);
    tp1 = struct.recentChochBelow || (demand4h ? demand4h.high + 0.50 : entry - risk * 1.5);
    tp2 = demand4h ? demand4h.mid : entry - risk * 3.0;
    tp3 = demand4h ? demand4h.low - 0.50 : entry - risk * 5.0;

    if (risk > 0) {
      rr1 = Math.round(((entry - tp1) / risk) * 10) / 10;
      rr2 = Math.round(((entry - tp2) / risk) * 10) / 10;
      rr3 = Math.round(((entry - tp3) / risk) * 10) / 10;
    }
  }

  return {
    bias, score, finalScore, modifier,
    entry, sl, tp1, tp2, tp3, rr1, rr2, rr3,
    supply4h, demand4h, supply30m, demand30m,
    vwap, vwapUpper, vwapLower, cvd, oi, sessionUpPct,
    reasons,
  };
}

// ─── Format zone map line ─────────────────────────────────────────────────────

function zoneMapLine(label, price, currentPrice, marker) {
  const delta  = price - currentPrice;
  const sign   = delta >= 0 ? '+' : '';
  const arrow  = delta > 2 ? '⬆' : delta < -2 ? '⬇' : '──';
  const m      = marker ? ` ← ${marker}` : '';
  return `${arrow} $${price.toFixed(2).padStart(7)}  ${label.padEnd(28)} [${sign}${delta.toFixed(1)}]${m}`;
}

// ─── Build Catalyst card ─────────────────────────────────────────────────────

function buildCard({ price, context, source, session, sentiment, setup, indicators4h, vwap4h, cvd4h, oi4h, sessionUpPct }) {
  const { bias, finalScore, entry, sl, tp1, tp2, tp3, rr1, rr2, rr3, supply4h, demand4h, supply30m, demand30m, reasons } = setup;
  const SEP   = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const now   = new Date().toUTCString().slice(17, 25);
  const scoreBar = '⭐'.repeat(Math.max(0, finalScore)) + '☆'.repeat(Math.max(0, 6 - finalScore));

  const dirIcon = bias === 'long' ? '🟢 LONG' : bias === 'short' ? '🔴 SHORT' : '📊 NEUTRAL';
  const titleLine = `🛢️ CATALYST ALERT — Brent Crude (BZ!) | ${session}`;

  const lines = [
    titleLine,
    SEP,
    '',
    `📰 **TRIGGER**`,
    `Source: ${source}`,
    context ? `"${context}"` : '',
    `🕐 ${now} UTC`,
    '',
    `💰 **PRICE SNAPSHOT**`,
    `Current:    $${price.toFixed(2)}   NYMEX:BZ1!`,
    vwap4h     != null ? `VWAP 4H:    $${vwap4h.toFixed(2)}   ${price > vwap4h ? '↑ Above — bullish bias' : '↓ Below — not yet reclaimed'}` : '',
    cvd4h      != null ? `CVD:        ${cvd4h.toFixed(0)}   ${cvd4h > 0 ? '↑ Buyers in control' : '↓ Selling pressure present'}` : '',
    oi4h       != null ? `OI:         ${(oi4h/1000).toFixed(1)}K` : '',
    sessionUpPct != null ? `Sess VP:    ${Math.round(sessionUpPct*100)}% Up  ${sessionUpPct > 0.55 ? '↑ Buyers dominating' : '↓ Sellers dominating'}` : '',
    '',
    SEP,
    `📍 **TRADE SETUP — ${dirIcon}**`,
    SEP,
    entry != null ? `Entry:      $${entry.toFixed(2)}` : 'Entry:      TBD — wait for VWAP pullback',
    sl    != null ? `Stop Loss:  $${sl.toFixed(2)}` : '',
    tp1   != null ? `TP1:        $${tp1.toFixed(2)}  (${rr1 != null ? rr1+'R' : '?'}) — structure flip` : '',
    tp2   != null ? `TP2:        $${tp2.toFixed(2)}  (${rr2 != null ? rr2+'R' : '?'}) — supply zone` : '',
    tp3   != null ? `TP3:        $${tp3.toFixed(2)}  (${rr3 != null ? rr3+'R' : '?'}) — extended target` : '',
    '',
    SEP,
    `🗺️ **ZONE MAP**`,
    SEP,
  ];

  // Build zone map
  const zoneLines = [];
  if (supply4h)  zoneLines.push(zoneMapLine(`4H Supply $${supply4h.low}–$${supply4h.high}`,  supply4h.mid,  price, tp2 && Math.abs(supply4h.mid - tp2) < 1 ? 'TP2' : null));
  if (supply30m && (!supply4h || Math.abs(supply30m.mid - supply4h.mid) > 2)) {
    zoneLines.push(zoneMapLine(`30M Supply $${supply30m.low}–$${supply30m.high}`, supply30m.mid, price, null));
  }
  if (vwap4h) zoneLines.push(zoneMapLine(`4H VWAP (entry zone)`, vwap4h, price, entry && Math.abs(vwap4h - entry) < 0.5 ? 'ENTRY' : null));
  lines.push(...zoneLines.sort((a, b) => {
    const pa = parseFloat(a.match(/\$(\d+\.\d+)/)?.[1] || 0);
    const pb = parseFloat(b.match(/\$(\d+\.\d+)/)?.[1] || 0);
    return pb - pa;
  }));
  lines.push(`  ★  $${price.toFixed(2).padStart(7)}  CURRENT PRICE`);
  if (demand4h)  lines.push(zoneMapLine(`4H Demand $${demand4h.low}–$${demand4h.high}`, demand4h.mid, price, null));
  if (sl)        lines.push(zoneMapLine(`HARD STOP`, sl, price, 'STOP'));

  // Quality section
  lines.push('', SEP, `⚖️ **TRADE QUALITY — ${finalScore}/6  ${scoreBar}**`, SEP);

  if (sentiment && sentiment.direction !== 'neutral') {
    const sIcon = sentiment.confirmed ? '✅' : '⚠️';
    lines.push(`${sIcon} Sentiment: ${sentiment.direction.toUpperCase()} | Severity: ${sentiment.severity.toUpperCase()} | ${sentiment.confirmed ? 'CONFIRMED' : 'UNCONFIRMED'}`);
    if (setup.modifier !== 0) lines.push(`   Catalyst modifier: ${setup.modifier > 0 ? '+1' : '-1'} applied to score`);
  }

  for (const r of reasons.pro) lines.push(`✅ ${r}`);
  for (const r of reasons.con) lines.push(`⚠️ ${r}`);

  // Why good/bad
  const whyGood = bias === 'long'
    ? (sentiment?.confirmed && sentiment?.direction === 'bullish'
        ? `Catalyst is CONFIRMED and SEVERE. Market still pricing pre-closure levels — gap to fair value is the trade. Minimum ${rr1 || '?'}R to TP1 with defined stop.`
        : `Technical setup active. Price approaching key demand with ${rr1 || '?'}R minimum to TP1.`)
    : `Price in supply zone with bearish structure confirmed. Risk clearly defined.`;

  const whyCon = bias === 'long'
    ? (sentiment && !sentiment.confirmed
        ? `Catalyst UNCONFIRMED — treat as technical trade only until physical event confirmed. Size down.`
        : `Counter-trend possible if daily bearish structure reasserts. Monitor ceasefire headlines. Take TP1 early.`)
    : `Geopolitical re-escalation can reverse short instantly. Keep stops tight.`;

  lines.push('', `**WHY IT'S GOOD:** ${whyGood}`, `**WHY TO BE CAREFUL:** ${whyCon}`);
  lines.push('', SEP, `⏳ WAITING FOR ENTRY — react 📊 for live update`);

  return lines.filter(l => l !== '').join('\n');
}

// ─── Log trade to backtest channel ──────────────────────────────────────────

async function logToBacktest(setup, price, context, source, session) {
  if (!BZ_BACKTEST_HOOK) return;
  const { bias, entry, sl, tp1, tp2, tp3, rr1, rr2, rr3 } = setup;
  const id   = `bz-${Date.now()}`;
  const card = [
    `📋 **SIGNAL LOGGED — BZ! ${bias?.toUpperCase() || 'NEUTRAL'}**`,
    `Time:    ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC | ${session}`,
    `Trigger: ${source}${context ? ' — "' + context + '"' : ''}`,
    entry != null ? `Entry:   $${entry.toFixed(2)}` : '',
    sl    != null ? `SL:      $${sl.toFixed(2)}` : '',
    tp1   != null ? `TP1:     $${tp1.toFixed(2)} (${rr1}R) | TP2: $${tp2?.toFixed(2)} (${rr2}R) | TP3: $${tp3?.toFixed(2)} (${rr3}R)` : '',
    `Status:  OPEN ⏳`,
    `ID:      \`${id}\``,
  ].filter(Boolean).join('\n');

  await postWebhook(BZ_BACKTEST_HOOK, 'info', card, `BZ! • Backtest Log • ${new Date().toISOString().slice(0,10)}`);

  // Persist to bz-trades.json
  const trades = readTrades();
  trades.push({
    id, instrument: 'BZ', symbol: 'NYMEX:BZ1!',
    firedAt: new Date().toISOString(),
    session, source, context: context || null,
    direction: bias, price,
    entry: setup.entry, stop: setup.sl,
    tp1: setup.tp1, tp2: setup.tp2, tp3: setup.tp3,
    rr1: setup.rr1, rr2: setup.rr2, rr3: setup.rr3,
    score: setup.finalScore,
    outcome: null, exitPrice: null, pnlR: null, closedAt: null,
  });
  writeTrades(trades);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { context, source, print } = parseArgs();
  const session = sessionLabel();
  const lockHolder = 'bz-analyze';

  log(`Starting analysis | source="${source}" | context="${context || ''}"`);

  // 1. Sentiment classification (parallel with CDP, fast)
  const sentimentPromise = classifySentiment(context);

  // 2. Acquire TradingView lock
  const lock = await acquireLock(30_000, lockHolder);
  if (!lock) {
    log('Could not acquire TradingView lock after 30s — aborting');
    if (!print && BZ_SIGNALS_HOOK) {
      await postWebhook(BZ_SIGNALS_HOOK, 'error',
        '❌ **BZ Analysis failed**\nCould not acquire TradingView lock (another script is running). Try again in 30 seconds.',
        `BZ! • ${session}`);
    }
    return;
  }

  let client;

  try {
    client = await cdpConnect('BZ');
    const currentSymbol = await getSymbol(client);
    log(`Connected to BZ tab. Symbol: ${currentSymbol}`);

    // If somehow not on BZ1!, switch symbol only (never navigate — breaks Desktop)
    if (currentSymbol !== BZ_SYMBOL && !(currentSymbol || '').endsWith('BZ1!')) {
      await setSymbol(client, BZ_SYMBOL);
      log(`Switched symbol to ${BZ_SYMBOL}`);
    }

    // ── 4H sweep ──────────────────────────────────────────────────────────────
    await setTimeframe(client, '240');
    const quote4h = await waitForPrice(client);
    const [studies4h, boxes4h, labels4h, ohlcv4h] = await Promise.all([
      getStudyValues(client),
      getPineBoxes(client, 'LuxAlgo'),
      getPineLabels(client, 'LuxAlgo'),
      getOHLCV(client, 20),
    ]);
    const price = quote4h.last;
    const { atr14, buffer } = calcATR(ohlcv4h);
    const ind4h = parseStudies(studies4h);
    log(`4H: price=$${price} ATR14=${atr14} buffer=${buffer}`);

    // ── 1H sweep ──────────────────────────────────────────────────────────────
    await setTimeframe(client, '60');
    const [studies1h, boxes1h] = await Promise.all([
      getStudyValues(client),
      getPineBoxes(client, 'LuxAlgo'),
    ]);

    // ── 30M sweep ─────────────────────────────────────────────────────────────
    await setTimeframe(client, '30');
    const [studies30m, boxes30m, labels30m] = await Promise.all([
      getStudyValues(client),
      getPineBoxes(client, 'LuxAlgo'),
      getPineLabels(client, 'LuxAlgo'),
    ]);

    // Restore to 4H — leave symbol alone, BZ tab stays on BZ1!
    await setTimeframe(client, '240');

    // 3. Await sentiment
    const sentiment = await sentimentPromise;
    log(`Sentiment: direction=${sentiment.direction} severity=${sentiment.severity} confirmed=${sentiment.confirmed} modifier=${sentiment.modifier}`);

    // 4. Evaluate setup
    const setup = evaluateSetup(
      price, ind4h, parseStudies(studies1h),
      boxes4h, boxes1h, boxes30m, labels4h, sentiment
    );
    log(`Setup: bias=${setup.bias} score=${setup.finalScore}/6 entry=$${setup.entry?.toFixed(2)}`);

    // 5. Build and post Catalyst card
    const card = buildCard({
      price, context, source, session, sentiment, setup,
      indicators4h: ind4h,
      vwap4h:       ind4h.vwap,
      cvd4h:        ind4h.cvd,
      oi4h:         ind4h.oi,
      sessionUpPct: ind4h.sessionUp != null
        ? ind4h.sessionUp / Math.max(1, ind4h.sessionUp + ind4h.sessionDown)
        : null,
    });

    if (print) {
      console.log(card);
    } else {
      if (!BZ_SIGNALS_HOOK) throw new Error('BZ_DISCORD_SIGNALS_WEBHOOK not set in .env');

      const footer = `BZ! • NYMEX:BZ1! • ${new Date().toUTCString().slice(5, 25)} UTC`;
      const msgId  = await postWebhook(BZ_SIGNALS_HOOK, 'catalyst', card, footer);
      log(`Catalyst card posted to ##bz-signals${msgId ? ' id=' + msgId : ''}`);

      // Store message ID for 📊 reaction polling
      const state = readState();
      if (!Array.isArray(state._signal_messages)) state._signal_messages = [];
      state._signal_messages.push({ id: msgId, firedAt: Date.now(), label: 'catalyst', analyzed: false });
      if (state._signal_messages.length > 20) state._signal_messages = state._signal_messages.slice(-20);
      writeState(state);

      // Log to backtest
      await logToBacktest(setup, price, context, source, session);
    }

  } catch (e) {
    log(`Error: ${e.message}`);
    if (!print && BZ_SIGNALS_HOOK) {
      await postWebhook(BZ_SIGNALS_HOOK, 'error',
        `❌ **BZ Analysis failed**\n**Error:** ${e.message}\n**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout.`,
        `BZ! • ${session}`);
    }
  } finally {
    // Always restore symbol and release lock
    try {
      if (client && originalSymbol && originalSymbol !== BZ_SYMBOL) {
        await setSymbol(client, originalSymbol);
      }
    } catch {}
    try { if (client) await client.close(); } catch {}
    releaseLock(lockHolder);
    log('Done');
  }
}

main().catch(e => { console.error('[bz-analyze] Fatal:', e.message); process.exit(1); });
