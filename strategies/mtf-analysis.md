# Multi-Timeframe Analysis Protocol

## Overview

Run this sequence in full before making any trade decision.
Timeframes in order: **12H → 4H → 1H → 30M**
Higher timeframes define the bias. Lower timeframes define the entry.

---

## Per-Timeframe Checklist

For each timeframe, collect and record:

### 1. Indicator Readings (`data_get_study_values`)

| Indicator | Bullish Reading | Bearish Reading | Notes |
|---|---|---|---|
| RSI | > 50, rising | < 50, falling | MA crossover direction matters more than level |
| VWAP | Price above | Price below | Institutional benchmark |
| CVD | Positive, rising | Negative, falling | **Divergence from price = highest signal** |
| Open Interest | Rising with price | Rising against price, or falling | Falling OI = liquidation, not conviction |
| Session VP | Up > Down | Down > Up | Ratio more important than absolute numbers |
| VRVP | Price above POC | Price below POC | POC = highest volume node |

### 2. Market Structure (`data_get_pine_labels` + `data_get_pine_lines`)

Read the most recent labels (top of list = most recent):
- **BOS** (Break of Structure) = trend continuation signal
- **CHoCH** (Change of Character) = potential trend reversal
- **EQH/EQL** (Equal Highs/Lows) = liquidity pools above/below — targets for sweeps

Record:
- Direction of most recent BOS/CHoCH
- Distance from current price to nearest BOS/CHoCH level
- Cluster of levels (3+ levels within 0.5% of each other = strong zone)

### 3. Supply & Demand Zones (`data_get_pine_boxes`)

Record all active boxes as `{high, low}` pairs.
Classify each as:
- **Supply** (above current price) — potential short entry or TP for long
- **Demand** (below current price) — potential long entry or TP for short

Zone strength increases when:
- Multiple timeframes show a zone at the same price area (confluence)
- Zone aligns with a VRVP HVN (high volume node)
- Zone aligns with a previous BOS level

---

## Synthesis Grid

After collecting all four timeframes, fill this grid:

| | 12H | 4H | 1H | 30M |
|---|---|---|---|---|
| RSI bias | | | | |
| VWAP position | | | | |
| CVD direction | | | | |
| OI direction | | | | |
| Session VP bias | | | | |
| Last SMC signal | | | | |
| Nearest zone | | | | |

**Scoring:**
- Count bullish vs bearish readings
- 5+ of 7 in one direction = strong bias
- 4 of 7 = moderate bias
- 3-4 split = no trade, wait for clarity

---

## CVD Divergence — Priority Signal

CVD divergence overrides other readings when present:

| Price | CVD | Signal |
|---|---|---|
| Higher high | Lower high | Bearish divergence — institutions selling into strength |
| Lower low | Higher low | Bullish divergence — institutions buying weakness |
| Flat/ranging | Rising sharply | Accumulation — breakout likely up |
| Flat/ranging | Falling sharply | Distribution — breakdown likely |

---

## Open Interest Interpretation

| Price | OI | Meaning | Action |
|---|---|---|---|
| Rising | Rising | New longs entering — trend has conviction | Trade with trend |
| Rising | Falling | Short squeeze — move may exhaust soon | Caution on longs, watch for reversal |
| Falling | Rising | New shorts entering — trend has conviction | Trade with trend |
| Falling | Falling | Long liquidation — may be near exhaustion | Watch demand zones for bounce |

---

## Timeframe Hierarchy Rules

1. **12H sets the macro bias** — only trade against it with extreme confluence
2. **4H sets the trade direction** — MACD and structure here defines entry side
3. **1H sets the zone** — which specific level to watch for entry
4. **30M sets the trigger** — CHoCH or BOS on 30M is the actual entry signal

If 12H and 4H disagree → no trade, mark as "wait"
If 4H and 1H disagree → reduce size or wait for alignment
If only 30M disagrees with higher TFs → this is noise, ignore 30M bias

---

## Output Format

After completing the analysis, produce:

```
## BTCUSDT MTF Analysis — [DATE TIME]

**Current Price:** $XX,XXX
**Overall Bias:** BULLISH / BEARISH / NEUTRAL (X/7 readings)

### Timeframe Summary
- 12H: [bias] — RSI [value], CVD [direction], OI [direction], last SMC: [BOS/CHoCH at price]
- 4H:  [bias] — RSI [value], CVD [direction], OI [direction], last SMC: [BOS/CHoCH at price]
- 1H:  [bias] — RSI [value], CVD [direction], last SMC: [BOS/CHoCH at price]
- 30M: [bias] — RSI [value], CVD [direction], last SMC: [BOS/CHoCH at price]

### Key Levels
- Nearest supply: $XX,XXX – $XX,XXX ([TF] origin)
- Nearest demand: $XX,XXX – $XX,XXX ([TF] origin)
- VWAP: $XX,XXX
- CVD divergence: YES/NO

### Setup
[Setup A/B/C or NO SETUP — see smc-setups.md]

### Trade Plan (if setup found)
- Entry: $XX,XXX
- Stop: $XX,XXX
- TP1: $XX,XXX (1:1)
- TP2: $XX,XXX (1:2)
- TP3: $XX,XXX (1:3)
- Trigger: [exact condition]
- Probability: XX%
```
