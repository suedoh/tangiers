# BTC CDP TF-switch race — audit + fix

**Date:** 2026-05-15
**Scope:** `scripts/mtf-analyze.js`, `scripts/trigger-check.js`

## Issue
Both BTC scripts switched TradingView timeframes via `setResolution(tf, function(){})` (fire-and-forget) followed by a fixed sleep (2500ms in `mtf-analyze`, 1500ms in `trigger-check`). No polling confirmation that the TF actually loaded before indicator reads fired.

## Evidence
- `logs/trigger-check.log`: 470 / 99,294 lines match `retry|null|confirm|stale|recompute`. `VWAP: null` reads observed as recently as 2026-05-15T14:50, 2026-05-13T02:40, 2026-05-12T09:30.
- `trigger-check.js:1990` inline comment: pre-canonical-TF-fix, ~44% of polls fired against a 5M chart.
- Git history: 6 prior CDP-race fixes shipped (`0568503`, `340d910`, `a727514`, `8b2dc08`, `4f3a944`, `fa49885`) — all for BZ/Poly/EW. BTC's two scripts were the last on the old fire-and-forget pattern.
- Class precedent: commit `0568503` ("BTC price appearing in BZ! Catalyst cards") fixed the same race for BZ.

## Fix
**`mtf-analyze.js`:**
- New `setTFConfirmed(client, tf, timeoutMs=5000)` helper polls `resolution()` every 300ms until match (mirrors `lib/cdp.js:setTimeframe`).
- `fetchTF` now takes `prevTF` arg. Stale-detector retries if VWAP+CVD+OI all exactly equal prior TF's values (three-way exact match is statistically near-zero live).
- Sweep wired to pass each TF's result as `prevTF` to the next.

**`trigger-check.js`:**
- Canonical-TF enforcement block (line ~1994) now polls `GET_TF_EXPR` until confirmed instead of fixed 1500ms sleep. 800ms safety pause only on timeout.

## Risk
- Happy path: ~0–1500ms slower per TF switch (often faster — polling exits as soon as TF echoes back).
- Worst case: +800ms when timeout fires (same as old fixed sleep).
- No signal-logic changes. Only the read-reliability layer.

## Baseline / verification
- **Baseline NOT captured in worktree** — `scripts/audit/win-rate-diff.js` failed with MongoDB auth error (worktree `.env` not loaded). Run from primary checkout before merge:
  `node scripts/audit/win-rate-diff.js > notes/audits/baseline-pre-tf-race-fix-20260515.txt`
- After ≥30 days post-fix, diff with `--since 2026-05-15`. Expectation: drop in `VWAP: null` log lines per day; cohort win rate ≥ baseline (correctness fix, no signal-rule change).

## Open questions (not resolved by this fix)
1. Of the 470 race-flag log entries, how many overlap signal-fire timestamps in `trades.json`? Required for win-rate impact estimate. ~2 hours work.
2. `!mtf` has no output log → can't quantify its historical failure rate. Add structured logging if H below matters.

## Statistical hypothesis (deferred)
H: BTC signals fired on cycles with VWAP=null or stale CVD have different win rate than clean cycles. Needs timestamp join between log and `trades.json`, walk-forward over ≥60d.
