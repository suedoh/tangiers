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
| 11 | Rule battery H1–H10 at 4h, k = 1, 2, 3 (H7 vwap applies) | 30 | 2026-07-27 round 3 |
| 12 | Rule battery H1–H10 at 1d, k = 1, 2, 3 (H7 excluded — no intraday VWAP) | 27 | 2026-07-27 round 3 |
| 13 | H9 cut-point grid (atrPctl ×5 × momentum ×2 × k ×2) | 20 | 2026-07-27 round 4 |
| 14 | 1h cut-point grid (atrPctl ×5 × momentum ×2 × k ×3) | 30 | 2026-07-27 round 5 |
| 15 | Selective prediction on price bars (4 TF×k configs × 5 coverages) | 20 | 2026-08-03 round 6 |
| 16 | Zone signal META + DIR selective (2 models × 6 coverages) | 12 | 2026-08-03 round 6 |
| 17 | Zone replay headline + 5 zone-type cells | 6 | 2026-08-03 round 6 |
| 18 | Long-only timing filter (3 TF×k configs × 4 coverages) | 12 | 2026-08-03 round 6b |
| 19 | Funding carry (3 fee models × 6 hold periods) | 18 | 2026-08-03 round 7 |
| 20 | Cross-sectional carry (2 fee models) | 2 | 2026-08-04 round 8a |
| 21 | Swing: trailing-stop grid ×5 + symmetric always-long ×3 | 8 | 2026-08-04 round 8b |
| **Σ** | **hypothesis cells tested to date** | **283** | |

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

## Round 3 — higher timeframes, where the toll is smaller (2026-07-27)

**Why this round.** Fee-in-R scales as 1/stop-width, so the 59.4% break-even that killed
rounds 1–2 is a property of *30-minute geometry*, not of the market. Rounds 1–2 searched
only 30m. This round holds the method fixed and raises the bar duration.

**Corpus.** Binance USDT-M perp, **2019-09-08 → 2026-07-27** (vs 2y before): 2,515 1d bars,
15,084 4h bars, **zero gaps, zero dupes**. Labels resolved on **723,971 5m bars** (also zero
gaps) rather than 1m — at daily-ATR barrier widths a 5m bar straddling both barriers is
vanishingly rare, and the measured ambiguity confirms it (0.00–0.07%). The window spans the
2021 bull, the 2022 bear, and the 2024–26 cycle, so the ≥2-regime requirement is met by data
rather than by waiting.

**`build-dataset.js` was 30m-only** despite taking file arguments — `t[i] + 1_800_000` for the
bar close plus every lookback as a bar count tuned to 30m (12/48/336/1440). Now parameterised
by `--bar` with per-timeframe windows. **Regression-checked: rebuilding 30m k=1 reproduces all
16 features on all 33,187 shared rows with zero mismatches**, so round-1/2 numbers stand. The
new build yields 323 extra rows because the old warmup summed two *overlapping* windows.

**The economics, measured per timeframe (6bp taker in / 2bp maker out):**

| TF | k | median ATR | stop | fee | break-even | always-long |
|---|---|---|---|---|---|---|
| 30m | 1 | 0.43% | 0.42% | 0.188R | **59.4%** | 49.6% |
| 4h | 1 | 1.57% | 1.57% | 0.051R | **52.6%** | 50.8% |
| 4h | 2 | 1.55% | 3.11% | 0.026R | **51.3%** | 51.1% |
| 1d | 1 | 4.17% | 4.17% | 0.019R | **51.0%** | 53.9% |
| 1d | 3 | 4.05% | 12.16% | 0.007R | **50.3%** | 56.7% |

(30m reproduces the spec's published 59.4/54.7/53.2 exactly — the cost model is calibrated,
not re-derived.) **The thesis is confirmed structurally: the hurdle falls from 59.4% to ~51%.**
But note the last column — at 1d, *always-long alone* (53.9–56.7%) already clears break-even.
At daily scale the fee hurdle stops being the binding constraint and **drift** becomes the
thing to beat. Every result below is therefore reported against always-long, not against 50%.

**Result: 12 of 57 new cells clear their own break-even on day-clustered CIs — where 0 of 98
did at 30m.** Under cumulative BH-FDR (q=0.10, 155 cells), and against spec 07.1's full
actionability rule (≥10pp lift AND FDR AND n≥50 AND CI clearing the floor): **0 actionable.**
Five of the twelve are worse than simply being long once drift is netted out.

