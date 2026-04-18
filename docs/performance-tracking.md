# Performance Tracking & Backtesting

See also: `BACKTESTING.md` — the primary reference for the full trade lifecycle, confirmation mechanics, and Phase activation instructions.

---

## How a Trade Moves Through the System

```
SIGNAL FIRED → UNCONFIRMED → CONFIRMED → CLOSED → REPORTED
```

### 1. Signal Fired

`trigger-check.js` detects price within proximity of a VRVP level with order flow criteria met. It posts a Discord alert and writes an entry to `trades.json` with:

- Entry price, stop, TP1/TP2/TP3, all R:R ratios
- All setup criteria at signal time (snapshot of CVD, OI, VWAP, MACD, RSI, Session VP)
- `confirmed: false`, `outcome: null`

### 2. Unconfirmed → Confirmed

Every 10-minute poll, `checkConfirmation()` fetches the last 48h of 30M bars and checks:

```
Long:  Has any 30M bar CLOSED above entry price, AND is CVD currently positive?
Short: Has any 30M bar CLOSED below entry price, AND is CVD currently negative?
```

If yes, the trade is stamped:
```json
"confirmed": true,
"confirmedAt": "2026-04-15T14:30:00.000Z",
"confirmedPrice": 84150
```

**An unconfirmed trade means the level was approached but price never convincingly entered with order flow.** These setups existed but the entry condition was never triggered. Their win rate is tracked separately and is expected to be lower.

### 3. Confirmed → Closed (Bar-Accurate)

Every 10-minute poll, `updateOutcomes()` fetches the last 336 30M bars (7 days) and walks bar-by-bar from the signal's `firedAt` timestamp:

```
For each 30M bar after the signal:

  LONG trade:
    if bar.low  <= stop  AND bar.high < tp1  → LOSS  (stop hit, no TP reached)
    if bar.high >= tp3                        → WIN at TP3
    if bar.high >= tp2                        → WIN at TP2
    if bar.high >= tp1                        → WIN at TP1
    if bar.low  <= stop  AND bar.high >= tp1  → LOSS  (same-bar ambiguity: stop wins, conservative)

  SHORT trade: mirror logic
```

When an outcome is found:
```json
"outcome": "tp2",
"pnlR": 3.6,
"closedAt": "2026-04-15T16:00:00.000Z"
```

**Why bar-accurate matters:** Checking spot price every 10 minutes misses wicks and gets the intrabar order wrong (stop vs TP on the same candle). Bar-accurate detection uses actual OHLCV data so a wick that touched TP1 at 14:32 and returned before the next poll is correctly detected.

**Expiry:** Trades open for 30+ days with no outcome are marked `expired` and excluded from all stats.

### 4. Closed → Reported

Every Monday at 09:00 UTC, `weekly-report.js` reads `trades.json` and posts a three-track report to `#btc-backtest`.

---

## The Three-Track Report

| Track | What it means |
|---|---|
| **All signals** | Every signal that fired and closed, confirmed or not |
| **Confirmed only** ← _the real number_ | Only trades where the 30M entry trigger actually fired |
| **Unconfirmed** | Signal fired, entry trigger never met — price backed away |

**The confirmed win rate is the strategy's true win rate.** If it is materially higher than the all-signals rate, the confirmation bar is doing meaningful filtering work. If they are the same, the entry criteria need review.

---

## What the Weekly Report Shows

