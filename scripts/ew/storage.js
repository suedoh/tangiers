'use strict';

/**
 * scripts/ew/storage.js
 *
 * Flat-file persistence for the Elliott Wave subsystem.
 *
 * Two files (both gitignored, written to project root):
 *   ew-forecasts.json — array of forecast docs
 *   .ew-state.json   — { lastRunAt, lastBacktestAt, openForecastIds,
 *                        cooldown, calibration, ... }
 *
 * Schema is locked to be identical to the future Mongo `wave_forecasts`
 * collection so the migrator (Phase 2 of feat/mongodb-docker) is mechanical.
 *
 * Atomic read-modify-write via a `.lock` sibling file. Mirrors the pattern
 * trigger-check.js uses for trades.json.
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT           = path.resolve(__dirname, '..', '..');
const FORECASTS_FILE = path.join(ROOT, 'ew-forecasts.json');
const STATE_FILE     = path.join(ROOT, '.ew-state.json');
const LOCK_TTL_MS    = 30_000;

// ─── Lock primitive ──────────────────────────────────────────────────────────

function acquireLock(filePath, timeoutMs = 5000) {
  const lockPath = filePath + '.lock';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Break stale locks
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) fs.unlinkSync(lockPath);
      } catch {}
      // Tight retry
      const wait = Date.now() + 50;
      while (Date.now() < wait) {}
    }
  }
  throw new Error(`Could not acquire lock on ${filePath} within ${timeoutMs}ms`);
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch {}
}

function withFileLock(filePath, fn) {
  const lockPath = acquireLock(filePath);
  try { return fn(); } finally { releaseLock(lockPath); }
}

// ─── Forecast log ────────────────────────────────────────────────────────────

function loadForecasts() {
  if (!fs.existsSync(FORECASTS_FILE)) return [];
  const raw = fs.readFileSync(FORECASTS_FILE, 'utf8').trim();
  if (!raw) return [];
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`ew-forecasts.json is corrupt: ${e.message}`); }
}

function saveForecasts(arr) {
  // Atomic write via tmp + rename
  const tmp = FORECASTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, FORECASTS_FILE);
}

function appendForecast(doc) {
  return withFileLock(FORECASTS_FILE, () => {
    const list = loadForecasts();
    list.push(doc);
    saveForecasts(list);
    return doc;
  });
}

function getOpenForecasts(now = new Date()) {
  const nowIso = now instanceof Date ? now.toISOString() : now;
  return loadForecasts().filter(f =>
    f.status === 'open' && f.expiresAt > nowIso
  );
}

function getForecastsBetween(startIso, endIso) {
  return loadForecasts().filter(f =>
    f.generatedAt >= startIso && f.generatedAt < endIso
  );
}

function getLatestForecast(filterFn) {
  const list = loadForecasts();
  for (let i = list.length - 1; i >= 0; i--) {
    if (!filterFn || filterFn(list[i])) return list[i];
  }
  return null;
}

function updateForecast(id, patch) {
  return withFileLock(FORECASTS_FILE, () => {
    const list = loadForecasts();
    const idx = list.findIndex(f => f._id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch };
    saveForecasts(list);
    return list[idx];
  });
}

// ─── State ───────────────────────────────────────────────────────────────────

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      lastRunAt:          null,
      lastBacktestAt:     null,
      lastDailyBriefAt:   null,
      lastDailySummaryAt: null,
      lastWeeklyOutlookAt: null,
      lastMonthlyReviewAt: null,
      openForecastIds:    [],
      cooldown:           {},
      calibration:        {},
    };
  }
  const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
  if (!raw) return loadState.call(null);
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`.ew-state.json is corrupt: ${e.message}`); }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function withState(fn) {
  return withFileLock(STATE_FILE, () => {
    const state = loadState();
    const result = fn(state);
    saveState(state);
    return result;
  });
}

// ─── Calibration buckets ─────────────────────────────────────────────────────

const BUCKETS = [50, 60, 70, 80, 90];

/** Confidence ∈ [0,1] → bucket key like "70" (lower edge). */
function bucketFor(confidence) {
  const pct = Math.max(0, Math.min(99, Math.floor(confidence * 100)));
  for (let i = BUCKETS.length - 1; i >= 0; i--) {
    if (pct >= BUCKETS[i]) return String(BUCKETS[i]);
  }
  return String(BUCKETS[0]);
}

/** Increment calibration counters. `hit` true if a target was reached. */
function incrementCalibration(tf, slot /* 'primary'|'alternate' */, confidence, hit) {
  return withState(state => {
    const key = `${tf}-${slot}`;
    if (!state.calibration) state.calibration = {};
    if (!state.calibration[key]) state.calibration[key] = {};
    const bk = bucketFor(confidence);
    if (!state.calibration[key][bk]) state.calibration[key][bk] = { n: 0, hits: 0 };
    state.calibration[key][bk].n += 1;
    if (hit) state.calibration[key][bk].hits += 1;
  });
}

function getCalibration() {
  return loadState().calibration || {};
}

// ─── ID helper ───────────────────────────────────────────────────────────────

function newId() {
  // Prefer crypto.randomUUID() (Node 14.17+); fall back if unavailable
  try { return crypto.randomUUID(); }
  catch { return crypto.randomBytes(16).toString('hex'); }
}

module.exports = {
  // Files
  FORECASTS_FILE, STATE_FILE,
  // Forecast log
  loadForecasts, saveForecasts,
  appendForecast, getOpenForecasts, getForecastsBetween,
  getLatestForecast, updateForecast,
  // State
  loadState, saveState, withState,
  // Calibration
  bucketFor, incrementCalibration, getCalibration,
  // Utility
  newId,
};
