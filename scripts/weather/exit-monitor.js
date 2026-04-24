'use strict';

/**
 * weather/exit-monitor.js — 5-layer paper trade exit monitor
 *
 * Runs every 5 minutes via Task Scheduler. Checks all open paper trades
 * that were manually entered (tookBy set) and auto-closes them when any
 * exit condition fires. Posts an exit card to #weather-signals.
 *
 * Exit layers (checked in priority order):
 *   1. Profit target   — 60% of original edge captured
 *   2. Edge convergence — remaining edge < 2%
 *   3. Trailing stop   — 40% pullback from peak gain
 *   4. Stop loss       — position down -15% from entry
 *   5. Time decay      — within 2h of resolution (end-of-day UTC)
 *
 * Peak price tracking: peakPrice is persisted in weather-trades.json
 * each run so the trailing stop survives restarts.
 */

const fs   = require('fs');
const path = require('path');

const { loadEnv, ROOT, resolveWebhook } = require('../lib/env');
loadEnv();

const { getMarketPrice } = require('../lib/polymarket');
const { postWebhook }    = require('../lib/discord');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRADES_FILE = path.join(ROOT, 'weather-trades.json');

const PROFIT_TARGET_RATIO = 0.60;  // 60% of original edge captured
const EDGE_CONVERGE_FLOOR = 0.02;  // remaining edge < 2 percentage points (decimal)
const TRAILING_STOP_RATIO = 0.40;  // 40% pullback from peak gain
const STOP_LOSS_RATIO     = 0.15;  // -15% mark-to-market on position
const TIME_DECAY_HOURS    = 2;     // exit within 2h of resolution

const SIGNALS_WEBHOOK = resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); }
  catch { return []; }
}

function writeTrades(trades) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

/** Mark-to-market P&L: what you'd pocket selling the position right now. */
function calcPnl(betDollars, entryPrice, currentPrice) {
  if (!betDollars || betDollars <= 0 || !entryPrice || entryPrice <= 0) return null;
  return Math.round(betDollars * ((currentPrice - entryPrice) / entryPrice) * 100) / 100;
}

function exitLabel(reason) {
  const labels = {
    profit_target:  '🎯 Profit Target (60% of edge captured)',
    edge_converged: '📉 Edge Converged (<2% remaining)',
    trailing_stop:  '🛑 Trailing Stop (40% pullback from peak)',
    stop_loss:      '❌ Stop Loss (-15%)',
    time_decay:     '⏰ Time Decay (within 2h of resolution)',
  };
  return labels[reason] || reason;
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }
function cents(n) { return (n * 100).toFixed(1) + '¢'; }

// ---------------------------------------------------------------------------
// Per-trade check
// ---------------------------------------------------------------------------

/**
 * Fetch live price and evaluate all 5 exit conditions.
 * Returns null if live price is unavailable.
 * Returns { exitReason, currentPrice, peakPrice, remainingEdge, pnlDollars }
 *   exitReason is null if no condition fired.
 */
async function checkTrade(trade) {
  const livePrice = await getMarketPrice(trade.conditionId).catch(() => null);
  if (!livePrice) return null;

  const entryPrice    = trade.side === 'yes' ? trade.yesPrice   : trade.noPrice;
  const currentPrice  = trade.side === 'yes' ? livePrice.yes    : livePrice.no;
  const modelProb     = trade.modelProb / 100;  // stored as e.g. 54.7 → 0.547
  const originalEdge  = trade.edge / 100;       // stored as e.g. 24.8 → 0.248

  // Track peak price across runs (persisted in trade record)
  const peakPrice     = Math.max(trade.peakPrice ?? entryPrice, currentPrice);

  const gain          = currentPrice - entryPrice;
  const remainingEdge = modelProb - currentPrice;  // still-unexploited edge (decimal)

  let exitReason = null;

  // --- Layer 1: Profit target — 60% of original edge captured ---------------
  if (originalEdge > 0 && gain / originalEdge >= PROFIT_TARGET_RATIO) {
    exitReason = 'profit_target';
  }

  // --- Layer 2: Edge convergence — remaining edge < 2% ---------------------
  else if (remainingEdge < EDGE_CONVERGE_FLOOR) {
    exitReason = 'edge_converged';
  }

  // --- Layer 3: Trailing stop — 40% pullback from peak gain ----------------
  else if (peakPrice > entryPrice) {
    const pullbackRatio = (peakPrice - currentPrice) / (peakPrice - entryPrice);
    if (pullbackRatio >= TRAILING_STOP_RATIO) {
      exitReason = 'trailing_stop';
    }
  }

  // --- Layer 4: Stop loss — position down -15% from entry ------------------
  else if (entryPrice > 0 && gain / entryPrice <= -STOP_LOSS_RATIO) {
    exitReason = 'stop_loss';
  }

  // --- Layer 5: Time decay — within 2h of end-of-resolution-day UTC --------
  else if (trade.parsed?.date) {
    const resolutionMs = new Date(trade.parsed.date + 'T23:59:00Z').getTime();
    const hoursLeft    = (resolutionMs - Date.now()) / 3_600_000;
    if (hoursLeft >= 0 && hoursLeft <= TIME_DECAY_HOURS) {
      exitReason = 'time_decay';
    }
  }

  return {
    exitReason,
    currentPrice,
    peakPrice,
    remainingEdge,
    pnlDollars: calcPnl(trade.betDollars, entryPrice, currentPrice),
    entryPrice,
    originalEdge,
  };
}

