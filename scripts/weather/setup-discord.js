#!/usr/bin/env node
'use strict';

/**
 * weather/setup-discord.js — One-shot Discord channel + webhook setup
 *
 * Creates #weather-signals and #weather-backtest in your Discord server,
 * creates a webhook for each, then prints the exact .env lines to paste.
 *
 * Usage:
 *   node scripts/weather/setup-discord.js
 *
 * Requires in .env:
 *   DISCORD_BOT_TOKEN  — your bot token (already set for BTC/BZ)
 *
 * Bot must have: Manage Channels + Manage Webhooks permissions in the server.
 */

const https = require('https');
const { loadEnv } = require('../lib/env');

loadEnv();

const GUILD_ID   = '1493008615446020337';
const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const DISCORD_API = 'discord.com';

if (!BOT_TOKEN) {
  console.error('❌  DISCORD_BOT_TOKEN not set in .env');
  process.exit(1);
}

// ─── Discord REST helper ──────────────────────────────────────────────────────

function discordRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: DISCORD_API,
      path:     `/api/v10${path}`,
      method,
      headers: {
        'Authorization': `Bot ${BOT_TOKEN}`,
        'Content-Type':  'application/json',
        'User-Agent':    'Weathermen/1.0 (Tangiers)',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`Discord API ${res.statusCode}: ${data.message || raw.slice(0, 200)}`));
          }
        } catch {
          reject(new Error(`JSON parse error (${res.statusCode}): ${raw.slice(0, 100)}`));
        }
      });
    });
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Discord API timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌦️  Weathermen — Discord Setup');
  console.log(`   Guild ID: ${GUILD_ID}\n`);

  // ── Fetch existing channels to avoid duplicates ───────────────────────────
  console.log('→  Fetching existing channels...');
  const existing = await discordRequest('GET', `/guilds/${GUILD_ID}/channels`);
  const existingNames = new Map(existing.map(c => [c.name, c]));

  const results = {};

  for (const { name, topic } of [
    { name: 'weather-signals',  topic: '🌡️ Polymarket weather edge signals — auto-posted by Weathermen bot' },
    { name: 'weather-backtest', topic: '📊 Paper trade log, outcome tracking, weekly P&L reports' },
  ]) {
    if (existingNames.has(name)) {
      console.log(`✓  #${name} already exists — skipping channel creation`);
      results[name] = { channel: existingNames.get(name) };
    } else {
      console.log(`→  Creating #${name}...`);
      const channel = await discordRequest('POST', `/guilds/${GUILD_ID}/channels`, {
        name,
        type:  0,   // GUILD_TEXT
        topic,
      });
      console.log(`✓  #${name} created (ID: ${channel.id})`);
      results[name] = { channel };
    }

    // ── Create webhook ──────────────────────────────────────────────────────
    const channelId = results[name].channel.id;

    // Check if a Weathermen webhook already exists on this channel
    let existingWebhooks = [];
    try { existingWebhooks = await discordRequest('GET', `/channels/${channelId}/webhooks`); }
    catch { /* ignore — bot may lack read-webhook permission */ }

    const existingWh = existingWebhooks.find(w => w.name === 'Weathermen');
    if (existingWh) {
      console.log(`✓  Webhook already exists on #${name} — reusing`);
      results[name].webhookUrl = `https://discord.com/api/webhooks/${existingWh.id}/${existingWh.token}`;
    } else {
      console.log(`→  Creating webhook on #${name}...`);
      const webhook = await discordRequest('POST', `/channels/${channelId}/webhooks`, {
        name: 'Weathermen',
      });
      results[name].webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
      console.log(`✓  Webhook created on #${name}`);
    }
  }

  // ── Print .env lines ──────────────────────────────────────────────────────
  const signals  = results['weather-signals'];
  const backtest = results['weather-backtest'];

  console.log('\n' + '─'.repeat(60));
  console.log('✅  Setup complete! Add these lines to your .env:\n');
  console.log(`WEATHER_DISCORD_SIGNALS_WEBHOOK=${signals.webhookUrl}`);
  console.log(`WEATHER_DISCORD_BACKTEST_WEBHOOK=${backtest.webhookUrl}`);
  console.log(`WEATHER_DISCORD_SIGNALS_CHANNEL_ID=${signals.channel.id}`);
  console.log(`WEATHER_DISCORD_BACKTEST_CHANNEL_ID=${backtest.channel.id}`);
  console.log('\n' + '─'.repeat(60));
  console.log('\nNext steps:');
  console.log('  1. Paste the four lines above into your .env');
  console.log('  2. Run: node scripts/weather/market-scan.js   (manual test)');
  console.log('  3. Run: make weather-cron                     (when ready to automate)');
}

main().catch(err => {
  console.error('\n❌  Setup failed:', err.message);
  if (err.message.includes('Missing Permissions')) {
    console.error('\n   Fix: Make sure your bot has "Manage Channels" and "Manage Webhooks"');
    console.error('   permissions in your Discord server.');
  }
  process.exit(1);
});
