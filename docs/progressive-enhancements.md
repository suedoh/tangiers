# Progressive Enhancements

This document outlines the path from the current automated alert system toward an institutional-grade trading desk. Items are ordered by impact vs effort.

Items are grouped into tiers. The system is currently solid at **Tier 1**. Each tier builds on the last.

---

## Current State (Tier 0 — Baseline)

- VRVP-based zone detection, bar-accurate outcome tracking
- 7 alert types to Discord (signals, invalidations, stop hunts, reclaims, errors)
- Weekly performance report (3-track: all / confirmed / unconfirmed)
- On-demand MTF analysis via `!analyze` and 📊 emoji reaction
- Sunday institutional war report
- Fully automated, zero AI cost, zero manual input

---

## Tier 1 — Signal Quality & Execution Tracking

These are low-effort, high-impact improvements to the existing pipeline.

### 1.1 Per-Bar CVD Confirmation (Phase 3 remainder)

**What:** Check CVD at the time of each confirmation bar, not at the current poll time.

**Why:** Currently a trade could be stamped "confirmed" even if CVD was against the trade when the entry bar actually closed. This is directionally correct ~85% of the time but introduces noise.

**How:** Store CVD time-series in `_cvdHistory` in `.trigger-state.json`. Match to confirmation bar timestamp. (Full spec in `BACKTESTING.md` Phase 3 section.)

**Effort:** 1-2 hours.

### 1.2 Activate Phase 2 — Your Execution Track

**What:** Enable `!took` and `!exit` Discord commands to log your personal trade execution against system signals. Weekly report shows your win rate vs system baseline.

**Why:** Tells you whether your signal selection is adding value above the system's base rate. Critical for improving your discretionary filter.

**When:** After 10+ confirmed closed trades in `trades.json`. See `BACKTESTING.md` Phase 2 section for exact steps.

**Effort:** 30 minutes (mostly removing guards and uncommenting stubs).

### 1.3 Multi-Symbol Support

**What:** Extend `trigger-check.js` to watch ETH/USDT.P and SOL/USDT.P alongside BTC.

**Why:** Correlated signals across instruments can confirm macro moves. Divergences (BTC weak, ETH strong) are often leading indicators.

**How:** Parameterize the symbol in `trigger-check.js`. Add `DISCORD_ETH_BACKTEST_WEBHOOK_URL` etc. to `.env`. The naming convention is already in place.

**Effort:** 3-4 hours per instrument.

### 1.4 Probability Score Calibration

**What:** After 3+ months of data, recalibrate the probability score weights using actual win/loss outcomes.

**Why:** The current weights are empirically derived from general SMC theory, not from this system's actual performance. After enough trades, fit weights to actual data (logistic regression or simple frequency tables).

**When:** After 50+ confirmed closed trades across different market regimes.

**Effort:** Half-day data analysis session.

---

## Tier 2 — Signal Depth

These enhancements add new data sources or detection capabilities.

### 2.1 Funding Rate Integration

**What:** Add real-time Binance funding rate to setup evaluation. Extreme funding (>0.1% per 8h) in trade direction penalizes the probability score.

**Why:** Extremely positive funding = over-leveraged longs = higher squeeze risk for longs. Already excluded as a no-trade condition in the strategy doc but not enforced in code.

**How:** Binance Futures API `/fapi/v1/fundingRate` is public (no auth). Add to `trigger-check.js` alongside CDP reads.

**Effort:** 2-3 hours.

### 2.2 Order Book Depth at VRVP Levels

**What:** At signal time, read Binance order book depth (bids/asks within 0.2% of entry) via Binance API. Add "OB stacked" criterion to setup.

**Why:** Stacked bids at a demand VRVP level = real institutional interest. Thin book = level may not hold. This is visible on the TradingView DOM but not currently read.

**Effort:** 3-4 hours.

### 2.3 Fear & Greed Regime Filter

**What:** Add Alternative.me Fear & Greed Index as a regime filter. In Extreme Fear (<20), reduce position size or skip longs. In Extreme Greed (>80), skip longs / prefer shorts.

**Why:** Trend-following setups fail disproportionately at extremes. The war report already reads this index — pipe it into trigger-check.js.

**Effort:** 1 hour (index already fetched in war report).

### 2.4 Multi-Timeframe VRVP Alignment

**What:** Check whether a VRVP level on 30M also aligns with VRVP levels on 4H and 12H. Bonus points for higher-timeframe confluence.

**Why:** A VRVP HVN that exists on both 30M and 4H at the same price area is a significantly stronger level than one only visible on 30M.

**How:** Currently `trigger-check.js` reads VRVP only on the active timeframe (30M). Add CDP reads of 4H and 12H VRVP during the trigger evaluation.

**Effort:** 4-6 hours (requires TF switching in the trigger script, which adds latency).

---

## Tier 3 — Analytics & Adaptation

These enhancements make the system self-improving over time.

