# Refactor Log — Process Guide

This folder contains decision records for every significant bug fix, dead-code removal, or structural change made to Tangiers. Each file answers: what changed, why the old code was wrong, and what the risk of the change was.

---

## How We Evaluate Before Touching Anything

The process below was established during the BOS/CHoCH dead code removal. It applies to any change where the right call isn't immediately obvious.

### 1. Confirm the claim before forming an opinion

Before deciding what to do with a suspect piece of code, verify the premise independently.

For the BOS/CHoCH case:
- Searched for every callsite of `buildLabelsExpr` and `parseBosChoch` — zero results
- Confirmed neither function appeared anywhere in `main()` or any execution path
- Did not rely on the prior analysis doc alone; re-ran the grep fresh

**Rule:** A claim that code is dead, unused, or broken is not evidence — a search result is.

### 2. Understand the original intent

Read the code and its comments to understand what it was *supposed* to do. This matters because dead code sometimes represents a half-finished feature that's worth completing rather than removing.

For BOS/CHoCH:
- Comment said "so evaluateSetup can use it as a structure-confirmation criterion"
- The criterion was never added to `evaluateSetup`
- This told us: it was speculative scaffolding, not an abandoned fix

### 3. Check whether the code *could* work even if wired in

This is the critical step that separates "remove it" from "wire it."

For BOS/CHoCH:
- `buildLabelsExpr` reads Pine `label.new()` primitives from the chart via CDP
- Cross-referenced the BTC indicator stack (CLAUDE.md + codebase): VRVP, Session VP, VWAP, CVD, OI — no LuxAlgo SMC
- No LuxAlgo on the BTC tab means no BOS/CHoCH labels are ever drawn
- Even a correct callsite would return an empty array every time

**Rule:** If the data source doesn't exist in the environment the code runs in, wiring it in is building on nothing.

### 4. Check whether the gap it was meant to fill actually exists

Even if the code couldn't work as-is, the underlying need might still be real.

For BOS/CHoCH:
- Reviewed all 9 criteria in `evaluateSetup`: VRVP level type, HVN delta, CVD, Session VP, VWAP, OI trend, 4H MACD, 12H RSI, weekly trend
- Structure confirmation is already covered by weekly trend regime + 4H MACD + CVD alignment
- No meaningful gap that BOS/CHoCH would fill that isn't already addressed

### 5. Confirm the correct home exists elsewhere if relevant

If the pattern has value but is in the wrong place, note that — don't just delete it.

For BOS/CHoCH:
- `bz/analyze.js` uses `extractStructureLevels()` on 4H LuxAlgo labels to anchor TP1 to the nearest CHoCH
- LuxAlgo *is* loaded on the BZ tab — it produces real data there
- The pattern works and belongs in BZ, not BTC

### 6. State the risk explicitly before committing

For BOS/CHoCH: zero risk — no execution path touched either function. If the risk had been non-zero, the bar for proceeding would have been higher.

---

## File Naming Convention

`{instrument-or-scope}-{what-changed}.md`

Examples:
- `remove-bos-choch-dead-code.md`
- `btc-checkconfirmation-tf-switch.md`
- `bz-oi-threshold-fix.md`

---

## What Each File Should Contain

- **What was removed / changed** — be specific about functions, line ranges, files
- **Why it was wrong** — the actual reason, not just "it was unused"
- **Why the fix took the shape it did** — especially if an alternative was considered and ruled out
- **Risk** — what could behave differently, and confidence level
