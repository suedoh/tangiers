# BloFin Phase B.2 — Order placement primitives

**Date:** 2026-06-15
**Phase:** B.2 of [BloFin roadmap](2026-06-15-blofin-roadmap.md)
**Status:** ✅ Closed — `make blofin-setup` + `make blofin-probe` both exit 0.

## What shipped

| File | Purpose |
|---|---|
| [scripts/lib/blofin.js](../scripts/lib/blofin.js) | + `setPositionMode`, `setLeverage`, `placeOrder`, `cancelOrder`, `getActiveOrders` |
| [scripts/blofin/setup-account.js](../scripts/blofin/setup-account.js) | One-time: `net` mode + `10× isolated` leverage on BTC-USDT |
| [scripts/blofin/order-probe.js](../scripts/blofin/order-probe.js) | Self-cleaning smoke test: limit far below market → verify → cancel → verify clean |
| `Makefile` | `make blofin-setup`, `make blofin-probe` |

## Account state after setup

- Futures position mode: **net** (one-way) — Tangiers never opens opposing positions
- BTC-USDT leverage: **10× isolated** — bounded per-trade loss
- 1500 USDT available, 0 positions, 0 active orders

## BloFin docs-vs-truth (continued — fourth and fifth gotchas)

The pattern from Phase A continued: BloFin's docs list paths under `/api/v1/trade/...` for several endpoints that actually live at `/api/v1/account/...`.

| Operation | Docs path | Real path |
|---|---|---|
| Set position mode | `/api/v1/trade/position-mode` | `/api/v1/account/set-position-mode` |
| Set leverage | `/api/v1/trade/leverage` | `/api/v1/account/set-leverage` |

`/api/v1/account/position-mode` exists too but is **GET-only** (returns 405 on POST) — it reads the current mode.

## `positionMode` value translation

User-facing API takes friendly values; BloFin's enum is verbose.

| Caller passes | BloFin wants |
|---|---|
| `'net'` | `'net_mode'` |
| `'hedge'` | `'long_short_mode'` |

Map lives in [lib/blofin.js#setPositionMode](../scripts/lib/blofin.js). Don't expose the BloFin strings to callers.

## Active-orders endpoint

The docs say `/api/v1/trade/active-orders`; the live path is `/api/v1/trade/orders-pending` (same family as OKX). Verified working in `order-probe.js`.

## Order-probe design

Limit-far-below-market rather than a market round-trip:
- Market entry would fill immediately, leaving a position to flatten
- Limit at 95% of mark won't fill in the probe window
- Lets us exercise `place` + `cancel` cleanly without ever entering a position
- Mark price sourced from Binance (already a Tangiers dep) — BloFin's public API doesn't expose a cheap live-price endpoint we need to integrate yet

## Exit criteria met

`make blofin-setup` succeeds: position mode + leverage configured.
`make blofin-probe` exits 0: place → read → cancel → verify-clean cycle works end-to-end.

## Next — Phase B.3

State model and persistence for orders/positions. MongoDB schema:
- `blofin_orders` collection: orderId, clientOrdId, signalId (links to `trades`), state machine
- `blofin_positions` collection: instId, side, size, entry price, current state
- Reconciliation loop polls `getActiveOrders` + `getPositions` and reconciles to local state

This consumes the deferred MongoDB Phase 3 work.
