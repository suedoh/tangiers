# Tangiers — Claude Instructions

## What Is Tangiers?

Tangiers is the **Ace Trading System** — an automated multi-instrument trade setup detection and alerting platform running on macOS. It monitors **BTC/USDT perpetual futures** (Binance), **Brent Crude futures (BZ!)** (NYMEX), and **Polymarket BTC 5-min directional predictions**, detects high-probability setups via TradingView Desktop, and delivers structured trade plans to Discord. Zero AI usage in the automated pipeline (except BZ! sentiment classification) — all signal rules are deterministic.

---

## Three Instruments, Three Pipelines

| | **BTC** | **BZ! (Brent Crude)** | **Poly BTC-5** |
|---|---|---|---|
| Symbol | `BINANCE:BTCUSDT.P` | `NYMEX:BZ1!` | `BINANCE:BTCUSDT.P` |
| Zone/signal source | VRVP levels | LuxAlgo SMC boxes | 6-factor score (CVD, VWAP, OI, structure, clean air, session) |
| Trigger script | `scripts/trigger-check.js` | `scripts/bz/trigger-check.js` | `scripts/poly/btc-5/trigger-check.js` |
| Analysis script | `scripts/mtf-analyze.js` | `scripts/bz/analyze.js` | `scripts/poly/btc-5/analyze.js` |
| Poll frequency | Every 10 min | Every 1 min (session-gated) | Every 5 min (1 min after bar open) |
| Signal threshold | Zone proximity | Zone proximity + quality score | Score ≥ 5/6 |
| TF sweep | 12H→4H→1H→30M | 4H→1H→30M | 5M primary → 1M momentum → 1H structure |
| Session gating | None | Skips NYMEX close 5–6pm ET | Active 08–21 UTC (scored, not gated) |
| Extra intelligence | — | AIS tanker monitoring + RSS news | Polymarket CLOB entry-price capture per signal (bid/ask/spread for $-EV) |
| Sentiment | None | Claude Haiku 4.5 (on trigger) | None |
| Discord channels | `#btc-*` | `#bz!-*` | `#poly-btc-5*` |

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
│   ├── lib/                            ← shared utilities
│   │   ├── env.js                      ← .env loader, ROOT path
│   │   ├── cdp.js                      ← TradingView CDP: connect, symbol/TF, price, studies, boxes, ATR
│   │   ├── lock.js                     ← file-based mutex at .tradingview-lock (prevents CDP conflicts)
│   │   ├── discord.js                  ← shared webhook poster (6 alert types)
│   │   ├── zones.js                    ← classifyZones(), nearestZones(), session cooldowns
│   │   ├── sentiment.js               ← Claude Haiku 4.5 sentiment classifier (BZ only)
│   │   ├── polymarket.js              ← Polymarket CLOB: per-bar slug, token resolution, order-book reads
│   │   └── binance.js                 ← Binance Futures REST: ground-truth klines for Poly outcome resolution
│   │
│   ├── bz/                             ← BZ! (Brent Crude) instrument
│   │   ├── trigger-check.js            ← 1-min session-aware zone poller
│   │   ├── analyze.js                  ← 4H→1H→30M sweep + Catalyst card + trade plan
│   │   ├── news-watch.js              ← AIS WebSocket + RSS monitor (pm2 process)
│   │   └── weekly-report.js           ← Sunday 5pm ET war report → #bz!-weekly-war-report
│   │
│   ├── poly/
│   │   ├── btc-5/                      ← Polymarket BTC 5-min module (active)
│   │   │   ├── trigger-check.js        ← 5-min bar scorer, signals at ≥5/6, outcome tracking
│   │   │   ├── analyze.js              ← on-demand sweep (!analyze), always posts score
│   │   │   └── weekly-report.js       ← Monday 09:00 UTC performance report
│   │   └── btc-15/                     ← deprecated (15-min Polymarket market no longer exists)
│   │
│   ├── discord-bot/                    ← multi-channel Discord bot (all instruments)
│   │   ├── index.js                    ← main entry: polls channels, handles reactions
│   │   ├── router.js                   ← channel prefix → handler (add new instrument here)
│   │   └── handlers/
│   │       ├── btc.js                  ← !analyze, !trades, !status
│   │       ├── bz.js                   ← !analyze, !report, !trades, !took, !take, !exit
│   │       ├── poly-btc-5.js          ← !analyze, !trades, !status, !report
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
├── poly-btc-5-trades.json             ← Poly BTC-5 bar evaluations + outcomes (gitignored, auto-created)
├── .trigger-state.json                 ← BTC: zone cooldowns, OI history, reclaim list, signal IDs
├── .bz-trigger-state.json              ← BZ: zone cooldowns, signal IDs
├── .bz-news-state.json                 ← BZ news monitor: seen articles, AIS history/baseline
├── .discord-bot-state.json            ← Discord bot: last-seen message IDs per channel
├── .poly-btc-5-state.json             ← Poly BTC-5: last bar fired, CVD prev, OI prev, signal message IDs (14d TTL)
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

