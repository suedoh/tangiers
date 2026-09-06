# Pre-registration — order-book corpus scoping (Phase B)

**Written 2026-09-06, BEFORE any forward return was joined to any feature.**
Only the *integrity* pass (row counts, null/zero structure, schema boundaries)
had been run at the time of writing. No conditional outcome, hit rate, or
forward return had been computed for any hypothesis below.

## Status of this document

This is a **scoping** exercise, not a test. The corpus is **19 usable days in a
single regime** — below this project's 60-day walk-forward threshold and far
below what the prior study (`order-flow-academic-backtest-2026-09-06.md`) used
to refute six hypotheses on 7 years of data. Nothing here may produce a verdict.
The purpose is to fix hypotheses *now*, while the outcome data is still too thin
to tempt anyone, so that Phase C is a confirmatory test of pre-committed rules
rather than a search.

**Deliberately NOT computed in Phase B:** p-values, FDR families, walk-forward
splits, or any statement of significance. Descriptive point estimates are
reported with n and with the same-bar drift alongside, so that drift
contamination (the prior study's §3.4 finding — no rule had a positive
drift-adjusted excess) is visible at a glance and cannot be mistaken for edge.

## What this corpus adds over the prior study

The prior study used **trade prints and OHLCV only**: aggregate taker-buy volume
per bar. It had no resting depth, no touch sizes, no per-trade sizes, and no
liquidation identification. This corpus has all four, at 1-minute aggregation.
Every hypothesis below is chosen because it is **untestable without them**.

## Causality convention (fixed here, applies to all)

Corpus row `t = T` aggregates all messages in `[T, T+60s)`. Its features are
therefore fully known only at `T+60s`. Forward returns are measured from the
**close of the 1-minute Binance kline whose openTime is T** (which is also
`T+60s`) to the close of the kline `k` minutes later. No feature can see any
price used in its own outcome.

Thresholds are percentiles of a **trailing, causal window of the prior 1440
minutes (24h)**, recomputed each minute, never full-sample. The first 1440
minutes of the corpus are warm-up and are excluded from all conditional stats.

Horizons: **k ∈ {1, 5, 15, 30} minutes**.
Reference cost, carried from the prior study: **14bp round trip** (5bp taker per
side + 2bp slippage per side). Any conditional mean below +14bp is not a
candidate for anything, regardless of hit rate.

---

## H-B1 — Resting depth imbalance predicts short-horizon direction

**Grounding.** Queue-imbalance-as-predictor is the most replicated result in the
microstructure literature: Cartea, Jaimungal & Penalva (*Algorithmic and
High-Frequency Trading*, 2015) on imbalance-conditioned fill and drift;
Lipton, Pesavento & Sotiropoulos (2013) on book-imbalance as a directional
predictor; Stoikov (2018) on the micro-price. The common finding is that
**bid-heavy books drift up over very short horizons**.

**Rule.** At the close of minute T, with `obi5` = mean 5-level depth imbalance
`(V_bid − V_ask)/(V_bid + V_ask)` over that minute:
- `obi5 ≥ P80(trailing 1440)` → **long**
- `obi5 ≤ P20(trailing 1440)` → **short**

Direction is **continuation** (bid-heavy → up). Reported separately for
`obi1`, `obi5`, `obi20`, and `obiTouch` to see whether depth of aggregation
matters, with `obi5` as the pre-registered primary.

**Why the corpus is required.** Resting depth does not exist in trade prints.

**Explicitly NOT tested, and why.** This is **not** Cont, Kukanov & Stoikov
(2014). CKS's Order Flow Imbalance is built from *per-update increments* at the
best quotes (`e_n = ΔV_bid − ΔV_ask`, with sign rules on quote-price changes).
This corpus stores the per-minute **mean level** of imbalance, not the
increments, so OFI cannot be reconstructed from it at any aggregation. Testing
CKS properly requires a recorder change (accumulate signed touch-size deltas per
minute). That is a Phase C prerequisite, not a Phase B result.

---

## H-B2 — Price impact scales inversely with measured resting depth (Kyle λ)

**Grounding.** Kyle (1985): λ, the price move per unit of signed order flow, is
the inverse of market depth. Amihud (2002) uses volume as a depth proxy
precisely *because* real depth is unobservable in standard data. Almgren &
Chriss (2000) separate permanent from temporary impact.

**Rule.** Define signed aggressor flow `F = 2·tbuy − tvol` (exact, not
tick-rule-inferred) and measured depth `D = dBid + dAsk` (20-level resting
size). Partition minutes into terciles of `D` (trailing-1440 percentiles):
thin / mid / thick.

- **H-B2a (impact):** the regression slope of same-minute return on `F` is
  **steeper in thin books than thick** — i.e. `λ_thin > λ_thick`.
