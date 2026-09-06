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
 *   zombieProcs — any cron script still alive >30 min. Cron scripts finish in
 *             ~90s; a survivor has completed its work and hung on an open
 *             libuv handle. 158 trigger-check + 5 discord-bot processes leaked
 *             for two weeks (2026-07-26) with every other class green.
 *   bookRecorder — the spec-07 order-book corpus recorder is still writing,
 *             AND the rows it writes contain book data. Its data cannot be
 *             backfilled, so silent death is permanent loss. Self-heals with a
 *             bounded `pm2 restart` (3 per 6h) — detection alone was proved
 *             insufficient on 2026-08-14, when 144 correct alerts over 12 days
 *             changed nothing and 23 days of corpus were lost. Skipped when the
 *             recorder was never installed on this machine.
 *   discordBot — the bot has actually REACHED Discord recently, not merely run.
 *             Inbound traffic failing is invisible: outbound alerts use curl and
 *             kept working through a multi-week bot outage.
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

if (process.env.PRIMARY === 'false' && require.main === module) {
  console.log('[watchdog] PRIMARY=false — skipping');
  process.exit(0);
}

const STATE_FILE      = path.join(ROOT, '.watchdog-state.json');
const RECON_LOG       = path.join(ROOT, 'logs', 'blofin-recon.log');
const SPOOL_FILE      = path.join(ROOT, '.blofin-spool.ndjson');
const DOCKER_BIN      = fs.existsSync('/usr/local/bin/docker') ? '/usr/local/bin/docker' : 'docker';

// pm2 is NOT on the cron PATH (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)
// — it lives under nvm. `execFileSync('pm2', …)` from cron therefore ENOENTs,
// which would make the auto-restart below silently never happen: exactly the
// class of failure this whole check exists to end. Resolve it explicitly, the
// same way DOCKER_BIN is resolved, and glob nvm rather than pinning a version.
const PM2_BIN = (() => {
  const fixed = ['/opt/homebrew/bin/pm2', '/usr/local/bin/pm2'];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  const nvm = path.join(process.env.HOME || '', '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) {
      const p = path.join(nvm, v, 'bin', 'pm2');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* no nvm on this machine */ }
  return null;   // no pm2 ⇒ alert only, never a silent no-op
})();

const STRIKES_TO_ALERT   = 2;               // 2 × 5-min cron = 10 min of confirmed failure
const ALERT_COOLDOWN_MS  = 2 * 60 * 60 * 1000;
const RECON_STALE_MIN    = 20;              // recon cadence is 3 min
// Recon-window health (audit A2, 2026-08-03). 15 passes ≈ 45 min at the 3-min
// cadence; 3 failures in that window ≈ 20%. Calibrated against the measured
// record: 2026-08-03 ran at 32% (≈5/15 → strikes), 2026-07-19 at 4.0% and
// 2026-07-25 at 4.2% (≈0.6/15 → stays green). A total outage is 15/15.
const RECON_WINDOW_PASSES     = 15;
const RECON_MAX_ERR_IN_WINDOW = 3;
const RECON_PASS_GRACE_MS     = 60_000;     // a pass younger than this may still be running
const RECON_TAIL_BYTES        = 65_536;     // ~15 passes incl. 403 stack traces
const RECON_PASS_MARKER  = '─── BloFin reconciliation ─── ';
const RECON_DONE_MARKER  = '─── Done. ───';
// Any of: a non-zero summary count, a thrown error, or an HTTP status. The
// `unexpected:` / bare-`Error:` / `blofin http NNN` arms are what the old
// summary-only matcher missed entirely.
const RECON_ERR_RE = /reconcile errors: [1-9]|resolve errors: [1-9]|^unexpected:|^\s*(?:[A-Za-z]*Error):|blofin http \d{3}/;
const SPOOL_STALE_MIN    = 15;
const BOOK_STATE         = path.join(ROOT, '.book-recorder-state.json');
const BOOK_STALE_MIN     = 15;              // recorder writes one row per minute
const BOOK_DIR           = path.join(ROOT, 'data', 'orderbook');
// The corpus file is the independent witness. writeRow() appends to the day
// file and THEN rewrites the state file; a state file that keeps advancing
// while the .ndjson does not means the append side is failing (disk, perms,
// path) and every "fresh" row is going nowhere.
const BOOK_FILE_STALE_MIN = 15;
// Content health. A row is written by ANY inbound frame, so the liquidation
// feed alone (~25 msg/min, market-wide) is enough to keep minute rows flowing
// while the depth/tick feeds are dead — fresh rows, zero book data. Freshness
// cannot see that; only the row contents can. 10 consecutive empty minutes is
// far beyond the 1–8 isolated empties the 19-day corpus actually contains.
const BOOK_EMPTY_RUN     = 10;
const BOOK_TAIL_BYTES    = 16_384;          // ≈40 rows
// Bounded self-heal. 3 restarts per 6h fixes the observed failure (a stuck
// reconnect loop: one `pm2 restart` cleared it on 2026-09-06) without
// hammering a recorder that is broken for a reason restarting cannot fix
// (Binance IP block, disk full). Past the cap the class stops restarting and
// stays loud, which is the state that needs hands.
const BOOK_RESTART_MAX      = 3;
const BOOK_RESTART_WINDOW_MS = 6 * 60 * 60 * 1000;
const BOT_HEALTH         = path.join(ROOT, '.discord-bot-health.json');
const BOT_STALE_MIN      = 20;              // bot polls every minute

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