### `scripts/poly/btc-5/trigger-check.js` — Poly BTC-5 Bar Scorer
- Runs **1 minute after each 5-min bar open** (`1,6,11,16,21,26,31,36,41,46,51,56 * * * *`)
- Deduplicates by bar boundary: only fires once per `floor(minute/5)*5` bar
- **TF sweep**: 5M (VWAP, CVD, VRVP) → 1M (3 closes for micro momentum) → 1H (3 bars for structure)
- **5 factors scored** (CVD worth 0–2 pts, others 1pt; max score = 6):
  - CVD: 1M momentum + CVD delta vs prior state (2pts if both agree, 1pt if momentum only)
  - VWAP: price >0.15% above/below VWAP (directional)
  - 1H structure: HH/HL or LL/LH over last 3 hourly bars (directional)
  - Clean air: price not within 0.3% of VRVP POC/VAH/VAL
  - Session: 08–21 UTC
  - (OI factor removed 2026-05-12 — −17.2pp lift on backtest)
- **Signal fires if score ≥ 5/6** — posts to `#poly-btc-5` with direction, probability, factor breakdown, **Polymarket entry book line** (bid/ask/spread)
- **Outcome resolution**: every cycle, loops over ALL signaled bars with `outcome=null` and `barOpen` ≥ 6 minutes old; resolves via Binance Futures REST (`/fapi/v1/klines`). No TV dependency for outcomes — works when chart is offline. Self-heals cron skips.
- **Polymarket entry capture**: at signal-fire, fetches CLOB order book for the bet side using `slugForBar(barOpen)` (deterministic — `btc-updown-5m-<epochSec>`). Writes `entryBid/entryAsk/entryMid/entrySpreadBps` to the trade record. Null on CLOB outage; signal still fires.
- **Backtest log**: posts a one-line entry to `#poly-btc-5-backtest` at outcome resolution — `✅ 10:05 UTC · UP 5/6 · $76,934 · entry 0.32 → +0.68 · CVD+VWAP+1H+Clean+Session`
- State: `.poly-btc-5-state.json` (CVD prev, last bar fired, signal message IDs with 14d TTL)
- Lock: `'poly-btc-5'`

### `scripts/poly/btc-5/analyze.js` — Poly BTC-5 On-Demand
- Triggered by `!analyze` Discord command or manually
- Same 5M→1M→1H sweep; no state/dedup — always posts current bar score regardless of threshold
- CVD limited to 1M momentum only (no prior CVD in state → max 1pt for CVD factor)
- Probability displayed as `min(88, 50 + |upScore − downScore| × 9)`
- Lock: `'poly-analyze-5'`

### `scripts/discord-bot/index.js` — Multi-Channel Bot
- Runs every **1 minute** via crontab
- Polls all registered channels for commands and 📊 emoji reactions
- Routes by channel prefix (`btc-*` → btc handler, `bz-*` → bz handler)
- Reaction tracking: reads `_signal_messages` from `.trigger-state.json` / `.bz-trigger-state.json`
- Respects rate limits: 1.1s between reaction API calls, max 6 checks per run

### `scripts/ew/run.js` — EW Scheduled Analysis
- Cron: 6×/day at 4H bar close +5min (`5 0,4,8,12,16,20 * * *`)
- Acquires `.tradingview-lock` mutex (competes with trigger-check & bz)
- `cdpConnect('EW')` — finds EW tab by title match; never touches `🕵Ace`
- Cycles 1D → 4H → 1H via `setTimeframe`; reads Pine pivot data via `getPineLabels('EW-DATA')` + study values + `captureScreenshot` per TF
- Validates EW rules in JS (`validateImpulse`), computes tiered invalidation (hard/soft/truncation), confidence (Bayesian-flavored), confluence flag, stability vs prior run
- Confidence floor 0.50 → ambiguous post when not met (no forced low-conf calls)
- Posts to `#btc-ew-signals` via multipart webhook with all 3 screenshots inline
- Persists to `ew-forecasts.json` (schema-identical to future Mongo `wave_forecasts`)
- `!ew` Discord handler invokes the same script with `--manual --user=...`

