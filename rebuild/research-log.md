# Research log — every hypothesis test, forever

Spec 07.3 requires every test on the signal to be recorded here — date, hypothesis, n,
result, verdict, **including failures** — and requires that **all cells ever tested count
toward the BH-FDR q=0.10 correction**. The multiple-comparisons clock does not reset when a
result is inconvenient. This file is seeded with the tests already run by the two 2026-07-26
audits so the cell count starts honest.

**Actionability bar (spec 07.2.4):** |lift| ≥10pp AND survives BH-FDR q=0.10 AND n≥50 AND
day-clustered CI on mean R excludes zero. Anything short of all four is a hypothesis — logged,
not shipped.

## Running FDR cell count

| # | Family | Cells | Source |
|---|---|---|---|
| 1 | Segment battery (direction ×2, tier ×3, zone ×4, prob ×5) | 14 | independent audit §5 |
| 2 | Symmetric ±k×ATR skill grid (k = 0.5, 1, 1.5, 2, 3) | 5 | prior audit A4 |
| 3 | "Late signal" gap filter (all, ≤3R, ≤2R, ≤1R, ≤0R) | 5 | prior audit A5 |
| 4 | Geometry grid (k×ATR stop × m×R target, market entry) | 20 | prior audit A6 |
| 5 | A-tier symmetric inversion (tested within a 9-cell BH family) | 9 | prior audit A7 |
| 6 | Pre-registered rule battery H1–H10 at k=1 | 10 | 2026-07-26 hunt |
| 7 | Same battery at k=2 | 10 | 2026-07-26 hunt |
| 8 | Same battery at k=3 | 10 | 2026-07-26 hunt |
| 9 | Funding family F1–F6 at k=1 and k=3 | 12 | 2026-07-26 hunt |
| 10 | Walk-forward logistic model, primary margin cell, k∈{1,2,3} | 3 | 2026-07-26 hunt |
| **Σ** | **hypothesis cells tested to date** | **98** | |

Descriptive/diagnostic measurements (accounting reconciliations, calibration Brier/ECE,
autocorrelation, walk-forward buckets, random-direction nulls, the random-entry MC
falsification) are recorded below but are not hypothesis cells; they don't enter the FDR
family. When in doubt, count the cell.

**Convention for new tests:** append a row to the ledger below, add the cell count to the
table above, and re-run BH-FDR q=0.10 across the *cumulative* cell set
(`bhFDR()` in [scripts/audit/falsification.js](../scripts/audit/falsification.js)) before
claiming significance for anything.

## Test ledger

All entries below are **in-sample** on the 2026-04-13 → 2026-07-26 book (801 signals, 768
confirmed, 78 signal-days, one dominant regime — downtrend-chop). ESS after lag-1 ρ≈0.35 is
roughly half of nominal n. No out-of-sample result exists yet.

