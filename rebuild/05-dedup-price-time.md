# 05 — Dedup by price-time cell

**Type:** measurement + risk · **Depends on:** 03 (measure its effect on an honest ledger) ·
**Audit refs:** D8 (48 refires), D11, prior-audit D7 (768→317 distinct setups)
**Files:** [scripts/trigger-check.js](../scripts/trigger-check.js) cooldown path,
`.trigger-state.json`

## The defect

Cooldowns key on **VRVP level identity**. Levels re-mint as the TradingView viewport drifts
(and will re-mint differently under exchange-native zones), so the "same" trade idea refires:
48 near-identical longs on 2026-07-26 alone; across history, 801 nominal signals collapse to
~317 distinct setups. Consequences: correlated risk stacking (D8) and a sample that overstates
evidence ~2× (D11, ρ=0.349).

## Required behavior

Replace level-identity cooldown keys with **price-time-direction cells**:

- Cell key = `(direction, floor(zonePrice / (price × 0.003)))` — i.e. 0.3%-wide price bands —
  with a **24h** expiry per cell.
- A signal only fires if its cell has no fire within the window. Store fired cells in
  `.trigger-state.json` with timestamps; prune expired on each cycle.
- Band width 0.3% and window 24h are the audit's stated starting cell (§8b). They are
  containment parameters, not tuned edge parameters — record them as constants with a comment
  that re-tuning awaits spec 07's sample bar (≥150 post-fix signals, ≥2 regimes).
- Keep the existing session/zone cooldown machinery only where it doesn't duplicate this;
  simplify rather than layering two systems (present the simplification to the operator first).

## Acceptance checks

1. **Incident replay:** replay the real burst through the cell logic.
   **CORRECTED 2026-07-26 (evidence over spec):** this spec originally stated "1 fire + 47
   suppressed where production fired 48", assuming a single-day burst. The ledger shows
   otherwise — **40 long signals (34 placed, 6 skipped) spanning 47.7 hours**. With a 24h cell
   the correct expectation is **one fire per 24h cell period**: the replay yields **2 fires,
   24.5h apart**, the second only after the first cell legitimately expired, plus 38 suppressed
   (95%). Demanding 1 would demand a cell that never re-arms — not the design. The enforced
   invariants are now: (a) consecutive fires ≥24h apart (every fire after the first is a
   post-expiry re-arm, never a refire), (b) fires ≤ ceil(span/24h), (c) suppression ≥90%.
   The audit's "48 signals" was itself approximate; 40/34 is the ledger-verified count.
2. **History replay (measurement, not gate):** count distinct cells over the full signal
   history; expect the same order of magnitude as the audit's ~317 distinct setups. Report it.
3. Unit tests: same cell within 24h ⇒ suppressed; adjacent band ⇒ fires; same band opposite
   direction ⇒ fires; cell expiry ⇒ fires again.
4. State survives restart (write/reload `.trigger-state.json` round-trip test).

## Expected metric effect

Signal count drops sharply (~60%). Forward samples approach independence — lag-1 ρ measured on
post-fix signals should fall well below 0.349; report the new ρ after 30+ post-fix signals.

## Definition of Done

- [ ] Cell dedup live; legacy level-identity keys removed or subordinated
- [ ] Incident replay produces 1 fire; unit tests pass
- [ ] Refactors note with replay evidence committed
