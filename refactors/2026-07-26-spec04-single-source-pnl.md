# Spec 04 — Single source of P&L truth (2026-07-26)

**Files:** `scripts/lib/executed-walk.js` (+test) **deleted**,
`scripts/trigger-check.js` (executed-track loop removed, kill-switch gate async),
`scripts/lib/daily-r.js` (rewritten), `scripts/blofin/attribution.js` (new —
promoted from `rebuild/tools/reconcile.js`).

## What changed

- **Executed-hypothetical track retired** (D6 — 2.3× overstated: plan-entry
  pricing, fire-time walk, zero fees). The walker call is gone from
  `updateOutcomes`; `executedOutcome/executedPnlR/executedClosedAt` are frozen
  in place, nothing writes them. `executed-walk.js` deleted (git history
  preserves it). `scripts/blofin/rewalk-executed.js` (stale per audit §6) now
  fails at require — cannot run; delete at integration (file owned outside
  this change set).
- **Kill switch re-anchored** (D7). `daily-r.js`: primary = exchange-realized
  net R today from orders-history — per-order (pnl − fee), divided by the
  signal's actual $-risk (spec-03 `riskPerUnit` × entry filled size; Mongo
  join for exits; unattributed flow divides by the standing risk budget so
  unmatched losses still count). Fallback on API error = corrected-ledger
  pnlR + YELLOW alert (rate-limited 30 min, `.daily-r-alert.json`). Floor
  −3.0 unchanged. Sync `todayUtcR()` kept for blofin-autotrade's
  defense-in-depth gate.
- **`attribution.js` standing job** (daily, host cron after the P&L report —
  cron line in the file header, install at integration): orders-history →
  signal join (Mongo `blofin_orders` + entry clientOrderId), per-signal
  exchange pnl/fee/net USD/net R with **actual-risk denominator** (not the
  audit's tier table), persists `exchangeNetR`/`exchangeFeeUsd`
  (+`exchangeNetUsd`/`exchangeRiskUsd`) onto trade records under the shared
  lock with a fresh re-read (no clobbering). Posts paired count, trailing-30
  mean |ledger−exchange| Δ, cumulative net; **red alert if mean |Δ| > 0.1R**
  (spec-09 ledger-trust invariant).

## Acceptance evidence

- Attribution reproduces the audit reconciliation **exactly**: 126 signals,
  matched gross **$688.90**, fees **$251.76**. Total net $204.83 vs audit's
  $78.41 — drift is **one** post-audit reduce-only fill of **+$126.41**
  (verified by timestamp; 78.41 + 126.41 = 204.82 ✓).
- Kill-switch tests: −3.2R mocked fills ⇒ active (exchange source); −2.9R ⇒
  not active; API error ⇒ ledger fallback + yellow alert. 14/14 in
  `scripts/tests/ledger.test.js`.
- Grep: no live writer of `executed*` fields remains (only the crash-on-require
  stale rewalk script and a frozen-fields comment).
- Trailing-30 mean |Δ| currently **0.564R > 0.1R** — expected: old-regime
  executions traded proximity-fire while the corrected ledger scores the
  confirmation event. This is the D9 mismatch that moving autotrade to
  confirmation time (spec 08 item 3) exists to close; the invariant is the
  measurement of that closure.

## Integration steps (operator)

1. Host cron: `10 17 * * * node scripts/blofin/attribution.js` (after daily P&L).
2. Delete `scripts/blofin/rewalk-executed.js` (premise dead; require broken).
3. First non-dry attribution run persists exchange fields onto live trades.json.
