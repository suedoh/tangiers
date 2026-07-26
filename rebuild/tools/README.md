# rebuild/tools — the audit's independent verification stack

These are the exact scripts the 2026-07-26 independent audit used to reach its numbers,
copied verbatim from the (ephemeral) audit scratch directory. They are the **reference
implementation for "honest measurement"** in this rebuild: spec 03's ledger rewrite must agree
with `verify.js`; spec 07's falsification harness is ported from `stats.js`; spec 04's
attribution job is promoted from `reconcile.js`.

**All scripts are read-only against the exchange and the repo.** They expect their inputs as
sibling JSON files in the directory they run from — run them from a scratch directory with
copies of the data, never against live state files.

## Pipeline order

```
fetch-klines.js   →  klines-30m.json, klines-1m.json        (Binance public REST; no auth)
cp trades.json .                                             (snapshot the ledger — COPY, never the live file)
verify.js         →  verified.json                          (re-derives every outcome 4 ways)
stats.js          →  stats-rows.json + console battery      (Wilson/Fisher/BH/bootstrap/ACF/Brier/ECE/walk-forward/random-entry MC)
blofin-pull.js    →  blofin-{orders,fills}-history.json,    (READ-ONLY BloFin pull; refuses to run
                     blofin-snapshot.json                     unless BLOFIN_ENV=demo — edit guard consciously for prod reads)
mongosh export    →  mongo-blofin-orders.json               (blofin_orders collection dump for the orderId→signalId join)
reconcile.js      →  reconciled.json + console summary      (per-signal exchange truth vs ledger claims)
```

## What each script established in the audit

| Script | Key outputs |
|---|---|
| `fetch-klines.js` | 5,075×30m + 152,233×1m bars 2026-04-13→07-26, zero gaps — ground truth prices |
| `verify.js` | code-faithful walk reproduces the ledger (proving we understood the code); fill-aware walk shows 502/801 signals never filled → +1,008.5R phantom; design-intent and 1m-ladder accountings side by side |
| `stats.js` | symmetric-skill 47.8% [44.3,51.3]; random-entry MC (actual at 0th pctile); ρ=0.349 → ESS≈374; Brier/ECE fail on tier probabilities; full FDR-corrected factor battery |
| `blofin-pull.js` | 571 orders / 200 fills pulled read-only; fee schedule measured 6bp taker / 2bp maker |
| `reconcile.js` | +$78.41 exchange net since 2026-06-15; executed-track 2.3× overstatement; fee burden per signal |

## Cautions for reuse

- `verify.js` and `stats.js` encode the **old** trades.json schema. After spec 03 lands, port
  rather than run blind — field names change (`fillPrice`, `grossR`, `feeR`, net `pnlR`).
- `reconcile.js` approximates $-risk with the tier table (`TIER_R`) because per-signal risk
  wasn't recorded at audit time. Spec 04's attribution job must use actual
  `riskPerUnit × size` instead.
- `blofin-pull.js` paginates with a 100-page guard; if history exceeds 10,000 orders, raise it.
- Full context and findings: [refactors/btc-audit-2026-07-26-independent.md](../../refactors/btc-audit-2026-07-26-independent.md).
