# BTC Signal + BloFin Execution — Independent Audit (2026-07-26)

**Auditor stance:** external quantitative review, blind-first. All Phase 1–3 measurements were
completed and frozen **before** reading `refactors/**`, `TODO.md`, `BACKTESTING.md`, `docs/**`,
`notes/**`, or the prior audit of the same date. Section 6 reconciles against that record.
**Disclosure:** the session's persistent memory index contained one-line summaries of prior audit
outcomes (e.g. "signal wr real but fully priced", "−0.71R/signal delta"). Full blindness is
therefore qualified; every number below was nonetheless derived independently from raw data.

**Scope:** BTC pipeline (`trigger-check.js`, `mtf-analyze.js`, `lib/zones.js`, `lib/market-data.js`),
BloFin layer (`lib/blofin*.js`, `blofin/**`, `lib/executed-walk.js`, `lib/daily-r.js`), their state
files, reports, Mongo. Polymarket, BZ!, EW excluded per mandate.

**Scratch workspace (re-runnable):**
`/private/tmp/claude-503/-Users-vpm-trading/d03d9634-08c2-481d-bcd7-2a9a089055dd/scratchpad/audit/`
— contains `fetch-klines.js`, `verify.js`, `reconcile.js`, `stats.js`, `blofin-pull.js`, plus all
extracted data (`klines-{1m,30m}.json`, `verified.json`, `reconciled.json`, `stats-rows.json`,
`blofin-*.json`, `mongo-blofin-orders.json`). No repo file other than this report was written; no
state file, Mongo collection, or exchange order was mutated.

---

## 1. Verdict

**No. This system does not identify high-probability trade setups in any economically meaningful
sense, and it is not fit for automated capital today — including demo graduation.**

The deciding measurement: **random-time entries with identical geometry and identical accounting
produce a median of +1,032R (range +966 to +1,179 over 30 simulations of 801 signals); the
system's actual claimed +964.7R sits at the 0th percentile of that distribution.** The entire
headline P&L is reproduced — slightly exceeded — by placing the same trade shapes at random
minutes. Signal timing contributes nothing detectable.

Under honest execution accounting (market fill at fire, the 1/3 TP ladder BloFin actually places,
fees at the measured 6bp taker / 2bp maker):

| Accounting | total R | mean R/trade (day-clustered 95% CI) | win rate |
|---|---|---|---|
| Canonical ledger (claimed) | **+964.7R** | +1.204 [+0.942, +1.396] | 71.4% [68.1, 74.4] |
| Same rule re-derived from Binance | +1,017.1R | — | (84.3% outcome reproduction) |
| Market fill, full position, gross | −96.7R | −0.121 | — |
| Market fill, 1/3 ladder, **gross** | **+10.7R** | +0.014 | — |
| Market fill, 1/3 ladder, **net of fees** | **−348.5R** | **−0.458 [−0.695, −0.225]** | 41.5% [38.1, 45.1] |
| Exchange truth (all filled orders since 06-15) | **+$78.41 realized** | ≈ breakeven | 40.7% by signal |

**84% of claimed wins (465 of 553, carrying +1,008.5R — more than the entire book total) come from
trades whose planned entry price never filled before a take-profit was touched.** The ledger
credits limit fills a median **1.25R better than the achievable market price**, then measures every
reward and risk from that fictional fill.

Fees are the binding economic constraint: mean **0.472R per trade** at a median notional-to-risk
ratio of **183×**, against a measured gross edge of +0.014R per trade. No parameter change within
the current geometry closes a 30× gap between edge and cost.

---

## 2. Method & data provenance

- **Price ground truth:** Binance USDT-M futures public REST `/fapi/v1/klines`, pulled fresh:
  152,233 1m bars and 5,075 30m bars, 2026-04-12 → 2026-07-26T17:12Z, zero gaps (verified
  monotonic). The repo helper `lib/binance.js:getKlinesRange` was code-reviewed (pagination and
  forward-progress guard correct) before reuse.
- **Signal ledger:** `trades.json` (copied to scratch; original untouched): 801 BTC signals,
  2026-04-13T14:00Z → 2026-07-26T12:50Z (104 calendar days, 78 signal-days). Mongo `trades`
  (BTC subset n=801) verified in sync with the file, newest record matching.
