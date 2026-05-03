'use strict';

/**
 * lib/env.js — Load .env into process.env
 * Call loadEnv() once at startup. Safe to call multiple times.
 *
 * Environment routing:
 *   resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK')
 *     → returns WEATHER_DISCORD_SIGNALS_WEBHOOK_STAGING when ENVIRONMENT=staging
 *     → returns WEATHER_DISCORD_SIGNALS_WEBHOOK when ENVIRONMENT=production (default)
 *
 * All new integrations should use resolveWebhook() instead of process.env directly
 * so staging/production routing is automatic.
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, '.env');

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  fs.readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const i = l.indexOf('=');
      if (i > 0) {
        const key = l.slice(0, i).trim();
        // Strip inline comments (e.g. VALUE=foo  # comment → foo)
        const raw = l.slice(i + 1).trim().replace(/\s+#.*$/, '');
        if (!process.env[key]) process.env[key] = raw;
      }
    });
}

/**
 * Resolve a webhook or channel ID env var to the correct value for the
 * current environment (staging vs production).
 *
 * Usage:
 *   const url = resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK');
 *   const id  = resolveWebhook('WEATHER_DISCORD_SIGNALS_CHANNEL_ID');
 *
 * @param {string} baseKey - The production env var name (no _STAGING suffix)
 * @returns {string|undefined}
 */
function resolveWebhook(baseKey) {
  const env = (process.env.ENVIRONMENT || 'production').toLowerCase();
  if (env === 'staging') {
    const stagingVal = process.env[`${baseKey}_STAGING`];
    if (stagingVal) return stagingVal;
    console.warn(`[env] ENVIRONMENT=staging but ${baseKey}_STAGING not set — falling back to production`);
  }
  return process.env[baseKey];
}

/** True when running in staging mode */
const isStaging = () => (process.env.ENVIRONMENT || 'production').toLowerCase() === 'staging';

module.exports = { loadEnv, ROOT, ENV_FILE, resolveWebhook, isStaging };