### 3.1 Level-Type Win Rate Feedback Loop

**What:** The weekly report already tracks win rate by level type (HVN vs VAL vs VAH vs POC). Feed this back into the probability score: if HVN win rate over 90 days is 78%, adjust the HVN base rate accordingly.

**Why:** The current probability model uses static weights. Different level types perform differently across market regimes. Self-updating weights make the score more accurate over time.

**Effort:** 1 day.

### 3.2 Regime Detection

**What:** Classify current market regime (trending up, trending down, ranging, low volatility) and filter setups accordingly. Trend-continuation setups (A) perform best in trending regimes; level-reversal setups (B) perform best in ranging regimes.

**How:** Use 30-day rolling stats from `trades.json` + current ATR relative to 90-day ATR. Post regime classification in the war report.

**Effort:** 1-2 days.

### 3.3 Automated Trade Journaling

**What:** After each closed trade, post a journaling summary to Discord: the setup screenshot at signal time, which criteria passed/failed, and the outcome with R multiple.

**Why:** Creates a searchable visual record. After 3 months you can scroll back and see exactly which setups looked good vs bad at entry.

**How:** `capture_screenshot` via TradingView MCP at signal time, attach to Discord message as an image. Store screenshot path in `trades.json`.

**Effort:** 1 day.

### 3.4 Session-Based Performance Breakdown

**What:** Break down performance by trading session (Asia 00:00–08:00 UTC, London 08:00–16:00 UTC, New York 13:00–21:00 UTC).

**Why:** VRVP levels interact differently with session opens and closes. London open is often the most reliable for continuation setups; Asia often fakes out. Knowing this informs which signals to weight more heavily.

**Effort:** Half-day (weekly report addition).

---

## Tier 4 — Institutional Grade

These are more significant engineering efforts that move the system toward professional-grade infrastructure.

### 4.1 Historical Backtesting Engine

**What:** Download historical 30M OHLCV data from Binance and replay signals against actual price history to test strategy parameters before deploying live changes.

**Why:** Currently the system can only test parameters going forward. To validate a probability weight change you need to wait weeks. A historical engine lets you simulate months of trading in minutes.

**How:** Binance Futures OHLCV API has full history. Write a separate `backtest.js` that replays the `trigger-check.js` logic over historical bars and outputs a performance report.

**Effort:** 3-5 days.

### 4.2 Execution Integration (Paper Trading First)

**What:** Integrate Binance Futures API to automatically place orders when the system generates a signal. Start with paper trading mode.

**Why:** Removes execution delay and emotion from entries. The system already calculates exact entry, stop, and TP levels — routing them to the exchange is the next logical step.

**How:** Binance Testnet for paper trading. When confidence in the strategy is high (50+ confirmed trades, consistent win rate), move to live.

**Effort:** 1-2 weeks (significant complexity in order management, partial fills, position sizing).

### 4.3 Multi-Exchange Arbitrage Signals

**What:** Compare funding rates and OI across Binance, Bybit, and OKX. When OI diverges significantly between exchanges, it can signal institutional positioning ahead of a move.

**Why:** Professional desks watch cross-exchange flow. A single-exchange view misses a significant portion of market structure.

**Effort:** 1-2 days for data reads; ongoing calibration.

### 4.4 Options Market Integration

**What:** Daily Deribit options reading: put/call ratio, max pain, gamma exposure (GEX) levels. Post these to the war report and flag when price approaches a high-GEX level (market maker pinning zone).

**Why:** Options market makers hedge their delta exposure at specific price levels, creating artificial support/resistance that pure futures analysis misses. Max pain and high-GEX levels are well-known institutional anchors.

**How:** Deribit public API already partially fetched for war report. Extend to calculate daily GEX levels.

**Effort:** 2-3 days.

### 4.5 Macro Event Pre-Trading Protocol

**What:** Automatically pause `trigger-check.js` for 2 hours before any high-impact USD macro event (FOMC, CPI, NFP) and resume after. Post a "macro blackout" notice to Discord.

**Why:** These events cause violent price action that invalidates technical levels. The ForexFactory feed is already read by the war report.

**Effort:** Half-day.

---

## What "Institutional Grade" Looks Like

When all tiers are complete, the system would have:

- **Data**: Real-time VRVP + order book depth + funding rate + options GEX + cross-exchange flow
- **Signals**: Calibrated probability model (3+ months of actual trade data), per-bar CVD confirmation, multi-TF VRVP confluence
- **Execution**: Automated order placement with hard risk limits, position sizing from account equity
- **Analysis**: Self-updating regime detection, session-based performance, automated journaling
- **Reporting**: Daily P&L, regime-adjusted win rates, drawdown tracking, Sharpe-equivalent metric for futures

The current system already does the hardest part correctly: it reads real institutional data (VRVP, CVD, OI), evaluates it with sound logic, and tracks actual performance. Everything above is additive refinement.
