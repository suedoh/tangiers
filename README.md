# Tangiers Trading System v1.1.0

Automated multi-instrument signal detection and alerting platform running two independent bots — **Ace** (futures) and **Billy Sherbert** (Polymarket weather).

**Ace** monitors **BTC/USDT perpetual futures** (Binance) and **Brent Crude (BZ!)** (NYMEX). He connects to TradingView Desktop via CDP, reads price zones, CVD, OI, Session VP, and VWAP, evaluates setup criteria rule-by-rule, and posts complete trade plans to Discord — entry, stop, three TP targets, R:R ratios, and a quality score. Every signal is auto-logged with bar-accurate outcome tracking. BZ! adds session-aware 1-min polling, AIS WebSocket tanker monitoring (Fujairah/Jebel Ali anchorages as Hormuz proxy), RSS feed monitoring across 7 sources, Claude Haiku sentiment classification, and a Sunday institutional war report with geopolitical scenarios.

**Billy Sherbert** scans **Polymarket temperature bucket markets**. He fetches a GFS/ECMWF/ICON ensemble forecast, computes model edge against market prices, and posts paper trade signals to Discord. He uses a two-stage AI filter (Haiku sanity check → Sonnet deep analysis) and resolves outcomes using the same NOAA/GHCN station data Polymarket uses for settlement. He has no TradingView dependency.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the system works — pipeline diagram, CDP design, zone source, trade lifecycle |
| [docs/setup.md](docs/setup.md) | Prerequisites, installation, TradingView layout, cron setup, troubleshooting |
| [docs/discord-commands.md](docs/discord-commands.md) | All bot commands per instrument |
| [docs/notifications.md](docs/notifications.md) | All alert types with example output |
| [docs/performance-tracking.md](docs/performance-tracking.md) | Trade lifecycle, three-track report, Phase 1/2/3 status |
| [docs/progressive-enhancements.md](docs/progressive-enhancements.md) | Roadmap to institutional-grade trading desk |
| [BACKTESTING.md](BACKTESTING.md) | Strategy overview, confirmation mechanics, Phase 2 activation |
| [TODO.md](TODO.md) | Outstanding tasks, known limitations |
| [strategies/smc-setups.md](strategies/smc-setups.md) | Setup criteria: entry triggers, stops, targets, invalidation |
| [strategies/mtf-analysis.md](strategies/mtf-analysis.md) | Manual MTF analysis protocol for Claude Desktop sessions |
| [strategies/risk-management.md](strategies/risk-management.md) | Position sizing, R:R rules, partial exit strategy |

---

## Quick Start

```bash
# 1. Clone and install dependencies
git clone --recurse-submodules https://github.com/YOUR_USERNAME/trading.git
cd trading && make deps

# 2. Configure environment
cp .env.example .env
# Fill in all webhooks, bot token, channel IDs, and API keys (see .env.example)

# 3. Set up TradingView Ace layout (see docs/setup.md Step 3)

# 4. Install cron jobs
make cron

# 5. Start BZ! news monitor (persistent, self-healing)
npm install -g pm2
pm2 start scripts/bz/news-watch.js --name bz-news-watch
pm2 startup  # follow the output command for reboot persistence
pm2 save

# 6. Test
bash scripts/discord-notify.sh info "Ace online"
node scripts/trigger-check.js
```

---

## File Structure

