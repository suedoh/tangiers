# Migrate non-CDP cron jobs from host to Docker `ace-cron`

**Date:** 2026-06-16
**Status:** ✅ Code shipped — user cutover required (see "Rollout" below)

## Why

Three cumulative reasons:

1. **Phase 4 of the MongoDB migration plan** explicitly called out containerizing the Discord bot + news-watch and removing from crontab — this advances that.
2. **The macOS Full Disk Access quirk** that bit us during Phase B.5 setup: `crontab -e` returned `Operation not permitted` for the BloFin recon entry. Docker `crond` doesn't hit that class of problem.
3. **Architectural consistency.** The existing `audit-cron` container had already proved the "Docker-hosted busybox crond + bind-mounted repo" pattern works for scheduled tasks. Anything that doesn't need TradingView CDP belongs there.

## What stays on the host

Four CDP-bound trigger scripts. They need `localhost:9222` (TradingView Desktop's CDP socket), which Docker for Mac can't reach. This is a permanent constraint — see [CLAUDE.md → MongoDB constraints](../CLAUDE.md).

| Script | Schedule | Reason |
|---|---|---|
| `scripts/trigger-check.js` | every 10 min | BTC trigger reads VRVP via CDP |
| `scripts/bz/trigger-check.js` | every 1 min | BZ trigger reads LuxAlgo via CDP |
| `scripts/poly/btc-5/trigger-check.js` | every 5 min | Poly bar scorer reads VRVP/VWAP/CVD via CDP |
| `scripts/ew/run.js` | 6×/day | EW reads Pine indicator output via CDP |

`make cron` now installs only `trigger-check.js`. `make ew-cron` installs only `ew/run.js`. Install the BZ and Poly trigger entries manually per the README.

## What moved to Docker (`ace-cron`)

Twelve entries. All run inside the renamed container with:
- Repo bind-mounted at `/app`
- `MONGO_URL` pointing to internal `mongodb:27017`
- `.env` read via the standard `loadEnv()` path

| Script | Schedule |
|---|---|
| `migrate/import-trades.js` | hourly `:55` |
| `blofin/recon-once.js` | every 3 min |
| `discord-bot/index.js` | every minute |
| `weekly-report.js` (BTC) | Mon 09:00 UTC |
| `weekly-war-report.js` (BTC) | Sun 14:00 UTC |
| `bz/weekly-report.js` | Sun 21:00 UTC |
| `poly/btc-5/weekly-report.js` | Mon 09:00 UTC |
| `ew/backtest.js` | 6×/day +5min after EW run |
| `ew/daily-summary.js` | 23:55 UTC |
| `ew/daily-brief.js` | 12:15 UTC |
| `ew/weekly-outlook.js` | Sun 22:00 UTC |
| `ew/monthly-review.js` | 1st of month 14:00 UTC |
| `audit/run-mid-week-diff.sh` | Wed 13:00 UTC (was already there) |

## Files changed

- `docker-compose.yml` — service `audit-cron` → `ace-cron`, container `ace_audit_cron` → `ace_cron`, crontab path → `scripts/cron/ace.crontab`
- `scripts/cron/ace.crontab` *(new)* — full schedule, replaces single-line audit crontab
- `scripts/audit/audit-cron.crontab` *(deleted)* — superseded
- `Makefile` — `cron:` target trimmed to only the BTC trigger install (the migrated ones happen via Docker now)
- `scripts/ew/install-cron.sh` — entries trimmed from 6 to 1 (only `ew/run.js` stays on host)
- `CLAUDE.md`, `README.md` — cron schedule sections split into Host vs Docker

## Rollout — what the user needs to do

This is **the only step that can't be automated** because it touches the user's live crontab.

### 1. Bring up the renamed container
```bash
cd ~/trading
docker compose up -d ace-cron --remove-orphans
```

`--remove-orphans` cleans up the old `audit-cron` container automatically.

### 2. Verify it's running
```bash
docker compose ps ace-cron        # should show `running`
docker logs ace_cron --tail 20    # should show `ace-cron: crontab installed, starting crond`
```

### 3. Remove migrated entries from the host crontab

Open it with `crontab -e` and delete these lines (and their comment headers):

- `scripts/discord-bot/index.js`
- `scripts/weekly-report.js`
- `scripts/weekly-war-report.js`
- `scripts/bz/weekly-report.js`
- `scripts/poly/btc-5/weekly-report.js`
- `scripts/migrate/import-trades.js`
- `scripts/ew/backtest.js`
- `scripts/ew/daily-summary.js`
- `scripts/ew/daily-brief.js`
- `scripts/ew/weekly-outlook.js`
- `scripts/ew/monthly-review.js`

**Keep:** `scripts/trigger-check.js`, `scripts/bz/trigger-check.js`, `scripts/poly/btc-5/trigger-check.js`, `scripts/ew/run.js`.

If you don't remove them, jobs will fire twice (once from host, once from Docker). Discord bot duplicates would be the most noticeable — same `!analyze` request answered twice.

### 4. Verify

```bash
crontab -l | wc -l                # smaller now — only CDP-bound entries left
docker logs ace_cron | tail       # crond firing the new jobs
tail logs/blofin-recon.log        # BloFin recon should be hitting it every 3 min
```

## Why I didn't auto-execute the rollout

The cutover (steps 1–3 above) is a transition with a brief window where the system is in a mixed state. Doing it by hand under operator control is safer than embedding it in a script:

- **Step 1 is reversible** — `docker compose stop ace-cron` puts you back to the prior state
- **Step 3 is destructive** — touching `crontab -e` without operator awareness is the kind of thing that should never happen unattended

Once the user runs steps 1–3, the migration is complete and the system is back in a single-source state.

## Future Phase 4 work (still ahead)

- BZ news-watch (currently `pm2`) → containerize. Not done here because pm2 isn't cron, and its WebSocket + RSS pollers have different ops considerations.
- Service rename + crontab move was the bulk of Phase 4. Bot containerization is now real.
