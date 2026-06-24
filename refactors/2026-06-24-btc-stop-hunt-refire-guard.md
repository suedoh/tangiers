# BTC stop-hunt re-fire guard

**Date:** 2026-06-24
**File:** [scripts/trigger-check.js:1234-1289](../scripts/trigger-check.js#L1234)
**Predecessor:** [2026-05-24-btc-level-dedupe-all-sites.md](2026-05-24-btc-level-dedupe-all-sites.md)
**Status:** Live on host crontab.

## Problem

User report 2026-06-24 ~20:00 UTC: `#btc-signals` received the same
`⚠️ LEVEL BROKEN — POSSIBLE STOP HUNT` + `🎯 STOP HUNT DETECTED — LONG RE-ENTRY`
pair every 10 minutes for `val-60370` (VAL $60,340–$60,400) while price chopped
$59.6k–$61k below the broken level. State file held 20 `_signal_messages` for
that level inside ~3 hours.

## Root cause

`checkInvalidations()` iterates `Object.entries(state)` every poll and fires the
break-alert pair for any level where `isLevelBroken` is true. The only gates
were `key.startsWith('_')` and presence of `direction` + `levelMid` — no
"this break already alerted" check.

After firing, the function re-arms the level at [trigger-check.js:1286](../scripts/trigger-check.js#L1286)
with `ts = now - (COOLDOWN_MS - 30min)` so it can re-trigger proximity-based
approaching alerts after 30 minutes. The May 24 refactor explicitly preserved
that re-arm behavior. What May 24 did **not** address: when the next 10-min
poll finds the same re-armed level still broken (price hasn't reclaimed yet),
the broken-level loop runs again with no gate and re-fires.

`COOLDOWN_MS` (1h) gates the proximity-approach branch elsewhere in the file,
not the invalidation branch. Different code paths, same state entry.

## Fix

Two lines, single function:

1. At the re-arm site (line 1286), stamp the level with `stopHuntFiredAt: Date.now()`.
2. At the top of the broken-level branch (after the `levelMid` presence check),
   skip if `entry.stopHuntFiredAt && Date.now() - entry.stopHuntFiredAt < 4h`.

4h window matches the existing `_watch_${key}.expires` reclaim-watch lifetime
(line 1284) — same horizon for "this break event is still in scope".

## What stays the same

- **The re-arm at line 1286 still runs.** May 24's explicit design decision is
  preserved: after a stop-hunt, the level re-enters state with a fresh 30-min
  proximity cooldown so it can fire approaching alerts when price drifts back.
- **The `_watch_${key}` reclaim-watch still arms.** When price climbs back
  through the level with order-flow confirmation, the watch graduates to an
  active level at [trigger-check.js:1442](../scripts/trigger-check.js#L1442)
  (one of the four sites May 24 deduped). A graduating watch creates a fresh
  state entry with no `stopHuntFiredAt`, so the guard does not block reclaim
  setups — the guard is per-state-entry, not per-level.
- **Setup-tier scoring, proximity triggers, `markAlerted`, autotrade hook at
  [line 2279](../scripts/trigger-check.js#L2279)** — all untouched. The
  invalidation branch never reached autotrade; this fix is alert-noise only.

## Risk

- Zero impact on BloFin recon or autotrade — different code path.
- Zero impact on setup-catch probability — proximity branch unchanged, reclaim
  promotion unchanged. The guard only suppresses repeat stop-hunt alerts on a
  level that's still broken from the same event.
- If a level genuinely "re-breaks" after a reclaim, the reclaim-graduation
  path creates a fresh state entry without `stopHuntFiredAt` → new break event
  alerts normally.
- 4h horizon is conservative: if a level stays broken for 4+ hours, by then it
  is rarely structurally relevant; a re-fire after 4h is acceptable.

## Verification

- `node -c scripts/trigger-check.js` — syntax OK
- Pre-fix state had 20 `_signal_messages` for `val-60370` since 12:00 UTC.
- Next cycle that finds `val-60370` still broken should log
  `Level val-60370 broken | ... | verdict: STOP HUNT | re-fire guard armed (4h)`
  on the first hit and **silently skip** for the remaining cycles inside the
  4h window.

## Companion ops cleanup (same session)

Independent of the code change, the debugging pass also:

- Killed 9 zombie `trigger-check.js` processes dating to Jun 16/17/22/23 (cron
  invocations that hung in CDP wait and never exited). Symptoms: low CPU, `S`
  state, holding no lock (TTL 60s already expired). No follow-up code change
  yet — open question: should `cdpConnect()` get a global hard timeout? Flagged
  as a separate follow-up.
- Fixed `discord-bot/index.js` DNS failures (`getaddrinfo ENOTFOUND discord.com`)
  by forcing `dns.setDefaultResultOrder('ipv4first')`. Node 22's default
  verbatim ordering preferred AAAA on this host, which intermittently failed.
  This restored 📊 reactions and `!analyze` / `!took` / `!exit` commands.

## Decision history

| Date | Decision | Reason |
|---|---|---|
| 2026-06-24 | 4h window for re-fire guard | Matches existing `_watch_${key}.expires`; same "break event in scope" horizon |
| 2026-06-24 | Per-state-entry flag, not per-level dedupe | Reclaim-graduation creates a fresh state entry — that path should be allowed to fire if it re-breaks |
| 2026-06-24 | Preserve May 24 re-arm behavior | Orthogonal concern; the May 24 design intent (re-arm with 30-min cooldown for proximity triggers) remains correct |