// zombieProcs: cron scripts are short-lived by construction — the longest
// legitimate run (BTC trigger, full CDP sweep) is ~90s. Anything from this set
// still alive after 30 min has finished its work and hung on an open libuv
// handle (see lib/cron-exit.js). Threshold is deliberately far above any real
// run so a slow cycle can never strike. pm2 processes (bz/news-watch.js) are
// persistent by design and are not in this list.
const CRON_SCRIPT_PATHS = [
  'scripts/trigger-check.js',
  'scripts/bz/trigger-check.js',
  'scripts/poly/btc-5/trigger-check.js',
  'scripts/discord-bot/index.js',
  'scripts/blofin/recon-once.js',
  'scripts/ew/run.js',
];
const PROC_MAX_AGE_MIN = 30;

function log(msg) { console.log(`[${new Date().toISOString()}] [watchdog] ${msg}`); }

// ps etime → minutes.  Formats: mm:ss | hh:mm:ss | dd-hh:mm:ss
function etimeToMin(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime).trim());
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return (Number(d || 0) * 1440) + (Number(h || 0) * 60) + Number(mm) + (Number(ss) / 60);
}

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

/**
 * Health of the recent recon window, from the log text alone (pure — tested in
 * test/watchdog-recon.test.js).
 *
 * Two things were wrong before (audit A2, 2026-08-03):
 *
 * 1. The matcher only knew `reconcile errors:` / `resolve errors:`. Those are
 *    SUMMARY lines — a thrown error aborts the pass long before they are
 *    written. A Cloudflare 403 (the dominant failure mode since 2026-07-10)
 *    therefore produced a pass containing no matched string at all, and the
 *    watchdog read that as healthy. Now a pass is healthy only if it COMPLETED
 *    and logged no error: completion is the signal, absence of known strings
 *    is not.
 *
 * 2. Only the LAST pass was inspected. The observed failure is intermittent —
 *    on 2026-08-03, 40 of 124 cycles (32%) failed while the rest succeeded, so
 *    a last-pass-only check flips green roughly two times in three and can
 *    almost never reach the 2 consecutive strikes an alert needs. Now the last
 *    RECON_WINDOW_PASSES (≈45 min) are counted and the class strikes at
 *    RECON_MAX_ERR_IN_WINDOW. That fires on total outage (all failed) AND on
 *    today's partial degradation, while a lone blip stays green.
 *
 * A pass still in flight is neither healthy nor failed — it is excluded until
 * it has had RECON_PASS_GRACE_MS to finish.
 */
