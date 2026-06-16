# BloFin Phase B.4 — Signal-to-orders pipeline

**Date:** 2026-06-16
**Phase:** B.4 of [BloFin roadmap](2026-06-15-blofin-roadmap.md)
**Status:** ✅ Closed — synthetic signal → 4 orders → idempotency → clean exit on demo.

## Architecture

The boundary the user pushed for. Two changes only in `trigger-check.js`:

```js
const autotrade = require('./lib/blofin-autotrade');     // line 31

// ...inside the signal-firing block (~line 2286)
const signalId = logTrade(price, trigger, setup);
// ...
autotrade.autotrade({ signalId, direction, setupType, entry, stop, tp1, tp2, tp3 })
  .then(r => log(r.skipped ? `Autotrade skipped: ${r.skipped}`
                           : `Autotrade placed ${r.orders.length} orders for ${signalId}`))
  .catch(e => log(`Autotrade error: ${e.message}`));
```

Eight lines added. All the actual logic lives in `lib/blofin-autotrade.js`.
The hook is fire-and-forget — errors here MUST NOT block Discord
posting or `trades.json` writes.

## What `autotrade()` does

| Step | Action |
|---|---|
| Gate | `BLOFIN_AUTOTRADE !== 'true'` → skip; not demo env → skip |
| Idempotency | Lookup `blofin_orders.findOne({signalId, env})` — skip if exists |
| Sizing | `equity × riskPct × tierMult / (stopDistance × contractValue)` → contracts, rounded down to `lotSize=0.1` |
| Reject | If `contracts < minSize` or `sizePerTp < minSize` |
| Entry | Market order, full size, with attached `stopLossTriggerPrice` |
| TP1/TP2/TP3 | Three reduce-only LIMIT orders, each at 1/3 size, at the respective TP price |
| Persist | All four orders linked to `signalId` via [scripts/lib/blofin-store.js](../scripts/lib/blofin-store.js) |

Failure semantics: if the entry places but a TP rejects, log the
rejection and proceed with what placed. We DO NOT roll back. A
partially-laddered position is preferable to an orphaned entry-SL
pair. B.5's reconciliation will surface inconsistencies.

## Sizing example (from the probe)

- Equity: $1500 demo balance
- Risk: 1.0% (Tangiers default)
- Tier A multiplier: 1.0 → R$ = $15
- Stop distance: ~315 USD
- Loss per contract: 315 × 0.001 = $0.315
- Contracts: 15 / 0.315 = 47.6 → rounded to 47.5
- Per TP: 47.5 / 3 = 15.83 → rounded to 15.8

Matches expected output from `node scripts/blofin/autotrade-probe.js`.

## Probe behavior (and a footgun)

The synthetic signal in the probe uses `entry = mark × 0.95` so the
market entry fills instantly. **Consequence:** the TPs (computed at
+0.5% / +1.0% / +2.0% from "entry") are all below mark too, so they
also fill instantly as limit sells inside the spread. Round-trip cost
on the test: ~$3.80 in slippage + fees.

This means `reconcileOnce` reports `disappeared=4` rather than
`matched=4` on probe runs — the orders aren't on the book anymore.
That's *correct behavior* but not what you want when you're testing
the "live order resting on the book" path. Phase B.5 (fills-history
lookup) will properly resolve `disappeared → filled` instead of
leaving them in the placeholder state.

## Gating — defaults are OFF

| Env | Default | Behavior |
|---|---|---|
| `BLOFIN_AUTOTRADE` | `false` | Trigger script ignores the hook |
| `BLOFIN_ENV` | `demo` | Hook refuses to fire against prod URL |
| `ACCOUNT_EQUITY_USD` | unset | Sizing returns `error` — hook skips |

So merging this commit doesn't change anything for anyone running
the system today. To exercise it, both `BLOFIN_AUTOTRADE=true` AND
`ACCOUNT_EQUITY_USD=<n>` must be set, AND the env must be demo.

## Exit criteria met

`BLOFIN_AUTOTRADE=true make blofin-autotrade-probe` passes all five
assertions:

1. Sizing produces valid contracts + sizePerTp
2. autotrade() places 4 orders (1 entry + 3 TPs)
3. Mongo has 4 docs linked to signalId
4. Re-firing same signal is a no-op (idempotency)
5. reconcileOnce + cleanup land at zero positions, zero orders

Exchange state after probe: balance reduced by ~$3.80 (slippage+fees);
no leftover positions or orders.

## Next — Phase B.5

Reconciliation refinement: distinguish `filled` vs `cancelled` for
disappeared orders by querying BloFin's fills-history endpoint. This
is what makes the `disappeared` state from B.3 properly resolve.

Plus daily-R kill switch wired to **actual order cancellation** (today
the kill switch just stops emitting signals; with autotrade live, we
need it to cancel the open TP ladder too).
