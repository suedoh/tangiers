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

module.exports = { loadEnv, ROOT, ENV_FILE };
