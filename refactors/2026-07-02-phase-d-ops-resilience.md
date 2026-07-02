# Phase D ops resilience — Mongo-outage degradation + watchdog + recon hardening

**Date:** 2026-07-02
**Status:** DONE — all paths probed live against the actual outage before restore.
**Trigger:** Docker daemon died 2026-06-27 ~20:30–22:40 UTC; discovered 2026-07-02 during a full-system review.

## The incident

| | |
|---|---|
| Docker daemon died | Jun 27 between 20:30 UTC (last recon log write) and 22:40 UTC (first drop). **No reboot** — host uptime 43 days; Docker Desktop crashed or was quit. |
| Autotrade drops | 11 consecutive, Jun 27 22:40 → Jun 29 01:00 UTC, all `ECONNREFUSED 127.0.0.1:27017`. Host was fully awake (144 cron slots/day) — this was NOT machine sleep. |
| Recon dark | 4.7 days. Protection invariant unchecked the whole time. |
| Pre-existing silent failure | 143 recon cycles failed with Cloudflare `403 <!DOCTYPE html>` (bursts from ~Jun 20; final 29 cycles consecutive) — **never posted to Discord** because `main().catch` was console-only. |
| Exchange exposure | None. No naked positions; account $1,611.59 (+7.4% from Phase D start). |

### R-cost (bar-walk hypothetical, post-launch cohort)

| Cohort | n | closed | wr | sum R |
|---|---|---|---|---|
| placed | 18 | 14 | 50% | **+7.0R** |
| dropped — timeout era (pre IPv4 fix) | 7 | 6 | 67% | +7.2R missed |
| dropped — Mongo outage | 11 | 11 | 100% | **+18.0R missed** |

Caveat: the 11 Mongo-era drops are time-clustered shorts in one Jun-28 downtrend leg (8 within ~7h) — correlated, not 11 independent trades; the 100% wr is regime luck. Even discounted, infra failures cost most of the window's available R. **Infrastructure, not signal quality, was Phase D's binding constraint.**

### Machine-sleep qualification (user question)

The machine never shuts down — it **sleeps** (laptop, battery): ~10h gaps on Jun 30 / Jul 1 in the cron log. Sleep is benign for execution: no polls → no signals → nothing can drop, and exchange-side SL/TP orders rest server-side. Sleep did NOT cause this incident; the dangerous state is **awake-with-dead-infra**, which is exactly what Jun 27–29 was. Policy: sleep = planned downtime (excluded from the Phase D clean-day clock, logged as coverage); awake-with-dead-infra = operational incident (clock resets — restarted 2026-07-02).

## Root causes → fixes

| # | Root cause | Fix | File |
|---|---|---|---|
| 1 | Autotrade hard-depends on Mongo for idempotency — throws before any exchange call | Degraded mode: exchange-side idempotency via deterministic clientOrderId (BloFin rejects dupes — probed 2026-06-24); orders place normally; docs spool to `.blofin-spool.ndjson`; recon flushes. `executionStatus='placed'` + `(mongo-down, spooled)` detail; yellow degraded-mode note to #blofin-recon | [blofin-autotrade.js](../scripts/lib/blofin-autotrade.js), [blofin-store.js](../scripts/lib/blofin-store.js), [trigger-check.js](../scripts/trigger-check.js) |
| 2 | `placeAndPersist` could throw AFTER a successful placement (Mongo insert) | Invariant: never throw post-placement — Mongo failure spools instead. Same for `persistTPSL` / `persistAdoptedEntry`. 60s Mongo backoff so one signal doesn't stack 5 connect timeouts | [blofin-store.js](../scripts/lib/blofin-store.js) |
| 3 | Recon hard-failure was silent (the 403 class) | `main().catch` posts red alert to #blofin-recon, rate-limited 30 min (state: `.blofin-recon-alert.json`) | [recon-once.js](../scripts/blofin/recon-once.js) |
| 4 | Nothing watches the watchers when the host is awake | `scripts/ops/watchdog.js` every 5 min (host): Docker (auto-restart via `open -g -a Docker`), Mongo ping, recon-log freshness, spool backlog. 2-strike gating (kills sleep-wake false positives), 2h re-alert cooldown, recovery posts | [watchdog.js](../scripts/ops/watchdog.js) |
| 5 | Container egress drew intermittent Cloudflare 403s from BloFin; host IPv4-forced path clean | recon + daily-pnl moved to **host crontab** (`make cron` installs). Also halves Docker-outage blast radius | host crontab, [ace.crontab](../scripts/cron/ace.crontab), [Makefile](../Makefile) |
| 6 | (Found during fix) recon diffed `sl_conditional` docs against `orders-pending` — every live SL marked disappeared→cancelled in Mongo minutes after placement | Diff SL docs against `getPendingTPSL` instead. Safety was never affected (protection invariant reads exchange directly) but the Mongo book was wrong — pre-2026-07-02 `sl_conditional` states are unreliable for attribution | [blofin-store.js](../scripts/lib/blofin-store.js) |
| 7 | (Found during fix) `docker info --format` exits 0 with daemon down | watchdog uses `docker version --format '{{.Server.Version}}'` + non-empty check | [watchdog.js](../scripts/ops/watchdog.js) |
| 8 | (Found during fix) recon retroactive pass read `ex.clientOrdId` (docs vocab) — always null | reads `ex.clientOrderId` (probed field name) | [blofin-store.js](../scripts/lib/blofin-store.js) |

## Verification (all against live conditions)

- **Degraded probe** (`make blofin-degraded-probe`, run while Mongo was actually down): entry + exchange-verified SL + 3 TPs placed, 5 docs spooled, `unsynced=true`, re-fire caught by degraded idempotency, Mongo-free cleanup clean.
- **Spool flush**: the ace-cron container's own recon (new code via bind mount) flushed all 5 docs on its first healthy cycle and resolved them to exchange-truth states (entry+TPs `filled`, cancelled SL `cancelled`) in the same pass.
- **Watchdog full lifecycle, live**: detected the real dead daemon → auto-restart → strike-gated alert posted (mongo+recon) → all-green recovery post after restore.
- **Normal-path regression** (`make blofin-autotrade-probe`, Mongo up): all 5 assertions pass; `matched=1` confirms the SL-vs-TPSL reconcile fix (previously the SL false-disappeared here).
- **Heal**: `import-trades` synced 4.7 days of backlog; `blofin_orders` census `cancelled=39 filled=63`, zero stuck live/disappeared; exchange flat.
- **Cron cutover**: container crontab has 0 recon/pnl entries; host recon fired on the next */3 boundary.

## Not done (deliberate)

- **Sleep prevention** (`pmset -c sleep 0` / scheduled wakes): user decision, not a defect. Coverage gaps just extend Phase D calendar time; attribution should note awake-hours sample bias.
- **Docker Desktop login-item**: watchdog's auto-restart covers crash recovery; the host hasn't rebooted in 43 days. Enable "Start when you sign in" in Docker Desktop settings if reboots become a thing.
- **Container 403 root-cause**: moot for the money path now that recon runs on the host; remaining container jobs (Mongo sync, weekly reports, EW) don't call BloFin.
