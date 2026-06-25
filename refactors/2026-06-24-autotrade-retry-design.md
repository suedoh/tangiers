# Autotrade idempotent retry — design (probe-first)

**Date:** 2026-06-24
**Status:** DONE — implemented, smoke-tested on demo, shipped.
**Problem source:** autotrade timeout audit (this session)
**Companion (shipped):** [2026-06-24-autotrade-drop-tagging.md](2026-06-24-autotrade-drop-tagging.md)

## Implementation (shipped)

| File | Change |
|---|---|
| [blofin-autotrade.js](../scripts/lib/blofin-autotrade.js) | `clientOrderIdFor`, `resolveEntry`, `placeEntryResilient` (place→resolve→adopt-or-retry, max 2); entry call site returns `{ dropped }` on exhaustion |
| [blofin-store.js](../scripts/lib/blofin-store.js) | `persistAdoptedEntry` — upsert a resolved/adopted entry with our signalId |
| [trigger-check.js](../scripts/trigger-check.js) | callback handles `r.dropped` → `markExecution('dropped')` + `postAutotradeDeadLetter` (red #blofin-recon alert); no auto re-arm |
| [autotrade-probe.js](../scripts/blofin/autotrade-probe.js) | fixed stale 4→5 order count (B.6 added the standalone SL) + TPSL cleanup |

## Verification (2026-06-24, demo)

- **New paths direct test:** `clientOrderIdFor` transform ✓; `resolveEntry` finds a placed order by clientOrderId (state=live) ✓; `persistAdoptedEntry` upserts a tracked doc with signalId+adopted ✓; cleanup clean ✓.
- **Full `autotrade-probe` (BLOFIN_AUTOTRADE=true):** synthetic A-long → 5 orders placed (entry via `placeEntryResilient` + SL + 3 TPs) ✓; 5 Mongo docs linked ✓; idempotent re-fire skipped ✓; reconcileOnce ✓; cleanup completed (flatten ran, no error).

## Live outage observed mid-test (refines the design)

Right after the probe passed, BloFin's **private/signed** API went into a ~minutes-long timeout cluster (public market endpoint stayed 200). This is the exact failure mode, live: stalls come in **bursts**, not single blips. Implication:
- The 2-attempt retry (~seconds) recovers an **isolated** stall — which is what the 2 Phase-D drops were.
- A **sustained** outage still dead-letters after 2 attempts — and that is correct: don't hammer a down exchange; surface a loud #blofin-recon alert + tag `dropped` so the user enters manually. The recon protection-invariant remains the backstop for any position opened during the window.

## Possible refinement (not shipped)

`resolveEntry` uses the default 10s per-call timeout; during a sustained outage a dead-letter can take ~2 min (2 attempts × stacked timeouts). Bounded and fire-and-forget (doesn't block the main loop; next cron is 10 min out), but a shorter per-call timeout for resolve/retry would make dead-letters snappier. Low priority.

## Probe results (2026-06-24, `scripts/blofin/clientordid-probe.js`)

| # | Question | Result |
|---|---|---|
| BUG | Does the entry send a usable client id? | **No — wrong field name.** BloFin's field is `clientOrderId`, not the docs' `clientOrdId`. The old wrapper sent `clientOrdId` → silently ignored, order came back `clientOrderId: ""`. **Fixed** in blofin.js. |
| P1 | Accept + echo a signalId-derived id? | ✓ 21-char alphanumeric (`1782387640158VAH65080`) accepted and echoed |
| P2 | Resolve a resting order by clientOrderId? | ✓ via `getActiveOrders` (orders-pending) |
| P3 | Resolve a FILLED entry by clientOrderId? | ✓ via new `getOrderHistory` (orders-history) — records carry `clientOrderId` + `state` + `filledSize` + `averagePrice`. (fills-history does NOT carry it — dead end.) |
| P4 | Is 10s the right timeout? | Latency 181–395ms (median 194, p90 219). 10s timeouts are rare HARD STALLS, not latency. Don't lower the timeout; retry instead. |
| DEDUP | Does BloFin reject a duplicate clientOrderId? | ✓ **YES** — second place with same id → "All operations failed". So reusing the id across retries makes a double-position physically impossible at the exchange. |

**Finalized decisions:** retry count = **2**. Limbo handling = **adopt-and-protect** (if the entry is found on the exchange in any non-cancelled/non-rejected state, persist it and continue to SL placement — never cancel-and-retry a live order). Dropped bar = **no auto re-arm** (dead-letter + loud #blofin-recon alert so the user can manually enter; don't auto-enter a stale signal into a moved market).

## The defect being fixed

A single 10s BloFin API timeout on the market entry permanently drops a
fully-qualified signal. Phase-D evidence: 2 of 9 attempts (22%), and the drops
were biased toward the highest-value signals (only A-tier + a +2R winner). The
entry order carries no `clientOrdId`, and `placeAndPersist` throws before the
Mongo insert, so after a timeout there is **no idempotency key anywhere** — a
naive retry could open a SECOND position. That is why this needs design, not a
retry loop.

## Three sub-defects (from the audit)

| | Defect | File |
|---|---|---|
| D1 | No retry / no dead-letter on transient autotrade failure | [trigger-check.js autotrade callback](../scripts/trigger-check.js) |
| D2 | Retroactive-recovery pass only scans `getActiveOrders` — blind to filled MARKET entries | [blofin-store.js:230](../scripts/lib/blofin-store.js#L230) |
| D3 | Entry sends no `clientOrdId` → ambiguous write has no idempotency key | [blofin-autotrade.js:151](../scripts/lib/blofin-autotrade.js#L151) |

## Design

### 1. Deterministic clientOrdId (fixes D3)

Derive a stable, exchange-legal id from signalId so an order can be looked up
after an ambiguous write.

- signalId today: `1782137423928-VAH-65080` (epoch-zone-mid)
- BloFin `clientOrdId` charset/length limits are **unknown — PROBE FIRST**
  (CLAUDE.md: "docs are wrong — probe first"). Likely alphanumeric, ≤32 chars.
- Candidate transform: strip non-alphanumerics → `1782137423928VAH65080`
  (21 chars). Verify length + charset + that BloFin echoes it back and that it
  is queryable.

### 2. Reconcile-before-retry (fixes D1 safely)

On entry timeout/error, do NOT blindly retry. First resolve the ambiguous write:

```
place entry (market, with clientOrdId)
  └─ on timeout/error:
       query exchange for clientOrdId  (open orders + positions + fills)
         ├─ FOUND  → adopt it: persist locally, CONTINUE to SL placement
         │           (a filled-but-untracked entry is a naked position —
         │            the SL step is the whole point of not dropping here)
         └─ NOT FOUND → bounded retry (max 1–2), same clientOrdId
              └─ still failing → DEAD-LETTER:
                   • markExecution(signalId, 'dropped', reason)
                   • loud Discord alert to #blofin-recon (a drop must be VISIBLE)
```

The forcing function: a drop is never silent again, and an ambiguous write is
always resolved against exchange truth before any second order.

### 3. Position-aware reconciliation (fixes D2)

Extend `reconcileOnce` to reconcile open **positions** against tracked signals,
not just resting orders. A market entry that places-on-timeout fills instantly
and never appears in `getActiveOrders`; only a position check catches it. Today
`findUnprotectedPositions` would alert but not attribute it to a signal.

## Probes required before implementation (all low-risk)

| # | Probe | Risk | Answers |
|---|---|---|---|
| P1 | Place a tiny limit order **far from market** with a known `clientOrdId`, then GET it back by clientOrdId, then cancel | Self-cancelling, never fills | Does BloFin accept + echo + allow lookup by clientOrdId? Charset/length limits? |
| P2 | Same order: confirm it appears in `getActiveOrders` filtered by clientOrdId | none beyond P1 | Is clientOrdId queryable on the open-orders endpoint? |
| P3 | Inspect a filled order in `fills-history` — does it carry clientOrdId? | read-only | Can we resolve a filled-on-timeout entry by clientOrdId post-fill? |
| P4 | Log actual request latency distribution over ~50 signed calls | read-only | Is 10s right? Is 22% a real rate or demo-venue noise (OQ2)? |

P1–P3 mirror the existing `scripts/blofin/order-probe.js` pattern (place far,
verify, cancel). P4 is pure instrumentation.

## Phase D considerations

- This is money-path surgery during a live forward test. A botched retry could
  create the naked-position risk that currently does NOT exist (both historical
  timeouts left zero exchange trace). Correctness > speed.
- Acceptable under Phase D discipline: the roadmap explicitly lists "network
  drops, mid-trade crashes — every failure mode documented and patched" as a
  Phase D deliverable. This IS that work.
- Ship behind the existing `BLOFIN_AUTOTRADE` gate; the retry path is reversible.

## Open decision for the user

- Retry count: 1 or 2 attempts before dead-letter?
- On "FOUND but unfilled limbo" (rare): adopt-and-protect vs cancel-and-dead-letter?
- Should a `dropped` dead-letter also re-arm the level so a later proximity
  trigger can re-enter, or stay dropped for that bar?
