# Execution-model fixes — the three attribution-verdict decisions, shipped

**Date:** 2026-07-02
**Status:** DONE — all paths probed on demo; one bug found during live verification and fixed before ship.
**Predecessor:** [2026-07-02-phase-d-attribution.md](2026-07-02-phase-d-attribution.md) (verdict: −0.71R/signal systematic delta, exchange fills become ground truth)
**Files:** [blofin-autotrade.js](../scripts/lib/blofin-autotrade.js), [trigger-check.js](../scripts/trigger-check.js), [autotrade-probe.js](../scripts/blofin/autotrade-probe.js), [degraded-probe.js](../scripts/blofin/degraded-probe.js)

## Fix 1 — ladder repriced off the actual fill (+ risk trim)

New flow after entry: fetch actual fill (orders-history by clientOrderId, ~200ms; fallback to planned entry = old behavior) → **risk trim** if fill→stop distance >1.25× plan (reduce-only market brings dollar risk back to budget) → **`repriceLadder()`**: rungs not ≥ minGap (`max(5bps, 0.1×stopDist)`) beyond the fill are burned; their size redistributes to survivors so a full TP run still flattens; zero survivors ⇒ flatten + `aborted` (the market consumed the target zone before we got in).

**Design deviations from the attribution doc's wording, deliberate:**
- **SL price stays structural** (zone break = thesis invalidation). Dragging the stop toward the fill to preserve R-distance would raise wick-out probability; instead *size* absorbs the slippage (trim). Decomposition of the −2.49R stop that motivated this: 64.5pts fill-chase (trim fixes) + 56.8pts SL trigger-to-fill slippage (venue physics — measured, not fixable).
- **TP prices stay structural** (HVN/VAL targets are where liquidity sits) — burned rungs are dropped, not re-projected as synthetic R-multiples.

## Fix 2 — executed-hypothetical track (measurement option shipped)

Placed signals bar-walk from fire-time into **separate fields** (`executedOutcome/executedPnlR/executedClosedAt`). Canonical outcome pipeline (confirmation-gated), daily-R kill, weekly cohorts, and win-rate-diff anomaly counters are byte-identical — the observation-window discipline holds. **The strategic decision (confirmation-gated autotrade entry) remains open** — deliberately deferred; this measurement ships first because it's reversible and quantifies the gap the decision needs.

## Fix 3 — one-direction book guard

Before entry: `getPositions`; opposite-direction net position ⇒ skip (`executionStatus='skipped'`). Fail-open on read errors — blocking the money path on a stalled read is how signals used to get dropped. Same-direction stacking stays allowed (B.6 posture).

## Verification (demo, live)

- `repriceLadder` unit cases (4): survive/burn/mirror/boundary — pass.
- **Scenario A** (near-mark): fill captured live at 61525.1 vs 61491.8 planned (33pts real chase), no trim, no burns, 5 orders + 5 Mongo docs, idempotency intact.
- **Scenario B**: opposite-direction signal correctly skipped against the open long (`net 48.7`).
- **Scenario C** (pre-fix probe geometry, entry 5% below mark): all rungs burned ⇒ **aborted + verified flat**. Note: the old probe "passed" on this geometry — instant-filling rungs were the bug being tested around.
- **Executed track**: Jun-27 pair resolved `stop` @ 13:00/21:00 bars — matching the exchange SL fills at 13:03/21:23. Cross-source agreement.
- Degraded probe geometry updated to near-mark (its old 5%-below synthetic now correctly aborts — covered by scenario C instead).

## Bug found during verification (why we verify)

First live run mislabeled **16 stale trades**: the executed-track walked trades that fired *before* the 7-day bar window, starting mid-history — all "resolved" on the window's first wide bar. Fixed with a window guard (`signalTs ≥ bars[0].time`; pre-window trades stay null → 30d expiry; their truth lives in `blofin_orders`). The 16 bogus labels were stripped (backup `trades.json.bak-executedtrack-fix`); the 2 valid Jun-27 labels kept.

## Phase D restated

Exchange fills are ground truth (attribution script re-runs at the gate). Execution now: guard → entry → fill → trim → verified SL → repriced ladder. Clean-day clock runs from 2026-07-02; D→E needs ≥30 days of exchange-truth measurement on THIS execution model. Open decisions: confirmation-gated entry (strategic, needs the executed-vs-canonical gap data now accumulating), SL slippage measurement over more stops.
