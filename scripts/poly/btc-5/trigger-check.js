#!/usr/bin/env node
'use strict';

/**
 * Polymarket BTC 5-min Directional Signal — Trigger Check
 *
 * Cron: 1,6,11,16,21,26,31,36,41,46,51,56 * * * * (fires 1 min after each 5-min bar open)
 *
 * What it does:
 *   1. Deduplicates against current bar — exits if already fired this bar
 *   2. Auto-discovers active Polymarket market URL (hourly check via Gamma API)
 *   3. Checks previous bar prediction → records outcome (UP/DOWN, correct/incorrect)
 *   4. Multi-TF sweep via TradingView CDP:
 *        5M:  price, VWAP, VRVP (POC/VAH/VAL), OI, CVD
 *        1M:  OHLCV last 4 bars (micro momentum)
 *        1H:  OHLCV last 4 bars (macro structure filter)
 *   5. Scores 5 factors (CVD worth 0–2 pts, all others 0–1 pt; max score=6)
 *   6. Determines direction (UP/DOWN) from majority of directional factors
 *   7. If score ≥ 5: posts Discord embed to #poly-btc-5
 *   8. Logs full evaluation to poly-btc-5-trades.json regardless of score
 */

const path = require('path');
const fs   = require('fs');

const { loadEnv, ROOT }            = require('../../lib/env');
const { acquireLock, releaseLock } = require('../../lib/lock');
const {
  cdpConnect, setSymbol, setTimeframe, waitForPrice,
  getStudyValues, getOHLCV, cdpEval, sleep,
} = require('../../lib/cdp');
const { postWebhook, addReaction } = require('../../lib/discord');
const { btcDirection5m }            = require('../../lib/binance');
const { fetchMarketTokens, fetchOrderBook, slugForBar } = require('../../lib/polymarket');

loadEnv();

if (process.env.TRADINGVIEW_ENABLED === 'false') {
  console.log('[poly-btc-5] TRADINGVIEW_ENABLED=false — skipping');
  process.exit(0);
}
if (process.env.PRIMARY === 'false') {
  console.log('[poly-btc-5] PRIMARY=false — skipping');
  process.exit(0);
}

const SYMBOL        = 'BINANCE:BTCUSDT.P';
const SIGNALS_HOOK  = process.env.POLY_BTC_5_SIGNALS_WEBHOOK;
const STATE_FILE    = path.join(ROOT, '.poly-btc-5-state.json');
const TRADES_FILE   = path.join(ROOT, 'poly-btc-5-trades.json');

const CDP_ERROR_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function log(msg) { console.log(`[${new Date().toISOString()}] [poly-btc-5] ${msg}`); }

// Retired 2026-05-24: search-based Gamma discovery and the hourly check were
// silently returning null (state._marketUrl stayed null). Replaced by
// deterministic `slugForBar(barOpenMs)` from scripts/lib/polymarket.js —
// Polymarket creates exactly one market per 5-min bar with a predictable
// slug. See refactors/2026-05-24-poly-btc-5-entry-price-tracking.md.

function readState()    { try { return JSON.parse(fs.readFileSync(STATE_FILE,  'utf8')); } catch { return {}; } }
function writeState(s) {
  const tmp = STATE_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, STATE_FILE); }
  catch (e) { console.error(`[writeState] write failed: ${e.message}`); }
}
function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } }
function writeTrades(t) {
  const tmp = TRADES_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(t, null, 2)); fs.renameSync(tmp, TRADES_FILE); }
  catch (e) { console.error(`[writeTrades] write failed: ${e.message}`); }
}

// ─── Bar timestamps ───────────────────────────────────────────────────────────

function barOpenTimestamp(offsetBars = 0) {
  const now       = new Date();
  const barMinute = Math.floor(now.getUTCMinutes() / 5) * 5;
  const d         = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), barMinute, 0, 0));
  d.setTime(d.getTime() - offsetBars * 5 * 60 * 1000);
  return d.toISOString();
}

// ─── VRVP CDP expression ──────────────────────────────────────────────────────

const VRVP_EXPR = `(function(){
  try {
    var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
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
      return { poc: poc, vah: vah, val: val };
    }
    return null;
  } catch(e) { return null; }
})()`;

