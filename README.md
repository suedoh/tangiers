# Ace Trading System v1.3.0

Automated multi-instrument signal detection for **BTC/USDT perpetual futures**, **Brent Crude (BZ!)**, and **Polymarket BTC 5-min predictions**.

Every minute the system connects to TradingView Desktop via CDP, reads price zones, CVD, OI, Session VP, and VWAP, evaluates setup criteria rule-by-rule, and posts complete trade plans to Discord — entry, stop, three TP targets, R:R ratios, and a quality score. Every signal is auto-logged with bar-accurate outcome tracking. A weekly performance report posts every Monday (BTC) and Sunday 5pm ET (BZ!). Type `!analyze` in any instrument channel for an on-demand sweep.

**BZ! adds:** session-aware 1-min polling, AIS WebSocket tanker monitoring (Fujairah/Jebel Ali anchorages as Hormuz proxy), RSS feed monitoring across 7 sources, Claude Haiku sentiment classification, and a Sunday institutional war report with geopolitical scenarios.

**Poly BTC-5 adds:** 5-min directional signals for the Polymarket "Will BTC be higher in 5 minutes?" market. 6-factor scoring across 5M→1M→1H sweep (CVD momentum, VWAP, 1H structure, OI, clean air, session). Score ≥ 5/6 triggers a signal for high-probability setups. Market URL auto-discovered hourly via Polymarket Gamma API. Full forward-test logging with outcome tracking and Monday weekly reports.

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
│   ├── discord-bot/                       ← multi-channel Discord bot
│   │   ├── index.js                       ← main entry: poll channels, route, handle reactions
│   │   ├── router.js                      ← channel prefix → handler mapping
│   │   └── handlers/
│   │       ├── btc.js                     ← BTC commands (!analyze, !trades, !status)
│   │       ├── bz.js                      ← BZ! commands (!analyze, !report, !trades, !took, !take, !exit)
│   │       ├── poly-btc-5.js              ← Poly BTC-5 commands (!analyze, !trades, !status, !report)
│   │       ├── poly-btc-15.js             ← Poly BTC-15 commands (deprecated)
│   │       └── shared.js                  ← cross-channel commands (!stop, !start)
│   │
│   ├── poly/
│   │   ├── btc-5/                         ← Polymarket BTC 5-min module (active)
│   │   │   ├── trigger-check.js           ← cron: 5M bar scorer + signal poster
│   │   │   ├── analyze.js                 ← on-demand sweep (!analyze)
│   │   │   └── weekly-report.js           ← Monday 09:00 UTC performance report
│   │   └── btc-15/                        ← Polymarket BTC 15-min module (deprecated)
│   │       ├── trigger-check.js           ← (inactive — cron removed)
│   │       ├── analyze.js
│   │       ├── weekly-report.js
│   │       └── debug-studies.js           ← diagnostic: dump TradingView study names/values
│   │
│   ├── trigger-check.js                   ← BTC zone poller (every 10m)
│   ├── mtf-analyze.js                     ← BTC 4-TF CDP sweep
│   ├── discord-bot.js                     ← legacy BTC-only bot (superseded by discord-bot/)
│   ├── weekly-report.js                   ← BTC Monday performance report
│   ├── weekly-war-report.js               ← BTC Sunday war report
│   └── discord-notify.sh                  ← Discord webhook poster (5 alert types)
│
├── docs/                                  ← documentation
├── strategies/                            ← setup criteria and analysis protocols
├── analysis/                              ← timestamped analysis outputs (gitignored)
├── logs/                                  ← cron + pm2 logs (gitignored)
│   ├── trigger-check.log
│   ├── discord-bot.log
│   ├── bz-trigger.log
│   └── bz-weekly.log
├── trades.json                            ← BTC signals + outcomes (gitignored)
├── bz-trades.json                         ← BZ! signals + outcomes (gitignored)
├── poly-btc-15-trades.json                ← Poly BTC-15 bar evaluations + outcomes (gitignored)
├── my-trades.json                         ← BTC personal execution log (gitignored)
├── bz-my-trades.json                      ← BZ! personal execution log (gitignored)
└── tradingview-mcp/                       ← TradingView MCP server (Claude Desktop only)
```

---

## Refactor Log

The `refactors/` directory contains a plain-English audit trail of every significant bug fix, dead-code removal, or architectural change made to this codebase. Each file covers:

- **What changed** and where
- **Why it was wrong** (or why the old code couldn't work)
- **Risk assessment** — what, if anything, could behave differently

These are decision records, not summaries of diffs. They exist so future sessions (human or AI) can understand the *reasoning* behind a change without reconstructing it from commit history. When in doubt about why something looks the way it does, check here first.

---

## Cron Schedule

```
*/10 * * * *                    trigger-check.js             — BTC zone trigger + outcome updates
*/1  * * * *                    discord-bot/index.js         — multi-channel bot (all instruments)
*/1  * * * *                    bz/trigger-check.js          — BZ! zone poller (self-throttles off-session)
1,6,11,16,21,26,31,36,41,46,51,56 * * * *  poly/btc-5/trigger-check.js  — Poly BTC-5 bar scorer (1 min after bar open)
0    9 * * 1                    weekly-report.js             — BTC Monday 09:00 UTC → #btc-backtest
0    9 * * 1                    poly/btc-5/weekly-report.js  — Poly Monday 09:00 UTC → #poly-btc-5-report
0   14 * * 0                    weekly-war-report.js         — BTC Sunday 14:00 UTC → #btc-weekly-war-report
0   21 * * 0                    bz/weekly-report.js          — BZ! Sunday 21:00 UTC (17:00 ET) → #bz!-weekly-war-report
```

View: `crontab -l`

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

### Poly BTC-5 (`#poly-btc-5` channels)
| Command | Action |
|---|---|
| `!analyze` | On-demand 5M→1M→1H sweep, always posts score + probability |
| `!trades` | Last 20 bar evaluations with prediction, score, outcome, correct |
| `!status` | Current bar score + overall win rate |
| `!report` | Generate weekly performance report immediately |

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

### Poly BTC-5 (BINANCE:BTCUSDT.P)
| Indicator | TF | Purpose |
|---|---|---|
| Visible Range Volume Profile | 5M | Clean air check — POC/VAH/VAL proximity |
| VWAP | 5M | Price above/below VWAP (>0.15% threshold) |
| Cumulative Volume Delta | 5M | CVD trend vs prior bar (rising/falling) |
| Open Interest | 5M | Rising OI = new positioning conviction |
| OHLCV (micro momentum) | 1M | Price momentum — last 3 closes direction |
| OHLCV (macro structure) | 1H | Higher highs/lows or lower lows/highs |

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
| **Poly BTC-5** | |
| 5M bar scorer + signal poster (score ≥ 5/6) | ✅ Live |
| Bar-accurate outcome tracking | ✅ Live |
| Forward-test trade log | ✅ Live |
| Market URL auto-discovery (Gamma API, hourly) | ✅ Live |
| Monday weekly performance report | ✅ Live |
| `!analyze` / `!trades` / `!status` / `!report` | ✅ Live |
