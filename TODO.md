# TODO

Outstanding tasks for the Tangiers Trading System. Items are grouped by urgency and dependency order.

---

## Ace — Active (do these now or soon)

### Activate Phase 2 (when ready)

Phase 2 (`!took` / `!exit` execution tracking) is fully implemented but behind early-return guards. Activate it when `!trades` consistently shows 10+ entries with `outcome` populated and `confirmed: true` on most of them.

**Steps:**
1. Open `scripts/discord-bot.js`
2. Find `handleTook()` — remove the "Phase 2 not yet active" early-return block (2–3 lines)
3. Do the same in `handleExit()`
4. Open `scripts/weekly-report.js`
5. Find `// ── Phase 2 stub: your execution track ──` in `analyse()` — uncomment the `myTrack` lines
6. Replace the `executionLines` stub in `formatReport()` with real `myTrack` data

**Context:** See `BACKTESTING.md` Phase 2 section and `docs/performance-tracking.md` for full details.

---

### Phase 2 data validation checklist

Before activating Phase 2, verify these in `trades.json` (run `!trades` in Discord or read the file directly):

- [ ] At least 10 entries exist
- [ ] `confirmed: true` on 50–75% of entries
- [ ] `confirmedAt` is hours after `firedAt` (not seconds — seconds = confirmation too loose)
- [ ] `outcome` is populated on closed trades (`null` on open is correct)
- [ ] `pnlR` values match the R:R ratios in the signal (TP2 should equal `rr2`)
- [ ] `closedAt` times are realistic (hours to days, not minutes, not 29 days)
- [ ] Manually verify one trade: find `firedAt` on TradingView 30M chart, confirm outcome matches what price did

---

### Per-Bar CVD Confirmation (Phase 3)

Currently `checkConfirmation()` checks CVD at the current poll time, not at the moment the 30M confirmation bar closed. Directionally correct ~85% of the time but introduces noise.

**Steps (from `BACKTESTING.md`):**
1. In `trigger-check.js` `main()`: append `{ ts: Date.now(), cvd: indicators.cvd }` to `state._cvdHistory` (cap at 200 entries)
2. In `checkConfirmation()`: for each confirmation bar, find the closest `_cvdHistory` entry by timestamp and use that CVD reading instead of `indicators.cvd`

**Effort:** ~1–2 hours.

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

## Ace — Backlog (good improvements, not urgent)

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

## Ace — Known issues / limitations

### CVD checked at poll time, not confirmation bar time

The `checkConfirmation()` function uses the current CVD reading from the active poll rather than the CVD value at the moment the 30M confirmation bar closed. This means a trade can be confirmed even if CVD was against it at entry time. Directionally correct ~85% of the time. Fix is documented under Phase 3 above.

### VRVP visibility required

The automated pipeline reads VRVP levels via CDP from the visible TradingView chart. If the VRVP indicator is hidden, collapsed, or outside the current visible range, no levels are read and no triggers fire. TradingView Desktop must be running with the `🕵Ace` layout and VRVP visible.

### No LuxAlgo EQH/EQL detection

Setup C (Liquidity Grab) relies on detecting equal highs/lows. LuxAlgo labels these but the automated system no longer reads LuxAlgo labels. Setup C can still be executed manually using Claude Desktop analysis, but is not automatically detected.

### war report uses LuxAlgo zone references

`scripts/weekly-war-report.js` may reference 4H LuxAlgo supply/demand zones in its CDP reads. Verify and update to use VRVP levels if LuxAlgo was the data source. (Not verified this session.)

---

## Billy Sherbert — Active / High Priority

### Phase A completion
- [ ] Reach 20+ resolved shadow YES+range trades under the dual filter (`sigmaF < 0.75°F AND |biasCorrection| < 2.0°F`) — currently tracking silently. Run `!performance` → 🔬 section to see progress.
- [ ] Reach 20+ resolved shadow YES+above trades under the dual filter (`sigmaF < 1.5°F AND biasCorrF > -2.0°F`) — same shadow pipeline. 78% WR on n=9 historical; validate before activating.
- [ ] Validate bias corrections have converged: run `!report` to recalibrate, then check `bias-corrections.json` — Houston and Dallas are missing (fewer than 5 resolved trades each).
- [ ] Consider blocking Jeddah (~14% WR) and Milan (~27% WR) once sample size crosses 10 trades each — add to `BLOCKED_CITIES` in `market-scan.js` with documented reason.

### Calibration
- [ ] Run `!report` to refresh `bias-corrections.json` — corrections were built on 348 trades; now 554+ resolved. Houston/Dallas have no entry yet.
- [ ] Monitor high-bias cities post-correction for 2–3 weeks: Miami (+5.72°F corr), Munich (+5.25°F), Warsaw (+4.85°F), Istanbul (blocked), Taipei (+3.13°F).

---

## Billy Sherbert — Medium Priority

### Shadow filter activation (future)
- [ ] **YES+range**: when shadow resolved count reaches ~20, check `!performance` 🔬 section. If WR ≥ 55%: replace the hard block in `market-scan.js` with `if (sigmaF < 0.75 && Math.abs(biasCorrF) < 2.0)` gate.
- [ ] **YES+above**: same process. If WR ≥ 60% at n≥20: replace block with `if (sigmaF < 1.5 && biasCorrF > -2.0)` gate. Historical data shows 78% WR on n=9 — promising but needs validation.
- [ ] Add `sigmaF` and `biasCorrF` fields to the Discord signal card so they're visible at signal time.

### Stage 2 deep analysis (Sonnet)
- [ ] Currently gated behind `WEATHER_DEEP_ANALYSIS=false`. Enable only after Phase B activation and when API credits support it.
- [ ] Validate Stage 1 (Haiku) confidence calibration first — check `!performance` Embed B confidence buckets. If >0.85 confidence bucket WR ≥ 60% with n≥20, Stage 1 alone may be sufficient.

### Settlement accuracy
- [ ] Cross-check GHCN-Daily station IDs in `city-profiles.js` against Polymarket's stated settlement source for each city. Discrepancies are the #1 source of "model win, Polymarket loss" edge leakage.
- [ ] Add `--id <id>` dry-run output comparison: settle.js already supports `--id` flag. Use it on past trades to verify settlement values match Polymarket's recorded outcomes.

---

## Billy Sherbert — Low Priority / Future

- [ ] `exit-monitor.js` — currently runs inside `market-scan.js` per cycle. Consider moving to a standalone scheduled entry (every 5 min) for faster early-exit detection on live positions.
- [ ] Weekly war report — add a `weekly-war-report.js` covering the coming week's forecast landscape: which cities have highest model uncertainty, which markets are already open with thin liquidity.
- [ ] Backtesting harness — replay `weather-trades.json` against different edge thresholds, Kelly fractions, and city blocklists without running live scans. Useful before Phase B tuning.

---

## Billy Sherbert — Known Issues

| Issue | Impact | Status |
|---|---|---|
| Bias corrections don't exist for cities with <5 resolved trades | Probability calc uses uncorrected mean for these cities | Resolves naturally as sample grows |
| `sigmaF` not displayed in signal Discord cards | Can't eyeball model confidence at signal time | Low priority — add to card in next signal card revision |
| Shadow trades show as "open" in `!trades` before settling | Cosmetic — they're correctly filtered from stats | Fixed: `!t.shadow` guard added to `handleTrades()` |
| Stage 2 (Sonnet) disabled | Some complex setups get Haiku-only analysis | By design — cost control; revisit at Phase B |
| `weekly-report.js` bias recalibration requires 5+ trades per city | Houston/Dallas corrections absent | Resolves naturally |
