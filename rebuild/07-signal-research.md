# 07 — Signal research & falsification harness

**Type:** edge (the crux) · **Depends on:** 03, 04, 05, 06 all done — research on a broken
ledger or unstable feed is void · **Audit refs:** D2, D3, D11, D12, §8a, §8c

## Honest framing (read twice)

The current VRVP-proximity signal, measured honestly, **has no directional edge**: 47.8%
[44.3, 51.3] at symmetric ±1×ATR geometry; a random-entry Monte Carlo with identical trade
geometry beats the actual book (actual at the 0th percentile). Fees at current geometry exceed
gross edge ~30×. Therefore this spec's job is **not** to tune the current signal into
profitability — it is to (a) re-measure the current signal on honest infrastructure, and
(b) test replacement hypotheses until one clears the bar, or conclude none does.

**"No viable signal found" is an acceptable terminal outcome of this spec.** Shipping a signal
that hasn't passed the bar is not. If nothing clears after honest effort, the system stays a
paper research instrument and spec 08's live-fire never activates — say so plainly.

## 7.1 The bar (all five rows green simultaneously, corrected ledger)

| Requirement | Threshold | Why (measurement) |
|---|---|---|
| Directional skill | ≥55% hit at symmetric ±1×ATR30m; day-clustered CI excluding 50%; ESS ≥150 across ≥2 regimes, one non-uptrend | current 47.8%; 55% is the minimum that survives the fee floor below |
| Gross expectancy | ≥ +0.25R/trade at the fee-reduced geometry | fee floor 0.10–0.20R at ≥1×ATR stops + margin of safety; current +0.014R |
| Stop width | ≥1.0×ATR30m (≈0.35–0.5% in-sample), structural | 0.216% stop sits inside a single 30M bar 82% of the time; fee-in-R scales as 1/stop |
| Ledger↔exchange agreement | mean \|Δ\| ≤0.1R over ≥30 paired signals | current tracks differed 0.7–1.3R/signal |
| Sample before capital | ≥150 post-fix signals, ≥60 days, ≥2 regimes, ESS-corrected | ρ=0.349 halved nominal n; current data is one regime |

Where any candidate lacks the sample: write exactly
**"insufficient evidence; requires ≥150 observations across ≥2 regimes"** and keep collecting.
Never invent a threshold.

## 7.2 Falsification harness (build first, before any research)

Port the audit's stats stack ([tools/stats.js](tools/stats.js) — the reference implementation)
into `scripts/audit/falsification.js`, runnable on demand and weekly (spec 09 wires the cron):

1. **Symmetric skill test** — from the honest fill, does price travel +1×ATR30m before
   −1×ATR30m? Report hit% + Wilson CI + day-clustered bootstrap CI.
2. **Random-entry Monte Carlo** — ≥200 books of random-minute entries with geometry resampled
   from the real book; report the actual book's percentile. Passing = actual > 95th percentile.
3. **Standard battery on every claim:** Wilson 95% CI on proportions; two-sided Fisher exact on
   contrasts; Benjamini–Hochberg FDR q=0.10 across all cells tested (report the cell count);
   day-clustered bootstrap (B≥10,000) on mean R; lag-1 autocorrelation with Fisher-z CI + ESS;
   Brier/ECE for any published probability; walk-forward in fixed windows when ≥60 days.
4. **Actionability rule:** a factor/gate/tweak is actionable only if |lift| ≥10pp AND survives
   BH-FDR AND n≥50 AND the clustered CI on mean R excludes zero. Everything else is a
   hypothesis, logged, not shipped.

## 7.3 Research protocol

- **Features from exchange data only** (spec 06): zones from `lib/market-data.js`; order-flow
  candidates recomputed natively — CVD from Binance aggTrades, OI from `/futures/data/`
  endpoints, funding, VWAP. Never TV-read values.
- **First experiment: re-measure the current signal** at ≥1.0×ATR structural stops on the
  corrected ledger. This is the cheapest path to viability — the audit could not rule out that
  the geometry, not the zone logic, destroys the edge. It also calibrates the harness.
