# Trading Project — Claude Instructions

## Project Overview

Automated multi-timeframe technical analysis system for BTC/USDT perpetual futures.
Goal: identify high-probability trade setups and deliver actionable alerts to Discord.

## Chart Setup

- **Layout**: `🕵Ace` (saved in TradingView)
- **Symbol**: `BINANCE:BTCUSDT.P` (Binance perpetual futures)
- **Default timeframe**: 30m
- **MCP Server**: TradingView MCP running via CDP on port 9222

### Indicator Stack (Ace layout)

| Indicator | Purpose | What to read |
|---|---|---|
| Smart Money Concepts [LuxAlgo] | Market structure | BOS, CHoCH, supply/demand zones |
| Visible Range Volume Profile | Volume consensus | HVN (support/resistance), LVN (fast-move zones) |
| Session Volume Profile | Intraday bias | Up vs Down ratio — skew tells you who controls session |
| Volume | Raw activity | Confirmation of moves |
| VWAP | Institutional benchmark | Price above = bullish bias, below = bearish |
| Cumulative Volume Delta | Order flow | Divergence from price = institutional activity |
| Open Interest | Futures positioning | Rising OI with price = conviction; falling OI = liquidation |

## Analysis Workflow

See `strategies/mtf-analysis.md` for the full sequence.

**Quick reference — run in this order:**
1. `layout_switch` → `🕵Ace`
2. For each timeframe (12H → 4H → 1H → 30M):
   - `chart_set_timeframe`
   - `data_get_study_values` — all indicator readings
   - `data_get_pine_lines` with `study_filter: "LuxAlgo"` — key price levels
   - `data_get_pine_labels` with `study_filter: "LuxAlgo"` — BOS/CHoCH signals
   - `data_get_pine_boxes` with `study_filter: "LuxAlgo"` — supply/demand zones
   - `capture_screenshot`
3. Synthesize across timeframes
4. Evaluate against setup criteria in `strategies/smc-setups.md`
5. If setup found → call `scripts/discord-notify.sh`
6. Save output to `analysis/YYYY-MM-DD-BTCUSDT.md`

## Trade Setups

See `strategies/smc-setups.md` for full criteria. Three setups in priority order:

1. **Setup A — Trend Continuation** (highest frequency, ~62% win rate)
2. **Setup B — Reversal at Major Level** (lower frequency, higher R:R)
3. **Setup C — Liquidity Grab** (lowest frequency, highest probability when it occurs)

## Automated Pipeline (Zero Claude/AI)

`scripts/trigger-check.js` runs every 30 minutes via macOS crontab. It:
1. Connects to TradingView Desktop via CDP (port 9222, chrome-remote-interface)
2. Reads price, supply/demand zones (LuxAlgo boxes), CVD, OI, Session VP, VWAP
3. Checks zone proximity: `trigger = distance < max(price × 0.005, zone_width × 1.5)`
4. If triggered: evaluates setup criteria rule-based, calculates entry/SL/TP1/TP2/TP3
5. Posts full trade plan to Discord — no Claude API calls, zero subscription cost
6. Posts actionable error alerts to Discord if TradingView is closed or unreachable

**No `full-analysis.js`** — Stage 2 logic is embedded directly in `trigger-check.js`.
For deeper manual analysis, open Claude Desktop and run the MTF workflow in `strategies/mtf-analysis.md`.

### Trigger Proximity Formula
```
buffer = max(price × 0.005, zone_width × 1.5)
trigger = insideZone OR distance_to_zone_edge <= buffer
```

## Discord Alerts

Five alert types via `scripts/discord-notify.sh`:
- **⚠️ Approaching** (yellow) — price nearing zone, full setup evaluation in progress
- **🟢 Long** (green) — confirmed long setup with full trade plan
- **🔴 Short** (red) — confirmed short setup with full trade plan
- **📊 Info** (blue) — general status, no setup
- **❌ Error** (dark red) — system error with fix instructions

Webhook URL: stored in `.env` as `DISCORD_WEBHOOK_URL`

## Polling Schedule

- **Every 30 minutes** via macOS crontab (see `crontab -l`)
- TradingView Desktop must be open and on the `🕵Ace` layout for CDP to work
- 2-hour cooldown per zone to prevent repeat alerts

## File Structure

```
/Users/vpm/trading/
├── CLAUDE.md                        ← this file
├── .env                             ← DISCORD_WEBHOOK_URL (gitignored)
├── strategies/
│   ├── mtf-analysis.md              ← full MTF analysis protocol
│   ├── smc-setups.md                ← three setups with exact trigger criteria
│   └── risk-management.md          ← position sizing and R:R rules
├── analysis/
│   └── YYYY-MM-DD-BTCUSDT.md       ← timestamped analysis outputs
├── scripts/
│   ├── discord-notify.sh            ← Discord webhook poster (5 types)
│   └── trigger-check.js             ← 30m cron poller — zone check + full trade plan
└── tradingview-mcp/                 ← TradingView MCP server
```

## Key Notes

- Always switch to `🕵Ace` layout before running analysis
- OI works on `BINANCE:BTCUSDT.P` — do not use BloFin charts for this layout
- CVD at 0 across all timeframes = squeeze forming — flag in Discord
- Session VP Up/Down ratio is the fastest single read for intraday bias
- When Squeeze fires after being 0.00 across all TFs, expect a large directional move