| Date | Hypothesis | n | Result | Verdict |
|---|---|---|---|---|
| 2026-07-27 | Raising the timeframe lowers the fee hurdle enough to expose an edge | 57 cells | hurdle 59.4%→50.3%; 12 cells clear break-even vs 0 at 30m; best E[R] +0.183R | **Confirmed structurally** — geometry, not zone logic, was destroying round-1 economics |
| 2026-07-27 | H5-imbCont (order flow) at 1d is real | 713–788 | k=3: 59.5% overall, but walk-forward **68.3% → 50.7%** and regime **+10.3pp uptrend / −10.8pp downtrend**; E[R] +0.359 → +0.007 across halves | **Refuted** — the exact funding-lead signature: decays out of sample, and is drift wearing a costume |
| 2026-07-27 | H9-trendHiVol (momentum conditioned on top-30% vol) at 4h is real | 3,688–4,106 | k=1: 55.1% [52.7, 57.8] clustered vs 52.6% break-even, ESS 1,586. **Positive E[R] in BOTH regimes and BOTH chronological halves** at k=1 and k=2. Edge concentrated where drift fails: downtrend lift **+8.9pp** (always-long 45.5%), uptrend lift ≈0 | **Lead — survives round 1 of killing** |

**Why H9 is not the funding lead repeating itself.** The funding cell died because its
apparent edge was long-bias: +10.9pp in uptrends, −2.8pp in downtrends. H9 has the *opposite*
shape — it merely matches buy-and-hold in uptrends (lift −0.5pp) and does its work in
downtrends where always-long loses (45.5% → 54.4%). It is also stable across k=1/2/3 and
across both halves of a 7-year window, rather than living in one barrier width and one year.

**Why it is still not actionable, and must not be traded.**
1. **E[R] +0.051R (k=1) to +0.129R (k=2) vs the spec's +0.25R bar.** It misses, at every k.
2. **Lift over always-long is +4.7pp vs the 10pp actionability threshold.** Misses.
3. **It is the best of 57 cells, chosen after seeing results.** The halves test is a weak
   walk-forward; a rolling-refit OOS test has not been run.
4. **H9 is vol-scaled time-series momentum** — a documented, widely-harvested risk premium,
   not a discovery. That it only survives fees at 4h+ is exactly what you'd expect of a
   well-known effect in a liquid market: it is arbitraged at the timeframes people trade.
5. Spec 07.1's +0.25R bar was derived from *30m* fee economics (fee floor 0.10–0.20R + margin).
   At 4h the floor is 0.026–0.051R, so the same reasoning implies a lower bar. **Whether the
   bar should scale with timeframe is an operator decision and must be made BEFORE the next
   round, not after seeing that a lower bar would pass this cell.** Recording it here so the
   decision is timestamped independently of the result.

**Round-3 conclusion.** The 30m dead end was partly a geometry problem, and that is worth
knowing: measurement at 4h/1d is where any future search should live. One lead survived its
first two killing tests, which is one more than rounds 1–2 produced across 98 cells. It is a
lead, not an edge. Spec 08 live-fire stays inactive.

## Round 4 — the lead under capacity, funding and honest OOS (2026-07-27)

Tool: [scripts/research/lead-tests.js](../scripts/research/lead-tests.js). Four gates, each of
which has killed a previous candidate. **Cells: +20** (5 atrPctl × 2 momentum × 2 k grid) →
cumulative family **175**.

**The finding that matters — R/trade is the wrong unit, and it nearly fooled us.**
H9 fires on 4,106 of 14,852 4h bars, but a position is open most of the time: only **1,365 of
those 4,106 signals are actually tradeable** on a non-overlapping book. Restricted to trades you
could really take, the round-3 headline collapses:

| | per-signal (round 3) | non-overlapping book (round 4) |
|---|---|---|
| hit rate | 55.1% | **52.5%** (break-even 52.6%) |
| E[R]/trade | +0.051R | **−0.005R** |
| annual | — | **−1.0R/yr** |

The overlapping signals were correlated — clusters of wins inside single trending moves, counted
repeatedly. **This is the round-1 overlap failure wearing a new costume**, and every future
result must be reported on a non-overlapping book. Funding (11.7% annualised, 7,538 settlements
2019→2026) costs a further 0.5–4R over the book; mean hold is only 13.3h so it is not fatal, but
it is not negligible either.

**What survived: the volatility gradient, not the chosen cut-point.** Per-signal expectancy rises
monotonically with the ATR percentile across both k and both momentum definitions — 0.5→+0.002,
0.6→+0.016, 0.7→+0.051, 0.8→+0.107, 0.9→+0.132R. A smooth gradient across a grid is far better
evidence than a spike at one value. Momentum choice matters too: the 1-day lookback (`mom1`) is
**negative everywhere**; the effect lives entirely in 5–7 day momentum.

**Honest out-of-sample (choose cut-point on 2019-10→2023-11, score 2023-11→2026-07, untouched):**

| k | chosen on early data | OOS n | OOS hit | always-long | lift | net/yr | verdict |
|---|---|---|---|---|---|---|---|
| 1 | atrPctl>0.9 mom2 | 269 | 53.9% | 46.1% | **+7.8pp** | +2.53R | survives (point est.) |
| 2 | atrPctl>0.7 mom3 | 212 | 50.9% | 51.9% | −0.9pp | −0.80R | **fails** |
| 3 | atrPctl>0.9 mom2 | 66 | 63.6% | 42.4% | **+21.2pp** | +6.18R | survives |

