# BTC — Tier-1 Defects Shipped (2026-05-15)

Defects identified in [btc-audit-2026-05-14-v2.md](btc-audit-2026-05-14-v2.md). All fixes are correctness against author-documented intent — no tuning. Baseline snapshot in [btc-baseline-2026-05-15.json](btc-baseline-2026-05-15.json); diff harness at [scripts/audit/win-rate-diff.js](../scripts/audit/win-rate-diff.js).

## Changes shipped

| # | File:line | What |
|---|---|---|
| **D2** | [trigger-check.js:1494](../scripts/trigger-check.js:1494) | `CONFIRM_MAX_AGE_SEC = 3600`. `checkConfirmation` now filters out trades older than the cap and only walks bars within the cap window. Pre-fix: 53 trades confirmed >1h post-fire had 32% wr (vs 76% for <1h confirms); 65 had `confirmedAt > closedAt`. |
| **D3** | [trigger-check.js:1714](../scripts/trigger-check.js:1714) | Outcome resolver now does `if (stopHit) outcome='stop' else if (tp3Hit)…`. Same-bar ambiguity → stop wins, matching commit `6a93d0d` message, BACKTESTING.md, docs/performance-tracking.md. The unreachable `else if (stopHit)` branch is removed. |
| **D1** | [trigger-check.js:1688](../scripts/trigger-check.js:1688) | `updateOutcomes` skips the TP/stop bar-walk on unconfirmed trades (`if (!t.confirmed) continue`). Expiry at 30 days still fires for both confirmed and unconfirmed, so unentered signals retire as `outcome:'expired', pnlR:0`. |
| **D7** | [trigger-check.js:1139](../scripts/trigger-check.js:1139) | `MAX_INVALIDATION_ALERTS` check now matches its name (`>= 3`, not `>= 3 * 2 = 6`). |
| **D9** | [trigger-check.js:31](../scripts/trigger-check.js:31), [1745](../scripts/trigger-check.js:1745) | `trigger-check.js` now acquires `lib/lock.js` mutex (15s wait, holder `'btc-trigger'`). Released on success, all error exits, and crash. |
| **D6** | [trades.json](../trades.json) + Mongo `trades` collection | 4 zombie setupType records (`B — Reversal` ×3, `A — Trend Continuation` ×1) renamed to `LEGACY (pre-VRVP-rewrite)` with original preserved in `legacySetupType` field. |

## Not shipped (waiting for user decision or more data)

- **D4** fill model (mid-bar wick vs close-based) — open question Q1
- **D5** probability constants stale — recalibration choice is Q2 (use spec'd weighted formula vs in-sample obs wr vs leave)
- **D8** `weeklyTrend` factor — observational only, no `false` cases in 567 trades; needs more data before changing scoring

## Pre/post comparison protocol

Baseline snapshotted at `refactors/btc-baseline-2026-05-15.json` (n=575). Re-snapshot and diff after ≥30 days of post-fix data:

```bash
# Compare current Mongo state to baseline:
node scripts/audit/win-rate-diff.js --diff refactors/btc-baseline-2026-05-15.json

# Compare only NEW trades (firedAt >= 2026-05-15) to baseline:
node scripts/audit/win-rate-diff.js --diff refactors/btc-baseline-2026-05-15.json --since 2026-05-15
```

The harness reports Wilson 95% CIs per cohort and classifies each as **IMPROVED** (current CI lower bound > baseline point), **REGRESSED** (current CI upper bound < baseline point), or **unchanged**. The four anomaly counters are explicit regression alarms:

| Counter | Baseline | Expected post-fix |
|---|---:|---|
| `unconfirmed_stops` | 7 | should NOT grow — D1 prevents new instances |
| `confirmed_after_close` | 158 | should NOT grow — D2 prevents new instances |
| `slow_confirms_over_1h` | 79 | should NOT grow — D2 prevents new instances |
| `zombie_setupType` | 0 | already cleaned via D6 |

If any anomaly grows after a code change, that change is regressing the fixes.

## Verification

- Syntax check: `node -c scripts/trigger-check.js` → OK
- Logic smoke-test: stop-wins on ambiguous bars, TP wins on clean bars, 1h confirmation cap excludes 2h+ bars, unconfirmed trades skip bar-walk — all pass
- Migrate sync: `node scripts/migrate/import-trades.js` ran cleanly after D6 — 573 updated, 2 new
