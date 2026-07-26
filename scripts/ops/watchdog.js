#!/usr/bin/env node
'use strict';

/**
 * Host infra watchdog — the alarm for "host awake but execution infra dead".
 *
 * Born from the 2026-06-27→29 incident: Docker Desktop died while the host
 * kept firing signals for 26+ hours; every autotrade dropped (ECONNREFUSED),
 * recon's protection invariant went dark for 4.7 days, and nothing alerted
 * because the only watchers lived inside the dead container.
 *
 * Runs every 5 min on the HOST crontab (never in Docker — it watches Docker).
 * Checks, in order:
 *   docker  — daemon reachable. On failure, attempts a background restart
 *             (`open -g -a Docker`) immediately; alert follows on 2nd strike.
 *   mongo   — connect to 127.0.0.1:27017 (5s timeout, via lib/db.js).
 *   recon   — logs/blofin-recon.log mtime < RECON_STALE_MIN. Recon runs
 *             every 3 min; 2 consecutive stale reads (10 min apart) cannot
 *             be a sleep/wake artifact.
 *   spool   — .blofin-spool.ndjson older than SPOOL_STALE_MIN means orders
 *             were placed in degraded mode and Mongo still isn't back.
 *   marginLow — available BloFin margin < 2× the initial margin a next entry
 *             at current sizing would need (spec 02.3). The early warning
 *             BEFORE autotrade starts skipping on margin — the 2026-07-26
 *             238-contract stack margin-locked the account for 24h+ with no
 *             alert anywhere. Rate-limited to 30 min (tighter than the infra
 *             classes) and posted as its own dedicated red alert.
 *
 * Alerting: 2 consecutive strikes → one red post to #blofin-recon listing
 * every failing class; re-alerts at most every ALERT_COOLDOWN_MS while the
 * failure persists; single green recovery post when all classes clear.
 * State in .watchdog-state.json. Sleep is invisible to this script by
 * design — while the host sleeps, nothing can fire, so there is nothing
 * to defend; the dangerous state is awake-with-dead-infra, which is
 * exactly when cron runs this.
 *
 * PRIMARY=false machines skip (no Docker, no execution layer there).
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

if (process.env.PRIMARY === 'false') {
  console.log('[watchdog] PRIMARY=false — skipping');
  process.exit(0);
}

const STATE_FILE      = path.join(ROOT, '.watchdog-state.json');
const RECON_LOG       = path.join(ROOT, 'logs', 'blofin-recon.log');
const SPOOL_FILE      = path.join(ROOT, '.blofin-spool.ndjson');
const DOCKER_BIN      = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';

const STRIKES_TO_ALERT   = 2;               // 2 × 5-min cron = 10 min of confirmed failure
const ALERT_COOLDOWN_MS  = 2 * 60 * 60 * 1000;
const RECON_STALE_MIN    = 20;              // recon cadence is 3 min
const SPOOL_STALE_MIN    = 15;

// Per-class cooldown overrides (spec 02.3: margin alerts rate-limit at 30 min,
// tighter than the 2h infra cadence — margin pressure is actionable *now*).
const CLASS_COOLDOWN_MS  = { marginLow: 30 * 60 * 1000 };
const cooldownFor        = name => CLASS_COOLDOWN_MS[name] ?? ALERT_COOLDOWN_MS;

// Reference stop width for the next-entry margin estimate: measured median
// stop 0.216% of price (2026-07-26 audit, prior-audit A3 — "0.216% stops sit
// inside a single bar 82% of the time"). Initial margin per entry =
// rDollar / (stopFrac × leverage) — price cancels out. Re-derive when spec 07
// validates a different stop geometry.
const REF_STOP_PCT       = 0.00216;

function log(msg) { console.log(`[${new Date().toISOString()}] [watchdog] ${msg}`); }

function readState()   { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { log(`state write failed: ${e.message}`); } }

// ─── Checks ──────────────────────────────────────────────────────────────────

function checkDocker() {
  try {
    // NB: `docker info --format` exits 0 even with the daemon down (probed
    // 2026-07-02 — error goes to stderr, format renders empty). `docker
    // version --format {{.Server.Version}}` exits 1, and we also require a
    // non-empty version string, belt and braces.
    const out = execFileSync(DOCKER_BIN, ['version', '--format', '{{.Server.Version}}'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).toString().trim();
    if (!out) throw new Error('daemon returned empty server version');
    return { ok: true };
  } catch (e) {
    // Self-heal attempt: background-launch Docker Desktop. Harmless if it is
    // mid-startup; containers return via restart:unless-stopped. Comment the
    // next block out if auto-restart is ever unwanted.
    try {
      execFileSync('/usr/bin/open', ['-g', '-a', 'Docker'], { stdio: 'pipe', timeout: 10_000 });
      log('docker daemon down — restart attempted via `open -g -a Docker`');
      return { ok: false, detail: 'daemon unreachable (auto-restart attempted; re-check next cycle)' };
    } catch (openErr) {
      return { ok: false, detail: `daemon unreachable, restart failed: ${openErr.message}` };
    }
  }
}

async function checkMongo() {
  const db = require('../lib/db');
  try {
    await db.connect();
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `127.0.0.1:27017 unreachable: ${String(e.message).split('\n')[0]}` };
  } finally {
    try { await db.disconnect(); } catch (_) {}
  }
}

function checkReconFresh() {
  try {
    const ageMin = (Date.now() - fs.statSync(RECON_LOG).mtimeMs) / 60_000;
    if (ageMin > RECON_STALE_MIN) {
      return { ok: false, detail: `blofin-recon.log last written ${ageMin.toFixed(0)} min ago (cadence: 3 min)` };
    }
    // Freshness alone missed the 2026-07-04 E11000 loop: recon ran every
    // 3 min but errored on every pass — watchdog said recon=ok throughout.
    // Scan the last pass (final ~4KB) for error lines so runs-but-fails
    // strikes the same class as doesn't-run. Two consecutive erroring
    // passes 5 min apart → strike; the normal 2-strike alert flow applies.
    const fd  = fs.openSync(RECON_LOG, 'r');
    const sz  = fs.fstatSync(fd).size;
    const len = Math.min(4096, sz);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, sz - len);
    fs.closeSync(fd);
    const tail     = buf.toString('utf8');
    const lastPass = tail.slice(tail.lastIndexOf('─── BloFin reconciliation ───'));
    const errLine  = lastPass.split('\n').find(l => /reconcile errors: [1-9]|resolve errors: [1-9]/.test(l));
    if (errLine) {
      return { ok: false, detail: `recon running but erroring — last pass: "${errLine.trim()}"` };
    }
    return { ok: true };
  } catch {
    return { ok: false, detail: 'blofin-recon.log missing' };
  }
}

function checkSpool() {
  try {
    if (!fs.existsSync(SPOOL_FILE)) return { ok: true };
    const ageMin = (Date.now() - fs.statSync(SPOOL_FILE).mtimeMs) / 60_000;
    if (ageMin <= SPOOL_STALE_MIN) return { ok: true }; // recon will flush it shortly
    const lines = fs.readFileSync(SPOOL_FILE, 'utf8').split('\n').filter(Boolean).length;
    return { ok: false, detail: `${lines} unsynced order doc(s) waiting ${ageMin.toFixed(0)} min for Mongo` };
  } catch {
    return { ok: true };
  }
}

// margin-low (spec 02.3): available margin < 2× next-entry initial margin at
// current sizing. Next-entry margin uses the same sizing the autotrade layer
// uses — equity = min(live balance, ACCOUNT_EQUITY_USD cap), rDollar =
// equity × RISK_PER_TRADE_PCT — at the measured median stop width
// (REF_STOP_PCT): margin = rDollar / (stopFrac × leverage); price cancels.
// Fail-open on read errors: an unreachable BloFin API is an infra problem the
// recon class already covers, not a margin condition.
async function checkMarginLow() {
  if (process.env.BLOFIN_AUTOTRADE !== 'true') return { ok: true }; // no next entry to fund
  try {
    const blofin = require('../lib/blofin');
    const bal    = await blofin.getBalance();
    const usdt   = (bal || []).find(b => b.currency === 'USDT');
    const cash   = Number(usdt?.balance);
    const frozen = Number(usdt?.frozen);
    const avail  = Number(usdt?.available);
    if (!Number.isFinite(avail) || !Number.isFinite(cash)) return { ok: true };

    const cap     = Number(process.env.ACCOUNT_EQUITY_USD);
    const live    = cash + (Number.isFinite(frozen) ? frozen : 0);
    const equity  = Number.isFinite(cap) && cap > 0 ? Math.min(live, cap) : live;
    const riskPct = Number(process.env.RISK_PER_TRADE_PCT || 1);
    const lev     = Number(process.env.BLOFIN_LEVERAGE || 10);
    const rDollar = equity * (riskPct / 100);
    const nextEntryMargin = rDollar / (REF_STOP_PCT * lev);
    if (avail < 2 * nextEntryMargin) {
      return { ok: false,
        detail: `available margin $${avail.toFixed(0)} < 2× next-entry initial margin $${nextEntryMargin.toFixed(0)} `
              + `(equity $${equity.toFixed(0)} · risk ${riskPct}%/trade · ${lev}x · ref stop ${(REF_STOP_PCT * 100).toFixed(3)}%)` };
    }
    return { ok: true };
  } catch (e) {
    log(`marginLow check unreadable (fail-open): ${String(e.message).split('\n')[0]}`);
    return { ok: true };
  }
}

// ─── Discord ─────────────────────────────────────────────────────────────────

async function post(type, body) {
  const webhook = process.env.BLOFIN_RECON_WEBHOOK;
  if (!webhook) { log('BLOFIN_RECON_WEBHOOK unset — cannot alert'); return; }
  const { postWebhook } = require('../lib/discord');
  await postWebhook(webhook, type, body,
    `Host watchdog · ${new Date().toUTCString().slice(5, 25)} UTC`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const results = {
    docker:    checkDocker(),
    mongo:     await checkMongo(),
    recon:     checkReconFresh(),
    spool:     checkSpool(),
    marginLow: await checkMarginLow(),
  };

  const state = readState();
  if (!state.strikes)     state.strikes = {};
  if (!state.alerting)    state.alerting = {};
  if (!state.lastAlertAt) state.lastAlertAt = {};

  const failing = [];
  const recovered = [];

  for (const [name, r] of Object.entries(results)) {
    if (r.ok) {
      if (state.alerting[name]) recovered.push(name);
      state.strikes[name]  = 0;
      state.alerting[name] = false;
    } else {
      state.strikes[name] = (state.strikes[name] || 0) + 1;
      log(`FAIL ${name} (strike ${state.strikes[name]}): ${r.detail}`);
      if (state.strikes[name] >= STRIKES_TO_ALERT) failing.push({ name, detail: r.detail });
    }
  }

  const dueForAlert = failing.filter(f =>
    !state.alerting[f.name]
    || Date.now() - (state.lastAlertAt[f.name] || 0) >= cooldownFor(f.name));

  // margin-low gets its own dedicated post (it is a book condition, not an
  // infra outage — the INFRA DOWN framing and 2h cadence don't fit it).
  const infraDue     = dueForAlert.filter(f => f.name !== 'marginLow');
  const marginDue    = dueForAlert.find(f => f.name === 'marginLow');
  const infraFailing = failing.filter(f => f.name !== 'marginLow');

  if (infraDue.length > 0) {
    const body = [
      `🚨 **INFRA DOWN — HOST IS AWAKE BUT EXECUTION INFRA IS NOT** 🚨`,
      `Signals that fire now will place in degraded mode (spooled) or not at all. Confirmed over ${STRIKES_TO_ALERT} checks.`,
      ``,
      ...infraFailing.map(f => `❌ **${f.name}** — ${f.detail}`),
      ``,
      `**Action** \`docker compose up -d\` from ~/trading if the auto-restart hasn't recovered it. Re-alerts every ${ALERT_COOLDOWN_MS / 3600000}h while broken.`,
    ].join('\n');
    await post('error', body);
    for (const f of infraFailing) {
      state.alerting[f.name]    = true;
      state.lastAlertAt[f.name] = Date.now();
    }
    log(`alert posted: ${infraFailing.map(f => f.name).join(', ')}`);
  }

  if (marginDue) {
    await post('error', [
      `🚨 **MARGIN LOW — NEXT ENTRY AT RISK OF SKIPPING** 🚨`,
      marginDue.detail,
      ``,
      `Autotrade skips (book cap / margin cap / preflight) alert separately at skip time — this is the early warning before they start.`,
      `**Action** Review open BloFin positions (margin may be locked by the book) or top up demo margin (\`make blofin-fund\`). Re-alerts every ${cooldownFor('marginLow') / 60000} min while low.`,
    ].join('\n'));
    state.alerting.marginLow    = true;
    state.lastAlertAt.marginLow = Date.now();
    log('alert posted: marginLow');
  }

  if (recovered.length > 0 && failing.length === 0) {
    await post('info', [
      `✅ **INFRA RECOVERED** — ${recovered.join(', ')} back to healthy.`,
      `Recon will flush any spooled degraded-mode placements on its next cycle.`,
    ].join('\n'));
    log(`recovery posted: ${recovered.join(', ')}`);
  }

  writeState(state);
  const summary = Object.entries(results).map(([n, r]) => `${n}=${r.ok ? 'ok' : 'FAIL'}`).join(' ');
  log(summary);
}

main().catch(e => { console.error('[watchdog] fatal:', e.message); process.exit(1); });
