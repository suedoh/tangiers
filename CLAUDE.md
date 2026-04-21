# Tangiers — Claude Instructions

## What Is Tangiers?

Tangiers is the **Ace Trading System** — an automated multi-instrument trade setup detection and alerting platform running on macOS. It monitors **BTC/USDT perpetual futures** (Binance) and **Brent Crude futures (BZ!)** (NYMEX), detects high-probability setups via TradingView Desktop, and delivers structured trade plans to Discord. Zero AI usage in the automated pipeline — all rules are deterministic.

---

## Two Instruments, Two Pipelines

| | **BTC** | **BZ! (Brent Crude)** |
|---|---|---|
| Symbol | `BINANCE:BTCUSDT.P` | `NYMEX:BZ1!` |
| Zone source | Visible Range Volume Profile (VRVP) | LuxAlgo SMC supply/demand boxes |
| Trigger script | `scripts/trigger-check.js` | `scripts/bz/trigger-check.js` |
| Analysis script | `scripts/mtf-analyze.js` | `scripts/bz/analyze.js` |
| Poll frequency | Every 10 min (cron) | Every 1 min (cron, session-gated) |
| Proximity buffer | `max(price × 0.005, zone_width × 1.5)` | `max(atr14 × 0.35, 1.50)` |
| Session gating | None | Skips NYMEX close 5–6pm ET; throttles post-settle |
| Extra intelligence | — | AIS tanker monitoring + RSS news feeds |
| Sentiment | None | Claude Haiku 4.5 (on trigger only) |
| Discord channels | `#btc-*` | `#bz!-*` |

---

## File Structure

```
/trading/
├── CLAUDE.md                           ← this file (Tangiers instructions)
├── README.md                           ← full setup guide + cron schedule
├── BACKTESTING.md                      ← Phase 1/2/3 activation criteria
├── TODO.md                             ← outstanding tasks + known limitations
├── Makefile                            ← dev shortcuts (make test, make analyze, etc.)
├── .env                                ← secrets (gitignored) — copy from .env.example
├── .env.example                        ← all required env vars documented
│
├── scripts/
│   ├── lib/                            ← shared utilities (BZ uses these; BTC inlines its own)
│   │   ├── env.js                      ← .env loader, ROOT path
│   │   ├── cdp.js                      ← TradingView CDP: connect, symbol/TF, price, studies, boxes, ATR
│   │   ├── lock.js                     ← file-based mutex at .tradingview-lock (prevents BTC/BZ conflicts)
│   │   ├── discord.js                  ← shared webhook poster (6 alert types)
│   │   ├── zones.js                    ← classifyZones(), nearestZones(), session cooldowns
│   │   └── sentiment.js               ← Claude Haiku 4.5 sentiment classifier (BZ only)
│   │
│   ├── bz/                             ← BZ! (Brent Crude) instrument
│   │   ├── trigger-check.js            ← 1-min session-aware zone poller
│   │   ├── analyze.js                  ← 4H→1H→30M sweep + Catalyst card + trade plan
│   │   ├── news-watch.js              ← AIS WebSocket + RSS monitor (pm2 process)
│   │   └── weekly-report.js           ← Sunday 5pm ET war report → #bz!-weekly-war-report
│   │
│   ├── discord-bot/                    ← multi-channel Discord bot (BTC + BZ)
│   │   ├── index.js                    ← main entry: polls channels, handles reactions
│   │   ├── router.js                   ← channel prefix → handler (add new instrument here)
│   │   └── handlers/
│   │       ├── btc.js                  ← !analyze, !trades, !status
│   │       ├── bz.js                   ← !analyze, !report, !trades, !took, !take, !exit
│   │       └── shared.js              ← !stop, !start (any channel)
│   │
│   ├── trigger-check.js                ← BTC zone poller (every 10m)
│   ├── mtf-analyze.js                  ← BTC 4-TF CDP sweep
│   ├── weekly-report.js               ← BTC Monday performance report
│   ├── weekly-war-report.js           ← BTC Sunday war report
│   └── discord-notify.sh              ← Discord webhook poster (5 alert types, shell)
│
├── docs/                              ← documentation
│   ├── architecture.md                ← pipeline diagrams, zone source, CDP design decisions
│   ├── discord-commands.md            ← all bot commands per instrument
│   ├── notifications.md               ← alert types with example output
│   ├── performance-tracking.md        ← trade lifecycle, three-track report, phase status
│   ├── progressive-enhancements.md   ← roadmap (Tier 1–4)
│   └── setup.md                       ← prerequisites, TradingView layout, cron setup
│
├── strategies/
│   ├── smc-setups.md                  ← three setup types (NOTE: needs update — see TODO.md)
│   ├── mtf-analysis.md                ← manual Claude Desktop analysis protocol
│   └── risk-management.md            ← position sizing, R:R rules
│
├── trades.json                         ← BTC signals + outcomes (gitignored, auto-created)
├── bz-trades.json                      ← BZ! signals + outcomes (gitignored, auto-created)
├── .trigger-state.json                 ← BTC: zone cooldowns, OI history, reclaim list, signal IDs
├── .bz-trigger-state.json              ← BZ: zone cooldowns, signal IDs
├── .bz-news-state.json                 ← BZ news monitor: seen articles, AIS history/baseline
├── .discord-bot-state.json            ← Discord bot: last-seen message IDs per channel
└── tradingview-mcp/                    ← TradingView MCP server (Claude Desktop only, git submodule)
```