### `scripts/ew/backtest.js` — EW Lifecycle Tracker
- Cron: +5min after each run (`10 0,4,8,12,16,20 * * *`)
- Reads BTCUSDT price + 5m klines via Binance Futures public API (no CDP/TV needed)
- Walks open forecasts × {1D,4H,1H} × {primary,alternate}
- Detects hard / soft / truncation crossings + Fib target hits (1.0×, 1.618×, 2.618×W1)
- Posts state-transition events to `#btc-ew-backtest` with original generation-time screenshot re-attached
- Updates calibration buckets (50/60/70/80/90 conf bands per TF+slot) in `.ew-state.json`
- Auto-expires forecasts older than 7 days

### `scripts/ew/daily-summary.js`, `daily-brief.js`, `weekly-outlook.js`, `monthly-review.js`
- All template-rendered (no LLM, no MCP) — preserves the project's no-LLM-in-cron rule
- daily-summary @ 23:55 UTC → stats + calibration table → `#btc-ew-backtest`
- daily-brief @ 12:15 UTC → narrative morning brief → `#btc-ew-report` (with screenshots)
- weekly-outlook @ Sun 22:00 UTC → week-in-review + count-evolution screenshot strip
- monthly-review @ 1st of month 14:00 UTC → cycle-degree commentary + ~4 screenshots

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

### Indicator Stack — Poly BTC-5 (BTCUSDT.P tab, same as BTC)
Poly BTC-5 uses the same TradingView tab as BTC but sweeps three timeframes.

| Indicator | TF | What's read |
|---|---|---|
| Visible Range Volume Profile | 5M | POC, VAH, VAL — clean air check (0.3% proximity) |
| VWAP | 5M | Price vs VWAP (>0.15% threshold for directional score) |
| Cumulative Volume Delta | 5M | CVD value — stored in state, delta vs prior bar = trend direction |
| Open Interest | 5M | OI value — rising vs prior bar |
| OHLCV (micro momentum) | 1M | Last 3 closes: consecutive direction |
| OHLCV (macro structure) | 1H | Last 3 bars: HH/HL or LL/LH pattern |

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
| `POLY_BTC_5_SIGNALS_WEBHOOK` | `#poly-btc-5` | Poly BTC-5 signals, analysis, errors |
| `POLY_BTC_5_REPORT_WEBHOOK` | `#poly-btc-5-report` | Poly BTC-5 Monday weekly report |
| `POLY_BTC_5_BACKTEST_WEBHOOK` | `#poly-btc-5-backtest` | Per-signal outcome lines (one per resolved signal) |

### Bot Channel IDs (set in `.env`)
`DISCORD_CHANNEL_ID`, `BZ_DISCORD_SIGNALS_CHANNEL_ID`, `BZ_DISCORD_WAR_REPORT_CHANNEL_ID`, `BZ_DISCORD_BACKTEST_CHANNEL_ID`, `POLY_BTC_5_SIGNALS_CHANNEL_ID`, `POLY_BTC_5_REPORT_CHANNEL_ID`, `POLY_BTC_5_BACKTEST_CHANNEL_ID`, `BTC_EW_SIGNALS_CHANNEL_ID`, `BTC_EW_BACKTEST_CHANNEL_ID`, `BTC_EW_REPORT_CHANNEL_ID`

### BTC Elliott Wave (EW) channels
| Variable | Channel | Used by |
|---|---|---|
| `BTC_EW_SIGNALS_WEBHOOK` | `#btc-ew-signals` | `ew/run.js` (scheduled + `!ew`) |
| `BTC_EW_BACKTEST_WEBHOOK` | `#btc-ew-backtest` | `ew/backtest.js`, `ew/daily-summary.js` |
| `BTC_EW_REPORT_WEBHOOK` | `#btc-ew-report` | `ew/daily-brief.js`, `ew/weekly-outlook.js`, `ew/monthly-review.js` |

EW lives in its own TradingView Desktop tab on the **`EW` layout**
(separate from `🕵Ace`). The `EW` layout has `BINANCE:BTCUSDT.P` plus
the custom Pine indicator (`scripts/pine/elliott-wave.pine`) + VWAP +
CVD + Volume. The cron pipeline reads it via `cdpConnect('EW')` and
never touches the Ace tab. See `strategies/elliott-wave.md` for the
full operator guide.

