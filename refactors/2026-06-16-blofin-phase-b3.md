# BloFin Phase B.3 — Persistence + reconciliation

**Date:** 2026-06-16
**Phase:** B.3 of [BloFin roadmap](2026-06-15-blofin-roadmap.md)
**Status:** ✅ Closed — `make blofin-store-probe` passes all 6 assertions.

## What shipped

| File | Purpose |
|---|---|
| [scripts/lib/blofin-store.js](../scripts/lib/blofin-store.js) | Persistence wrappers (placeAndPersist, cancelAndPersist) + reconcileOnce |
| [scripts/lib/db.js](../scripts/lib/db.js) | + `blofinOrders` accessor |
| [scripts/blofin/store-probe.js](../scripts/blofin/store-probe.js) | 6-step assertion-based smoke test |
| [scripts/blofin/recon-once.js](../scripts/blofin/recon-once.js) | One-shot reconciliation runner |
| `Makefile` | `make blofin-store-probe`, `make blofin-recon-once` |

## Schema — `blofin_orders` collection

```js
{
  orderId, clientOrdId, signalId,           // identity + tangiers link
  instId, side, orderType, size, price,     // order spec
  marginMode, positionSide,
  stopLossTriggerPrice, takeProfitTriggerPrice,
  state: 'live'|'cancelled'|'filled'|'disappeared',
  env: 'demo'|'prod',                       // safety marker — never mix books
  schemaVersion: 1,
  createdAt, updatedAt, lastSyncedAt,
  cancelledAt, filledAt,
  retroactive?: true,                        // set if recon created it post-hoc
}
```

Indexes:
- `(orderId, env)` unique — prevents env-mixing
- `state`, `signalId`, `(instId, state)` — for fast lookups in the trigger path

## State machine (Phase B.3 — intentionally narrow)

```
                ┌─→ cancelled (via cancelAndPersist or recon)
   live ────────┤
                ├─→ filled (B.5 will populate via fills-history)
                └─→ disappeared (recon found exchange forgot it)
```

`filled` and `disappeared` resolution is deferred to B.5 (fills-history
lookup needed). Today: `live` → `cancelled` is fully wired; everything
else lands as `disappeared` and waits for B.5.

## Reconciliation logic

`reconcileOnce({instId})` does a single pass:

1. Read exchange active orders + local 'live' orders
2. Bidirectional diff:
   - **Local live + exchange has it** → bump `lastSyncedAt`
   - **Local live + exchange forgot it** → mark `disappeared`
   - **Exchange has it + local doesn't** → create retroactive local record
     (catches the place-succeeded-but-Mongo-write-failed race; also picks
     up orders placed by other clients like the BloFin web UI)

Returns `{matched, disappeared, retroactive, errors}` summary.

## Smoke-test design (`store-probe.js`)

Six assertions, end-to-end:
1. `placeAndPersist` returns orderId
2. Mongo round-trip: doc exists with `state='live'`, `env='demo'`, signalId set
3. `reconcileOnce` reports 1 matched, 0 disappeared
4. `cancelAndPersist` returns ok
5. Mongo doc transitioned to `state='cancelled'`, `cancelledAt` set
6. `reconcileOnce` on clean state reports 0/0/0 (no-op)

All pass on first run. Sample post-test doc:
```js
{ orderId: '1000130106123', state: 'cancelled', env: 'demo',
  side: 'buy', size: '0.1', signalId: 'probe-1781592798607',
  createdAt: '2026-06-16T06:53:19.252Z',
  cancelledAt: '2026-06-16T06:53:20.117Z' }
```

## What's still in `trades.json` vs Mongo

- `trades.json` — Tangiers signal records (what fired, expected R, outcome). Unchanged.
- `blofin_orders` (new) — exchange-side order lifecycle, linked back to a signal via `signalId`.
- These will join in B.4 when the trigger writes a `signalId` into both.

## Next — Phase B.4

Wire the trigger-check signal pipeline to actually call `placeAndPersist`
when a signal fires. Requires:
- Position-sizing translation: signal $-risk → BloFin contracts
- Attaching SL + TP1 to the entry order via `stopLossTriggerPrice` / `takeProfitTriggerPrice`
- TP2 and TP3 as separate reduce-only limits
- All of this guarded by a config flag so it only fires when `BLOFIN_AUTOTRADE=true`

That's the first phase where signals actually move money on the demo
exchange.
