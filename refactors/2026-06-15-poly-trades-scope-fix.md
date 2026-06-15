# Poly BTC-5: hoist `trades` out of resolution block — fix 22d data loss

**Date:** 2026-06-15
**File:** [scripts/poly/btc-5/trigger-check.js](../scripts/poly/btc-5/trigger-check.js)
**Regression introduced:** dca7f35 (2026-05-24, audit A1 entry-price capture)

## What broke

The outcome-resolution loop (lines 337–399) was wrapped in a `{ … }` block.
Inside that block, `const trades = readTrades();` declared `trades` with
block scope. Three downstream sites referenced the same name at function
scope (push the new evaluation, write trades, persist Discord message ID),
expecting it to still be visible:

```js
trades.push(evalEntry);     // line 519 — ReferenceError
writeTrades(trades);        // line 520, 535 — never reached
```

Every cycle since the A1 ship threw `ReferenceError: trades is not defined`
after the entry-book read completed. `poly-btc-5-trades.json` last write
was `2026-05-24T10:10:00.000Z`. `logs/poly-btc-5.log` shows **4,173 failed
cycles** between then and 2026-06-15 — ~22 days, ~30 signals lost, 0
entry-tracked records despite the A1 ship.

## Fix

Hoist the `const trades = readTrades();` declaration out of the inner
block and into the surrounding `try` scope, keeping the rest of the
resolution block intact. The new bar's evaluation correctly appends to
the same array we just resolved outcomes on, then `writeTrades(trades)`
persists both mutations in a single write.

No behavioral change — this is the state the original author intended.

## Why no test catches this

`trigger-check.js` has no unit tests; the file is exercised only by cron.
The `ReferenceError` is reached only on the happy path (lock acquired,
CDP connected, studies read, score computed). A static lint pass with
`no-undef` would have caught it — currently not configured.

## Validation

- `node -c scripts/poly/btc-5/trigger-check.js` → OK
- All five `trades` references (343, 399, 519, 520, 535) now resolve to
  the hoisted declaration
- Next 5-min cron tick (xx:01/xx:06/…) should write a new evaluation
  entry to `poly-btc-5-trades.json`

## Downstream consequences

- $-EV summary (the A1 deliverable) now begins accumulating forward
  from today. Per the discipline gate in TODO.md, no factor/threshold
  changes until ≥150 entry-tracked OOS signals.
- Outcome-resolution backlog: the 420 previously-signaled bars from
  May 23–24 are all already resolved (outcome non-null in
  `poly-btc-5-trades.json`), so there's no replay work.
- Backtest channel resumes posting on the next signal close.