- **Exchange truth:** read-only pulls of BloFin demo `orders-pending` / `orders-history` (571
  orders, per-order `pnl`, `fee`, `averagePrice`) / `fills-history` (200 fills — retention ≈3
  days) / positions / balance / pending TPSL. Order→signal mapping via Mongo `blofin_orders`
  (522 docs, 127 distinct signalIds) plus deterministic clientOrderId.
- **Fee rates measured from actual fills**, not assumed: market orders 6.00bp, resting limit
  reduce-only 2.00bp (multiple fills each, exact to 2 decimals).
- **Statistics:** Wilson 95% CIs; two-sided Fisher exact; BH-FDR q=0.10 across all 14 tested
  cells; day-clustered bootstrap (B=10,000, resampling 78 days) on mean R; lag-1 autocorrelation
  with Fisher-z CI; Brier/ECE vs published probability; 15-day walk-forward; random-entry Monte
  Carlo falsification (geometry resampled from the real book).

Accounting definitions are stated per table; where the code is ambiguous, multiple accountings are
shown side by side rather than picking one.

---

## 3. Tier 1 — Defects (provable from code or data)

### D1 — The canonical ledger scores a strategy nobody can trade ★★★
`walkBarsForOutcome` ([trigger-check.js:1870-1888](../scripts/trigger-check.js)) walks 30m bars
from `firedAt` and credits the **full position at `rr1/rr2/rr3` computed from the planned
`entry`** — a limit 20% inside the zone
([trigger-check.js:881,893](../scripts/trigger-check.js)) — without ever checking that the entry
traded. Measured against 1m klines:

- 502/801 signals (62.7%) never fill the planned entry before a TP is touched;
- 465 of those are recorded as wins totalling **+1,008.5R** — the phantom-fill wins exceed the
  whole book's claimed total (+964.7R);
- median gap between planned entry and achievable market fill: **1.25R** in the trade's favor.

The rule reproduces from ground truth (re-derived +1,017R vs claimed +965R; 84.3% outcome match,
mismatches mostly *under*-crediting — see D5), so this is a defective **rule**, faithfully
applied. Everything downstream — weekly reports, probability calibration, the daily-R kill
switch, the Phase D paper-vs-exchange comparison — inherits the fiction.

### D2 — Zero directional skill: random entries beat the actual signals ★★★
Falsification design: 30 simulations × 801 synthetic signals; each takes a real trade's geometry
(risk fraction, limit-advantage, rr1/rr2/rr3, direction) and drops it at a uniformly random
minute in the sample; outcomes scored with the system's own canonical accounting.
**MC median +1,032R [966, 1,179]; actual +964.7R → 0th percentile. MC median win rate 67.4%
[64.8, 73.8] vs actual 71.4%.** Under honest ladder accounting the actual book (−348R) lands
within the random distribution (median −477R, range [−580, −211]) — at best marginally less bad
than random, still deeply negative. A result materially above the MC envelope would have
demonstrated timing skill; the observed result refutes it.

### D3 — Fees exceed gross edge by ~30× ★★★
Ladder gross: +0.014R/trade. Fee cost at measured rates: mean **0.472R/trade** (total 359.1R
across 761 resolved), driven by notional/risk of ~183× (stop ≈0.2% of price at plan, ≈0.5% from
actual fills). Day-clustered net: **−0.458R [−0.695, −0.225]** — the CI excludes zero on the
downside. Exchange corroboration: $251.76 fees on matched signal orders vs $688.90 gross
matched P&L (37%), and account-level net of **+$78.41** across all 404 filled orders since
2026-06-15 (the +$437 "matched net" illusion disappears once the 128 unmatched reduce-only
orders — SL triggers, flattens, trims, Σ −$358.77 — are included).

### D4 — Confirmation fires on forming bars, not 30M closes ★★★
`checkConfirmation` ([trigger-check.js:1655-1680](../scripts/trigger-check.js)) evaluates
`bar.close` on a TradingView series that includes the in-progress bar, whose "close" is the live
tick. Measured: **283 of 471 checkable confirmations (60.1%) recorded a `confirmedPrice` that
does not equal the true final close of the claimed confirmation bar**; 104 of 768 confirmations
(13.5%) would never have confirmed under strict close semantics (their claimed R sums to −65.5R,
so fixing this *raises* the paper total — reported for honesty, not as a defense). The
documented rule (BACKTESTING.md: "wait for a 30-min candle to close beyond entry") is not what
runs. The same forming-bar reads produce the D5 walk mismatches.

