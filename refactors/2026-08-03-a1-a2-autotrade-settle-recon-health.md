# A1 + A2 — autotrade settlement, and a watchdog that can see 403s (2026-08-03)

Ships the two Tier-1 safety defects from [btc-audit-2026-08-03.md](btc-audit-2026-08-03.md).
Both are "the alarm was disconnected" bugs, not strategy changes. No signal logic touched.

**Files:** `scripts/trigger-check.js` (`settleAutotrades`, call site, `main()` tail),
`scripts/ops/watchdog.js` (`evaluateReconLog`, `checkReconFresh`, entrypoint gate),
`test/autotrade-settle.test.js` (new, 6), `test/watchdog-recon.test.js` (new, 10).

---

## A1 — the autotrade promise was being killed by `process.exit()`

`main()` fired `autotrade.autotrade(...)` without awaiting it, then `finishCron(0)` →
`process.exit(0)`. That promise chain carries **entry → fetch fill → risk trim →
standalone SL → verify SL → TP ladder**, and its `.then`/`.catch` write
`executionStatus` and post the dead-letter alert. Exiting mid-flight can end the run
between the entry fill and the SL that protects it, with no record it happened.

Introduced by `cb38c94` (2026-07-26 20:20 UTC, cron-exit discipline) — before it the
process leaked, which accidentally kept it alive long enough. `lib/cron-exit.js` reasons
that "whatever else libuv is still holding is by definition work nobody is waiting on";
the autotrade promise was the counter-example.

| | signals | no `executionStatus` |
|---|---|---|
| 2026-06-15 → `cb38c94` | 173 | 0 |
| `cb38c94` → 2026-08-03 | 13 | **3 (23%)** |

Two-sided Fisher exact **p = 2.7e-4**. Affected: `2026-07-28T22:50`, `2026-07-30T09:20`,
`2026-08-02T02:30` — exchange state for those three is unknown.

**Fix.** Calls are collected into `pendingAutotrades` and settled at the tail of
`main()` — *after* `releaseLock('btc-trigger')`, so a slow exchange can never hold the
TradingView mutex, and *before* `main()` resolves. `settleAutotrades()` is pure (no
fs/network), bounded at `AUTOTRADE_SETTLE_MS = 120_000` — 24× the ~5s happy path, ⅕ of
the 10-min cadence. A rejected chain counts as **settled** (the caller's `.catch`
already stamped it `dropped`); only never-resolved calls are unknown-state, and those
get `executionStatus='dropped'` with `EXCHANGE STATE UNKNOWN, verify manually` plus a red
Discord alert naming the signalIds.

## A2 — the watchdog could not see the failure that was actually happening

`checkReconFresh()` matched `/reconcile errors: [1-9]|resolve errors: [1-9]/`. Those are
**summary** lines; a thrown error aborts the pass before any of them is written. A
Cloudflare 403 therefore produced a pass with no matched string and read as healthy:

```
─── BloFin reconciliation ─── 2026-08-03T06:06:07.733Z
env:     demo
instId:  (all)

unexpected: Error: blofin http 403: <!DOCTYPE html>
```

Second, only the **last** pass was inspected — but the failure is intermittent, so a
last-pass check flips green ~⅔ of the time and can almost never reach the 2 consecutive
strikes an alert requires.

Measured 403 rate (480 cycles/day, all present): 0.0% on 07-27 → 3.8% (07-30) → 12.1%
(08-01) → 13.3% (08-02) → **32.3%** on 08-03 to 06:11. Every one reported `recon=ok`.

**Fix.** Two inversions:

1. **Completion is the signal.** A pass is healthy iff it reached `─── Done. ───` and
   logged no error. `RECON_ERR_RE` adds `^unexpected:`, bare `Error:`, and
   `blofin http \d{3}` to the two summary arms (which are kept — 2026-07-04 E11000
   regression cover).
2. **Window, not last pass.** `RECON_WINDOW_PASSES = 15` (≈45 min) with
   `RECON_MAX_ERR_IN_WINDOW = 3` (20%). Calibrated against the record: 32% ⇒ ≈5/15
   strikes; 4.0% (07-19) and 4.2% (07-25) ⇒ ≈0.6/15 stay green; total outage is 15/15.
   A pass younger than `RECON_PASS_GRACE_MS` (60s) may still be running and is excluded;
   a *newest* pass past that grace with no `Done.` is reported as **hung** on its own,
   without waiting for the error count — recon at 3-min cadence cannot legitimately sit
   unfinished, and freshness alone would not catch it until `RECON_STALE_MIN` (20 min).

`marginLow`'s fail-open is deliberately left as-is: its stated justification is that "an
unreachable BloFin API is an infra problem the recon class already covers." That was
false before this change and is true after it.

`evaluateReconLog(tail, {nowMs})` is pure and exported; `main()` is now behind
`require.main === module` (as is the `PRIMARY=false` exit) so requiring the module for
tests no longer runs a live health sweep and post.

---

## Verification

```
node --test test/*.test.js          → 38/38 pass (16 new)
node --test scripts/tests/*.test.js → 16/16 pass
node scripts/trigger-check.js       → exit 0, "Stage 1 complete.", 0 lingering procs
node scripts/ops/watchdog.js        → exit 0, all classes evaluated
```

New checker against the **live** log, not just fixtures — 06:46 UTC:

```
{ ok: false, passes: 15, errored: 3,
  detail: 'recon running but erroring — 3/15 of the last passes failed (~45 min):
           "unexpected: Error: blofin http 403: <!DOCTYPE html>"' }
```

The old matcher returned `ok` on that same input.

Because the window rolls, the class tracks the true rate rather than latching: at 06:52
it read `{ ok: true, errored: 2 }` — the failure rate had genuinely fallen to 13.3%. At
that rate it strikes on roughly a third of watchdog runs, which is the intended
behaviour, not flapping. It will alert while degradation persists and clear when it
stops.

## Not fixed here — the cause is still live

These make the failure **visible**; they do not stop it. The 403s are ProtonVPN egress
(audit B3, reconfirmed live 2026-08-03: default route `utun5` → 403, `--interface en0`
→ 200). Until the split-tunnel/VPN-off decision is made, recon will keep going dark
intermittently — the difference is that now something says so.

Exchange verified flat and protected during this work (read-only over en0): equity
$1,679.12, 0 positions, 0 pending TPSL, 0 pending orders.
