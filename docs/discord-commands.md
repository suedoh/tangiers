# Discord Commands & Bot

## Overview

`scripts/discord-bot.js` runs every minute via cron. It polls `#btc-signals` for commands and emoji reactions, then posts responses back to the channel. It uses the Discord REST API — no persistent WebSocket process required.

**Requirements:** `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` must be set in `.env`.

---

## Commands

### `!analyze` / `!mtf`

Runs a full 4-timeframe CDP sweep and posts the analysis report to Discord.

**What it does:**
- Reads current BTC price from TradingView (before any timeframe changes)
- Sweeps 12H → 4H → 1H → 30M
- At each timeframe: reads CVD, OI, Session VP, VWAP, VRVP levels, Volume
- Scores all criteria, calculates probability (28–91%) and expected value
- Builds a trade plan (entry / stop / TP1/TP2/TP3) anchored to VRVP levels (falls back to VWAP if VRVP unavailable)
- Posts the full report to Discord in ~15 seconds

**Requirements:** TradingView Desktop must be running on the `🕵Ace` layout.

---

### `!trades`

Shows a summary of the current trade log from `trades.json`.

**Output includes:**
- Open trades: direction, level type, entry/stop/TP1/TP2, confirmation status (✅ confirmed or ⏳ waiting), age in hours
- Last 5 closed trades: outcome, pnlR, direction, whether confirmed

**Example output:**
```
📊 TRADE LOG — 2 open, 5 closed (last 7d)

OPEN TRADES
LONG  HVN   entry $84,200  stop $83,100  TP1 $85,800  ✅ confirmed  (14h ago)
SHORT VAH   entry $86,500  stop $87,200  TP1 $84,900  ⏳ unconfirmed (2h ago)

RECENT CLOSED
✅ LONG  HVN  tp2  +3.6R  confirmed  2026-04-12
✅ SHORT POC  tp1  +1.8R  confirmed  2026-04-11
❌ LONG  VAL  stop  -1.0R  confirmed  2026-04-10
```

---

### `!stop` / `!start`

Pauses or resumes all Discord notifications from `trigger-check.js`.

- `!stop` — creates `.discord-paused` file, `discord-notify.sh` checks for this file and exits silently
- `!start` — removes `.discord-paused` file, notifications resume

Useful when you do not want alerts during sleep or when manually trading a major event.

---

### `!took <trade-id>` _(Phase 2 — not yet active)_

Logs that you personally entered on a system signal. Links your execution to a specific signal in `trades.json`.

**When to activate:** After Phase 1 has 10+ confirmed closed trades with verified outcomes. See `BACKTESTING.md` for exact activation steps.

---

### `!exit tp1|tp2|tp3|stop|manual <price>` _(Phase 2 — not yet active)_

Logs your actual exit on a trade you previously `!took`.

**When to activate:** Same as `!took` — alongside Phase 2 activation.

---

## 📊 Emoji Reaction

React to **any bot message** in `#btc-signals` with 📊 to trigger an on-demand MTF analysis.

The bot polls all recent message IDs stored in `.trigger-state.json`. When a 📊 reaction is detected from a human user, it:

1. Runs `mtf-analyze.js --print`
2. Posts the full analysis as a **threaded reply** to the original message

This works on all notification types: Long signals, Short signals, Level Broken, Stop Hunt, Reclaim — any message the bot posted.

Message IDs are tracked for 24 hours. After that the reaction is ignored (stale signal).

---

## Bot Setup (if configuring from scratch)

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → New Application
2. Go to **Bot** → **Reset Token** → copy the token → add to `.env` as `DISCORD_BOT_TOKEN`
3. Permissions required: **Read Messages**, **Send Messages**, **Read Message History**, **Add Reactions**
4. No privileged intents required
5. Invite the bot to your server with these permissions
6. Right-click `#btc-signals` in Discord → **Copy Channel ID** → add to `.env` as `DISCORD_CHANNEL_ID`
   (Requires Developer Mode: Discord Settings → Advanced → Developer Mode)

---

## Cron Entry

```
*/1 * * * * PATH=/Users/vpm/.nvm/versions/node/v22.22.0/bin:/Users/vpm/.local/bin:/usr/local/bin:/usr/bin:/bin /Users/vpm/.nvm/versions/node/v22.22.0/bin/node /Users/vpm/trading/scripts/discord-bot.js >> /Users/vpm/trading/logs/discord-bot.log 2>&1
```

| Scenario | Duration | Output |
|---|---|---|
| No new messages, no reactions | ~200ms | Silent |
| `!analyze` / `!mtf` found | ~20 seconds | Full MTF report to Discord |
| `!trades` found | ~1 second | Trade log summary |
| `!stop` / `!start` found | ~200ms | Confirmation message |
| 📊 reaction detected | ~20 seconds | Threaded MTF analysis reply |
| TradingView not running | ~20 seconds | Discord error alert |
| Bot token not configured | ~0ms | Exits silently |
