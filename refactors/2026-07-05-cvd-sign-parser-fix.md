# Signal-brain fixes: CVD sign flip, unit chaos, phantom invalidations

**Date:** 2026-07-05
**Files:** `scripts/lib/parse-num.js` (new), `scripts/lib/parse-num.test.js` (new), `scripts/trigger-check.js`
**Trigger:** signal-brain audit (2026-07-05) — full read of trigger-check
internals + ground-truth probes. Baseline snapshot taken pre-fix:
`notes/audits/baseline-2026-07-05-pre-parser-fix.json` (n=704).

## F1 — CVD sign destroyed on the CDP path (since inception)

`parseFloat_` stripped `[^0-9.\-]`, which drops TradingView's Unicode minus
(U+2212). Live raw string at fix time: `−2.96 K` (U+2212 + U+202F narrow
space + K) — old parser → **+2.96**; correct value → **−2,960**. Both the
sign and the magnitude were wrong in one string.

Empirical proof from 3 months of logs: **7,841 CDP-path CVD reads, zero
negative**; the Binance fallback's 503 reads split 252/251 neg/pos — the
same market is negative half the time. Poly's parser normalized U+2212
explicitly; BTC never got the fix.

Blast radius of every `cvd < 0` consumer on the primary path: short
CVD-alignment criterion (never credited → shorts under-tiered → undersized
on BloFin; longs credited on bearish flow → over-tiered → oversized),
direction-aware cooldown bypass (dead code), break-vs-stop-hunt verdicts
(long breaks ~never "REAL BREAK" without high volume), reclaim
confirmation for shorts (dead), pending-confirmation deltas (garbage).

## F2 — K/M/B suffixes stripped → cross-magnitude garbage

"1.92K" → 1.92 while "980" → 980: deltas, `CVD_CONFIRM_MIN=200`, and
baselines compared incompatible scales (log history shows CVD values from
1.2 to 6,521 — mixed systems). The 11 historical pending-confirmation
fires are suspect as unit artifacts.

## F3 — OI unit mismatch between CDP and Binance fallback

CDP "105.68 K" (K BTC) vs fallback `oiCoins×price/1e9` ($B ≈ 6.7); the
fallback engaged 589 times, corrupting `_previousOI` trends and baselines.

## F4 — phantom −1R on unconfirmed invalidations

`checkInvalidations` booked ANY nearby open trade at −1R. All 13
invalidated trades in the record were unconfirmed — by BACKTESTING.md's
own rule (no confirmation = no position) that is −13R of phantom losses
in the canonical record and the daily-R kill-switch input.

## Fixes

- **`lib/parse-num.js`** — `parseStudyNum()`: U+2212→'-', commas stripped,
  K/M/B expanded to raw magnitude, suffix guarded against letter-following
  false positives ("106.84 BTC" ≠ billions). 17 unit tests.
  `parseFloat_` in trigger-check delegates to it.
- **`fetchOIBinance`** returns raw coins — same unit as the expanded CDP
  read (verified live: CDP 105,680 vs Binance 105,563 BTC, 0.1%).
- **`getOITrend`** flat band is now relative (0.05% ≈ old behavior at the
  historical scale) + >10× scale-jump guard returns null (unit-migration
  safety).
- **`checkInvalidations`** books unconfirmed invalidations at 0R
  (confirmed keep −1R).
- **Heals:** 13 records → 0R (+13R canonical correction, backup
  `trades.json.bak-invalheal-*`); `_previousOI`/`_cvdHistory` cleared from
  state (old units).

## Verification

- 17/17 parser unit tests pass, including the exact live string shapes.
- Live end-to-end probe: raw study strings → new parser → sign preserved,
  OI matches Binance coins to 0.1%.
- Bar-data ground truth (context): 39/39 closed 30M chart bars match
  Binance klines at $0.0 diff — outcome labels were never affected.
- `node --check` clean; next cron cycle runs the fixed parser.

## Measurement notes (important)

- **Phase D interaction:** this changes tier composition (CVD criterion
  now correct) and therefore BloFin sizing going forward. Clean-signal
  measurement effectively restarts 2026-07-05; ~3 days since the 07-02
  restart are pre-fix.
- **Expect distribution shifts, not necessarily wr improvement:** more
  shorts reaching A/B tier, fewer longs at A tier. Diff after ≥30 days:
  `node scripts/audit/win-rate-diff.js --diff notes/audits/baseline-2026-07-05-pre-parser-fix.json --since 2026-07-05`.
- `CVD_CONFIRM_MIN=200` and OI thresholds were NOT retuned (correctness
  fix only). With units now coherent (raw volume), revisit thresholds
  only through the gated tuning process.
- Poly BTC-5 deliberately untouched: its parser already keeps the sign;
  its suffix-stripping is a known sibling issue but changing it would
  alter factor behavior mid-OOS-accumulation (Phase 2 discipline gate).
