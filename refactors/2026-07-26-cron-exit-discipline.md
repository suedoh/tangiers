# Cron exit discipline — the fix for the hung-process leak (2026-07-26)

Fixes the leak documented in [2026-07-26-trigger-process-leak.md](2026-07-26-trigger-process-leak.md).
Operator-approved same day. No spec owned this; it is filed under spec 02's alerting umbrella.

## Scope grew during the fix

The original note counted **158 hung `trigger-check.js`** processes. Enumerating live processes
before patching found a **second leaker the note missed**: `discord-bot/index.js`, **5 processes,
oldest 7d14h**, each holding 2 ESTABLISHED sockets to Discord (162.159.136.232). Same class,
different handle — Mongo pool there, keep-alive HTTPS here.

## Root cause (one sentence)

Node exits when libuv has no open handles; a pooled `MongoClient` or a keep-alive socket is an
open handle, so a cron script that has **finished its work** stays resident forever while cron
keeps spawning replacements.

### Counterfactual, measured

```
$ node -e "require('./scripts/lib/db').connect().then(()=>console.log('main() done'))" &
main() done
… still alive after 6s → leak reproduced
```

Same script routed through the fix: `exit=0`, elapsed **0s**.

## The fix

`scripts/lib/cron-exit.js` — `finishCron(code)`: closes the Mongo pool **only if `lib/db.js` was
actually loaded this run** (never loads it just to close it), then exits explicitly. Cleanup is
wrapped so it can never change the run's outcome.

Applied to every host cron entrypoint that can hold a handle:

| Entrypoint | Was | Now |
|---|---|---|
| `scripts/trigger-check.js` | `main().catch(…)` | `main().then(()=>finishCron(0)).catch(…finishCron(1))` |
| `scripts/discord-bot/index.js` | `main().catch(… exit(1))` | same pattern |
| `scripts/bz/trigger-check.js` | `main().catch(…)` — **no exit at all** | same pattern |
| `scripts/poly/btc-5/trigger-check.js` | `main().catch(… exit(1))` | same pattern |

`recon-once.js`, `daily-pnl-report.js` and `watchdog.js` already disconnected explicitly and were
left alone.

## The monitoring gap it exposed

This ran ~2 weeks unnoticed, exactly like the margin exhaustion (audit D8): **the watchdog watched
services, not the crons themselves.** New `zombieProcs` class in `scripts/ops/watchdog.js`:

- Any process from `CRON_SCRIPT_PATHS` alive **>30 min** is a zombie (longest legitimate run — BTC
  full CDP sweep — is ~90s, so a slow cycle can never strike).
- Skips the `/bin/sh -c` cron wrapper line, which names the same script and would double-count.
- Fail-open if `ps` is unreadable. pm2-managed `bz/news-watch.js` is persistent by design, excluded.

**Validated live against the real leak** before cleanup: reported `5 hung
scripts/discord-bot/index.js process(es), oldest 182.3h` — matching the manual count exactly —
alerted on strike 2, and posted recovery once the processes were killed.

## Unrelated finding, not fixed (operator decision needed)

`logs/discord-bot.log` is **59% error lines**: 23,772 × `getaddrinfo ENOTFOUND discord.com` out of
40,274 lines, and the last ~20 minutes of runs are *all* failures. DNS resolves fine from an
interactive shell and from a stripped cron-like env, so this is not reproducible here — it is
consistent with the known ProtonVPN full-tunnel egress issue
([reference](../refactors/) · memory `reference_blofin_403_vpn`). While it persists, `!analyze` /
`!took` commands and 📊 reaction tracking are silently dead. Worth its own watchdog class
(bot error-rate), which is not built.
