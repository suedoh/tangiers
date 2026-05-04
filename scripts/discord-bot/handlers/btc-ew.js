'use strict';

/**
 * handlers/btc-ew.js — #btc-ew-signals channel commands
 *
 * Delegates to scripts/ew/run.js with --manual flag. The Discord embed
 * + screenshot upload + storage write all happen inside run.js so this
 * handler is intentionally thin.
 *
 * Commands:
 *   !ew  — run on-demand EW analysis pass; posts result back to this channel
 *
 * The bot listens here because BTC_EW_SIGNALS_CHANNEL_ID is registered in
 * router.js. !ew is a long-running command (~30s for the 1D/4H/1H sweep
 * + screenshots), so we spawn run.js in detached mode and return
 * immediately after a "starting" notice — same UX pattern as !analyze.
 */

const path = require('path');
const { spawn } = require('child_process');
const { ROOT } = require('../../lib/env');

const RUN_SCRIPT = path.join(ROOT, 'scripts', 'ew', 'run.js');
const NODE       = process.execPath;

async function handle(message, api) {
  const text = (message.content || '').trim();

  if (/^!ew\b/i.test(text)) {
    await handleEw(message, api);
    return true;
  }
  return false;
}

async function handleEw(message, api) {
  const user = message.author?.username || 'unknown';
  await api.sendTyping();

  // Quick acknowledgement so the user knows it's running
  try {
    await api.send(`🌊 **EW analysis triggered by ${user}** — running 1D → 4H → 1H sweep, ~30s. Result will post here.`);
  } catch {}

  // Spawn detached so the bot doesn't block on the long-running CDP work
  const child = spawn(NODE, [RUN_SCRIPT, '--manual', `--user=${user}`], {
    cwd: ROOT,
    detached: true,
    stdio:    'ignore',
    env:      process.env,
  });
  child.unref();
}

module.exports = { handle };