```
📊 WEEKLY PERFORMANCE REPORT | BINANCE:BTCUSDT.P
━━━━━━━━━━━━━━━━━━━━━━━━━━
Period  2026-04-06 → 2026-04-13 (7 days)

SIGNAL FUNNEL
Fired: 12 | Confirmed: 8 (67%) | Closed: 9

ALL SIGNALS (closed only)
Wins: 6 | Losses: 3 | Win Rate: 67%
Total R: +7.40R | Avg R: +0.82R

CONFIRMED ONLY (real win rate)
Wins: 5 | Losses: 2 | Win Rate: 71%
Total R: +6.20R | Avg R: +0.89R

UNCONFIRMED
Wins: 1 | Losses: 1 | Win Rate: 50%
(entry trigger never fired on these)

BY DIRECTION
Longs:  4/6 wins (67%)
Shorts: 2/3 wins (67%)

BY LEVEL TYPE
HVN:  4/5 wins (80%) — 4 confirmed
VAL:  1/2 wins (50%) — 2 confirmed
POC:  1/2 wins (50%) — 2 confirmed

MOST PREDICTIVE CRITERIA (confirmed trades)
80% win rate when ✅ OI rising (5 samples)
75% win rate when ✅ CVD aligned (4 samples)
75% win rate when ✅ 4H MACD aligned (4 samples)

TIME TO OUTCOME
Avg win: 6.2h | Avg loss: 18.4h

STREAK  Current: 3 wins ✅

YOUR EXECUTION (Phase 2 not yet active)
━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Phase Status

### Phase 1 — System Track (Bar-Accurate) ✅ COMPLETE

Bar-accurate outcome detection is live. Confirmation tracking is live. Weekly report with three tracks is live.

**Validate after 2 weeks:**
- `!trades` consistently shows 10+ entries with `outcome` populated on closed trades
- `confirmed: true` on 50–75% of entries
- `confirmedAt` is hours after `firedAt` (not seconds)

### Phase 2 — Your Execution Track 🔲 NOT YET ACTIVE

`!took` and `!exit` commands are implemented but behind early-return guards. Activate when Phase 1 has 10+ confirmed closed trades.

**To activate:**
1. In `scripts/discord-bot.js`: find `handleTook()` — remove the "Phase 2 not yet active" early-return block
2. Do the same in `handleExit()`
3. In `scripts/weekly-report.js`: find the `// ── Phase 2 stub ──` comment and uncomment the `myTrack` lines
4. Replace the `executionLines` stub in `formatReport()` with real `myTrack` data

### Phase 3 — Per-Bar CVD Confirmation ❌ NOT BUILT

Currently `checkConfirmation()` checks CVD from the current poll's indicators, not from the specific bar when the 30M close happened. This is directionally correct ~85% of the time.

**To implement:**
1. In `trigger-check.js` `main()`: append `{ ts: Date.now(), cvd: indicators.cvd }` to `state._cvdHistory` (cap at 200 entries)
2. In `checkConfirmation()`: for each confirmation bar, find the closest `_cvdHistory` entry by timestamp and use that CVD reading

---

## Checking Trades Without Discord

```bash
# All open trades
cat trades.json | python3 -c "
import sys, json
trades = [t for t in json.load(sys.stdin) if t['outcome'] is None]
for t in trades:
    print(t['direction'], t['zone']['type'], t['firedAt'][:10],
          'confirmed:', t['confirmed'], 'outcome:', t['outcome'])
"

# Run the report manually (posts to Discord + stdout)
node scripts/weekly-report.js

# Custom lookback
node scripts/weekly-report.js --days 30
```

---

## trades.json Schema

```json
{
  "id": "2026-04-15T14:20:00.000Z-LONG",
  "direction": "LONG",
  "firedAt": "2026-04-15T14:20:00.000Z",
  "zone": {
    "type": "HVN",
    "low": 83900,
    "high": 84350
  },
  "entry": 84100,
  "stop": 83650,
  "tp1": 85200,
  "tp2": 86800,
  "tp3": 88400,
  "rr1": 2.3,
  "rr2": 5.8,
  "rr3": 9.4,
  "indicators": {
    "cvd": 41,
    "oi": 18450000,
    "oiTrend": "rising",
    "vwap": 83900,
    "macd4h": 18,
    "rsi12h": 44,
    "sessionVpUp": 1.4,
    "sessionVpDown": 0.8
  },
  "criteria": {
    "cvdAligned": true,
    "oiRising": true,
    "aboveVwap": true,
    "macdAligned": true,
    "sessionVpAligned": true,
    "rsiAligned": false,
    "atValVah": false
  },
  "probability": 72,
  "confirmed": true,
  "confirmedAt": "2026-04-15T16:00:00.000Z",
  "confirmedPrice": 84150,
  "outcome": "tp2",
  "pnlR": 5.8,
  "closedAt": "2026-04-16T08:30:00.000Z"
}
```
