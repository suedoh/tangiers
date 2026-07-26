# Spec 07 — the signal hunt, round 1: no viable edge found (2026-07-26)

Full cell-by-cell record: [rebuild/research-log.md](../rebuild/research-log.md). This note is the
short version and the reasoning behind it.

## What was searched

A corpus independent of the old signal ledger: **2 years of Binance BTCUSDT perp** — 35,040 30m
bars for features, **1,051,200 1m bars** for labels. Integrity-checked: **0 gaps, 0 duplicates**
in both series.

Label: symmetric **±k×ATR30m** barrier resolved on 1m — which side is touched first. It is
direction-free, so any rule can be scored against it, and it strips payoff geometry out of the
question, leaving only *directional forecasting*. Ambiguity (both barriers inside one 1m bar) is
**0.01%**, excluded rather than guessed. Base rate P(up-first) = 49.6 / 50.2 / 50.6% at k=1/2/3 —
a driftless barrier behaving like one, the first evidence the labels are sound.

## The bar, derived before looking at data

At a symmetric barrier the payoff is ±1R, so `E[R] = (2p−1) − fee(k)`, and fee-in-R scales as
1/stop-width. At the measured median ATR of 0.42% with 6bp taker in / 2bp maker out:

| k | fee | break-even hit | hit needed for spec 07.1's +0.25R |
|---|---|---|---|
| 1 | 0.188R | **59.4%** | 71.9% |
| 2 | 0.094R | **54.7%** | 67.2% |
| 3 | 0.063R | **53.2%** | 65.7% |

Worth stating plainly: **spec 07.1's "≥55%" row is only meaningful at wide stops.** At k=1 the
real hurdle is ~59%. Widening the stop does not create edge — it lowers the toll.

## What was found

| Test | Result |
|---|---|
| 10 pre-registered rules × 3 barrier widths (30 cells) | best **51.8%**; nothing within 1.4pp of any break-even |
| Walk-forward logistic, 13 features, 180d→30d rolling, 17 folds, ~24k OOS rows | **51.5 / 50.9 / 49.7%** at k=1/2/3. At k=3 it is *worse than buy-and-hold* |
| Funding-rate family (12 cells) | one apparent hit — see below |

**My own prior was refuted.** Taker aggressor imbalance — order flow, the thing this system was
built around and the hypothesis I most expected to survive — scored 51.2 / 51.7 / 51.8%. Its
explicit inverse is symmetric below 50. Best drift-adjusted lift across all of it: **+1.2pp**.

## The one lead, and how it died

At k=3, "trailing-30d funding in its top decile → go long" hit **56.6%** vs a 50.6% base — +6.0pp,
p=1.4e-12, comfortably through cumulative BH-FDR. It had a clean economic story (crowded longs)
and it was the only thing in 98 tested cells that looked like a discovery.

Four adversarial checks, all of which it failed:

1. **Independence.** 2,855 rows are not 2,855 observations — consecutive 30m bars share a funding
   settlement *and* a 72h label window. Naive Wilson [54.8, 58.5]; **7-day block bootstrap
   [48.1%, 64.9%]** — includes 50%. Strictly non-overlapping subsample: **n=59, 52.5%** [40.0, 64.7].
2. **Regime.** 2025: 66.9%. 2026: **49.9%**. 2024: 52.9%. In uptrends +10.9pp; in downtrends **−2.8pp**.
3. **Novelty.** High funding *without* momentum hits **45.9%** — it carries no information beyond
   momentum, and momentum itself is worth +1.7pp.
4. **Economics.** Gross **+0.133R** against a ≥+0.25R bar; **−0.101R** at the lower block bound.

The same pattern shows in the quarterly splits of every "significant" cell — e.g. H4-revExtreme
runs 64.4% → 38.2% → 46.8% → 49.9% → 59.2% → 39.0% → 38.5% → 40.5% → 49.5% across nine quarters.
That is not an edge with variance; that is variance.

## Verdict

**No viable signal found.** This is spec 07's explicitly permitted terminal outcome: *"No viable
signal found" is an acceptable terminal outcome of this spec. Shipping a signal that hasn't passed
the bar is not.* Spec 08 live-fire stays inactive; the system remains a paper research instrument.

## Why this is a bounded claim, not a proof

Not tested, and each is a real gap: order-book microstructure (no historical depth feed),
open-interest history (Binance caps it at 30 days), cross-asset and ETF-flow features, holding
periods beyond 72h, timeframes above 30m, sub-minute execution effects, and non-linear learners
(deliberately excluded — at ~1pp effect sizes a flexible model fits noise and would have to be
walked forward far more carefully than the sample supports).

## Harness validation

The battery was run against synthetic data with a **planted 60% edge**. It recovered it at
**60.3%** (p=1.3e-38) while scoring unrelated rules at ~50%. An edge of the size the spec requires
would not have been missed — which is what makes the null result worth acting on.

## Tools (all read-only, reusable)

`scripts/research/` — `fetch-history.js` (columnar Binance fetch, resumable),
`build-dataset.js` (causal features + barrier labels), `hypotheses.js` (pre-registered battery,
cumulative BH-FDR, day-clustered CIs), `walkforward-model.js`, `funding-test.js`,
`funding-deepdive.js`. Data lands in `.market-data-cache/` (gitignored); no script writes to
`trades.json` or touches an exchange.
