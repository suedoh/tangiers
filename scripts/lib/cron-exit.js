'use strict';

/**
 * Exit discipline for cron entrypoints.
 *
 * Node keeps a process alive as long as libuv has an open handle. A pooled
 * MongoClient (lib/db.js keeps 2 sockets) or a keep-alive HTTPS socket is
 * enough — so a cron script that has *finished its work* can hang forever,
 * silently, while cron keeps spawning replacements every minute.
 *
 * Measured 2026-07-26 (found during the rebuild integration, no spec owned it):
 *   trigger-check.js   158 hung processes, oldest 13d21h, ~316 idle Mongo conns
 *   discord-bot/index  5 hung processes,  oldest  7d14h,  2 Discord sockets each
 * Together ~1 GB resident and a slow leak of the Mongo connection budget.
 * See refactors/2026-07-26-cron-exit-discipline.md.
 *
 * Every cron entrypoint ends with finishCron(). It closes the Mongo pool if
 * (and only if) lib/db.js was actually loaded this run, then exits explicitly —
 * whatever else libuv is still holding is by definition work nobody is waiting
 * on. Cleanup failures never mask the run's own exit code.
 */

async function finishCron(code = 0) {
  try {
    // Don't load db.js just to close it — only close what this run opened.
    const dbPath = require.resolve('./db');
    if (require.cache[dbPath]) await require('./db').disconnect();
  } catch (_) { /* cleanup must never change the outcome */ }
  process.exit(code);
}

module.exports = { finishCron };
