'use strict';

/**
 * lib/env.js — Load .env into process.env
 * Call loadEnv() once at startup. Safe to call multiple times.
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
        if (!process.env[key]) process.env[key] = l.slice(i + 1).trim();
      }
    });
}

/**
 * Resolve an env var to its staging equivalent when ENVIRONMENT=staging.
 * Usage: resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK')
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

const isStaging = () => (process.env.ENVIRONMENT || 'production').toLowerCase() === 'staging';

module.exports = { loadEnv, ROOT, ENV_FILE, resolveWebhook, isStaging };
