# Remove BOS/CHoCH Dead Code — trigger-check.js

## What was removed
- `buildLabelsExpr(filter)` — CDP expression builder that read Pine `label.new()` primitives via `dwglabels`
- `parseBosChoch(labels, price)` — parser that scanned those labels for BOS/CHoCH text and inferred bullish/bearish structure

Combined: ~85 lines.

## Why it was dead
Neither function had a callsite anywhere in the file. The comment on `parseBosChoch` said "so evaluateSetup can use it as a structure-confirmation criterion" — that criterion was never added to `evaluateSetup`.

## Why it couldn't be wired in
LuxAlgo Smart Money Concepts is **not in the BTC indicator stack**. The `🕵Ace` BTC tab runs VRVP, Session VP, VWAP, CVD, OI. No Pine script produces BOS/CHoCH labels on that tab, so `buildLabelsExpr` would have returned `[]` on every call.

## Where BOS/CHoCH is correctly used
`bz/analyze.js` — `extractStructureLevels()` reads `labels4h` from LuxAlgo (which *is* loaded on the BZ tab) and uses the nearest CHoCH as TP1 anchor. That's the right home for this pattern.

## Risk
Zero. No execution path touched these functions. Behavior is identical.
