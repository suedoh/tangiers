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

module.exports = { postWebhook, postRaw };
