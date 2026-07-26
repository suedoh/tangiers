# 04 — Single source of P&L truth

**Type:** measurement correctness · **Depends on:** 03 · **Audit refs:** D6, D7, D9, R4, R5, R10
**Files:** [scripts/lib/executed-walk.js](../scripts/lib/executed-walk.js),
[scripts/lib/daily-r.js](../scripts/lib/daily-r.js), [scripts/trigger-check.js](../scripts/trigger-check.js)
(executed-track loop inside `updateOutcomes`), `scripts/blofin/recon-once.js`

Today three books disagree about the same trades (D9): the canonical ledger (fiction, fixed by
spec 03), the executed-hypothetical track (2.3× overstated — D6), and BloFin's own
orders-history (truth). After this spec there are exactly **two**: the design-intent ledger
(what the strategy *should* earn) and exchange fills (what it *did* earn) — plus a standing
job that measures the gap between them.

## 4.1 Retire the executed-hypothetical track

`walkExecutedLadder` ([executed-walk.js](../scripts/lib/executed-walk.js)) prices rungs off the
*planned* entry, walks from fire-time, and charges no fees. The exchange already records the
truth it tries to estimate. Therefore:

- Delete the executed-track walker call from `updateOutcomes`; stop writing
  `executedOutcome`/`executedPnlR`/`executedClosedAt`. Freeze existing values in place
  (historical forensics only; rename nothing).
- Remove `executed-walk.js` from the live path (keep the file with a deprecation header, or
  delete it and note the commit — operator's taste; default: delete, git history preserves it).
- Do **not** run the pending `rewalk-executed.js --apply` (stale — audit §6 "Stale"). Its
  premise died with the track.

## 4.2 Exchange-fill attribution as a standing job

Promote the audit's reconciliation ([tools/reconcile.js](tools/reconcile.js)) into
`scripts/blofin/attribution.js`, run daily (host cron, after the daily P&L report):

- Join orders-history → signalId via Mongo `blofin_orders` + entry clientOrderId (the only
  join path; see tools/reconcile.js:11–16).
- Per signal: exchange `pnl`, `fee`, net USD, net R (denominator = the signal's *actual*
  `riskPerUnit × size` from spec 03 fields — **not** the tier table; tier $-R was an audit
  approximation).
- Persist per-signal exchange R onto the trade record (`exchangeNetR`, `exchangeFeeUsd`).
- Daily post to `#blofin-recon`: paired-signal count, mean |ledger R − exchange R|, cumulative
  exchange net. **Alert (red) if mean |Δ| > 0.1R over the trailing 30 paired signals** — that
  is the ledger-trust invariant from spec 09.

## 4.3 Re-anchor the daily kill switch

[daily-r.js](../scripts/lib/daily-r.js) `todayUtcR()` (:21) sums ledger `pnlR` — under the old
ledger it watched fiction (D7). Change to:

- **Primary:** exchange-realized net R today (UTC) from orders-history (sum `pnl − fee` per
  filled exit order since UTC midnight, ÷ the per-signal $-risk from 4.2). Orders-history is
  durable and survives local state loss (R10).
- **Fallback:** if the BloFin API is unreachable, use the corrected ledger's `pnlR` for trades
  closed today, and post a yellow info alert that the kill switch is on fallback.
- `DAILY_R_KILL_FLOOR = -3.0` (:19) unchanged — no evidence-based reason to move it, and
  re-tuning thresholds is out of scope until spec 07's sample bar.

## Acceptance checks

1. `attribution.js` output on current history reproduces the audit's reconciliation totals
   (+$78.41 net since 2026-06-15 ±drift from new activity; same paired-signal count method).
2. Kill-switch unit test: mock orders-history with −3.2R of fills today ⇒ `isKillActive()`
   true; API error ⇒ fallback path + alert fires.
3. Grep proves no live code path writes `executedOutcome`/`executedPnlR` anymore.
4. One full recon + attribution cycle runs clean on host cron (check exit codes directly).

## Definition of Done

- [ ] Executed-track retired; fields frozen; rewalk script marked stale/removed
- [ ] `attribution.js` daily job live, posting to `#blofin-recon`
- [ ] Kill switch reads exchange truth with alerting fallback; tests pass
- [ ] Refactors note committed
