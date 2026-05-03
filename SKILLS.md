# Weathermen — Skills Reference

## Common Tasks

```bash
make weather-scan                          # run market-scan.js once
make weather-analyze URL=https://poly...   # deep-dive one market by URL
make weather-analyze Q="Will NYC..."       # or by question text
make weather-report                        # generate weekly report now
make weather-clean                         # reset .weather-state.json + clear logs
```

Re-run `schedule-windows.ps1` as Admin after any Task Scheduler change.

---

## Pipeline Flow

`market-scan.js` groups Polymarket temperature markets by city+date → fetches one `getTemperatureForecast()` per group → calculates edge per bucket → Stage 1 Haiku quality filter (`weather-analysis.js`) → optional Stage 2 Sonnet deep analysis → posts signal card → writes `weather-trades.json` → updates `.weather-state.json` cooldown (4h per market).

---

## Key Functions

| Function | File | Returns |
|---|---|---|
| `getTemperatureForecast(lat, lon, date, opts)` | `scripts/lib/forecasts.js` | meanF, sigmaF, ensemble, models, historical, sources |
| `analyzeSignal(signal)` | `scripts/lib/weather-analysis.js` | decision / confidence / sizeMultiplier |
| `fetchWeatherMarkets()` | `scripts/lib/polymarket.js` | active markets grouped by event slug |
| `resolveWebhook(key)` | `scripts/lib/env.js` | webhook URL, auto-appends `_STAGING` when staging |

---

## State Files

| File | Owner | How to reset |
|---|---|---|
| `.weather-state.json` | market-scan | `make weather-clean` |
| `.discord-bot-state.json` | discord-bot | set to `{}` |
| `weather-trades.json` | market-scan + bot | do not reset — trade history |
| `scripts/lib/bias-corrections.json` | weekly-report (auto) | do not edit manually |

---

## Gotchas

- **Discord 2000-char limit** — `!trades` capped at 8 signals; signal cards must stay under limit
- **NCEI 1-year API limit** — `fetchGHCNBaseRate()` makes 12 parallel yearly requests to work around it
- **HRRR is US-only** — returns null internationally; weight normalization handles it silently
- **Extreme threshold mode** — `thresholdPercentile < 0.10 or > 0.90` flips model weights (AIFS down, IFS up)
- **bias-corrections.json** — auto-updated by weekly-report after resolved trades; do not edit manually
- **Bot watermark** — `.discord-bot-state.json` `lastMessageId` newer than a command silently skips it; fix by resetting to `{}`
- **Message Content Intent** — must be ON in Discord Developer Portal or all message content arrives empty

---

## Env Vars (weather-specific)

```
ENVIRONMENT=staging          # routes all webhooks/channels to *_STAGING vars
NCEI_TOKEN=WlFJMUfbBpbJAWEziBBHczvcLudBVgUw
ANTHROPIC_API_KEY=...        # Haiku Stage 1 + optional Sonnet Stage 2
WEATHER_DEEP_ANALYSIS=false  # true = enable Stage 2 Sonnet (~$0.015/call)
WEATHER_MIN_EDGE=0.08        # 8% threshold — review after first resolved batch
WEATHER_BANKROLL=500         # paper bankroll for Kelly sizing
WEATHER_KELLY_FRAC=0.15
WEATHER_MAX_BET=100
WU_API_KEY=                  # optional — Weather Underground PWS observations
```
