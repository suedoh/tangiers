# BTC level dedupe — apply to all state-insertion sites
**Status:** DONE
**Owner:** suedoh
**Date:** 2026-05-24
**Commit:** (see follow-up)

---

## Problem

User reported 2026-05-24 09:50 UTC `#btc-signals`: two near-identical `LEVEL BROKEN` + `STOP HUNT DETECTED` pairs fired simultaneously for VAL zones $77,812–$77,872 (mid 77842) and $77,825–$77,885 (mid 77855). Same break, $13 apart in mid, same CVD/OI/price.

Cause: `markAlerted()` at [trigger-check.js:1152](../scripts/trigger-check.js:1152) had a 0.5% same-type dedupe — but **three other code paths** wrote `state[levelKey] = {...}` without going through it:

| Site | Path |
|---|---|
| [1280](../scripts/trigger-check.js:1280) | Stop-hunt re-arm (after ambiguous break, re-tracks the level with reset cooldown) |
| [1442](../scripts/trigger-check.js:1442) | Reclaim-watch promotion (4h watch graduates to active level on order-flow confirmation) |
| [1549](../scripts/trigger-check.js:1549) | Pending-confirmation graduation (flat-OI signal confirms and re-registers) |

Each of these could insert a near-duplicate of an existing entry. Over time clusters accumulated — state file at fix time held **25 duplicate levels** (e.g. 7 VAL entries clustered around $77,855).

When price sweeps through a cluster, `checkInvalidations()` iterates `Object.entries(state)` and fires one `LEVEL BROKEN` + `STOP HUNT DETECTED` pair per matching entry, capped at `MAX_INVALIDATION_ALERTS = 3` pairs (= 6 messages).

## Fix

Extracted the dedupe loop into `dedupeNearbyLevels(state, keepKey, levelType, levelMid)` and called it from all four insertion sites. Same 0.5% threshold, same same-type guard.

Also: one-time cleanup pass on existing `.trigger-state.json` — removed 25 duplicates (backup at `.trigger-state.json.bak-<ts>`). Kept the newest entry of each cluster.

## Risk

- **Selection rules unchanged.** Same triggers, same cooldowns. This is alert-noise correctness only.
- **Phase 2 observation window unaffected.** Trades fire from `markAlerted` → `triggers` path, not duplicates. The duplicates only added noise on invalidations.
- **Cleanup picked newest entry per cluster.** Cooldown timestamps are at most a few minutes off from what they'd have been if dedupe ran on insert.

## Verification

- `node -c scripts/trigger-check.js` — syntax OK
- Pre-fix state had 25 duplicate level entries; post-cleanup zero clusters within the 0.5% same-type threshold
- Next 09:50/19:50 sweep through any active VAL/VAH/HVN zone should now emit exactly one `LEVEL BROKEN` + `STOP HUNT DETECTED` pair (not 2–6)

## Decision history

| Date | Decision | Reason |
|---|---|---|
| 2026-05-24 | Extract helper, call from all 4 sites | Simpler than auditing each insertion for inline dedupe; future writes are protected by default |
| 2026-05-24 | One-time state cleanup keeps newest per cluster | Newer entries reflect more recent VRVP visible-range read; cooldown delta is minutes, not hours |
| 2026-05-24 | No code-path-level change to stop-hunt re-arm / reclaim graduation | The re-inserts are correct behavior; only the lack of dedupe was the bug |
