# 2026-07-12 — Exchange-native migration: P0–P2 shipped

Plan: [2026-07-12-btc-exchange-native-migration-plan.md](2026-07-12-btc-exchange-native-migration-plan.md).
All three phases landed same-day; P3 gate evaluates after ≥14 days of parity data.

## What shipped

- **P0** `scripts/lib/market-data.js` — klines fetch/cache, volume profile
  (VRVP_EXPR-compatible), CVD, session VP, VWAP. 15 known-answer tests (TDD).
- **P1** `scripts/audit/calibrate-zone-window.js` — measures the live chart,
  scores candidate windows, freezes `config/btc-zones.json`.
  **Frozen: 14d × 5m klines × rowSize 34.7 → worst Δ 0.190% of price.**
- **P2** `zoneParitySidecar()` in trigger-check.js — shadow-computes zones each
  cycle through the SAME computeVRVPLevels/checkVRVPProximity, appends
  `logs/zone-parity.jsonl`. Fail-safe, after all signal work, `ZONE_PARITY=false`
  kills it. Gate: `scripts/audit/zone-parity-report.js` (6 tests).

## Calibration falsified two assumptions (why P1 exists)

1. **hlc3 point-bucketing** — POC off 1.9% even on the exact visible window.
   TV spreads each bar's volume across its H–L span. Fixed in market-data.js
   (spread ∝ row overlap); after fix, 60-TF chart reproduced to 0.003%.
2. **Calibrating the 60-TF chart state** — trigger-check switches to TF 30
   for its canonical read; visible range differs per TF. Recalibrated in the
   production read state (script now switches to 30M itself, restores after).

## ⚠️ Defect discovered in the EXISTING pipeline: stale VRVP rows

TV exposes two POCs that disagreed by 4% at calibration time:
- `_data` store (developing lines): POC 62669 — consistent with the visible
  ~14.3d of bars and with VAH/VAL (64490/60222).
- Histogram rows (`histBars2` primitives): max-row POC 60101 — matches a ~21d
  window (confirmed by 30m-bar smear test). **The rows lag the visible range.**

`computeVRVPLevels` takes POC **and all HVN/LVN zones from the rows** ("more
precise than _data store" — assumption now falsified) while VAH/VAL come from
the fresh store. So today's production zones are mixed-freshness; POC/HVN
triggers can fire on days-old volume structure. The sidecar logs both variants
(`tv.poc` = stale max-row the brain uses, `tv.pocFresh` = data store);
zone-parity-report gates on the brain's value and reports `pocFresh`
informationally — 14 days of data will quantify how often staleness bites.
Exchange-native computation eliminates the class entirely (no render layer).

## First live cycle (verification)

```
mkt POC 62790 vs tv pocFresh 62669 (0.19%) · VAH Δ0.027% · VAL Δ0.027%
tv poc (stale rows) 60101 → Δ2689 pts — staleness now measured per cycle
OI 100970 vs 100973 · signal path unchanged ("No trigger", Stage 1 complete)
```

## Next

- **P3** after 2026-07-26: `node scripts/audit/zone-parity-report.js`
  (exit 0 = PASS). Recalibrate + restart clock if the chart zoom changes
  materially.
- **P4** cutover only on PASS: flag + win-rate-diff baseline snapshot first.