```
/trading/
├── README.md
├── CLAUDE.md                              ← instructions loaded in every Claude session
├── BACKTESTING.md                         ← backtesting strategy, phases, lifecycle
├── .env                                   ← secrets (gitignored)
├── .env.example                           ← template with all required vars
│
├── scripts/
│   │
│   ├── lib/                               ← shared utilities (all instruments)
│   │   ├── env.js                         ← .env loader, ROOT path
│   │   ├── cdp.js                         ← TradingView CDP: connect, read, switch symbol/TF
│   │   ├── lock.js                        ← file-based mutex (prevents BTC/BZ CDP conflicts)
│   │   ├── discord.js                     ← shared webhook poster (6 alert types)
│   │   ├── zones.js                       ← zone classification, proximity, session cooldowns
│   │   └── sentiment.js                   ← Claude Haiku 4.5 sentiment classifier
│   │
│   ├── bz/                                ← BZ! (Brent Crude NYMEX:BZ1!) instrument
│   │   ├── analyze.js                     ← 4H→1H→30M sweep + Catalyst card + trade plan
│   │   ├── trigger-check.js               ← session-aware 1-min zone poller
│   │   ├── news-watch.js                  ← AIS WebSocket + RSS monitor (pm2 process)
│   │   └── weekly-report.js               ← Sunday 5pm ET war report → #bz!-weekly-war-report
│   │
│   ├── weather/                           ← Billy Sherbert — Polymarket weather signal bot
│   │   ├── market-scan.js                 ← main scanner (every 30 min)
│   │   ├── settle.js                      ← NOAA settlement resolver
│   │   ├── weekly-report.js               ← Sunday 18:00 UTC P&L report → #weather-backtest
│   │   ├── analyze-performance.js         ← on-demand deep analysis (!performance command)
│   │   ├── exit-monitor.js                ← open position early-exit tracker
│   │   ├── post-welcome.js                ← (re)post #weather-signals welcome messages
│   │   ├── setup-discord.js               ← first-time Discord channel setup
│   │   ├── setup-mongo-windows.ps1       ← Windows one-time MongoDB + Docker setup
│   │   └── schedule-windows.ps1          ← Windows Task Scheduler setup (staging env)
│   │
│   ├── discord-bot/                       ← multi-channel Discord bot
│   │   ├── index.js                       ← main entry: poll channels, route, handle reactions
│   │   ├── router.js                      ← channel prefix → handler mapping
│   │   └── handlers/
│   │       ├── btc.js                     ← BTC commands (!analyze, !trades, !status)
│   │       ├── bz.js                      ← BZ! commands (!analyze, !report, !trades, !took, !take, !exit)
│   │       ├── weather.js                 ← Billy Sherbert commands (!scan, !analyze, !report, !trades, !took, !exit, !performance)
│   │       └── shared.js                  ← cross-channel commands (!stop, !start)
│   │
│   ├── trigger-check.js                   ← BTC zone poller (every 10m)
│   ├── mtf-analyze.js                     ← BTC 4-TF CDP sweep
│   ├── weekly-report.js                   ← BTC Monday performance report
│   ├── weekly-war-report.js               ← BTC Sunday war report
│   └── discord-notify.sh                  ← Discord webhook poster (5 alert types)
│
├── docs/                                  ← documentation
├── strategies/                            ← setup criteria and analysis protocols
├── analysis/                              ← timestamped analysis outputs (gitignored)
├── logs/                                  ← cron + pm2 logs (gitignored)
├── trades.json                            ← BTC signals + outcomes (gitignored)
├── bz-trades.json                         ← BZ! signals + outcomes (gitignored)
├── weather-trades.json                    ← Billy Sherbert signals + outcomes (gitignored)
└── tradingview-mcp/                       ← TradingView MCP server (Claude Desktop only)
```

---

## Cron Schedule

```
*/10 * * * *   trigger-check.js              — BTC zone trigger + outcome updates
*/1  * * * *   discord-bot/index.js          — multi-channel bot (all instruments)
*/1  * * * *   bz/trigger-check.js           — BZ! zone poller (self-throttles off-session)
0    9 * * 1   weekly-report.js              — BTC Monday 09:00 UTC → #btc-backtest
0   14 * * 0   weekly-war-report.js          — BTC Sunday 14:00 UTC → #btc-weekly-war-report
0   21 * * 0   bz/weekly-report.js           — BZ! Sunday 21:00 UTC (17:00 ET) → #bz!-weekly-war-report
*/30 * * * *   weather/market-scan.js        — Billy Sherbert Polymarket scan
0   18 * * 0   weather/weekly-report.js      — Billy Sherbert Sunday 18:00 UTC → #weather-backtest
```

View: `crontab -l` (macOS/Linux) | Task Scheduler (Windows)

---

## pm2 Processes

```
bz-news-watch   — AIS WebSocket + RSS monitor, self-healing, persistent
```

Commands:
```bash
pm2 status                    # check running processes
pm2 logs bz-news-watch        # live log stream
pm2 restart bz-news-watch     # restart after config change
```