function evaluateReconLog(tail, { nowMs = Date.now() } = {}) {
  const chunks = tail.split(RECON_PASS_MARKER).slice(1);
  if (!chunks.length) return { ok: true, passes: 0, errored: 0 };

  const window = chunks.slice(-RECON_WINDOW_PASSES);
  const errors = [];
  let counted = 0, stalled = null;

  window.forEach((body, i) => {
    const startedMs = Date.parse((body.slice(0, 30).trim().split(/\s/)[0]) || '');
    const errLine   = body.split('\n').find(l => RECON_ERR_RE.test(l));
    if (errLine) { counted++; errors.push(errLine.trim().slice(0, 160)); return; }
    if (body.includes(RECON_DONE_MARKER)) { counted++; return; }

    // Incomplete. The last pass may simply be running right now; anything
    // older than the grace window, or followed by another pass, never finished.
    const inFlight = i === window.length - 1
      && Number.isFinite(startedMs) && nowMs - startedMs < RECON_PASS_GRACE_MS;
    if (inFlight) return;
    counted++;
    const at = Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : 'unknown time';
    const msg = `pass at ${at} never completed`;
    errors.push(msg);
    if (i === window.length - 1) stalled = msg;
  });

  // A hung *current* pass is its own condition, not an error rate: recon is
  // 3-min cadence, so the newest pass sitting unfinished means the runner is
  // stuck now. Freshness alone would not catch it until RECON_STALE_MIN.
  if (stalled) {
    return { ok: false, passes: counted, errored: errors.length,
      detail: `recon appears hung — most recent ${stalled}` };
  }
  if (errors.length >= RECON_MAX_ERR_IN_WINDOW) {
    return {
      ok: false, passes: counted, errored: errors.length,
      detail: `recon running but erroring — ${errors.length}/${counted} of the last passes failed `
            + `(~${Math.round(counted * 3)} min): "${errors[errors.length - 1]}"`,
    };
  }
  return { ok: true, passes: counted, errored: errors.length };
}