| Date | Hypothesis | n | Result | Verdict |
|---|---|---|---|---|
| 2026-07-26 | Signal has directional skill at symmetric ±1×ATR30m geometry | 768 | 47.8% [44.3, 51.3]; clustered mean-R CI [−0.17, +0.08] incl. 0 (prior A4) | **Refuted** — no detectable skill; all 5 k-grid cells' clustered CIs include 0 |
| 2026-07-26 | Signal timing beats random entries of identical geometry (MC falsification) | 801 vs 30 books | actual +964.7R at 0th pctile of random (median +1,032R [966, 1,179]) | **Refuted** — random entries beat the book (independent audit D2) |
| 2026-07-26 | Some segment (direction/tier/zone/prob) has positive honest net mean R | 775 res. | 14 cells; 8 BH-sig on claimed accounting; **zero** cells positive honest-net with CI excl. 0 | **Refuted** — no profitable subset to retreat to (§5) |
| 2026-07-26 | Long-vs-short asymmetry is tradeable (claimed 76.7% vs 60.9%, p=7.6e-6) | 775 | ladder net: long −0.301 [−0.634, +0.088], short −0.730 [−1.084, −0.430] | **Not actionable** — both ≤0 honestly |
| 2026-07-26 | A-tier is least-negative under ladder accounting | 92 | −0.094 [−0.409, +0.279] | **Not actionable** — CI includes 0 |
| 2026-07-26 | prob=85 cell is positive | 19 | +0.117 [−0.782, +0.780] | **Not actionable** — n too small |
| 2026-07-26 | VAH shorts structurally weak (claimed lift −7.5pp, BH-sig) | — | ladder −0.833 [−1.251, −0.464] | Negative like everything else; no cell-drop tuning until ledger fixed |
| 2026-07-26 | Tier ranking A>B>C is real | 775 | ranking **flips** between accountings (A>B>C ladder vs C>B>A spot-gross) | **Unmeasured** — treat all tier claims (incl. sizing multipliers) as untested |
| 2026-07-26 | "Late" signals (fired far past trigger) are the damaged cohort — filter them | 768 | monotone: gap≤0R cohort −0.416R vs all +0.063R (prior A5, 5 cells) | **Refuted, inverted** — the gap is the momentum; do not re-propose |
| 2026-07-26 | Some market-entry geometry (k×ATR stop, m×R target) clears costs | 768×20 | best cell (2×ATR, 3R) +0.097R [−0.194, +0.401]; zero of 20 cells excl. 0 | **Refuted at current sample** — widening stops lowers fee leverage, doesn't add edge |
| 2026-07-26 | A-tier is directionally *inverted* at ±1×ATR | 91 | 35.2% vs 49.4% rest; −14.2pp; mean-R CI [−0.508, −0.082]; Fisher p=1.36e-2 vs BH crit 0.0111 | **Not actionable** — misses FDR bar by a hair; second independent hint; re-test at n(A)≥150 |
| 2026-07-26 | Published tier probabilities (85/74/63) are calibrated | 775 | Brier 0.2122 / ECE 12.0pp vs claimed; Brier 0.2739 (worse than coin) vs honest ladder | **Refuted** — labels retired from all posts (spec 09.2, audit D12) |
| 2026-07-26 | Falsification harness port reproduces the audit (self-test, not a hypothesis) | 801 | skill 47.4% [43.9, 50.9] (audit 47.8 [44.3, 51.3], Δ = ATR bar-convention); MC actual 1st pctile of 200 books; ladder net −348.5R / fees 359.1R; clustered net −0.458 [−0.695, −0.224]; Brier 0.2122 | **Calibrated** — `scripts/audit/falsification.js` is the standing gate (09.1) |

## Round 2 — the exchange-native hunt (2026-07-26)

New corpus, independent of the signal ledger: **2 years of Binance BTCUSDT perp**, 35,040 30m
bars for features and **1,051,200 1m bars** for labels (both integrity-checked, **zero gaps, zero
duplicates**). Label = symmetric ±k×ATR30m barrier resolved on 1m: which side is touched first.
Ambiguity (both barriers inside one 1m bar) is **0.01%** and is excluded, never guessed;
unresolved-in-horizon 0.2–1.2%, also excluded. Base rate P(up-first) = 49.6% / 50.2% / 50.6% at
k = 1 / 2 / 3 — a driftless barrier behaves like one, which is the first sign the labels are sane.

**The bar, derived before looking at anything.** At a symmetric barrier the payoff is ±1R, so
E[R] = (2p−1) − fee(k), and fee in R scales as 1/stop-width. At the measured median ATR of 0.42%
with 6bp taker in / 2bp maker out: fee = 0.188R at k=1, 0.094R at k=2, 0.063R at k=3 ⇒ **break-even
hit rates 59.4% / 54.7% / 53.2%**. Spec 07.1's ≥55% row is only meaningful with wide stops; at
k=1 the true hurdle is ~59%. Wide stops do not create edge — they lower the toll.

**Every cell reports the always-long rate on its own rows.** BTC drifts; drift is free and is not
skill. Without that column, family 9 below would read as a discovery.

