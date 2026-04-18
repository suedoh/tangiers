'use strict';

/**
 * handlers/bz.js — All BZ! channel commands
 *
 * Commands:
 *   !analyze [context]  — run full MTF analysis with optional context string
 *   !report             — generate weekly war report immediately
 *   !trades             — list open/recent BZ signals
 *   !took               — confirm you entered a signal
 *   !take <price>       — log partial close at TP
 *   !exit <outcome>     — log full exit
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT }      = require('../../lib/env');
const { postWebhook } = require('../../lib/discord');

const ANALYZE_SCRIPT = path.join(ROOT, 'scripts', 'bz', 'analyze.js');
const REPORT_SCRIPT  = path.join(ROOT, 'scripts', 'bz', 'weekly-report.js');
const TRADES_FILE    = path.join(ROOT, 'bz-trades.json');
const MY_TRADES_FILE = path.join(ROOT, 'bz-my-trades.json');
const BACKTEST_HOOK  = process.env.BZ_DISCORD_BACKTEST_WEBHOOK;
const SIGNALS_HOOK   = process.env.BZ_DISCORD_SIGNALS_WEBHOOK;
const NODE           = process.execPath;

function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE,    'utf8')); } catch { return []; } }
function readMyTrades() { try { return JSON.parse(fs.readFileSync(MY_TRADES_FILE, 'utf8')); } catch { return []; } }
function writeMyTrades(t) { try { fs.writeFileSync(MY_TRADES_FILE, JSON.stringify(t, null, 2)); } catch {} }
function writeTrades(t)   { try { fs.writeFileSync(TRADES_FILE,    JSON.stringify(t, null, 2)); } catch {} }

async function handle(message, api) {
  const text = (message.content || '').trim();
  const user = message.author?.username || 'unknown';
  const args = text.split(/\s+/).slice(1);

  // !analyze [optional context text]
  if (/^!analyze\b/i.test(text)) {
    const context = text.replace(/^!analyze\s*/i, '').trim();
    await handleAnalyze(user, context, api);
    return true;
  }

  if (/^!report\b/i.test(text))          { await handleReport(user, api);           return true; }
  if (/^!trades\b/i.test(text))          { await handleTrades(user, api);           return true; }
  if (/^!took\b/i.test(text))            { await handleTook(user, args, api);       return true; }
  if (/^!take\b/i.test(text))            { await handleTake(user, args, api);       return true; }
  if (/^!exit\b/i.test(text))            { await handleExit(user, args, api);       return true; }

  return false;
}

// ─── !analyze ────────────────────────────────────────────────────────────────

async function handleAnalyze(user, context, api) {
  await api.sendTyping();

  const contextDisplay = context ? `"${context}"` : '*(no context — pure technical read)*';
  await api.sendMessage([
    `🔄 **BZ! Analysis triggered by ${user}**`,
    `Context: ${contextDisplay}`,
    `Running 4H→1H→30M sweep + sentiment classification... (~20 seconds)`,
  ].join('\n'));

  const args = [ANALYZE_SCRIPT, '--source', `Manual | ${user}`];
  if (context) args.push('--context', context);

  const result = spawnSync(NODE, args, { encoding: 'utf8', timeout: 120_000 });

  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    if (SIGNALS_HOOK) {
      await postWebhook(SIGNALS_HOOK, 'error',
        `❌ **BZ Analysis failed** (triggered by ${user})\n**Error:** ${err}\n**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout.`,
        'BZ! • Analysis Error');
    }
  }
  // analyze.js posts its own Discord card — no need to post here
}

// ─── !report ─────────────────────────────────────────────────────────────────

