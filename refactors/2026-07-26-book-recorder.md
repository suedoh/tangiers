# Order-book recorder — starting the round-2 corpus (2026-07-26)

Spec 07 round 1 found no edge in 2 years of price-derived data
([note](2026-07-26-spec07-hunt-round1.md)). The obvious next move is information the bars cannot
contain — resting liquidity, its asymmetry, trade-level aggression, forced liquidations. **Binance
serves none of that historically.** The only way to own it is to start recording, so this is the
one task where a day of delay is a permanent day of missing corpus.

`scripts/research/book-recorder.js`, running under pm2 alongside `bz-news-watch`. One JSON line per
UTC minute in `data/orderbook/<symbol>-YYYY-MM-DD.ndjson` (gitignored, ~1 MB/day).

## The finding that changed the design

The first build subscribed to `aggTrade`, `markPrice@1s`, `forceOrder` and `depth20@100ms`, and it
produced beautiful, well-formed rows — **with every flow column zero**. It would have looked
healthy for a month.

Measured, per stream, before trusting any of them:

| stream | 30s test | verdict |
|---|---|---|
| `btcusdt@depth20@100ms` | ~600/min | ✅ used |
| `btcusdt@bookTicker` | ~13,000/min | ✅ used |
| `btcusdt@trade` | ~1,000/min | ✅ used |
| `btcusdt@forceOrder` | 0 | ⚠️ subscribed, **unverified** |
| `btcusdt@aggTrade` | **0** | ❌ replaced by `@trade` |
| `btcusdt@markPrice@1s` | **0** | ❌ replaced by REST `premiumIndex` poll |

The sockets for the failing streams *open and stay open* — `readyState 1`, no error, no close, no
data. Had the recorder been left as written, `trades`, `mark`, `funding` and `basis` would have been
structurally null for as long as it ran, and the gap would only have surfaced when someone tried to
research with them. Substitutes are strictly better anyway: `@trade` is finer-grained than
`@aggTrade`, and `bookTicker` adds touch-size dynamics at ~20× the depth snapshot rate.

Liquidations are genuinely rare, so a quiet 30s cannot distinguish "broken" from "nothing happened."
`forceOrder` stays subscribed and the state file carries a running **`liqSeen`** counter. **If that
is still 0 after a volatile day, the stream is dead and the `liq*` columns must not be used.**
`make book-status` prints the warning while the counter is zero.

## Recorded per minute

`obi1/obi5/obi20` (mean, sd, last) · `obiTouch` (best-bid/ask size imbalance) · `spread`, `spreadMax`
· `dBid`, `dAsk` (resting depth) · `slopeBid`, `slopeAsk` (volume-weighted distance of liquidity from
mid, bps) · `mpDev` (microprice deviation) · `trades`, `tvol`, `tbuy`, `tmax`, `tbigBuy`, `tbigSell`
(≥5 BTC blocks) · `liqLong`, `liqShort`, `liqN`, `liqNotional` · `mark`, `funding`, `basisBps`,
`markAge`.

First live full minute, for the record:

```
samples 496  ticks 1303  obi20 0.446  obiTouch 0.3084  spread 0.0155bps
dBid 12.96  dAsk 4.85  trades 157  tvol 8.14  tbuy 6.32  mark 64670.7
funding 0.00003591  basisBps −4.2983  markAge 12
```

## Honesty rules built in

- `samples` and `ticks` on every row — a degraded minute is visible and filterable, never interpolated.
- Minutes with no data are written as explicit `gap: true` rows. A missing row and a silent row mean
  different things, and research must be able to tell them apart.
- `markAge` records how stale the REST mark snapshot was at write time, so a frozen poll cannot
  masquerade as a fresh reading.
- Aggregates stay close to raw so tomorrow's feature idea isn't blocked by today's feature choices.

## Monitoring

New `bookRecorder` watchdog class (15-min staleness on `.book-recorder-state.json`, skipped entirely
when the recorder isn't installed). Same lesson as the 158 hung crons and the 24h margin lock:
**something that fails silently needs a watcher, and this one's failure is unrecoverable** — you
cannot backfill an order book.

`make book-status` · `make book-logs` · `pm2 save` done so it survives a pm2 resurrect.

## What this does NOT do yet

It records; it does not analyse. Joining these minute rows to the barrier labels and re-running the
harness needs ~30+ days of coverage before any cell is worth testing — and every cell tested will
count toward the same cumulative BH-FDR family (98 and counting) in
[rebuild/research-log.md](../rebuild/research-log.md). No shortcut, no early peeking.
