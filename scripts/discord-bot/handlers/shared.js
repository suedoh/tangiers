'use strict';

/**
 * handlers/shared.js — Commands that work in any channel
 *   !stop   — pause all Discord notifications
 *   !start  — resume notifications
 */

const fs   = require('fs');
const path = require('path');
const { ROOT } = require('../../lib/env');

const PAUSE_FILE = path.join(ROOT, '.discord-paused');

async function handle(message, api) {
  const text = (message.content || '').trim();
  const user = message.author?.username || 'unknown';

  if (/^!stop\b/i.test(text))  { await handleStop(user, api);  return true; }
  if (/^!start\b/i.test(text)) { await handleStart(user, api); return true; }

  return false; // not handled
}

async function handleStop(user, api) {
  fs.writeFileSync(PAUSE_FILE, JSON.stringify({ pausedAt: new Date().toISOString(), by: user }, null, 2));
  await api.sendMessage(`⏸️ **Ace notifications paused** by **${user}**\nAll signals, alerts, and errors are now suppressed.\nType \`!start\` to resume.`);
}

async function handleStart(user, api) {
  const wasPaused = fs.existsSync(PAUSE_FILE);
  if (wasPaused) fs.unlinkSync(PAUSE_FILE);
  await api.sendMessage(`▶️ **Ace notifications resumed** by **${user}**\n${wasPaused ? 'Signals, alerts, and errors will now post normally.' : 'System was already running — no change.'}`);
}

module.exports = { handle };
