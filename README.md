# Ace Trading System

Automated trade setup detection for **BTC/USDT perpetual futures** on Binance.

Every 10 minutes the system connects to TradingView Desktop via CDP, reads **Visible Range Volume Profile** levels (HVN, POC, VAH, VAL) along with CVD, OI, Session VP, and VWAP, evaluates setup criteria rule-by-rule, and posts a complete trade plan to Discord — entry, stop, three TP targets, R:R ratios, a criteria checklist, and a probability score (28–91%). Every signal is logged to `trades.json` with bar-accurate outcome tracking. A weekly performance report posts every Monday. Type `!analyze` in Discord (or react 📊 to any alert) for an on-demand 12H→4H→1H→30M sweep.

**Zero AI in the automated pipeline.** All logic is deterministic rules. No API keys, no subscription cost, no token usage.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the system works — pipeline diagram, CDP design, VRVP zone source, trade lifecycle |
| [docs/setup.md](docs/setup.md) | Prerequisites, installation, TradingView layout, cron setup, troubleshooting |
| [docs/discord-commands.md](docs/discord-commands.md) | All bot commands: `!analyze`, `!trades`, `!stop`/`!start`, 📊 emoji reaction, Phase 2 |
| [docs/notifications.md](docs/notifications.md) | All 8 alert types with example output |
| [docs/performance-tracking.md](docs/performance-tracking.md) | Trade lifecycle, three-track report, Phase 1/2/3 status |
| [docs/progressive-enhancements.md](docs/progressive-enhancements.md) | Roadmap to institutional-grade trading desk (Tier 1–4) |
| [BACKTESTING.md](BACKTESTING.md) | Strategy overview, confirmation mechanics, exact Phase 2 activation steps |
| [TODO.md](TODO.md) | Outstanding tasks, known limitations |
| [strategies/smc-setups.md](strategies/smc-setups.md) | Setup criteria: entry triggers, stops, targets, invalidation |
| [strategies/mtf-analysis.md](strategies/mtf-analysis.md) | Manual MTF analysis protocol for Claude Desktop sessions |
| [strategies/risk-management.md](strategies/risk-management.md) | Position sizing, R:R rules, partial exit strategy |

---

## Quick Start

```bash
# 1. Install dependencies
git clone --recurse-submodules https://github.com/YOUR_USERNAME/trading.git
cd trading && make deps

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in Discord webhooks and bot token (see docs/setup.md)

# 3. Set up TradingView Ace layout (see docs/setup.md Step 3)

# 4. Install cron jobs
make cron

# 5. Test
bash scripts/discord-notify.sh info "Ace online"
node scripts/trigger-check.js
```

See [docs/setup.md](docs/setup.md) for complete setup instructions.

---

## File Structure

```
/trading/
├── README.md                         ← this file
├── CLAUDE.md                         ← instructions loaded in every Claude session
├── BACKTESTING.md                    ← backtesting strategy, phases, lifecycle
├── TODO.md                           ← outstanding tasks and known issues
├── .env                              ← secrets (gitignored, never commit)
├── .env.example                      ← template
├── .trigger-state.json               ← zone cooldowns, OI history, signal IDs (gitignored)
├── trades.json                       ← all signals + bar-accurate outcomes (gitignored)
├── my-trades.json                    ← your personal execution log, Phase 2 (gitignored)
├── .discord-bot-state.json           ← last-seen Discord message ID (gitignored)
│
├── scripts/
│   ├── trigger-check.js              ← main cron: VRVP zone check + trade plan (every 10m)
│   ├── mtf-analyze.js                ← 4-TF CDP sweep: all indicators, probability, trade plan
│   ├── discord-bot.js                ← Discord bot: commands + emoji reactions (every 1m)
│   ├── weekly-report.js              ← Monday performance report → #btc-backtest
│   ├── weekly-war-report.js          ← Sunday war report → #btc-weekly-war-report
│   └── discord-notify.sh             ← Discord webhook poster (5 alert types)
│
├── docs/
│   ├── architecture.md               ← pipeline diagram + design decisions
│   ├── setup.md                      ← full setup guide + troubleshooting
│   ├── discord-commands.md           ← all bot commands
│   ├── notifications.md              ← all alert types with examples
│   ├── performance-tracking.md       ← trade lifecycle + backtesting phases
│   └── progressive-enhancements.md  ← roadmap to institutional-grade desk
│
├── strategies/
│   ├── smc-setups.md                 ← setup criteria (entry, stop, TP, invalidation)
│   ├── mtf-analysis.md               ← manual analysis protocol for Claude Desktop
│   └── risk-management.md            ← position sizing and R:R rules
│
├── analysis/                         ← timestamped analysis outputs (gitignored)
├── logs/                             ← cron logs (gitignored, auto-created)
└── tradingview-mcp/                  ← TradingView MCP server (Claude Desktop only)
```

---

## Cron Schedule

```
*/10 * * * *   trigger-check.js    — zone trigger + outcome updates
*/1  * * * *   discord-bot.js      — !analyze, !trades, emoji reactions
0    9 * * 1   weekly-report.js    — Monday 09:00 UTC → #btc-backtest
0   14 * * 0   weekly-war-report.js — Sunday 14:00 UTC → #btc-weekly-war-report
```

Install: `make cron` | View: `crontab -l`

---

## Make Commands

```bash
make deps          # Install all npm dependencies
make cron          # Install cron jobs
make test          # Run the trigger check once
make analyze       # Run MTF analysis (posts to Discord)
make bot           # Run discord-bot once
make bot-logs      # Tail discord-bot.log
make report        # Run weekly report (7 days)
make report-30     # Run weekly report (30 days)
make war-report    # Run weekly war report
make test-discord  # Test Discord webhook
make logs          # Tail trigger-check.log
```

---

## Chart Setup

- **Layout:** `🕵Ace` (saved in TradingView)
- **Symbol:** `BINANCE:BTCUSDT.P` (Binance perpetual futures — not spot, not BloFin)
- **Default timeframe:** 30M

| Indicator | Purpose |
|---|---|
| Visible Range Volume Profile | Primary zone source — HVN, POC, VAH, VAL |
| Session Volume Profile | Intraday bias — Up/Down ratio |
| Volume | Confirmation of moves |
| VWAP | Institutional price benchmark |
| Cumulative Volume Delta | Order flow — divergence = institutional activity |
| Open Interest | Futures positioning — rising OI = conviction |

**CDP:** TradingView Desktop must run with `--remote-debugging-port=9222`. This is automatic when Claude Desktop is running. See [docs/setup.md](docs/setup.md) for manual launch instructions.

---

## System Status

| Component | Status |
|---|---|
| Zone detection (VRVP) | ✅ Live |
| Bar-accurate outcome tracking | ✅ Live |
| Confirmation tracking (30M close) | ✅ Live |
| Weekly performance report (3-track) | ✅ Live |
| `!analyze` / `!trades` / `!stop` / `!start` | ✅ Live |
| 📊 emoji reaction → threaded MTF analysis | ✅ Live |
| Sunday war report | ✅ Live |
| `!took` / `!exit` execution tracking (Phase 2) | 🔲 Built, not yet active |
| Per-bar CVD confirmation (Phase 3) | ❌ Not built |
