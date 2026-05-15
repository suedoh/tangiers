# BTC `!took` / `!exit` Activation
**Status:** DONE — shipped 2026-05-15
**Owner:** suedoh
**Supersedes activation guidance in:** [../TODO.md](../TODO.md) (Phase 2 section), [memory project_phase2_plan.md](https://github.com/anthropics/claude-code/issues)

## What changed

Phase 2 execution tracking (`!took` / `!exit`) activated for BTC. The data gate (10+ confirmed closed trades) was massively exceeded — current state is 555 confirmed closed trades — so the only blocker remaining was the early-return guards.

### Files

| File | Change |
|---|---|
| [scripts/discord-bot/handlers/btc.js](../scripts/discord-bot/handlers/btc.js:162) | Replaced Phase-1 stubs with real `handleTook` / `handleExit` (mirrors BZ pattern; does NOT write back to `trades.json` since BTC outcomes are auto-tracked) |
| [scripts/weekly-report.js](../scripts/weekly-report.js:186) | Uncommented `myTrack` block in `analyse()`; replaced executionLines stub in `formatReport()` with real selectivity %, wr-vs-system, R-vs-system |
| [../.gitignore](../.gitignore) | Added `my-trades.json` and `bz-my-trades.json` |

### BTC-specific design choices vs BZ pattern

- **No partial close (`!take`).** BTC TPs are widely spaced; partial closes would clutter without giving useful resolution per the current setup geometry.
- **`!exit` does NOT modify `trades.json`.** BZ's `handleExit` writes back to `bz-trades.json` because BZ has no auto-outcome tracking. BTC's `updateOutcomes()` polls every 10 minutes and resolves outcomes on the full signal set, so the system-wide track is authoritative; `my-trades.json` is the *personal* track only.
- **24-hour stale-signal guard.** A signal older than 24h can't be `!took` — at that point it's not a current entry decision.

## How to use

```
!trades                                  → list open signals with IDs
!took <id>                               → log YOUR entry on that signal
!exit tp1                                → log exit at TP1 price
!exit manual <price>                     → log a manual close at <price>
!exit stop                               → log stop hit
```

Weekly report (Monday 09:00 UTC) now includes a "**YOUR EXECUTION**" section:

```
You took: N closed | M open | Selectivity: X% of confirmed signals
Your wr: NN% (WW/LL) | vs system confirmed: +/-Xpp
Your avg R: +/-X.XXR | vs system: +/-X.XXR | Total R: +/-X.XXR
```

## Risk

- Low. `!took`/`!exit` only write to `my-trades.json`. No signal-pipeline code paths touched.
- `my-trades.json` is gitignored (personal trading data). State is local-only.
- Metrics protocol doesn't apply — this is execution tracking, not signal selection or scoring.

## Verification

- Syntax: `node -c` on both files passes
- Handler smoke-test: log-entry / dup-attempt / unknown-id / exit-tp1 / exit-when-none-open all behave correctly
- Render smoke-test: empty / open-only / closed-with-comparison all produce sensible output

## Note for future audits

`my-trades.json` is NOT imported to MongoDB. If this dataset grows large or needs cross-machine sync, add a `normalizeMyTrades()` in [scripts/migrate/import-trades.js](../scripts/migrate/import-trades.js) with `instrument: 'BTC-MY'`. Not needed yet.