---

## How Each Script Works

### `scripts/trigger-check.js` — BTC Poller
- Runs every **10 minutes** via crontab
- Reads TradingView Desktop via CDP on port 9222
- Zone source: **VRVP levels** (VAL, VAH, HVN, POC)
- Proximity trigger: `buffer = max(price × 0.005, zone_width × 1.5)`
- When triggered: scores setup criteria → posts trade plan to `#btc-signals`
- Also tracks: confirmation (30M bar close + CVD/OI), zone mitigation, stop hunts, reclaims
- Outcome tracking runs every cycle regardless of trigger

### `scripts/bz/trigger-check.js` — BZ! Poller
- Runs every **1 minute** via crontab (self-throttles off-session)
- Session gate: skips 5–6pm ET (NYMEX close); throttles 2:30–5pm ET to every 15 min
- Zone source: **LuxAlgo SMC boxes** (supply/demand)
- Proximity buffer: ATR-based — `max(atr14 × 0.35, 1.50)`
- One alert per zone per session (Asia/London/NY/Post cooldown)
- When triggered: posts Approaching alert, then spawns `bz/analyze.js` for full analysis

### `scripts/bz/analyze.js` — BZ! Analysis Engine
- Runs 4H → 1H → 30M sweep via CDP
- Reads: LuxAlgo boxes + labels (BOS/CHoCH), VWAP, CVD, OI, Session VP, OHLCV/ATR
- Runs Claude Haiku sentiment classification on any `--context` string
- Builds a **Catalyst card**: trade plan with zone map, entry/SL/TP1/TP2/TP3, quality score (0–6)
- Posts to `#bz!-signals` and logs to `bz-trades.json`

### `scripts/bz/news-watch.js` — BZ! News Monitor (pm2)
- **LAYER 1 — AIS**: WebSocket to aisstream.io watching Fujairah + Jebel Ali anchorages
  - Tracks anchored tankers (speed < 0.5 kts, AIS type 80–89)
  - Surge alert if count rises >20% in 30min vs prior hour AND >15% above baseline → fires analyze.js
  - 2-hour cooldown between AIS triggers; exponential backoff on reconnect
- **LAYER 2 — RSS**: 7 feeds polled every 60 seconds
  - Keywords: Hormuz blockade, IRGC, tanker attack, OPEC emergency, etc.
  - New headline match → posts info alert + fires analyze.js
  - Deduplicates by article link; state in `.bz-news-state.json`
- Both layers respect a **10-minute analysis cooldown** to prevent spam

### `scripts/discord-bot/index.js` — Multi-Channel Bot
- Runs every **1 minute** via crontab
- Polls all registered channels for commands and 📊 emoji reactions
- Routes by channel prefix (`btc-*` → btc handler, `bz-*` → bz handler)
- Reaction tracking: reads `_signal_messages` from `.trigger-state.json` / `.bz-trigger-state.json`
- Respects rate limits: 1.1s between reaction API calls, max 6 checks per run

### `scripts/lib/lock.js` — Mutex
- File-based lock at `.tradingview-lock` (project root)
- Both BTC and BZ scripts compete for the same TradingView Desktop session
- TTL: 60s (stale locks auto-broken). Always acquire before CDP work; release in `finally`.

