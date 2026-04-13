# Trade Setups — Entry Criteria

Three setups in priority order. Only take a trade when ALL criteria for that setup are met.
Never force a setup. No setup = no trade.

---

## Setup A — Trend Continuation

**When:** Market is in a clear trend on 4H+. Looking to enter on a pullback.

**Probability:** ~62% | **R:R Target:** minimum 1:2

### Required Criteria (ALL must be true)

1. **4H structure:** BOS confirmed in trend direction within last 10 candles
2. **4H MACD:** Histogram in trend direction (positive for long, negative for short)
3. **12H bias:** RSI above 50 (long) or below 50 (short)
4. **Price location:** Pulling back into a demand zone (long) or supply zone (short) on 1H/30M
5. **CVD:** Not diverging against the trade direction on 4H
6. **OI:** Rising (new positions being opened, not a squeeze)
7. **VWAP:** Price approaching from above demand (long) or below supply (short)

### Entry Trigger

**30M CHoCH** back in the trend direction after touching the zone.

Example (long): 4H trending up → price pulls back to 1H demand zone → 30M makes a lower low (tests zone) → 30M CHoCH up (higher low forms) → **enter long on the close of the CHoCH candle**

### Stop Placement

Below the low of the demand zone (long) or above the high of the supply zone (short).
Add 0.2% buffer beyond the zone edge.

### Targets

- TP1: Previous swing high/low (1:1 minimum)
- TP2: Next HTF supply/demand zone
- TP3: Measured move (height of impulse leg projected from entry)

### Invalidation

- Price closes a 4H candle through the zone with momentum
- CVD turns strongly negative (long) or positive (short) at zone
- OI drops sharply at zone (liquidation, not accumulation)

---

## Setup B — Reversal at Major Level

**When:** Price reaches a significant HTF supply or demand zone with exhaustion signals.

**Probability:** ~52% | **R:R Target:** minimum 1:3 (compensates for lower win rate)

### Required Criteria (ALL must be true)

1. **HTF zone:** Price reaching a 4H or 12H supply/demand zone
2. **CVD divergence:** Price making new high/low but CVD is NOT confirming (divergence present)
3. **OI behavior:** OI falling as price extends (short squeeze / long liquidation, not real move)
4. **Session VP:** Up/Down ratio opposing the current move (e.g., price rising but Down > Up)
5. **RSI:** Overextended on 1H (>70 for short, <30 for long) OR RSI divergence present
6. **VWAP:** Price significantly extended from VWAP (>1.5% away)
7. **SMC:** EQH or EQL visible just beyond current price (liquidity pool — sweep likely)

### Entry Trigger

**30M CHoCH** in reversal direction after price sweeps the EQH/EQL liquidity.

The sweep is critical — wait for price to briefly push through equal highs/lows, then immediately reverse. Enter on the 30M candle that closes back through the EQH/EQL level.

### Stop Placement

Beyond the extreme of the sweep wick + 0.3% buffer.

### Targets

- TP1: VWAP (price always returns to VWAP)
- TP2: Opposite HTF zone
- TP3: Measured reversal move

### Invalidation

- Price closes a 1H candle beyond the sweep level (not a wick — a close)
- CVD confirms the move (no longer diverging)
- OI rises sharply through the zone (real conviction buying/selling, not a trap)

---

## Setup C — Liquidity Grab

**When:** Price sweeps a pool of equal highs or equal lows, then immediately reverses.
Highest probability setup when it occurs cleanly. Rarest.

**Probability:** ~70% | **R:R Target:** minimum 1:2 (fast move expected)

### Required Criteria (ALL must be true)

1. **EQH/EQL visible:** LuxAlgo has labeled Equal Highs or Equal Lows on 1H or 30M
2. **Sweep occurs:** Price wicks through the EQH/EQL level (can be any timeframe wick)
3. **Immediate rejection:** The sweep candle closes back below EQH (short) or above EQL (long) — the wick must be rejected, not consolidated above/below
4. **OI spike then drop:** OI spikes during the sweep (stop-hunt liquidations) then drops — confirms stops were run
5. **CVD reversal:** CVD turns sharply in the reversal direction on the sweep candle or next candle
6. **Volume spike:** Volume on the sweep candle is >2x the 10-candle average

### Entry Trigger

Enter on the **close of the sweep candle** (if it closes back through the level) or on the **next candle open** if the rejection is clear.

This is a fast entry — do not wait for a 30M CHoCH. The sweep itself is the signal.

### Stop Placement

Beyond the tip of the sweep wick + 0.2% buffer.

### Targets

- TP1: Nearest opposing zone (fast, take partial here)
- TP2: VWAP
- TP3: Opposite EQH/EQL

### Invalidation

- Price consolidates beyond the EQH/EQL (liquidity grab failed, trend continuation instead)
- OI continues rising after the sweep (institutions still positioning)

---

## No-Trade Conditions

Do not take any setup when:
- 12H and 4H bias contradict each other
- Squeeze Momentum is 0.00 across all timeframes (market has not chosen direction — wait for the fire)
- CVD is flat/sideways on 4H (no institutional conviction)
- Funding rate is extreme in your trade direction (already over-leveraged — you are late)
- Less than 2 hours before a major macro event (FOMC, CPI, etc.)

---

## Setup Checklist (Quick Reference)

Before entering, confirm:
- [ ] Setup type identified (A, B, or C)
- [ ] All required criteria met
- [ ] Entry trigger confirmed (not anticipated)
- [ ] Stop level defined
- [ ] TP1, TP2, TP3 defined
- [ ] Position size calculated (see risk-management.md)
- [ ] Invalidation level noted
