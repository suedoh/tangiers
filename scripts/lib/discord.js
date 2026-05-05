'use strict';

/**
 * lib/discord.js — Shared Discord webhook poster
 *
 * Supports all 6 alert types used by BZ (and future instruments):
 *   approaching  ⚠️  yellow
 *   long         🟢  green
 *   short        🔴  red
 *   info         📊  blue
 *   error        ❌  dark red
 *   catalyst     🛢️  orange
 */

const https = require('https');

const COLORS = {
  approaching: 16776960,  // yellow
  long:        5763719,   // green
  short:       15548997,  // red
  error:       10038562,  // dark red
  info:        3447003,   // blue
  catalyst:    16744272,  // orange
};

/**
 * Post an embed to a Discord webhook.
 * @param {string} webhookUrl
 * @param {string} type        One of the 6 alert types
 * @param {string} message     Markdown body text
 * @param {string} footer      Footer text (e.g. "BZ! • NYMEX:BZ1! • 03:14 UTC")
 * @returns {Promise<string|null>}  Message ID if successful, null otherwise
 */
function postWebhook(webhookUrl, type, message, footer) {
  return new Promise((resolve) => {
    const color   = COLORS[type] ?? COLORS.info;
    const ts      = new Date().toISOString();
    const safeMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const safeFtr = (footer || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const payload = JSON.stringify({
      embeds: [{
        description: message,
        color,
        footer: { text: footer || '' },
        timestamp: ts,
      }],
    });

    const url = new URL(webhookUrl + '?wait=true');
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'AceTradingBot/1.1',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const id = JSON.parse(data).id || null;
            resolve(id);
          } catch { resolve(null); }
        } else {
          console.error(`[discord] HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error('[discord] request error:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}

/**
 * Post a plain-text message to a webhook (no embed).
 */
function postRaw(webhookUrl, content) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ content });
    const url     = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'AceTradingBot/1.1',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

// ─── Discord Bot API (requires DISCORD_BOT_TOKEN) ────────────────────────────

function _discordApi(botToken, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'discord.com',
      path:     `/api/v10${apiPath}`,
      method,
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent':    'AceTradingBot/1.1',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Add a unicode emoji reaction to a message.
 * @param {string} botToken
 * @param {string} channelId
 * @param {string} messageId
 * @param {string} emoji     e.g. '✅' or '❌'
 * @returns {Promise<boolean>}
 */
async function addReaction(botToken, channelId, messageId, emoji) {
  const { status } = await _discordApi(
    botToken, 'PUT',
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
  );
  return status === 204;
}

/**
 * Fetch messages from a channel (newest first).
 * @param {string} botToken
 * @param {string} channelId
 * @param {{ limit?: number, before?: string }} options
 * @returns {Promise<object[]>}
 */
async function getChannelMessages(botToken, channelId, { limit = 100, before } = {}) {
  const qs = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
  if (before) qs.set('before', before);
  const { status, body } = await _discordApi(
    botToken, 'GET',
    `/channels/${channelId}/messages?${qs}`
  );
  if (status !== 200) return [];
  try { return JSON.parse(body); } catch { return []; }
}

module.exports = { postWebhook, postRaw, addReaction, getChannelMessages };
