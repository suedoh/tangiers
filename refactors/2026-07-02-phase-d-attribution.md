# Phase D attribution — trades.json vs exchange ground truth

**Date:** 2026-07-02
**Status:** ANALYSIS COMPLETE — verdict below; three execution decisions pending user sign-off.
**Tool:** `scripts/audit/phase-d-attribution.js` (re-runnable; re-run at the real D→E gate)
**Data:** 18 placed signals joined to `blofin_orders` + full exchange fills-history (per-fill `fillPnl` + `fee`, exchange-computed). Dollar reconciliation ties to the account within funding noise: +$123.93 cohort − $1.22 probes/trims − ~$11 funding ≈ +$111.59 actual balance change.

## Verdict

**The systematic delta is −0.71R per signal (threshold in TODO was 0.2R — exceeded 3.5×), and the drift is structural, not noise. Per the pre-registered decision rule: pivot Phase D evaluation to exchange fills as ground truth.** trades.json stays as the signal log; it cannot serve as the P&L baseline because the two tracks don't even share a payoff function (see cause 1).

| | n | ΣR |
|---|---|---|
| trades.json hypothetical (comparable pairs) | 11 | **+6.0R** |
| Exchange realized, net of fees (same 11) | 11 | **−1.82R** |

9 of 11 deltas negative (sign test p≈0.065; magnitude is what matters at n=11). Mean |Δ| = 1.38R.

**The uncomfortable dollar truth:** the strategy-attributable execution book is **−$47.74** (comparable −$18.53 + no-hypothetical signals −$29.21). The account is only +7.4% because closing the legacy Jun-17 net short banked a **+$171.67 windfall** that belongs to no Phase-D signal. Modeled edge is NOT currently surviving execution — measured now, with $0 at stake. This is Phase D doing its job.

## Four causes, decomposed

### 1. Payoff-model mismatch (largest, affects every winner)
Bar-walk credits the FULL position at the furthest TP touched (`tp3` = +3R × whole position). The ladder takes 1/3 off per rung — **perfect execution of a tp3 outcome pays (1+2+3)/3 = 2R, not 3R**; a tp1 outcome ranges −0.33R…+2R depending on what the untracked remainder did. The ±20% D→E gate as written compares two different strategies.

### 2. Ladder priced off planned entry, not actual fill (biggest fixable defect)
Market entries chase — by fill time, price often ran through rungs. Rungs inside the fill execute instantly at ≈$0. Exhibit: `1782478838959` — a "+3R" tp3 in trades.json realized **+0.05R** (rung1 filled at −$0.11 vs plan, rung2 at ≈0, only rung3 real). Mirror image on stops: sizing uses planned entry→stop distance, but fills land closer to the stop → `1782389414281` realized **−2.49R** on a "−1R" stop (SL slippage adds more).

### 3. Entry-model mismatch — autotrade trades unconfirmed signals the strategy never takes
Autotrade enters at signal-fire; the strategy's official entry is the 30M confirmation close. 4 executed signals have `outcome=null` (never confirmed → never bar-walked → invisible to the hypothetical): net **−$29.21**, including both Jun-27 shorts SL'd at −2.36R/−1.79R on trades the strategy would call "no trade."

### 4. Net-mode cross-cancellation (4 signals unattributable)
The Jun-16 long entry partially closed the prior short; the Jun-23 long entries closed the legacy 59.9-contract short (their `fillPnl` is measured against the OLD position's cost basis — that's the +$171.67 windfall). One direction flip while a book is open poisoned 4 of 18 signals' attribution.

Also measured: **fees = $51.10 on the cohort ≈ 0.27R per signal** (6bps taker on entries + rungs that crossed). Material at B-tier sizing; the Phase D fee-drag deliverable now has its number. SL-trigger market orders never enter `blofin_orders` (matched here by size+time); recon should eventually adopt them.

## Decisions pending (in value order)

1. **Reprice the ladder + SL off the actual entry fill** (keep R geometry, drop rungs already inside the fill). Kills cause 2. Money-path change → probe first, sign-off required.
2. **Pick the entry model.** Either gate autotrade on the confirmation event (matches the strategy as validated; fewer, later entries) or keep signal-time entry and make the bar-walk track ALL placed signals from fire-time (measure what is actually traded). Measurement-only option is reversible and can ship first.
3. **One-direction book guard:** refuse (or flatten before) an entry opposite an open tracked position. Kills cause 4. One-line check against `getPositions`.
4. **Gate math:** D→E expectancy comparison moves to exchange-R vs a ladder-consistent hypothetical (mechanical recompute of trades.json R under 1/3-scaling assumptions).

## D→E gate impact

Gate restated 2026-07-02: paper-vs-model comparison uses exchange fills as truth. Clean-day clock already restarted today (ops incident). Do NOT approach Phase E until decisions 1–2 ship and ≥30 days of exchange-truth measurement accumulate on the fixed execution — current data says the edge doesn't survive execution *as currently wired*, and the causes are identified and fixable.