// ---------------------------------------------------------------------------
// Discord exit card
// ---------------------------------------------------------------------------

async function postExitCard(trade, result) {
  const { exitReason, currentPrice, entryPrice, remainingEdge, pnlDollars, originalEdge } = result;

  const city   = (trade.parsed?.city || 'unknown').toUpperCase();
  const type   = (trade.parsed?.type || 'temp').toUpperCase();
  const side   = trade.side.toUpperCase();
  const date   = trade.parsed?.date || '?';

  const edgeCaptured  = originalEdge > 0
    ? Math.round(((currentPrice - entryPrice) / originalEdge) * 100)
    : 0;

  const pnlStr   = pnlDollars != null
    ? (pnlDollars >= 0 ? `+$${pnlDollars.toFixed(2)}` : `-$${Math.abs(pnlDollars).toFixed(2)}`)
    : 'N/A';
  const pnlEmoji = pnlDollars == null ? '📊' : pnlDollars >= 0 ? '💚' : '🔴';

  const lines = [
    `**${trade.question}**`,
    '',
    `**Trigger:** ${exitLabel(exitReason)}`,
    '',
    `📌 **${side} position:** ${cents(entryPrice)} entry → ${cents(currentPrice)} exit`,
    `${pnlEmoji} **Paper P&L:** ${pnlStr}`,
    '',
    `📉 Edge captured: **${edgeCaptured}%** of original | Remaining: **${pct(Math.max(remainingEdge, 0))}**`,
    `⏱️ Resolves: **${date}**`,
    `📌 *Paper trade auto-closed — check polymarket.com to exit live position*`,
    `\`\`\`ID: ${trade.id}\`\`\``,
  ];

  await postWebhook(
    SIGNALS_WEBHOOK,
    'info',
    lines.join('\n'),
    `Weather • ${city.toLowerCase()} • exit-monitor • ${new Date().toISOString().slice(11, 16)} UTC`,
  );
}

// ---------------------------------------------------------------------------
// Core: autoExit — called by market-scan.js (or standalone via main())
// ---------------------------------------------------------------------------

/**
 * Check all open paper trades for exit conditions.
 * Mutates the trades array in place and returns true if any trade was changed.
 * Callers are responsible for persisting trades if the return value is true.
 *
 * @param {Array} trades  — the full trades array (from weather-trades.json)
 * @returns {Promise<boolean>} dirty — true if any trade was updated
 */
async function autoExit(trades) {
  const candidates = trades.filter(t =>
    t.outcome === null &&
    t.signalResult == null &&
    t.tookBy &&
    t.conditionId &&
    t.parsed?.date,
  );

  if (candidates.length === 0) return false;

  console.log(`[exit-monitor] checking ${candidates.length} open trade(s)`);

  let dirty = false;

  for (const trade of candidates) {
    const idx = trades.indexOf(trade);

    let result;
    try {
      result = await checkTrade(trade);
    } catch (err) {
      console.error(`[exit-monitor] ${trade.id} price fetch error:`, err.message);
      continue;
    }

    if (!result) {
      console.log(`[exit-monitor] ${trade.id} — no live price, skipping`);
      continue;
    }

    const { exitReason, peakPrice, currentPrice } = result;

    // Always persist peak price (trailing stop needs it across runs)
    if (peakPrice !== trade.peakPrice) {
      trades[idx].peakPrice = peakPrice;
      dirty = true;
    }

    if (!exitReason) {
      console.log(`[exit-monitor] ${trade.id} — ${cents(currentPrice)} — no exit triggered`);
      continue;
    }

    // --- Auto-close the paper trade ----------------------------------------
    const pnl = result.pnlDollars;
    trades[idx].signalResult = pnl != null && pnl >= 0 ? 'win' : 'loss';
    trades[idx].pnlDollars   = pnl;
    trades[idx].closedAt     = new Date().toISOString();
    trades[idx].closedBy     = 'exit-monitor';
    trades[idx].outcome      = exitReason;
    dirty = true;

    console.log(`[exit-monitor] AUTO-CLOSED ${trade.id}: ${exitReason} @ ${cents(currentPrice)} | P&L ${pnl != null ? '$' + pnl.toFixed(2) : 'N/A'}`);

    try {
      await postExitCard(trade, result);
    } catch (err) {
      console.error(`[exit-monitor] ${trade.id} Discord post error:`, err.message);
    }
  }

  return dirty;
}

module.exports = { autoExit };

// ---------------------------------------------------------------------------
// Standalone entry point (node scripts/weather/exit-monitor.js)
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const trades = readTrades();
    const dirty  = await autoExit(trades);
    if (dirty) writeTrades(trades);
  })().catch(err => {
    console.error('[exit-monitor] fatal:', err.message);
    process.exit(1);
  });
}
