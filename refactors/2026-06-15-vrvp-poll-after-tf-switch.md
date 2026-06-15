# 2026-06-15 — VRVP poll after TF switch + drop poly 5M restore

## Symptom
Weekly BTC report (2026-06-08 → 2026-06-15): only 12 signals fired, 9
confirmed, 4/9 confirmed wins (44%). Wilson 95% CI on 4/9 ≈ 14%–79% —
sample noise, not a signal-quality regression.

`logs/trigger-check.log` over the trailing hour shows the real defect:

```
12:20  VRVP unavailable: no data
12:30  VRVP unavailable: no data
12:40  VRVP: 101 rows  ✓
12:50  VRVP unavailable
13:00  VRVP unavailable
13:10  VRVP: 123 rows  ✓ (only trigger that hour)
13:20  VRVP unavailable
13:30  VRVP unavailable
```

~75% of polls read an empty VRVP histogram and could not evaluate any
zone — silently dropped on the floor. Signal volume was half-gated for
the whole week.

## Root cause
1. **`scripts/trigger-check.js`** — After `setTimeframe('30')`, the
   indicator data source is reachable before the histogram is rebuilt.
   The fixed 1500ms settle was missing the populated histogram most
   polls. Likely worsened by LuxAlgo SMC having drifted onto the BTC
   tab (extra render budget on every TF switch).
2. **`scripts/poly/btc-5/trigger-check.js:440`** — End-of-run
   `setTimeframe('5')` "restore" yanks the chart back to 5M every 5
   minutes. The next BTC trigger-check (10-min cadence) then has to
   re-switch 5→30, hitting the recompute window described above.

## Fix
- **BTC trigger**: replace fixed 1500ms wait + single VRVP read with a
  polling loop (8 attempts × 500ms, after a 600ms initial settle).
  Bails out the moment `rows.length > 0`. Worst case ~4.6s, typical
  ~1s. Logs attempt count so we have data for tuning.
- **Poly BTC-5 trigger**: remove the end-of-run `setTimeframe('5')`.
  Chart now stays on 1H between Poly runs. Each script asserts the TF
  it needs at the top of its own cycle, so leaving the chart wherever
  the last script left it is safe.

## Files
- `scripts/trigger-check.js` lines ~2001–2030 — VRVP polling loop
- `scripts/poly/btc-5/trigger-check.js` line ~440 — removed restore

## How to verify
- Tail `logs/trigger-check.log` over the next hour. New log line is
  `VRVP ready in N attempt(s)` — N should be 1–3 normally. Any
  `VRVP unavailable after 8 attempts` is the new failure mode (real
  indicator absence, not a settle race).
- Watch the chart: TF should no longer slam back to 5M every 5
  minutes. Expect it to sit on 1H most of the time (last frame of the
  Poly sweep), with 30M flashes from BTC trigger every 10 min.

## Pre/post metrics
Baseline this fix with `scripts/audit/win-rate-diff.js` — capture now
(2026-06-15), re-run after ≥30 days. Expect:
- Signal volume per week to ~2–3× (most of the dropped polls become
  evaluated triggers).
- Confirmed win rate to revert toward the longer-run mean. The 44%
  number was a tiny-sample artifact; what matters is the trajectory
  with full signal volume restored.

## Out of scope (separate cleanup)
LuxAlgo SMC indicator is loaded on the BTC tab. Per `CLAUDE.md` the
BTC tab is supposed to be VRVP-only. Visual clutter; doesn't break
the script (reads VRVP specifically) but may contribute to slow TF
recomputes. Operator cleanup: drop LuxAlgo SMC from the `🕵Ace` BTC
tab.
