# Trade Setups — Entry Criteria

The automated system uses **VRVP levels** (HVN, POC, VAH, VAL) as zone anchors. The setup criteria below define what makes a signal at each level type worth taking.

Never force a setup. No setup = no trade. A Discord alert is a signal to evaluate, not a signal to enter.

---

## The Three Setup Types

The automated system scores signals against these criteria and includes the result in every Discord alert. Use this as your decision framework when reviewing an alert.

### Setup A — VRVP Level Bounce / Continuation

**When:** Price approaches a VRVP level with order flow aligned in the same direction as the recent trend.

**Best level types:** HVN (demand from previous accumulation), VAL (bottom of value area — institutions defend this), VAH (breakout above value area — continuation likely)

**Probability base:** ~62% | **Minimum R:R:** 1:2

**Required (all must be true):**
- Price at or inside the VRVP level
- CVD aligned with trade direction (positive for long, negative for short)
- OI rising — new positions being opened, not a squeeze / liquidation
- VWAP: price above (long) or below (short)
- Session VP Up/Down ratio aligned with direction
- 4H MACD histogram in trade direction
- 12H RSI above 50 (long) or below 50 (short)

**Entry trigger:** Wait for a 30M bar to **close beyond the entry price** in the trade direction. This is the confirmation that the level is holding, not breaking. An alert firing does not mean you enter immediately — wait for the 30M close.

**Stop:** Beyond the far edge of the VRVP level + 0.15% buffer

**Targets:**
- TP1: Next VRVP HVN or POC in the trade direction (1:1.5–2 minimum)
- TP2: VAH (for longs) or VAL (for shorts) — the opposite edge of value
- TP3: Measured move or next major VRVP cluster

**Invalidation:**
- 30M close through the zone in the opposite direction
- CVD turns sharply against the trade at the level (distribution/accumulation signal)
- OI drops sharply at zone (liquidation move, not real accumulation)

---

### Setup B — VRVP Level Reversal

**When:** Price reaches VAH (extended above value area) or VAL (extended below value area) with exhaustion signals. Mean reversion back toward POC expected.

**Best level types:** VAH (price above value — potential short), VAL (price below value — potential long), POC (price far from POC — reversion target)

**Probability base:** ~52% | **Minimum R:R:** 1:3 (lower win rate requires larger winners)

**Required (all must be true):**
- Price reaching or extending beyond VAH (short) or VAL (long)
- CVD divergence: price making new high/low but CVD is NOT confirming
- OI falling as price extends (short squeeze / long liquidation — not a real move)
- Session VP opposing the move (Down > Up on a rising price = distribution)
- 12H RSI overextended (>70 for short, <30 for long) or RSI divergence present
- Price significantly extended from VWAP (>1.5%)

**Entry trigger:** 30M close back inside the value area (below VAH for short, above VAL for long) with CVD turning in reversal direction

**Stop:** Beyond the extreme wick + 0.2% buffer

**Targets:**
- TP1: VWAP (price always returns to VWAP)
- TP2: POC (point of control — highest volume, strongest mean reversion target)
- TP3: Opposite edge of value area (VAL for shorts, VAH for longs)

**Invalidation:**
- 1H close beyond the extension level (not a wick — a close confirms trend continuation)
- CVD confirms the move (divergence resolves in trend direction)
- OI rises sharply at the level (real conviction, not a trap)

---

### Setup C — Stop Hunt / Liquidity Grab

**When:** Price briefly sweeps beyond a clear structural high/low (liquidity pool), then immediately reverses with sharp CVD and OI reversal.

**Note:** The automated system does not currently detect EQH/EQL labels automatically. This setup can be identified manually via Claude Desktop analysis or by watching for POC/VAL/VAH sweeps followed by sharp reversal.

**Probability base:** ~70% when clean | **Minimum R:R:** 1:2 (fast move expected)

**Required (all must be true):**
- Clear swing high or low (or VRVP VAH/VAL) acting as a liquidity pool just beyond current price
- Price wicks through the level (sweep occurs)
- The sweep candle closes back through the level — wick rejected, not consolidated beyond
- OI spikes during the sweep then drops (stop-hunt liquidations confirmed)
- CVD turns sharply in the reversal direction on the sweep candle or next candle
- Volume on sweep candle is >2× the 10-candle average

**Entry trigger:** Close of the sweep candle (if it closes back through the level) or next candle open. Do not wait for a 30M confirmation — the sweep itself is the signal.

**Stop:** Beyond the tip of the sweep wick + 0.2% buffer

**Targets:**
- TP1: Nearest VRVP HVN in the reversal direction (fast, take partial)
- TP2: VWAP
- TP3: Opposite structural level or VRVP cluster

**Invalidation:**
- Price consolidates beyond the sweep level (liquidity grab failed — trend continues)
- OI continues rising after the sweep (real institutional positioning, not a trap)

---

## No-Trade Conditions

Do not take any setup when:

- 12H and 4H bias directly contradict each other (coin flip — wait for resolution)
- CVD is flat/sideways on 4H (no institutional conviction — market is indecisive)
- Funding rate is extreme in trade direction (>0.1% per 8h — over-leveraged side, sweep risk)
- Less than 2 hours before a high-impact macro event (FOMC, CPI, NFP)
- `!stop` has been used to pause notifications (system paused for a reason)

---

## VRVP Level Priority

| Level | Why it matters | Weight |
|---|---|---|
| **VAL** | Bottom of 70% volume band — institutions defend this as fair value | Highest |
| **VAH** | Top of 70% volume band — breakout above here = new value area forming | Highest |
| **HVN** | Individual high-volume node — previous accumulation/distribution | High |
| **POC** | Single bar with most volume — magnetic, price returns to it | Medium |

Signals at VAL or VAH carry more structural weight than HVN signals. HVN signals carry more than POC signals.

---

## Probability Model

Every automated alert includes a probability score (28–91%) and EV at TP2.

**Base rate:** 62% (Setup A baseline), adjusted per criterion:

| Criterion | Pass | Fail |
|---|---|---|
| CVD aligned with direction | +7% | −11% |
| OI rising (new conviction) | +6% | −9% |
| Price at VAL or VAH (structural level) | +5% | −8% |
| 12H + 4H macro aligned | +5% | −8% |
| 4H MACD aligned | +4% | −6% |
| Price above/below VWAP | +4% | −6% |
| 12H RSI above/below 50 | +3% | −4% |

VRVP position bonus: price between VAL and POC +3pp | above POC +1pp | below VAL −3pp

Failures weighted ~1.5× harder than confirmations. Score clamped to [28%, 91%].

**Expected Value (at TP2):**
```
EV = (probability × R:R_at_TP2) − ((1 − probability) × 1.0)
```

- EV > +0.5R and probability ≥ 55%: positive expected value — follow your entry trigger
- EV 0 to +0.5R: marginal — tighter sizing or wait for better confirmation
- EV < 0: skip it even if criteria pass

---

## Pre-Trade Checklist

Before entering:

- [ ] Setup type identified (A, B, or C)
- [ ] All required criteria met
- [ ] Entry trigger confirmed (30M close beyond entry, not anticipated)
- [ ] Stop level defined (beyond VRVP zone edge + buffer)
- [ ] TP1, TP2, TP3 defined (reference VRVP levels in trade direction)
- [ ] Position size calculated (see `strategies/risk-management.md`)
- [ ] Invalidation level noted
- [ ] No-trade conditions checked
