# Weathermen — Polymarket Weather Signal Bot

Automated scanner for mispriced temperature bucket markets on Polymarket. Fetches GFS/ECMWF/ICON ensemble forecasts, computes edge against market prices, and fires paper trade signals to Discord. Currently in **Phase A — signal validation** (paper trading only).

---

## How It Works

1. **`market-scan.js`** runs every 15 minutes — fetches active Polymarket temperature markets for all tracked cities, groups by city × date, gets one ensemble forecast per group, and signals the highest-edge bucket if edge ≥ 8%
2. **`settle.js`** resolves expired trades via GHCN-Daily → NWS METAR → Open-Meteo ERA5 (priority order), matching Polymarket's own settlement sources
3. **`weekly-report.js`** posts a Sunday 18:00 UTC P&L summary to `#weather-backtest`
4. **`analyze-performance.js`** on-demand deep analysis: bias correction impact, AI filter calibration, direction/side breakdown, shadow validation progress
5. **`exit-monitor.js`** tracks open positions for early exit opportunities

Signals route through a two-stage AI filter:
- **Stage 1 (Haiku)** — fast sanity check, flags structural issues, sets size multiplier
- **Stage 2 (Sonnet)** — 5-step deep analysis; gated behind `WEATHER_DEEP_ANALYSIS=true`

---

## File Structure

```
scripts/
├── weather/
│   ├── market-scan.js          ← main scanner (runs every 15 min via Task Scheduler)
│   ├── settle.js               ← NOAA settlement resolver
│   ├── weekly-report.js        ← Sunday weekly P&L report + bias recalibration
│   ├── analyze-performance.js  ← on-demand deep analysis (!performance command)
│   ├── exit-monitor.js         ← open position early-exit tracker
│   ├── post-welcome.js         ← (re)post the #weather-signals welcome/reference messages
│   └── setup-discord.js        ← first-time Discord channel setup
│
├── lib/
│   ├── env.js                  ← .env loader, ROOT path, resolveWebhook()
│   ├── forecasts.js            ← GFS/ECMWF/ICON ensemble fetch, probability math, settlement fetch
│   ├── polymarket.js           ← Polymarket API: market fetch, prices, Kelly sizing
│   ├── weather-analysis.js     ← Stage 1 (Haiku) + Stage 2 (Sonnet) AI analysis
│   ├── city-profiles.js        ← per-city station IDs, coordinates, TZ, GHCN station
│   ├── bias-corrections.json   ← per-city mean(observedTemp − modelMeanF); auto-updated weekly
│   └── discord.js              ← shared webhook poster
│
├── discord-bot/
│   ├── index.js                ← bot entry point (runs every 1 min via Task Scheduler)
│   ├── router.js               ← channel prefix → handler routing
│   └── handlers/
│       └── weather.js          ← all !commands for weather channels
│
.weather-state.json             ← cooldowns, signal IDs (auto-managed, gitignored)
weather-trades.json             ← all signals + outcomes (gitignored)
```

---

## Environment Variables

Copy `.env.example` to `.env`. Key variables:

| Variable | Purpose |
|---|---|
| `PRIMARY` | `true/false` — only one machine should post signals |
| `ANTHROPIC_API_KEY` | Claude Haiku (Stage 1) + Sonnet (Stage 2) |
| `NCEI_TOKEN` | NOAA NCEI — GHCN-Daily historical base rates (free at ncdc.noaa.gov/cdo-web/token) |
| `WU_API_KEY` | Weather Underground PWS observations (Stage 2, optional) |
| `WEATHER_DISCORD_SIGNALS_WEBHOOK` | `#weather-signals` channel |
| `WEATHER_DISCORD_BACKTEST_WEBHOOK` | `#weather-backtest` channel |
| `WEATHER_DISCORD_SIGNALS_CHANNEL_ID` | Bot polling — signals channel |
| `WEATHER_DISCORD_BACKTEST_CHANNEL_ID` | Bot polling — backtest channel |
| `WEATHER_MIN_EDGE` | Minimum edge to signal (default `0.08` = 8%) |
| `WEATHER_BANKROLL` | Paper bankroll for Kelly sizing (default `500`) |
| `WEATHER_KELLY_FRAC` | Fractional Kelly multiplier (default `0.15`) |
| `WEATHER_MAX_BET` | Hard cap per trade in USD (default `100`) |
| `WEATHER_DEEP_ANALYSIS` | Enable Stage 2 Sonnet analysis (default `false`) |
| `ENVIRONMENT` | `production` or `staging` |

---

## Discord Channels

| Channel | Webhook Variable | Purpose |
|---|---|---|
| `#weather-signals` | `WEATHER_DISCORD_SIGNALS_WEBHOOK` | Live edge alerts, deep-dive analysis cards |
| `#weather-backtest` | `WEATHER_DISCORD_BACKTEST_WEBHOOK` | Signal log, settlement cards, weekly report |

---

## Bot Commands

| Command | Where | What it does |
|---|---|---|
| `!scan` | signals | Run market-scan.js immediately |
| `!settle` | signals | Run settle.js to close expired trades |
| `!report` | backtest | Post weekly report + recalibrate bias corrections |
| `!performance [--days N]` | backtest | Deep analysis across all resolved trades (default 30d window) |
| `!trades` | either | List open positions |
| `!stop` / `!start` | either | Pause/resume signal posting |

---

## Scheduling (Windows Task Scheduler)

```
market-scan.js   — every 15 minutes
discord-bot      — every 1 minute
settle.js        — daily at 06:00 UTC
weekly-report.js — Sundays at 18:00 UTC
```

Use the `.vbs` helper scripts in `scripts/weather/` to launch Node.js silently from Task Scheduler.

---

## Settlement Data Sources

Resolution uses the same station network as Polymarket, in priority order:

1. **GHCN-Daily (NCEI CDO)** — authoritative; same ASOS stations Polymarket uses for US markets
2. **NWS Hourly METAR** — near real-time airport observations
3. **Open-Meteo ERA5** — gridded fallback; always available

---

## Signal Types

| Direction | Side | Notes |
|---|---|---|
| `above` | YES / NO | Temperature exceeds threshold |
| `below` | YES / NO | Temperature stays below threshold |
| `range` | NO only | Temperature lands in a 1–2°F window — YES+range **blocked** (structural model-accuracy problem; shadow-logged for validation) |

---

## Phase Status

| Phase | Description | Status |
|---|---|---|
| A | Signal validation — paper trading, bias correction, AI filter calibration | **Active** |
| B | Live execution — activate after ≥20 confirmed resolved trades with 55%+ WR | Pending |

Advance to Phase B when: `allResolved ≥ 20` AND `lifetimeWinRate ≥ 55%` AND bias corrections have converged (≥5 trades per city).

---

## Key Design Decisions

- **One forecast call per city/date group** — not per bucket market. Keeps API costs flat regardless of how many bucket markets exist per event.
- **YES+range blocked** — 13% all-time WR. Model mean error (~3°F) exceeds bucket width (1–2°F). Shadow-logging candidates meeting `sigmaF < 0.75°F AND |biasCorrection| < 2.0°F` for future filter validation. See TODO.md.
- **Bias corrections** — per-city mean(observedTemp − modelMeanF) applied to correctedMeanF before probability math. Updated weekly by `weekly-report.js`.
- **Blocked cities** — see `BLOCKED_CITIES` in `market-scan.js`. Each entry has a documented reason; don't remove without verifying the underlying issue is resolved.
- **Stage 2 gated** — Sonnet analysis is expensive. Keep `WEATHER_DEEP_ANALYSIS=false` until Phase B and API credits allow.