- **H-B2b (reversion):** the portion of impact occurring in thin books
  **reverts more** over k ∈ {5, 15, 30} than the thick-book portion, since
  thin-book impact is disproportionately inventory/temporary rather than
  informational.

**Why the corpus is required.** The prior study's H1 proxied depth with a
trailing median of *volume* and produced a near-empty trigger (n=46, 0.08%)
because the proxy was its own denominator (its §3.1). With real `D`, λ and the
depth condition are measured independently and that degeneracy cannot occur.

---

## H-B3 — Liquidation cascades: continuation or reversion

**Grounding.** Brunnermeier & Pedersen (2009) on liquidity spirals — forced
deleveraging is price-insensitive supply, which both moves price and creates
subsequent reversal pressure once the forced flow is exhausted. The two
competing readings are explicitly stated so the sign is not chosen after
looking.

**Rule.** Net forced flow `L = liqShort − liqLong` (BTC-only, in BTC). Sign
convention verified against the recorder: `o.S === 'SELL'` is a **long** being
liquidated (forced selling, pushes price down), so `liqShort − liqLong` is the
net **upward** forced pressure. Trigger: `liqNotional ≥ P95(trailing 1440)`.

- **H-B3-cont:** direction `sign(L)` — the cascade continues.
- **H-B3-rev:** direction `−sign(L)` — the cascade exhausts and reverts.

These are mutually exclusive; both are reported, and neither is privileged.
Market-wide cascade intensity (`liqAllNotional`) is reported as a **separate
conditioning variable**, never mixed with the BTC-only series.

**Why the corpus is required.** Trade prints do not identify forced orders.
Binance serves no `forceOrder` history — this feed exists only going forward.

---

## H-B4 — Block prints (≥5 BTC): permanent vs temporary impact

**Grounding.** Holthausen, Leftwich & Mayers (1987) and Keim & Madhavan (1996)
decompose block-trade impact into a permanent (information) component and a
temporary (liquidity) component that reverts. Kyle (1985) predicts the permanent
part scales with informed flow.

**Rule.** Net block flow `B = tbigBuy − tbigSell` (single prints ≥5 BTC).
Trigger: `|B| ≥ P90(trailing 1440)`.
- **H-B4-perm:** direction `sign(B)` — impact persists at k=15, 30.
- **H-B4-rev:** direction `−sign(B)` — impact reverts.
Both reported. Additionally, the **share of the minute's volume that is block
flow** (`(tbigBuy+tbigSell)/tvol`) is reported as a conditioning variable.

**Why the corpus is required.** The prior study had per-bar aggregate taker-buy
volume only, so a 5 BTC print and a hundred 0.05 BTC prints were identical to
it. Per-trade size thresholding requires the `@trade` stream.

---

## VPIN — a scoping question, not a hypothesis

The prior study's H2 **failed its own positive control**: high VPIN selected
*quiet* periods (forward-vol ratio 0.85 bar-clock, 0.93 volume-bucket), the
opposite of the documented signature, so it was reported as "construct not
validated" rather than refuted.

The pre-registered question here is narrow and answered before any VPIN
outcome is computed: **does this corpus permit a materially better VPIN
construction?** Two things are checked:

1. **Classification.** VPIN normally needs Bulk Volume Classification because
   aggressor side is unobservable. This corpus has the **true** aggressor side
   (`tbuy` from the `@trade` stream's maker flag), removing BVC error entirely.
2. **Bucketing.** VPIN requires *volume* buckets, not clock buckets. This corpus
   is minute-aggregated, so buckets can only be assembled from whole minutes —
   quantized, not exact.

**Pre-registered positive control, identical to the prior study's:** high VPIN
must predict **higher** forward realized volatility (ratio > 1). If the ratio is
again ≤ 1, VPIN is closed for this corpus at this aggregation and no directional
VPIN result may be reported from it, in Phase B or Phase C.

---

## Known confounds, stated in advance

- **One regime.** 19 days. The prior study's §3.5 showed a 31-day window whose
  momentum base rate was 62.5% against a 48.8% seven-year norm. The BTC move
  across this window is measured and reported first, before any conditional
  statistic, so the reader sees the regime before seeing any number.
- **Overlapping windows.** k = 5/15/30 overlap, so consecutive observations are
  not independent. Relevant to Phase C's inference; noted here so it is not
  discovered later.
- **Corpus artefacts** (from the integrity pass, all quantified in the report):
  pre-2026-07-27T12:45Z rows carry no liquidation data; `samples > 600` rows
  indicate double-counted depth snapshots; one duplicate minute;
  `liqAllLong`/`liqAllShort` are dimensionally invalid. Exclusion rules are
  applied and stated.
- **Multiplicity.** 4 hypotheses × several direction variants × 4 horizons is a
  large family. No correction is applied in Phase B **because no inference is
  claimed**. Phase C must carry the full family, including every variant listed
  here, into one BH-FDR correction.
