# BloFin Phase B.6 — Standalone SL + protection invariant

**Date:** 2026-06-19
**Phase:** B.6 of [BloFin roadmap](2026-06-15-blofin-roadmap.md)
**Status:** ✅ Closed — `make blofin-sl-probe` passes all 6 assertions; recon clean.

## What this fixes

The Phase B.4 autotrade design attached `stopLossTriggerPrice` directly to entry orders. **In BloFin's net mode, that attached SL is size-bound and gets cancelled when**:
- A subsequent entry fires for the same instrument (new attached SL replaces it)
- A reduce-only TP rung fills and shrinks the position (conditional becomes invalid)

After several signal cycles, the position is held with **no active SL** while the user (and the system) assume protection. Discovered live on 2026-06-19 — open SHORT 59.9 contracts with `TP/SL: --/--` in the BloFin UI.

## Architectural fix

Three changes:

### 1. Use standalone TPSL conditional orders, not attached

`scripts/lib/blofin.js` gains three new methods:

| Method | Endpoint | Purpose |
|---|---|---|
| `placeTPSL(...)` | `POST /api/v1/trade/order-tpsl` | Place standalone SL/TP conditional |
| `getPendingTPSL(...)` | `GET /api/v1/trade/orders-tpsl-pending` | Read pending list |
| `cancelTPSL(...)` | `POST /api/v1/trade/cancel-tpsl` | Cancel one or more |

Standalone TPSL orders **survive partial position closes** and **multiple SLs can coexist on the same instrument** (confirmed via probe). They're independent of any entry-order lifecycle.

### 2. Post-condition verification + auto-flatten

`scripts/lib/blofin-autotrade.js` no longer puts `stopLossTriggerPrice` on the entry. Instead, after the entry fills:

```
1. Place standalone SL via placeTPSL (mark-price trigger)
2. Read getPendingTPSL — confirm the tpslId we just placed is present
   with the expected slTriggerPrice (tolerance: 0.5)
3. IF verification fails →
     a. Immediately market-close the entry (reduceOnly = true)
     b. Return { aborted: 'SL verification failed — entry flattened' }
4. IF verification succeeds → persist tpslId in Mongo (kind='sl_conditional')
   and continue with TP rungs
```

The forcing function: an unverified SL leads to **immediate position flatten**, not a hopeful continuation. Better a known small loss than an unbounded one.

### 3. Recon-level protection invariant

`scripts/lib/blofin-store.js` adds `findUnprotectedPositions()` — for every open exchange position, checks that at least one `slTriggerPrice > 0` exists in `getPendingTPSL`. If not, the position is unprotected.

`reconcileOnce()` now runs this check every cycle. If any positions are unprotected, the Discord summary upgrades from `info` to `error` (red embed) and starts with:

```
🚨 UNPROTECTED POSITIONS — NO ACTIVE SL 🚨
• BTC-USDT SHORT size=59.9 avgPx=65858.7
Action: flip BLOFIN_AUTOTRADE=false and set SL via UI immediately.
```

This is the operational safety net that catches drift between autotrade's verification and reality — useful if the user opens a position via UI, or if a future code path bypasses placeTPSL.

## What stays the same

- TP rungs (3 reduce-only limits at 1/3 size each) — already correct in B.4, no change needed
- Idempotency by signalId — unchanged
- Daily-R kill switch — unchanged
- Fills-history resolution (B.5) — unchanged

## Smoke test (`make blofin-sl-probe`)

6 assertions, all green:

```
[1/6] placeTPSL (standalone)…                         ✓ tpslId 10002057234
[2/6] getPendingTPSL verification…                    ✓ trigger=69243.2 type=mark
[3/6] persistTPSL → Mongo…                            ✓ kind=sl_conditional state=live
[4/6] findUnprotectedPositions (expect empty)…        ✓ all positions covered
[5/6] cancelTPSL (array body)…                        ✓ code=0
[6/6] verify removed from pending…                    ✓ gone
```

The probe places a temporary SL with a trigger 10% above mark (won't fire) on top of the user's existing live position + existing manual SL. Confirms multiple SLs coexist, persistence works, cancel array works, protection invariant correctly returns empty when ANY SL covers a position.

## API discoveries (BloFin docs-vs-truth catalog #5-7)

1. `placeTPSL` endpoint is `/api/v1/trade/order-tpsl` — confirmed
2. Field name is `slTriggerPrice` (not `stopLossTriggerPrice` — that's the attached-field vocab from `/order`)
3. `cancelTPSL` body is an **array** `[{instId, tpslId}]` — single-object body returns 152004 "JSON syntax error"

## What's deferred

- **Cancelling stale SLs as position closes.** When a TP rung fills and reduces the position, we should consider whether the SL's `size` field should be updated. Current behavior: the SL stays at its original size with `reduceOnly: true`, which means it only closes whatever's left. No bug, but not optimal.
- **Multiple-entry aggregation.** If two signals fire back-to-back, each places its own SL. Both stay live and either can fire first. This is acceptable but worth monitoring — a tighter post-aggregation SL would lock in profit better.

## Rollout

No user action needed. Changes take effect on the next signal that fires through `autotrade.autotrade()`. The recon loop will run the protection invariant check every 3 minutes starting from the next cycle.

The user's existing manual SL at $65,827 (placed earlier today) remains in effect for the current 59.9-contract SHORT. The new autotrade flow only governs FUTURE signals.
