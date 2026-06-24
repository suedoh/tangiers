# BloFin recon — `!pnl` on-demand P&L command

**Date:** 2026-06-24
**Files:**
- New: [scripts/discord-bot/handlers/blofin.js](../scripts/discord-bot/handlers/blofin.js)
- Edit: [scripts/discord-bot/router.js](../scripts/discord-bot/router.js) — `blofin` prefix + channel registration
- Edit: `.env`, `.env.example` — `BLOFIN_RECON_CHANNEL_ID`
**Status:** Live. Test post landed in `#blofin-recon` via direct script run.

## What this adds

`!pnl` command in `#blofin-recon`. Triggers the same report format that the
21:00 UTC daily cron posts: account snapshot (equity, available, margin, uPnL),
open positions with SL/TP distances, today's signal+fill+realized-P&L counts,
and the protection-invariant check.

## Why this design

The user asked for "latest assets, balances and trades". The existing
[daily-pnl-report.js](../scripts/blofin/daily-pnl-report.js) already produces
exactly that view — built in Phase D for the 21:00 UTC heartbeat. Reusing it
keeps one source of truth for the report format.

The handler shells out to `daily-pnl-report.js` as a subprocess, matching the
pattern used by `!analyze` → `mtf-analyze.js` and `!report` → `weekly-war-report.js`.
No new env vars beyond the channel ID; the report uses the existing
`BLOFIN_RECON_WEBHOOK`.

## Channel-ID resolution

The recon channel was never registered with the bot (recon-only flow had been
write-only via webhook). Derived the ID by GETting the webhook:

```
curl https://discord.com/api/webhooks/<id>/<token>
→ { channel_id: "1516342677422084126", name: "Ace", ... }
```

Added to `.env` and documented the resolution method in `.env.example`.

## How the bot picks it up

[router.js](../scripts/discord-bot/router.js):
- `ROUTES` gains `{ prefix: 'blofin', handler: blofinHandler }`
- `allChannelIds()` gains a conditional push for `BLOFIN_RECON_CHANNEL_ID`

Resolved correctly in smoke test:
```
resolve("blofin-recon") → blofin handler
channels: ..., 1516342677422084126 → blofin
```

## Risk

- Zero impact on signal generation, autotrade, recon, or any other channel.
- Subprocess shell-out is bounded by a 60s timeout.
- Bot ack ("📊 P&L report triggered by USER — generating…") is plain bot
  message; the actual report posts via webhook with rich embed coloring
  (`error` color if unprotected positions detected, else `info`) — same as
  the daily cron.

## Verification

- `node -c` clean on both files.
- Router smoke test confirms `resolve('blofin-recon')` → blofin handler and
  channel ID 1516342677422084126 appears in `allChannelIds()` with prefix
  `blofin`.
- Live `node scripts/blofin/daily-pnl-report.js` posted successfully — verifies
  the BloFin REST + Mongo + Discord webhook chain works end-to-end. (Mongo
  container shows `(unhealthy)` for 4 weeks but responds normally; healthcheck
  itself is broken, not the DB.)

## Follow-up flagged (not done)

- Mongo container `(unhealthy)` healthcheck — investigate why the docker
  healthcheck fails despite Mongo responding cleanly.
