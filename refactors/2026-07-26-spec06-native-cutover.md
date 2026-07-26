# Spec 06 — exchange-native cutover applied (2026-07-26)

`BTC_DATA_SOURCE=native` is live in `.env`. BTC market reads now come from Binance Futures REST via
`lib/market-data.js` + the frozen calibration in `config/btc-zones.json`. TradingView/CDP is the
rollback path (comment the flag out) and, until the 14-day gate, the parity **shadow**.

Applied from [rebuild/06-integration-patch.md](../rebuild/06-integration-patch.md), re-anchored onto
the post-spec-03 ledger code. Operator approved 2026-07-26.

## Structural change (H4, deviates from the patch — for the better)

The patch wrapped main()'s steps 1–6 in an `else` arm, which meant re-indenting ~130 lines of the
legacy path. Instead the two readers became sibling functions with one return shape:

```
gatherTV()      → { price, indicators, client, restoreUserTF }   // body unchanged, zero re-indent
gatherNative()  → { price, indicators, client: null, restoreUserTF: noop }
main()          → picks one, everything downstream untouched
```

The rollback path is therefore byte-comparable to its pre-cutover self, and `git diff` shows intent
rather than whitespace. All other hunks (H1, H2, H3, H5, H6) applied as written.

## Two defects the smoke test caught — both would have shipped silently

**1. `.env` clobbered the caller's environment → 7 unintended demo orders.**
`trigger-check.js`'s inline env loader assigned `process.env[key]` unconditionally, so
`BLOFIN_AUTOTRADE=false node scripts/trigger-check.js` was **not** a dry run: `.env`'s `true` won.
The first native smoke run fired a real (demo) signal and placed 7 orders — 1 entry + SL + 5 TP
rungs, 17.9 contracts, $115.68 margin. Fixed: the loader now skips keys already present in the
environment, matching `lib/env.js` semantics used everywhere else. Verified — the same override now
resolves to `false` against an `.env` that says `true`.

*Same unconditional pattern remains in `weekly-report.js`, `weekly-war-report.js`, `mtf-analyze.js`,
`discord-bot.js`. None can place orders, so none were changed here.*

**2. CVD history carried across a definition change → spurious confirmation.**
The TV CVD study is an **anchored cumulative** series (values in the thousands); native CVD is a
**1h rolling** sum (values near zero). `lookupCVDAt()` returns the nearest reading *in time*, with no
notion of source, so the first post-flip cycle compared a native baseline of **−19** against a TV
residue of **2190** → delta 2209 → `CVD confirmed=true` on a pending level, from nothing but the
unit change. The patch's delta-list flagged that CVD definitions unify; it did not say the *state*
must be invalidated.

Fixed with `resetCVDStateOnSourceChange()`: on any source change it drops `_cvdHistory`, nulls every
`_pending_*.baselineCVD` (null ⇒ `cvdDelta` null ⇒ confirmation fails **closed**), and records
`_cvdSource`. Idempotent and symmetric — it fires on rollback too. Live output:

```
CVD source tv → native: dropped 200 history reading(s), cleared 1 pending baseline(s)
Pending _pending_hvn-64507: … CVD null→-142 delta=n/a confirmed=false   ← was delta=2209 confirmed=true
```

`_previousOI` needs no reset: native OI is in coins, the same unit the CDP read has used since
`4f175b3`.

## What the cutover measured on day zero

| | TV (shadow) | Native (primary) |
|---|---|---|
| POC | $62,836 | $64,768 |
| Δ | **$1,932 — 3.0% of price** | — |
| Trigger this cycle | ∅ | HVN long |

A 3% POC disagreement is the audit's D10 stale-row defect seen from the other side: the two feeds
were not describing the same market, and the TV side is the one that drifts with viewport and lags
its own histogram. Native reads complete in **0.3–0.7s** with no mutex, no timeframe switching and
no 8-attempt VRVP polling — the entire class of "chart wasn't ready" failure disappears.

Spec 05's cell dedup got its first live exercise in the same window: the second and third cycles
logged `Cell dedup: long HVN @$64507 suppressed — cell fired 0.0h ago`. Pre-rebuild this is exactly
where the 48-signal stack came from.

## Verification

```
node --check scripts/trigger-check.js                 → 0
node --test scripts/tests/*.test.js                   → 16 pass / 0 fail
node --test test/*.test.js                            → 22 pass / 0 fail
node scripts/trigger-check.js                          → exit 0, "source: native", Stage 1 complete
node scripts/audit/zone-parity-report.js               → exit 2 INSUFFICIENT (fresh clock — correct)
```

Baseline snapshotted **before** the flip: `notes/baselines/pre-native-cutover-2026-07-26.json`
(n=801). Parity clock reset: `logs/zone-parity.jsonl` → `logs/zone-parity.pre-cutover.jsonl`
(1,998 lines kept — that file is the D10 evidence base).

## Clocks started

- **14-day parity gate** starts 2026-07-26. It restarts on any cutover code change.
- The gate compares native decisions to a TV feed that is ~15% blind and whose zones drift with
  chart zoom. Per the patch's open item, expect trigger-agreement to fail unless the chart is pinned
  (VRVP visible, 30M, stable zoom). Native-side checks (0 blind cycles, determinism) should pass.
  Restating that gate is spec-09 territory and an operator call.
- H7 (deleting the CDP path) stays parked until the gate passes.
