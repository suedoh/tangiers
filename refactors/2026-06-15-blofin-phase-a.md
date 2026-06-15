# BloFin Phase A — Foundation client + health check

**Date:** 2026-06-15
**Phase:** A of [BloFin roadmap](2026-06-15-blofin-roadmap.md)
**Status:** Shipped — pending user credential paste + `make blofin-status` confirmation

## What shipped

| File | Purpose |
|---|---|
| [scripts/lib/blofin.js](../scripts/lib/blofin.js) | REST client: base-URL resolution, signing, read endpoints |
| [scripts/blofin/status.js](../scripts/blofin/status.js) | 3-step health check (public instrument → balance → positions) |
| `.env.example` | `BLOFIN_ENV`, `BLOFIN_API_KEY/SECRET/PASSPHRASE` |
| `Makefile` | `make blofin-status` target |

## Signing scheme — the one gotcha

BloFin uses a **two-step encoding** for the signature:

```
prehash = requestPath + METHOD + timestamp_ms + nonce + body
hex     = HMAC-SHA256(secret, prehash).digest('hex')
sig     = base64(utf8-bytes-of(hex))
```

This is **NOT** the OKX-style single base64-of-raw-HMAC that most developers reach for first. The wrong implementation produces a valid-looking signature that the exchange rejects with error code 50113. Implementation is at [lib/blofin.js:48](../scripts/lib/blofin.js#L48) — if anyone touches it, the test vector is: paste creds, `make blofin-status`, expect a 200 on step 2.

Other quirks worth knowing:
- `ACCESS-NONCE` header is required (most exchanges don't ask for this)
- `ACCESS-TIMESTAMP` is in **milliseconds**, not seconds
- `requestPath` in the prehash MUST include the query string for GET
- Response envelope is `{code, msg, data}` where `code === '0'` (string) means success

## Demo defaults

Base URL defaults to demo unless `BLOFIN_ENV=prod` — chosen deliberately so credentials accidentally committed to a dev environment can't touch real capital. Roadmap forbids `BLOFIN_ENV=prod` until Phase E.

## BTC-USDT perpetual specs (demo, confirmed live)

| Field | Value |
|---|---|
| `contractValue` | 0.001 BTC |
| `tickSize` | 0.1 USD |
| `lotSize` | 0.1 contracts |
| `minSize` | 0.1 contracts (~$7 notional at current price) |
| `maxLeverage` | 150× |
| `instType` | SWAP, linear |

These feed Phase B's position sizing math: any signal at risk < ~$7 cannot be placed (minSize floor); leverage cap will need to come from `.env`.

## Endpoints exposed (read-only)

- `getInstruments(instId)` — public, no auth
- `getBalance(accountType='futures')` — private
- `getPositions(instId?)` — private

Notably absent: user fills history. That endpoint exists but isn't needed until Phase B reconciliation; defer to keep Phase A focused.

## Exit criteria check

Phase A exits when **`make blofin-status` exits 0** on the user's machine with credentials populated. Until then, status is "scaffolding shipped, awaiting user verification."

Once green, Phase B (paper-trade execution) can start.
