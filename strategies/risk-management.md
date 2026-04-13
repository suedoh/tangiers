# Risk Management

## Core Rules

1. **Never risk more than 1% of account per trade**
2. **Never have more than 2% of account at risk simultaneously** (max 2 open trades)
3. **Never move stop to breakeven before TP1 is hit**
4. **Never add to a losing position**
5. **R:R minimum: 1:2 for Setup A and C, 1:3 for Setup B**

---

## Position Sizing Formula

```
Position Size = (Account Balance × Risk %) / (Entry Price - Stop Price)
```

Example:
- Account: $10,000
- Risk per trade: 1% = $100
- Entry: $71,500
- Stop: $70,500 (distance = $1,000)
- Position size = $100 / $1,000 = 0.1 BTC

---

## Stop Loss Rules

- Always place stop **beyond the zone**, not at the zone edge
- Add buffer: 0.2% for Setup A/C, 0.3% for Setup B
- Never use a stop tighter than 0.5% from entry (slippage risk on BTC)
- Never use a stop wider than 3% from entry (position size becomes too small to be meaningful)

---

## Take Profit Management

**Partial exit strategy:**
- At TP1 (1:1 R:R): Close 40% of position, move stop to breakeven
- At TP2 (1:2 R:R): Close another 40% of position
- At TP3 (1:3 R:R): Close remaining 20%

This locks in profit while letting a runner work toward the full target.

---

## Trade Management After Entry

- Once TP1 is hit and stop is at breakeven: the trade is "free" — no more risk
- Do not watch the chart tick-by-tick — check at each 30M candle close
- If price consolidates for more than 4 candles near entry without moving to TP1: consider closing at breakeven (momentum gone)

---

## Daily Loss Limit

- **Stop trading for the day if -2% of account is hit**
- This prevents revenge trading after a losing session
- Come back fresh next session

---

## Setup-Specific R:R Minimums

| Setup | Min R:R | Why |
|---|---|---|
| A — Trend Continuation | 1:2 | Higher frequency, needs good R:R to be profitable long-term |
| B — Reversal | 1:3 | Lower win rate (~52%), requires larger winners to be net positive |
| C — Liquidity Grab | 1:2 | High win rate (~70%), even 1:2 is very profitable at this rate |

---

## What NOT to Do

- Do not enter without a defined stop loss
- Do not increase position size to "make back" losses
- Do not take a trade just because a Discord alert fired — confirm the trigger yourself
- Do not trade during extreme funding rate (>0.1% per 8h in either direction)
- Do not trade the same direction as a setup if OI is falling (liquidation move, not trend)
