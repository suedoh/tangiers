#!/usr/bin/env node
'use strict';

/**
 * discord-bot/index.js — Ace Trading System multi-channel bot
 *
 * Polls all registered Discord channels every minute (via crontab).
 * Routes incoming messages to the correct instrument handler.
 * Scans for 📊 reactions on signal messages and re-triggers analysis.
 *
 * Adding a new instrument: one handler file + two lines in router.js.
 * This file never changes.
 *
 * Crontab entry (add once):
 *   * * * * * node /Users/vpm/trading/scripts/discord-bot/index.js >> /Users/vpm/trading/logs/discord-bot.log 2>&1
 */

const https  = require('https');
const dns    = require('dns');
const fs     = require('fs');
const path   = require('path');

const { loadEnv, ROOT } = require('../lib/env');
const router            = require('./router');

// Force IPv4 DNS resolution. Node 22 defaults to verbatim (IPv6-first when
// available); on this host that intermittently returns getaddrinfo ENOTFOUND
// for discord.com despite cmdline DNS working. Reproduces only inside the
// cron-spawned bot process. Forcing ipv4first eliminates the failure mode.
dns.setDefaultResultOrder('ipv4first');

loadEnv();

const BOT_TOKEN      = process.env.DISCORD_BOT_TOKEN;
const REACT_EMOJI    = '📊';
const REACT_ENC      = encodeURIComponent(REACT_EMOJI);
const MSG_MAX_AGE    = 24 * 60 * 60 * 1000; // 24h — expire old signal tracking
const STATE_FILE     = path.join(ROOT, '.discord-bot-state.json');  // { [channelId]: { lastMessageId } }
const HEALTH_FILE    = path.join(ROOT, '.discord-bot-health.json');

// Timestamped from here on. The log had no timestamps, which is why a two-week
// outage could not be dated from it — 23,772 error lines with no way to tell
// whether they were from this minute or last month (2026-07-26).
const log = (...a) => console.log(`[${new Date().toISOString()}] [discord-bot]`, ...a);

// State files per instrument prefix — must match what trigger-check / analyze scripts write
const SIGNAL_STATE = {
  btc: path.join(ROOT, '.trigger-state.json'),
  bz:  path.join(ROOT, '.bz-trigger-state.json'),
};

// ─── Guards ───────────────────────────────────────────────────────────────────

if (process.env.PRIMARY === 'false') {
  console.log('[discord-bot] PRIMARY=false — secondary machine, skipping.');
  process.exit(0);
}

if (!BOT_TOKEN || BOT_TOKEN === 'your_token_here') {
  console.log('[discord-bot] DISCORD_BOT_TOKEN not set — see setup instructions in scripts/discord-bot.js');
  process.exit(0);
}

// ─── State ────────────────────────────────────────────────────────────────────