---

## Discord Channels & Commands

### BTC (`#btc-*` channels)
| Command | Action |
|---|---|
| `!analyze` / `!mtf` | On-demand 12H→4H→1H→30M sweep |
| `!trades` | List open signals + last 5 closed |
| `!status` | Post system briefing to #general |
| `!stop` / `!start` | Pause / resume all notifications |
| 📊 reaction | Re-run analysis as a reply to that signal |

### BZ! (`#bz!-*` channels)
| Command | Action |
|---|---|
| `!analyze [context]` | On-demand 4H→1H→30M sweep with optional sentiment context |
| `!report` | Generate weekly war report immediately |
| `!trades` | List open BZ! signals + last 5 closed with win rate |
| `!took <id>` | Log your entry on a signal |
| `!take <price>` | Log a partial close (runner stays open) |
| `!exit tp1\|tp2\|tp3\|stop\|manual <price>` | Close trade, log outcome |
| `!stop` / `!start` | Pause / resume all notifications |

### Billy Sherbert (`#weather-*` channels)
| Command | Action |
|---|---|
| `!scan` | Run market-scan.js immediately |
| `!settle` | Run settle.js to close expired trades |
| `!report` | Post weekly report + recalibrate bias corrections |
| `!performance [--days N]` | Deep analysis across all resolved trades |
| `!trades` | List open positions |
| `!took <id>` | Log a paper entry on a signal |
| `!exit <id> win\|loss\|manual` | Close a paper trade |
| `!stop` / `!start` | Pause / resume signal posting |

---

## Indicator Stack

### BTC (BINANCE:BTCUSDT.P)
| Indicator | Purpose |
|---|---|
| Visible Range Volume Profile | Primary zone source — HVN, POC, VAH, VAL |
| Session Volume Profile | Intraday bias — Up/Down ratio |
| VWAP | Institutional price benchmark |
| Cumulative Volume Delta | Order flow divergence |
| Open Interest | Futures positioning conviction |

### BZ! (NYMEX:BZ1!)
| Indicator | Purpose |
|---|---|
| Smart Money Concepts [LuxAlgo] | Supply/demand zones, BOS, CHoCH |
| Session Volume Profile | Session bias |
| VWAP | Directional bias (above = bullish) |
| Cumulative Volume Delta | Order flow |
| Open Interest | Positioning |

---

## System Status

| Component | Status |
|---|---|
| **BTC** | |
| Zone detection + trade plan | ✅ Live |
| Bar-accurate outcome tracking | ✅ Live |
| 30M confirmation tracking | ✅ Live |
| Weekly performance report | ✅ Live |
| Sunday war report | ✅ Live |
| `!analyze` / `!trades` / 📊 reaction | ✅ Live |
| `!took` / `!exit` execution tracking | 🔲 Built, pending Phase 1 validation |
| **BZ!** | |
| Session-aware zone poller (1-min) | ✅ Live |
| AIS tanker monitoring (Fujairah/Jebel Ali) | ✅ Live |
| RSS news monitoring (7 feeds, 60s) | ✅ Live |
| Claude Haiku sentiment classification | ✅ Live |
| Full trade plan + Catalyst card | ✅ Live |
| `!analyze [context]` via Discord | ✅ Live |
| `!took` / `!take` / `!exit` tracking | ✅ Live |
| Sunday 5pm ET war report | ✅ Live |
| Geopolitical flag (BZ_GEOPOLITICAL_FLAG) | ✅ Active |
| **Billy Sherbert** | |
| Polymarket temperature market scanner | ✅ Live (staging) |
| GFS/ECMWF/ICON ensemble forecast | ✅ Live |
| Stage 1 Haiku AI filter | ✅ Live |
| Stage 2 Sonnet deep analysis | 🔲 Built, gated behind WEATHER_DEEP_ANALYSIS=true |
| NOAA settlement resolver | ✅ Live |
| `!trades` / `!took` / `!exit` tracking | ✅ Live |
| Weekly P&L report | ✅ Live |
| Phase B live execution | 🔲 Pending ≥20 resolved trades + 55%+ WR |
