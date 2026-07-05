# Autotrade: pre-flight margin check + nested BloFin error surfacing

**Date:** 2026-07-05
**Files:** `scripts/lib/blofin.js`, `scripts/lib/blofin-autotrade.js`, `scripts/trigger-check.js`, `.env.example`
**Trigger:** open question from the 2026-07-04 audit — two entry drops (`blofin api error 1: All operations failed`), API flake vs margin exhaustion

## Diagnosis: margin exhaustion, confirmed

- The rejections were **processed API responses**, not transport errors —
  the exchange answered and refused. Rules out the Cloudflare/IPv6 class.
- Timeline fits margin exactly: 12:10 drop at peak stack (net 188.7
  contracts long, ~$1,179 initial margin frozen of ~$1,611 equity) →
  13:30 entry **succeeds** right after the 13:30-33 TP1 fills freed
  margin → 14:30 drop again as the stack rebuilt.
- Live probe (oversized order, demo): rejection wrapper is identical —
  `error 1: All operations failed` — with the real reason nested in
  `data[].code/msg` (probe drew `[102015: Market order exceeds maximum
  order size limit]`), which `_request` was discarding. The 07-04 nested
  code is unrecoverable (never logged) — that's the diagnosability defect,
  now fixed.
- Cost of the bug: the 12:10 drop (`1783167012632-VAH-62227`) went on to
  close canonical **tp1 +3R** — a real missed winner.

## Fixes

1. **`blofin.js _request`** — non-zero API codes now append nested
   `data[].code/msg` to the thrown error. Every future rejection is
   classifiable from the log line alone.
2. **`blofin-autotrade.js`** — pre-flight margin check between sizing and
   entry placement: reads available USDT, computes initial margin
   (`contracts × 0.001 × entry / LEVERAGE`, 10% headroom for fees/drift).
   Over budget → **trim size to fit** (same entry/stop/TPs — R geometry
   and R-unit attribution unchanged; `rDollar` scaled) with detail
   `(margin-trimmed 50→28.9 contracts …)` on the trade record. Below floor
   (fit < MIN_SIZE or < 20% of intended) → clean
   `skipped: insufficient margin …` instead of a `dropped` bug-bucket
   entry. **Fail-open**: any balance-read error proceeds unchecked — a
   blocked money path is how the Jun-27 outage dropped 11 signals.
3. **`trigger-check.js`** — placed-detail string carries the trim note;
   `BLOFIN_LEVERAGE` documented in `.env.example` (must match the
   exchange's 10× iso setting).

## Verification

- Branch math validated: trim lands within budget ($311-need/$200-avail →
  28.9 contracts at $180), exhausted and dust cases skip with reasons,
  healthy margin unchanged.
- Balance response shape probed live (`currency/available/frozen`).
- Rejection fingerprint probed live on demo with a cannot-fill order.
- Not exercised: a real signal-path placement (the B.4 probe would stack
  onto the live Phase D book in net mode — deliberately avoided).

## Phase D note

Margin-exhaustion drops were previously indistinguishable from execution
bugs in the `dropped` bucket. From now they are `skipped` (policy) or
`placed` with a trim note (partial) — the attribution query's
`executionStatus='placed'` filter keeps working, and the D→E gate stops
counting margin ceilings as execution failures. The deeper policy question
— whether unbounded same-direction stacking is *desirable* at 1%
risk/signal — is a Phase C/E sizing decision, deliberately not changed here.