### Poly BTC-5 env vars
| Variable | Purpose |
|---|---|
| `POLY_BTC_5_SIGNALS_WEBHOOK` | Webhook for signals + analysis + errors |
| `POLY_BTC_5_REPORT_WEBHOOK` | Webhook for Monday weekly report |
| `POLY_BTC_5_BACKTEST_WEBHOOK` | Webhook for per-signal outcome lines |
| `POLY_BTC_5_SIGNALS_CHANNEL_ID` | Channel for bot polling (`!analyze`, `!summary`, `!trades`, `!status`) |
| `POLY_BTC_5_REPORT_CHANNEL_ID` | Channel for bot polling |
| `POLY_BTC_5_BACKTEST_CHANNEL_ID` | Channel for bot polling |
| `POLY_BTC_5_MARKET_URL` | Deprecated seed (kept for backwards compat). Live market URLs are now built per-bar from `slugForBar(barOpenMs)` — `btc-updown-5m-<epochSec>`. |

### Alert Types (6)
`approaching` (yellow) · `long` (green) · `short` (red) · `info` (blue) · `error` (dark red) · `catalyst` (orange, BZ only)

---

## Cron Schedule

Two surfaces since 2026-06-16: **host crontab** for CDP-bound triggers (they
need TradingView Desktop on `localhost:9222`, unreachable from Docker on
macOS), and **Docker `ace-cron` container** for everything else.

### Host crontab (CDP-bound — install via `make cron` + `make ew-cron`)

```
*/10 * * * *                                  scripts/trigger-check.js               — BTC zone trigger
*/1  * * * *                                  scripts/bz/trigger-check.js TZ=ET      — BZ! zone poller (session-gated)
1,6,11,16,21,26,31,36,41,46,51,56 * * * *    scripts/poly/btc-5/trigger-check.js   — Poly BTC-5 bar scorer
5   0,4,8,12,16,20 * * *                     scripts/ew/run.js                      — EW analysis 6×/day
```

View installed host jobs: `crontab -l`

### Docker `ace-cron` (everything else — `scripts/cron/ace.crontab`)

```
55  * * * *                                  scripts/migrate/import-trades.js       — Mongo sync hourly :55
*/3 * * * *                                  scripts/blofin/recon-once.js           — BloFin order recon every 3 min
*   * * * *                                  scripts/discord-bot/index.js           — multi-channel bot every minute
0   9 * * 1                                  scripts/weekly-report.js               — BTC Monday 09:00 UTC
0   14 * * 0                                 scripts/weekly-war-report.js           — BTC Sunday 14:00 UTC
0   21 * * 0                                 scripts/bz/weekly-report.js            — BZ! Sunday 21:00 UTC
0   9 * * 1                                  scripts/poly/btc-5/weekly-report.js   — Poly Monday 09:00 UTC
10  0,4,8,12,16,20 * * *                     scripts/ew/backtest.js                 — EW backtest 6×/day
55  23 * * *                                 scripts/ew/daily-summary.js            — EW daily stats post
15  12 * * *                                 scripts/ew/daily-brief.js              — EW daily narrative brief
0   22 * * 0                                 scripts/ew/weekly-outlook.js           — EW weekly outlook
0   14 1 * *                                 scripts/ew/monthly-review.js           — EW monthly review
0   13 * * 3                                 scripts/audit/run-mid-week-diff.sh     — Mid-week win-rate diff
```

Edit Docker schedule: `scripts/cron/ace.crontab` → `docker compose restart ace-cron`.
View Docker logs: `docker logs ace_cron`.

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
| `.poly-btc-5-state.json` | poly/btc-5/trigger-check.js | Last bar fired, CVD prev, signal message IDs (14d TTL) |
| `trades.json` | BTC pipeline | All BTC signals with lifecycle fields |
| `bz-trades.json` | BZ pipeline | All BZ! signals with lifecycle fields |
| `poly-btc-5-trades.json` | Poly BTC-5 pipeline | All 5-min bar evaluations: score, direction, signaled, outcome, correct |
| `.tradingview-lock` | lib/lock.js | Ephemeral mutex (deleted after each CDP session) |
| `ew-forecasts.json` | EW pipeline | All EW forecasts — schema-identical to future Mongo `wave_forecasts` collection |
| `.ew-state.json` | EW pipeline | Last run/backtest/brief timestamps, open forecast IDs, calibration buckets |

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

## Workflow

- **Commit and push after every significant change.** Bug fixes, new features, refactors — stage the relevant files and push to `main`. Don't wait to be asked.
- **Never hardcode absolute paths.** Use `__dirname`-relative `path.resolve()` so the code works on both the primary machine (`/Users/vpm/trading/`) and the partner's Windows install.
- **Partner machine** (`PRIMARY=false`, `TRADINGVIEW_ENABLED=false`): does not run crons, does not use TradingView Desktop or the MCP server. All CDP/TradingView code must be guarded by those flags or be in scripts that are never called on non-primary machines.
- **Only work within `~/trading/`.** Do not read or modify files outside this directory.