// ─── Study parser ─────────────────────────────────────────────────────────────

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

// ─── Scoring ──────────────────────────────────────────────────────────────────

function evaluate({ price, vwap, vrvp, oiCurrent, cvd5m, cvdPrev, ohlcv1m, ohlcv1h, utcHour }) {
  const factors = {};

  // Factor 1: CVD momentum (0–2 pts, directional)
  // Primary: 1M price momentum (last 3 closes). Secondary: CVD trend vs prior-bar state.
  // Both agree → 2pts. Momentum only → 1pt. Conflict → 0pts.
  let cvdDir = null, cvdScore = 0;

  let momentumDir = null;
  if (ohlcv1m && ohlcv1m.length >= 3) {
    const c = ohlcv1m.slice(-3).map(b => b.close);
    if      (c[2] > c[1] && c[1] > c[0]) momentumDir = 'UP';
    else if (c[2] < c[1] && c[1] < c[0]) momentumDir = 'DOWN';
    else if (c[2] > c[0])                momentumDir = 'UP';
    else if (c[2] < c[0])                momentumDir = 'DOWN';
  }
  let cvdTrendDir = null;
  if (cvd5m != null && cvdPrev != null) {
    if      (cvd5m > cvdPrev) cvdTrendDir = 'UP';
    else if (cvd5m < cvdPrev) cvdTrendDir = 'DOWN';
  }
  if      (momentumDir && cvdTrendDir === momentumDir) { cvdDir = momentumDir; cvdScore = 2; }
  else if (momentumDir && cvdTrendDir == null)         { cvdDir = momentumDir; cvdScore = 1; }
  else if (momentumDir)                                { cvdDir = null;        cvdScore = 0; }
  else if (cvdTrendDir)                                { cvdDir = cvdTrendDir; cvdScore = 1; }

  factors.cvdDir    = cvdDir;
  factors.cvdScore  = cvdScore;
  factors.cvdStrong = cvdScore === 2;

  // Factor 2: VWAP position (1 pt, directional)
  let vwapDir = null;
  if (vwap && price) {
    const pct = (price - vwap) / vwap;
    if (pct >  0.0015) vwapDir = 'UP';
    if (pct < -0.0015) vwapDir = 'DOWN';
  }
  factors.vwapDir = vwapDir;

  // Factor 3: 1H structure (1 pt, directional) — macro trend filter
  // Kept at 1H even for 5M signals: aligning with the hourly trend is the strongest quality gate.
  let structDir = null;
  if (ohlcv1h && ohlcv1h.length >= 3) {
    const b = ohlcv1h.slice(-3);
    const hhhl   = b[2].high > b[1].high && b[1].high > b[0].high && b[2].low > b[1].low;
    const lllh   = b[2].low  < b[1].low  && b[1].low  < b[0].low  && b[2].high < b[1].high;
    const partUp = b[2].high > b[1].high || b[2].low > b[1].low;
    const partDn = b[2].low  < b[1].low  || b[2].high < b[1].high;
    if (hhhl)                   structDir = 'UP';
    else if (lllh)              structDir = 'DOWN';
    else if (partUp && !partDn) structDir = 'UP';
    else if (partDn && !partUp) structDir = 'DOWN';
  }
  factors.structDir = structDir;

  // Factor 4: Clean air (1 pt, non-directional)
  let cleanAir = true;
  if (vrvp && price) {
    const threshold = price * 0.003;
    for (const lvl of [vrvp.poc, vrvp.vah, vrvp.val]) {
      if (lvl && Math.abs(price - lvl) < threshold) { cleanAir = false; break; }
    }
  }
  factors.cleanAir = cleanAir;

  // Factor 5: Active session (1 pt, non-directional)
  const goodSession = utcHour >= 8 && utcHour < 21;
  factors.goodSession = goodSession;

  function scoreFor(dir) {
    let s = 0;
    if (factors.cvdDir === dir)    s += factors.cvdScore;
    if (factors.vwapDir === dir)   s += 1;
    if (factors.structDir === dir) s += 1;
    if (factors.cleanAir)          s += 1;
    if (factors.goodSession)       s += 1;
    return s;
  }

  const upScore   = scoreFor('UP');
  const downScore = scoreFor('DOWN');
  const direction = upScore >= downScore ? 'UP' : 'DOWN';
  const score     = Math.max(upScore, downScore);

  return { score, direction, factors, upScore, downScore };
}

