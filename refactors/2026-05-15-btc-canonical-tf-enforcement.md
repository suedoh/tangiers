# BTC trigger-check — Canonical TF Enforcement
**Status:** DONE — shipped 2026-05-15
**Owner:** suedoh
**Baseline (pre-fix):** [btc-baseline-2026-05-15-pre-tf-fix.json](btc-baseline-2026-05-15-pre-tf-fix.json)

## What was broken

`scripts/trigger-check.js` read `VRVP_EXPR`, `STUDY_VALUES_EXPR`, and `buildVolumeExpr` from whatever timeframe the chart was on at the moment the cron fired. There was no `setTimeframe()` call before the read. The subsequent HTF sweep (`fetchHTFCloses` for 4H / 12H / W), `checkConfirmation`, and `updateOutcomes` all correctly enforce their target TF — only the initial VRVP + study read was unguarded.

Every other CDP script in the system already enforces TF explicitly: `mtf-analyze.js`, `bz/trigger-check.js`, `bz/analyze.js`, `poly/btc-5/trigger-check.js`, `poly/btc-5/analyze.js`, `ew/protocol.js`. BTC trigger-check was the lone outlier.

## Evidence

Log analysis at fix time showed `current TF: <value>` distribution across the 2199 proximity-detected polls in `logs/trigger-check.log`:

| Chart TF at poll | Count | % |
|---|---:|---:|
| 30M | 1141 | 52% |
| **5M** | **992** | **44%** |
| 15M | 62 | 3% |
| 1H | 3 | 0.1% |
| 1M | 1 | 0% |

The last 20 entries before the fix were all on 5M. VRVP is a visible-range indicator — on 5M the histogram resolves intraday micro-levels (~2-3h of bars); on 30M it resolves daily swing levels (~1-2 days of bars). CVD, VWAP, and Session VP are similarly TF-sensitive on the displayed bars. The strategy was calibrated against 30M; reading on 5M produced different POC/VAH/VAL levels than intended.

## The fix

[scripts/trigger-check.js:1846–1858, 1925–1933, 1992, 2200](../scripts/trigger-check.js:1846)

1. Capture `userTF` right after CDP connects (before any read).
2. If `userTF !== '30'`, switch chart to 30M and wait 1.5s for indicators to recompute.
3. Read VRVP, studies, and volumes on 30M.
4. Existing HTF sweep takes over (now captures `30` as its `originalTF` since chart is already on 30M).
5. `checkConfirmation` and `updateOutcomes` continue to work as before (each does its own 30M save/restore).
6. On main-success path, on symbol-mismatch exit, and on data-collection error exit: call `restoreUserTF()` before closing the client. Chart returns to whatever the user had it on.

```js
const CANONICAL_TF = '30';
let userTF = null;
const restoreUserTF = async () => {
  if (!userTF || userTF === CANONICAL_TF || !client) return;
  try { await cdpEval(client, buildSetTFExpr(userTF)); } catch {}
};

// after CDP connect + price read:
userTF = await cdpEval(client, GET_TF_EXPR).catch(() => null);
if (userTF && userTF !== CANONICAL_TF) {
  await cdpEval(client, buildSetTFExpr(CANONICAL_TF));
  await new Promise(r => setTimeout(r, 1500));
}
// ... read VRVP / studies / volumes ...
// at every exit: await restoreUserTF();
```

## Risk

**Selection-rule change.** VRVP levels will shift to 30M's visible range. Signals that fired against 5M-tight intraday levels will no longer fire; new signals will fire against 30M institutional levels. Direction of effect: expect fewer signals overall (30M VRVP resolves to broader, fewer levels), each with higher institutional significance.

Per the metrics protocol, a fresh baseline was taken before the fix shipped and is the comparison point for the next diff.

## Crash path

If the script crashes inside `main()` after the canonical switch, the chart will be left on 30M. The next cron poll (10 minutes later) will detect the TF mismatch and switch again on its way out. Worst-case orphan: chart sits on 30M for up to 10 minutes. Acceptable; not worth wiring restore into the crash handler.

## Verification

- Syntax: `node -c scripts/trigger-check.js` passes
- Logic smoke-test (user on 5M / 30M / 4H, including double-restore): all cases produce expected chart state
- All four exit paths (success, symbol-mismatch, data-error, normal end) call `restoreUserTF()`
