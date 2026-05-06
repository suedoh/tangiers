# Weathermen — Claude Instructions

## What & Where
Polymarket weather market scanner. Finds mispriced temperature bucket markets, calculates model edge %, posts signals to Discord.

**Branch:** `weathermen` | **Repo:** `suedoh/tangiers`
**Working dir:** `D:\Tangiers\tangiers\.claude\worktrees\nifty-visvesvaraya-4334ea`
**Env:** `ENVIRONMENT=staging`, `PRIMARY=true`, Windows (Task Scheduler, not cron)

## Key Files
| File | Purpose |
|---|---|
| `scripts/weather/market-scan.js` | Main scanner — scans Polymarket, fires signals |
| `scripts/lib/forecasts.js` | Forecast engine (5 models + GFS ensemble + NCEI) |
| `scripts/weather/weekly-report.js` | Sunday 18:00 P&L report → #weather-backtest |
| `scripts/discord-bot/handlers/weather.js` | !scan !analyze !report !trades !took !exit |
| `scripts/discord-bot/router.js` | Channel ID → handler routing (staging-aware) |
| `scripts/discord-bot/index.js` | Polls Discord every 1 min, routes commands |
| `scripts/weather/schedule-windows.ps1` | Task Scheduler setup (run as Admin to update) |
| `weather-trades.json` | All signals + outcomes (auto-created, gitignored) |

## Forecast Stack
GFS 31-member ensemble (40%) + ECMWF AIFS/IFS · ICON · GFS · HRRR/US (35%) + NCEI GHCN-Daily historical (25%). All free via Open-Meteo. NCEI token: `WlFJMUfbBpbJAWEziBBHczvcLudBVgUw`.

## Discord (staging)
Bot: Billy Sherbert | #weather-signals: `1496769012368019457` | #weather-backtest: `1496769015962665041`
Uses `DISCORD_BOT_TOKEN_STAGING` + `*_STAGING` channel/webhook env vars. Message Content Intent must be enabled in Developer Portal.

## Task Scheduler
3 tasks run via silent VBS launchers (`scripts/weather/run-*.vbs`):
- **Weathermen-Scan** — every 30 min
- **Weathermen-Bot** — every 1 min
- **Weathermen-Report** — Sundays 18:00

Re-run `schedule-windows.ps1` as Admin after any task config change.

## Rules
- Never hardcode absolute paths — use `ROOT` from `scripts/lib/env.js`
- Commit and push after every significant change
- Only work within the project directory