---

## CDP Architecture

All scripts connect to **TradingView Desktop** via Chrome DevTools Protocol on `localhost:9222`. No external market data APIs. No Anthropic API in the automated pipeline (only BZ news context classification).

Key shared helpers in `scripts/lib/cdp.js`:
- `cdpConnect(symbolHint)` — connects to matching tab; falls back to probing each tab's symbol
- `setSymbol()` / `setTimeframe()` — polls until confirmed (not a fixed sleep)
- `waitForPrice()` — polls until a valid last price is available post-switch
- `getStudyValues()` — reads all visible indicator values via TradingView's internal data window
- `getPineBoxes(client, 'LuxAlgo')` — reads supply/demand zone coordinates
- `calcATR(bars, 14)` — returns `{ atr14, buffer }` for BZ proximity calculations

**Important:** Scripts must hold the mutex lock during all CDP operations. BTC's `trigger-check.js` inlines its own CDP code (legacy, untouched); BZ scripts use `lib/cdp.js`.

---

## TradingView Layout

- **Layout name**: `🕵Ace` (saved in TradingView)
- **BTC tab**: `BINANCE:BTCUSDT.P`
- **BZ tab**: `NYMEX:BZ1!`
- TradingView Desktop **must be open** with both tabs visible for the pipeline to work

### Indicator Stack — BTC (`🕵Ace` layout)
| Indicator | What's read |
|---|---|
| Visible Range Volume Profile | VAL, VAH, HVN, POC — primary zone source |
| Session Volume Profile | Up/Down ratio — session bias |
| VWAP | Institutional benchmark, entry anchor |
| Cumulative Volume Delta | Order flow confirmation |
| Open Interest | Conviction check |

### Indicator Stack — BZ! (same layout, BZ1! tab)
| Indicator | What's read |
|---|---|
| Smart Money Concepts [LuxAlgo] | Supply/demand boxes, BOS/CHoCH labels |
| Session Volume Profile | Session bias |
| VWAP | Directional bias and entry anchor |
| Cumulative Volume Delta | Order flow |
| Open Interest | Positioning |

---

## Discord Structure

### Webhooks (set in `.env`)
| Variable | Channel | Used by |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | `#btc-signals` | BTC alerts, errors |
| `DISCORD_BTC_BACKTEST_WEBHOOK_URL` | `#btc-backtest` | Weekly BTC report |
| `DISCORD_BTC_WEEKLY_WAR_REPORT` | `#btc-weekly-war-report` | BTC Sunday war report |
| `DISCORD_HELPER` | `#general` | `!status` command |
| `BZ_DISCORD_SIGNALS_WEBHOOK` | `#bz!-signals` | BZ alerts, approaching, errors |
| `BZ_DISCORD_BACKTEST_WEBHOOK` | `#bz!-backtest` | BZ signal log, weekly report |
| `BZ_DISCORD_WAR_REPORT_WEBHOOK` | `#bz!-weekly-war-report` | BZ Sunday war report |

### Bot Channel IDs (set in `.env`)
`DISCORD_CHANNEL_ID`, `BZ_DISCORD_SIGNALS_CHANNEL_ID`, `BZ_DISCORD_WAR_REPORT_CHANNEL_ID`, `BZ_DISCORD_BACKTEST_CHANNEL_ID`

### Alert Types (6)
`approaching` (yellow) · `long` (green) · `short` (red) · `info` (blue) · `error` (dark red) · `catalyst` (orange, BZ only)

---

## Cron Schedule

```
*/10 * * * *   scripts/trigger-check.js               — BTC zone trigger + outcome tracking
*/1  * * * *   scripts/discord-bot/index.js           — multi-channel bot (all instruments)
*/1  * * * *   scripts/bz/trigger-check.js TZ=ET      — BZ! zone poller (session-gated)
0    9 * * 1   scripts/weekly-report.js               — BTC Monday 09:00 UTC
0   14 * * 0   scripts/weekly-war-report.js           — BTC Sunday 14:00 UTC
0   21 * * 0   scripts/bz/weekly-report.js            — BZ! Sunday 21:00 UTC (17:00 ET)
```

View installed jobs: `crontab -l`

## pm2 Process

