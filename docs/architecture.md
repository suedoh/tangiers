# System Architecture

## Overview

The Ace Trading System has two independent pipelines:

1. **Automated pipeline** — `trigger-check.js` runs every 10 minutes, reads TradingView via CDP, fires trade alerts to Discord. Zero AI. Zero cost.
2. **On-demand analysis** — `discord-bot.js` listens for `!analyze` commands and emoji reactions, runs `mtf-analyze.js` to produce a full 4-TF report.

Both pipelines read TradingView Desktop directly via the Chrome DevTools Protocol (CDP). No external market data APIs. No AI API calls.

---

## Pipeline Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  macOS crontab (every 10 minutes)                                   │
│                                                                     │
│  node scripts/trigger-check.js                                      │
│         │                                                           │
│         │  Chrome DevTools Protocol (CDP) on port 9222             │
│         ▼                                                           │
│  TradingView Desktop (Electron app, 🕵Ace layout)                   │
│         │  reads: price, VRVP levels (HVN/POC/VAH/VAL)            │
│         │  reads: CVD, OI, Session VP, VWAP, Volume               │
│         │  reads: 4H bars → MACD direction                         │
│         │  reads: 12H bars → RSI                                   │
│         │                                                           │
│         ├─ price near VRVP level?                                   │
│         │       ▼                                                   │
│         │  Rule-based setup evaluation                              │
│         │  entry / stop / TP1 / TP2 / TP3                          │
│         │  probability score (28–91%)                               │
│         │  → discord-notify.sh → #btc-signals                      │
│         │  → logTrade() → trades.json                              │
│         │                                                           │
│         ├─ alerted zone mitigated?                                  │
│         │       ▼                                                   │
│         │  CVD + OI verdict: real break or stop hunt               │
│         │  → discord-notify.sh → #btc-signals                      │
│         │  → stop hunt? add to reclaim watch list                  │
│         │                                                           │
│         ├─ watched zone reclaimed?                                  │
│         │       ▼                                                   │
│         │  CVD + OI confirm reclaim                                │
│         │  → discord-notify.sh → #btc-signals                      │
│         │                                                           │
│         └─ always: updateOutcomes() + checkConfirmation()          │
│                    → trades.json (bar-accurate)                     │
│                                                                     │
│  macOS crontab (every 1 minute)                                     │
│                                                                     │
│  node scripts/discord-bot.js                                        │
│         │  polls Discord channel for commands + emoji reactions     │
│         │  !analyze / !mtf / !trades / !stop / !start              │
│         │  📊 emoji reaction on any bot post?                       │
│         │       ▼                                                   │
│         │  node scripts/mtf-analyze.js --print                     │
│         │       │  CDP: reads price first (before TF changes)      │
│         │       │  sweeps: 12H → 4H → 1H → 30M                    │
│         │       │  reads all Ace indicators per TF                  │
│         │       │  probability score + trade plan                   │
│         │       ▼                                                   │
│         │  → threaded reply to original message                    │
│                                                                     │
│  macOS crontab (every Monday 09:00 UTC)                             │
│                                                                     │
│  node scripts/weekly-report.js                                      │
│         │  reads trades.json                                        │
│         │  three-track analysis:                                    │
│         │    all signals / confirmed-only / unconfirmed             │
│         │  streak, time-to-outcome, criteria correlation            │
│         ▼                                                           │
│  discord-notify → #btc-backtest                                     │
│                                                                     │
│  macOS crontab (every Sunday 14:00 UTC / 09:00 EST)                │
│                                                                     │
│  node scripts/weekly-war-report.js                                  │
│         │  TradingView CDP: weekly/monthly bars, CVD, OI, VWAP    │
│         │  Binance API: funding rate                                │
│         │  Alternative.me: Fear & Greed Index                      │
│         │  Deribit API: options expiry + max pain                   │
│         │  ForexFactory: macro calendar                             │
│         ▼                                                           │
│  discord-notify → #btc-weekly-war-report                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### Why no Claude/AI in the automated pipeline?

Every 10-minute poll would consume thousands of tokens per day. All setup logic is deterministic rules. Claude is reserved for on-demand deeper analysis via the TradingView MCP server.

### Why TradingView Desktop instead of a market data API?

The indicators used (Visible Range Volume Profile, Session Volume Profile, Cumulative Volume Delta, Open Interest) either don't exist in standard market data APIs or require expensive subscriptions. TradingView Desktop already has everything running — the system reads from it directly via CDP.

### Why CDP instead of the TradingView MCP server?

The MCP server requires Claude to orchestrate it (it's a Model Context Protocol server). For cron jobs with no Claude involvement, `trigger-check.js` and `mtf-analyze.js` call CDP directly using `chrome-remote-interface`.

### What is the TradingView MCP server used for?

Manual analysis sessions in Claude Desktop. When a signal fires and you want qualitative judgment, open Claude Desktop and follow the workflow in `strategies/mtf-analysis.md`. Claude uses the MCP server's 78 tools to read every indicator across all timeframes.

### Why `!analyze` instead of a Claude Desktop session?

`mtf-analyze.js` completes in ~15 seconds, works from Discord on any device, costs nothing, and fires automatically on 📊 emoji reactions. Claude Desktop is for qualitative judgment: "does the structure really look right here?", cases with ambiguous CVD, or when you want a natural-language explanation.

---

## VRVP — The Zone Source

The automated pipeline uses **Visible Range Volume Profile (VRVP)** levels as zone anchors. These replace the LuxAlgo SMC supply/demand boxes used in an earlier version of the system.

VRVP levels read by the system:

| Level | Description | Priority |
|---|---|---|
| **VAL** | Value Area Low — bottom of the 70% volume band | 10 (highest) |
| **VAH** | Value Area High — top of the 70% volume band | 10 (highest) |
| **HVN** | High Volume Node — individual bars with >2× average volume | 7 |
| **POC** | Point of Control — single bar with highest volume | 5 |

**Proximity trigger:**
```
buffer = max(price × 0.005, zone_width × 1.5)
trigger = price_inside_zone OR distance_to_zone_edge <= buffer
```

**VRVP structural position bonus** (applied to probability score):
- Between VAL and POC: +3pp (institutional value area, long bias)
- Above POC: +1pp (above consensus, continuation)
- Below VAL: −3pp (rejected from value, bearish)

---

## Trade Lifecycle

```
SIGNAL FIRED → UNCONFIRMED → CONFIRMED → CLOSED → REPORTED
```

See [docs/performance-tracking.md](performance-tracking.md) for full trade lifecycle documentation.

---

## State Files

| File | Purpose | Notes |
|---|---|---|
| `trades.json` | All signals + outcomes | Gitignored, auto-created |
| `my-trades.json` | Your personal execution log | Phase 2, not yet active |
| `.trigger-state.json` | Zone cooldowns, OI history, reclaim watch list, signal message IDs | Gitignored, auto-created |
| `.discord-bot-state.json` | Last-seen Discord message ID | Gitignored, auto-created |
