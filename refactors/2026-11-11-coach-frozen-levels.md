# Coach lines frozen at the daily close (2026-11-11)

**Symptom.** The 74,050 floor the coach had been teaching all night disappeared from the learner's chart at 5 AM EST.
No message said why. The box silently widened to 73,715-74,909.

**Cause.** `keyLevels()` (`.claude/watchers/entry-check.js`) built the 14-day volume profile from a window ending at
the current minute, and the coach refreshed it every 1-2 hours. As each hour dropped out of the window, the VAL drifted:
74,050 (3 AM) -> 73,807 (4 AM) -> 73,599 (6 AM). At 73,807 it fell within 0.15% of the fixed 73,715 and was merged away.

**Fix.**
- `rawLevels()` anchors the profile window to the last daily close (00:00 UTC, 7 PM EST). Within a day the lines
  cannot move. `keyLevels()` = `mergeLevels(rawLevels())`, so every caller gets the anchored lines.
- The coach's `loadLevels()` refreshes once per UTC day (it used to be `T - levelsAt > H`, which on hour boundaries
  meant every 2h). It diffs the new raw levels against the old by name and stores what moved (>0.05%), including
  lines that now sit on top of another one.
- The next MARKET MAP prints `LINES MOVED at the 7:00 PM EST daily close` for moved lines within 3% of price, and is
  forced out even if the trend and box are unchanged.

**Effect today.** Anchored to Nov 10 7 PM EST, VAL = 74,050 again, the line the learner saw overnight.

**Verified.** A scratch harness covered a moved line (74,400 -> 74,050), a line merged onto 73,715, and the map's
wording. The live coach reloaded the lines and redrew the chart (74,050 back as a ceiling, box 73,715-74,050),
confirmed through the chart's shape list. TradingView was hidden, so no fresh screenshot of the result.
