# Poly BTC-5 — Entry-price tracking (audit Tier A1)
**Status:** DONE
**Owner:** suedoh
**Date:** 2026-05-24
**Audit reference:** quant playbook ("As a quant specializing…") conversation 2026-05-24

---

## Why

Win rate is a proxy. Polymarket pays `(1 − entry_ask)` on a winning UP/DOWN bet and `−entry_ask` on a loss. A 65% win-rate strategy that fills at 0.55c is +$0.10/share; at 0.70c it's −$0.05/share. Same wr, opposite economics. Until we record what we'd actually pay at signal time, all the wr/Brier/ECE work above sits on top of a missing denominator.

## What changed

### New module: [scripts/lib/polymarket.js](../scripts/lib/polymarket.js)

- `fetchMarketTokens(slug)` — resolves a Polymarket event slug to its two CLOB token IDs (Up + Down). Defensive: aligns by outcome label rather than position.
- `fetchOrderBook(tokenId)` — reads `clob.polymarket.com/book?token_id=...` and returns `{bid, ask, mid, spreadBps, depthAsk, ts}`. Returns null on any failure (HTTP, timeout, empty book). The cron path **never blocks** on Polymarket.
- `slugForBar(barOpenMs)` — Polymarket creates exactly one BTC Up/Down market per 5-min bar with slug `btc-updown-5m-<epochSeconds>`. Computing this deterministically removes our dependency on the (search-based, frequently empty) `discoverActiveMarket()` query.

### [trigger-check.js](../scripts/poly/btc-5/trigger-check.js)

At signal-fire (`score >= 5`), the script now:
1. Computes the bar's market slug → fetches tokens → fetches order book for the bet side (UP or DOWN token).
2. Writes `entryBid`, `entryAsk`, `entryMid`, `entrySpreadBps`, `entryDepthAsk`, `entryTokenId`, `entryMarketSlug`, `bookTs` to the trade record **before** the first `writeTrades()`.
3. Passes entry data to `buildEmbed` — the `#poly-btc-5` signal post now shows the entry line:
   ```
   Entry: 0.31 / 0.32 (mid 0.32, spread 317bps)
   ```
4. Links to the bar-specific market URL (overrides the stale `_marketUrl` cache when book capture succeeds).

`formatBacktestLine` in trigger-check.js + [backfill-backtest-posts.js](../scripts/poly/btc-5/backfill-backtest-posts.js) now shows realized P&L per signal when `entryAsk` is present:
```
✅ `10:05 UTC` · **UP** 5/6 · $76,934 · entry 0.32 → +0.68 · CVD+VWAP+1H+Clean+Session
```

### [summary.js](../scripts/poly/btc-5/summary.js)

When ≥30 signals in the requested window have `entryAsk`, the summary adds:
```
$-EV/signal: +$0.123  |  Total P&L: +$13.55 over 110 signals  |  Mean ask 0.41, spread 220bps
```

The 30-signal floor avoids reporting a noisy EV from the first few captures. While below threshold, a sentinel line shows progress (`*$-EV: 7 signals captured entry — need 30+ before showing*`).

## Risks

- **No historical backfill possible.** Polymarket's public CLOB doesn't expose historical books. Pre-2026-05-24 signals will never have `entry*` fields. The EV cohort starts from zero and grows forward-only.
- **CLOB outage / rate limit / slow response.** Caught — `fetchOrderBook` returns null, entry fields stay null, signal still fires with no entry context. Logged: `Polymarket book unavailable for slug …`.
- **Bar-vs-book skew.** Signal scoring completes within a few seconds; book read happens immediately after. Worst case: 1–2 cents of drift between book snapshot and the moment a human would actually click "buy." Logged as `bookTs` so we can audit.
- **No execution layer.** This is observation only — we record what we *would* pay, no actual orders. Sizing / Kelly / Polymarket auth are all future work.
- **The slug timestamp assumption is empirical, not contractual.** Verified live: every 5-min bar in the current window has exactly one matching market. If Polymarket changes their slug convention, the URL discovery silently goes to null — but the signal pipeline keeps working.

## Verification

- `node -c` clean on all 4 modified/new files.
- Live end-to-end test against the current 5-min market (`btc-updown-5m-1779621600`): tokens resolved, UP book read OK (bid 0.31, ask 0.32, spread 317bps, depth 257 shares).
- Existing audit ground-truth diff (`backfill-outcomes.js --dry-run`) still shows 0 disagreements with Binance.
- Sample `summary.js` output unchanged for pre-fix data (no `entry*` fields yet); the sentinel will appear once first signals come through.

## What's still open

- **OQ1 (Chainlink vs Binance oracle).** Unchanged — small per-bar drift. Will reassess once we have ≥150 OOS samples with entry data.
- **Old `discoverActiveMarket()` cron.** Has been silently failing (state shows `_marketUrl: null`). The new bar-slug method makes hourly discovery redundant; cron path no longer relies on the cached URL when entry capture succeeds. Worth a small follow-up to either retire the discovery or repurpose it as a sanity probe (does our computed slug match what Gamma search returns?).
- **Comparator baselines (audit A3).** Not in this commit. After ~7 days of entry data, the `!summary` command should also report "naive UP every bar EV" and "naive continuation EV" as benchmarks.
- **Day-clustered CIs (audit B1).** Not in this commit. Wilson CIs still in use; switch to day-clustered bootstrap once n ≥ 150 makes the difference meaningful.

## Decision history

| Date | Decision | Reason |
|---|---|---|
| 2026-05-24 | Use `entryAsk` for EV math (not mid) | Honest taker fill; ECE work later will adjust for fill quality |
| 2026-05-24 | Show entry line on live alerts + backtest | Spread visibility at decision time is itself a filter |
| 2026-05-24 | Deterministic slug-from-bar instead of search | Polymarket search was returning nothing; per-bar slugs are reliable |
| 2026-05-24 | 30-signal floor before showing $-EV | Below that, single outlier bars dominate the number |
| 2026-05-24 | Forward-only, no backfill | CLOB historical books not public; honest about the data gap |
