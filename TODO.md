# TODO

Outstanding tasks for the Ace Trading System. Items are grouped by urgency and dependency order.

---

## Active — do these now or soon

### ✅ Phase 2 (`!took`/`!exit`) ACTIVATED 2026-05-15

Done. Use `!took <id>` after a signal, `!exit tp1|tp2|tp3|stop|manual <price>` on close. Weekly report now shows your execution track vs system. See [refactors/2026-05-15-btc-took-exit-activation.md](refactors/2026-05-15-btc-took-exit-activation.md).

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