function checkReconFresh() {
  try {
    const ageMin = (Date.now() - fs.statSync(RECON_LOG).mtimeMs) / 60_000;
    if (ageMin > RECON_STALE_MIN) {
      return { ok: false, detail: `blofin-recon.log last written ${ageMin.toFixed(0)} min ago (cadence: 3 min)` };
    }
    const fd  = fs.openSync(RECON_LOG, 'r');
    const sz  = fs.fstatSync(fd).size;
    const len = Math.min(RECON_TAIL_BYTES, sz);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, sz - len);
    fs.closeSync(fd);
    return evaluateReconLog(buf.toString('utf8'));
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

// zombieProcs: hung cron processes. The 2026-07-26 leak (158 trigger-check +
// 5 discord-bot, oldest 13d21h, ~316 idle Mongo conns) ran for two weeks with
// every other class green — the watchdog watched services, not the crons
// themselves. Reports the worst offender; fail-open if ps is unreadable.
function checkZombieProcs() {
  let out;
  try {
    out = execFileSync('/bin/ps', ['-eo', 'etime=,args='], { encoding: 'utf8', timeout: 10_000 });
  } catch (e) {
    log(`zombieProcs unreadable (fail-open): ${e.message}`);
    return { ok: true };
  }
  const offenders = [];
  for (const script of CRON_SCRIPT_PATHS) {
    const ages = out.split('\n')
      .map(l => {
        const t = l.trim();
        const i = t.indexOf(' ');
        if (i < 1) return null;
        const args = t.slice(i + 1).trim();
        // cron wraps each job in `/bin/sh -c PATH=... node <script>`; that
        // wrapper line names the same script and would double-count it.
        if (/^\S*sh\s+-c\s/.test(args) || !args.includes(script)) return null;
        return etimeToMin(t.slice(0, i));
      })
      .filter(a => a != null && a > PROC_MAX_AGE_MIN);
    if (ages.length) {
      offenders.push({ script, n: ages.length, oldest: Math.max(...ages) });
    }
  }
  if (!offenders.length) return { ok: true };
  offenders.sort((a, b) => b.oldest - a.oldest);
  const worst = offenders[0];
  const rest  = offenders.length > 1 ? ` (+${offenders.length - 1} other script(s))` : '';
  return { ok: false,
    detail: `${worst.n} hung ${worst.script} process(es), oldest ${(worst.oldest / 60).toFixed(1)}h `
          + `— finished work holding an open handle; see lib/cron-exit.js${rest}` };
}

// bookRecorder: the spec-07 round-2 corpus is accumulating live and cannot be
// backfilled — Binance serves no order-book history. A recorder that dies
// silently costs days of irreplaceable data, which is the same failure shape as
// the 158 hung crons and the 24h margin lock: nobody was watching.
//
// 2026-09-06 — WHY THIS GREW A SELF-HEAL. The recorder stopped writing at
// 2026-08-14T04:01Z and did not write again until a hand restarted it on
// 2026-09-06: 23 days, ~33,600 minutes of unbackfillable corpus, gone.
// Detection was never the problem. The freshness check above caught it in 24
// minutes (strike 1 at 04:20Z, alert at 04:25Z) and then posted 144 alerts to
// #blofin-recon, every 2h, for twelve days. Only 6 failed to send; ~138 landed
// and were read by nobody. pm2 showed `online` the whole time — the process was
// alive in a reconnect loop, so nothing looked wrong at a glance.
//
// The missing link was remediation, not detection. Docker has had a self-heal
// since day one (`open -g -a Docker`); the recorder had a sentence of advice in
// an embed. It now restarts itself on the same pattern, because one
// `pm2 restart book-recorder` is what eventually fixed it.
//
// Two failure modes are covered, and they are not the same shape:
//   stale — no rows at all (dead process, or the observed reconnect loop).
//           Cross-checked against the newest .ndjson mtime so a state file that
//           advances while the corpus file does not cannot read as healthy.
//   empty — rows still arriving but structurally empty. Any inbound frame
//           writes a minute row, so the market-wide liquidation feed alone is
//           enough to keep rows flowing with the depth and tick feeds dead.
//           Freshness reads that as perfectly healthy; it is a silent write of
//           worthless rows. Same shape as the 2026-07-27 liq-route bug, which
//           produced a day of rows with liqN structurally 0.
//
// Pure so test/watchdog-book.test.js can drive it; skips entirely when the
// recorder was never installed (no state file).
function evaluateBookRecorder({ state, fileAgeMin, newestFile, tailRows }, { nowMs = Date.now() } = {}) {
  const s = state;
  const rows   = Array.isArray(tailRows) ? tailRows : [];
  const ageMin = (nowMs - s.lastRowAt) / 60_000;
  const stats  = `${s.rowsWritten} rows, ${s.reconnects} reconnects`;

  if (!Number.isFinite(ageMin)) {
    return { ok: false, stale: true, detail: 'book recorder state has no usable lastRowAt' };
  }

  if (ageMin > BOOK_STALE_MIN) {
    return { ok: false, stale: true,
      detail: `order-book recorder last wrote ${ageMin.toFixed(0)} min ago (writes every minute; ${stats})` };
  }

  // State fresh but the corpus file is not: the append side is failing.
  if (Number.isFinite(fileAgeMin) && fileAgeMin > BOOK_FILE_STALE_MIN) {
    return { ok: false, stale: true,
      detail: `recorder state is fresh (${ageMin.toFixed(0)} min) but ${newestFile || 'the newest day file'} `
            + `has not been written for ${fileAgeMin.toFixed(0)} min — rows are not reaching disk` };
  }

  // Content health: a sustained run of empty minutes at the tail.
  const tail = rows.slice(-BOOK_EMPTY_RUN);
  const isEmpty = r => r && (r.gap === true || !r.samples);
  if (tail.length >= BOOK_EMPTY_RUN && tail.every(isEmpty)) {
    const gaps = tail.filter(r => r.gap === true).length;
    return { ok: false, empty: true,
      detail: `recorder is writing but the last ${tail.length} minutes carry no book data `
            + `(${gaps} explicit gap rows, samples=0 throughout; ${stats}) `
            + `— depth/tick feeds are down while rows keep flowing` };
  }

  return { ok: true };
}

// Bounded `pm2 restart book-recorder`, mirroring checkDocker's self-heal.
// Returns a sentence describing what happened, appended to the alert detail so
// the embed says whether hands are still needed.
function healBookRecorder(state, nowMs) {
  if (!state.bookRestarts) state.bookRestarts = [];
  state.bookRestarts = state.bookRestarts.filter(t => nowMs - t < BOOK_RESTART_WINDOW_MS);

  const hrs = BOOK_RESTART_WINDOW_MS / 3_600_000;
  if (state.bookRestarts.length >= BOOK_RESTART_MAX) {
    return ` — ${state.bookRestarts.length} auto-restart(s) in the last ${hrs}h did NOT fix it; `
         + `restarting has stopped. Needs hands: \`pm2 logs book-recorder\`.`;
  }
  if (!PM2_BIN) {
    return ' — pm2 binary not found; cannot auto-restart. Run `pm2 restart book-recorder`.';
  }
  try {
    execFileSync(PM2_BIN, ['restart', 'book-recorder'], { stdio: 'pipe', timeout: 30_000 });
    state.bookRestarts.push(nowMs);
    // Persist the ledger NOW, not at the end of main(): if anything downstream
    // throws before writeState(), an unrecorded attempt would let the cap be
    // exceeded and turn the self-heal into a restart loop.
    writeState(state);
    log('book recorder stale/empty — `pm2 restart book-recorder` issued');
    return ` — auto-restart issued (attempt ${state.bookRestarts.length}/${BOOK_RESTART_MAX} in ${hrs}h); re-checks next cycle.`;
  } catch (e) {
    state.bookRestarts.push(nowMs);
    writeState(state);
    return ` — auto-restart FAILED: ${String(e.message).split('\n')[0]}. Run \`pm2 restart book-recorder\`.`;
  }
}

function checkBookRecorder(state) {
  if (!fs.existsSync(BOOK_STATE)) return { ok: true };   // not installed here
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BOOK_STATE, 'utf8'));
  } catch (e) {
    return { ok: false, detail: `book recorder state unreadable: ${e.message}` };
  }

  // Newest day file: mtime as the independent witness, tail as the content probe.
  let fileAgeMin = null, newestFile = null, tailRows = [];
  try {
    const newest = fs.readdirSync(BOOK_DIR)
      .filter(f => f.endsWith('.ndjson'))
      .map(f => ({ f, m: fs.statSync(path.join(BOOK_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (newest) {
      newestFile = newest.f;
      fileAgeMin = (Date.now() - newest.m) / 60_000;
      const p   = path.join(BOOK_DIR, newest.f);
      const fd  = fs.openSync(p, 'r');
      const sz  = fs.fstatSync(fd).size;
      const len = Math.min(BOOK_TAIL_BYTES, sz);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, sz - len);
      fs.closeSync(fd);
      // Drop the leading partial line when the read started mid-row.
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (len < sz) lines.shift();
      for (const l of lines) { try { tailRows.push(JSON.parse(l)); } catch { /* skip */ } }
    }
  } catch { /* fall back to state-only evaluation */ }

  const r = evaluateBookRecorder({ state: parsed, fileAgeMin, newestFile, tailRows });
  if (r.ok) return r;
  return { ...r, detail: r.detail + healBookRecorder(state, Date.now()) };
}

// discordBot: the command interface (!analyze, !took, reactions) is read-only
// traffic TO Discord, so its failure is invisible — alerts keep flowing out via
// curl while nothing comes back in. It failed this way for weeks (23,772
// getaddrinfo errors) with every other class green. Checks that the bot has had
// at least one successful Discord request recently, not merely that it ran.
function checkDiscordBot() {
  if (!fs.existsSync(BOT_HEALTH)) return { ok: true };   // pre-heartbeat install
  try {
    const h = JSON.parse(fs.readFileSync(BOT_HEALTH, 'utf8'));
    if (!h.lastSuccessAt) {
      return { ok: false, detail: `Discord bot has never completed a request (last error: ${h.lastError || 'unknown'})` };
    }
    const ageMin = (Date.now() - h.lastSuccessAt) / 60_000;
    if (ageMin > BOT_STALE_MIN) {
      return { ok: false,
        detail: `Discord bot last reached the API ${ageMin.toFixed(0)} min ago `
              + `(${h.consecutiveFailedRuns} failed run(s); last error: ${h.lastError || 'unknown'}) `
              + `— commands and reactions are dead` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `Discord bot health unreadable: ${e.message}` };
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
  // Read state BEFORE the checks: checkBookRecorder records its auto-restart
  // attempts into it, and writeState() at the end persists them.
  const state = readState();

  const results = {
    docker:    checkDocker(),
    mongo:     await checkMongo(),
    recon:     checkReconFresh(),
    spool:     checkSpool(),
    zombieProcs: checkZombieProcs(),
    bookRecorder: checkBookRecorder(state),
    discordBot: checkDiscordBot(),
    marginLow: await checkMarginLow(),
  };

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

// Pure evaluator exported for test/watchdog-recon.test.js. The cron entrypoint
// below is gated so requiring this module never runs a health sweep.
module.exports = {
  evaluateReconLog, RECON_WINDOW_PASSES, RECON_MAX_ERR_IN_WINDOW,
  evaluateBookRecorder, BOOK_STALE_MIN, BOOK_FILE_STALE_MIN, BOOK_EMPTY_RUN,
};

if (require.main === module) {
  main().catch(e => { console.error('[watchdog] fatal:', e.message); process.exit(1); });
}
