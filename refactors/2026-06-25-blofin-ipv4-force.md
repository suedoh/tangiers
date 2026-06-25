# BloFin client — force IPv4 (root cause of the autotrade timeouts)

**Date:** 2026-06-25
**Status:** DONE
**File:** [scripts/lib/blofin.js](../scripts/lib/blofin.js) `_request`
**Surfaced by:** the new dead-letter alerts (4 `AUTOTRADE DROPPED` in #blofin-recon on 2026-06-25)

## Symptom

After the resilient-retry fix shipped (2026-06-24), `#blofin-recon` posted 4
`AUTOTRADE DROPPED — entry dropped after 2 attempts: blofin timeout` alerts on
2026-06-25 (13:01, 13:41, 15:50, 19:41 UTC). One signal at 12:10 placed fine.
So autotrade was intermittently timing out on every BloFin call.

## Investigation (what ruled out what)

| Test | Result | Conclusion |
|---|---|---|
| Public market endpoint (curl) | 200 in ~1s | host + BloFin up |
| Private path, no auth (curl) | 401 in ~1s | private backend up; not an auth-service outage |
| Clock vs server `Date` header | exact match | not signature clock skew |
| `getBalance` from host (node) | timeout ~5s | host node calls fail |
| **recon from Docker (same key)** | **clean, 200** | **not the key, not BloFin — host-side** |
| node UNAUTH call from host | timeout ~5s | not auth-specific — node-specific |
| node `family:4, autoSelectFamily:false` | **200 in 1.5s** | **IPv6/Happy-Eyeballs is the cause** |
| literal IPv4 A-record | 200 in 1.5s | IPv4 path is healthy |

## Root cause

This host's **IPv6 route to BloFin's Cloudflare endpoint is broken.** BloFin
(`demo-trading-openapi.blofin.com`) is dual-stack (A + AAAA, all Cloudflare).
Node 20+ defaults to Happy Eyeballs (`autoSelectFamily: true`), which races IPv6
and IPv4 connections. On this host the IPv6 attempt hangs (~5s) and gums up the
whole connect, surfacing as `blofin timeout`. It's **intermittent** because
sometimes the IPv4 race wins first (12:10, 16:06 worked).

- **Docker recon unaffected** — the Linux VM has a clean network path.
- **curl unaffected** — its own fallback drops the dead IPv6 fast.
- `dns.setDefaultResultOrder('ipv4first')` is **NOT sufficient** (proven): it
  only reorders DNS; Happy Eyeballs still attempts IPv6. Must disable
  autoSelect / force `family: 4`.

Same underlying host IPv6 defect as the discord-bot `ENOTFOUND` fix earlier, but
that one was patchable with `ipv4first`; BloFin's Cloudflare v6 hangs instead of
failing fast, so it needs the stronger socket-level force.

## Fix

`https.request(url, { method, headers, family: 4, autoSelectFamily: false }, …)`
in `_request`. One line. Forces IPv4-only, bypassing the dead v6 path.

## Verification

- 8/8 consecutive signed `getBalance` calls from the host: all OK (~530ms, was
  100% timeout).
- Full `autotrade-probe` (BLOFIN_AUTOTRADE=true): entry + SL + 3 TPs placed,
  5 Mongo docs, idempotency holds, reconcile + cleanup clean.
- Positions/orders/TPSL/unprotected all 0 — **no naked positions** from any of
  the 4 drops (the entries genuinely never placed).

## Notes

- The 4 dropped signals are stale (hours old, price moved) — correctly NOT
  re-entered (no auto re-arm by design). The fix prevents future drops.
- The retry fix from 2026-06-24 did its job: it made the failure **loud and
  safe** (dead-letter + no naked position) instead of silent. This commit
  removes the underlying cause so signals stop dropping at all.

## Follow-up (not urgent)

The host has a general broken-IPv6 condition. Other host-side node clients that
hit dual-stack external APIs (Binance in trigger-check/poly, RSS/AIS in
bz-news-watch) could intermittently hang the same way. Consider a global
`net.setDefaultAutoSelectFamily(false)` at process start for the native cron
scripts, or audit each HTTP client. BloFin (money path) is fixed; the rest is
lower-stakes.
