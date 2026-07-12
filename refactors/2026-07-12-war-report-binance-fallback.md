# 2026-07-12 — Weekly War Report: Binance fallback for CDP data

## Symptom
Every BTC Weekly War Report since 2026-06-16 posted with `—` for LW O/H/L/C,
current price, weekly trend/RSI, `$0` scenario triggers, and inverted S/R
classification (Monthly Low listed as *resistance*). Script still logged
"posted successfully" — no alert ever fired.

## Root cause
`weekly-war-report.js` sourced price, weekly bars, and VWAP from TradingView
CDP (`localhost:9222`). The 2026-06-16 migration moved it into the Docker
`ace-cron` container, which **can never reach CDP** (documented permanent
constraint). Every Sunday run since: `ECONNREFUSED` → nulls cascade.
- `$0` triggers: `Math.round(null)` → `0`
- Inverted S/R: `level > null` → `true` → every level bucketed "R"

Same failure class as the recon 403 fix (2026-07-02): container ≠ host network.

## Fix (commit this file's sha)
1. `fetchWeeklyBarsFromBinance()` + `fetchPriceFromBinance()` — same
   `/fapi/v1/klines` pattern already used for monthly bars / poly outcomes.
2. Fallback block in `main()` after the CDP attempt: null price/weekly bars
   are filled from Binance REST. CDP remains primary (host runs keep VWAP/VRVP;
   those stay null in Docker and degrade gracefully — already handled).
3. `buildScenarios()` returns `null` when price/LW data missing → formatter +
   summary render explicit "⚠️ Unavailable" instead of `$0`.
4. LW levels excluded from S/R lists when null; `MH $0` target case guarded.
5. `--dry-run` flag: renders full report, skips Discord post.

## Verification
`docker compose exec -T ace-cron node /app/scripts/weekly-war-report.js --dry-run`
→ CDP fails as expected, Binance fallback fills everything, report fully
populated, S/R classified correctly, no `$0`/`—`, post skipped.

## Side effect worth knowing
Weekly-structure factor is back in the bias score (was silently dropped with
the null data). 2026-07-05 report said "BULLISH +2/4" on incomplete data;
with structure restored the same week would have read lower. Bias scores
2026-06-21 → 2026-07-05 are not comparable to scores after this fix.

## Residual risk
- VWAP/VRVP factors and VRVP-based levels only appear when run from host
  (manual `make war-report`). Acceptable: report is Docker-cron owned.
- If Binance REST is also down, report now says so explicitly instead of $0.
