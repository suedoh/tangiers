'use strict';

/**
 * Today's realized R + daily-R kill switch floor.
 *
 * Reads trades.json directly (the canonical write path); sums pnlR for
 * trades that closed in the current UTC day. Shared between
 * trigger-check.js (existing signal-suppression gate) and
 * blofin-autotrade.js (defense-in-depth gate at order-placement time).
 *
 * Re-evaluate the floor after 60 days of post-fix data.
 */

const fs   = require('fs');
const path = require('path');

const TRADES_FILE = path.resolve(__dirname, '..', '..', 'trades.json');

const DAILY_R_KILL_FLOOR = -3.0;

function todayUtcR() {
  try {
    const all = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const cutoff = startOfUtcDay.getTime();
    return all.reduce((sum, t) => {
      if (!t.closedAt || t.pnlR == null) return sum;
      const ms = new Date(t.closedAt).getTime();
      return ms >= cutoff ? sum + t.pnlR : sum;
    }, 0);
  } catch { return 0; }
}

function isKillActive() {
  return todayUtcR() <= DAILY_R_KILL_FLOOR;
}

module.exports = { DAILY_R_KILL_FLOOR, todayUtcR, isKillActive };
