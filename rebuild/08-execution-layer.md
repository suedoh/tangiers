# 08 — Execution layer changes

**Type:** execution · **Depends on:** 02 (governance) now; **live-firing a signal is gated on
07 + 09** · **Audit refs:** §8b, D3, R14 · **Files:**
[scripts/lib/blofin-autotrade.js](../scripts/lib/blofin-autotrade.js),
[scripts/lib/blofin.js](../scripts/lib/blofin.js), `scripts/blofin/*-probe.js`

The audit's verdict on this layer: mostly sound, keep it. Changes below are cost reduction,
sizing honesty, and one unprobed feature. Everything must follow the probe-first rule.

## 8.1 KEEP as built (measured correct — do not "improve")

| Subsystem | Where | Evidence |
|---|---|---|
| Standalone TPSL SL, mark trigger, verify-or-flatten | blofin-autotrade.js:409–453 | 0 unprotected positions across recon history; survived partial closes (the attached-SL field provably does not — Phase B.6 incident) |
| Fill-fetch by clientOrderId; everything keyed off actual fill | :133–147 | works; fixed the 2026-07-02 fill-repricing class |
| Risk trim on chased fills (size absorbs slippage, stop stays structural) | :361–379 | correct design; keep |
| Idempotency via clientOrderId + Mongo `(orderId, env)` unique index | blofin-store | prevented dupes through outages |
| Degraded-mode spool + recon flush + watchdog | recon-once.js / watchdog.js | born from real incidents; keep |

## 8.2 CHANGE

1. **Sizing: flat risk fraction, no tier multipliers.** Tier ranking flips between accountings
   (audit §5) — tiers are untested until spec 07 re-derives them. Remove `tierMult`; size =
   `equity × RISK_PER_TRADE_PCT / |fill − stop|`.
2. **Equity marked to live balance** (R14): fetch balance at entry time; use it instead of the
   static `ACCOUNT_EQUITY_USD` (keep the env var as a *cap*: size off `min(live, cap)` so a
   demo top-up can't silently double risk).
3. **Entry price basis = confirmation** (spec 03): autotrade fires on confirmed signals at the
   confirming close, not at proximity-fire. The signal the exchange trades and the signal the
   ledger scores must be the same event (D9).
4. **TP structure: single TP or 2-rung ladder, maker exits.** The 3-rung ladder's first rung
   barely clears its own fee (prior-audit A2). Exact rung spacing: **insufficient evidence;
   requires ≥150 post-fix observations across ≥2 regimes** — until then, mirror whatever
   geometry spec 07's passing candidate was validated with, exactly. No improvisation between
   validation and execution.
5. **Fee-in-R printed on every trade record and every Discord trade post** (from spec 03's
   `feeR`) — cost visibility is permanent.

## 8.3 PROBE (never used before — probe before any reliance)

- **`post_only` maker entries** would halve entry cost (6bp→2bp), but post-only has never been
  exercised against BloFin. Write `scripts/blofin/postonly-probe.js` (demo): place far-from-touch
  post-only limit → assert it rests; place a crossing post-only → assert exchange behavior
  (reject vs cancel vs silent taker — the dangerous case); test cancel path. Only after the
  probe documents actual behavior may a maker-entry mode be built (and validated in spec 07's
  cost model — a resting entry also changes fill probability, which changes measured edge:
  treat maker-entry as its own candidate variant, not a free upgrade).
- Any other new endpoint/feature (order amendment, batch orders, etc.): same rule, own probe.

## Acceptance checks

1. All existing probes still pass (`make blofin-probe`, `blofin-autotrade-probe`,
   `blofin-sl-probe`, `blofin-degraded-probe`, plus spec 02's governance probe).
2. Sizing unit test: live balance ≠ env cap ⇒ size uses the min; tierMult absent from the code.
3. Demo end-to-end: one synthetic confirmed signal → entry at confirmation, verified SL,
   TP per validated geometry, fee-in-R on the Discord post, exchange attribution row appears
   (spec 04's job).
4. post_only probe report committed before any maker-entry code exists.

## Definition of Done

- [ ] 8.2 changes live behind existing `BLOFIN_AUTOTRADE` flag; probes green
- [ ] post_only behavior documented from probe (or maker-entry explicitly deferred)
- [ ] End-to-end demo trade demonstrates ledger event = exchange event (same trigger,
      same price basis)
- [ ] Refactors note committed
