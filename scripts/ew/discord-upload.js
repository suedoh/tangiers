'use strict';

/**
 * scripts/ew/discord-upload.js
 *
 * Multipart/form-data Discord webhook poster. The project's existing
 * scripts/lib/discord.js posts JSON-only embeds; this is the first
 * place we attach binary files (chart screenshots) to a webhook post.
 *
 * Built with Node's built-in `https` module — no new deps.
 *
 * Usage:
 *   const { postWithFiles } = require('./discord-upload.js');
 *   await postWithFiles(webhookUrl, embeds, [
 *     { path: '/.../ew_1D.png', name: 'ew_1D.png' },
 *     { path: '/.../ew_4H.png', name: 'ew_4H.png' },
 *   ]);
 *
 * Embed image references use `attachment://<filename>` so Discord renders
 * the upload inline:
 *   { image: { url: 'attachment://ew_4H.png' } }
 *
 * Refuses files > 9 MB (Discord webhook cap is 10 MB w/o Nitro; we keep
 * margin) and falls back to text-only when refused.
 *
 * Returns the Discord message ID on success, null on failure.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES  = 9 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;  // Discord cap is 25 MB total
const MAX_FILES       = 10;

/**
 * @param {string} webhookUrl
 * @param {Array}  embeds       Array of Discord embed objects
 * @param {Array<{path:string, name:string}>} files
 * @param {Object} [opts]
 * @param {string} [opts.username]   Webhook poster username override
 * @param {string} [opts.content]    Optional content text above embeds
 * @returns {Promise<string|null>}   Message ID or null on failure
 */
async function postWithFiles(webhookUrl, embeds, files, opts = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return postEmbedsOnly(webhookUrl, embeds, opts);
  }

  if (files.length > MAX_FILES) {
    console.error(`[discord-upload] too many files (${files.length}); truncating to ${MAX_FILES}`);
    files = files.slice(0, MAX_FILES);
  }

  // Validate sizes upfront
  let totalBytes = 0;
  const validated = [];
  for (const f of files) {
    try {
      const stat = fs.statSync(f.path);
      if (stat.size > MAX_FILE_BYTES) {
        console.error(`[discord-upload] file ${f.name} too large (${stat.size} bytes); skipping`);
        continue;
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        console.error(`[discord-upload] cumulative file size exceeded ${MAX_TOTAL_BYTES}; truncating`);
        break;
      }
      validated.push(f);
    } catch (e) {
      console.error(`[discord-upload] could not stat ${f.path}: ${e.message}`);
    }
  }

  if (validated.length === 0) {
    // All files refused — fall back with a footer note
    const augmented = embeds.map((e, i) =>
      i === embeds.length - 1
        ? { ...e, footer: { text: ((e.footer && e.footer.text) ? (e.footer.text + ' · ') : '') + 'screenshots refused (size or read error)' } }
        : e
    );
    return postEmbedsOnly(webhookUrl, augmented, opts);
  }

  const boundary = '----AceFormBoundary' + crypto.randomBytes(16).toString('hex');
  const payloadJson = JSON.stringify({
    embeds,
    username:    opts.username,
    content:     opts.content,
    attachments: validated.map((f, i) => ({ id: i, filename: f.name })),
  });

  // Build the multipart body
  const parts = [];

  // Part 1: payload_json
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="payload_json"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    payloadJson + `\r\n`
  ));

  // Each file part
  for (let i = 0; i < validated.length; i++) {
    const f = validated[i];
    const fileBuf = fs.readFileSync(f.path);
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files[${i}]"; filename="${f.name}"\r\n` +
      `Content-Type: image/png\r\n\r\n`
    ));
    parts.push(fileBuf);
    parts.push(Buffer.from(`\r\n`));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const url = new URL(webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true');
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'User-Agent':     'AceTradingBot/1.1 (EW)',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).id || null); }
          catch { resolve(null); }
        } else {
          console.error(`[discord-upload] HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(null);
        }
      });
    });
    req.on('error', e => {
      console.error('[discord-upload] request error:', e.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/** Internal — JSON-only fallback (no attachments). */
function postEmbedsOnly(webhookUrl, embeds, opts = {}) {
  const payload = JSON.stringify({
    embeds,
    username: opts.username,
    content:  opts.content,
  });
  const url = new URL(webhookUrl + (webhookUrl.includes('?') ? '&' : '?') + 'wait=true');
  return new Promise(resolve => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'AceTradingBot/1.1 (EW)',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).id || null); }
          catch { resolve(null); }
        } else {
          console.error(`[discord-upload] HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(null);
        }
      });
    });
    req.on('error', e => {
      console.error('[discord-upload] request error:', e.message);
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { postWithFiles, postEmbedsOnly };
