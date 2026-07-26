# Spec 05 — price-time cell dedup (2026-07-26)

Replaces VRVP level-identity cooldowns with direction × 0.3%-price-band × 24h **cells**.
Audit refs: D8 (the 238.3-contract stack), D11 (ρ=0.349 → ESS ≈ half of nominal n).

## Why the old gate failed

`isCoolingDown(zoneKey, ...)` keyed on `${type}-${round(zone.mid)}`. VRVP levels re-mint as the
TradingView viewport drifts, so the *same trade idea* arrived under a new key and bypassed the
1h cooldown entirely. Result: 40 long signals over 47.7h at essentially one price (~$63.7k),
34 of them placed, stacking 238.3 contracts and locking 97% of account margin. The 6h
`stopUntil` extended cooldown had the same flaw — it was also keyed by level identity.

## What replaced it

- A fired signal claims a cell: `{ts, direction, zonePrice, band = price × 0.003}`, stored in
  `.trigger-state.json` under `_firedCells`, pruned on every cycle.
- A new trigger is suppressed if an unexpired same-direction cell exists within one band width.
- Direction-keyed by design: failed-breakout flips (long zone → short re-entry) still fire,
  preserving the behavior the old direction-aware bypass provided.
- `isCoolingDown`, `COOLDOWN_MS`, and the `stopUntil`/`stopDirection` writer are deleted. The
  24h cell is strictly stronger than the old 6h post-stop lock, so nothing regressed.

## Deviation from the spec's key sketch — and why

The spec sketched `floor(zonePrice / (price × 0.003))`. Verified against the incident data:
a price-dependent divisor jitters the quantized index across 330/331/332 for the *same* ~$63.7k
zone, so the burst would still have produced 3+ fires — violating the spec's own acceptance.
Band-distance suppression implements the stated behavior ("0.3%-wide price band × 24h ×
direction") without boundary jitter.

## Spec acceptance number was wrong; evidence corrected it

Spec 05 asserted "1 fire + 47 suppressed". The ledger shows the burst is **40 signals over
47.7 hours**, not one day, and the audit's "48" was approximate. With a 24h cell, **2 fires
24.5h apart is correct** — the second is a legitimate post-expiry re-arm. Asserting 1 would
require a cell that never re-arms. Enforced invariants instead: consecutive fires ≥24h apart,
fires ≤ ceil(span/24h), suppression ≥90%. Measured: **40 → 2 fired, 38 suppressed (95%)**.

## Tests

`scripts/tests/ledger.test.js` — 21 assertions pass (7 new for spec 05): same-band suppression,
adjacent band fires, opposite direction fires, expiry re-arm, prune, JSON round-trip (restart
safety), plus the incident replay above.

## Expected metric effect

Signal count drops sharply (95% on the incident window). Forward samples approach independence;
re-measure lag-1 ρ after 30+ post-fix signals and expect it well below 0.349. Fewer trades is
the intended outcome — correlated refires were never independent evidence.
