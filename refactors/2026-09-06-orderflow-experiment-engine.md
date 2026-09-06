# Order-flow experiment engine — live readings, no orders (2026-09-06)

`scripts/research/orderflow-engine.js`, pm2 process **`orderflow-engine`**. Recomputes the eight
pre-registered order-flow hypotheses at every 1h BTCUSDT bar close, posts them to `#blofin-recon`,
writes every bar to Mongo. **It places no orders and cannot, as shipped.**

## Why it exists, and why it doesn't trade

The pre-registered backtest
([notes/flow-research/order-flow-academic-backtest-2026-09-06.md](../notes/flow-research/order-flow-academic-backtest-2026-09-06.md))
ran the family on 61,316 hourly bars (7.00y) with BH-FDR at q=0.05, drift-adjusted directional
excess, walk-forward splits and day-clustered bootstrap CIs. Verdict line: **"CLEARED: none."**
Worse than null in two places — H4b and H6 came back FDR-significant *in the opposite direction to
the one predicted* (H6: 45.96% vs 51.17% base, p=7.7e-24).

So there is nothing here worth risking capital on. What was missing was not another backtest, it was
(a) something observable running forward today, (b) a forward out-of-sample record with an honest
denominator — every bar written, not just the triggering ones — and (c) an execution path built
carefully in advance rather than hastily on the day something clears.

## The port is provably the backtested rule, not a paraphrase

Features and hypothesis definitions are lifted verbatim from
`backtest-2026-09-06/engine.js` (+ H1′ from `run.js`, H2redo and H5 from `phase3.js`). Verified by
running both implementations over the same 7-year dataset:

```
all feature arrays identical ✓        (lam, vpin, cumF, poc/vah/val, all 7 percentiles, atr, ema)
id      live_trig  orig_trig   match
H1             46         46    YES     ← report's n=46
H1p          6203       6203    YES
H2           7388       7388    YES
H3            358        358    YES     ← report's n=358
H4a          4213       4213    YES
H4b         23212      23212    YES
H6          11489      11489    YES
```

The file exports its internals purely so this diff stays runnable; `require` never starts the loop.
**If a threshold in `hypotheses1h()` is ever edited, that parity is void and the live readings stop
being comparable to the published result.**

Causality is inherited, not re-argued: every percentile at `t` uses only `[t−720, t−1]`, and the
in-progress Binance bar is dropped by close time before features are built.

## Isolation

| | |
|---|---|
| collections | `orderflow_experiment_{signals,orders,state}` — never `trades` / `blofin_orders` |
| state | `.orderflow-experiment-state.json` |
| config | `.orderflow-experiment-config.json` |
| breaker | `.orderflow-experiment-disabled.json` |
| orders | `clientOrderId` prefix `ofexp-` — identifiable inside BloFin's own history |
| data | Binance public REST only — no TradingView, no CDP, no `.tradingview-lock` |
| Discord | existing `BLOFIN_RECON_WEBHOOK`, every post prefixed `🧪 ORDER-FLOW EXPERIMENT` |

Reads `lib/{db,blofin,discord,env}.js`; modifies none of them. Does not read or write
`.autotrade-disabled.json`, `trades.json`, or anything owned by `scripts/trigger-check.js` — that
signal stays disabled and untouched.

## What `TRADING_ENABLED` gates

`.orderflow-experiment-config.json` → `tradingEnabled`, **currently `false`** (auto-created with that
default on first run). Env `ORDERFLOW_TRADING_ENABLED=true` overrides upward only.

False ⇒ readings computed, persisted and posted; `maybeTrade()` returns `observed` before touching
the exchange. A hypothesis that *would* have fired is still named in the bar post, so a dormant
would-fire is never invisible.

Turning it on needs **both** `tradingEnabled: true` **and** `hypothesis` naming one id — the engine
refuses an unnamed or unknown rule and posts the refusal. That second key is the real gate: it
demands someone name a specific hypothesis that has cleared a *fresh* pre-registered test. Re-reading
the 2026-09-06 results does not qualify; they refuted all eight. **This is a future decision and was
not taken here.**

## Circuit breaker

`.orderflow-experiment-disabled.json` — presence disables placement, checked immediately before every
order. It exists from day one deliberately: the old signal's falsification gate was bolted on
afterwards and the breaker is the piece you cannot retrofit calmly.

Nothing trips it yet, because nothing trades and there is no forward record to judge. The extension
point is `evaluateFalsification()`, with the intended shape written into its docblock — Wilson lower
bound, Fisher against the non-triggered arm, day-clustered bootstrap on mean R, trip when the
bootstrap upper bound on mean R sits below zero net of the pre-registered 14bp round trip, or the
Wilson lower bound sits under the base rate two windows running. Reuse
`backtest-2026-09-06/stats.js` — it is the validated implementation, not a re-derivation.

## Two audit defects designed out

Both from [btc-audit-2026-08-03.md](btc-audit-2026-08-03.md), and both were failures of *silence*.

**A4** — sizing against a risk budget the account's margin could not satisfy, producing zero orders
for weeks with no signal that anything was wrong. Here contract value, lot step, exchange minimum and
available margin are all fetched live before placing; a size below `minSize` or a required initial
margin above 30% of available produces a **posted** skip naming both numbers
(`sized at X contracts (notional $N, margin $M), doesn't fit available margin $A`). There is no
branch that drops an intended order quietly.

**A6** — the ledger recorded the planned entry rather than the fill, understating losses ~2.4×. Here
`fillPrice/filledSize/filledAt` come from `orders-history` by `clientOrderId` after placement and are
the canonical record; the plan is kept in a separate `planned` sub-document that is never the P&L
basis. An unresolved fill is stored as `null` with `fillResolved: false` — never backfilled from the
plan.

SL is standalone `order-tpsl` (mark trigger), verified present in pending TPSL, and the position is
reduce-only flattened if verification fails — the Phase B.6 lesson, not re-learned.

## Env

No new required vars. One new optional one, documented in `.env.example`:
`ORDERFLOW_TRADING_ENABLED` (default unset = off). Reuses `BLOFIN_RECON_WEBHOOK`,
`ACCOUNT_EQUITY_USD`, `BLOFIN_*` credentials.

## Ops

`make orderflow-status` · `make orderflow-logs` · `make orderflow-probe` (Binance → 9 readings →
Mongo → Discord end-to-end). `pm2 save` done.

First live post, 2026-09-06 13:36 UTC, bar `12:00`, BTCUSDT $79,882 — all nine quiet
(λ P6, |Fn| P10, vol P18, |δ| P11, VPIN(vb) P60).

## What this does NOT do

It observes; it does not decide. Accumulating forward bars is not evidence and must not be mistaken
for it — any future cell tested off this data counts toward the same cumulative BH-FDR family as the
rest of the hunt ([rebuild/research-log.md](../rebuild/research-log.md)). The engine posts the
2026-09-06 verdict under every bar for exactly that reason.
