'use strict';

/**
 * discord-bot/router.js — Channel-to-handler mapping
 *
 * Routes incoming Discord messages to the correct instrument handler
 * based on channel name prefix. Adding a new instrument = 2 lines here.
 *
 * Convention: channel names must start with the instrument prefix.
 *   btc-signals, btc-backtest, btc-weekly-war-report → btc handler
 *   #bz-signals, #bz-backtest, #bz-weekly-war-report → bz handler
 */

const btcHandler       = require('./handlers/btc');
const bzHandler        = require('./handlers/bz');
const polyBtc5Handler  = require('./handlers/poly-btc-5');
const polyBtc15Handler = require('./handlers/poly-btc-15');
const sharedHandler    = require('./handlers/shared');

// Map of channel name prefix → handler module
// Order matters: first match wins. More-specific prefixes must come before shorter ones.
const ROUTES = [
  { prefix: 'bz',          handler: bzHandler        },
  { prefix: 'btc',         handler: btcHandler       },
  { prefix: 'poly-btc-5',  handler: polyBtc5Handler  },
  { prefix: 'poly-btc-15', handler: polyBtc15Handler },
  { prefix: 'poly-btc',    handler: polyBtc5Handler  },  // fallback → btc-5
];

/**
 * Resolve the correct handler for a given channel name.
 * Falls back to sharedHandler for commands that work in any channel (!stop, !start).
 *
 * @param {string} channelName  e.g. "#bz-signals", "btc-signals"
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
  if (process.env.DISCORD_CHANNEL_ID)                   ids.push({ id: process.env.DISCORD_CHANNEL_ID,                   prefix: 'btc' });
  if (process.env.DISCORD_BTC_WAR_REPORT_CHANNEL_ID)    ids.push({ id: process.env.DISCORD_BTC_WAR_REPORT_CHANNEL_ID,    prefix: 'btc' });
  if (process.env.DISCORD_BTC_BACKTEST_CHANNEL_ID)      ids.push({ id: process.env.DISCORD_BTC_BACKTEST_CHANNEL_ID,      prefix: 'btc' });
  if (process.env.BZ_DISCORD_SIGNALS_CHANNEL_ID)            ids.push({ id: process.env.BZ_DISCORD_SIGNALS_CHANNEL_ID,            prefix: 'bz' });
  if (process.env.BZ_DISCORD_WAR_REPORT_CHANNEL_ID)         ids.push({ id: process.env.BZ_DISCORD_WAR_REPORT_CHANNEL_ID,         prefix: 'bz' });
  if (process.env.BZ_DISCORD_BACKTEST_CHANNEL_ID)           ids.push({ id: process.env.BZ_DISCORD_BACKTEST_CHANNEL_ID,           prefix: 'bz' });
  if (process.env.POLY_BTC_5_SIGNALS_CHANNEL_ID)            ids.push({ id: process.env.POLY_BTC_5_SIGNALS_CHANNEL_ID,            prefix: 'poly-btc-5'  });
  if (process.env.POLY_BTC_5_REPORT_CHANNEL_ID)             ids.push({ id: process.env.POLY_BTC_5_REPORT_CHANNEL_ID,             prefix: 'poly-btc-5'  });
  if (process.env.POLY_BTC_15_SIGNALS_CHANNEL_ID)           ids.push({ id: process.env.POLY_BTC_15_SIGNALS_CHANNEL_ID,           prefix: 'poly-btc-15' });
  if (process.env.POLY_BTC_15_REPORT_CHANNEL_ID)            ids.push({ id: process.env.POLY_BTC_15_REPORT_CHANNEL_ID,            prefix: 'poly-btc-15' });
  return ids;
}

module.exports = { resolve, allChannelIds };