### D5 — Outcome stamping from in-progress bars silently violates the documented stop-first rule ★★
Re-walk with completed bars reproduces 653/775 (84.3%). Mismatch pairs: tp1→tp2 (43), tp1→tp3
(25), tp2→tp3 (24) — early booking at lower rungs; and **25 trades booked as wins that completed
bars score as stop-first losses** (tp1→stop 19, tp2→stop 5, tp3→stop 1) — the documented
"stop wins same-bar ambiguity — conservative" guarantee
([trigger-check.js:1857-1858](../scripts/trigger-check.js)) is inverted whenever a poll reads a
bar mid-formation. Net effect is *under*-credit (−52R vs the rule), so this is an integrity
defect, not an inflation source.

### D6 — The executed-hypothetical track still overstates exchange truth 2.3× ★★★
For the n=80 placed signals with both an `executedPnlR` and exchange orders: executed-track
claims **+185.3R**; the exchange's realized net for the same signals is **+81.5R**. Causes are
structural: `walkExecutedLadder` ([lib/executed-walk.js:63-92](../scripts/lib/executed-walk.js))
prices rungs off the **planned entry** (not the fill), walks from fire-time, and charges **no
fees**. Its outcome distribution (44 tp3 / 36 stop / zero tp1-tp2 terminals) shows the uncapped
rr3 class is still being paid out. This is the track the D→E gate would consult.

### D7 — The daily-R kill switch is anchored to the fictional ledger ★★
[lib/daily-r.js:19-32](../scripts/lib/daily-r.js) sums canonical `pnlR` (biased +1.2R/trade)
against a −3.0R floor. A ledger that books +1.2R/trade average cannot reach −3R on any realistic
day, so the only strategy-level circuit breaker cannot bind while the exchange account bleeds
(three consecutive negative weeks: −$31, −$13, −$103). The risk control exists in code and is
inert in practice.

### D8 — Unbounded same-direction stacking exhausted the account; signals now silently skipped ★★★
The one-direction book guard
([lib/blofin-autotrade.js:272-278](../scripts/lib/blofin-autotrade.js)) blocks only *opposite*
entries; nothing caps aggregate same-direction exposure. Jul 24–26: **48 consecutive long
signals** (mostly C-tier) stacked into a single net position — live at audit time: **238.3
contracts long @ avg 64,123.7, margin $1,528.07 frozen of $1,570.77 total balance, $42.70
available, 34 layered sell SLs at 63,589–63,717, liquidation 57,920**. From 2026-07-26T01:50Z
onward every signal is `skipped — insufficient margin`; the execution layer has been de-facto
dead for ~11 hours. `ops/watchdog.js` checks Docker/Mongo/recon/spool — **not margin, not
aggregate exposure** — so no alert fired. The margin-preflight trim
([blofin-autotrade.js:293-311](../scripts/lib/blofin-autotrade.js)) made sizing path-dependent on
the way in (32.3 → 29 → 20.3 → … → 7.4 contracts), so late-July "identical" signals carry
arbitrary fractions of intended risk.

### D9 — The ledger, the executed-track, and the exchange trade three different strategies ★★★
Established from code, not inference: canonical = limit fill 20% inside the zone, full position
exits at first-touched rung ([trigger-check.js:1876-1884](../scripts/trigger-check.js));
executed-track = 1/3 ladder from plan entry, no fees
([executed-walk.js](../scripts/lib/executed-walk.js)); exchange = market fill at fire
([blofin-autotrade.js:192-217](../scripts/lib/blofin-autotrade.js)), fill-repriced burn-rule
ladder (:162-177), risk trim (:361-379), standalone verified SL (:409-453). Any comparison
between these tracks (including the Phase D→E gate as specified) compares different strategies.

### D10 — Signal inputs are not stable across data sources ★★
From the project's own parity sidecar (1,976 cycles, 14.2 days, read independently): TV VRVP
read returns null in **14.9%** of cycles (signal generation silently blind ~1 poll in 7); CVD
sign agreement TV-vs-exchange **61.6%**; POC location deviates a median **201bp**; the same
trigger code fires the same decision in only **34.2%** of cycles. The signal definition is an
artifact of chart viewport state, not a property of the market.

### D11 — Serial dependence: nominal n overstates evidence ~2× ★
Lag-1 autocorrelation of the win sequence: **ρ=0.349 [0.286, 0.410] → effective n ≈ 374** of
775. Up to 22 canonical trades open concurrently; 47 signals fired on the worst day. Every
Wilson CI in every report that assumes independence is overconfident.