async function handleReport(user, api) {
  await api.sendTyping();
  await api.sendMessage(`🔄 **BZ! Weekly War Report triggered by ${user}**\nGenerating report... (~20 seconds)`);

  const result = spawnSync(NODE, [REPORT_SCRIPT, '--force'], { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    await api.sendMessage(`❌ **Report failed:** ${err}`);
  }
  // weekly-report.js posts its own Discord card
}

// ─── !trades ─────────────────────────────────────────────────────────────────

async function handleTrades(user, api) {
  const trades = readTrades();
  const open   = trades.filter(t => t.outcome === null);
  const recent = trades
    .filter(t => t.outcome !== null)
    .sort((a, b) => new Date(b.closedAt || b.firedAt) - new Date(a.closedAt || a.firedAt))
    .slice(0, 5);

  if (trades.length === 0) { await api.sendMessage('📭 No BZ! trades logged yet — waiting for first signal.'); return; }

  const lines = [];
  if (open.length) {
    lines.push(`**OPEN BZ! TRADES (${open.length})**`);
    for (const t of open) {
      const age = Math.round((Date.now() - new Date(t.firedAt)) / 3_600_000);
      const dir = t.direction === 'long' ? '🟢' : '🔴';
      lines.push(`${dir} **${t.direction.toUpperCase()}** fired ${t.firedAt.slice(0,10)} (${age}h ago) | Score ${t.score}/6`);
      if (t.entry) lines.push(`  Entry $${t.entry.toFixed(2)} | SL $${t.stop?.toFixed(2)} | TP1 $${t.tp1?.toFixed(2)} | TP2 $${t.tp2?.toFixed(2)} | TP3 $${t.tp3?.toFixed(2)}`);
      if (t.context) lines.push(`  Trigger: "${t.context}"`);
      lines.push(`  ID: \`${t.id}\``);
    }
  } else lines.push('**OPEN BZ! TRADES** — none');

  if (recent.length) {
    lines.push('', `**LAST ${recent.length} CLOSED**`);
    for (const t of recent) {
      const pnl  = t.pnlR != null ? (t.pnlR >= 0 ? `+${t.pnlR.toFixed(2)}R` : `${t.pnlR.toFixed(2)}R`) : '?R';
      const icon = (t.outcome || '').startsWith('tp') ? '✅' : t.outcome === 'stop' ? '❌' : '📋';
      lines.push(`${icon} ${t.direction === 'long' ? '🟢' : '🔴'} ${t.direction.toUpperCase()} ${t.firedAt.slice(0,10)} → **${pnl}** (${t.outcome})`);
    }
  }

  // Win rate
  const closed  = trades.filter(t => t.outcome !== null && t.pnlR != null);
  const wins    = closed.filter(t => t.pnlR > 0);
  if (closed.length > 0) {
    const avgR = closed.reduce((a, t) => a + t.pnlR, 0) / closed.length;
    lines.push('', `*Win rate: ${wins.length}/${closed.length} (${Math.round(100*wins.length/closed.length)}%) | Avg R: ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R*`);
  }

  lines.push('', `*Type \`!took <id>\` to log your entry on a signal.*`);
  await api.sendMessage(lines.join('\n'));
}

// ─── !took ───────────────────────────────────────────────────────────────────

async function handleTook(user, args, api) {
  const tradeId = args[0];
  if (!tradeId) { await api.sendMessage('Usage: `!took <trade-id>` — get the ID from `!trades`'); return; }

  const trades  = readTrades();
  const trade   = trades.find(t => t.id === tradeId);
  if (!trade) { await api.sendMessage(`❌ Trade \`${tradeId}\` not found. Use \`!trades\` to list open signals.`); return; }

  const myTrades = readMyTrades();
  if (myTrades.find(t => t.systemId === tradeId)) {
    await api.sendMessage(`⚠️ You already logged an entry for \`${tradeId}\`.`);
    return;
  }

  const entry = {
    systemId:  tradeId,
    instrument:'BZ',
    direction: trade.direction,
    firedAt:   trade.firedAt,
    tookAt:    new Date().toISOString(),
    tookBy:    user,
    entry:     trade.entry,
    stop:      trade.stop,
    tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3,
    rr1: trade.rr1, rr2: trade.rr2, rr3: trade.rr3,
    partials:  [],
    outcome:   null,
    exitPrice: null,
    pnlR:      null,
    exitAt:    null,
  };

  myTrades.push(entry);
  writeMyTrades(myTrades);

  const confirmCard = [
    `✅ **BZ! Entry Logged — ${trade.direction.toUpperCase()}**`,
    `Entry: $${trade.entry?.toFixed(2)} | SL: $${trade.stop?.toFixed(2)}`,
    `TP1: $${trade.tp1?.toFixed(2)} (${trade.rr1}R) | TP2: $${trade.tp2?.toFixed(2)} (${trade.rr2}R) | TP3: $${trade.tp3?.toFixed(2)} (${trade.rr3}R)`,
    `ID: \`${tradeId}\``,
    `Use \`!take <price>\` to log a partial close, \`!exit tp1|tp2|tp3|stop|manual <price>\` to close fully.`,
  ].join('\n');

  await api.sendMessage(confirmCard);

  if (BACKTEST_HOOK) {
    await postWebhook(BACKTEST_HOOK, 'info',
      `📋 **ENTRY CONFIRMED — BZ! ${trade.direction.toUpperCase()}**\nBy: ${user} | ${new Date().toISOString().slice(0,16)} UTC\nEntry: $${trade.entry?.toFixed(2)} | SL: $${trade.stop?.toFixed(2)}\nID: \`${tradeId}\``,
      `BZ! • Backtest Log`);
  }
}

// ─── !take ───────────────────────────────────────────────────────────────────

async function handleTake(user, args, api) {
  const exitPx = parseFloat(args[0]);
  if (isNaN(exitPx)) { await api.sendMessage('Usage: `!take <price>` — e.g. `!take 94.08`'); return; }

  const myTrades = readMyTrades();
  const open     = myTrades.filter(t => t.outcome === null && t.instrument === 'BZ');
  if (!open.length) { await api.sendMessage('No open BZ! trades. Use `!took <id>` to log an entry first.'); return; }

  const trade = open[open.length - 1]; // most recent open
  const risk  = Math.abs(trade.entry - trade.stop);

  const partialR = trade.direction === 'long'
    ? (exitPx - trade.entry) / risk
    : (trade.entry - exitPx) / risk;

  if (!Array.isArray(trade.partials)) trade.partials = [];
  trade.partials.push({ price: exitPx, at: new Date().toISOString(), pnlR: Math.round(partialR * 100) / 100 });
  writeMyTrades(myTrades);

  const sign = partialR >= 0 ? '+' : '';
  await api.sendMessage(`📊 **BZ! Partial Close Logged**\nPrice: $${exitPx.toFixed(2)} | ${sign}${partialR.toFixed(2)}R\nRunner still active. Use \`!exit\` to fully close.`);

  if (BACKTEST_HOOK) {
    await postWebhook(BACKTEST_HOOK, 'info',
      `✅ **TP HIT — BZ! ${trade.direction.toUpperCase()}**\nEntry: $${trade.entry?.toFixed(2)} → Partial exit: $${exitPx.toFixed(2)} | ${sign}${partialR.toFixed(2)}R\nRunner active.`,
      'BZ! • Backtest Log');
  }
}

// ─── !exit ───────────────────────────────────────────────────────────────────

async function handleExit(user, args, api) {
  const outcome   = args[0]?.toLowerCase();
  const manualPx  = args[1] ? parseFloat(args[1]) : null;
  const valid     = ['tp1', 'tp2', 'tp3', 'stop', 'manual'];

  if (!outcome || !valid.includes(outcome)) {
    await api.sendMessage('Usage: `!exit tp1|tp2|tp3|stop|manual <price>`');
    return;
  }
  if (outcome === 'manual' && isNaN(manualPx)) {
    await api.sendMessage('Usage: `!exit manual <price>` — provide the exit price');
    return;
  }

  const myTrades = readMyTrades();
  const openIdx  = myTrades.map((t, i) => ({ t, i })).filter(({ t }) => t.outcome === null && t.instrument === 'BZ');
  if (!openIdx.length) { await api.sendMessage('No open BZ! trades to exit. Use `!took <id>` to log an entry first.'); return; }

  const { t: trade, i: idx } = openIdx[openIdx.length - 1];
  const exitPrice = outcome === 'manual' ? manualPx
    : outcome === 'tp1'  ? trade.tp1
    : outcome === 'tp2'  ? trade.tp2
    : outcome === 'tp3'  ? trade.tp3
    : trade.stop;

  const risk  = Math.abs(trade.entry - trade.stop);
  const pnlR  = risk > 0
    ? (trade.direction === 'long'
        ? (exitPrice - trade.entry) / risk
        : (trade.entry - exitPrice) / risk)
    : 0;

  myTrades[idx].outcome   = outcome;
  myTrades[idx].exitPrice = exitPrice;
  myTrades[idx].pnlR      = Math.round(pnlR * 100) / 100;
  myTrades[idx].exitAt    = new Date().toISOString();
  writeMyTrades(myTrades);

  // Update system trades file
  const sysTrades = readTrades();
  const sysIdx    = sysTrades.findIndex(t => t.id === trade.systemId);
  if (sysIdx !== -1) {
    sysTrades[sysIdx].outcome   = outcome;
    sysTrades[sysIdx].exitPrice = exitPrice;
    sysTrades[sysIdx].pnlR      = myTrades[idx].pnlR;
    sysTrades[sysIdx].closedAt  = myTrades[idx].exitAt;
    writeTrades(sysTrades);
  }

  const sign    = pnlR >= 0 ? '+' : '';
  const icon    = pnlR >= 0 ? '✅' : '❌';
  const durationMs = new Date(myTrades[idx].exitAt) - new Date(trade.tookAt);
  const durationH  = Math.round(durationMs / 3_600_000);

  const closeCard = [
    `${icon} **BZ! Trade Closed — ${trade.direction.toUpperCase()}**`,
    `Entry: $${trade.entry?.toFixed(2)} → Exit: $${exitPrice?.toFixed(2)}`,
    `P&L: **${sign}${pnlR.toFixed(2)}R** | Outcome: ${outcome}`,
    `Duration: ${durationH}h`,
  ].join('\n');

  await api.sendMessage(closeCard);

  if (BACKTEST_HOOK) {
    await postWebhook(BACKTEST_HOOK, pnlR >= 0 ? 'long' : 'error', closeCard + `\n\nID: \`${trade.systemId}\``, 'BZ! • Backtest Log');
  }
}

module.exports = { handle };
