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

---

# Addendum — paper book + BloFin read integration (same day, second pass)

## Paper layer

One simulated account, seeded at **$3,000**, trading a *composite* of the nine readings rather than
nine toy strategies on one balance. Only hypotheses that are both triggered and directional vote;
quiet and n/a ones abstain. Entry requires **≥2 voters and ≥0.60 agreement** — so a 2-vote bar must
be 2-0, a 3-vote bar 2-1, a 4-vote bar 3-1, and split decisions are rejected rather than settled by a
coin-flip tiebreak. Those are activity-rate choices measured off the trigger distribution of the
trailing 1,421 live bars (`minN=2` → 16.8% of bars, ~1 entry per 6), **not** fitted parameters:
nothing was selected on outcomes, because no outcomes existed.

Full lifecycle per position — modelled fill, `1.5 × ATR14` stop, `+2R` target, 6-bar time stop,
per-bar mark-to-market, realised P&L. One position at a time, mirroring BloFin net mode. Both stop
and target touched inside one bar resolves as the **stop** (no intrabar path; pessimistic, and
stated). Sizing uses the same config knobs as the real path against the paper balance, with one
deliberate difference: where `maybeTrade()` posts a visible skip on a margin-cap breach, the paper
book scales down and records `sizeCappedByMargin` — a real account going silent is audit defect A4;
a paper account going silent just shows the owner nothing.

**The composite has not been backtested.** It is nine individually-refuted components in a
trenchcoat. Provenance lives on every stored document as `mode: "paper"`, in the code's honesty note,
and here — deliberately *not* in the Discord copy, which reads as plain trade alerts by request.
Collections `orderflow_experiment_paper_{trades,equity}`, never `..._orders`.

## BloFin read integration

The engine computed everything from Binance while claiming to emulate a BloFin automation. That is a
Binance backtest wearing a BloFin label, and this project has already measured the two venues
disagreeing — the carry research put BloFin funding at 6.22%/yr against Binance's 11.67%/yr, ~13pp
apart and at one point opposite in sign. So the venue is now read directly.

**Probed before written**, per the docs-are-wrong rule. Findings:

| | Truth (probed 2026-09-06, demo) |
|---|---|
| Path | `tickers` and `books` are **plural**. Singular `/market/ticker`, `/market/book` return the Cloudflare landing page — *not* 152404, so a wrong path is indistinguishable from an IP block |
| Shape | every endpoint returns an **array** in `data`, even for a single `instId` |
| Ticker fields | `bidPrice`/`askPrice`/`bidSize`/`askSize`/`last`/`ts` — **not** OKX's `bidPx`/`askPx` |
| Book levels | 2-tuples `[price, size]` — **not** OKX's 4-tuple `[price, size, liquidated, orders]` |

Added to `scripts/lib/blofin.js`: `getTicker`, `getOrderBook`, `getMarkPrice`, `getFundingRate` —
all unsigned GETs. Mark price is read separately from `last` because every SL this project places
triggers on `mark`, so mark is the price that decides whether a stop fires.

`blofinSnapshot()` runs once per cycle and persists to a new **`orderflow_experiment_blofin_market`**
collection (one row per 1h bar) plus a summary on the signals doc. It records ticker, L2 top of book,
mark/index, funding (annualised), and — reference only — the demo account's available margin.

**Fill model.** Applied slippage is `max(BloFin's measured half-spread, the pre-registered 2bp)`.
Taking the max means the real book can only make the simulation *more* expensive, never cheaper: a
venue quoting 0.013bp at the touch would otherwise hand the paper account a cost model far kinder
than the one the 7-year family was scored on, and the P&L would stop being comparable. Every trade
records `entrySlipBp/exitSlipBp` and their source (`blofin-book` | `model-floor`).

**Basis measured honestly.** The first cut compared BloFin's live tick against the 1h bar close and
called the +11.5bp result a basis; it was mostly elapsed time. `blofinSnapshot()` now reads Binance's
live `bookTicker` in the same breath, so `venueBasisBps` is mid-vs-mid at one instant (−0.03bp
observed) and the bar-close comparison is kept separately as `driftFromBarCloseBps`, named so nobody
reads it as a venue gap.

## The boundary

Read-only, enforced by construction and grep-verifiable: the only `placeOrder`/`placeTPSL` call sites
in the file are inside `maybeTrade()`, above the PAPER LAYER banner. The paper layer calls
`getTicker`/`getOrderBook`/`getMarkPrice`/`getFundingRate`/`getBalance` and nothing else. The demo
balance is recorded for comparison and **never sizes a paper trade** — sizing runs off the
independent $3,000 notional in `state.paper` and would be byte-identical if the balance call returned
nothing. `orderflow_experiment_orders` remains at 0 documents.

## Defect found in the dormant order path

`maybeTrade()` read available margin as `bal?.details?.find(...) ?? bal?.available`. `getBalance()`
returns a **flat array** of currency rows, so that resolved to `0` and would have failed *every* size
against $0.00 available — reintroducing audit defect A4 (zero orders, silently) inside the very
function whose docblock claims to have designed it out. Fixed to the canonical idiom used by
`blofin-autotrade.js:530` and `watchdog.js:521`. Fail-safe direction, but it would have guaranteed
zero orders forever the day the gate opened.

## Blocker: the host's VPN egress

BloFin market reads succeed **2/12 over the default route** and **12/12 bound to `en0`**, measured
minutes apart on 2026-09-06 — the ProtonVPN/Cloudflare 403 from the 2026-07-10 and 2026-08-03
incidents, now far worse than the 32.3% recorded then. `blofinSnapshot()` retries 3× and then records
`ok:false` with the reason, so a gap in this dataset is always visible *as a gap*; but at ~17%
per-call availability the BloFin arm will be mostly null until the egress is fixed.

`scripts/lib/blofin.js` now supports `BLOFIN_BIND_INTERFACE` (`localAddress` bind, unresolvable
interface degrades to the default route). It is **OFF by default and unset in `.env`** — turning it
on changes transport for recon, the kill switch, the watchdog and autotrade too, which is the
account owner's call, not this change's. Setting `BLOFIN_BIND_INTERFACE=en0` is the one-line fix.

## Verified end to end, 2026-09-06 18:10–18:12 UTC

Bar `17:00`, BTCUSDT $79,708 — all nine quiet. Mongo `1h-1788714000000` carries 9 readings *and*
the BloFin snapshot (last $79,800, spread 0.013bp, mark $79,800.7, funding +4.47%/yr, demo available
$2,999.998); `bf-1h-1788714000000` written to the new collection; three Discord posts landed in
`#blofin-recon` with the BloFin line present. A forced round trip exercised the full lifecycle
(`--paper-force=long` → `--paper-close`, −$4.29 = exactly the pre-registered 14bp on $3,061 notional).
That trade is retained in Mongo flagged `forced: true`, and the book was reset to $3,000 / 0 trades
afterwards — a smoke test is not a decision the composite made and does not belong in the forward
track.

## Also worth knowing

`pm2 orderflow-engine` was found **stalled**: the 30s poll loop stopped completing cycles at
17:05 UTC after a burst of `cycle error: fetch failed`, missed the 17:00 bar, and sat idle for 55+
minutes with the process alive, 0% CPU and zero outbound HTTPS. The `fetch failed` lines themselves
were transient (Binance answers fine from this host), but the engine did not recover from them.
Nothing watches this process — `ops/watchdog.js` self-heals `book-recorder` but has no orderflow
check, and the `--status` STALE threshold at 90 minutes has no caller.
