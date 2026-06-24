'use strict';

/**
 * handlers/blofin.js — BloFin recon channel commands
 *
 * Commands:
 *   !pnl — on-demand P&L report (same format as the 21:00 UTC daily post)
 */

const path                    = require('path');
const { promisify }           = require('util');
const { execFile }            = require('child_process');
const { ROOT }                = require('../../lib/env');

const execFileAsync = promisify(execFile);

const DAILY_PNL_SCRIPT = path.join(ROOT, 'scripts', 'blofin', 'daily-pnl-report.js');
const NODE             = process.execPath;

async function handle(message, api) {
  const text = (message.content || '').trim();
  const user = message.author?.username || 'unknown';

  if (/^!pnl\b/i.test(text)) { await handlePnl(user, api); return true; }
  return false;
}

async function handlePnl(user, api) {
  await api.sendTyping();
  await api.sendMessage(`📊 **P&L report triggered by ${user}** — generating…`);

  try {
    await execFileAsync(NODE, [DAILY_PNL_SCRIPT], { encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    await api.sendMessage([
      `❌ **!pnl failed** (triggered by ${user})`,
      `**Error:** ${e.stderr?.trim() || e.message}`,
    ].join('\n'));
  }
}

module.exports = { handle };
