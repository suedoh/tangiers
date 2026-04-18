# Discord Notifications

## Channels

| Channel | What posts here |
|---|---|
| `#btc-signals` | All real-time alerts: signals, invalidations, reclaims, errors |
| `#btc-backtest` | Monday weekly performance report |
| `#btc-weekly-war-report` | Sunday institutional weekly preview |

---

## Alert Types — `#btc-signals`

### 🟢 Long Signal

Fires when price enters proximity of a VRVP level and all criteria confirm a long setup.

```
🟢 LONG SIGNAL | BINANCE:BTCUSDT.P
━━━━━━━━━━━━━━━━━━━━━━━━━━
Price $84,200 | Near HVN $83,900–$84,350

ENTRY  $84,100
STOP   $83,650
TP1    $85,200  — 1:2.3
TP2    $86,800  — 1:5.8
TP3    $88,400  — 1:9.4

TRIGGER  Wait for 30M close above $84,100

CRITERIA (5/7)
✅ CVD +41 (bullish)
✅ OI rising — conviction
✅ Price above VWAP $83,900
✅ 4H MACD bullish (hist +18)
✅ Session VP Up/Down 1.4/0.8 (bullish)
❌ 12H RSI 44 (below 50)
❌ Price at VAL/VAH (HVN only — lower structural weight)

PROBABILITY  72%   EV at TP2: +2.8R
VRVP  price is above POC — bullish structural position

INVALIDATION  30M close below $83,650
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 React with this emoji for instant MTF analysis
```

**Cooldown:** 1 hour per zone after firing to prevent repeat alerts.

---

### 🔴 Short Signal

Mirror of Long Signal with reversed criteria.

---

### 🚫 Level Broken

Fires when a previously alerted zone is mitigated with CVD and OI confirming a real break (not a stop hunt).

```
🚫 LEVEL BROKEN | BINANCE:BTCUSDT.P
━━━━━━━━━━━━━━━━━━━━━━━━━━
Price $83,400 broke below HVN $83,900–$84,350

ORDER FLOW  Bearish — real break confirmed
CVD  −28 (negative, confirming sellers)
OI   Rising (new shorts entering)

THESIS  Long thesis from earlier signal is INVALIDATED
ACTION  If long: stop should have triggered. Do not re-enter.

Next support: VAL $82,100 | POC $81,800
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 React with this emoji for instant MTF analysis
```

---

### ⚠️ Stop Hunt Alert

Fires when a zone is breached but CVD/OI indicate a stop hunt rather than a real break. Price is expected to reclaim the zone — a reclaim watch is started.

```
⚠️ STOP HUNT | BINANCE:BTCUSDT.P
━━━━━━━━━━━━━━━━━━━━━━━━━━
Price briefly broke HVN $83,900–$84,350 then reversed

ORDER FLOW  Ambiguous / bullish on reversal
CVD  Turned positive on the reversal candle
OI   Dropped during the breach (stop liquidations, not new shorts)

VERDICT  Probable stop hunt — watching for reclaim

WATCHING  If price closes back above $83,900 with CVD rising,
          reclaim alert will fire
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 React with this emoji for instant MTF analysis
```

---

### 🔄 Zone Reclaimed

Fires when a stop-hunt zone is reclaimed — price closes back through the level with order flow confirmation. The original long/short thesis is back on.

```
🔄 ZONE RECLAIMED | BINANCE:BTCUSDT.P
━━━━━━━━━━━━━━━━━━━━━━━━━━
Price reclaimed HVN $83,900–$84,350

ORDER FLOW  Bullish confirmation
CVD  +35 and rising
OI   Rising (new longs entering above reclaimed level)

VERDICT  Stop hunt confirmed + reclaim — original bullish thesis restored

ENTRY CONSIDERATION
Re-entry near $84,100 with stop below $83,650
Original TP levels still valid
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 React with this emoji for instant MTF analysis
```

---

### 📊 Info

General status message — no trade setup, no error. Used for system status, manual test messages, and `!analyze` output.

---

### ❌ Error

System error with specific instructions to fix it. Posted when the cron job cannot connect to TradingView or reads unexpected data.

```
❌ ERROR — Ace Trigger Check
━━━━━━━━━━━━━━━━━━━━━━━━━━
What:  Cannot reach TradingView Desktop (CDP port 9222 not responding)
Where: CDP connection attempt
Fix:   Open TradingView Desktop. If already open, restart it.
       If running without Claude Desktop, launch with:
       open -a "TradingView" --args --remote-debugging-port=9222
━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Criteria Icons

| Icon | Meaning |
|---|---|
| ✅ | Auto-confirmed — criterion passes for the setup direction |
| ❌ | Auto-failed — criterion contradicts the setup direction |
| ⚠️ | Manual check required — data unavailable or requires human judgment |

---

## Zone Cooldown

Once an alert fires for a zone, that zone is suppressed for **1 hour** to prevent repeat notifications. The cooldown state is stored in `.trigger-state.json`. Delete the file to reset all cooldowns.

---

## Pausing Notifications

Type `!stop` in `#btc-signals` to pause all notifications. Type `!start` to resume. See [docs/discord-commands.md](discord-commands.md) for details.

---

## Weekly Performance Report — `#btc-backtest`

Posts every Monday at 09:00 UTC. Three-track analysis: all signals, confirmed-only (the real win rate), unconfirmed.

See [docs/performance-tracking.md](performance-tracking.md) for full documentation of what the report shows.

---

## Weekly War Report — `#btc-weekly-war-report`

Posts every Sunday at 14:00 UTC (09:00 EST). Institutional weekly preview covering:

- Quarterly / monthly / weekly reference levels (OHLCV)
- VRVP key levels at macro timeframes
- Weekly candle structure and trend
- Bull and bear scenario plans
- High-impact macro events (ForexFactory)
- Deribit options expiry and max pain
- Binance funding rate
- Fear & Greed Index
- 6-factor bias score + directional verdict

All data sourced automatically. Zero manual input. Run manually with `make war-report`.