Two of three survive a genuine OOS test, with the correct regime signature: the OOS window is the
recent downtrend where always-long *loses* (46.1% / 42.4%), and the rule beats it by 7.8–21.2pp.
That is the opposite of the funding lead, which was long-bias in disguise.

**Why it is still not tradeable.** k=1's Wilson CI on 53.9% (n=269) is ≈[47.9, 59.8] — the lower
bound sits **below** its 52.6% break-even. k=3 clears its floor but on **n=66**. And k=2 fails
outright; a real effect should not be that inconsistent across barrier width. Verdict: **the
strongest candidate the project has produced, and still short of the bar.**

**Bar recommendation (quant call, made on the UNIT argument, and the current leads FAIL it).**
Spec 07.1's "+0.25R/trade" is the wrong denominator at any timeframe — it is blind to frequency
and to overlap, which is precisely the error that made a −1.0R/yr rule look like +0.051R/trade.
Replace it with, and require simultaneously:
1. **≥ +10R/year on a non-overlapping book, net of fees AND funding** (≈10%/yr at 1% risk),
2. **OOS lower CI bound above the cell's own break-even**, not above 50%,
3. **≥10pp lift over always-long on the same entry schedule**,
4. consistency across **at least two of k ∈ {1,2,3}**.
Best current cell: k=3 at **+6.18R/yr** OOS — fails row 1, passes row 3. Nothing passes all four.

## Round 5 — the frequency/edge tradeoff is real and binding (2026-07-27)

**Cells: +30** (1h: 5 atrPctl × 2 momentum × 3 k) → cumulative family **205**.

Round 4 established the binding constraint for a fully-automated product: a rule must clear
**Sharpe ≥1.0 after selection deflation** *and* fire **≥100×/yr**, because a 24-trade/yr rule
needs eight years to reach a verifiable sample and the regime will not hold still that long.
4h had edge without frequency; 30m had frequency without edge. **1h was the untested middle.**

Corpus: 60,337 1h bars 2019-09→2026-07, zero gaps. Labels on the same 5m series.

| TF · k | break-even | best in-sample (non-overlap) | trades/yr | OOS lift vs always-long | verdict |
|---|---|---|---|---|---|
| 1h · 1 | 55.3% | **−19.9R/yr** (gross +97R, **fees −231R**) | 319 | +4.9pp | **Refuted** — fees are 2.4× gross |
| 1h · 2 | 52.7% | +6.1R/yr | 130 | +2.6pp | **Refuted** — OOS lift collapses |
| 1h · 3 | 51.8% | **+9.8R/yr @ 119 trades/yr** ← the target zone | 119 | **−0.4pp** | **Refuted out of sample** |

1h k=3 is the round's headline failure and the reason the choose-early/score-late test exists:
in-sample it looked like the answer — +9.8R/yr at 119 trades/yr is almost exactly the product
spec. Selected honestly on 2019–2023 and scored on untouched 2023–2026, it lands at 50.4% hit
against an always-long rate of 50.9% — **worse than doing nothing.**

**The tradeoff, now measured across four timeframes.** This is the round's real contribution:

| | 30m | 1h | 4h | 1d |
|---|---|---|---|---|
| fee hurdle | 59.4% | 55.3% | 52.6% | 51.0% |
| frequency | very high | high | low | very low |
| OOS edge | none | none | k=1 +7.8pp / k=3 +21.2pp | refuted |
| Sharpe (OOS, net) | — | — | 0.25 (k=1) / 1.30→**0.76 deflated** (k=3) | — |
| trades/yr | — | — | 99 / **24** | — |

**Where there is frequency, fees eat the edge. Where there is edge, frequency is too low to
verify.** No setting of the momentum × volatility family — the only family to survive 205 cells —
delivers both. That is a bounded, useful negative: it says this family cannot be automated at a
verifiable frequency, not that no edge exists anywhere.

**Consequence for the product.** There is currently **nothing to automate**. The remaining
untested feature space is the order-book corpus (decision date 2026-08-25 per 07.5), which is
genuinely independent of everything above — it is the first candidate feature set that is not a
transformation of OHLCV.

## Open hypotheses queue (test when sample bar is met — spec 07.1: ≥150 post-fix signals, ≥60d, ≥2 regimes)

- **H9-trendHiVol at 4h — the live lead (round 3).** Next gates, in order: (a) rolling-refit
  walk-forward, not chronological halves; (b) sensitivity to the 0.7 atrPctl and 24h-momentum
  choices — if the edge only exists at exactly those cut-points it is fitted; (c) operator
  decision on whether the +0.25R bar scales with timeframe, taken *before* re-scoring;
  (d) execution realism at 4h holds — funding carry over multi-day holds is unmodelled and
  can exceed the entire +0.05R edge at k=1.