function readBotState()    { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeBotState(s)  { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

function readSignalState(prefix) {
  const f = SIGNAL_STATE[prefix];
  if (!f) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
}
function writeSignalState(prefix, s) {
  const f = SIGNAL_STATE[prefix];
  if (!f) return;
  try { fs.writeFileSync(f, JSON.stringify(s, null, 2)); } catch {}
}

// ─── Discord REST ─────────────────────────────────────────────────────────────

// Transient network faults that are worth another attempt rather than losing
// the whole poll cycle. DNS resolution on this host fails intermittently —
// 23,772 `getaddrinfo ENOTFOUND discord.com` errors accumulated silently while
// curl-based alerts on the same cron kept working (2026-07-26). A single blip
// used to cost the entire minute's commands and reaction checks.
const TRANSIENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT',
                           'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'ETIMEOUT']);
const REQ_TIMEOUT_MS = 12_000;
const RETRY_DELAYS   = [400, 1500];   // two retries, then give up for this cycle

let netFailures = 0, netSuccesses = 0, lastNetError = null;

function discordRequestOnce(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'discord.com',
      path:     `/api/v10${urlPath}`,
      method,
      headers:  {
        Authorization:  `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent':   'AceTradingBot/1.1',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 204) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(`Bad JSON (${res.statusCode}): ${data.slice(0,200)}`)); }
      });
    });
    // Without an explicit timeout a stalled connect hangs until the OS gives
    // up, which is far longer than the one-minute cron cadence.
    req.setTimeout(REQ_TIMEOUT_MS, () => {
      req.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEOUT' }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function discordRequest(method, urlPath, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await discordRequestOnce(method, urlPath, body);
      netSuccesses++;
      return r;
    } catch (e) {
      const transient = TRANSIENT.has(e.code);
      if (!transient || attempt >= RETRY_DELAYS.length) {
        netFailures++;
        lastNetError = `${e.code || 'ERR'}: ${e.message}`;
        throw e;
      }
      log(`transient ${e.code} on ${method} ${urlPath} — retry ${attempt + 1}/${RETRY_DELAYS.length} in ${RETRY_DELAYS[attempt]}ms`);
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
}

// Build an api object scoped to a specific channel — passed to every handler
function makeApi(channelId) {
  return {
    sendMessage: (content) => discordRequest('POST', `/channels/${channelId}/messages`, { content }),
    sendTyping:  ()        => discordRequest('POST', `/channels/${channelId}/typing`).catch(() => {}),
    reply:       (msgId, content) => discordRequest('POST', `/channels/${channelId}/messages`, {
      content,
      message_reference: { message_id: msgId },
      allowed_mentions:  { replied_user: false },
    }),
  };
}

// ─── Command polling ──────────────────────────────────────────────────────────

async function pollChannel({ id: channelId, prefix }) {
  const handler = router.resolve(prefix + '-signals'); // resolve by prefix to get correct handler
  const state   = readBotState();
  const ch      = state[channelId] || {};
  const lastId  = ch.lastMessageId || null;

  const qs  = lastId ? `?limit=20&after=${lastId}` : `?limit=5`;
  let msgs;
  try {
    msgs = await discordRequest('GET', `/channels/${channelId}/messages${qs}`);
  } catch(e) {
    console.error(`[discord-bot] [${prefix}] API error fetching messages:`, e.message);
    return;
  }

  if (!Array.isArray(msgs) || msgs.length === 0) return;

  // Save newest ID first
  ch.lastMessageId    = msgs[0].id;
  state[channelId]    = ch;
  writeBotState(state);

  const humanMsgs = msgs.reverse().filter(m => !m.author?.bot);
  const api       = makeApi(channelId);

  for (const msg of humanMsgs) {
    const handled = await handler.handle(msg, api).catch(e => {
      console.error(`[discord-bot] [${prefix}] handler error:`, e.message);
      return false;
    });
    if (handled) break; // one command per poll cycle
  }
}

// ─── Reaction polling ─────────────────────────────────────────────────────────

async function checkReactions({ id: channelId, prefix }) {
  const ss   = readSignalState(prefix);
  const msgs = ss._signal_messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return;

  const api     = makeApi(channelId);
  const handler = router.resolve(prefix + '-signals');
  const now     = Date.now();
  let changed   = false;
  let checked   = 0;

  for (const entry of [...msgs].reverse()) {
    if (entry.analyzed) continue;
    if (now - entry.firedAt > MSG_MAX_AGE) { entry.analyzed = true; changed = true; continue; }
    if (checked >= 6) break; // max 6 API calls per run (≈6s)
    checked++;

    await new Promise(r => setTimeout(r, 1100)); // Discord rate-limit spacing

    let reactors;
    try {
      reactors = await discordRequest('GET', `/channels/${channelId}/messages/${entry.id}/reactions/${REACT_ENC}?limit=5`);
    } catch(e) {
      if (e.message?.includes('10008') || e.message?.includes('404')) { entry.analyzed = true; changed = true; }
      continue;
    }

    if (reactors?.retry_after) {
      await new Promise(r => setTimeout(r, Math.ceil(reactors.retry_after * 1000) + 500));
      continue;
    }

    if (!Array.isArray(reactors) || reactors.length === 0) continue;
    if (!reactors.some(u => !u.bot)) continue;

    // Human reacted — mark analyzed immediately to prevent double-fire
    entry.analyzed = true;
    changed = true;
    writeSignalState(prefix, ss);

    console.log(`[discord-bot] [${prefix}] 📊 reaction on msg ${entry.id} — triggering !analyze`);

    // Synthesize an !analyze command through the handler
    const syntheticMsg = {
      content: '!analyze',
      author:  { username: 'reaction', bot: false },
    };
    try {
      await handler.handle(syntheticMsg, api);
    } catch(e) {
      console.error(`[discord-bot] [${prefix}] reaction analyze error:`, e.message);
    }
  }

  if (changed) {
    ss._signal_messages = msgs.filter(e => !e.analyzed || now - e.firedAt < MSG_MAX_AGE);
    writeSignalState(prefix, ss);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const channels = router.allChannelIds();

  if (channels.length === 0) {
    console.log('[discord-bot] No channels configured — set DISCORD_CHANNEL_ID and/or BZ_DISCORD_SIGNALS_CHANNEL_ID in .env');
    return;
  }

  // Poll all channels concurrently
  await Promise.all([
    ...channels.map(ch => pollChannel(ch).catch(e => console.error(`[discord-bot] pollChannel error [${ch.prefix}]:`, e.message))),
    ...channels.map(ch => checkReactions(ch).catch(e => console.error(`[discord-bot] checkReactions error [${ch.prefix}]:`, e.message))),
  ]);

  // Health heartbeat. A bot that cannot reach Discord produces error lines and
  // nothing else — which is indistinguishable from a quiet channel unless
  // somebody reads the log. This file is what the watchdog checks, so a
  // sustained outage alarms instead of hiding for two weeks.
  try {
    const prev = (() => { try { return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch { return {}; } })();
    const ok = netSuccesses > 0;
    fs.writeFileSync(HEALTH_FILE, JSON.stringify({
      lastRunAt: Date.now(),
      lastSuccessAt: ok ? Date.now() : (prev.lastSuccessAt ?? null),
      requests: netSuccesses, failures: netFailures,
      lastError: lastNetError ?? prev.lastError ?? null,
      consecutiveFailedRuns: ok ? 0 : (prev.consecutiveFailedRuns ?? 0) + 1,
    }, null, 2));
    if (!ok) log(`WARNING: zero successful Discord requests this run (${netFailures} failures) — last: ${lastNetError}`);
  } catch (e) { log(`health write failed: ${e.message}`); }
}

// Explicit exit: keep-alive sockets to discord.com kept finished runs alive
// (5 processes leaked, oldest 7d14h, found 2026-07-26). See lib/cron-exit.js.
const { finishCron } = require('../lib/cron-exit');
main()
  .then(() => finishCron(0))
  .catch(e => { console.error('[discord-bot] Fatal:', e.message); finishCron(1); });
