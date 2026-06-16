# BloFin Phase B.5 — Fills resolution + kill switch + recon cron

**Date:** 2026-06-16
**Phase:** B.5 of [BloFin roadmap](2026-06-15-blofin-roadmap.md)
**Status:** ✅ Closed — `make blofin-resolve-probe` passes all 5 assertions; recon cron installed.

## Three pieces shipped

### 1. Fills-history resolution

The `disappeared` state from B.3 was a placeholder. B.5 resolves it.

- New API method [`blofin.getTradeHistory(...)`](../scripts/lib/blofin.js) — wraps `GET /api/v1/trade/fills-history`
- New store method [`resolveDisappeared({instId})`](../scripts/lib/blofin-store.js) — walks orders in `disappeared`, queries fills for each:
  - **Fills exist** → state=`filled`, records weighted avg `fillPrice`, total `fillSize`, `filledAt`
  - **No fills** → state=`cancelled` (externally cancelled or expired)
- `reconcileOnce()` now calls `resolveDisappeared` automatically at the end

After Phase B.5 the lifecycle is fully resolved on every recon pass:
```
live  ─→  (exchange forgets it)  ─→  disappeared  ─→  filled / cancelled
```

### 2. Defense-in-depth daily-R kill switch

Extracted [`scripts/lib/daily-r.js`](../scripts/lib/daily-r.js): `todayUtcR()`, `DAILY_R_KILL_FLOOR=-3.0`, `isKillActive()`. Two callers:

- **`trigger-check.js`** (existing) — now imports from lib instead of inlining the function (no behavior change)
- **`blofin-autotrade.js`** (new) — gates on kill at order-placement time

Why both: the trigger-check gate suppresses signals from firing. The autotrade gate is defense in depth — even if a signal source bypasses the trigger gate (manual call, future signal sources), the autotrade module refuses to open new positions during a drawdown day.

### 3. Continuous reconciliation cron

`make cron` now installs:

```
*/3 * * * *  node scripts/blofin/recon-once.js  >>  logs/blofin-recon.log
```

Every 3 minutes: heals state drift, resolves `disappeared`→`filled`/`cancelled`, picks up retroactive orders (UI-placed or race-failed locally). Logs append-only for forensics.

## What stays out of scope (intentionally)

- **Closing existing positions on kill switch trip.** The kill gates NEW positions only. Open positions continue managing themselves via their attached SL — risk is already capped. Force-flattening during a drawdown is a much bigger decision and outside Phase B-D scope.
- **Webhook-driven fill notifications.** BloFin offers a private WebSocket; we poll instead. Simpler and good enough for 3-minute granularity.
- **Position-side reconciliation collection.** We trust BloFin's `getPositions()` as the source of truth; no local positions collection. Add later only if we discover a need.

## Smoke test results

```
[1/5] placeAndPersist (market buy)…       ✓ orderId  · live
[2/5] pre-recon Mongo state…              ✓ live
[3/5] reconcileOnce…                      ✓ matched=0 disappeared=1 resolvedFilled=5
[4/5] post-recon Mongo state…             ✓ state=filled fillPrice=66428.8 fillSize=0.1
[5/5] second reconcileOnce…               ✓ clean
```

`resolvedFilled=5` because earlier B.4 probe runs left orders in `disappeared` that hadn't been resolved yet — the new resolution loop swept them up at the same time. Self-healing.

## Phase B complete

| Phase | Status |
|---|---|
| B.1 — Demo funded | ✅ |
| B.2 — Order primitives validated | ✅ |
| B.3 — Persistence + reconciliation | ✅ |
| B.4 — Signal-to-orders pipeline | ✅ |
| **B.5 — Fills resolution + kill switch + cron** | ✅ |

The system can now (a) place orders from real signals, (b) persist them durably, (c) reconcile against exchange truth every 3 minutes, (d) resolve fills automatically, (e) refuse new orders during a drawdown day. All of this on demo, all gated OFF by default.

## Next — Phase C/D (the long waits)

- **Phase C** (signal hardening, parallel work): per-direction tier recalibration using n=629 cohort. Already scoped in the roadmap.
- **Phase D**: 4–8 week forward-test on demo with `BLOFIN_AUTOTRADE=true`. Compare paper P&L to `trades.json` expectancy. Fee + slippage attribution. Operational drills.

Phase D is the long wait. You can run it autonomously — the cron and reconciliation handle everything; you just check `#blofin-recon` (and the recon log) daily.

Before D starts, you'll want to flip `BLOFIN_AUTOTRADE=true` in `.env` and stand back. The next signal that fires will result in a real demo trade.
