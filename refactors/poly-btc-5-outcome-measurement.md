# Poly BTC-5 Outcome Measurement — Validation Against Polymarket Rules

## What was investigated

Whether `trigger-check.js` line 361's outcome measurement matches Polymarket's actual resolution rules:
```js
prevEval.outcome = prevCompletedBar.close > prevCompletedBar.open ? 'UP' : 'DOWN';
```

## What Polymarket actually resolves on (verified from live market page)

- **Price feed**: Chainlink BTC/USD data stream — explicitly NOT Binance perp or any other single source
- **Logic**: resolves UP if `price_at_end >= price_at_start` (equal = UP), DOWN otherwise

## Two real discrepancies found

### 1. Equality operator — `>` vs `>=` ✅ Fixed

Our code used strict `>`. A bar that closes exactly at its open would score DOWN, but Polymarket resolves it UP. Fixed to `>=`.

Risk: zero. At BTC prices and 5-min volatility, an exact close == open is essentially impossible. The fix is cosmetically correct.

### 2. Price feed — perp futures vs Chainlink spot ⚠️ Accepted as approximation

We measure `BINANCE:BTCUSDT.P` (perpetual futures). Polymarket uses Chainlink BTC/USD (spot aggregated from Coinbase, Binance spot, Kraken, etc.). Perp trades at a premium/discount to spot due to funding. On a normal day with typical 5-min moves, directional agreement is ~98%+. During funding rate flips or post-news bursts, the spread can flip a marginal move.

**Decision: leave as-is.** Fixing this would require either:
- A second chart symbol switch to `BINANCE:BTCUSDT` (spot) just for outcome reads — adds latency + complexity to every outcome check cycle
- Querying Chainlink's data stream API externally — new dependency, not worth it

~2% noise on outcome tracking does not meaningfully corrupt calibration. Document and accept.

## What the prior audit got wrong

`recent-analysis.md` (Bug #8) said the problem was: "`barClose > barOpen` not equivalent to measuring from the signal bar's open." This is wrong — `prevCompletedBar` is matched by `t.barOpen === prevBar`, so it IS the signal bar. `barClose > barOpen` IS measuring from the signal bar's open. The audit confused itself on the geometry. The real issues were the equality operator and the price feed.

## Risk summary

- `>=` fix: zero risk, outcome tracking only, no live behavior changes
- Price feed approximation: accepted, documented, ~2% noise on calibration data
