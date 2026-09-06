# 2026-09-06 — the order-book recorder alerted 144 times and still lost 23 days

**Symptom.** `data/orderbook/` covers 2026-07-26 → 2026-08-14 and then stops. The
recorder wrote its last row at **2026-08-14T04:01Z** and did not write another
until a hand ran `pm2 restart book-recorder` on **2026-09-06**. ~33,600 minutes of
order-book history — the one dataset in this project that **cannot be backfilled**,
because Binance serves no depth history — are permanently gone. `pm2 status` said
`online` throughout: the process was alive in a reconnect loop.

**The detection worked. That was never the problem.**

| | |
|---|---|
| Last row | 2026-08-14T04:01Z |
| Watchdog strike 1 | 04:20Z — **19 min later** |
| Alert posted | 04:25Z — **24 min later** |
| Alerts posted, 08-14 → 08-26 | **144**, one every 2h |
| Alerts that failed to send | 6 (`getaddrinfo ENOTFOUND discord.com`) |
| Alerts that landed in `#blofin-recon` | **~138** |
| Anything that changed as a result | **nothing, for 12 days** |

The freshness check added in `4e955d9` did its job perfectly on the first try. It
then repeated itself 143 more times into a channel where it changed nothing. The
gap between "the system knows" and "the system is fixed" was a human typing one
command, and that human never typed it.

**Root cause.** No remediation path. `checkDocker` has had a self-heal since day
one (`open -g -a Docker`); `checkBookRecorder` had a sentence of advice inside a
Discord embed. Alerting is not remediation, and an alert that repeats 144 times
without effect is not a safety net — it is a log line with a webhook attached.

## Fix

`scripts/ops/watchdog.js`

1. **Bounded self-heal** (`healBookRecorder`, :419). `pm2 restart book-recorder`
   on the first failing check — not at alert time, so it fires at strike 1 while
   the alert still waits for strike 2. Capped at **3 restarts per 6h**, ledger in
   `.watchdog-state.json.bookRestarts`, persisted *immediately* on each attempt so
   a later throw cannot reset the cap into a restart loop. Past the cap it stops
   restarting and the alert escalates to "needs hands". One `pm2 restart` is
   exactly what cleared the real outage, so this is the loop that was missing.

2. **`PM2_BIN` resolution** (:76). pm2 is **not on the cron PATH**
   (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`) — it lives under nvm.
   `execFileSync('pm2', …)` from cron would ENOENT, making the self-heal a silent
   no-op: the same class of failure this check exists to end. Resolved explicitly
   like `DOCKER_BIN`, globbing nvm rather than pinning a version. Verified under a
   scrubbed cron env.

3. **Content health** (`evaluateBookRecorder`, :380). A minute row is written by
   *any* inbound frame, so the market-wide liquidation feed alone (~25 msg/min) is
   enough to keep rows flowing with the depth and tick feeds dead — fresh rows,
   zero book data, and freshness reads it as perfectly healthy. Ten consecutive
   `samples=0`/`gap` rows now strike. Threshold set from the corpus itself: the
   19 days contain 24 scattered empty rows and 393 gap rows, so short runs are
   routine and must stay green.

4. **File-vs-state cross-check** (:396). `writeRow()` appends to the day file and
   *then* rewrites the state file. A state file advancing while the newest
   `.ndjson` mtime does not means the append side is failing and every "fresh" row
   is going nowhere.

`test/watchdog-book.test.js` — 10 tests on the pure evaluator, built from the real
incident's numbers (`25396 rows, 6716 reconnects`), covering both detection
shapes, the file/state divergence, the sub-threshold cases that must stay green,
and the short-tail start-up case.

**Verification.** All four paths driven against the live corpus file. Self-heal
proved end-to-end by injecting the real 24-min-stale shape: restart issued,
`restart_time` 1→2, recorder reconnected both feeds, ledger recorded 1/3, no alert
at strike 1. Cap proved by preloading 3 attempts: no restart issued
(`restart_time` unchanged), message escalated. 55/55 tests pass.

**What this does not fix.** Why the recorder cannot recover from its own reconnect
loop — 6,716 reconnects preceded the stall and the process never re-established a
usable connection. The watchdog now papers over that from outside. The loop itself
is untouched and still unexplained.

**Generalises to.** Every class in this watchdog is detect-and-tell. `docker` is
the only other one that acts. `zombieProcs` (158 hung crons, two weeks) and
`discordBot` (23,772 errors, weeks) are both the same story as this one: detection
that worked, correctly, into a void. Both are `pm2`/`kill`-remediable and neither
remediates.
