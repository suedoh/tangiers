# REBUILD — BTC → BloFin Automated Execution

**End state:** automated, high-probability BTC trade setups executing on BloFin with real
capital and high conviction — where "high conviction" is *earned* by passing every gate in
[09-acceptance-gates.md](09-acceptance-gates.md), not asserted.

**Why this folder exists:** the 2026-07-26 independent audit
([refactors/btc-audit-2026-07-26-independent.md](../refactors/btc-audit-2026-07-26-independent.md))
proved the current system's +965R track record is a measurement artifact (fictional fills, no
fees) and that the signal, measured honestly, has **no directional edge** (47.8% at symmetric
geometry; random entries beat it). The execution plumbing is largely sound. This folder specs
the rebuild: make the measurement honest → contain risk → re-prove (or replace) the signal →
gate capital.

## How to work this folder

- Execute specs **in numeric order**. Dependencies are explicit; do not reorder.
  Measurement correctness always precedes tuning — never "improve" the signal on a broken ledger.
- Each spec has a **Definition of Done**. A spec is not done until its acceptance checks pass
  and the result is committed with a short analysis note in `refactors/` (project convention).
- **Present the proposed change to the operator and get explicit agreement before implementing**
  each spec (project workflow rule), then implement + commit + push.
- Where a spec says *operator decision*, stop and ask. Do not decide for them.
- Where a number is marked **"insufficient evidence; requires ≥N observations"**, do not invent
  a value. Collect the observations.

## Work order and status

| # | Spec | Depends on | Type | Status |
|---|---|---|---|---|
| 01 | [Live book decision](01-live-book-decision.md) | — | operator gate | ☐ |
| 02 | [Book governance + margin alerting](02-book-governance.md) | 01 | risk containment | ☐ |
| 03 | [Ledger rewrite — design-intent accounting](03-ledger-rewrite.md) | — | measurement | ☐ |
| 04 | [Single source of P&L truth](04-single-source-pnl.md) | 03 | measurement | ☐ |
| 05 | [Dedup by price-time cell](05-dedup-price-time.md) | 03 | measurement/risk | ☐ |
| 06 | [Exchange-native data cutover](06-exchange-native-data.md) | — (parallel OK) | data integrity | ☐ |
| 07 | [Signal research & falsification harness](07-signal-research.md) | 03, 04, 05, 06 | edge | ☐ |
| 08 | [Execution layer changes](08-execution-layer.md) | 02; live-fire gated on 07 | execution | ☐ |
| 09 | [Acceptance gates → Phase E](09-acceptance-gates.md) | all | capital gate | ☐ |

`00-context.md` is background reading — start there.

## Hard rules (non-negotiable)

1. **`BLOFIN_ENV=demo` until spec 09's Phase E gate passes with operator sign-off.** Never touch
   prod credentials before that.
2. **Probe first, trust later.** BloFin docs are known-wrong (see the docs-vs-truth table in
   [CLAUDE.md](../CLAUDE.md)). Any BloFin API feature not already exercised by an existing probe
   script gets a new probe script under `scripts/blofin/` before any code relies on it.
3. **No parameter tuning before spec 07's sample bar is met** (≥150 post-fix signals, ≥60 days,
   ≥2 regimes). Tuning on the current single-regime in-sample data is curve-fitting.
4. **Correctness fixes are expected to make numbers worse.** The corrected ledger will show
   ≈ −78R where +965R was claimed. That is success, not regression. Never "fix the fix" to
   restore old numbers.
5. **Recompute, don't diff.** Historical baselines (win-rate-diff snapshots) measure the old
   artifact. After the ledger rewrite, historical stats are recomputed from scratch.
6. Read-only analysis tools live in [tools/](tools/README.md) — the audit's independent
   verification stack. Reuse them; they are the reference implementation for "honest".

## Key definitions

- **R** — risk unit: `|fill − stop| × size` in USD. All performance is stated in R, **net of fees**.
- **Design-intent accounting** — the trade the system *means* to take: entry = the confirming
  30M close price, R denominator = |confirmedPrice − stop|, walked on completed bars only,
  fees charged. This is what spec 03 makes canonical.
- **Symmetric skill test** — % of signals where price moves +1×ATR30m in the signal direction
  before −1×ATR30m against, from the honest entry. Removes payoff geometry; isolates
  directional forecasting. The primary edge metric (spec 07).
- **ESS** — effective sample size after lag-1 autocorrelation correction (ρ=0.349 halves
  nominal n on current data).
- **Ledger↔exchange agreement** — mean |ledger R − exchange net R| per paired signal. Must be
  ≤0.1R before any ledger number is trusted for capital decisions.

## The five numbers that drove this rebuild (audit, 2026-07-26)

1. **502/801** recorded signals never traded through their planned entry before a TP —
   465 of them booked as wins worth **+1,008.5R** of the claimed +964.7R total.
2. Random-time entries with identical trade geometry: median **+1,032R** [966, 1,179] —
   the actual signal book sits at the **0th percentile**. No detectable timing skill.
3. Symmetric ±1×ATR hit rate: **47.8%** [44.3, 51.3]. A coin.
4. Measured fees **0.27–0.47R/trade** (6bp taker / 2bp maker at ~183× notional-to-risk)
   vs gross edge **+0.014R/trade**. Costs exceed edge ~30×.
5. Exchange truth since 2026-06-15: **+$78.41 net**, last three weeks negative, while the
   executed-hypothetical track claimed +185.3R for the same signals (2.3× overstatement).
