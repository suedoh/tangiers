# Setup Guide

## Prerequisites

### Software

| Requirement | Notes |
|---|---|
| **TradingView Desktop** | Mac or Windows app. Must be running with CDP enabled (see below). |
| **Node.js v18+** | Tested on v22. Used by all scripts. |
| **Claude Desktop** (optional) | For manual analysis sessions only — not required for automated pipeline. |

### TradingView Desktop — CDP

TradingView Desktop must be launched with Chrome DevTools Protocol (CDP) enabled on port 9222. This is how the scripts connect to the chart.

**On macOS, CDP is enabled automatically when the TradingView MCP server is running** (i.e., when Claude Desktop is active). If you are not using Claude Desktop, launch TradingView manually:

```bash
open -a "TradingView" --args --remote-debugging-port=9222
```

> To make this automatic on login: add the above command to a login item or startup script. The system will post a Discord error if TradingView is unreachable, so you will know if it's not running.

### Discord channels required

| Channel | Purpose | `.env` key |
|---|---|---|
| `#btc-signals` | Live trade alerts, invalidations, reclaims | `DISCORD_WEBHOOK_URL` |
| `#btc-backtest` | Monday performance reports | `DISCORD_BTC_BACKTEST_WEBHOOK_URL` |
| `#btc-weekly-war-report` | Sunday institutional preview | `DISCORD_BTC_WEEKLY_WAR_REPORT` |

For `!analyze`, `!trades`, and emoji reactions, a **Bot Token** is also required:

| Purpose | `.env` key |
|---|---|
| Discord bot (read messages + post replies) | `DISCORD_BOT_TOKEN` |
| Channel to watch for commands | `DISCORD_CHANNEL_ID` |

---

## Step 1 — Clone and install dependencies

`tradingview-mcp` is a git submodule. Use `--recurse-submodules` when cloning:

```bash
git clone --recurse-submodules https://github.com/YOUR_USERNAME/trading.git
cd trading
make deps
```

If you already cloned without the flag:

```bash
git submodule update --init
make deps
```

---

## Step 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` with all required values:

```bash
# Discord webhooks (create in: Server Settings → Integrations → Webhooks)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
DISCORD_BTC_BACKTEST_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
DISCORD_BTC_WEEKLY_WAR_REPORT=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN

# Discord bot (for !analyze, !trades, emoji reactions)
# Create at: discord.com/developers/applications → New Application → Bot → Reset Token
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CHANNEL_ID=your_btc_signals_channel_id
```

To get your channel ID: right-click `#btc-signals` in Discord → **Copy Channel ID** (requires Developer Mode enabled in Discord settings).

For the bot token: the bot needs **Read Messages** and **Send Messages** permissions. No slash commands, no privileged intents required.

---

## Step 3 — Set up the TradingView Ace layout

Open TradingView Desktop and configure:

- **Symbol:** `BINANCE:BTCUSDT.P` (Binance perpetual futures — not spot, not BloFin)
- **Timeframe:** 30M (default)
- **Layout name:** `🕵Ace`

Add these indicators (in this order):

| Indicator | Where to find |
|---|---|
| Visible Range Volume Profile | Built-in — search "Visible Range Volume Profile" |
| Session Volume Profile | Built-in — search "Session Volume Profile" |
| Volume | Built-in |
| Volume Weighted Average Price | Built-in — search "VWAP" |
| Cumulative Volume Delta | Built-in — search "Cumulative Volume Delta" |
| Open Interest | Built-in — search "Open Interest" (use Binance data) |

> **Note on LuxAlgo SMC:** The automated pipeline no longer uses LuxAlgo supply/demand zones. VRVP levels (HVN, POC, VAH, VAL) are the primary zone source. LuxAlgo is still useful on the chart for manual structure reading, but is not required for the automated pipeline to function.

> **Important:** Open Interest only works correctly on `BINANCE:BTCUSDT.P`. Do not use BloFin or spot charts for this layout.

Save the layout as `🕵Ace`. The script verifies symbol on every run and posts a Discord error if the wrong symbol is active.

---

## Step 4 — Install the TradingView MCP server (Claude Desktop only)

Skip this step if you are not using Claude Desktop for manual analysis.

```bash
claude mcp add tradingview -s user -- node /Users/yourname/trading/tradingview-mcp/src/server.js
```

Verify:

```bash
claude mcp list
```

---

## Step 5 — Install cron jobs

```bash
make cron
```

This installs four scheduled jobs. See the cron schedule in [README.md](../README.md#cron-schedule) for exact entries.

To verify:

```bash
crontab -l
```

---

## Step 6 — Test

Test the Discord webhook:

```bash
bash scripts/discord-notify.sh info "Ace system online — test message"
```

Test the full pipeline:

```bash
node scripts/trigger-check.js
```

Test the Discord bot (requires `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` in `.env`):

```bash
node scripts/discord-bot.js
# then type !analyze in #btc-signals
```

Monitor logs:

```bash
tail -f logs/trigger-check.log
tail -f logs/discord-bot.log
```

---

## Troubleshooting

### "Cannot reach TradingView Desktop (CDP port 9222 not responding)"

TradingView is not running or CDP is not enabled.

**Fix:** Open TradingView Desktop. If already open, restart it. If running without Claude Desktop, ensure you launched with `--remote-debugging-port=9222`.

### "No TradingView chart page found in CDP targets"

TradingView is open but no chart is loaded.

**Fix:** Open a chart in TradingView Desktop. Confirm the `🕵Ace` layout is active.

### "Wrong chart symbol: got X, expected BINANCE:BTCUSDT.P"

**Fix:** Load the `🕵Ace` layout. Confirm the symbol reads `BINANCE:BTCUSDT.P` in the top-left.

### "Could not read price data"

TradingView is loading or the chart has not finished rendering.

**Fix:** Wait for the chart to fully load (all indicators showing data), then the next cron run will succeed. The mtf-analyze.js script has a 3-attempt retry with 1.5s delays.

### No alerts firing when price is near a level

1. **VRVP indicator is hidden** — the zone data comes from the Visible Range Volume Profile. If it is toggled off or outside the visible range, no levels are read.
2. **Cooldown active** — alerts suppress for 1 hour per zone. Check `.trigger-state.json` for cooldown timestamps. Delete the file to reset all cooldowns.
3. **Zone distance beyond buffer** — proximity formula is `max(price × 0.005, zone_width × 1.5)`. If price is further than ~0.5% from the nearest level edge, no trigger fires.

### "Cannot find module"

The scripts require `chrome-remote-interface` from `tradingview-mcp/node_modules`.

**Fix:**

```bash
cd tradingview-mcp && npm install
```

### OI trend shows "no trend yet"

On first run after setup (or after `.trigger-state.json` is deleted), there is no previous OI value to compare. Populates automatically after the second cron run.

### VWAP shows null in logs

The VWAP indicator is not on the chart or has been renamed. Confirm it is visible on the `🕵Ace` layout. The script looks for a study named "Volume Weighted Average Price".
