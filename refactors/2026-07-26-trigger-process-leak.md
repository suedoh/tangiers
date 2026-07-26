# trigger-check.js process leak — 158 hung processes (2026-07-26)

Found during rebuild integration, **not** by the independent audit — the audit examined code
and data, never process state. No spec covers it. Filed here so it isn't lost.

## Symptom

```
$ pgrep -f "node .../trigger-check.js" | wc -l
158
$ ps -eo etime,pid,command | grep trigger-check | sort -r | head -1
13-21:24:39   ← oldest process alive 13 days 21 hours
```

158 leaked processes × ~6.5 MB RSS ≈ **1 GB** resident, and **~316 open MongoDB connections**
(2 per process) against a server whose default `maxIncomingConnections` is finite.

## Diagnosis

The hung processes are **finished**, not stuck mid-work:

- `%CPU 0.0`, state `S` (sleeping), `WCHAN -`
- **No** CDP/TradingView socket, **no** `.tradingview-lock`, **no** handle on `trades.json`
- The only live descriptors are `TCP localhost:*->localhost:27017 (ESTABLISHED)` ×2

So the script completes its cycle and then never exits: **the MongoDB client is never closed,
its pool keeps libuv's event loop alive, and `node` hangs forever.** Runs that never touch
Mongo (no trigger, no autotrade) exit cleanly — which is why the leak is intermittent and why
`logs/trigger-check.log` shows normal `Stage 1 complete.` lines throughout. Log counts over the
file's life: 12,121 starts vs 11,572 completions.

## Immediate action taken

All 158 killed (`pkill -f "node .../trigger-check.js"`), Mongo connections back to 0. Verified
none held `trades.json` before killing — the historical recompute ran immediately after and was
independently cross-verified at 100%.

## Fix required (not applied — no spec owns it yet)

Close the Mongo client in a `finally` at the end of `main()` in every cron-invoked script that
opens one (`trigger-check.js` first; audit `scripts/lib/db.js` consumers for the same pattern),
**or** give `db.js` an explicit `closeAll()` and call it from each entrypoint's exit path.
Belt-and-braces: a watchdog class that alerts when >N same-script processes are alive, and/or
`process.exit(0)` after a successful cycle.

Note the leak has been silently degrading the host for ~2 weeks and no watchdog class covered
it — the same blind spot that let the margin exhaustion (audit D8) run 24h+ unnoticed. Worth
generalising: **the watchdog watches services, not the crons themselves.**

## Where this should live

`rebuild/02-book-governance.md` owns alerting; this is process-health alerting rather than book
governance, so it likely deserves its own small spec (or an addition to `scripts/ops/watchdog.js`
under spec 02's alerting umbrella). Flagged for the operator.