---

## MongoDB Migration — In Progress

**Plan file:** `refactors/mongodb-migration-plan.md`

### What's done (Phases 0–2, merged to main 2026-05-09)
- **Phase 0–1**: MongoDB 7.0 in Docker (`127.0.0.1:27017`), `scripts/lib/db.js` shared connection + collection accessors, `scripts/migrate/` import + index scripts. BTC structured `factors` field, sparse TTL on poly non-signaled bars, `wave_forecasts` separate collection.
- **Phase 2**: BTC and Poly BTC-5 weekly reports read from MongoDB (JSON files remain the canonical write path). BZ weekly-report untouched — it's a market-intel war report, not trade-based. Hourly sync cron at `:55` keeps Mongo at most 5 minutes stale before `:00` reports fire.

### Active sync cron
`55 * * * *  node scripts/migrate/import-trades.js >> logs/migrate.log`

Installed via `make cron`. Verify it's running: `crontab -l | grep migrate`

### Phase 3 — entry criteria (verify before starting)
- `tail -50 ~/trading/logs/migrate.log` — hourly upserts should show consistent pattern, no errors
- `tail ~/trading/logs/weekly-report.log` after Monday 09:00 UTC — should match historic cadence
- Verify factor correlation query against actual Discord report numbers
- If all clean: Phase 3 = trigger scripts write to MongoDB (poly → BZ → BTC last). Use Opus 4.7 + high effort for BTC (`trigger-check.js` is 1500+ lines with inline CDP).

### Remaining phases
| Phase | Work |
|---|---|
| 3 | Trigger scripts write to MongoDB — dual-write window. Poly first, BZ next, BTC last. |
| 4 | Containerize Discord bot, news-watch; remove from crontab/pm2 |
| 5 | Remove JSON dual-writes, archive `.json` files, update Makefile |

### Key constraints (don't forget these)
- CDP scripts (`trigger-check.js`, `bz/trigger-check.js`, `bz/analyze.js`) **must stay native** — Docker for Mac can't reach TradingView Desktop on `localhost:9222`. This is permanent.
- Native cron scripts connect to MongoDB via `127.0.0.1:27017`; Docker services would connect via `mongodb:27017` (internal network)
- **Weathermen** merge: `normalizeWeathermen()` hook already in `import-trades.js` (dormant). Expect conflicts in `db.js` exports and `import-trades.js` at merge time. PR `fix/pre-merge-weathermen` (#1) must land in weathermen branch first.
- Partner machine (`PRIMARY=false`): no MongoDB, no Docker needed — `PRIMARY` guard exits before any DB calls

### Docker quick-reference
```bash
docker compose up -d mongodb    # start mongodb (survives reboots via restart:unless-stopped)
docker compose up -d ace-cron   # start the scheduled-task host (all non-CDP cron jobs)
docker compose ps               # check health of both
docker compose down             # stop everything (data persists in volumes)
```

### ace-cron service (was audit-cron — renamed 2026-06-16)
`ace-cron` is a `node:20-alpine` container running busybox `crond`. It hosts every scheduled task that does NOT need TradingView CDP — Mongo sync, BloFin recon, Discord bot, all weekly reports, EW backtest/reports, mid-week audit. Connects to MongoDB on the internal Docker network (`mongodb:27017`).
- Crontab is the static file `scripts/cron/ace.crontab` (avoids YAML escape hell).
- The whole repo is bind-mounted at `/app` so scripts read `.env`, write logs, and access JSON/Mongo through the same paths as the host.
- Cron logs: `logs/<job>.log` (gitignored, bind-mounted to host).
- Manual one-off run: `docker compose exec ace-cron node /app/scripts/<path>`.
- Apply schedule changes: edit `scripts/cron/ace.crontab` → `docker compose restart ace-cron`.
- Mid-week audit output: `notes/audits/latest.txt` + `mid-week-diff-<utc-ts>.txt` (history). See `notes/README.md`.

---

## Adding a New Instrument

1. Create `scripts/{ticker}/trigger-check.js` and `scripts/{ticker}/analyze.js` (model on `scripts/bz/`)
2. Add webhook + channel ID vars to `.env.example`
3. Add two lines to `scripts/discord-bot/router.js`
4. Create `scripts/discord-bot/handlers/{ticker}.js`
5. Add cron entries via `Makefile`