- **Candidate hypotheses to test after that** (from audit Tier 3 — all currently
  non-actionable; test, don't assume): regime conditioning (the only regime sampled is a
  downtrend-chop); confirmation-strength filters; zone-type splits (the tier ranking flipped
  between accountings — treat tiers as untested). Add your own; log every test in a research
  ledger file (`rebuild/research-log.md`) with date, hypothesis, n, result, verdict —
  including failures. All cells count toward the BH-FDR correction.
- **Walk-forward discipline:** fit/choose on window k, evaluate on k+1 only. In-sample numbers
  are always labeled in-sample. No out-of-sample estimate may be quoted until one exists.
- **Two-regime requirement:** the ≥2-regimes row cannot be satisfied by waiting alone if the
  market stays one-regime; say so rather than shipping single-regime evidence.

## 7.4 Cost model (fixed inputs to all EV math)

Measured (audit, real fills): taker 6bp, maker 2bp per side. At 1×ATR (~0.4%) stops,
notional/risk ≈250 ⇒ taker-in/maker-out ≈ **0.20R**, maker/maker ≈ **0.10R** per round trip.
Every candidate's expectancy is reported **net** using this model; `feeR` per trade from
spec 03 is the realized check. Prod fee tiers are unverified — re-measure at Phase E.

## 7.5 Stop rules — written 2026-07-27, BEFORE the data exists

Added because the order-flow premise ran ~3 months on assertion before anything measured it.
These exist so a marginal result cannot quietly become "collect one more month". **Any change
to the thresholds below must be dated and justified in the research log, and a change made
after seeing the result it governs is void.**

### Order-book corpus (`book-recorder.js`, started 2026-07-26)

- **Decision date: 2026-08-25** (30 days of coverage). Not "when it looks ready".
- **Precondition:** `liqAllSeen` climbing and ≥25 days of non-gap rows. If the recorder was
  broken for part of the window, the window extends by the outage — it does not shrink the bar.
- **Test:** the same pre-registered battery, on a **non-overlapping book, net of fees and
  funding**, against always-long on the same entry schedule.
- **STOP if:** no book-derived feature produces ≥ +10R/yr with an OOS CI lower bound above its
  own break-even. On STOP, the corpus is archived, the recorder is switched off, and
  microstructure is marked refuted-at-this-scale in the log. **No extension for "one more month"
  — a real edge at 1-minute resolution does not need 60 days to become visible when 30 days of
  minute bars is ~43,000 observations.**
- **Continue only if** a feature clears the bar *and* the operator signs off in writing.

### Any future lead

- **Report on a non-overlapping book, always.** Per-signal statistics are void as evidence:
  round 4 showed +0.051R/trade become −0.005R/trade once overlap was removed.
- **Charge funding.** It is not in the barrier label and runs ~11.7% annualised.
- **Choose cut-points on early data and score on untouched late data.** In-sample grid maxima
  are not results.
- **Time-box: 4 weeks from lead to verdict.** A lead that cannot be resolved in 4 weeks with
  historical data is not resolvable by waiting; it is under-powered and should be logged as such.

### Bar (proposed 2026-07-27, replaces the +0.25R/trade row — operator sign-off required)

`+0.25R/trade` is blind to frequency and overlap, and that blindness is exactly what made a
−1.0R/yr rule read as profitable. Replace with **all four, simultaneously**:

1. **≥ +10R/year** on a non-overlapping book, net of fees and funding (≈10%/yr at 1% risk);
2. **OOS CI lower bound above the cell's own break-even** (not above 50%);
3. **≥10pp lift over always-long** on the same entry schedule;
4. **consistent across ≥2 of k ∈ {1,2,3}**.

Recorded while the best live candidate **fails row 1** (+6.18R/yr), so this bar is not
reverse-engineered from a passing result.

## Definition of Done (for any candidate promoted to spec 08 live-fire)

- [ ] Falsification harness built, reproduces audit numbers on the historical book
      (47.8% skill; actual-at-0th-percentile MC) as its self-test
- [ ] Research log exists; every test recorded, FDR-corrected across all of them
- [ ] Candidate passes all five 7.1 rows simultaneously, documented with CIs, regimes, ESS
- [ ] Operator has reviewed and signed off on the evidence package
