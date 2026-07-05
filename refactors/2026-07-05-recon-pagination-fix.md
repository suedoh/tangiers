# Recon: paginated exchange reads + positive-confirmation cancels + E11000 self-heal

**Date:** 2026-07-05
**Files:** `scripts/lib/blofin.js`, `scripts/lib/blofin-store.js`, `scripts/blofin/recon-once.js`
**Trigger:** 2026-07-04 end-to-end audit — recon stuck in a duplicate-key error loop every 3 min, 4 live TP rungs falsely `cancelled` in Mongo

## The defect chain (all three links needed for the incident)

1. **Unpaginated pending reads.** `getActiveOrders` / `getPendingTPSL` took ONE
   page of `orders-pending` (default 20). With 11 stacked long ladders
   (~29 live orders) the read silently truncated; resting rungs fell off the
   page. Log evidence: passes with `disappeared: 4` and `disappeared: 6` while
   nothing was actually cancelled.
2. **Single-miss cancellation.** One truncated read → `disappeared`, and
   `resolveDisappeared` in the SAME pass finds no fills (resting rungs have
   none) → `cancelled`. Four live rungs falsely cancelled on 2026-07-04
   (04:42, 13:33×3). Binance-style ground truth check on `1000131593849`:
   it actually FILLED overnight at 63174.
3. **No self-heal.** When TP fills shrank the book and the falsely-cancelled
   orders re-entered the page, the retroactive path `insertOne`d them into
   the unique `(orderId, env)` index → E11000 every 3 minutes forever, with
   an identical red Discord post per pass (no cooldown) burying real alerts.

## Fixes

- **`blofin.js`** — both pending reads now cursor-paginate (`limit=100`,
  `after=last id`, dedupe, no-progress bail, 10-page cap). Probed live:
  forced `pageSize=5`/`pageSize=3` walks return sets identical to the
  single-page read (limit + after honored by the API).
- **`blofin-store.js` reconcileOnce** — retroactive path checks for an
  existing doc first: exists non-live + exchange shows resting →
  **resurrect** to `live` (report bucket `resurrected`), never `insertOne`
  into the index. Matched orders reset `reconMisses: 0`.
- **`blofin-store.js` resolveDisappeared** — no-fills branch now requires
  positive confirmation from `orders-history` before cancelling: history
  says filled → `filled` (aggregate price/size recovered); history says
  cancelled → `cancelled`; **not in history → still resting → resurrect**
  (`reconMisses` capped at 3 attempts so a truly-gone order can't
  ping-pong). `sl_conditional` keeps the old rule — TPSL ids never appear
  in orders-history and a triggered SL legitimately vanishes.
- **`recon-once.js`** — timestamped pass headers (the 07-04 forensics had
  no timestamps), `resurrected` printed + posted, and error-only repeat
  posts cooled to one per 30 min by error signature (fails open; any other
  material activity always posts).

## Heal result (verified live)

All four corrupted docs settled by the fixed pipeline itself:
`1000131593395` + `1000131593851` → resurrected `live` (still resting on
exchange); `1000131593849` → `filled` @ 63174 × 7.5; `1000131599430` →
`filled` @ 62940 × 9.4 — two real fills recovered for Phase D attribution
that a false `cancelled` would have hidden. End state consistent: 22 live
docs = 11 pending + 11 TPSL on exchange, 0 disappeared, 0 errors across
cron + manual passes.

## Notes

- The two entry drops on 07-04 (`blofin api error 1`) remain an open
  question (API flake vs margin exhaustion at 188.7-contract net stack) —
  not addressed here.
- TP-rung docs lack a `kind` field (observed in Mongo) — cosmetic for this
  fix (the sl_conditional guard matches on `kind === 'sl_conditional'`,
  which TPSL docs do carry), worth a look at attribution-join time.