| Date | Hypothesis | n | Result | Verdict |
|---|---|---|---|---|
| 2026-07-26 | Rule battery H1–H10 (momentum, range reversion, taker-flow continuation + its inverse, VWAP reversion, trend-pullback, vol-conditioned variants) at k=1 | 33,187 bars | best cell H5-imbCont **51.2%** [50.3, 52.2] vs break-even 59.4%; 0 of 10 survive cumulative BH-FDR | **Refuted** |
| 2026-07-26 | Same battery at k=2 (lower fee hurdle) | 32,993 | best **51.7%** vs break-even 54.7%; 7 cells BH-sig *within* the battery, none economic | **Refuted** |
| 2026-07-26 | Same battery at k=3 | 32,866 | best **51.8%** vs break-even 53.2%; apparent "wins" (H4/H8/H10 inverses) are all ≤ their own always-long rate | **Refuted** — statistically real, economically nothing |
| 2026-07-26 | My own prior: taker aggressor imbalance (order flow) carries directional information | 10,294–10,359 | H5 51.2 / 51.7 / 51.8% across k; inverse H6 symmetric below 50. Best drift-adjusted lift **+1.2pp** | **Refuted — explicitly.** Order flow was the hypothesis I most expected to survive; it did not |
| 2026-07-26 | ANY linear combination of 13 features predicts the barrier out-of-sample (walk-forward logistic, 180d train → 30d test, 17 folds, ~24.3k OOS rows) | 24,421 / 24,300 / 24,196 | OOS hit **51.5% / 50.9% / 49.7%** at k=1/2/3 vs break-even 59.4 / 54.7 / 53.2. Drift-adjusted lift +0.5 / +0.3 / **−0.3**pp | **Refuted** — the strongest form of the test; at k=3 the model is worse than buy-and-hold |
| 2026-07-26 | Funding-rate positioning (family F1–F6, top/bottom trailing-30d decile, fade and follow) | 2,855–33,187 | k=1: nothing (best 51.4% vs 59.4%). k=3: **F2 "top-decile funding → long" hits 56.6% vs 50.6% base, +6.0pp, p=1.4e-12** | **Lead — then refuted, see below** |
| 2026-07-26 | The F2 funding lead is real | 2,855 rows | Killed on all four checks: **(1) independence** — 2,855 overlapping rows are ~50 independent weeks / 182 settlements; 7-day block bootstrap **[48.1%, 64.9%]** includes 50%, and the strictly non-overlapping subsample is n=59, 52.5% [40.0, 64.7]. **(2) regime** — 2025 66.9% but 2026 **49.9%**, 2024 52.9%; +10.9pp in uptrends, **−2.8pp in downtrends**. **(3) novelty** — high funding *without* momentum hits **45.9%**, so it carries no information beyond momentum. **(4) economics** — gross **+0.133R** vs the spec's ≥+0.25R bar, and **−0.101R** at the lower block bound | **Refuted** — the naive CI was an artefact of overlap |

**Round-2 conclusion.** Across 42 new hypothesis cells and a walk-forward model on 2 years of
exchange-native data, **nothing produced a directional edge that clears its own transaction
costs.** The one cell that looked like a discovery dissolved the moment the sample was corrected
for overlap. This is spec 07's explicitly permitted terminal outcome — *"No viable signal found"
is an acceptable terminal outcome of this spec. Shipping a signal that hasn't passed the bar is
not."*

**Scope of the claim — what was NOT tested** (so this is a bounded finding, not a proof of
market efficiency): order-book microstructure (depth/queue — no historical feed), open-interest
history (Binance caps it at 30 days), cross-asset and ETF-flow features, holding periods beyond
72h, timeframes above 30m, sub-minute execution effects, and non-linear/interaction learners
(deliberately excluded — at effect sizes of ~1pp a flexible learner fits noise).

Tooling, all reusable and read-only: [scripts/research/](../scripts/research/) —
`fetch-history.js`, `build-dataset.js`, `hypotheses.js`, `walkforward-model.js`,
`funding-test.js`, `funding-deepdive.js`. The battery was validated against synthetic data with a
**planted 60% edge**, which it recovered at 60.3% (p=1.3e-38) while scoring unrelated rules at
~50% — so a real edge of that size would not have been missed.

## Open hypotheses queue (test when sample bar is met — spec 07.1: ≥150 post-fix signals, ≥60d, ≥2 regimes)

- Re-measure the current signal at ≥1.0×ATR structural stops on the corrected ledger
  (first experiment per spec 07.3 — cheapest path; audit could not rule out that geometry,
  not zone logic, destroys the edge).
- Regime conditioning (only a downtrend-chop regime is sampled to date).
- Confirmation-strength filters.
- Zone-type splits (tier/zone ranking currently accounting-dependent).
- A-tier inversion re-test at n(A) ≥ 150 (two independent hints, both sub-bar).