// ─── Backtest log line ────────────────────────────────────────────────────────
//
// One compact line per resolved signal, posted to #poly-btc-5-backtest at the
// moment outcome resolves. Designed to be greppable + skimmable on mobile.
// Only directional factors that fired in the predicted direction are listed.
function formatBacktestLine(ev) {
  const f = ev.factors || {};
  const dir = ev.prediction;
  const tags = [];
  if (f.cvdDir === dir)    tags.push(f.cvdScore === 2 ? 'CVD²' : 'CVD');
  if (f.vwapDir === dir)   tags.push('VWAP');
  if (f.structDir === dir) tags.push('1H');
  if (f.cleanAir)          tags.push('Clean');
  if (f.goodSession)       tags.push('Session');

  const time   = new Date(ev.barOpen).toISOString().slice(11, 16); // HH:MM
  const emoji  = ev.correct ? '✅' : '❌';
  const score  = `${ev.score}/6`;
  const price  = ev.price ? `$${Math.round(ev.price).toLocaleString()}` : '';

  // Realized $ result when we have an entry ask: paid ask, received $1 on win,
  // $0 on loss. Positive = profit, negative = loss. Skip when entry missing.
  let evNote = '';
  if (ev.entryAsk != null) {
    const pnl = ev.correct ? (1 - ev.entryAsk) : -ev.entryAsk;
    const sign = pnl >= 0 ? '+' : '';
    evNote = ` · entry ${ev.entryAsk.toFixed(2)} → ${sign}${pnl.toFixed(2)}`;
  }

  return `${emoji} \`${time} UTC\` · **${dir}** ${score} · ${price}${evNote} · ${tags.join('+')}`;
}

// ─── Discord embed ────────────────────────────────────────────────────────────

function calcProbability(upScore, downScore) {
  const netEdge = Math.abs(upScore - downScore);
  return Math.min(88, 50 + netEdge * 9);
}

