# Executed track: ladder-consistent payoff + full-history rewalk

**Date:** 2026-07-04
**Files:** `scripts/lib/executed-walk.js` (new), `scripts/lib/executed-walk.test.js` (new), `scripts/blofin/rewalk-executed.js` (new), `scripts/trigger-check.js`, `scripts/lib/binance.js`
**Trigger:** audit found 4 impossible executedPnlR records (+42.7R / +42.5R / +39.4R / +15.3R)

## Two defects, one root cause each

**1. Stale pre-guard labels (the +40R records).** The executed track shipped
2026-07-02 and initially walked ALL placed signals against the trailing 7-day
CDP window. June 13–17 signals got walked from mid-history bars; the guard
(`signalTs < bars[0].time → skip`) landed the same day but never healed the
records already written. `executedPnlR` was simply `rr3` — the plan's real
geometry (tp3 at a distant zone, e.g. 42.5:1) — credited to the full position
on a phantom touch. Verified against raw Binance bars: `1782436228287`
(labeled `stop`, closedAt 06-29T00:00 — a mid-window bar) actually ran
tp1→tp2→tp3 within 90 minutes of fire, never within 580 points of the stop.

**2. First-touch full-position payoff (attribution cause 1, reproduced).**
`walkBarsForOutcome` flattens the whole position at the first level any bar
crosses. Autotrade places a 1/3 ladder + full-size SL: a perfect tp3 run pays
(rr1+rr2+rr3)/3, and a post-TP1 stop pays ⅓·rr1 − ⅔, not −1. The D→E gate
compares executed-R to exchange-R — the old payoff model made that comparison
meaningless (the exact mismatch the 2026-07-02 attribution flagged for the
canonical track).

## Fix

- **`lib/executed-walk.js`** — `walkExecutedLadder(t, bars)`: chronological
  walk, rungs bank 1/N at their own price-derived R:R, stop closes the
  remainder at −1R×remaining. Same-bar ambiguity: stop wins, rungs in that
  bar don't bank (canonical rule). Outcome label = terminal event, so `stop`
  can carry positive net R. Returns null while the ladder is live.
- **`trigger-check.js`** — executed loop swaps to the ladder walk. Canonical
  track byte-identical. Expiry rule unchanged (30d → 0R).
- **`blofin/rewalk-executed.js`** — re-runnable heal: full 30m Binance
  history (new `getKlinesRange` in lib/binance.js, paginated), recomputes all
  placed records, dry-run default, timestamped backup on `--apply`.
- **10 unit tests** including the exact June defect shape.

## Result of the rewalk (applied 2026-07-04, backup `trades.json.bak-rewalk-1783181890`)

19/29 records changed: 3 phantom tp3 → stop −1R; one phantom 15.3R → legit
6.76R full ladder; 4 June-26 shorts flipped stop → tp3 +2R (pre-guard
mislabels, Binance-verified); 11 July tp1/tp2 "resolutions" → open (only ⅓
banked — the old walk resolved the full position at first touch). Executed
track now: **n=18 resolved, +1.76R total, +0.10R/signal** (was +146.9R /
+5.25R — phantom). Still above exchange truth (fees, slippage, fill-repricing
not modeled) — expected for the chart-side hypothetical.

## Known limitations

- Cron walk still sees only the 7-day CDP window: a ladder living longer than
  7 days stops being walked and expires at 30d with 0R. **Re-run
  `rewalk-executed.js --apply` before the D→E gate** so long-lived ladders
  resolve on full history.
- Hypothetical walks plan prices, not fills — by design (like-for-like
  chart-hypothetical; exchange fills remain ground truth).
