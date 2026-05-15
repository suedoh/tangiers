# BTC — Position Sizing + Drawdown-Mode Size Suggestion
**Status:** DONE — shipped 2026-05-15 PM
**Owner:** suedoh
**Roadmap:** [2026-05-15-btc-optimization-roadmap.md](2026-05-15-btc-optimization-roadmap.md) Phase 1, items P1-5 + P1-6
**Source:** 2026-05-15 PM "quant trader's must-haves" review

## What changed

Two additions to BTC signal alerts. Neither changes which signals fire — they only enrich the alert text. Observation-window safe.

### P1-5 — Position sizing math

When `ACCOUNT_EQUITY_USD` is set in `.env`, the alert now includes a `**POSITION SIZING**` section computed from:

| Input | Source |
|---|---|
| Account equity | `ACCOUNT_EQUITY_USD` env |
| Risk per trade | `RISK_PER_TRADE_PCT` env (default 1.0%) |
| Tier multiplier | A=1.0, B=0.7, C=0.3 (applied to risk %, not notional) |
| Drawdown multiplier | 0.5 if ≥3 consecutive confirmed stops, else 1.0 |
| Stop distance | `|entry − stop|` from the signal |

Output:
```
Risk: $150 (1.00% of $15,000)
Stop distance: $1,000 | Size: 0.1500 BTC (~$15,000 notional, 1.0× leverage)
```

If `ACCOUNT_EQUITY_USD` is unset (partner machine, dev mode, or new user not yet configured), the section is omitted and the alert keeps the tier multiplier display only.

### P1-6 — Drawdown-mode size suggestion

`currentDrawdownMultiplier()` walks the most recent **confirmed** closed trades in descending `closedAt`. Counts consecutive stops at the head of the list:
- 0–2 stops → multiplier 1.0
- 3+ stops → multiplier 0.5 (size halved)
- Any winner (tp1/tp2/tp3) clears the streak

Unconfirmed-stops do NOT count (per BACKTESTING.md "entry condition was never met"). This is consistent with D1's post-fix data model.

Applied multiplicatively with the tier: a Setup B (0.7×) in drawdown mode shows 0.35× effective.

## Why P1-5 was the single most-missing piece

A signal alert that says "1.0× base" without quantifying base is non-actionable. Two retail traders given the same alert and the same account size will type wildly different position sizes into Binance. The strategy's measured 75% wr on the clean cohort cannot translate to account P&L without consistent sizing. This is the single biggest force multiplier between "the system has edge" and "the user actually captures that edge."

## Why drawdown-mode is anti-martingale, not stop-loss

The daily-R kill switch (shipped earlier today) is binary: trade at full size or stop. Drawdown-mode sits between them — keep trading but smaller — so the user doesn't sit out a regime that's about to recover. Combined with the daily-R floor at −3R, the cap on a single bad day is approximately:
- 3 full-size stops = −3R → daily kill fires; remaining 0R for the day
- 3 stops then half-size = −3R + (−0.5R) per next stop → 6 half-size stops before next kill point

This matches the "size down in drawdown, ride through with smaller exposure" pattern in institutional risk books.

## Files

| File | Change |
|---|---|
| [scripts/trigger-check.js](../scripts/trigger-check.js) | `computeSizing()` + `currentDrawdownMultiplier()` helpers; `formatSetupMessage()` renders the new `**POSITION SIZING**` block when configured |
| [.env.example](../.env.example) | Adds `ACCOUNT_EQUITY_USD=` and `RISK_PER_TRADE_PCT=1.0` with guidance |

## Risk

- Selection-rule changes: **none**. Alerts only.
- Observation window: **safe**. Doesn't change `trades.json` schema, doesn't change which signals fire, doesn't affect `my-trades.json`.
- Sizing math edge cases: handled — zero stop distance, unset equity, negative inputs all fall back to null/no-section.
- Drawdown counter on unconfirmed trades: explicitly filtered out (only confirmed stops count).

## Verification

- Syntax check passes
- Smoke tests: Setup A at $15k/1% → $150 risk / 0.15 BTC / 1.0× leverage ✓; Setup B with drawdown → 0.35× effective ✓; no equity → null ✓; drawdown streak counting (single winner / single stop / 3 stops / 3 stops then win / unconfirmed stops ignored) — all match expected values ✓

## To activate on your machine

1. Edit `.env`:
   ```
   ACCOUNT_EQUITY_USD=15000
   RISK_PER_TRADE_PCT=1.0
   ```
2. Next BTC signal alert will include the POSITION SIZING block.
3. To run dev-only or partner-mode without sizing: leave `ACCOUNT_EQUITY_USD` blank.
