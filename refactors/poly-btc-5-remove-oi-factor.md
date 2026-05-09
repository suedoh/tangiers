# Poly BTC-5 — Remove OI Rising Factor

## What was changed

Removed `oiRising` (Factor 4) from the 5-factor scoring model in both `trigger-check.js` and `analyze.js`.

- Deleted `oiRising` from `evaluate()` params, `factors` object, and `scoreFor()`
- Removed `oiPrev` / `state._previousOI` state tracking (no longer needed)
- Removed OI line from Discord embed in both files
- Renumbered factors 4→cleanAir, 5→goodSession
- Max score: 7 → 6 (makes the existing `score/6` display accurate for the first time)
- Threshold unchanged at ≥5

## Why it was removed

Evidence from 1,243 bars (7 days) with 148 signaled events:

| OI state | Win rate | n |
|---|---|---|
| OI rising (factor green) | 41.7% | 12 |
| OI not rising (factor red) | 58.8% | 136 |

Lift: **-17.2pp**. The only factor with both a large and directionally negative lift. When OI rising triggered, the system performed below the 50% market baseline.

Hypothesis for why: at 5-minute resolution, rising OI may indicate late positioning or trend exhaustion rather than directional conviction. The BTC trigger-check.js uses the same OI-rising logic correctly at the 10-minute timeframe for a different purpose (pending confirmation), but at 5M scale it inverts.

## Risk

Low. The signal threshold (≥5) is unchanged. Removing 1 point from a 7-point max means:
- Bars that scored exactly 5 only because OI was rising will no longer signal — these were the worst-performing cohort.
- Bars that scored ≥5 without OI are unaffected.
- Net effect: signal rate decreases slightly, expected win rate increases.

State cleanup: `state._previousOI` entries already written to `.poly-btc-5-state.json` are harmless orphans — the key is simply never updated again.
