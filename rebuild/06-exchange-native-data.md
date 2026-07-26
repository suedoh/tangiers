# 06 — Exchange-native data cutover

**Type:** data integrity · **Depends on:** none (parallel-safe; complete before 07 starts) ·
**Audit refs:** D10, R-register data items · **Plan:** the committed migration plan
(`refactors/` 2026-07-12, commit 5a73783) — this spec inherits it and adds audit-driven gates.
**Files:** [scripts/lib/market-data.js](../scripts/lib/market-data.js) (P0, committed 7706b31),
zone calibration (P1, 9254ed8), parity sidecar (P2, 7d12e84), [scripts/trigger-check.js](../scripts/trigger-check.js)

## Why this is mandatory, not optional

The TradingView CDP path is **blind 14.9% of cycles** (VRVP hidden/stale rows — discovered in
P2, commit 7d12e84) and only **34% decision-stable** against the same indicators computed from
exchange data (D10). No signal research (spec 07) is meaningful on an input that disagrees with
itself: any measured edge could be an artifact of *which feed* was up.

## Work remaining (P3+ of the migration plan)

1. **Investigate the stale-VRVP-rows discovery first** (P2 finding): quantify how many
   historical signals fired on stale zone rows; report the count. This bounds how much of
   history is even interpretable.
2. **Cutover:** `trigger-check.js` reads zones + VWAP/CVD/OI from `lib/market-data.js`
   (Binance-computed) instead of CDP. The frozen zone-window calibration (P1: 30d/5m replicates
   live VRVP to 0.003%) is the zone definition — **calibrate-then-freeze**, per the plan; no
   recalibration without operator sign-off.
3. **Parity gate:** run the P2 sidecar for **14 consecutive days** post-cutover comparing
   exchange-native zones/decisions vs the TV feed. Gate: decision agreement on live cycles
   ≥ the plan's threshold, and **0 blind cycles** on the native path. Restart the 14-day clock
   on any cutover code change (the plan's own rule).
4. **Remove CDP from the BTC signal path** once the gate passes. BZ!/Poly/EW keep CDP —
   BTC scope only. After removal, BTC trigger-check can move into `ace-cron` (it no longer
   needs the host); do that as a separate commit with its own smoke test.
5. **TradingView remains** for the human's charts and manual analysis — nothing in this spec
   touches the `🕵Ace` layout requirements for other instruments.

## Acceptance checks

1. Stale-row impact count reported (item 1) before cutover.
2. 14-day parity log green per the plan's threshold; blind-cycle count on native path = 0.
3. Side-by-side spot check: 10 random cycles, native vs TV zone sets and fire/no-fire
   decisions, table in the refactors note.
4. Signal path runs with TradingView Desktop **closed** (the definitive no-CDP proof).

## Definition of Done

- [ ] Stale-row impact quantified and reported
- [ ] Cutover live; 14-day parity gate passed; clock restarts honored
- [ ] BTC signal path proven CDP-free; container migration done (or explicitly deferred)
- [ ] Refactors note committed