- Re-measure the current signal at ≥1.0×ATR structural stops on the corrected ledger
  (first experiment per spec 07.3 — cheapest path; audit could not rule out that geometry,
  not zone logic, destroys the edge). **Round 3 partially answers this**: geometry was
  demonstrably part of the problem at 30m.
- Regime conditioning (only a downtrend-chop regime is sampled to date).
- Confirmation-strength filters.
- Zone-type splits (tier/zone ranking currently accounting-dependent).
- A-tier inversion re-test at n(A) ≥ 150 (two independent hints, both sub-bar).

## Round 6 — the zone signal itself, at 292× the live sample (2026-08-03)

**Why this round.** Every prior round tested market-wide rules on *price bars*. Nobody had ever
tested **the system's own signal** at a sample that could resolve anything: the live ledger has
814 signals (ESS ≈ 348), and the 2026-08-03 audit measured 43.5% symmetric skill on it — enough
to say "no edge on average", nowhere near enough to rule out a **high-probability subset**. The
operator's standing request is precisely for such a subset. So this round makes that question
answerable.

**New tool — [scripts/research/zone-replay.js](../scripts/research/zone-replay.js)** (`make
zone-replay`). Replays the live VRVP proximity rule across the whole 5m corpus at the live
10-min poll cadence: rolling 14-day volume profile, `computeVRVPLevels`/`checkVRVPProximity`
logic, one row per trigger with features known at trigger time and a symmetric ±k×ATR label
resolved strictly afterwards. **237,735 signals, 2019-09 → 2026-07, 66% trigger rate.** This
turns "wait 4 months for 800 live signals" into "20 minutes for 237,735" and is the capability
whose absence let the order-flow premise run 3 months on assertion.

*Fidelity deviations, disclosed:* log-price bucket grid at constant relative width (an absolute
34.7 grid is 0.87% of price in 2019 and 0.055% today — no single rule spans the corpus
otherwise); labels on 5m not 1m; no CVD/OI/session-VWAP (not available historically — taker-buy
ratio, which CVD is built from, IS used); no confirmation gate or dedup, because this measures
the SIGNAL, not the execution wrapper.

**Validation against the live book.** In the live calendar window the replay reads 50.92%
[49.92, 51.91] vs the live ledger's 46.07% [42.67, 49.50] measured from fire price — *not*
overlapping. Diagnosed rather than waved through: applying a live-equivalent 12h zone cooldown
to the replay in that window gives 48.38% [43.11, 53.69], which **does** overlap the live book.
The live 814 is a small, heavily clustered, mildly unlucky draw; the 237,735-row estimate is the
reliable one. Cooldown does not change the full-corpus result (50.18–51.18% at 1/4/12/24h).

### The headline

| cohort | n | hit | 95% CI | break-even (k=1) |
|---|---|---|---|---|
| **all replayed zone signals** | **237,735** | **50.40%** | **[50.20, 50.60]** | **60.65%** |
| always-long benchmark | 237,735 | 49.86% | — | — |

**The zone signal is a coin, to ±0.2pp, across 6.9 years and every regime.** Directional lift
over always-long: **+0.54pp**. No zone type escapes: HVN-long 50.32%, HVN-short 50.47%,
VAH-long 49.96%, VAH-short 51.19%, VAL-long 50.05%. No year escapes: 49.53% (2023) to 52.06%
(2026). This is no longer a sample-size question.

### Geometry cannot rescue it — the requirement table

`fee_R = 0.0008 / stopFrac`, so break-even hit `= 0.5 × (1 + fee_R)`. Median ATR30m over the
corpus is 0.454%.

| stop width | stopFrac | fee (R) | break-even | signal short by |
|---|---|---|---|---|
| 0.216% (live plan) | 0.216% | 0.370R | **68.52%** | −18.12pp |
| 1×ATR | 0.454% | 0.176R | 58.80% | −8.40pp |
| 2×ATR | 0.909% | 0.088R | 54.40% | −4.00pp |
| 3×ATR | 1.363% | 0.059R | 52.93% | −2.53pp |
| 10×ATR | 4.543% | 0.018R | 50.88% | −0.48pp |

For a 50.40% signal to break even the fee must be ≤0.0080R ⇒ **stop ≥10.00% of price = 22×ATR30m
(≈$6,300 at BTC $63k)** — at which point the surviving "edge" is 0.4pp, indistinguishable from
the 49.86% drift benchmark. **No geometry at any width makes this signal profitable.** This
closes the spec 07.3 open question "geometry vs zone logic": it is the zone logic.

### Selective prediction — can a model with an ABSTAIN option find a good subset?

