# Spec 03 — Ledger rewrite: design-intent accounting (2026-07-26)

**Files:** `scripts/trigger-check.js` (`decideConfirmation`, `unconfirmedExpiry`,
`walkBarsForOutcome`, `checkConfirmation`, `updateOutcomes`, `logTrade`),
`scripts/audit/recompute-history.js` (new), `scripts/tests/ledger.test.js` (new),
`scripts/migrate/import-trades.js` (comment — spread already carries new fields).

## What changed

- **Confirmation = completed 30M closes only** (D4). The TV series includes the
  forming bar; `decideConfirmation` now rejects any bar whose close time > now.
  Watch window extended by one bar so late-completing candidates are still seen.
- **Fill = confirmedPrice; R denominator = riskPerUnit = |fill − stop|** (D1).
  Planned `entry` is forensics only. New fields: `fillPrice`, `riskPerUnit`,
  `accounting:'design-intent-v1'`, `grossR`, `feeR`, net `pnlR`.
- **Walker**: 1/3 ladder re-anchored to the fill, walked on completed bars after
  the confirming close (`closeTime > confirmTs && <= now`), stop-first on
  same-bar ambiguity (now actually enforced — D5), fees 6bp taker entry/stop +
  2bp maker rungs. Outcome label = terminal event (`tp3` full run, `stop`
  remainder; partial rungs keep their banked R inside pnlR).
- **Unconfirmed ⇒ no trade**: `expired_unconfirmed`, `pnlR:null` (excluded from
  all aggregates), stamped as soon as the 1h window closes — not after 30 days.
- **7-day-window guard** on the canonical walk (same class as the 2026-07-02
  executed-track fix): never walk from mid-history.
- trigger-check.js is now requireable as a module (`require.main` gates; CDP
  require guarded) so tests + recompute share ONE walker implementation.

## Recompute of full history (scratch copy, Binance klines, zero gaps)

| | legacy claim | design-intent recompute |
|---|---|---|
| resolved | 801 | 633 (+128 expired_unconfirmed, +40 open) |
| total R | **+964.7** | **−131.4 net** (−15.6 gross, 115.8 fees) |
| mean R | +1.20 | **−0.208** |
| tp1-touch | ~71% | 75.5% |

1m cross-verification: **633/633 outcome-class agreement**, grossR mean |Δ|
0.008R (>0.05R on 9/633 — 30m stop-first vs 1m sequencing only).

## Delta vs the audit's ≈ −78R expectation — explained, not tuned

Audit's estimate was anchored on **recorded** (forming-bar) confirmations.
Reproduced: ladder+fees from recorded confirms = **+21.6R** (≈ +0.2R/trade
gross — matches the audit addendum's +0.170R). Strict completed-close
confirmation additionally:
- drops **104** recorded confirms that never strictly confirm — the exact D4
  count;
- moves fills further into the move: mean +0.046R/trade worse ≈ −30R total.

Worse numbers are the point. Legacy values preserved once in
`legacyOutcome/legacyPnlR/legacyConfirmed*` (idempotent on re-run).

## Integration (operator, cron paused)

```
node scripts/audit/recompute-history.js --trades trades.json --klines <klines-dir> --verify
node scripts/audit/win-rate-diff.js --snapshot <fresh-baseline>   # never diff old baselines
```