function buildEmbed(result, price, barOpenTs, marketUrl, entry) {
  const { score, direction, factors, upScore, downScore } = result;
  const isUp  = direction === 'UP';
  const arrow = isUp ? '↑' : '↓';
  const emoji = isUp ? '🟢' : '🔴';
  const tier  = score >= 5 ? 'HIGH' : 'MODERATE';
  const prob  = calcProbability(upScore, downScore);

  const barEnd   = new Date(new Date(barOpenTs).getTime() + 5 * 60 * 1000);
  const barLabel = `${barOpenTs.slice(11, 16)}–${barEnd.toISOString().slice(11, 16)} UTC`;

  const cvdLine = factors.cvdDir
    ? `${factors.cvdDir === direction ? '✅' : '❌'} CVD: ${factors.cvdStrong ? '1M momentum + CVD trend' : 'partial'} ${factors.cvdDir === 'UP' ? 'bullish' : 'bearish'} (+${factors.cvdScore})`
    : `❌ CVD: no clear trend`;

  // Polymarket entry-price line. Skipped when entry capture failed (book
  // unreachable). The ask is what we'd pay to enter; spread > ~500bps means
  // execution will eat most of the directional edge.
  const entryLine = entry?.entryAsk != null
    ? `**Entry:** ${entry.entryBid.toFixed(2)} / ${entry.entryAsk.toFixed(2)} (mid ${entry.entryMid.toFixed(2)}, spread ${entry.entrySpreadBps}bps)`
    : null;

  const lines = [
    `${emoji} **BTC ${direction} ${arrow} — ${prob}% probability**`,
    `Bar: ${barLabel} · Score: ${score}/6 · Tier: ${tier}`,
    ``,
    cvdLine,
    `${factors.vwapDir === direction ? '✅' : '❌'} VWAP: price ${isUp ? 'above' : 'below'} VWAP${factors.vwapDir ? '' : ' (near — no edge)'}`,
    `${factors.structDir === direction ? '✅' : '❌'} 1H structure: ${factors.structDir ? (factors.structDir === 'UP' ? 'higher highs/lows' : 'lower lows/highs') : 'choppy (no clear structure)'}`,
    `${factors.cleanAir ? '✅' : '❌'} Clean air: ${factors.cleanAir ? 'no major level within 0.3%' : 'VRVP level nearby (caution)'}`,
    `${factors.goodSession ? '✅' : '❌'} Session: ${factors.goodSession ? 'active window (08–21 UTC)' : 'low-volume window'}`,
    ``,
    `**Price:** $${price.toFixed(2)}   [Market →](${marketUrl})`,
  ];
  if (entryLine) lines.push(entryLine);

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const currentBar = barOpenTimestamp(0);
  const prevBar    = barOpenTimestamp(1);
  const utcHour    = new Date().getUTCHours();

  const state = readState();

  if (state._lastBarFired === currentBar) {
    log(`Already fired for bar ${currentBar} — skipping`);
    return;
  }

  if (state._lastCdpError && Date.now() - state._lastCdpError < CDP_ERROR_COOLDOWN_MS) {
    log('In CDP error cooldown — skipping');
    return;
  }

  const lock = await acquireLock(15_000, 'poly-btc-5');
  if (!lock) {
    log('Could not acquire lock — another script is running, skipping');
    return;
  }

  let client;

  try {
    // Market URL is derived deterministically from the bar timestamp; no
    // discovery, no caching, no alert layer. See the slugForBar import.
    const marketUrl = `https://polymarket.com/event/${slugForBar(new Date(currentBar).getTime())}`;

    // ── Outcome resolution (Binance REST — ground truth) ────────────────────
    //
    // Why Binance and not TradingView OHLCV: TV CDP reads can race against
    // chart tick refresh and return the wrong bar (audit 2026-05-24 found
    // 3.2% label disagreements). Binance Futures klines are authoritative
    // for a closed 5-min bar and work even when the TV chart is offline or
    // backgrounded.
    //
    // We resolve ALL signaled bars with outcome=null whose barOpen is
    // ≥ 6 minutes old (one full 5-min bar plus a 60s grace for the kline
    // to publish). Single-prev-bar logic created orphans when crons skipped.
    // `trades` is hoisted to the try scope — downstream code appends the
    // current bar's evaluation to the same array.
    const trades  = readTrades();
    {
      const nowMs   = Date.now();
      const minAge  = 6 * 60 * 1000;
      const pending = trades.filter(t => t.signaled && !t.outcome
        && (nowMs - new Date(t.barOpen).getTime()) >= minAge);

      if (pending.length > 0) {
        log(`Resolving ${pending.length} unresolved signaled bar(s) via Binance`);
        const botToken     = process.env.DISCORD_BOT_TOKEN;
        const channelId    = process.env.POLY_BTC_5_SIGNALS_CHANNEL_ID;
        const backtestHook = process.env.POLY_BTC_5_BACKTEST_WEBHOOK;
        let writeMutated = false;

        // Cap per-run work; remaining bars will resolve on next cycle.
        for (const ev of pending.slice(0, 20)) {
          let truth;
          try {
            truth = await btcDirection5m(new Date(ev.barOpen).getTime());
          } catch (e) {
            log(`Binance lookup failed for ${ev.barOpen}: ${e.message}`);
            continue;
          }
          if (!truth) {
            log(`Bar ${ev.barOpen} not yet available on Binance — will retry next run`);
            continue;
          }
          ev.outcome  = truth;
          ev.correct  = ev.prediction === truth;
          ev.closedAt = new Date().toISOString();
          writeMutated = true;
          log(`Outcome for ${ev.barOpen}: ${truth} (${ev.correct ? 'CORRECT ✓' : 'WRONG ✗'}) predicted=${ev.prediction}`);

          if (botToken && channelId) {
            const msgs   = state._signal_messages || [];
            const sigMsg = msgs.find(m => m.barOpen === ev.barOpen);
            if (sigMsg?.id && !sigMsg.reacted) {
              const emoji = ev.correct ? '✅' : '❌';
              const ok    = await addReaction(botToken, channelId, sigMsg.id, emoji);
              if (ok) {
                sigMsg.reacted = true;
                writeState(state);
                log(`Reaction ${emoji} posted to signal ${sigMsg.id}`);
              } else {
                log(`Reaction ${emoji} failed for signal ${sigMsg.id}`);
              }
            }
          }

          // Per-signal backtest log line — fire-and-forget; failures don't
          // block the outcome write.
          if (backtestHook) {
            try {
              await postWebhook(backtestHook, ev.correct ? 'long' : 'short',
                formatBacktestLine(ev), 'Poly BTC-5 • Backtest');
            } catch (e) {
              log(`Backtest post failed for ${ev.barOpen}: ${e.message}`);
            }
          }
        }
        if (writeMutated) writeTrades(trades);
      }
    }

    client = await cdpConnect('BTC');
    await setSymbol(client, SYMBOL);

    // ── 5M sweep (primary) ────────────────────────────────────────────────────
    await setTimeframe(client, '5');
    await waitForPrice(client);
    await sleep(500);

    const [studies5m, ohlcv5mBar, vrvp] = await Promise.all([
      getStudyValues(client),
      getOHLCV(client, 2),
      cdpEval(client, VRVP_EXPR),
    ]);

    const price = ohlcv5mBar[ohlcv5mBar.length - 1]?.close;
    if (!price) throw new Error('Could not read price from OHLCV');

    const { vwap, oi: oiCurrent, cvd: cvd5m } = parseStudies(studies5m);
    const cvdPrev = state._lastCvd || null;

    state._lastCvd = cvd5m;

    // ── 1M sweep: micro momentum ──────────────────────────────────────────────
    await setTimeframe(client, '1');
    await waitForPrice(client);
    await sleep(400);

    const ohlcv1m = await getOHLCV(client, 4);

    // ── 1H sweep: macro structure ─────────────────────────────────────────────
    await setTimeframe(client, '60');
    await waitForPrice(client);
    await sleep(400);

    const ohlcv1h = await getOHLCV(client, 4);

    // Intentionally do NOT restore the chart to 5M here. This script shares the
    // BINANCE:BTCUSDT.P tab with the BTC trigger-check (canonical 30M) and the
    // user; yanking the chart back to 5M every 5 minutes was overwriting both
    // the BTC trigger's 30M state and any manual TF the user had selected.
    // Leaving the chart on 1H is harmless: each script asserts the TF it needs
    // at the top of its own run.

    log(`price=$${price?.toFixed(2)} vwap=${vwap?.toFixed(2)} oi=${oiCurrent?.toFixed(0)} cvd=${cvd5m?.toFixed(0)} cvdPrev=${cvdPrev?.toFixed(0)}`);

    // ── Score ─────────────────────────────────────────────────────────────────
    const result = evaluate({ price, vwap, vrvp, oiCurrent, cvd5m, cvdPrev, ohlcv1m, ohlcv1h, utcHour });
    const { score, direction } = result;

    log(`score=${score} direction=${direction} up=${result.upScore} down=${result.downScore}`);

    if (state._lastCdpError) delete state._lastCdpError;
    state._lastBarFired = currentBar;
    writeState(state);

    // ── Log evaluation ────────────────────────────────────────────────────────
    const evalEntry = {
      id:              `PM-BTC5-${currentBar}`,
      barOpen:         currentBar,
      prediction:      score >= 5 ? direction : null,
      score,
      tier:            score >= 5 ? 'high' : null,
      signaled:        score >= 5,
      price,
      factors: {
        cvdDir:      result.factors.cvdDir,
        cvdScore:    result.factors.cvdScore,
        vwapDir:     result.factors.vwapDir,
        structDir:   result.factors.structDir,
        cleanAir:    result.factors.cleanAir,
        goodSession: result.factors.goodSession,
      },
      upScore:         result.upScore,
      downScore:       result.downScore,
      // Polymarket entry context (null when score < 5 or CLOB unreachable).
      // Captures the bid/ask we'd actually trade at, so summary.js can compute
      // realized $-EV instead of just win rate (audit Tier A1, 2026-05-24).
      entryBid:        null,
      entryAsk:        null,
      entryMid:        null,
      entrySpreadBps:  null,
      entryDepthAsk:   null,
      entryTokenId:    null,
      entryMarketSlug: null,
      bookTs:          null,
      discordMessageId: null,
      outcome:         null,
      correct:         null,
      closedAt:        null,
    };

    // ── Polymarket entry-price capture (signal bars only) ─────────────────────
    if (score >= 5) {
      const slug = slugForBar(new Date(currentBar).getTime());
      try {
        const tokens = await fetchMarketTokens(slug);
        if (tokens) {
          const tokenId = direction === 'UP' ? tokens.upTokenId : tokens.downTokenId;
          const book    = await fetchOrderBook(tokenId);
          if (book) {
            evalEntry.entryBid        = book.bid;
            evalEntry.entryAsk        = book.ask;
            evalEntry.entryMid        = book.mid;
            evalEntry.entrySpreadBps  = book.spreadBps;
            evalEntry.entryDepthAsk   = book.depthAsk;
            evalEntry.entryTokenId    = tokenId;
            evalEntry.entryMarketSlug = slug;
            evalEntry.bookTs          = book.ts;
            log(`Entry book: ${direction} bid=${book.bid} ask=${book.ask} mid=${book.mid} spread=${book.spreadBps}bps`);
          } else {
            log(`Polymarket book unavailable for slug ${slug}`);
          }
        } else {
          log(`Polymarket tokens not found for slug ${slug} (market may not be open yet)`);
        }
      } catch (e) {
        log(`Polymarket lookup error: ${e.message}`);
      }
    }

    trades.push(evalEntry);
    writeTrades(trades);

    // ── Signal alert ──────────────────────────────────────────────────────────
    if (score >= 5 && SIGNALS_HOOK) {
      // Prefer the bar-specific market URL we just resolved; fall back to the
      // (often stale) cached one only when book capture failed.
      const embed  = buildEmbed(result, price, currentBar, marketUrl, evalEntry);
      const footer = `POLY BTC-5 • ${SYMBOL} • ${new Date().toUTCString().slice(5, 25)} UTC`;
      const type   = direction === 'UP' ? 'long' : 'short';

      const msgId = await postWebhook(SIGNALS_HOOK, type, embed, footer);
      log(`Signal posted (score=${score} dir=${direction})${msgId ? ' id=' + msgId : ''}`);

      if (msgId) {
        evalEntry.discordMessageId = msgId;
        writeTrades(trades);

        if (!Array.isArray(state._signal_messages)) state._signal_messages = [];
        state._signal_messages.push({ id: msgId, firedAt: Date.now(), barOpen: currentBar, analyzed: false, reacted: false });
        // Prune by age, not count. Outcome resolution needs the message ID to
        // post the ✅/❌ reaction; a 20-message cap dropped IDs for older bars
        // before they were resolved. 14 days >> max resolution latency.
        const MSG_TTL_MS = 14 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - MSG_TTL_MS;
        state._signal_messages = state._signal_messages.filter(m => (m.firedAt ?? 0) >= cutoff);
        writeState(state);
      }
    } else {
      log(`Score ${score}/6 — below threshold (need 5+), no signal`);
    }

  } catch (e) {
    log(`Error: ${e.message}`);
    const code = e.code || '';
    if (code === 'CDP_UNAVAILABLE' || code === 'NO_TARGET' || /ECONNREFUSED|connect/i.test(e.message)) {
      state._lastCdpError = Date.now();
      writeState(state);
      if (SIGNALS_HOOK) {
        const lastAlert = state._lastCdpAlertAt || 0;
        if (Date.now() - lastAlert > CDP_ERROR_COOLDOWN_MS) {
          state._lastCdpAlertAt = Date.now();
          writeState(state);
          await postWebhook(SIGNALS_HOOK, 'error',
            `❌ **Poly BTC-5 — TradingView Unreachable**\n**What:** CDP connection failed\n**Fix:** Open TradingView Desktop and switch to the 🕵Ace layout`,
            'Poly BTC-5 • System Error');
        }
      }
    }
  } finally {
    try { if (client) await client.close(); } catch {}
    releaseLock('poly-btc-5');
  }
}

main().catch(e => { console.error('[poly-btc-5] Fatal:', e.message); process.exit(1); });
