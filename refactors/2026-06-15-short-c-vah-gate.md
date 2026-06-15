# BTC: gate `short | C | VAH` signals (structural 50% wr cell)

**Date:** 2026-06-15
**File:** [scripts/trigger-check.js:2197](../scripts/trigger-check.js#L2197)
**Baseline:** [notes/audits/baselines/2026-06-15-pre-short-c-vah-gate.json](../notes/audits/baselines/2026-06-15-pre-short-c-vah-gate.json) — n=629

## Investigation summary

BTC shorts realized 62.3% wr (n=207 closed) vs longs at 73.0% (n=403). χ² = 7.27,
p ≈ 0.007. A 3-way decomposition (direction × setup tier × zone type) showed the
gap is **concentrated in a single cell**:

| Cell | n | W/L | wr | expR | Same-zone long wr |
|---|---|---|---|---|---|
| `short \| C \| VAH` | 78 | 39/39 | **50.0%** | +0.67R | longs at VAH: 78.0% |
| `short \| B \| VAH` | 58 | 34/20 | 63.0% | +0.96R | — |
| `short \| C \| HVN` | 24 | 18/6 | 75.0% | +1.25R | — |

The pathology is direction-specific to VAH: fade-the-resistance C-shorts get
steamrolled in the current bull-leaning tape regardless of CVD / VWAP state.
The existing `isCShortCoinFlip` gate (CVD<50 ∧ price≥VWAP) catches only a
subset; the residual still resolves 39W / 39L over 78 trades — pure coin flip.

Same-zone-opposite-direction performance gap = **28pp** (78.0% vs 50.0%).

## Why no A-tier shorts ever fire (out of scope, noted)

Read [trigger-check.js:915–922](../scripts/trigger-check.js#L915). Tier
assignment is direction-agnostic (`autoPassed === autoTotal`) but the
underlying criteria are written in bull-absolute terms ("CVD bullish",
"4H MACD bullish") so in a sustained uptrend a short can hit B at best.
**Zero short A-tier signals exist in n=629.** This is a structural
deficiency in the criteria normalization layer; Phase 2 work.

## What this fix does

Adds `isCVAHShort` predicate alongside the existing `isCShortCoinFlip`:

```js
const isCVAHShort = setup.direction === 'short'
  && setup.setupType.startsWith('C')
  && trigger.type === 'VAH';
```

New else-if branch placed **before** `isCShortCoinFlip` (more specific
case first). When the gate fires, it posts a `📊 APPROACHED — SIGNAL
SUPPRESSED` info message with the structural-coin-flip rationale, marks
the level alerted (so it doesn't re-spam), and falls through to
`triggered = true`.

## Expected impact

- Removes ~1.3 signals/day (extrapolated from 78 trades / ~60d cohort)
- Lifts short wr from 62.3% → ~67.5% (mechanical, assuming cohort stable)
- Lifts overall wr from 69.1% → ~71% (mechanical)
- Forfeits +0.67R per dropped signal × ~1.3/day ≈ ~0.87R/day expectancy
  lost — small in absolute terms, recovered many times over by the
  variance reduction it buys

## Validation plan

- Pre-snapshot: `notes/audits/baselines/2026-06-15-pre-short-c-vah-gate.json`
- After 30+ days: `node scripts/audit/win-rate-diff.js --diff <baseline> --since 2026-06-15`
- Expect: short|C|VAH count drops to 0, overall short wr lifts ~5pp,
  no other cells materially impacted
- **Anomaly to watch:** if `short|C|VAH` was previously a meaningful
  fraction of total alerts, the cron's "no trigger" log lines will rise

## Out of scope (followups)

1. Add direction-aware criteria normalization to enable A-tier shorts
2. Tighten `short|B|VAH` (63.0% wr, n=58) — needs CVD-divergence
   or OI-rising as a hard requirement, not generic auto-count
3. Re-evaluate cohort post-Phase 1 ship — June-only data is too small
   (23 signals) to attribute changes confidently
