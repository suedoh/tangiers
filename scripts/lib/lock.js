'use strict';

/**
 * lib/lock.js — Simple file-based mutex for TradingView CDP access.
 *
 * Both BTC and BZ scripts connect to the same TradingView Desktop CDP session.
 * The lock prevents them from stepping on each other when switching symbols/timeframes.
 *
 * Usage:
 *   const { acquireLock, releaseLock } = require('./lib/lock');
 *   const lock = await acquireLock(30_000); // wait up to 30s
 *   try { ...do CDP work... } finally { releaseLock(lock); }
 */

const fs   = require('fs');
const path = require('path');

const LOCK_FILE    = path.join(__dirname, '..', '..', '.tradingview-lock');
const LOCK_TTL_MS  = 60_000;  // locks older than 60s are considered stale and broken

function isLockStale(lockData) {
  try {
    const d = JSON.parse(lockData);
    return Date.now() - d.at > LOCK_TTL_MS;
  } catch {
    return true;
  }
}

function writeLock(holder) {
  const data = JSON.stringify({ holder, at: Date.now(), pid: process.pid });
  fs.writeFileSync(LOCK_FILE, data);
  return data;
}

/**
 * Attempt to acquire the lock.
 * @param {number} timeoutMs  Max milliseconds to wait (default 30s)
 * @param {string} holder     Label for debugging (e.g. 'bz-trigger', 'bz-analyze')
 * @returns {string|null}     Lock data string if acquired, null if timed out
 */
async function acquireLock(timeoutMs = 30_000, holder = 'unknown') {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!fs.existsSync(LOCK_FILE)) {
      writeLock(holder);
      return holder;
    }

    const existing = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (isLockStale(existing)) {
      // Stale lock — break it and acquire
      writeLock(holder);
      return holder;
    }

    // Lock held by another process — wait 1 second and retry
    await new Promise(r => setTimeout(r, 1_000));
  }

  return null; // timed out
}

function releaseLock(holder) {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    // Only release if we hold it (avoid releasing another process's lock)
    if (existing.holder === holder && existing.pid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // Best-effort release
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

module.exports = { acquireLock, releaseLock };
