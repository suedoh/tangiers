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
| **Σ** | **hypothesis cells tested to date** | **53** | |

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

## Open hypotheses queue (test when sample bar is met — spec 07.1: ≥150 post-fix signals, ≥60d, ≥2 regimes)

- Re-measure the current signal at ≥1.0×ATR structural stops on the corrected ledger
  (first experiment per spec 07.3 — cheapest path; audit could not rule out that geometry,
  not zone logic, destroys the edge).
- Regime conditioning (only a downtrend-chop regime is sampled to date).
- Confirmation-strength filters.
- Zone-type splits (tier/zone ranking currently accounting-dependent).
- A-tier inversion re-test at n(A) ≥ 150 (two independent hints, both sub-bar).
