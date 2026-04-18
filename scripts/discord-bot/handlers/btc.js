'use strict';

/**
 * handlers/btc.js — All BTC channel commands
 *
 * Delegates to the existing BTC scripts (untouched):
 *   mtf-analyze.js  — full MTF analysis
 *   weekly-report.js / weekly-war-report.js — reports
 *
 * Commands:
 *   !analyze / !mtf   — run MTF analysis
 *   !trades           — list open/recent signals
 *   !took <id>        — log personal entry on a signal
 *   !exit <outcome>   — log exit
 *   !status           — post system briefing to #general
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT }      = require('../../lib/env');

const ANALYZE_SCRIPT = path.join(ROOT, 'scripts', 'mtf-analyze.js');
const NOTIFY_SH      = path.join(ROOT, 'scripts', 'discord-notify.sh');
const TRADES_FILE    = path.join(ROOT, 'trades.json');
const MY_TRADES_FILE = path.join(ROOT, 'my-trades.json');
const NODE           = process.execPath;

function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE,    'utf8')); } catch { return []; } }
function readMyTrades() { try { return JSON.parse(fs.readFileSync(MY_TRADES_FILE, 'utf8')); } catch { return []; } }
function writeMyTrades(t) { try { fs.writeFileSync(MY_TRADES_FILE, JSON.stringify(t, null, 2)); } catch {} }

function notify(type, message) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  try { spawnSync('bash', [NOTIFY_SH, type, message], { stdio: 'pipe', encoding: 'utf8' }); } catch {}
}

function runAnalysis() {
  const result = spawnSync(NODE, [ANALYZE_SCRIPT, '--print'], { encoding: 'utf8', timeout: 90_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'mtf-analyze exited non-zero');
  return result.stdout?.trim();
}

async function handle(message, api) {
  const text = (message.content || '').trim();
  const user = message.author?.username || 'unknown';
  const args = text.split(/\s+/).slice(1);

  if (/^!analyze\b|^!mtf\b/i.test(text)) { await handleAnalyze(user, api); return true; }
  if (/^!trades\b/i.test(text))           { await handleTrades(user, api);   return true; }
  if (/^!took\b/i.test(text))             { await handleTook(user, args, api); return true; }
  if (/^!exit\b/i.test(text))             { await handleExit(user, args, api); return true; }
  if (/^!status\b/i.test(text))           { await handleStatus(user, api);   return true; }
  return false;
}

async function handleAnalyze(user, api) {
  await api.sendTyping();
  notify('info', `🔄 **MTF analysis triggered by ${user}**\nRunning 12H→4H→1H→30M sweep...`);

  let report;
  try {
    report = runAnalysis();
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

async function handleTook(user, args, api) {
  await api.sendMessage('⏸️ **!took** — activates once Phase 1 BTC data is validated. Run `!trades` to see open signals.');
}

async function handleExit(user, args, api) {
  await api.sendMessage('⏸️ **!exit** — activates once Phase 1 BTC data is validated.');
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
      `**#bz!-signals** — Live alerts + \`!analyze [context]\` manual trigger`,
      `**#bz!-weekly-war-report** — Sunday 5pm ET + \`!report\` manual trigger`,
      `**#bz!-backtest** — Auto-logged signals + \`!took\` / \`!exit\` outcome tracking`,
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
