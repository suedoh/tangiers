'use strict';

/**
 * handlers/poly-btc-15.js — Polymarket BTC 15-min signal commands
 *
 * Commands:
 *   !analyze  — on-demand 15M→5M→1H sweep, post current bar score
 *   !trades   — list last 20 evaluations (prediction, score, outcome, correct)
 *   !report   — generate weekly performance report immediately
 *   !status   — one-line current score for the live bar
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync }   = require('child_process');
const { ROOT }        = require('../../lib/env');
const { postWebhook } = require('../../lib/discord');

const ANALYZE_SCRIPT = path.join(ROOT, 'scripts', 'poly', 'btc-15', 'analyze.js');
const REPORT_SCRIPT  = path.join(ROOT, 'scripts', 'poly', 'btc-15', 'weekly-report.js');
const TRADES_FILE    = path.join(ROOT, 'poly-btc-15-trades.json');
const SIGNALS_HOOK   = process.env.POLY_BTC_15_SIGNALS_WEBHOOK;
const NODE           = process.execPath;

function readTrades() { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } }

async function handle(message, api) {
  const text = (message.content || '').trim();
  const user = message.author?.username || 'unknown';

  if (/^!analyze\b/i.test(text)) { await handleAnalyze(user, api); return true; }
  if (/^!trades\b/i.test(text))  { await handleTrades(user, api);  return true; }
  if (/^!report\b/i.test(text))  { await handleReport(user, api);  return true; }
  if (/^!status\b/i.test(text))  { await handleStatus(user, api);  return true; }

  return false;
}

// ─── !analyze ────────────────────────────────────────────────────────────────

async function handleAnalyze(user, api) {
  await api.sendTyping();
  await api.sendMessage(`🔄 **Poly BTC-15 analysis triggered by ${user}**\nRunning 15M→5M→1H sweep... (~15 seconds)`);

  const result = spawnSync(NODE, [ANALYZE_SCRIPT, '--source', `Manual | ${user}`], {
    encoding: 'utf8',
    timeout:  90_000,
  });

  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    if (SIGNALS_HOOK) {
      await postWebhook(SIGNALS_HOOK, 'error',
        `❌ **Poly BTC-15 analysis failed** (${user})\n**Error:** ${err}\n**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout.`,
        'Poly BTC-15 • Error');
    }
  }
  // analyze.js posts its own Discord card
}

// ─── !trades ─────────────────────────────────────────────────────────────────

async function handleTrades(user, api) {
  const trades = readTrades();
  const last20 = trades.slice(-20).reverse();

  if (last20.length === 0) {
    await api.sendMessage('No evaluations logged yet. System starts recording from the next bar.');
    return;
  }

  const totalResolved  = trades.filter(t => t.signaled && t.outcome).length;
  const totalCorrect   = trades.filter(t => t.signaled && t.correct).length;
  const winRateLine    = totalResolved > 0
    ? `Overall win rate: **${(100 * totalCorrect / totalResolved).toFixed(1)}%** (${totalCorrect}/${totalResolved})`
    : 'No resolved trades yet';

  const rows = last20.map(t => {
    const time    = t.barOpen.slice(11, 16) + ' UTC';
    const signal  = t.signaled ? `${t.prediction} (${t.score}/6)` : `– (${t.score}/6)`;
    const outcome = t.outcome || '⏳';
    const result  = t.outcome == null ? '' : t.correct ? '✓' : '✗';
    return `\`${time}\`  ${signal.padEnd(12)}  ${outcome}  ${result}`;
  });

  const lines = [
    `📊 **Poly BTC-15 — Last ${last20.length} bars**`,
    winRateLine,
    '',
    '`Time      Signal       Outcome`',
    ...rows,
  ];

  await api.sendMessage(lines.join('\n'));
}

// ─── !report ─────────────────────────────────────────────────────────────────

async function handleReport(user, api) {
  await api.sendTyping();
  await api.sendMessage(`🔄 **Poly BTC-15 weekly report triggered by ${user}**`);

  const result = spawnSync(NODE, [REPORT_SCRIPT, '--force'], {
    encoding: 'utf8',
    timeout:  30_000,
  });

  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    await api.sendMessage(`❌ **Report failed:** ${err}`);
  }
  // weekly-report.js posts its own Discord card
}

// ─── !status ─────────────────────────────────────────────────────────────────

async function handleStatus(user, api) {
  const trades = readTrades();
  if (trades.length === 0) {
    await api.sendMessage('⚪ No bars logged yet. System is running.');
    return;
  }

  const last        = trades[trades.length - 1];
  const now         = new Date();
  const barMinute   = Math.floor(now.getUTCMinutes() / 15) * 15;
  const currentBar  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), barMinute, 0)).toISOString();
  const isThisBar   = last.barOpen === currentBar;

  const total    = trades.filter(t => t.signaled && t.outcome).length;
  const correct  = trades.filter(t => t.signaled && t.correct).length;
  const winLine  = total > 0 ? ` · Win rate: **${(100 * correct / total).toFixed(1)}%** (${correct}/${total})` : '';

  if (isThisBar && last.signaled) {
    await api.sendMessage([
      `${last.direction === 'UP' ? '🟢' : '🔴'} **Current bar:** ${last.prediction} ${last.direction === 'UP' ? '↑' : '↓'} | Score ${last.score}/6${winLine}`,
      `Bar: ${last.barOpen.slice(11, 16)} UTC | Awaiting outcome at close`,
    ].join('\n'));
  } else if (isThisBar) {
    await api.sendMessage(`⚪ **Current bar:** evaluated, score ${last.score}/6 (below threshold — no signal)${winLine}`);
  } else {
    await api.sendMessage(`⚪ **Last bar:** ${last.barOpen.slice(11, 16)} UTC | Next evaluation in ${Math.floor(15 - now.getUTCMinutes() % 15) - 1}min${winLine}`);
  }
}

module.exports = { handle };
