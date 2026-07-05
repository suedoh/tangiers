# Warm-ups: order-doc `kind` wiring + watchdog runs-but-errors detection

**Date:** 2026-07-05
**Files:** `scripts/lib/blofin-store.js`, `scripts/lib/blofin-autotrade.js`, `scripts/ops/watchdog.js`
**Trigger:** two minor findings from the 2026-07-04 audit, folded in ahead of the signal-brain audit

## 1. `kind` was never set on entry/TP docs

The CLAUDE.md schema specifies `kind: 'entry'|'tp_limit'|'sl_conditional'`,
but only the SL path (`persistTPSL`) ever set it — `placeAndPersist` and
`persistAdoptedEntry` omitted it, so 138 of 168 docs were kindless and the
Phase D attribution join can't separate entries from rungs.

- `placeAndPersist` now takes `{ kind }`; autotrade passes `'entry'` /
  `'tp_limit'`; adopted entries hardcode `'entry'`.
- Backfill by orderType inference (autotrade only ever places market
  entries and limit rungs): 39 market→entry, 99 limit→tp_limit, 0 left
  ambiguous. Final distribution: 99 tp_limit / 39 entry / 30 sl_conditional.

## 2. Watchdog said `recon=ok` through the E11000 loop

`checkReconFresh` only checked log mtime — recon *ran* every 3 min while
erroring on every pass, so the 07-04 loop never struck. The check now also
scans the last pass (final 4KB of the log) for `reconcile errors: N` /
`resolve errors: N` and fails the recon class when found; the existing
2-strike/cooldown alert flow applies unchanged. Verified: live run green
on today's clean log; regex matches the historical erroring pass shape.
