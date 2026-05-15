'use strict';

/**
 * handlers/btc.js — All BTC channel commands
 *
 * Delegates to the existing BTC scripts (untouched):
 *   mtf-analyze.js  — full MTF analysis
 *   weekly-report.js / weekly-war-report.js — reports
 *
 * Commands:
 *   !analyze / !mtf      — run MTF analysis
 *   !trades              — list open/recent signals
 *   !backtest [days]     — run performance stats report (default 7 days) → #btc-backtest
 *   !took <id>           — log personal entry on a signal
 *   !exit <outcome>      — log exit
 *   !status              — post system briefing to #general
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { promisify }           = require('util');
const { ROOT }                = require('../../lib/env');
const { postWebhook }         = require('../../lib/discord');

const execFileAsync = promisify(execFile);

const ANALYZE_SCRIPT     = path.join(ROOT, 'scripts', 'mtf-analyze.js');
const WAR_REPORT_SCRIPT  = path.join(ROOT, 'scripts', 'weekly-war-report.js');
const WEEKLY_REPORT_SCRIPT = path.join(ROOT, 'scripts', 'weekly-report.js');
const NOTIFY_SH          = path.join(ROOT, 'scripts', 'discord-notify.sh');
const TRADES_FILE        = path.join(ROOT, 'trades.json');
const MY_TRADES_FILE     = path.join(ROOT, 'my-trades.json');
const NODE               = process.execPath;

function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE,    'utf8')); } catch { return []; } }
function readMyTrades() { try { return JSON.parse(fs.readFileSync(MY_TRADES_FILE, 'utf8')); } catch { return []; } }
function writeMyTrades(t) { try { fs.writeFileSync(MY_TRADES_FILE, JSON.stringify(t, null, 2)); } catch {} }

function notify(type, message) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  try { spawnSync('bash', [NOTIFY_SH, type, message], { stdio: 'pipe', encoding: 'utf8' }); } catch {}
}

async function runAnalysis() {
  const { stdout } = await execFileAsync(NODE, [ANALYZE_SCRIPT, '--print'], { encoding: 'utf8', timeout: 90_000 });
  return stdout?.trim();
}

async function handle(message, api) {
  const text = (message.content || '').trim();
  const user = message.author?.username || 'unknown';
  const args = text.split(/\s+/).slice(1);

  if (/^!analyze\b|^!mtf\b/i.test(text)) { await handleAnalyze(user, api);        return true; }
  if (/^!report\b/i.test(text))          { await handleReport(user, api);         return true; }
  if (/^!backtest\b/i.test(text))        { await handleBacktest(user, args, api); return true; }
  if (/^!trades\b/i.test(text))          { await handleTrades(user, api);         return true; }
  if (/^!took\b/i.test(text))            { await handleTook(user, args, api);     return true; }
  if (/^!exit\b/i.test(text))            { await handleExit(user, args, api);     return true; }
  if (/^!status\b/i.test(text))          { await handleStatus(user, api);         return true; }
  return false;
}

async function handleAnalyze(user, api) {
  await api.sendTyping();
  notify('info', `🔄 **MTF analysis triggered by ${user}**\nRunning 12H→4H→1H→30M sweep...`);

  let report;
  try {
    report = await runAnalysis();
  } catch (e) {
    notify('error', [
      `❌ **MTF Analysis failed** (triggered by ${user})`,
      `**Error:** ${e.message}`,
      `**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout with BINANCE:BTCUSDT.P`,
    ].join('\n'));
    return;
  }

  if (!report) { notify('error', `❌ MTF Analysis returned empty output (triggered by ${user})`); return; }

  const vType = report.includes('🟢') ? 'long'
              : report.includes('🔴') ? 'short'
              : report.includes('⚠️') ? 'approaching'
              : 'info';
  notify(vType, report);
}

async function handleTrades(user, api) {
  const trades = readTrades();
  const open   = trades.filter(t => t.outcome === null);
  const recent = trades.filter(t => t.outcome !== null && t.outcome !== 'expired')
    .sort((a, b) => new Date(b.closedAt || b.firedAt) - new Date(a.closedAt || a.firedAt))
    .slice(0, 5);

  if (trades.length === 0) { await api.sendMessage('📭 No BTC trades logged yet.'); return; }

  const lines = [];
  if (open.length) {
    lines.push(`**OPEN TRADES (${open.length})**`);
    for (const t of open) {
      const age  = Math.round((Date.now() - new Date(t.firedAt)) / 3_600_000);
      const conf = t.confirmed ? `✅ confirmed` : '⏳ awaiting confirmation';
      const dir  = t.direction === 'long' ? '🟢' : '🔴';
      lines.push(`${dir} **${t.zone?.type ?? '?'} ${t.direction.toUpperCase()}** fired ${t.firedAt.slice(0,10)} (${age}h ago)`);
      lines.push(`  Entry $${t.entry?.toLocaleString()} | SL $${t.stop?.toLocaleString()} | TP1 $${t.tp1?.toLocaleString()} | ${conf}`);
      lines.push(`  ID: \`${t.id}\``);
    }
  } else lines.push('**OPEN TRADES** — none');

  if (recent.length) {
    lines.push('', `**LAST ${recent.length} CLOSED**`);
    for (const t of recent) {
      const pnl  = t.pnlR != null ? (t.pnlR >= 0 ? `+${t.pnlR.toFixed(2)}R` : `${t.pnlR.toFixed(2)}R`) : '?R';
      const icon = t.outcome?.startsWith('tp') ? '✅' : '❌';
      lines.push(`${icon} ${t.direction === 'long' ? '🟢' : '🔴'} ${t.zone?.type ?? '?'} ${t.direction.toUpperCase()} ${t.firedAt.slice(0,10)} → **${pnl}** (${t.outcome})`);
    }
  }

  lines.push('', `*Total: ${trades.length} | Use \`!took <id>\` to log your entry*`);
  await api.sendMessage(lines.join('\n'));
}

async function handleReport(user, api) {
  await api.sendTyping();
  notify('info', `📊 **BTC Weekly War Report triggered by ${user}**\nGenerating report (~20 seconds)...`);

  try {
    await execFileAsync(NODE, [WAR_REPORT_SCRIPT, '--force'], { encoding: 'utf8', timeout: 120_000 });
  } catch (e) {
    notify('error', [
      `❌ **War Report failed** (triggered by ${user})`,
      `**Error:** ${e.stderr?.trim() || e.message}`,
      `**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout`,
    ].join('\n'));
    return;
  }
  // Report posts itself to Discord — just confirm to the triggering channel
  await api.sendMessage(`✅ Weekly War Report generated by **${user}** and posted to **#btc-weekly-war-report**`);
}

async function handleBacktest(user, args, api) {
  const days = parseInt(args[0], 10);
  const lookback = (days > 0 && days <= 365) ? days : 7;

  await api.sendTyping();
  notify('info', `📈 **BTC Backtest triggered by ${user}**\nRunning ${lookback}-day stats report...`);

  try {
    await execFileAsync(NODE, [WEEKLY_REPORT_SCRIPT, '--days', String(lookback)], { encoding: 'utf8', timeout: 30_000 });
  } catch (e) {
    notify('error', [
      `❌ **Backtest failed** (triggered by ${user})`,
      `**Error:** ${e.stderr?.trim() || e.message}`,
    ].join('\n'));
    return;
  }
  await api.sendMessage(`✅ **${lookback}-day backtest** generated by **${user}** and posted to **#btc-backtest**`);
}

// ─── !took ───────────────────────────────────────────────────────────────────
// Logs that YOU entered a signal — adds an entry to my-trades.json.
// Does NOT modify trades.json; the system continues to auto-track outcomes
// on every signal. The weekly report compares your execution vs the system.

async function handleTook(user, args, api) {
  const tradeId = args[0];
  if (!tradeId) { await api.sendMessage('Usage: `!took <trade-id>` — get the ID from `!trades`'); return; }

  const trades = readTrades();
  const trade  = trades.find(t => t.id === tradeId);
  if (!trade) { await api.sendMessage(`❌ Trade \`${tradeId}\` not found. Use \`!trades\` to list open signals.`); return; }

  // Stale-signal guard: don't allow taking a signal more than 24h old
  const ageH = (Date.now() - new Date(trade.firedAt).getTime()) / 3_600_000;
  if (ageH > 24) {
    await api.sendMessage(`⚠️ Signal \`${tradeId}\` is ${Math.round(ageH)}h old — too stale to log as a new entry.`);
    return;
  }

  const myTrades = readMyTrades();
  if (myTrades.find(t => t.systemId === tradeId)) {
    await api.sendMessage(`⚠️ You already logged an entry for \`${tradeId}\`.`);
    return;
  }

  const entry = {
    systemId:    tradeId,
    instrument:  'BTC',
    direction:   trade.direction,
    setupType:   trade.setupType,
    firedAt:     trade.firedAt,
    tookAt:      new Date().toISOString(),
    tookBy:      user,
    entry:       trade.entry,
    stop:        trade.stop,
    tp1: trade.tp1, tp2: trade.tp2, tp3: trade.tp3,
    rr1: trade.rr1, rr2: trade.rr2, rr3: trade.rr3,
    outcome:     null,
    exitPrice:   null,
    pnlR:        null,
    exitAt:      null,
  };

  myTrades.push(entry);
  writeMyTrades(myTrades);

  const card = [
    `✅ **BTC Entry Logged — ${trade.direction.toUpperCase()}** (${trade.setupType})`,
    `Entry: $${trade.entry?.toLocaleString()} | SL: $${trade.stop?.toLocaleString()}`,
    `TP1: $${trade.tp1?.toLocaleString()} (${trade.rr1}R) | TP2: $${trade.tp2?.toLocaleString()} (${trade.rr2}R) | TP3: $${trade.tp3?.toLocaleString()} (${trade.rr3}R)`,
    `ID: \`${tradeId}\``,
    `Use \`!exit tp1|tp2|tp3|stop|manual <price>\` to close.`,
  ].join('\n');
  await api.sendMessage(card);

  const backtestHook = process.env.DISCORD_BTC_BACKTEST_WEBHOOK_URL;
  if (backtestHook) {
    await postWebhook(backtestHook, 'info',
      `📋 **ENTRY CONFIRMED — BTC ${trade.direction.toUpperCase()}**\nBy: ${user} | ${new Date().toISOString().slice(0,16)} UTC\nEntry: $${trade.entry?.toLocaleString()} | SL: $${trade.stop?.toLocaleString()}\nID: \`${tradeId}\``,
      'BTC • Backtest Log');
  }
}

// ─── !exit ───────────────────────────────────────────────────────────────────
// Records your exit. Only writes to my-trades.json; trades.json is untouched
// because the system auto-tracks outcomes on the full signal set.

async function handleExit(user, args, api) {
  const outcome  = args[0]?.toLowerCase();
  const manualPx = args[1] ? parseFloat(args[1]) : null;
  const valid    = ['tp1', 'tp2', 'tp3', 'stop', 'manual'];
  if (!outcome || !valid.includes(outcome)) {
    await api.sendMessage('Usage: `!exit tp1|tp2|tp3|stop|manual <price>`');
    return;
  }
  if (outcome === 'manual' && (manualPx == null || isNaN(manualPx))) {
    await api.sendMessage('Usage: `!exit manual <price>` — provide the exit price');
    return;
  }

  const myTrades = readMyTrades();
  const open = myTrades.map((t, i) => ({ t, i })).filter(({ t }) => t.outcome === null && t.instrument === 'BTC');
  if (!open.length) { await api.sendMessage('No open BTC trades to exit. Use `!took <id>` to log an entry first.'); return; }

  const { t: trade, i: idx } = open[open.length - 1]; // most recent open
  const exitPrice = outcome === 'manual' ? manualPx
    : outcome === 'tp1' ? trade.tp1
    : outcome === 'tp2' ? trade.tp2
    : outcome === 'tp3' ? trade.tp3
    : trade.stop;

  const risk = Math.abs(trade.entry - trade.stop);
  const pnlR = risk > 0
    ? (trade.direction === 'long'
        ? (exitPrice - trade.entry) / risk
        : (trade.entry - exitPrice) / risk)
    : 0;

  myTrades[idx].outcome   = outcome;
  myTrades[idx].exitPrice = exitPrice;
  myTrades[idx].pnlR      = Math.round(pnlR * 100) / 100;
  myTrades[idx].exitAt    = new Date().toISOString();
  writeMyTrades(myTrades);

  const sign = pnlR >= 0 ? '+' : '';
  const icon = pnlR >= 0 ? '✅' : '❌';
  const durationH = Math.round((new Date(myTrades[idx].exitAt) - new Date(trade.tookAt)) / 3_600_000);

  const card = [
    `${icon} **BTC Trade Closed — ${trade.direction.toUpperCase()}**`,
    `Entry: $${trade.entry?.toLocaleString()} → Exit: $${exitPrice?.toLocaleString()}`,
    `P&L: **${sign}${pnlR.toFixed(2)}R** | Outcome: ${outcome}`,
    `Duration: ${durationH}h`,
  ].join('\n');
  await api.sendMessage(card);

  const backtestHook = process.env.DISCORD_BTC_BACKTEST_WEBHOOK_URL;
  if (backtestHook) {
    await postWebhook(backtestHook, pnlR >= 0 ? 'long' : 'error',
      card + `\n\nID: \`${trade.systemId}\``,
      'BTC • Backtest Log');
  }
}

async function handleStatus(user, api) {
  const helperWebhook = process.env.DISCORD_HELPER;
  if (!helperWebhook) { await api.sendMessage('❌ `DISCORD_HELPER` webhook not configured in `.env`'); return; }

  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const msgs = [
    [
      `🤖 **Ace Trading System v1.1.0** — Multi-Instrument`,
      SEP,
      `**BTC** — BINANCE:BTCUSDT.P | Zone proximity → full trade plan → 30M confirmation`,
      `**BZ!** — NYMEX:BZ1! | Session-aware (1-min active) | AIS + RSS news monitoring | Catalyst alerts`,
    ].join('\n'),
    [
      `📡 **BZ! Channels**`,
      SEP,
      `**##bz-signals** — Live alerts + \`!analyze [context]\` manual trigger`,
      `**##bz-weekly-war-report** — Sunday 5pm ET + \`!report\` manual trigger`,
      `**##bz-backtest** — Auto-logged signals + \`!took\` / \`!exit\` outcome tracking`,
    ].join('\n'),
  ];

  const { postRaw } = require('../../lib/discord');
  for (const content of msgs) {
    await postRaw(helperWebhook, content);
    await new Promise(r => setTimeout(r, 600));
  }
  await api.sendMessage(`📬 Status posted to **#general** by **${user}**`);
}

module.exports = { handle };
