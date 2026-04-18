'use strict';

/**
 * discord-bot/router.js — Channel-to-handler mapping
 *
 * Routes incoming Discord messages to the correct instrument handler
 * based on channel name prefix. Adding a new instrument = 2 lines here.
 *
 * Convention: channel names must start with the instrument prefix.
 *   btc-signals, btc-backtest, btc-weekly-war-report → btc handler
 *   bz!-signals, bz!-backtest, bz!-weekly-war-report → bz handler
 */

const btcHandler    = require('./handlers/btc');
const bzHandler     = require('./handlers/bz');
const sharedHandler = require('./handlers/shared');

// Map of channel name prefix → handler module
// Order matters: first match wins
const ROUTES = [
  { prefix: 'bz',  handler: bzHandler  },
  { prefix: 'btc', handler: btcHandler },
];

/**
 * Resolve the correct handler for a given channel name.
 * Falls back to sharedHandler for commands that work in any channel (!stop, !start).
 *
 * @param {string} channelName  e.g. "bz!-signals", "btc-signals"
 * @returns {object}            Handler module with a handle(message, client) method
 */
function resolve(channelName) {
  const name = (channelName || '').toLowerCase();
  const route = ROUTES.find(r => name.startsWith(r.prefix));
  return route ? route.handler : sharedHandler;
}

/**
 * Return all channel IDs that the bot should poll.
 * Reads from env — each instrument registers its own channel ID.
 */
function allChannelIds() {
  const ids = [];
  if (process.env.DISCORD_CHANNEL_ID)     ids.push({ id: process.env.DISCORD_CHANNEL_ID,     prefix: 'btc' });
  if (process.env.BZ_DISCORD_SIGNALS_CHANNEL_ID) ids.push({ id: process.env.BZ_DISCORD_SIGNALS_CHANNEL_ID, prefix: 'bz' });
  return ids;
}

module.exports = { resolve, allChannelIds };
