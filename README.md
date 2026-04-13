# Ace Trading System

An automated market monitoring and trade setup detection system for **BTC/USDT perpetual futures** on Binance. Built around Smart Money Concepts (SMC) technical analysis.

The system watches your TradingView chart every 30 minutes, detects when price approaches or enters a key supply/demand zone, evaluates a full set of trade criteria automatically, and fires a complete trade plan to Discord — entry, stop loss, three take-profit targets, R:R ratios, and a criteria checklist — with no manual work required.

---

## Table of Contents

1. [What This System Does](#1-what-this-system-does)
2. [How It Works — Architecture](#2-how-it-works--architecture)
3. [Prerequisites](#3-prerequisites)
4. [Initial Setup](#4-initial-setup)
5. [The TradingView Chart](#5-the-tradingview-chart)
6. [Trade Setups](#6-trade-setups)
7. [Discord Alerts](#7-discord-alerts)
8. [Deeper Analysis with Claude](#8-deeper-analysis-with-claude)
9. [Risk Management](#9-risk-management)
10. [File Structure](#10-file-structure)
11. [Crontab Schedule](#11-crontab-schedule)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. What This System Does

Every 30 minutes, the system automatically:

1. Connects to your live TradingView Desktop chart
2. Reads the current BTC price and all active supply/demand zones from the LuxAlgo SMC indicator
3. Reads seven indicators: CVD, OI, Session Volume Profile, VWAP, and more
4. Fetches 4H bars to compute MACD direction
5. Fetches 12H bars to compute RSI
6. Evaluates whether price is near or inside a zone using a proximity formula
7. If a zone is triggered, runs the full trade setup criteria check and calculates entry/stop/targets
8. Posts a complete trade plan to Discord, or stays silent if no setup is present

If TradingView is not running, the chart is on the wrong symbol, or any other error occurs, the system posts a specific error message to Discord with instructions on how to fix it.

**Zero AI usage in the automated pipeline.** All logic is rule-based. No API keys, no subscription costs, no token usage.

---

## 2. How It Works — Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  macOS crontab (every 30 minutes)                               │
│                                                                 │
│  node scripts/trigger-check.js                                  │
│         │                                                       │
│         │ Chrome DevTools Protocol (CDP) on port 9222          │
│         ▼                                                       │
│  TradingView Desktop (Electron app)                             │
│         │  reads: price, zones, CVD, OI, Session VP, VWAP      │
│         │  reads: 4H bars → MACD | 12H bars → RSI              │
│         │                                                       │
│         │ if zone triggered                                     │
│         ▼                                                       │
│  Rule-based setup evaluation                                    │
│         │  entry / stop / TP1 / TP2 / TP3                      │
│         │  criteria checklist (✅ ❌ ⚠️)                        │
│         │  setup type + win rate                                │
│         │                                                       │
│         ▼                                                       │
│  scripts/discord-notify.sh → Discord webhook                    │
└─────────────────────────────────────────────────────────────────┘
```

### Key design decisions

**Why no Claude/AI in the automated pipeline?**
Using Claude for every 30-minute poll would consume thousands of tokens per day. All setup logic is codified as deterministic rules. Claude is reserved for on-demand deeper analysis when a signal fires and you want a qualitative read.

**Why TradingView Desktop instead of an API?**
The indicators used (LuxAlgo SMC, Session Volume Profile, Cumulative Volume Delta, Open Interest) either don't exist in standard market data APIs or require expensive data subscriptions. TradingView Desktop already has everything running — the system reads directly from it via the Chrome DevTools Protocol (CDP), the same protocol browser developer tools use.

**Why CDP instead of the TradingView MCP server?**
The TradingView MCP server (used by Claude Desktop for manual analysis) runs as a Model Context Protocol server — it requires Claude to orchestrate it. For automated cron jobs with no Claude involvement, `trigger-check.js` calls CDP directly using `chrome-remote-interface`.

**What is the TradingView MCP server used for then?**
Manual analysis sessions in Claude Desktop. When a Discord alert fires and you want a deeper read, you paste the provided prompt into Claude Desktop. Claude uses the MCP server's 78 tools to read every indicator across all four timeframes, synthesize the picture, and give you a qualitative verdict.

---

## 3. Prerequisites

### Software

| Requirement | Notes |
|---|---|
| **TradingView Desktop** | Mac or Windows app. Must be running for the cron job to work. |
| **Node.js v18+** | Tested on v22. Used to run `trigger-check.js`. |
| **Claude Desktop** (optional) | Personal subscription. Used for on-demand deeper analysis only. |

### TradingView Desktop — CDP setup

TradingView Desktop must be launched with the Chrome DevTools Protocol enabled on port 9222. This is how the script connects to the chart.

On macOS, the TradingView MCP server handles this automatically when Claude Desktop is running. If you are not using Claude Desktop, you need to launch TradingView Desktop manually with:

```bash
open -a "TradingView" --args --remote-debugging-port=9222
```

Or add this flag permanently in the app's launch configuration.

### Discord webhook

You need a Discord server with a webhook URL. To create one:

1. Open your Discord server → **Settings** → **Integrations** → **Webhooks**
2. Click **New Webhook**, give it a name (e.g. "Ace"), assign it to a channel
3. Click **Copy Webhook URL**
4. Paste it into `.env` (see setup below)

---

## 4. Initial Setup

### Step 1 — Clone and install dependencies

`tradingview-mcp` is a git submodule. Use `--recurse-submodules` when cloning so it is fetched automatically:

```bash
git clone --recurse-submodules https://github.com/YOUR_USERNAME/trading.git
cd trading
make deps
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
make deps
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your Discord webhook URL:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
```

This file is gitignored and never committed.

### Step 3 — Install the TradingView MCP server (for Claude Desktop)

This step is only required if you want to use Claude Desktop for manual analysis sessions.

```bash
claude mcp add tradingview -s user -- node /Users/yourname/trading/tradingview-mcp/src/server.js
```

Verify it registered:

```bash
claude mcp list
```

### Step 4 — Set up the TradingView Ace layout

Open TradingView Desktop and configure a chart with the following settings:

- **Symbol:** `BINANCE:BTCUSDT.P` (Binance perpetual futures — not spot, not BloFin)
- **Timeframe:** 30M (default)
- **Layout name:** `🕵Ace`

Add these indicators (in this order):

| Indicator | Where to find |
|---|---|
| Smart Money Concepts [LuxAlgo] | Search "LuxAlgo" — requires LuxAlgo subscription |
| Visible Range Volume Profile | Built-in TradingView indicator |
| Session Volume Profile | Built-in TradingView indicator |
| Volume | Built-in TradingView indicator |
| Volume Weighted Average Price | Built-in TradingView indicator (search "VWAP") |
| Cumulative Volume Delta | Built-in TradingView indicator |
| Open Interest | Built-in TradingView indicator (search "Open Interest" — Binance data) |

Save the layout as `🕵Ace`. The script verifies it is reading `BINANCE:BTCUSDT.P` and will send an error alert if the wrong symbol is active.

> **Important:** Open Interest only works correctly on Binance perpetual futures (`BINANCE:BTCUSDT.P`). Do not use BloFin or spot charts for this layout.

### Step 5 — Set up the cron job

The script must run every 30 minutes. Because cron has a minimal PATH environment, the full path to Node must be specified.

Find your Node path:

```bash
which node
# e.g. /Users/yourname/.nvm/versions/node/v22.22.0/bin/node
```

Open your crontab:

```bash
crontab -e
```

Add this line (replace paths to match your system):

```
*/30 * * * * PATH=/Users/yourname/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin /Users/yourname/.nvm/versions/node/v22.22.0/bin/node /Users/yourname/trading/scripts/trigger-check.js >> /Users/yourname/trading/logs/trigger-check.log 2>&1
```

The `logs/` directory is created automatically on first run.

### Step 6 — Test

Test the Discord webhook in isolation:

```bash
bash scripts/discord-notify.sh info "Ace system online — test message"
```

Test the full pipeline:

```bash
node scripts/trigger-check.js
```

Check the log:

```bash
tail -f logs/trigger-check.log
```

---

## 5. The TradingView Chart

### Indicator roles

| Indicator | What it tells you |
|---|---|
| **Smart Money Concepts [LuxAlgo]** | Draws supply/demand zones, BOS (Break of Structure), and CHoCH (Change of Character) — the core structure of the strategy |
| **Visible Range Volume Profile** | Shows where volume has traded across the visible range. HVN = support/resistance, LVN = fast-move zones |
| **Session Volume Profile** | Up/Down volume ratio for the current session. Skew toward Down = bearish institutional activity |
| **Volume** | Raw confirmation. High volume on a zone reaction = real interest |
| **VWAP** | The institutional price benchmark. Price above VWAP = bullish bias; below = bearish |
| **Cumulative Volume Delta** | Running total of buy vs sell volume. Divergence from price = institutional accumulation/distribution |
| **Open Interest** | Number of open futures contracts. Rising OI with price = conviction; falling OI = liquidation move |

### Timeframe hierarchy

The system reads four timeframes for manual analysis. Higher timeframes set the bias; lower timeframes set the entry.

| Timeframe | Role |
|---|---|
| **12H** | Macro bias — is the market broadly bullish or bearish? |
| **4H** | Trend confirmation — structure, MACD, active supply/demand |
| **1H** | Entry context — which specific zone is in play |
| **30M** | Trigger — the CHoCH that confirms the setup |

### Zone proximity formula

The trigger fires when price is close enough to a zone to matter:

```
buffer = max(price × 0.005, zone_width × 1.5)
trigger = price_inside_zone OR distance_to_zone_edge <= buffer
```

This scales the buffer with price (0.5% of $70,000 = $350) and with zone size (wide zones get a wider buffer). Small zones near price and large zones further away can both trigger.

---

## 6. Trade Setups

Three setups are defined, each with distinct criteria. The system identifies which setup type applies and includes the historical win rate in every alert.

### Setup A — Trend Continuation (~62% win rate, min 1:2 R:R)

The highest-frequency setup. Market is in a clear trend on 4H+. Looking to enter on a pullback into a zone.

**Required (all must be true):**
- 4H structure shows a BOS in the trend direction
- 4H MACD histogram in the trend direction
- 12H RSI above 50 (long) or below 50 (short)
- Price pulling back into a demand zone (long) or supply zone (short)
- CVD not diverging against the trade
- OI rising — new positions being opened, not a squeeze
- VWAP aligned with trade direction

**Entry trigger:** 30M CHoCH in the trend direction after touching the zone

**Stop:** Beyond the zone edge + 0.2% buffer

---

### Setup B — Reversal at Major Level (~52% win rate, min 1:3 R:R)

Lower frequency. Price reaches a significant HTF zone with exhaustion signals. Lower win rate requires a larger R:R to be net positive.

**Required (all must be true):**
- Price at a 4H or 12H supply/demand zone
- CVD divergence present (price making new high/low but CVD is not confirming)
- OI falling as price extends (liquidation, not real move)
- Session VP opposing the move
- RSI overextended on 1H (>70 short, <30 long) or RSI divergence
- Price significantly extended from VWAP (>1.5%)
- Equal highs or lows (EQH/EQL) visible just beyond price

**Entry trigger:** 30M CHoCH in the reversal direction after a sweep of the EQH/EQL

**Stop:** Beyond the sweep wick extreme + 0.3% buffer

---

### Setup C — Liquidity Grab (~70% win rate, min 1:2 R:R)

The rarest and highest-probability setup. Price sweeps a pool of equal highs/lows and immediately reverses.

**Required (all must be true):**
- EQH or EQL visible on 1H or 30M via LuxAlgo labels
- Price wicks through the EQH/EQL level
- The sweep candle closes back through the level (wick rejected, not consolidated)
- OI spikes during the sweep then drops (stop-hunt confirmed)
- CVD turns sharply in the reversal direction
- Volume on sweep candle is >2x the 10-candle average

**Entry trigger:** Close of the sweep candle or next candle open — no CHoCH wait needed

**Stop:** Beyond the tip of the sweep wick + 0.2% buffer

---

### No-trade conditions

Do not take any setup when:
- 12H and 4H bias contradict each other
- CVD is flat on 4H (no institutional conviction)
- Extreme funding rate in your trade direction (>0.1% per 8h — already over-leveraged)
- Less than 2 hours before a major macro event (FOMC, CPI, etc.)

---

## 7. Discord Alerts

Five alert types, each with a distinct color:

| Type | Color | When it fires |
|---|---|---|
| 🟢 **Long** | Green | Confirmed long setup with full trade plan |
| 🔴 **Short** | Red | Confirmed short setup with full trade plan |
| ⚠️ **Approaching** | Yellow | Price nearing a zone — reserved for future use |
| 📊 **Info** | Blue | General status, no setup |
| ❌ **Error** | Dark red | System error with specific fix instructions |

### What a trade alert contains

```
🟢 LONG SIGNAL | BINANCE:BTCUSDT.P
━━━━━━━━━━━━━━━━━━━━━━━━━━
Price $70,775 | Inside Zone $70,470–$70,823
Setup A — Trend Continuation | Win Rate ~62%

ENTRY  $70,717
STOP   $70,329
TP1    $71,580 — 1:2.2
TP2    $73,400 — 1:6.9
TP3    $71,881 — 1:3.0

TRIGGER  Wait for 30M CHoCH above current price

CRITERIA (5/6 auto-confirmed)
✅ Price inside zone
✅ CVD +13 (bullish)
❌ Session VP 1.26↑ / 923↓ (bearish)
✅ VWAP $71,394 — price is below
✅ OI rising — conviction
✅ 4H MACD bullish (hist +31)
❌ 12H RSI 41 (below 50)

INVALIDATION  4H close below $70,329

SET ALERTS  $70,823 (zone edge) | $70,329 (stop) | $71,580 (TP1)
━━━━━━━━━━━━━━━━━━━━━━━━━━
`Ace signal fired: LONG at $70,775, Inside zone $70,470–$70,823. Run full MTF analysis and give me your read on whether to take this trade.`
```

The last line (in a code block) is a ready-to-paste prompt for Claude Desktop. See section 8.

### Criteria icons

- ✅ Auto-confirmed — criterion passes for the setup direction
- ❌ Auto-failed — criterion contradicts the setup direction
- ⚠️ Manual check required — data unavailable or requires human judgment

### Zone cooldown

Once an alert fires for a zone, that zone is suppressed for **2 hours** to prevent repeat notifications. The cooldown state is stored in `.trigger-state.json`.

### Error alerts

If something goes wrong, you receive a specific Discord error message:

```
❌ ERROR — Ace Trigger Check
What: Cannot reach TradingView Desktop (CDP port 9222 not responding)
Where: CDP connection attempt
Fix: Open TradingView Desktop. If already open, restart it.
```

Common errors and their fixes are covered in the [Troubleshooting](#12-troubleshooting) section.

---

## 8. Deeper Analysis with Claude

The automated system provides a complete trade plan, but it uses only the rules that can be evaluated programmatically. For qualitative judgment — "does the structure really look right here?", "is this CVD divergence meaningful or noise?", "what does the overall picture say?" — Claude Desktop can run a full multi-timeframe analysis using the TradingView MCP server.

### How to use it

When a Discord alert fires, the last line of every alert is a ready-to-paste prompt:

```
`Ace signal fired: LONG at $70,775, Inside zone $70,470–$70,823. Run full MTF analysis and give me your read on whether to take this trade.`
```

Copy that line and paste it into Claude Desktop. Claude will:

1. Switch your TradingView chart to the `🕵Ace` layout
2. Cycle through 12H → 4H → 1H → 30M
3. At each timeframe: read all indicator values, read LuxAlgo zones/labels/BOS/CHoCH signals, take a screenshot
4. Synthesize the full picture across all four timeframes
5. Evaluate against the setup criteria in `strategies/smc-setups.md`
6. Give you a qualitative verdict: take it, skip it, or wait for a better entry

This is useful for learning — Claude explains *why* a criterion passes or fails, building your intuition for reading the chart yourself.

### Requirements for Claude analysis

- Claude Desktop must be installed with your personal subscription
- The TradingView MCP server must be registered (`claude mcp list` should show `tradingview`)
- TradingView Desktop must be open on the `🕵Ace` layout

---

## 9. Risk Management

### Position sizing

```
Position Size = (Account Balance × 1%) / (Entry Price − Stop Price)
```

Example: $10,000 account, entry $71,500, stop $70,500
→ Risk = $100, distance = $1,000 → Position = 0.1 BTC

### Core rules

- **Max 1% risk per trade** — never more
- **Max 2% at risk simultaneously** — no more than 2 open trades
- **Never move stop to breakeven before TP1 is hit**
- **Never add to a losing position**

### Partial exit strategy

| Level | Action |
|---|---|
| **TP1 (1:1)** | Close 40% of position, move stop to breakeven |
| **TP2 (1:2)** | Close another 40% |
| **TP3 (1:3+)** | Close remaining 20% |

Once TP1 is hit and stop is at breakeven, the trade is risk-free. Let the remainder run.

### R:R minimums by setup

| Setup | Minimum R:R | Why |
|---|---|---|
| A — Trend Continuation | 1:2 | Higher frequency needs good R:R to be net positive |
| B — Reversal | 1:3 | Lower win rate (~52%) requires larger winners |
| C — Liquidity Grab | 1:2 | High win rate (~70%) makes 1:2 very profitable |

### Daily loss limit

Stop trading for the day if account is down 2%. Come back fresh next session.

> A Discord alert is a signal to evaluate, not a signal to enter. Always confirm the trigger yourself before placing a trade.

---

## 10. File Structure

```
/trading/
├── README.md                        ← this file
├── CLAUDE.md                        ← instructions loaded in every Claude session
├── .env                             ← DISCORD_WEBHOOK_URL (gitignored, never commit)
├── .env.example                     ← template for .env
├── .gitignore
├── .trigger-state.json              ← cooldown state + OI trend tracking (gitignored, auto-created)
│
├── scripts/
│   ├── trigger-check.js             ← main cron script: zone check + full trade plan
│   └── discord-notify.sh            ← Discord webhook poster (5 alert types)
│
├── strategies/
│   ├── smc-setups.md                ← full criteria for all three setups
│   ├── mtf-analysis.md              ← manual multi-timeframe analysis protocol for Claude
│   └── risk-management.md          ← position sizing and R:R rules
│
├── analysis/                        ← timestamped analysis outputs from Claude sessions (gitignored)
├── logs/                            ← trigger-check.log (gitignored, auto-created)
│
└── tradingview-mcp/                 ← TradingView MCP server (Claude Desktop integration)
    ├── src/server.js                ← MCP server entrypoint
    └── node_modules/                ← includes chrome-remote-interface used by trigger-check.js
```

### Key files explained

**`scripts/trigger-check.js`**
The core of the system. Runs every 30 minutes via cron. Connects to TradingView via CDP, reads all indicator data, switches to 4H/12H to compute MACD and RSI, evaluates setup criteria, and posts to Discord. Has no dependency on Claude or any external AI service.

**`scripts/discord-notify.sh`**
Thin wrapper around a Discord webhook HTTP POST. Takes a type (`long`, `short`, `info`, `approaching`, `error`) and a message. Called by `trigger-check.js`.

**`strategies/mtf-analysis.md`**
The protocol Claude follows during manual analysis sessions. Defines exactly which tools to call at each timeframe, what to look for, and how to synthesize into a verdict.

**`strategies/smc-setups.md`**
The rulebook. Defines all criteria for Setup A, B, and C including entry triggers, stop placement, targets, and invalidation conditions.

**`.trigger-state.json`**
Auto-created. Stores two things: per-zone cooldown timestamps (prevents alert spam) and the previous OI reading (used to determine if OI is rising or falling).

---

## 11. Crontab Schedule

The script runs every 30 minutes. The current crontab entry:

```
*/30 * * * * PATH=/Users/vpm/.nvm/versions/node/v22.22.0/bin:/Users/vpm/.local/bin:/usr/local/bin:/usr/bin:/bin /Users/vpm/.nvm/versions/node/v22.22.0/bin/node /Users/vpm/trading/scripts/trigger-check.js >> /Users/vpm/trading/logs/trigger-check.log 2>&1
```

The PATH is set explicitly because cron runs with a minimal environment and cannot find `node` otherwise.

To view your crontab: `crontab -l`
To edit: `crontab -e`

### What happens each run

| Scenario | Duration | Output |
|---|---|---|
| No zone trigger | ~100ms | Silent (logged only) |
| Zone trigger fires | ~5 seconds | Discord alert (fetches 4H + 12H bars) |
| TradingView not running | ~2 seconds | Discord error alert |
| Wrong symbol on chart | ~1 second | Discord error alert |

---

## 12. Troubleshooting

### Error: "Cannot reach TradingView Desktop (CDP port 9222 not responding)"

TradingView is not running or CDP is not enabled.

**Fix:** Open TradingView Desktop. If it is already open, restart it. On macOS, CDP is enabled automatically when the TradingView MCP server is running (i.e. when Claude Desktop is open). If you are running the cron job without Claude Desktop, launch TradingView manually with `--remote-debugging-port=9222`.

---

### Error: "No TradingView chart page found in CDP targets"

TradingView is open but no chart is loaded.

**Fix:** Open a chart in TradingView Desktop. Make sure the `🕵Ace` layout is active.

---

### Error: "Wrong chart symbol: got X, expected BINANCE:BTCUSDT.P"

The chart is open but not on the right symbol or layout.

**Fix:** In TradingView Desktop, load the `🕵Ace` layout. Confirm the symbol in the top-left reads `BINANCE:BTCUSDT.P`.

---

### Error: "Could not read price data"

TradingView is loading or the chart has not finished rendering.

**Fix:** Wait for the chart to fully load (all indicators showing data), then the next cron run will succeed.

---

### No alerts firing when price should be near a zone

Possible causes:

1. **LuxAlgo SMC indicator is hidden** — the zone data comes from LuxAlgo's box drawings. If the indicator pane is hidden or the indicator is toggled off, no zones are read. Make sure it is visible.
2. **Cooldown active** — if an alert fired for this zone in the last 2 hours, it is suppressed. Check `.trigger-state.json` to see cooldown timestamps. Delete the file to reset all cooldowns.
3. **Zone distance beyond buffer** — the proximity formula is `max(price × 0.005, zone_width × 1.5)`. If price is further than ~0.5% from the nearest zone edge, no trigger fires.

---

### VWAP shows null in logs

If `VWAP: null` appears in the log, the VWAP indicator is either not on the chart or has been renamed. Confirm the indicator is visible on the `🕵Ace` layout. The script looks for a study named "Volume Weighted Average Price".

---

### OI trend shows "no trend yet"

On the first run after setup (or after `.trigger-state.json` is deleted), there is no previous OI value to compare. The OI trend criterion will show as unavailable. It populates automatically after the second cron run.

---

### Script fails with "Cannot find module"

The script requires `chrome-remote-interface` from the `tradingview-mcp/node_modules` directory. If that directory is missing, run:

```bash
cd tradingview-mcp && npm install
```

---

### Testing without waiting for cron

Run the script manually at any time:

```bash
node /Users/vpm/trading/scripts/trigger-check.js
```

Test just the Discord webhook:

```bash
bash scripts/discord-notify.sh info "Test message"
bash scripts/discord-notify.sh long "Test long alert"
bash scripts/discord-notify.sh error "Test error alert"
```

Monitor the log in real time:

```bash
tail -f logs/trigger-check.log
```
