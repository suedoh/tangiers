# 2026-07-12 — BTC Exchange-Native Migration Plan

**Goal:** remove TradingView CDP from the BTC signal pipeline so it can deploy
to a remote server. Replace TV-scraped indicators with the same quantities
computed from Binance Futures REST. TradingView stays as the human/qualitative
cockpit (Claude Desktop MCP, screenshots, other instruments).

**Scope:** `trigger-check.js` (#btc-signals), BTC reports, outcome backtest,
BloFin recon/execution. **Out of scope:** Poly, EW, BZ!, `!analyze`/
`mtf-analyze.js` (stays CDP on the Mac), EW screenshots, LuxAlgo.

## Why (evidence, not theory)

Every operational incident in this repo traces to the GUI-as-data-layer:
war report blind 3 weeks (ECONNREFUSED from Docker, fixed cc8e443), discord-bot
Docker revert (2026-06-16), recon 403s (2026-07-02), CVD U+2212 sign-flip,
K/M/B unit parsing, OI unit chaos (all 4f175b3), "VRVP must be visible or no
triggers fire", the `.tradingview-lock` mutex. All scraping tax.

Precision gains: raw floats instead of formatted strings; deterministic
fixed-window zones instead of zoom-dependent visible range; reproducible →
zones become backtestable for the first time (audit stack can finally run on
the zone source, not just outcomes).

## Audit findings (what actually depends on TV)

| Input | Current use | Migration | Risk |
|---|---|---|---|
| CVD | Confirmation reads CVD *at 30M bar close* from state history — delta-based, anchor-free | Binance fallback already exists (trigger-check.js:443) — promote to primary | Low |
| OI | Trend rule ≥0.5% rise vs baseline | Fallback exists; units unified in 4f175b3 — promote | Low |
| 30M bars (outcome walk) | `walkBarsForOutcome` already bar-accurate; only the bar *source* is CDP | `/fapi/v1/klines?interval=30m` — signal-brain audit proved TV bars ≡ Binance bars | Low |
| Session VP bias | Up/Down ratio | Up/down vol from current-session 5m klines (takerBuy split) | Low |
| VWAP | Entry anchor | Session-anchored from klines | Low |
| **VRVP histogram + VAH/VAL** | Zone source (POC/VAH/VAL/HVN/LVN) | **Build from 5m klines** — the only real engineering | **Medium** |
| HVN/LVN clustering, priority, direction, buffers | — | Already our own JS (`computeVRVPLevels`, `checkVRVPProximity`) — reuse unchanged | None |

## Key decisions (grilled 2026-07-12)

1. **Zone lookback: calibrate-then-freeze.** Measure the Ace chart's actual
   visible range + VRVP row size during P1, round to a clean number, freeze as
   config. Preserves comparability with ~700 historical signal outcomes.
   Rejected: a-priori "correct" window (breaks the signal record), anchored
   quarter window (zone jumps at boundaries).
2. **Histogram construction:** 5m klines over the frozen window; bucket volume
   at hlc3; up/down split = `takerBuy` vs remainder; row height calibrated to
   TV's rows. VAH/VAL = standard 70% value-area expansion from POC.
3. **Parity before trust** (same pattern as Mongo dual-write): shadow-compute
   every poll cycle alongside the TV read, log both to JSONL, diff. Live
   behavior unchanged during parity — zero Phase D impact.
4. **Failure semantics unchanged:** Binance unreachable → skip cycle + error
   alert. Never signal off a stale cached profile.

## Parity gate (quantified — P3 go/no-go)

- ≥14 days of shadow cycles
- POC/VAH/VAL: median |Δ| ≤ 0.10% of price, p95 ≤ 0.25%
- Trigger-decision agreement (fire/no-fire + direction + zone type) ≥ 95%
- CVD-sign agreement ≥ 99%; OI-trend agreement ≥ 99%
- Miss → recalibrate window/bucket size, restart the 14-day clock

## Phases

| Phase | Work | Gate |
|---|---|---|
| P0 | `scripts/lib/market-data.js`: incremental klines cache, profile builder, CVD, OI, session VP, VWAP | Unit tests vs known-answer fixtures |
| P1 | Calibrate visible range + row size off the live Ace chart → freeze config | Config committed |
| P2 | Parity sidecar in `trigger-check.js` (shadow JSONL, no behavior change) | 14+ days accumulated |
| P3 | Parity report vs gate above | Go/no-go |
| P4 | Cutover: `BTC_ZONE_SOURCE=tv\|computed` flag; every signal tagged `zoneSource`; `win-rate-diff.js` baseline snapshot BEFORE flip (metrics protocol); outcome-walk source swap; TV path retained ≥2 wks for rollback | Clean week post-cutover |
| P5 | Remote deploy: compose stack (trigger, recon, watchdog, Mongo, reports) on VPS; `PRIMARY` flips to server; Mac demoted to TV cockpit | Watchdog green 7 days |

## Phase D interaction

- P0–P3 are read-only sidecars: forward test unaffected.
- P4 cutover **is** a signal-brain change: schedule at a Phase D checkpoint,
  snapshot baseline first, note clean-clock restart. `zoneSource` tag keeps
  attribution separable.
- P5 bonus: VPS egress permanently kills the ProtonVPN/Cloudflare-403 failure
  class (see reference_blofin_403_vpn).

## Deferred (not forgotten)

- Poly/EW factor reads → same `market-data.js` once BTC parity proves it
- BZ!: needs a NYMEX feed (e.g. IB Gateway) + own order-block detection, or
  stays local permanently
- Historical zone replay/backtest script (unlocked by determinism; v2)
- Order-book/liquidation microstructure factors (post-migration, gated on
  Phase discipline)