### D12 — Published probabilities are miscalibrated on both accountings ★
Vs canonical wins: Brier 0.2122, **ECE 12.0pp** (the 48% tier realizes 60.0% [53.6, 66.1]).
Vs honest ladder wins: **Brier 0.2739 — worse than a coin flip**. The 85/74/63 constants are
in-sample touch-TP1 rates of a fictional accounting, not win probabilities of anything tradeable.

**Data integrity (negative finding, in the system's favor):** recorded fire prices are honest —
786/801 (98.1%) lie within the containing 1m bar; the 15 outliers deviate ≤70bp (feed skew, not
fabrication). Mongo `trades` is in sync with `trades.json`. The corruption is model-level, not
data-capture-level.

---

## 4. Tier 2 — Open questions (operator intent required)

- **Q1 — Which strategy is the product?** The code answers what each *track* does (D9), but only
  the operator can say which is intended for capital: confirmation-triggered market entry (what
  BACKTESTING.md describes), fire-time market entry (what BloFin does), or zone-limit resting
  orders (what the ledger scores). Every remediation depends on this. *(The prior audit's
  addendum resolves this as breakout-trigger from three code sites; I concur that reading is the
  best-supported — but making BloFin actually wait for confirmation is still an undecided
  operator choice, listed open in TODO.md.)*
- **Q2 — Is the ~0.2%-of-price stop intentional?** It is near-constant, sits inside a single 30m
  bar's range most of the time, and is the direct cause of the 183× fee leverage. If it encodes
  "zone edge + 0.2% buffer" as thesis invalidation, the thesis and the noise floor are not
  distinguishable at this width.
- **Q3 — Should C-tier signals reach the exchange at all?** They fire and trade at 0.3× size;
  they dominated the Jul 24–26 stack. Tier gating vs tier sizing is a policy choice.
- **Q4 — What is the intended maximum aggregate exposure?** Nothing in code or env bounds
  concurrent same-direction stacking (D8). 10× leverage × unlimited stacking is a policy hole,
  not a bug per se.
- **Q5 — Is demo graduation (Phase E) still conditioned on the D→E gate as written?** As
  specified it compares tracks that measure different strategies (D6, D9); the gate needs
  restating before it can be evaluated.

---

## 5. Tier 3 — Statistical hypotheses (NOT actionable)

Actionability bar: |lift| ≥10pp, BH-FDR q=0.10 survival, n ≥50, day-clustered CI on mean R
excluding zero. 14 cells tested; 8 BH-significant on the claimed accounting; **zero cells have
positive honest net mean R with a CI excluding zero.** There is no profitable subset to retreat to.

| hypothesis | evidence | status |
|---|---|---|
| A-tier least-negative under ladder accounting | net −0.094 [−0.409, +0.279], n=92 | CI includes 0 → not actionable |
| prob=85 cell positive | +0.117 [−0.782, +0.780], n=19 | n too small → not actionable |
| Long-vs-short asymmetry (claimed wr 76.7% vs 60.9%, p=7.6e-6) | ladder net: long −0.301 [−0.634, +0.088] vs short −0.730 [−1.084, −0.430] | both ≤0 honestly; direction split not tradeable |
| VAH shorts structurally weak (claimed lift −7.5pp, BH-sig) | ladder −0.833 [−1.251, −0.464] | negative but so is everything; cell-drop tuning premature until ledger fixed |
| Tier ranking (A best vs C best) flips between accountings | mine: A>B>C on ladder net; prior audit: C>B>A on spot-fill gross | ranking is accounting-dependent → treat all tier claims as unmeasured |

Note the last row: my measurement and the prior audit's *disagree on tier ordering* because the
accountings differ — which is itself evidence that no tier conclusion should drive sizing today
(currently A-tier gets the largest multiplier).

---

## 6. Reconciliation with the project record

Read after findings were frozen: `refactors/**` (incl. `btc-audit-2026-07-26.md` + addendum),
`TODO.md`, `BACKTESTING.md`, `docs/**`, `notes/audits/**`.

### Confirmed (independent corroboration — different methods, same conclusions)
- **Headline P&L is a measurement artifact** — prior D1 (98 never-touched-entry trades, +274.4R;
  median fire-gap 1.29R) vs my fill-aware measurement (502 never-filled-before-TP, +1,008.5R;
  median advantage 1.25R). Definitions differ (touch-ever vs fill-before-TP); same verdict.
- **No directional skill** — prior addendum A4 (symmetric ±k·ATR bets: 45–54%, all clustered CIs
  include 0) vs my random-entry MC (actual at 0th percentile of random). Two independent
  falsification designs agreeing is the strongest result in either audit.
- **Fees are the binding constraint** — prior: 0.273R mean fee, "nearly the entire deficit is
  fees"; mine: 0.472R on the ladder-from-fire accounting, gross +0.014R. Same conclusion at
  different accounting bases.
- **Forming-bar reads** (prior D5 = my D4/D5; mismatch tables nearly identical: 43/25/24 +
  19/5/1), **confirmation inert** (95.9% confirm; prior D6), **dedup absent / ESS ≈ half**
  (prior D7, ρ=0.347 vs my 0.349), **zone parity FAIL + 14.6/14.9% blind cycles** (prior D2/D3
  = my D10), **calibration** (Brier 0.2114/ECE 12.17 vs my 0.2122/12.0), **2026-07-02
  attribution** (−0.71R/signal on n=11 — my full-book exchange reconciliation extends it to
  n=126 with the same sign).
- **Walk-forward divergence** — prior A8 (hit rate 94.7% while losing) = my w6 (claimed 96% wr,
  ladder +26.7R, exchange bleeding). The "metric improves while economics deteriorate" failure
  mode is real and current.

### Contradicted
- **"BloFin infrastructure is the healthiest part of the system"** (prior audit, Roadmap
  section). Contradicted by live state within hours: the execution layer allowed unbounded
  stacking into margin exhaustion, silently stopped trading, and no monitor noticed (D8). The
  *order-level* plumbing (SL verify-or-flatten, recon, idempotency) is indeed sound; the
  *book-level* risk management does not exist. Both audits are right at different altitudes —
  but the roadmap sentence as written is wrong today.
- **Prior main-audit spot-fill gross +0.224R/trade [+0.03, +0.46]** vs my market-fill
  full-position gross **−0.121R/trade**. Both are defensible accountings (theirs: 30m-bar walk
  crediting plan-priced TPs; mine: 1m-resolution walk, fill = next-minute open, farthest rung in
  first touching bar). The addendum's own design-intent gross (+0.170 → net −0.102) already
  superseded the +0.224 figure. None of the variants change the sign of the net conclusion; I
  flag the spread itself as evidence that the plan-anchored R unit is too unstable to report on.

### Stale
- **`rewalk-executed.js --apply` still not re-run** — prior D4 flagged the executed-track phantom
  class; it has since *grown* (44 tp3 / 36 stop, n=80, vs 44/29 at n=73) and now measures 2.3×
  above exchange truth (my D6).
- **TODO.md "Phase D attribution — analysis complete"** is accurate but its caveats list is now
  materially incomplete: the margin-freeze/stacking failure mode post-dates it.
- **BACKTESTING.md** describes strict 30M-close confirmation and conservative same-bar handling;
  neither is what runs (D4, D5) — documented-but-wrong.
- **CLAUDE.md "Known Issues"** lists none of: phantom-fill accounting, fee burden, stacking,
  kill-switch inertness.

### Unverifiable
- Whether TV-side zone drift (prior D2's viewport-step diagnosis) is operator re-zoom vs. app
  behavior — needs a controlled experiment with the chart untouched for 14 days.
- Demo-account funding history (needed to tie the balance to cumulative P&L exactly; BloFin has
  no funding-history endpoint in the client; balance ≈ funded + realized within noise).
- BloFin post-only ("post_only") order behavior — never exercised by any probe in the repo; any
  maker-entry design depends on it (see §8).

### Blind vs reconciliation-phase findings
All of D1–D12 and the Tier-3 table were reached blind. Learned only in reconciliation: the
addendum's three-code-site resolution of entry semantics (A1), the symmetric-bet skill test as a
complementary method (A4), the refuted late-signal filter (A5 — a dead end I did not re-test and
now won't), and the 2026-07-02 attribution's per-cause decomposition.

---

## 7. Undocumented findings register (Phase 4b)

Legend — U: not documented anywhere · W: documented but wrong · S: documented but stale.

| # | what | evidence | tier | class | impact if ignored | where it should live |
|---|---|---|---|---|---|---|
| R1 | 238.3-contract stacked long; $42.70 free of $1,570.77; 34 layered SLs 63,589–63,717; liq 57,920 | BloFin positions/TPSL snapshot (scratch `blofin-snapshot.json`) | 1 | U | one gap-down liquidates the demo book; all measurement distorted meanwhile | new `refactors/2026-07-26-margin-stack-incident.md` + CLAUDE.md Known Issues |
| R2 | All signals since 07-26T01:50Z skipped `insufficient margin`; no alert class covers margin/exposure | `trades.json` executionDetail rows; `ops/watchdog.js` check list | 1 | U | execution silently dead for hours→days; forward-test sample corrupted | watchdog spec + CLAUDE.md ops table |
| R3 | Account-level exchange truth since 06-15: **+$78.41 net** over 404 filled orders; per-signal 50W/73L (40.7%); weekly +30/+81/+114/−31/−13/−103 | scratch `reconcile.js` output; orders-history | 1 | U (record has only n=11 attribution) | Phase D judged on partial joins; deterioration invisible | `refactors/` Phase D ledger note; daily-pnl-report should print cumulative |
| R4 | Executed-track vs exchange same-80-signals: +185.3R vs +81.5R (2.3×) | scratch join; D6 | 1 | S (class flagged 07-26 a.m.; magnitude-vs-exchange new) | D→E gate consults an inflated track | `executed-walk.js` header + attribution doc addendum |
| R5 | Daily-R kill switch mathematically cannot bind (anchored to +1.2R/trade-biased ledger) | `lib/daily-r.js:19-32`; claimed-vs-honest daily distributions | 1 | W (documented as active protection) | believed circuit breaker provides zero protection | CLAUDE.md execution-layer section; `daily-r.js` |
| R6 | One-direction guard permits unlimited same-direction stacking (48 longs→one book) | `blofin-autotrade.js:272-278`; R1 | 1 | U | recurrence guaranteed in any trend | autotrade design doc; Q4 decision |
| R7 | Margin-trim makes late-signal sizing path-dependent (32.3→7.4 contracts across "same" signals) | executionDetail margin-trimmed rows 07-25 | 2 | U | R-per-signal no longer comparable across the book | attribution methodology note |
| R8 | 104 forming-bar confirmations would fail strict close semantics; net claimed −65.5R (fix *raises* paper R) | scratch `verify.js` strictConfirm | 1 | W | confirmation research (1h cap, FAST/SLOW split) computed on corrupted flags | BACKTESTING.md correction |
| R9 | Canonical walk skips the fire bar's remainder (`b.time > signalTs`, open-time bars) — first 0–30min invisible | `trigger-check.js:1939` | 1 | U | stop/TP touches in the first minutes missed; adds to D5 noise | walk rewrite spec |
| R10 | BloFin fills-history retention ≈3 days (200 fills, none before Jul 22); orders-history is the only durable per-order P&L source | scratch pull | 2 | U | any future fills-based reconciliation silently truncates | `lib/blofin.js` header note |
| R11 | 13 signalIds in Mongo `blofin_orders` lack `executionStatus` in trades.json (127 vs 114) — probe/abort residue pollutes joins | Mongo vs trades.json counts | 2 | U | attribution joins overcount unless filtered | `blofin-store.js` note |
| R12 | 16 `invalidated` outcomes book −1R (confirmed) via level-break heuristic, a different loss definition than the walk's | `trigger-check.js:1283-1294` | 2 | U | mixes two loss semantics in one pnlR column | BACKTESTING.md |
| R13 | `PRIMARY` / `TRADINGVIEW_ENABLED` absent from `.env` — guards run on defaults | `.env` grep | 2 | U | partner-machine safety rails depend on unset-var behavior | `.env` hygiene pass |
| R14 | `ACCOUNT_EQUITY_USD=1500` static vs actual balance $1,570.77 (and falling available) — sizing never marks to market | `.env`; balance snapshot | 2 | U | risk% drifts from intent as equity moves | sizing spec |
| R15 | Repo-root litter: 6 `*.bak-*` ledger copies incl. untracked `.trigger-state.json.bak` | `ls` / git status | 3 | U | stale ledgers get confused for live ones in future sessions | delete or move to `notes/` |
| R16 | Fire-price recording is honest (98.1% in-bar, ≤70bp outliers) — positive integrity finding worth recording | scratch `verify.js` | — | U | future audits re-derive it | this report suffices |

---

## 8. Target design for BloFin capture (Phase 5)

**The evidence does not support any design that clears costs today.** Measured gross edge
(+0.014R/trade, ladder-from-fire; +0.170R design-intent per the prior addendum — both in-sample)
is an order of magnitude below the measured fee floor (0.27–0.47R at current geometry). Both
skill tests (symmetric-payoff; random-entry MC) fail to detect directional information. Per the
mandate, I will not fabricate a design; instead: (a) the requirements a viable signal must meet,
(b) the execution architecture that *would* capture such a signal on BloFin — every element
already exercised by existing probes except where flagged, and (c) acceptance criteria.

### 8a. Requirements for a viable signal (all evidence-cited)

| requirement | threshold | why (measurement) |
|---|---|---|
| Directional skill at symmetric geometry | ≥55% hit at ±1×ATR30m, day-clustered CI excluding 50%, ESS ≥150 across ≥2 regimes (one non-uptrend) | current: 47.8% [44.3, 51.3] (prior A4); my MC 0th pct (D2). 55% is the minimum that survives fees below |
| Gross expectancy | ≥ +0.25R/trade at the fee-reduced geometry below | fee floor 0.11–0.17R (see cost model) + margin of safety; current gross +0.014R |
| Stop width | ≥1.0×ATR30m (≈0.35–0.5% in this sample), structural, not fixed-% | 0.216% stop sits inside a single bar 82% of the time (prior A3); fee leverage scales as 1/stop |
| Ledger=exchange agreement | mean |Δ| ≤0.1R/signal over ≥30 paired signals | current tracks differ by 0.7–1.3R/signal (D6, 07-02 attribution) |
| Sample before capital | ≥150 signals post-fix, ≥60 days, ≥2 regimes, ESS-corrected | ρ=0.349 halves nominal n (D11); current data is one regime |

### 8b. Execution architecture (conditional on 8a ever passing)

- **Entry:** confirmation-triggered (strict 30M close beyond trigger, completed bars only),
  market order — taker 6bp is measured and reliable; the fill-fetch by clientOrderId works
  ([blofin-autotrade.js:133-147](../scripts/lib/blofin-autotrade.js)). A post-only maker entry
  would halve entry cost **but `post_only` has never been probed on BloFin** — treat as
  assumption requiring a probe script before any design relies on it (this repo's own docs-vs-truth
  table warns exactly here).
- **Stop:** standalone TPSL, mark trigger, verify-or-flatten — keep exactly as built
  ([blofin-autotrade.js:409-453](../scripts/lib/blofin-autotrade.js)); this subsystem measured
  correct (0 unprotected positions across recon history).
- **Targets:** single TP or 2-rung ladder at maker (2bp measured). The 3-rung ladder's third rung
  is the only rung that historically pays (prior A2: tp1 rung barely clears its own fee) —
  "insufficient evidence; requires ≥150 post-fix observations across ≥2 regimes" for any specific
  rung spacing.
- **Sizing:** flat risk fraction; **no tier multipliers** until tier evidence clears the bar
  (tier ranking flips between accountings — §5). Mark equity to the live balance (R14).
- **Book governance (unconditional — implement regardless of signal work):** max 1 open position
  per direction; new same-direction signal while a position is open → skip (or replace, operator
  choice, Q4); aggregate margin cap ≤30% of equity; watchdog alert when available margin <2×
  next-entry requirement or any signal skips on margin (R2).
- **Dedup/cooldown:** key cooldowns to *price-time cells* (e.g. 0.3%-wide price band × 24h ×
  direction), not VRVP level identity — level keys demonstrably re-mint as the viewport drifts
  (48 refires, D8; prior D7: 768→317 distinct setups).
- **Kill switch:** anchor to **exchange-realized daily net R** (orders-history is durable, R10),
  not ledger pnlR (R5).
- **Cost model:** at 1×ATR stop (~0.4%), notional/risk ≈250; taker entry + maker exit ≈
  0.0008×250 = **0.20R**; maker/maker ≈ 0.10R. Fee-in-R must be printed per trade in the ledger.
- **Data source:** exchange-native zones/indicators (P0–P2 code exists, `lib/market-data.js`) —
  the TV path is 14.9% blind and 34% decision-stable (D10); no signal research is meaningful on
  an input that disagrees with itself.

### 8c. Acceptance criteria & standing falsification
Before any capital (including continued demo interpretation): all five 8a rows green
simultaneously on the **corrected ledger**; plus a **standing falsification gate** re-run weekly:
(1) symmetric ±1×ATR skill test ≥55% with clustered CI excluding 50%, and (2) random-entry MC —
actual total must exceed the 95th percentile of 200 geometry-matched random books. Two
consecutive failing weeks → autotrade off. Expected performance under the current signal, stated
honestly: **in-sample, net −0.458R/trade [−0.695, −0.225]** (ladder-from-fire) to **−0.102R
[−0.250, +0.070]** (design-intent accounting, prior addendum). There is no out-of-sample
estimate; none should be quoted until one exists.

---

## 9. Proposed remediation sequence (not applied — measurement before tuning)

1. **Operator decision on the live book (today):** the 238-contract stack (R1) is open market
   risk with the account 97% margin-locked. Options: flatten, or hold with explicit intent.
   I did not touch it (read-only mandate). Nothing else can be forward-tested while it stands.
2. **Book governance + margin alerting** (D8/R2/R6; `blofin-autotrade.js`, `ops/watchdog.js`):
   position-count cap, aggregate margin cap, margin-skip alert. Prevents recurrence during the
   measurement window. *Expected metric effect: fewer trades; forward samples become independent.*
3. **Ledger rewrite to design-intent accounting** (D1/D4/D5/R8/R9; `trigger-check.js`
   `checkConfirmation` + `walkBarsForOutcome`): confirm only on completed 30M closes; fill =
   `confirmedPrice`; R denominator = |confirmedPrice − stop|; walk from the confirming bar on
   completed bars; unconfirmed ⇒ no trade; fees charged per trade at 6bp/2bp measured. *Expected
   effect: claimed win rate drops ~71%→~73% hit but mean R falls from +1.20 to ≈−0.10; totals go
   from +965R to ≈−78R. The numbers get worse because they become true.* Historical stats must be
   recomputed, not diffed — existing baselines measure the artifact.
4. **Executed-track: retire or fix** (D6/R4): either delete `executedOutcome` fields and use
   exchange fills exclusively (recommended — the truth already exists in orders-history), or
   reprice `walkExecutedLadder` off actual fills with fees. Re-run `rewalk-executed.js` only
   after that decision.
5. **Kill switch re-anchor** (D7/R5; `lib/daily-r.js`): compute today's R from exchange
   orders-history net, fall back to corrected ledger when the API is down.
6. **Dedup by price-time cell** (D11; `trigger-check.js` cooldown path) — after 3, so its effect
   is measured on an honest ledger.
7. **Zone-source cutover to exchange-native** (D10): recalibrate, restart the 14-day parity
   clock per the migration plan's own rule; investigate the 14.9% blind cycles regardless.
8. **Reporting honesty** (D12): weekly report prints net-of-fee R, exchange cumulative, and the
   falsification-gate status; retire the 85/74/63 probability labels until re-derived
   out-of-sample on the corrected ledger.
9. **Phase E: frozen.** Do not approach until §8c passes. The D→E gate must be restated as
   corrected-ledger vs exchange on ≥30 paired post-fix signals.

Nothing above is a tuning change; every item is measurement correctness or risk containment.
Any parameter proposal (stop width, rung spacing, tier gating, cell drops) is deferred:
**insufficient evidence; requires ≥150 post-fix observations across ≥2 regimes.**

---

## 10. Sample limitations

Single instrument, single venue, 104 calendar days (2026-04-13 → 2026-07-26), 78 signal-days,
one dominant regime (net decline ~73k→64.7k with chop; no sustained uptrend tested). Nominal
n=801; **effective n ≈ 374** (lag-1 ρ=0.349); arguably ~317 independent setups (prior D7,
corroborated by my concurrency max of 22). Exchange truth covers only 2026-06-15 onward (n=126
signals, one regime), demo microstructure (fills may be friendlier than prod). Fee model beyond
matched orders assumes the measured 6bp/2bp schedule holds at prod tiers — unverified. My 1m-bar
walks cannot resolve sub-minute path ambiguity (stop-first assumed within a 1m bar —
conservative). The MC falsification resamples geometry from the book itself, so it tests timing
skill, not geometry selection. Probability-constant regime change (2026-05-15) and the
2026-07-05 parser fix partition the sample; segment cells span both. Session memory contained
prior-audit one-liners (disclosed in header) — methods and numbers here were derived from raw
data regardless.
