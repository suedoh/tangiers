# 02 — Book governance + margin alerting

**Type:** risk containment · **Depends on:** 01 · **Audit refs:** D8, R2, R6
**Files:** [scripts/lib/blofin-autotrade.js](../scripts/lib/blofin-autotrade.js),
[scripts/ops/watchdog.js](../scripts/ops/watchdog.js), `.env.example`

Unconditional: implement regardless of any signal work. This prevents recurrence of the
238-contract incident *during* the measurement window and makes forward samples independent
(48 correlated refires are 1 effective observation — D11).

## Required behavior

### 2.1 Same-direction position guard (blofin-autotrade.js)

The existing one-direction guard (line 276) only blocks **opposite**-direction entries. Add:
if a **same**-direction net position is already open on the instrument →
`executionStatus='skipped'`, detail `'same-direction position open (net <N>) — book cap'`.
Default policy is **skip**; a replace policy (close old, open new) is an operator choice
(audit Q4) — do not implement replace unless the operator asks.

- Config: `MAX_POSITIONS_PER_DIRECTION=1` in `.env` (read with default 1; only 1 is supported
  initially — the var exists so the cap is visible, not to invite tuning).
- Fail-open **must not** apply here: if the position read errors, **skip** the entry (fail-safe).
  Rationale: the opposite-direction guard fails open because a miss merely nets down exposure;
  a same-direction miss *stacks* exposure — the exact incident class this spec kills.

### 2.2 Aggregate margin cap

Before entry: fetch account balance; if `(margin in use + this order's initial margin)` would
exceed **30% of equity** → skip with `executionStatus='skipped'`, detail
`'margin cap: would use X% > 30%'`. Config: `MARGIN_CAP_PCT=30`.

### 2.3 Margin/skip alerting (watchdog + autotrade)

Two new alert classes, posted to `#blofin-recon` (red, same palette as recon errors),
rate-limited 30 min like existing classes:

- **`margin-low`** (watchdog, every 5-min cycle): available margin < 2× the initial margin a
  next entry at current sizing would need.
- **`signal-skipped-margin`** (autotrade, at skip time): any skip under 2.1/2.2 or the
  existing preflight. Today these are **silent** — that silence hid a 24h+ execution outage.

Watchdog additions follow the existing per-class strike/rate-limit pattern in
`.watchdog-state.json`.

## Acceptance checks

1. **Probe script** `scripts/blofin/governance-probe.js` (modeled on existing `*-probe.js`):
   on demo, with a small long open, fire a synthetic same-direction signal → assert skip +
   detail + Discord alert; fire opposite-direction → assert existing guard message unchanged.
2. Simulate position-read error (bad instId) → assert same-direction path **skips** (fail-safe).
3. Margin cap: with cap artificially set low (`MARGIN_CAP_PCT=1`), assert skip + alert.
4. Confirm no regression: `make blofin-autotrade-probe` still passes.
5. Replay check: with the guard in place, the 2026-07-26 sequence (48 refires) would have
   produced 1 position + 47 alerted skips. State this in the refactors note with the logic path.

## Expected metric effect

Far fewer executed trades (most refires become skips). This is intended — sample count drops,
sample *independence* rises. Note it in the pre/post metrics snapshot (project protocol).

## Definition of Done

- [ ] 2.1–2.3 implemented behind config, defaults as specified
- [ ] Governance probe passes on demo; output pasted into refactors note
- [ ] Alert classes visible in `#blofin-recon` (screenshot or message link)
- [ ] `.env.example` updated; refactors analysis note committed
