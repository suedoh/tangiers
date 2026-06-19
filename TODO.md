# TODO

Outstanding tasks for the Ace Trading System. Items are grouped by urgency and dependency order.

---

## Active — do these now or soon

### ✅ Phase 2 (`!took`/`!exit`) ACTIVATED 2026-05-15

Done. Use `!took <id>` after a signal, `!exit tp1|tp2|tp3|stop|manual <price>` on close. Weekly report now shows your execution track vs system. See [refactors/2026-05-15-btc-took-exit-activation.md](refactors/2026-05-15-btc-took-exit-activation.md).

---

### Phase D attribution — `trades.json` outcome vs exchange ground truth

**Status:** Tracking. Don't start until ≥15 paired signals accumulate (~mid-July 2026 at current 5/day cadence).

**Why:** Phase D health check on 2026-06-19 surfaced signal `1781716810783-VAH-65724` (2026-06-17T17:20 UTC short B) marked `outcome=stop` in `trades.json` but on BloFin its TP1 + TP2 buy-limits both filled profitably at $65,454 / $65,310 before any stop trigger. The bar-walk outcome detector in `trigger-check.js` conservatively scores `stop` when a 30M candle wicks above SL *and* below TP1 in the same bar; the exchange knows the atomic fill order. CLAUDE.md flagged this as a known limitation; Phase D is the first time we have paired data to quantify systematic drift.

**What to do when ready:**
- Pull Phase-D-era signals from `trades.json` (firedAt ≥ 2026-06-15)
- Join to `blofin_orders` collection by `signalId`
- Per signal compute: `pnlR_trades_json`, `pnlR_exchange_realized`, `delta`
- If systematic delta > 0.2R, fix the bar-walk detector OR pivot Phase D evaluation to use exchange fills as ground truth
- Save analysis to `refactors/2026-07-XX-phase-d-attribution.md`

This is measurement-and-decision, not a code change. **No urgency** — exchange fills are durable in Mongo, the analysis can wait until the data is rich enough.

---

### Update `strategies/smc-setups.md`

The setup criteria file still references LuxAlgo CHoCH/BOS as entry triggers. The automated system now uses VRVP levels. The file needs updating to:

- Describe the three setup types in terms of VRVP context (at VAL = demand bounce, at VAH = breakout confirmation, at HVN = mean reversion)
- Keep the manual/Claude analysis section with indicator criteria (still valid)
- Remove references to LuxAlgo EQH/EQL for Setup C (the automated system does not detect these)
- Update entry trigger from "30M CHoCH" to "30M bar close beyond entry price with CVD confirmation"

---

### Update `strategies/mtf-analysis.md`

The MTF analysis protocol references LuxAlgo BOS/CHoCH labels and supply/demand boxes as primary data sources. These are still useful for manual analysis but should be noted as supplementary — the primary structure now comes from VRVP levels.

Review and update to:
- Lead with VRVP level analysis per timeframe
- Move LuxAlgo structure labels to "supplementary context" section
- Update synthesis grid to include VRVP structural position (above POC, at VAL, etc.)

---

## Poly BTC-5 — quant follow-ups (audit 2026-05-24)

See `refactors/2026-05-24-poly-btc-5-label-audit.md` and `2026-05-24-poly-btc-5-entry-price-tracking.md` for the underlying audit. Items below are gated on **≥150 entry-tracked OOS signals AND label-error rate <0.5%** before any code/threshold changes ship.

### Comparator baselines in `!summary` (Tier A3)
Add `naive_up`, `naive_continuation`, and `random` baselines to `scripts/poly/btc-5/summary.js` over the same window. Reports edge as `(strategy_wr − baseline_wr)`, not just absolute wr. Without comparators, 65% wr in a trending tape might be just 5pp above always-buy-UP.

### Day-clustered bootstrap CIs (Tier B1)
Wilson CI assumes independence. Two signals on the same UTC day share regime / news / vol. Switch the headline CI to day-clustered bootstrap once n ≥ 150. Expect intervals to widen ~30%.

