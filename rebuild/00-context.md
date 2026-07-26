# 00 — Context: system state as of 2026-07-26

Read this before touching anything. Everything here is cited to code or to the independent
audit ([refactors/btc-audit-2026-07-26-independent.md](../refactors/btc-audit-2026-07-26-independent.md),
sections referenced as §N / D-numbers / R-numbers).

## What exists today

**Signal side (BTC):** [scripts/trigger-check.js](../scripts/trigger-check.js) (~2,540 lines,
inlined legacy CDP) polls TradingView Desktop every 10 min via CDP :9222, reads VRVP levels,
fires on proximity (`buf = price × 0.0035`, `checkVRVPProximity` at line 678), builds
entry/stop/TPs in `evaluateSetup` (line 733), confirms via `checkConfirmation` (line 1628),
scores outcomes via `walkBarsForOutcome` (line 1870) inside `updateOutcomes` (line 1890).
Signals + lifecycle live in `trades.json` (canonical write path) with hourly Mongo sync.

**Execution side (BloFin demo, Phase D since 2026-06-15):**
[scripts/lib/blofin-autotrade.js](../scripts/lib/blofin-autotrade.js) — market entry sized off
plan entry→stop distance, fill-fetch by clientOrderId (lines 133–147), risk trim if fill chased
>25% toward stop (361–379), standalone TPSL SL with verify-or-flatten (409–453), TP ladder
repriced off fill with burned-rung redistribution (162–177). Recon every 3 min
(`scripts/blofin/recon-once.js`, host cron), watchdog every 5 min (`scripts/ops/watchdog.js`),
Mongo `blofin_orders` ledger, degraded-mode spool. Protection invariant: measured **0
unprotected positions across recon history** — this subsystem is correct.

## What the audit proved (condensed)

| Finding | Evidence | Consequence |
|---|---|---|
| **D1** Ledger scores untradeable fills | `walkBarsForOutcome` (trigger-check.js:1870) never checks whether price reached `t.entry` — it walks stop/TP from the raw bar sequence. 502/801 signals never filled their planned entry before a TP; 465 booked wins = +1,008.5R | The +964.7R book is fiction |
| **D2** No timing skill | Random-entry Monte Carlo, identical geometry: actual book at 0th percentile | The signal adds nothing over its payoff shape |
| **D3** Fees ≫ edge | Measured 6bp taker / 2bp maker from real fills; 0.216% stops ⇒ ~183–250× notional/risk ⇒ 0.27–0.47R fees vs +0.014R gross | Nothing clears costs at current geometry |
| **D4** Confirmation on forming bars | `checkConfirmation` (1628) reads a TV OHLCV series that includes the in-progress 30M bar | Confirms on prices that never closed |
| **D6** Executed-track overstates 2.3× | [scripts/lib/executed-walk.js](../scripts/lib/executed-walk.js) prices rungs off *planned* entry, walks from fire-time, charges no fees: +185.3R claimed vs ~$81.5 R-equivalent exchange truth | Even the "realistic" track is wrong |
| **D7** Kill switch watches fiction | [scripts/lib/daily-r.js:21](../scripts/lib/daily-r.js) sums canonical `pnlR` | −3R floor can never trip on real losses |
| **D8** Unbounded same-direction stacking | Guard at blofin-autotrade.js:276 only blocks *opposite* direction. 48 long refires stacked 238.3 contracts, locking $1,528/$1,570 margin; all signals since 2026-07-26T01:50Z silently skipped | Live incident; no watchdog class covers margin |
| **D10** TV data unstable | 14.9% of cycles blind (VRVP hidden/stale); 34% decision-stability vs exchange-computed | Signal input disagrees with itself |
| **D11** Serial dependence | lag-1 ρ=0.349 ⇒ effective n≈374 of 801 (~317 distinct setups) | Every CI on nominal n is ~2× overconfident |
| **D12** Probabilities miscalibrated | Tier labels 85/74/63 (trigger-check.js:931–938) fail Brier/ECE on both accountings | Retire the labels |

**Corrected-ledger estimate of history** (audit §9 step 3): hit rate ~71%→~73% but mean R
falls **+1.20 → ≈ −0.10**, totals **+965R → ≈ −78R**. Expect this. It is correct.

## Where truth lives

| Question | Source | Notes |
|---|---|---|
| What actually happened to money | BloFin `orders-history` (`pnl`, `fee` per order) via [scripts/lib/blofin.js](../scripts/lib/blofin.js) | Durable server-side; survives local state loss |
| Order→signal linkage | Mongo `blofin_orders` (`orderId`→`signalId`) + entry clientOrderId derived from signal id | Only join path; see [tools/reconcile.js](tools/reconcile.js) |
| Ground-truth prices | Binance Futures public REST `/fapi/v1/klines` via [scripts/lib/binance.js](../scripts/lib/binance.js) `getKlinesRange` | Audit pulled 104d of 30m+1m bars, zero gaps |
| What the system believed | `trades.json` / Mongo `trades` | Untrusted until spec 03 lands |

## Environment constraints (permanent)

- CDP-bound scripts must run on the **host** (Docker on macOS can't reach :9222). Everything
  else runs in the `ace-cron` container. After spec 06, the BTC signal path has **no** CDP
  dependency and can containerize.
- BloFin API docs are wrong in catalogued ways — see the table in [CLAUDE.md](../CLAUDE.md).
  **Probe scripts before trust**, always.
- Recon/API egress must not route through full-tunnel VPN (Cloudflare 403s —
  `refactors/` 2026-07-10 note). Split-tunnel is the standing fix.
- Partner machine runs `PRIMARY=false` / `TRADINGVIEW_ENABLED=false` — never hardcode absolute
  paths; guard anything host-specific.
- `.env` keys in play: `BLOFIN_ENV=demo`, `BLOFIN_AUTOTRADE`, `ACCOUNT_EQUITY_USD`,
  `RISK_PER_TRADE_PCT`, webhooks per CLAUDE.md.

## Sample limitations (carry into every claim you make)

One instrument, one venue, 104 days (2026-04-13→07-26), 78 signal-days, **one dominant regime**
(net decline ~73k→64.7k, no sustained uptrend tested). Exchange truth only from 2026-06-15
(n=126 signals). Demo fills may be friendlier than prod; fee schedule at prod tiers unverified.
1m-bar walks can't resolve sub-minute path (stop-first assumed within a bar).
