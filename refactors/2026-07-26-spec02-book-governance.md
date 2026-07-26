# Spec 02 — Book governance + margin alerting (rebuild)

**Files:** `scripts/lib/blofin-autotrade.js`, `scripts/ops/watchdog.js`, `.env.example`,
`scripts/blofin/governance-probe.js` (new), `scripts/tests/governance.test.js` (new)
**Audit refs:** D8 (238-contract stack), R2, R6. Spec: `rebuild/02-book-governance.md`.

## What changed

1. **Same-direction book cap** (`assessDirectionGuard`). The guard at the old line 276 only
   blocked *opposite* entries. Now a same-direction net position ⇒
   `executionStatus='skipped'`, detail `same-direction position open (net <N>) — book cap`.
   Skip is the only policy; replace is an operator decision (audit Q4), not implemented.
   `MAX_POSITIONS_PER_DIRECTION` (default 1) is visible config; values ≠ 1 clamp to 1 with a log.
2. **FAIL-SAFE position read.** The old guard failed open on read errors. A same-direction
   miss *stacks* exposure (the incident class), so an unreadable book now skips the entry:
   `position read failed — fail-safe skip, same-direction book cap unverifiable: <err>`.
   The margin preflight below it stays fail-open (a miss there merely mis-sizes one entry;
   blocking on balance reads is how Jun-27 dropped 11 signals).
3. **Aggregate margin cap** (`assessMarginCap`): skip when
   `(frozen + entry initial margin) / (cash + frozen) × 100 > MARGIN_CAP_PCT` (default 30).
   Detail: `margin cap: would use X% > 30%`. Unevaluable inputs fail open (only 2.1 is fail-safe).
4. **Skip alerting** — `signal-skipped-margin` class: every governance/margin skip
   (same-direction, opposite, fail-safe read, margin cap, preflight insufficient-margin)
   posts a red alert to `#blofin-recon`, rate-limited one per skip-kind per 30 min via
   `.autotrade-skip-alert.json` (recon-once.js state-file pattern). Alerting fails open and
   never throws into the money path. Previously ALL skips were silent — that silence hid the
   24h+ 2026-07-26 outage.
5. **Watchdog `margin-low` class**: every 5-min cycle, if BloFin available margin <
   2× next-entry initial margin at current sizing (`rDollar / (0.00216 × leverage)`;
   0.216% = measured median stop width, prior-audit A3), post a dedicated red alert,
   30-min cooldown (`CLASS_COOLDOWN_MS` override; infra classes keep 2h). Gated on
   `BLOFIN_AUTOTRADE=true`; fail-open on read errors (recon class covers API outages).

## Replay check (acceptance 5)

With this guard, the 2026-07-26 sequence (48 long refires over ~24h) walks:
refire #1 → book flat → places, opens the long. Refires #2–#48 → `getPositions` → net > 0 →
`assessDirectionGuard` → same-direction → skip + alert. **Result: 1 position, 47 alerted
skips** (first alert immediate, repeats suppressed to one per 30 min ⇒ ~48 posts max over
24h instead of silence). The margin cap never engages because the book never stacks past
one position. Additionally the watchdog's `margin-low` would NOT fire in that world
(margin never locks) — under today's actual locked book it fires immediately, which is the
designed deploy-time behavior.

## Verification

- `node scripts/tests/governance.test.js` — all assertions pass (pure guard/cap functions,
  plus integration through `autotrade()` with exchange/store/Discord monkey-patched and
  every placement primitive stubbed to record-and-throw).
- `node scripts/blofin/governance-probe.js` (mocked mode) — 11 assertions pass: skip
  details pinned exactly, opposite-guard message unchanged, fail-safe read path, margin cap
  at `MARGIN_CAP_PCT=1`, red alert captured per skip.
- **PENDING MARGIN UNLOCK:** `--live-reads` (real reads, stubbed writes — no `.env` in this
  worktree) and `--live` (real small long + real skips + real Discord posts, spec acceptance
  check 1) cannot run while the demo account is margin-locked by the live 238-contract
  position and the operator is deciding its fate. `make blofin-autotrade-probe` regression
  run is pending for the same reason.

## Expected metric effect

Far fewer executed trades — refires become alerted skips. Intended: sample count drops,
sample *independence* rises (48 correlated refires ≈ 1 effective observation, D11). Note
for the pre/post metrics protocol: post-deploy cohorts are not comparable to the stacked-book era.
