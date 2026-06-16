# Revert Discord bot from Docker back to host crontab

**Date:** 2026-06-16 (same day as the original migration commit `4acb4ec`)
**Status:** ✅ Live — host cron entry restored, Docker entry commented out, container restarted.

## What broke

After the cron migration ([4acb4ec](2026-06-16-docker-cron-migration.md)) moved the Discord bot into the `ace-cron` Docker container, user-issued `!mtf` commands and 📊 reactions in `#btc-signals` showed "Ace is typing…" indefinitely with no response.

## Root cause

The bot doesn't just receive Discord commands — its handlers **spawn CDP-bound child processes** to do the actual analysis:

| Handler | Spawns | CDP? |
|---|---|---|
| `handlers/btc.js:47` — `!mtf` / 📊 reaction | `scripts/mtf-analyze.js --print` | yes |
| `handlers/bz.js` — `!analyze` | `scripts/bz/analyze.js` | yes |
| `handlers/poly-btc-5.js` — `!analyze` | `scripts/poly/btc-5/analyze.js` | yes |

When the bot runs inside Docker on macOS, those subprocesses inherit the container's network namespace and **cannot reach `localhost:9222`** (TradingView Desktop's CDP socket on the host). The `cdpConnect()` call hangs / errors, the analysis script exits non-zero, and the bot's promise chain dies without posting a result. The Discord typing indicator times out on its own.

## What I missed when migrating

I classified `discord-bot/index.js` by what *the entry script itself* does — pure HTTP polling, state file reads, Discord webhook posts. None of that needs CDP. But the bot's job isn't just polling; it's **dispatching to handlers that need CDP**. The right classification heuristic is "does this script or anything it transitively spawns touch CDP" — not "does THIS script touch CDP".

The same heuristic catches the BZ and Poly bots if we ever try to migrate them. None of the analysis-spawning bots can live in Docker until either:

1. CDP becomes reachable from Docker (not happening on macOS), OR
2. The analysis scripts are themselves moved off CDP (e.g. via a host-side IPC daemon the Docker bot calls). That's a real refactor — out of scope today.

## What I changed

- **`scripts/cron/ace.crontab`** — discord-bot line commented out with a pointer to this note
- **Host crontab** — discord-bot line re-added (entry persists across reboots)
- **`docker compose restart ace-cron`** — the restart picks up the trimmed crontab and stops scheduling the bot inside the container
- **`Makefile` → `cron:`** — re-added the discord-bot install block so a fresh `make cron` recovers it
- **`CLAUDE.md`, `README.md`** — schedule sections updated; the host block now lists 5 entries (4 triggers + bot) and the Docker block drops the bot line

The original migration refactor note ([2026-06-16-docker-cron-migration.md](2026-06-16-docker-cron-migration.md)) is unchanged because it remains accurate as a historical record. This note is the correction.

## What's still in Docker

The other 11 jobs from the original migration are unaffected — none of them spawn CDP-bound subprocesses:

- Mongo sync, BloFin recon, mid-week audit
- BTC / BZ / Poly weekly reports (read Mongo, post Discord)
- EW backtest (reads Binance REST), daily-summary, daily-brief, weekly-outlook, monthly-review (all template-rendered)

All of those keep running in `ace-cron`.

## How I caught it

User report: `!mtf` shows "Ace is typing…" then nothing. Within a minute of digging — `grep spawn handlers/btc.js` → confirms `execFileAsync(NODE, [ANALYZE_SCRIPT])`. Done.

## Lesson for next time

When migrating a process to Docker, audit not just its own dependencies but the **transitive dependencies of any subprocess it spawns**. For Tangiers this is concrete: any script in `discord-bot/handlers/*.js` that does `execFile(NODE, [<some-script>])` makes the bot CDP-bound by proxy.
