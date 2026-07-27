# 2026-07-27 — the liquidation feed was never broken, it was on another route

**Symptom.** `book-recorder.js` ran 15h with `liqSeen: 0`. The recorder's own header
had already flagged `aggTrade` and `markPrice@1s` as "connect but deliver nothing"
and worked around them (`@trade` instead of `@aggTrade`, REST `premiumIndex`
instead of the mark stream), leaving `forceOrder` subscribed but unverified.

**Root cause.** Binance's **2026-03-06 WebSocket upgrade** split futures market data
across routed paths — `/public`, `/market`, `/private` — and **decommissioned the
legacy un-routed URLs on 2026-04-23**. The recorder connected to
`wss://fstream.binance.com/stream?streams=…` (un-routed), which since that date
serves **only the `public` bucket**. Measured, 45–60s per stream:

| stream | un-routed | `/public` | `/market` |
|---|---|---|---|
| `@depth20@100ms` | 430 | ✅ 430 | — |
| `@bookTicker` | 19,949 | ✅ 19,949 | — |
| `@trade` | 4,114 | ✅ 4,114 | ❌ 0 |
| `@aggTrade` | ❌ 0 | ❌ 0 | ✅ 1,193 |
| `@markPrice@1s` | ❌ 0 | — | ✅ 45 |
| `!forceOrder@arr` | ❌ 0 | — | ✅ 25 |

So the three "dead" streams were alive the whole time on `/market`. The original
diagnosis generalised from one endpoint to "the stream is broken" and shipped a
workaround around a routing error.

**Why it stayed invisible.** The failure mode is silent by design:

1. An un-routed socket **opens normally** and never errors or closes.
2. `SUBSCRIBE` returns `{"result":null}` — and proves nothing. The server also
   accepts **`btcusdt@totallyFakeStreamXYZ`** and lists it in `LIST_SUBSCRIPTIONS`.
   Subscription acks are worthless as evidence; only frames count.
3. Liquidations are genuinely bursty, so "quiet" was a plausible-looking excuse —
   which is exactly why the `liqSeen` counter existed. It did its job.

**A trap avoided.** `stream.binancefuture.com` appears in Binance's own docs as a
base URL and *does* serve `aggTrade`/`markPrice`. It is **testnet**: its trade IDs
sit ~7.4e9 from production's (521M vs 7.93B) at ~7× lower volume, while
`fstream` matches REST truth within 1,121 IDs. Switching hosts would have silently
filled the corpus with fake fills. Another entry for the docs-are-wrong catalog.

**Fix.** Two independently-supervised connections, one per route:
- `/public/stream?streams=` → `@depth20@100ms`, `@bookTicker`, `@trade`
- `/market/stream?streams=` → `!forceOrder@arr`

Kept independent so a tick-feed drop cannot take the liquidation feed with it, and
because they cannot share a staleness threshold: `bookTicker` runs ~14k msg/min
while liquidations run ~25/min. The liq feed gets `LIQ_STALE_MS = 600s`; the tick
feed keeps 30s. A `done` guard stops `close`+`error` double-firing a reconnect.

**Market-wide, not per-symbol.** Subscribed to `!forceOrder@arr` and filtered for
BTC rather than `btcusdt@forceOrder`: BTC alone liquidates too rarely to keep any
staleness timer honest, and cross-symbol cascade intensity is itself a candidate
feature. New columns `liqAllLong/Short/N/Notional` alongside the BTC-specific ones.

**Verification.** `liqSeen 1 / liqAllSeen 12` within 2 minutes of restart, 0
reconnects, tick streams unaffected (20,708 ticks, 2,335 trades in the minute).
`scripts/research/route-check.js --all` passes 10/10 — including the four streams
that are *expected* to be silent, so it fails loudly if the contract changes again.

**Corpus caveat — read before analysing.** Rows from **2026-07-26 17:35 → 2026-07-27
12:44 UTC** (~908 minute rows) were recorded pre-fix: their `liq*` columns are
structurally zero and `liqAll*` is absent entirely. That is *missing*, not *quiet*.
Exclude that window from any liquidation feature, or the model learns "no
liquidations happen in July".

**Standing rule.** A silent Binance stream means **wrong route** until proven
otherwise. `node scripts/research/route-check.js` re-verifies the contract on
demand; run it before trusting any newly added stream.
