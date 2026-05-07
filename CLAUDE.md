# Tangiers — Claude Instructions

## What Is Tangiers?

Tangiers is the **Ace + Billy Sherbert Trading System** — a cross-platform automated signal detection and alerting platform. It runs two independent bots from a single shared codebase:

- **Ace** monitors **BTC/USDT perpetual futures** (Binance) and **Brent Crude futures (BZ!)** (NYMEX) via TradingView Desktop. He detects high-probability setups and delivers structured trade plans to Discord. Zero AI usage in his automated pipeline — all rules are deterministic.

- **Billy Sherbert** scans **Polymarket temperature bucket markets**. He computes model edge using a GFS/ECMWF/ICON ensemble forecast and posts paper trade signals to Discord. He has no TradingView dependency — he uses public weather forecast APIs and the Polymarket CLOB directly.

Both bots share `scripts/lib/`, `scripts/discord-bot/`, MongoDB collections, and `.env` — but operate completely independently of each other. Currently Ace runs in production on macOS; Billy Sherbert is being developed in a Windows staging environment. Both are designed to be cross-platform — a future move to a different OS or VPS is intentional and supported.

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
│   ├── weather/                        ← Billy Sherbert — Polymarket weather signals
│   │   ├── market-scan.js             ← main scanner (every 30 min)
│   │   ├── settle.js                  ← NOAA settlement resolver
│   │   ├── weekly-report.js           ← Sunday 18:00 UTC P&L report → #weather-backtest
│   │   ├── analyze-performance.js     ← !performance deep analysis
│   │   ├── exit-monitor.js            ← early-exit tracker for open positions
│   │   ├── post-welcome.js            ← (re)post #weather-signals welcome messages
│   │   ├── setup-discord.js           ← first-time Discord channel setup
│   │   ├── setup-mongo-windows.ps1   ← Windows one-time MongoDB + Docker setup
│   │   └── schedule-windows.ps1      ← Windows Task Scheduler setup (current staging env)
│   │
│   ├── discord-bot/                    ← multi-channel Discord bot (Ace + Billy Sherbert)
│   │   ├── index.js                    ← main entry: polls channels, handles reactions
│   │   ├── router.js                   ← channel prefix → handler (add new instrument here)
│   │   └── handlers/
│   │       ├── btc.js                  ← !analyze, !trades, !status
│   │       ├── bz.js                   ← !analyze, !report, !trades, !took, !take, !exit
│   │       ├── weather.js             ← !scan, !analyze, !report, !trades, !took, !exit, !performance
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
├── weather-trades.json                ← Billy Sherbert signals + outcomes (gitignored, auto-created)
├── .trigger-state.json                 ← BTC: zone cooldowns, OI history, reclaim list, signal IDs
├── .bz-trigger-state.json              ← BZ: zone cooldowns, signal IDs
├── .bz-news-state.json                 ← BZ news monitor: seen articles, AIS history/baseline
├── .discord-bot-state.json            ← Discord bot: last-seen message IDs per channel
├── .weather-state.json                ← Billy Sherbert: cooldowns, open signal IDs (gitignored)
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

### `scripts/weather/market-scan.js` — Billy Sherbert Scanner
- Runs every **30 minutes** (crontab on macOS/Linux; Task Scheduler on Windows)
- Fetches active Polymarket temperature bucket markets for all tracked cities
- Groups by city × date; calls `getTemperatureForecast()` once per group
- Signals the highest-edge bucket per group if edge ≥ `WEATHER_MIN_EDGE` (default 8%)
- Two-stage AI filter: Stage 1 (Haiku) sanity check → Stage 2 (Sonnet, gated by `WEATHER_DEEP_ANALYSIS=true`)
- State: `.weather-state.json` | Trades: `weather-trades.json`

### `scripts/discord-bot/index.js` — Multi-Channel Bot
- Runs every **1 minute** (crontab on macOS/Linux; Task Scheduler on Windows)
- Polls all registered channels for commands and 📊 emoji reactions
- Routes by channel prefix (`btc-*` → btc handler, `bz-*` → bz handler, `weather-*` → weather handler)
- When `ENVIRONMENT=staging`, only weather channels are polled — Ace's BTC/BZ channels are excluded so he is never disturbed during Billy Sherbert staging
- Reaction tracking: reads `_signal_messages` from `.trigger-state.json` / `.bz-trigger-state.json`
- Respects rate limits: 1.1s between reaction API calls, max 6 checks per run

### `scripts/lib/lock.js` — Mutex
- File-based lock at `.tradingview-lock` (project root)
- Both BTC and BZ scripts compete for the same TradingView Desktop session
- TTL: 60s (stale locks auto-broken). Always acquire before CDP work; release in `finally`.

---

## CDP Architecture

