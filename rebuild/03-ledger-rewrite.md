# 03 — Ledger rewrite: design-intent accounting

**Type:** measurement correctness · **Depends on:** nothing (parallel with 02) ·
**Audit refs:** D1, D4, D5, R8, R9 · **Files:** [scripts/trigger-check.js](../scripts/trigger-check.js)
(`checkConfirmation` :1628, `walkBarsForOutcome` :1870, `updateOutcomes` :1890)

This is the single most important fix in the rebuild. Until it lands, every performance number
the system produces is untrusted, and specs 07/09 cannot start.

## The defect being fixed

`walkBarsForOutcome` (trigger-check.js:1870) walks stop/TP hits from the raw bar sequence and
**never checks whether price ever reached `t.entry`**. Combined with TP distances measured from
that fictional entry, 502/801 historical signals were scored on trades that never filled;
465 of them booked as wins worth +1,008.5R. `checkConfirmation` (:1628) additionally confirms
on a TV OHLCV series that includes the **in-progress** 30M bar (D4), and outcome stamping can
read forming bars, violating the documented stop-first rule (D5).

## Required behavior — "design-intent accounting"

The trade the ledger scores must be a trade someone could have taken:

1. **Confirmation = completed 30M closes only.** Filter the bar series to bars whose close time
   ≤ now before evaluating. A signal confirms when a *completed* 30M bar closes beyond the
   trigger in the signal direction, within `CONFIRM_MAX_AGE_SEC` (unchanged, 1h — :1618).
2. **Fill = `confirmedPrice`** (the confirming bar's close). The planned `entry` field remains
   recorded for forensics but is never a fill.
3. **R denominator = |confirmedPrice − stop|.** All R math re-keys off this. (Stop *price*
   stays structural, per the existing zone-break thesis-invalidation rule.)
4. **Walk from the bar after confirmation, completed bars only.** Replaces the
   `b.time > signalTs` filter (:1939) with `b.closeTime > confirmTs && b.closeTime <= now`.
5. **Same-bar ambiguity: stop-first** (both stop and TP inside one bar ⇒ stop). This is the
   documented rule; now it is actually enforced because forming bars are excluded. Document it
   next to the walker.
6. **Unconfirmed ⇒ no trade.** Status `expired_unconfirmed`; excluded from all performance
   aggregates (reported separately as a count).
7. **Fees charged per trade, in R, stored per trade** (`feeR` field): entry 6bp taker; each TP
   rung exit 2bp maker; stop exit 6bp taker — the measured schedule (audit D3). Fee in R =
   `(feeRate × notional legs) / (riskPerUnit × size)`; with the ladder, weight legs by rung size.
   `pnlR` becomes **net of fees**; store `grossR` alongside.
8. **TP ladder distances re-anchored to `confirmedPrice`**, same 1/3-1/3-1/3 structure
   (structure changes are spec 07/08 territory, not here).

## Field migration

- New canonical fields: `fillPrice` (=confirmedPrice), `riskPerUnit`, `grossR`, `feeR`, `pnlR`
  (net), `accounting: 'design-intent-v1'`.
- Old values preserved: copy the previous `outcome`/`pnlR` into `legacyOutcome`/`legacyPnlR`
  once, at migration. Never delete.
- Mongo sync (`scripts/migrate/import-trades.js`) carries the new fields through unchanged.

## Historical recompute (not diff)

Recompute **every** historical signal under the new walker using Binance 30m klines
([scripts/lib/binance.js](../scripts/lib/binance.js) `getKlinesRange`; the audit already pulled
2026-04-13→07-26 with zero gaps — regenerate with [tools/fetch-klines.js](tools/fetch-klines.js)).
Write to `legacy*`+new fields in place (backup `trades.json` first, `.bak-<ts>` per project
convention). Existing win-rate-diff baselines measure the artifact — **do not diff against
them**; snapshot a fresh baseline after recompute (pre/post metrics protocol).

## Acceptance checks

1. **Independent cross-check:** re-run the audit's verifier ([tools/verify.js](tools/verify.js),
   1m-resolution walk) against the recomputed ledger. Per-signal agreement required on outcome
   class for ≥98% of confirmed signals; every disagreement listed and explained (1m vs 30m
   granularity is the only acceptable cause).
2. **Expected magnitudes** (from the audit's re-walk of the same history): total ≈ **−78R net**,
   mean ≈ **−0.10R**, hit ~73%. If the recompute lands near +900R, the rewrite is wrong —
   find the fictional fill path and fix it. Large deviation in either direction ⇒ investigate
   before accepting.
3. **Forming-bar test:** unit-test `checkConfirmation` with a synthetic series whose last bar
   is in-progress and beyond entry ⇒ must NOT confirm; same series with the bar completed ⇒
   confirms.
4. **No-entry-touch test:** synthetic signal where price runs to TP3 without ever printing
   `confirmedPrice` after signal time ⇒ `expired_unconfirmed`, not a win.
5. Verify exit codes directly (`cmd; echo $?`), never through a pipe.

## Expected metric effect (state it up front, everywhere)

Claimed performance collapses: **+965R → ≈ −78R**. Win rate roughly holds (~71→~73%) but mean R
goes **+1.20 → ≈ −0.10**. The numbers get worse because they become true. The weekly report
will look broken; it isn't — spec 04/09 make the reporting honest to match.

## Definition of Done

- [ ] New confirmation + walker live; unit tests 3–4 pass
- [ ] Historical recompute done; verifier agreement ≥98%; deltas explained
- [ ] `legacy*` fields preserved; Mongo sync carries new schema
- [ ] Fresh post-fix baseline snapshotted (`scripts/audit/win-rate-diff.js`)
- [ ] Refactors note with before/after totals committed