### BH-FDR correction when ranking buckets (Tier B2)
`!summary` flags "best hour" by raw wr. With 13 hour-buckets tested, pure noise produces one ~85% bucket by chance. Apply Benjamini–Hochberg before claiming significance.

### Fisher's exact test for score gradient (Tier B3)
Currently 5/6 wr ≈ 65%, 6/6 wr ≈ 79%. Looks real but n=33 on 6/6. Run Fisher on the 2×2; if p < 0.05 survives FDR, 6/6 deserves higher sizing.

### Pre-registered interaction tests (Tier B4)
Pick 4–6 plausible interactions (direction × hour, score × cleanAir, CVD-strong × VWAP) and test only those. Skip exhaustive search — fishing finds noise.

### Regime decomposition (Tier C1)
Bucket signals by realized 1h vol (low/mid/high) and BTC weekly trend. A single 65% wr likely hides 80% in trend / 50% in chop. Both a finding and a sizing rule.

### Calibration refit (Tier C2)
Current `prob = 50 + 9·|edge|` is a guess; ECE is currently ~13pp. After OOS window, refit on actual data (isotonic or Platt). Only matters if sizing by probability.

### Chainlink-vs-Binance oracle drift monitor (OQ1)
Sample Chainlink BTC/USD reference at bar boundaries; log alongside Binance Futures bar close. After 500+ signals, quantify systematic bias and decide whether to switch outcome source.

### Polymarket execution layer (eventually)
Forward-only entry-price tracking is the foundation. Eventual paid-execution work would add: auth (Polymarket private key), order placement, fill tracking, real P&L (not paper). Not on the near roadmap.

---

## Backlog — good improvements, not urgent

### Funding rate integration into probability score

Add Binance Futures funding rate to setup evaluation. Penalize probability when funding is extreme (>0.1% per 8h) in the trade direction.

Binance endpoint: `GET /fapi/v1/fundingRate?symbol=BTCUSDT` (public, no auth).

See `docs/progressive-enhancements.md` Tier 2.1 for full spec.

---

### Multi-TF VRVP confluence bonus

Check whether a 30M VRVP level aligns with 4H or 12H VRVP levels. Add confluence bonus to probability score.

See `docs/progressive-enhancements.md` Tier 2.4 for full spec.

---

### Probability score calibration

After 50+ confirmed closed trades, recalibrate criterion weights using actual win/loss data. Replace empirically-estimated weights with data-driven ones.

See `docs/progressive-enhancements.md` Tier 1.4 for full spec.

---

### Multi-symbol support (ETH, SOL)

Extend `trigger-check.js` to watch ETH/USDT.P and SOL/USDT.P. The `.env` naming convention (`DISCORD_ETH_BACKTEST_WEBHOOK_URL`) is already in place.

See `docs/progressive-enhancements.md` Tier 1.3 for full spec.

---

### Historical backtesting engine

Write a separate `backtest.js` that downloads historical 30M OHLCV from Binance and replays `trigger-check.js` logic to validate strategy parameters before deploying changes.

See `docs/progressive-enhancements.md` Tier 4.1 for full spec.

---

## Known issues / limitations

### CVD checked at poll time, not confirmation bar time

The `checkConfirmation()` function uses the current CVD reading from the active poll rather than the CVD value at the moment the 30M confirmation bar closed. This means a trade can be confirmed even if CVD was against it at entry time. Directionally correct ~85% of the time. Fix is documented under Phase 3 above.

### VRVP visibility required

The automated pipeline reads VRVP levels via CDP from the visible TradingView chart. If the VRVP indicator is hidden, collapsed, or outside the current visible range, no levels are read and no triggers fire. TradingView Desktop must be running with the `🕵Ace` layout and VRVP visible.

### No LuxAlgo EQH/EQL detection

Setup C (Liquidity Grab) relies on detecting equal highs/lows. LuxAlgo labels these but the automated system no longer reads LuxAlgo labels. Setup C can still be executed manually using Claude Desktop analysis, but is not automatically detected.

### war report uses LuxAlgo zone references

`scripts/weekly-war-report.js` may reference 4H LuxAlgo supply/demand zones in its CDP reads. Verify and update to use VRVP levels if LuxAlgo was the data source. (Not verified this session.)