Purged walk-forward (embargo = one full label horizon), HistGradientBoosting, 7-day block
bootstrap, and a **label-shuffle null through the identical pipeline** — the decisive control,
because selecting the top 1% of 170,000 rows manufactures a high hit rate from noise.

**META (accept the zone's direction, predict whether it wins) — refuted, and inverted.**
Hit *falls* as confidence rises: 50.33% → 49.24% → 47.06% → 44.53% at coverage 1.00 → 0.10 →
0.02 → 0.01, and sits **below its own null at every coverage**. There is nothing in the zone's
direction to meta-label.

**DIR (ignore the zone, predict direction) — real information, still unprofitable.** This is
the one genuinely positive finding of the round:

| coverage | n | hit | null (5 shuf) | always-long | break-even | net R |
|---|---|---|---|---|---|---|
| 1.00 | 170,000 | 50.36% | 49.83% | 49.77% | 61.38% | −0.2205 |
| 0.10 | 17,000 | 51.76% | 49.46% | 50.54% | 62.99% | −0.2246 |
| 0.05 | 8,501 | 52.91% | 49.49% | 49.11% | 63.68% | −0.2153 |
| 0.01 | 1,700 | **56.47%** | 51.45% | 54.53% | **65.00%** | −0.1705 [−0.2825, −0.0397] |

Monotone in coverage, beats its null everywhere, beats always-long. **This is a real directional
edge.** It is also unprofitable, and the reason is structural:

**ADVERSE COST SELECTION — the round's actual finding.** Break-even *rises* with confidence
(61.38% → 65.00%) because the states the model is confident about are the **quiet** ones:
median ATR falls 0.434% → 0.305% (−30%) from full coverage to the top 1%, and `fee_R = cost/ATR`,
so the toll rises 0.228R → 0.300R. Accuracy gains 6.1pp; the hurdle gains 3.6pp. The signal
starts 11pp behind and finishes 8.5pp behind. **Predictability and transaction cost are
positively coupled** — the market is most forecastable exactly where it is most expensive to
trade that forecast. No tuning removes this; it is a property of the cost model, not the
predictor. (Linear corr(confidence, ATR) is only −0.007 — this is a tail effect, not a
linear one, which is why no prior univariate test could have seen it.)

### Selective prediction on plain price bars (rounds 1–5 feature set, new objective)

| TF | k | best cell | hit | break-even | always-long | null max | net R |
|---|---|---|---|---|---|---|---|
| 1h | 3 | cov 0.05 | 54.30% | 52.32% | 52.04% | 48.53% | +0.0397 [−0.084, +0.166] |
| 4h | 3 | cov 0.10 | 55.33% | 51.00% | **58.88%** | 50.76% | +0.0867 |
| 4h | 1 | cov 0.05 | 55.19% | 52.54% | **56.15%** | 54.42% | +0.0530 |
| 1h | 1 | cov 0.05 | 53.05% | 56.19% | 49.88% | 49.69% | −0.0628 |

Both 4h cells **lose to always-long on their own selected bars** — the model finds favourable
bars and then gives the advantage back by going short on some of them. Only **1h k=3 cov 0.05**
beat break-even, always-long and every null shuffle simultaneously. Kill-tested:

| Date | Hypothesis | n | Result | Verdict |
|---|---|---|---|---|
| 2026-08-03 | Zone signal has directional edge (definitive test) | 237,735 | 50.40% [50.20, 50.60] vs 60.65% break-even; +0.54pp over always-long | **Refuted — definitively** |
| 2026-08-03 | Some zone TYPE has edge | 237,735 | all five within 1.2pp of 50% | **Refuted** |
| 2026-08-03 | Geometry, not zone logic, is the problem | — | needs 22×ATR stop to break even; edge then = drift | **Refuted — it is the zone logic** |
| 2026-08-03 | META-labelling the zone signal finds a good subset | 170,000 | 50.33%→44.53% as confidence rises; below null throughout | **Refuted, inverted** |
| 2026-08-03 | A direction model on zone states finds a profitable subset | 170,000 | real edge (56.47% @1%, beats null 51.45% and always-long 54.53%) but break-even rises to 65.00% | **Refuted on economics — edge real, toll larger** |
| 2026-08-03 | 1h k=3 selective (cov 0.05) is a viable edge | 2,081 | halves 48.75% / 59.85%; by year 2021 **39.34%**, 2022 49.13%, 2023 50.11%, 2024 **64.81%**, 2025 56.04%, 2026 57.20%; +0.040R vs the +0.25R bar | **Refuted — regime artefact**, same signature as the round-2 funding lead |

*(The 6-seed stability check in that kill-test was void — `HistGradientBoostingClassifier` is
deterministic on fixed data, so all six seeds returned identical numbers. Recorded as not-run
rather than as a passed check.)*

### Round 6b — the model as a long-only TIMING filter

Motivated directly by the round-6 sweep, not invented afterwards: at 4h k=3 cov 0.10 the model
hit 55.33% while **always-long on those same bars hit 58.88%** — it was selecting favourable
bars and then giving the advantage back by going short on some. So split the two jobs: use the
score for WHEN to be in the market, and always go long.

At 4h k=3 this produced the strongest cell of the entire round — coverage 0.05: **hit 60.04%,
net +0.1801R/trade vs always-long's +0.0182R, against a 48.07% null.** It clears break-even,
clears always-long by 10×, and beats its null by 12pp. It fails only the block-bootstrap CI
([−0.0927, +0.4222]) — and then dies completely on regime:

| year | filtered hit | always-long that year | lift |
|---|---|---|---|
| 2022 | 60.71% | 45.32% | **+15.39pp** |
| 2023 | 57.24% | 57.53% | −0.29pp |
| 2024 | 83.19% | 58.38% | **+24.80pp** |
| 2025 | 53.01% | 51.25% | +1.76pp |
| 2026 | 16.13% | 48.43% | **−32.30pp** |

**The whole result is 2024**, and **2026 — the regime closest to live conditions — is the worst
year on record for it.** Chronological halves 54.07% / 65.99% confirm the instability. Refuted,
same signature as the funding lead and the 1h k=3 lead. (1h k=3 and 4h k=2 long-only variants
fail outright: per-trade CI includes zero at every coverage.)

**FDR bookkeeping.** New hypothesis cells this round: 20 (selective on bars, 4 configs × 5
coverages) + 12 (zone META/DIR × 6 coverages) + 6 (zone headline + 5 zone types) + 12 (long-only
timing filter, 3 configs × 4 coverages) = **50**.
**Cumulative family: 255 cells. Still 0 actionable.**

### Round-6 conclusion

The zone signal is not under-tuned, mis-parameterised, or badly gated. Measured at 237,735
instances across every regime BTC has had, it is **a coin flip with a 60.65% toll**, and no
geometry reaches it. The one real edge found anywhere in the round is inaccessible because it
lives in the low-volatility states where cost-in-R is highest.

**There is nothing here to tune into high-probability setups.** The honest options are (a) the
order-book corpus, still the only untested feature family, decision date 2026-08-25 per 07.5;
or (b) accept that at these horizons directional prediction is a coin and that the only thing in
255 cells which reliably clears its own costs is **long exposure at multi-day horizons** — which
is beta, not a signal, and needs no alert pipeline to capture.

## Round 7 — funding CARRY, not funding as a predictor (2026-08-03)

**Different in kind from rounds 1–6.** Those asked "can we predict direction?" — answered no
across 255 cells. This asks a structural question with no forecast in it: hold long spot +
short perp, collect the 8-hourly funding the crowded side pays, and see whether the payment
exceeds the cost of holding both legs. Price direction cancels between the legs.

**Not to be confused with round 2's F1–F6**, which used funding as a *directional predictor* and
was refuted. This captures the payment itself.

Tool: [scripts/research/carry-test.js](../scripts/research/carry-test.js). Data: 7,538 funding
settlements 2019-09 → 2026-07, plus Binance spot and perp 8h closes (7,544 bars each), aligned
to settlement.

### The hedge works — this is the part rounds 1–6 could never achieve

| | value |
|---|---|
| mean funding / 8h | **1.065 bp** = **11.67% annualised** (full sample) |
| settlements positive | 85.5% |
| **basis P&L per trade** | **0.000–0.002%** — direction genuinely cancels |
| \|Δbasis\| over 7d, p95 | 0.096% vs a 7-day carry of 0.224% ⇒ **noise is 0.4× the signal** |

That last row is the inversion of every prior round: here the payment is *larger* than the
noise around it. Nothing in 255 directional cells had that property.

**Break-even hold** (round trip = 4 legs): taker 32bp → 10.0 days · mixed 20bp → 6.3 days ·
maker 8bp → 2.5 days.

**Full-sample simulated carry, non-overlapping, return on capital (spot 1.0× + perp margin at
10×), net of all four legs:**

| fee model | hold | n | net/trade | annualised | win% | 95% block CI (ann.) |
|---|---|---|---|---|---|---|
| taker | 90×8h (30d) | 83 | +0.585% | **+7.12%** | 74.7% | [4.33, 10.34] |
| mixed | 90×8h | 83 | +0.694% | **+8.45%** | 86.7% | [5.65, 11.77] |
| maker | 90×8h | 83 | +0.803% | **+9.77%** | 90.4% | [6.98, 13.12] |

**These are the first CIs excluding zero anywhere in spec 07.** Short holds are strongly
negative at every fee model (3×8h taker = −95% annualised) — the cost is fixed and the carry is
per-period, so this is a hold-duration trade, not a signal.

### The decay is the whole story

| year | mean bp/8h | annualised | % settlements positive |
|---|---|---|---|
| 2020 | 1.570 | 17.19% | 85.7% |
| 2021 | 2.795 | **30.61%** | 92.7% |
| 2022 | 0.380 | 4.16% | 77.9% |
| 2023 | 0.718 | 7.87% | 89.9% |
| 2024 | 1.089 | 11.92% | 91.6% |
| 2025 | 0.468 | 5.13% | 87.1% |
| 2026 | **0.167** | **1.83%** | **66.7%** |

The 11.67% full-sample figure is carried by 2020–21. Monotone compression since — the signature
of a well-known trade being arbitraged. Net-of-cost by year at hold=90: 2021 +22.9%, 2024 +7.1%,
2025 +1.0%, **2026 −2.5%** (taker) / +0.2% (maker).

**Restricted to the regime that matters (2024-08 →, n=2,178 settlements, gross carry 4.85%):**

| hold | taker | mixed | maker |
|---|---|---|---|
| 45×8h (15d) | −2.67% | −0.02% | +2.64% |
| 90×8h (30d) | +0.87% | +2.19% | **+3.52%** |
| 180×8h (60d) | +2.64% | +3.30% | **+3.96%** |

### Verdict

| Date | Hypothesis | n | Result | Verdict |
|---|---|---|---|---|
| 2026-08-03 | Delta-neutral funding carry covers its costs | 7,538 settlements / 83 non-overlapping 30d trades | full sample +7.1 to +9.8% ann, CI excludes zero, basis P&L ≈ 0 | **Supported — first cell in spec 07 to clear** |
| 2026-08-03 | …and is still viable in the current regime | 2,178 settlements | 2026 gross carry 1.83%; net +3.5–4.0% (maker, 30–60d holds), ~0% mixed, **negative at taker** | **Marginal — pays roughly the risk-free rate** |

**Honest reading.** The trade is real, structural, and direction-neutral — everything rounds 1–6
were not. It has also been arbitraged down to approximately the return on T-bills, requires
fully passive execution on both legs to stay positive, and needs 30–60 day holds. It is a
*carry* business, not a signal business, and it competes with cash rather than with the old
zone pipeline.

**Caveats before anyone sizes this.**
1. **Executability blocker:** BloFin is futures-only in this setup. The long-spot leg needs a
   spot venue and a second set of credentials/reconciliation. That is real infrastructure, not a
   config change.
2. The 7-day block bootstrap is **too tight** at 30–60 day holds (blocks shorter than the hold).
   Treat the full-sample CIs as optimistic; the year table, which needs no bootstrap, is the
   honest view.
3. Funding was negative on 14.5% of settlements overall and **33% in 2026**. Worst cumulative
   negative-funding run: −1.037% of notional.
4. Risk moves rather than disappears: margin/liquidation on the perp leg, two-venue operational
   risk, and basis convergence — not price direction.

## Round 8 — the two operator questions: cross-sectional carry, and swing trading (2026-08-04)

Operator asked whether BloFin is truly ruled out, and whether swing trading changes the answer.
Both tested. Both refuted, for different reasons.

### 8a — Cross-sectional funding carry (the only carry executable on BloFin alone)

BloFin has no spot and no dated futures, so round 7's BTC cash-and-carry has no second leg
there. But it lists 88 perps whose funding differs enormously — measured live 2026-08-04:
ZK −16.47bp/8h (−180%/yr) to M +10.97bp/8h (+120%/yr), a **300%/yr cross-sectional spread**.
So: long the perps paying you to be long, short the perps paying you to be short, dollar-neutral,
every leg a perp.

Tools: [xs-carry-fetch.js](../scripts/research/xs-carry-fetch.js) +
[xs-carry-test.js](../scripts/research/xs-carry-test.js). Universe: the **81 perps tradeable on
both venues** (verified by intersecting BloFin's instrument list with Binance's, not assumed).
History from Binance — BloFin serves none. 80 symbols × >500 settlements, 2022-01 → 2026-08,
10,196-point settlement grid. Config: 5 legs/side, daily rebalance, ranked on 21-settlement
trailing funding, ranking strictly on information prior to each period.

| fee | n | gross carry | basket price P&L | cost | net | win% | 95% block CI |
|---|---|---|---|---|---|---|---|
| maker 2bp | 1,951 | +0.0639%/day | +0.0475%/day | 0.080% | **+11.5%/yr** | 50% | **[−29.4, +52.7]** |
| taker 6bp | 1,951 | +0.0639%/day | +0.0475%/day | 0.240% | **−46.9%/yr** | 46% | [−87.0, −3.8] |

**The carry is real — and the hedge is not.** This is the whole finding:

| | round 7 (BTC spot vs perp) | round 8 (alt vs alt) |
|---|---|---|
| legs | **same asset** | different coins |
| un-hedged price noise ÷ carry | **0.4×** | **39.5×** |

sd(price P&L) is 2.52% per period against a carry of 0.064%. The dollar-neutral basket is not
risk-neutral, so the funding is drowned by idiosyncratic co-movement. Over the full 4.5 years the
maker-fee equity curve compounds to **×0.992 — flat — with a −76.1% maximum drawdown**, worst
single day −12.18%. At taker fees, which is the realistic assumption on thin alt perps, it is
−46.9%/yr with a CI excluding zero on the wrong side.

Regime (maker): 2022 +42.6%, 2023 +52.7%, **2024 −41.4%**, 2025 +9.8%, 2026 +6.9%.

**Verdict: refuted.** Extreme negative funding is compensation for a token in freefall, not a
mispricing — you collect 180%/yr while the price halves. Round 7's hedge worked because both
legs were the same asset; nothing on BloFin reproduces that.

### 8b — Swing trading

Does the lower fee bar at multi-day horizons (break-even 59.4% at 30m → 50.3% at 1d) produce a
business? Benchmark is **buy-and-hold**, not zero — any long-biased rule flatters itself in a
window where BTC rose. BTC daily 2019-09 → 2026-07, 2,515 bars.

**Buy & hold: CAGR 35.5%, max drawdown −76.7%, Sharpe 0.81.**

Long with a *trailing* stop, exit on trail, breakout re-entry, fees both ways:

| trail | trades | win% | CAGR | max DD | Sharpe | time in mkt | vs buy&hold |
|---|---|---|---|---|---|---|---|
| 1×ATR | 37 | 32.4% | −1.5% | −27.0% | −0.05 | 2% | −36.9pp |
| 2×ATR | 22 | 36.4% | +1.1% | −39.8% | 0.15 | 6% | −34.4pp |
| 3×ATR | 17 | 23.5% | −2.1% | −53.3% | 0.01 | 11% | −37.6pp |
| 5×ATR | 10 | 20.0% | **+11.9%** | −46.6% | 0.54 | 19% | −23.5pp |
| 8×ATR | 8 | 25.0% | +8.0% | −61.0% | 0.40 | 27% | −27.5pp |

**Every configuration loses to buy-and-hold by 23–38pp of CAGR**, and win rates are **20–36%** —
trend-following's profile is many small losses and few large wins, the opposite of the operator's
80–90% target. The genuine benefit is risk, not return: the 1×ATR trail cuts max drawdown from
−76.7% to −27.0%. *(Caveat: the breakout re-entry rule is strict — requiring a reclaim of the
prior peak keeps time-in-market at 2–27%, which depresses CAGR. A looser re-entry would trade
more; it would not change the ordering, since every exit pays fees the benchmark does not.)*

**What does work at daily horizons is drift, and it needs no signal:**

| k | n | always-long hit | break-even | net R/trade |
|---|---|---|---|---|
| 1 | 2,469 | 52.77% | ~51.6% | **+0.0303** |
| 2 | 2,421 | 55.39% | ~50.8% | **+0.0953** |
| 3 | 2,244 | 57.22% | ~50.5% | **+0.1359** |

Positive at every k — this is round 3's result restated as money. But **52.8–57.2% is not
80–90%**, and reaching 80–90% requires skewing the geometry, which gives the expectancy straight
back (measured: 1:9 target:stop → 90.0% wins at −0.0254R).

| Date | Hypothesis | n | Result | Verdict |
|---|---|---|---|---|
| 2026-08-04 | Cross-sectional funding carry is executable and profitable on BloFin | 1,951 periods, 80 symbols | maker +11.5%/yr CI [−29.4, +52.7]; taker −46.9%/yr; equity ×0.992 over 4.5y; maxDD −76.1%; price noise **39.5×** the carry | **Refuted — no real hedge** |
| 2026-08-04 | Swing trading (trailing stop, multi-day) beats buy-and-hold | 2,515 daily bars | every trail 23–38pp of CAGR **worse**; win rates 20–36% | **Refuted** |
| 2026-08-04 | Always-long at daily barriers clears its costs | 2,244–2,469 | +0.030 / +0.095 / +0.136 R/trade at k=1/2/3 | **Supported — but it is drift, not signal, and it is 53–57% not 80–90%** |

**FDR bookkeeping.** New cells: 2 (xs-carry fee models) + 5 (trailing-stop grid) + 3 (symmetric
always-long) = **10**. **Cumulative family: 283 cells.**

### Where this leaves BloFin

Every carry structure needs two legs that are the *same risk*. BloFin lists one instrument type —
perpetuals — so the only pairs available are different coins, and round 8a measures exactly how
badly that fails (39.5× noise-to-carry). The remaining honest options on BloFin are directional
(refuted at 237,735 instances, round 6) or long-biased beta (works, ~53–57% win rate, and is
just owning BTC with liquidation risk attached).