All Ace scripts connect to **TradingView Desktop** via Chrome DevTools Protocol on `localhost:9222`. No external market data APIs. No Anthropic API in the automated pipeline (only BZ news context classification). Billy Sherbert does not use CDP.

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
| `WEATHER_DISCORD_SIGNALS_WEBHOOK` | `#weather-signals` | Billy Sherbert edge alerts |
| `WEATHER_DISCORD_BACKTEST_WEBHOOK` | `#weather-backtest` | Billy Sherbert signal log, weekly report |

### Bot Channel IDs (set in `.env`)
`DISCORD_CHANNEL_ID`, `BZ_DISCORD_SIGNALS_CHANNEL_ID`, `BZ_DISCORD_WAR_REPORT_CHANNEL_ID`, `BZ_DISCORD_BACKTEST_CHANNEL_ID`, `WEATHER_DISCORD_SIGNALS_CHANNEL_ID`, `WEATHER_DISCORD_BACKTEST_CHANNEL_ID`

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
*/30 * * * *   scripts/weather/market-scan.js          — Billy Sherbert Polymarket scan
```

View installed jobs: `crontab -l` (macOS/Linux) | Task Scheduler (Windows)

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
| `.weather-state.json` | Billy Sherbert market-scan | Cooldowns, open signal IDs |
| `trades.json` | BTC pipeline | All BTC signals with lifecycle fields |
| `bz-trades.json` | BZ pipeline | All BZ! signals with lifecycle fields |
| `weather-trades.json` | Billy Sherbert pipeline | All weather signals with lifecycle fields |
| `.tradingview-lock` | lib/lock.js | Ephemeral mutex (deleted after each CDP session) |

---

## Trade Lifecycle

### Ace (BTC / BZ!)
```
SIGNAL FIRED → UNCONFIRMED → CONFIRMED → CLOSED → REPORTED
```

- **Confirmation**: 30M bar close beyond entry + CVD/OI growth thresholds
- **Outcome tracking**: runs every poll cycle — checks price vs TP1/TP2/TP3/stop
- **Phase 2** (`!took` / `!exit` execution tracking): implemented but behind guards. Activate after 10+ confirmed closed trades. See `TODO.md`.

### Billy Sherbert (Polymarket weather)
```
SIGNAL FIRED → OPEN → RESOLVED → REPORTED
```

- **Resolution**: GHCN-Daily → NWS METAR → Open-Meteo ERA5 (same source priority as Polymarket)
- **Paper entry**: `!took <id>` logs a paper trade; `!exit <id> win|loss` closes it
- **Phase B** (live execution): activate after ≥20 confirmed resolved trades with 55%+ WR

---

## Environment Variables

Key variables in `.env` (see `.env.example` for full list):

| Variable | Purpose |
|---|---|
| `PRIMARY` | `true/false` — only one machine should post signals |
| `TRADINGVIEW_ENABLED` | `true/false` — disable CDP on machines without TradingView Desktop |
| `ANTHROPIC_API_KEY` | BZ! sentiment (Haiku) + Billy Sherbert Stage 1/2 analysis |
| `AISSTREAM_API_KEY` | aisstream.io WebSocket — BZ! AIS tanker monitoring |
| `BZ_GEOPOLITICAL_FLAG` | `active/inactive` — adds geo-premium bonus to BZ! quality score |
| `ENVIRONMENT` | `production` / `staging` — routes Billy Sherbert to staging Discord when set to `staging` |
| `NCEI_TOKEN` | NOAA NCEI — GHCN-Daily historical base rates for Billy Sherbert settlement |
| `WEATHER_MIN_EDGE` | Minimum edge to fire a Billy Sherbert signal (default `0.08` = 8%) |
| `WEATHER_BANKROLL` | Paper bankroll for Kelly sizing (default `500`) |
| `WEATHER_DEEP_ANALYSIS` | Enable Stage 2 Sonnet analysis (default `false`) |

---

## Makefile Shortcuts

```bash
make test              # run trigger-check.js once
make analyze           # run BTC MTF analysis now
make bot               # run discord-bot once
make report            # BTC weekly report now
make war-report        # BTC war report now
make logs              # tail trigger-check.log
make bot-logs          # tail discord-bot.log
make clean             # reset BTC state + clear logs
make cron              # install all cron jobs (idempotent)
make weather-scan      # run Billy Sherbert market-scan.js once
make weather-analyze   # deep-dive a specific Polymarket market
make weather-report    # generate Billy Sherbert weekly report now
make weather-cron      # install Billy Sherbert cron jobs (macOS/Linux)
make weather-clean     # reset Billy Sherbert state + clear logs
```

---

## Manual Analysis (Claude Desktop + TradingView MCP)

For qualitative judgment when an Ace signal fires:
1. Open Claude Desktop with the TradingView MCP server connected
2. Switch to `🕵Ace` layout
3. Follow `strategies/mtf-analysis.md` — sweeps 12H → 4H → 1H → 30M
4. The MCP server has 78 tools: `chart_set_timeframe`, `data_get_study_values`, `data_get_pine_boxes`, `data_get_pine_labels`, `capture_screenshot`, etc.

**Rule**: Claude Desktop + MCP = qualitative analysis only. The automated pipeline never calls the MCP server or Claude API.

---

## Known Issues / Active TODOs

See `TODO.md` for full list. Key items:

**Ace:**
1. **Phase 2 activation**: `!took` / `!exit` implemented but gated — activate when 10+ confirmed closed BTC trades
2. **CVD at poll time vs bar time**: `checkConfirmation()` uses current CVD, not the value when the 30M bar closed (~15% noise)
3. **`strategies/smc-setups.md` is stale**: still references LuxAlgo as primary BTC zone source — needs update to VRVP
4. **VRVP visibility required**: if the VRVP indicator is hidden or outside visible range, no BTC triggers fire
5. **BZ! `!took`/`!take`/`!exit`**: fully active for BZ (unlike BTC which is Phase 2 gated)

**Billy Sherbert:**
1. **Phase B activation**: live execution gated until ≥20 resolved trades + 55%+ WR
2. **Houston/Dallas bias corrections absent**: fewer than 5 resolved trades each — resolves naturally as sample grows
3. **YES+range blocked**: 13% all-time WR; shadow-logging candidates under `sigmaF < 0.75°F AND |biasCorrection| < 2.0°F`
4. **Stage 2 (Sonnet) disabled**: keep `WEATHER_DEEP_ANALYSIS=false` until Phase B and API credits allow

---

## Workflow

- **Commit and push after every significant change.** Bug fixes, new features, refactors — stage the relevant files and push to `main`. Don't wait to be asked.
- **Never hardcode absolute paths.** Use `ROOT` from `scripts/lib/env.js` — resolves correctly on macOS, Windows, and any future deployment target regardless of install path.
- **TradingView-dependent machine** (`TRADINGVIEW_ENABLED=true`): runs Ace's cron jobs and requires TradingView Desktop open with the `🕵Ace` layout. All CDP/TradingView code must be guarded by `TRADINGVIEW_ENABLED`.
- **Non-TradingView machine** (`PRIMARY=false`, `TRADINGVIEW_ENABLED=false`): runs Billy Sherbert's pipeline. Does not run Ace's crons and never touches CDP.
- **`ENVIRONMENT=staging`** routes Billy Sherbert's Discord output to the staging server. Ace's BTC/BZ channels are excluded in staging mode so he is never disturbed. Switch back to `production` before going live.
- **Only work within the project directory.** Do not read or modify files outside it.

---

## MongoDB Migration — In Progress

**Branch:** `feat/mongodb-docker` | **Plan file:** `~/.claude/plans/i-have-a-project-cozy-book.md`

### What's done (Phase 0–1)
- MongoDB 7.0 running in Docker (`docker-compose.yml`, `127.0.0.1:27017`, volume `mongo_data`)
- `scripts/lib/db.js` — shared ES-module connection + collection accessors (loads `.env` automatically)
- Migration scripts in `scripts/migrate/` — indexes created, 161 trades + all state imported
- **Cron scripts still read/write JSON files** — no behavioral change yet

### What's next (Phases 2–5, after weathermen merges to main)
| Phase | Work |
|---|---|
| 2 | Switch native cron scripts to MongoDB: `trigger-check.js`, `bz/trigger-check.js`, `bz/analyze.js`, weekly reports |
| 3 | Containerize Discord bot (`docker/discord-bot.Dockerfile`), remove from crontab |
| 4 | Refactor `bz/news-watch.js` to write `triggers` collection instead of spawning `analyze.js`; containerize as Docker service, remove from pm2 |
| 5 | Cleanup — remove JSON dual-writes, archive `.json` files, update Makefile |

### Key constraints (don't forget these)
- CDP scripts (`trigger-check.js`, `bz/trigger-check.js`, `bz/analyze.js`) **must stay native** — Docker for Mac can't reach TradingView Desktop on `localhost:9222`
- Native cron scripts connect to MongoDB via `127.0.0.1:27017` (port-forwarded from Docker); Docker services connect via `mongodb:27017` (internal network)
- **Weathermen** will be a new instrument + standalone feature — add its instrument to `scripts/migrate/import-trades.js` before merging so it's in MongoDB from day one
- Partner machine (`PRIMARY=false`): no MongoDB, no Docker needed — `PRIMARY` guard exits before any DB calls

### Docker quick-reference
```bash
docker compose up -d mongodb    # start (survives reboots via restart:unless-stopped)
docker compose ps               # check health
docker compose down             # stop (data persists in volume)
```

---

## Adding a New Instrument

1. Create `scripts/{ticker}/trigger-check.js` and `scripts/{ticker}/analyze.js` (model on `scripts/bz/`)
2. Add webhook + channel ID vars to `.env.example`
3. Add two lines to `scripts/discord-bot/router.js`
4. Create `scripts/discord-bot/handlers/{ticker}.js`
5. Add cron entries via `Makefile`
