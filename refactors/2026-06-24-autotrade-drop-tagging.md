# Autotrade execution-disposition tagging (Phase D measurement fix)

**Date:** 2026-06-24
**Status:** DONE
**Files:** [scripts/trigger-check.js](../scripts/trigger-check.js) (`markExecution`), [scripts/blofin/backfill-execution-status.js](../scripts/blofin/backfill-execution-status.js)
**Predecessor investigation:** autotrade timeout audit (this session)
**Related (proposed):** [2026-06-24-autotrade-retry-design.md](2026-06-24-autotrade-retry-design.md)

## Why

Phase D's exit gate compares **paper P&L (exchange fills)** against **trades.json
hypothetical expectancy** and requires them within ±20%. But a signal that never
reached the exchange — API timeout, deliberate skip, or aborted entry — still
sits in trades.json with a hypothetical outcome. Those rows drag the comparison
as a **pure artifact, not real slippage**.

This bit us concretely: 2 of 9 post-launch Phase-D autotrade attempts (22%) were
silently dropped on a 10s BloFin API timeout ([blofin.js:97](../scripts/lib/blofin.js#L97)),
with no retry and no tag. By luck the dropped set included the window's **only
A-tier signal** and a **+2R B-tier winner** — i.e. the drops were biased toward
the highest-value trades, which would make Phase D understate executed edge.

This change does NOT fix the drop (see the proposed retry design). It makes the
drop **measurable** so the Phase-D attribution query can exclude bug-drops and
pre-launch signals instead of conflating them with genuine fill friction.

## What changed

`markExecution(signalId, status, detail)` in trigger-check.js, called from the
autotrade fire-and-forget callback. Stamps every signal with one of:

| status | meaning |
|---|---|
| `placed` | orders confirmed on the exchange |
| `skipped` | autotrade deliberately declined (daily-R kill, sizing, disabled, idempotent) |
| `aborted` | entry placed then auto-flattened (SL verify failed — Phase B.6) |
| `dropped` | autotrade threw (timeout / API error) — the execution-bug bucket |

Fire-and-forget safe: re-reads trades.json fresh, mutates one record, never
throws (a throw would break the promise callback chain).

## Historical backfill

`scripts/blofin/backfill-execution-status.js` labels the 24 Phase-D signals that
fired before the live tagging existed. Disposition is derived from **Mongo ground
truth** (a `blofin_orders` doc for the signalId = placed), not log parsing:

```
Phase D backfill: placed=7 dropped=2 skipped/pre-launch=15
```

- 7 placed (have exchange order docs)
- 2 dropped (post-launch, fully qualified, no exchange order — the timeouts:
  `1781681411832-VAH-65724` B-short→TP1, `1782137423928-VAH-65080` A-long→unresolved)
- 15 skipped/pre-launch (fired before the autotrade hook shipped 2026-06-16T07:03Z)

Backup written to `trades.json.bak-execstatus-<ts>`. Script is idempotent and
re-runnable; only touches `firedAt >= 2026-06-15` records.

## Risk

- **Zero impact on signal generation or execution.** This only adds three fields
  (`executionStatus`, `executionDetail`, `executionAt`) to trade records.
- Does not change which signals fire, autotrade, or how outcomes resolve.
- Partner machine (`PRIMARY=false`, autotrade off): every signal tags `skipped`
  with the disabled reason — accurate, harmless.

## How the Phase D query uses it

When the attribution analysis runs (~mid-July, ≥15 paired signals — see TODO.md),
the paper-vs-hypothetical comparison filters to `executionStatus === 'placed'`.
Dropped rows are reported **separately** as an execution-reliability metric, not
folded into the slippage number. This keeps the D→E gate honest.

## Follow-up

The drop itself is still unfixed — a transient timeout still loses the trade.
Fixing it safely needs idempotent retry (clientOrdId + reconcile-before-retry),
designed in [2026-06-24-autotrade-retry-design.md](2026-06-24-autotrade-retry-design.md).
That is money-path surgery and is gated on a read-only probe + user sign-off.