```
bz-news-watch   — AIS WebSocket + RSS monitor, persistent, self-healing
```

```bash
pm2 status
pm2 logs bz-news-watch
pm2 restart bz-news-watch
```

---

## State Files (auto-managed, gitignored)

| File | Owner | Contains |
|---|---|---|
| `.trigger-state.json` | BTC trigger + discord-bot | Zone cooldowns, OI history, reclaim list, signal message IDs |
| `.bz-trigger-state.json` | BZ trigger/analyze + discord-bot | Zone cooldowns, CDP error cooldown, signal message IDs |
| `.bz-news-state.json` | bz-news-watch | Seen article IDs, AIS vessel history, AIS baseline |
| `.discord-bot-state.json` | discord-bot | Last-seen Discord message ID per channel |
| `trades.json` | BTC pipeline | All BTC signals with lifecycle fields |
| `bz-trades.json` | BZ pipeline | All BZ! signals with lifecycle fields |
| `.tradingview-lock` | lib/lock.js | Ephemeral mutex (deleted after each CDP session) |

---

## Trade Lifecycle

```
SIGNAL FIRED → UNCONFIRMED → CONFIRMED → CLOSED → REPORTED
```

- **Confirmation**: 30M bar close beyond entry + CVD/OI growth thresholds
- **Outcome tracking**: runs every poll cycle — checks price vs TP1/TP2/TP3/stop
- **Phase 2** (`!took` / `!exit` execution tracking): implemented but behind guards. Activate after 10+ confirmed closed trades. See `TODO.md`.

---

## Environment Variables

Key variables in `.env` (see `.env.example` for full list):

| Variable | Purpose |
|---|---|
| `PRIMARY` | `true/false` — only one machine should post signals |
| `TRADINGVIEW_ENABLED` | `true/false` — disable CDP on machines without TradingView Desktop |
| `ANTHROPIC_API_KEY` | Used by `lib/sentiment.js` for BZ! context classification |
| `AISSTREAM_API_KEY` | aisstream.io WebSocket — BZ! AIS tanker monitoring |
| `BZ_GEOPOLITICAL_FLAG` | `active/inactive` — adds geo-premium bonus to BZ! quality score |

---

## Makefile Shortcuts

```bash
make test           # run trigger-check.js once
make analyze        # run BTC MTF analysis now
make bot            # run discord-bot once
make report         # BTC weekly report now
make war-report     # BTC war report now
make logs           # tail trigger-check.log
make bot-logs       # tail discord-bot.log
make clean          # reset BTC state + clear logs
make cron           # install all cron jobs (idempotent)
```

---

## Manual Analysis (Claude Desktop + TradingView MCP)

For qualitative judgment when a signal fires:
1. Open Claude Desktop with the TradingView MCP server connected
2. Switch to `🕵Ace` layout
3. Follow `strategies/mtf-analysis.md` — sweeps 12H → 4H → 1H → 30M
4. The MCP server has 78 tools: `chart_set_timeframe`, `data_get_study_values`, `data_get_pine_boxes`, `data_get_pine_labels`, `capture_screenshot`, etc.

**Rule**: Claude Desktop + MCP = qualitative analysis only. The automated pipeline never calls the MCP server or Claude API.

---

## Known Issues / Active TODOs

See `TODO.md` for full list. Key items:

1. **Phase 2 activation**: `!took` / `!exit` implemented but gated — activate when 10+ confirmed closed BTC trades
2. **CVD at poll time vs bar time**: `checkConfirmation()` uses current CVD, not the value when the 30M bar closed (~15% noise)
3. **`strategies/smc-setups.md` is stale**: still references LuxAlgo as primary BTC zone source — needs update to VRVP
4. **VRVP visibility required**: if the VRVP indicator is hidden or outside visible range, no BTC triggers fire
5. **BZ! `!took`/`!take`/`!exit`**: fully active for BZ (unlike BTC which is Phase 2 gated)

---

## Adding a New Instrument

1. Create `scripts/{ticker}/trigger-check.js` and `scripts/{ticker}/analyze.js` (model on `scripts/bz/`)
2. Add webhook + channel ID vars to `.env.example`
3. Add two lines to `scripts/discord-bot/router.js`
4. Create `scripts/discord-bot/handlers/{ticker}.js`
5. Add cron entries via `Makefile`
