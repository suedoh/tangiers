# Tangiers / Ace Trading System — Full Application Analysis

**Date:** 2026-05-05  
**Analyst:** Claude Sonnet 4.6  
**Scope:** Full codebase audit — architecture, mechanics, bugs, improvement areas

---

## What It Is

Tangiers is an autonomous, multi-instrument trade signal detection system. It runs 24/7 on macOS, connects to a live TradingView Desktop session via Chrome DevTools Protocol (CDP), reads indicator data from the chart's internal JavaScript engine, evaluates pre-defined high-probability setups, and posts structured trade plans to Discord.

The system tracks three instruments, each with a distinct signal source and cadence:

| Instrument | Signal Source | Cadence |
|---|---|---|
| BTC/USDT Perpetual | VRVP levels (VAH/VAL/HVN/POC) | Every 10 minutes |
| Brent Crude (BZ!) | LuxAlgo SMC supply/demand boxes | Every 1 minute (session-gated) |
| Polymarket BTC 5-min | 6-factor score (CVD, VWAP, OI, structure, clean air, session) | Every 5 minutes |

Zero AI in the automated pipeline except one purpose-built use: Claude Haiku 4.5 classifies news context strings for BZ! trade quality scoring. All signal rules are deterministic JavaScript.

---

## Architecture — How the Pieces Fit

```
TradingView Desktop (port 9222)
        │
        │  Chrome DevTools Protocol (CDP)
        ▼
┌─────────────────────────────────────────────────┐
│              lib/cdp.js (shared)                │
│  cdpConnect → getStudyValues → getPineBoxes     │
│  setTimeframe → waitForPrice → getOHLCV         │
└─────────────────────────────────────────────────┘
        │
   ┌────┴────────────────────┐
   │                         │
trigger-check.js (BTC)   bz/trigger-check.js   poly/btc-5/trigger-check.js
   │                         │                         │
mtf-analyze.js (BTC)    bz/analyze.js           poly/btc-5/analyze.js
   │                         │                         │
   └────┬────────────────────┘─────────────────────────┘
        │
   Discord webhooks / bot API
        │
discord-bot/index.js (every 1 min)
   - polls for !analyze / !status commands
   - polls for 📊 reactions → re-triggers analysis
        │
weekly-report.js / weekly-war-report.js (Monday / Sunday)
```

The mutex (`lib/lock.js`) uses atomic file creation (`O_EXCL`) to serialize CDP access — BZ, Poly, and EW scripts all hold this lock while reading TradingView. The BTC script is legacy and does not use the lock (documented as known).

---

## Pipeline 1: BTC — VRVP Zone Proximity Signal

### How it works

Every 10 minutes the BTC poller:

1. Connects to the `BINANCE:BTCUSDT.P` tab via CDP  
2. Reads the Visible Range Volume Profile histogram directly from TradingView's internal data store (not from Pine indicators — this is a native study)  
3. Extracts POC, VAH, VAL, and up to 6 HVN clusters from the histogram  
4. Checks whether the current price is within a proximity buffer of any level  
   - Buffer = `max(price × 0.005, zone_width × 1.5)` — adapts to zone width, so tight zones have tighter triggers  
5. If triggered: evaluates 8 confirming criteria, formats a full trade plan, posts to Discord  
6. Unconditionally runs outcome tracking and pending confirmation checks every cycle

### VRVP Level Priority

```
VAL / VAH  →  Priority 10  (value area boundaries — strongest institutional zones)
HVN        →  Priority 7   (high-volume nodes — proven S/R clusters)
POC        →  Priority 5   (only triggered within 0.7× buffer — very tight proximity)
```

Direction logic:
- VAL: long only (institutional demand floor)
- VAH: long if price is above by > buffer (breakout), short if at or below
- HVN: price above mid → long (support); price below mid → short (resistance)

### Signal Criteria (8 factors)

| Factor | Signal |
|---|---|
| VRVP level type + context | Auto-pass (always fires, provides framing) |
| HVN delta (bull/bear vol ratio at the node) | ✅/❌ based on which side dominated |
| CVD | Positive → long, Negative → short |
| Session VP | Up ratio > 50% → bullish, Down > 50% → bearish |
| VWAP | Price above → long, below → short |
| OI trend (vs prior poll) | Rising → conviction; flat/falling → caution |
| 4H MACD | Computed from live TradingView bars |
| 12H RSI | Computed from live TradingView bars |
| Weekly trend | 5-close consecutive direction filter |

Setup grades: A (all criteria pass), B (≥60% pass), C (<60% pass). Setup A triggers "TAKE THIS TRADE" verdict. Setup C shorts above VWAP with near-zero CVD are suppressed entirely.

### Confirmation and Outcome Tracking

After a signal fires:
- Every subsequent poll checks for a **30M bar close beyond the entry price** → marks the trade `confirmed`
- Every poll checks whether price has crossed TP1/TP2/TP3/stop on any 30M bar since the signal
- **Invalidation detection**: if price moves 0.8% beyond a level's midpoint, classifies as real break (CVD + OI confirm) or stop hunt (~63% reversal) — posts accordingly and manages cooldown
- **Pending confirmation**: if OI was flat at signal time, watches for a 0.5% OI rise AND CVD growing ≥1.5× from baseline — fires a "TRIGGER CONFIRMED" alert when both hit

CVD and OI are sourced from Binance fapi as the primary feed (TradingView doesn't carry them on the BTC Ace layout). The formula for CVD is `sum of (2 × takerBuyBaseAssetVolume − totalVolume)` per 5-min kline over the last hour — correct taker delta math.

### Cooldown Architecture

Each zone gets a state key of `{levelType.toLowerCase()}-{Math.round(mid)}`. This is where the previous flooding bug originated: VRVP recalculates its histogram as the visible chart range shifts, so a HVN at $95,000 becomes $95,050 on the next poll, creating a new key. The deduplication fix in `markAlerted()` now removes same-type entries within 0.5% before writing the new key.

---

## Pipeline 2: BZ! — LuxAlgo SMC Zone Proximity Signal

### How it works

Every minute (`TZ=America/New_York`), the BZ poller:

1. Checks session gate — exits silently during NYMEX close (5–6pm ET), throttles to 15-min intervals during post-settle (2:30–5pm ET)  
2. Connects to the `NYMEX:BZ1!` tab  
3. Reads LuxAlgo supply/demand box coordinates via CDP (Pine `box.new()` primitives from the graphics layer)  
4. Calculates ATR(14) from the last 20 bars → sets proximity buffer = `max(atr14 × 0.35, 1.50)`  
5. Classifies each zone as supply/demand/inside based on position relative to price  
6. If a zone is within the buffer AND hasn't fired this session → posts approaching alert + spawns `analyze.js`  

Session cooldown uses a session-string key (`YYYY-MM-DD-{asia|london|ny|post}`) in `.bz-trigger-state.json`. One alert per zone per session.

### BZ! Analysis Engine

When a zone triggers (or `!analyze` is called), `analyze.js` runs a full 4H → 1H → 30M sweep:

- **Bias determination**: price above 4H VWAP → long bias, below → short bias
- **Quality score** (0–6 points):
  1. VWAP position vs bias (+1)
  2. CVD direction vs bias (+1)
  3. OI level > 45,000 contracts (+1) — static threshold, not trending
  4. Session VP ratio (+1 if >60% in bias direction)
  5. 4H demand/supply zone proximity (+1 if within $5)
  6. Geopolitical flag (`BZ_GEOPOLITICAL_FLAG=active`) (+1 bonus)
- **Sentiment modifier**: Claude Haiku 4.5 classifies any trigger context → `+1` if confirmed bullish, `-1` if confirmed bearish, `0` otherwise
- **Final score** = min(technical + modifier, 6)

The "Catalyst card" includes a zone map, entry/SL/TP1/TP2/TP3, pro/con reasoning, and a plain-English WHY section.

### BZ! News Layer (pm2 process: `bz-news-watch.js`)

Two parallel intelligence feeds:
- **AIS layer**: WebSocket to aisstream.io watching Fujairah + Jebel Ali anchorages. Tracks tankers anchored (speed < 0.5 kts, type 80–89). Surge alert if count rises >20% vs prior hour AND >15% above baseline.
- **RSS layer**: 7 feeds polled every 60 seconds for keywords: Hormuz blockade, IRGC, tanker attack, OPEC emergency, etc.

Both layers respect a 10-minute analysis cooldown and then spawn `analyze.js` with the news context string, which then runs sentiment classification.

---

## Pipeline 3: Polymarket BTC 5-min Bar Scorer

### How it works

Fires 1 minute after each 5-min bar open (`1,6,11,16,21,26,31,36,41,46,51,56 * * * *`), deduplicated by bar boundary.

The sweep is intentionally fast:
1. **5M**: price, VWAP, OI, CVD, VRVP (POC/VAH/VAL) — from TradingView study values
2. **1M**: last 4 OHLCV bars — micro-momentum (consecutive closes direction)
3. **1H**: last 4 OHLCV bars — macro structure (HH/HL or LL/LH pattern)

### 6-Factor Scoring

| Factor | Points | Logic |
|---|---|---|
| CVD momentum | 0–2 | 1M consecutive closes + CVD delta vs prior bar — both agree = 2pts, momentum only = 1pt |
| VWAP position | 0–1 | Price >0.15% above/below VWAP |
| 1H structure | 0–1 | HH+HL = UP, LL+LH = DOWN — clear structure required |
| OI rising | 0–1 | Current OI > prior OI × 1.001 (new positioning filter) |
| Clean air | 0–1 | Price not within 0.3% of VRVP POC/VAH/VAL |
| Active session | 0–1 | 08–21 UTC window |

Signal fires if score ≥ 5. Direction = whichever of `scoreFor('UP')` vs `scoreFor('DOWN')` wins. Probability displayed as `min(88, 50 + |upScore − downScore| × 9)`.

Outcome tracking: on the NEXT bar's run, the prior bar's close vs open determines UP/DOWN outcome → `correct: true/false` → ✅/❌ Discord reaction.

Market URL is auto-discovered hourly via Polymarket Gamma API. Falls back to seed URL from `.env` with alert if discovery fails.

---

## Discord Bot Architecture

`discord-bot/index.js` runs every minute via crontab. It:
- Polls all registered channels for new messages since last `lastMessageId`
- Routes by channel prefix to the correct handler (`btc-*` → btc handler, `bz-*` → bz handler, etc.)
- Separately polls for 📊 emoji reactions on tracked signal messages → synthesizes an `!analyze` command through the handler
- Rate-limits reaction checks: 1.1s between API calls, max 6 per cycle, message expiry after 24h

The router (`discord-bot/router.js`) is the only file to touch when adding a new instrument — handler wiring is intentionally isolated.

---

## Signal Quality Framework

### BTC Three-Track Report

The weekly report computes three independent statistical tracks:

1. **All signals** — everything that fired, regardless of confirmation
2. **Confirmed only** — 30M bar closed beyond entry price after signal
3. **Unconfirmed** — signal fired but entry never triggered

This three-track approach is the core evaluation engine. If the confirmed track has a substantially higher win rate than the all-signals track, the confirmation bar is doing real statistical work. If not, the confirmation requirement may be unnecessary friction.

Per-level-type breakdown (VAH/VAL/HVN/POC) and per-direction breakdown (long/short) let you identify which specific setups are performing and which are noise.

### BZ! Quality Score

The 0–6 scoring system is deliberately static at the time of trigger analysis — it does not update as price moves. This is correct for a "should I enter?" decision but means the quality score doesn't reflect what happened. The backtest channel (`#bz!-backtest`) logs signals with their score, but outcome tracking for BZ requires manual `!exit` commands (unlike BTC which is automatic bar-by-bar).

---

## Bugs Identified

### 1. BTC trigger-check.js — OI Unit Label in Pending Confirmation Message ✅ Fixed

**File:** `scripts/trigger-check.js:1514`  
**Severity:** Cosmetic / Misleading  
The pending confirmation Discord message showed OI as `28.50K` when the Binance OI values are in billions (e.g., 28.50 = $28.5B). The log at line 1940 correctly says "B". This was fixed in the audit session.

### 2. BTC trigger-check.js — checkConfirmation() No Timeframe Switch ✅ Fixed

**File:** `scripts/trigger-check.js:1555`  
**Severity:** Low / Pre-existing  
`checkConfirmation()` read OHLCV bars without switching the chart to 30M first. A stale comment said "already on 30M from outcome check above" but `checkConfirmation` runs **before** `updateOutcomes`. On a chart set to a short timeframe (e.g. 5M), 96 bars covers only 8 hours — signals older than 8 hours would silently never confirm. Fixed by adding explicit save/switch-to-30M/restore inside `checkConfirmation`.

### 3. Makefile — make cron Installs Deprecated Bot ✅ Fixed

**File:** `Makefile:68-74`  
**Severity:** Moderate / Silent Regression Risk  
`make cron` used `grep -q "discord-bot.js"` to check if the bot cron was installed. The live crontab had `discord-bot/index.js` (the current multi-instrument bot), which does not match `discord-bot.js`. Running `make cron` on a fresh machine, or if the cron was ever reset, would have installed the **deprecated `discord-bot.js`** alongside the live bot — two bots running concurrently, producing duplicate reactions, duplicate analyze calls, and potential message spam. Fixed by updating all references to `discord-bot/index.js`.

### 4. BZ! trigger-check.js — Hardcoded EDT Offset

**File:** `scripts/bz/trigger-check.js:63-64`  
**Severity:** Low / Seasonal  
```js
// UTC-4 (EDT, summer 2026)
return (new Date().getUTCHours() - 4 + 24) % 24;
```
The session gate in `getETHour()` hardcodes UTC-4 (EDT) and will be wrong in winter when the offset is UTC-5 (EST). The `lib/zones.js` helper (`currentSession()`) already has correct DST logic using the 2nd Sunday in March / 1st Sunday in November. This function in `bz/trigger-check.js` is a parallel (and inferior) implementation that was not updated when the timezone fix was applied to `zones.js`. The NYMEX close window will fire at the wrong hour from November through March.

### 5. BZ! analyze.js — OI Quality Score is a Static Threshold

**File:** `scripts/bz/analyze.js:152`  
**Severity:** Conceptual / Strategic  
```js
if (oi != null && oi > 45000) { score++; ... }
```
OI is scored based on whether it exceeds a fixed 45,000-contract threshold, not whether it is **rising** (as BTC does). This means the OI factor gives a permanent point during any high-OI environment and gives no point during normal-OI environments, regardless of whether new money is actually entering. The BTC pipeline correctly compares current OI to the prior reading to detect trend. BZ! does not.

### 6. BTC trigger-check.js — BOS/CHoCH Labels Not Wired Into Signal Evaluation

**File:** `scripts/trigger-check.js:633-649`  
**Severity:** Low / Unused Feature  
`parseBosChoch()` and `buildLabelsExpr()` are fully implemented functions that read LuxAlgo BOS/CHoCH labels from CDP. However, they are **never called** in `main()`. The intent appears to have been to use BOS/CHoCH as a structure confirmation criterion, but the wiring was never completed. The functions exist but produce no output. This is dead code that adds complexity without contributing to signals.

### 7. BZ! trigger-check.js — Only One Zone Processed Per Cycle

**File:** `scripts/bz/trigger-check.js:257-259`  
**Severity:** Low / By Design?  
```js
// Only trigger once per cycle even if multiple zones in range
break;
```
If BZ price is simultaneously near two zones (e.g., between a 4H supply and a 30M supply), only the first zone in `classified.filter(z => z.inBuffer)` fires. The sort order from `getPineBoxes` is descending by `high`, so the uppermost zone is always checked first. This could cause a demand zone below price to be silently skipped if a supply zone above price also triggers first. Whether this is intentional is not documented.

### 8. poly/btc-5/trigger-check.js — Outcome Detection Uses Bar Direction, Not Polymarket Close Price

**File:** `scripts/poly/btc-5/trigger-check.js:360-362`  
**Severity:** Conceptual  
```js
prevEval.outcome = prevCompletedBar.close > prevCompletedBar.open ? 'UP' : 'DOWN';
```
The outcome is determined by whether the 5M bar **closed higher or lower than it opened** (bullish/bearish candle), not by whether the price was higher at bar close than at bar open of the **signal bar**. A flat or mixed candle (opens $95,000, oscillates, closes $95,001) would be scored UP. This is a coarse approximation — accurate directionally most of the time but not equivalent to measuring from the signal bar's open. The signal asks "will BTC go UP or DOWN in the next 5 minutes?" — the correct measurement is `barClose > signalBarOpen`, not `barClose > barOpen of the outcome bar` (which is the same bar).

---

## Areas for Improvement

### I. BZ! OI Factor — Replace Threshold With Trend

**Priority: High**  
Replace the static 45K threshold with the same trend comparison used in BTC:
- Store `_previousOI` in `.bz-trigger-state.json` on each poll
- Score +1 if current OI > prior OI (new positioning) — same logic as BTC's `getOITrend()`
- This makes the BZ! OI factor meaningful in all market conditions

### II. BZ! Session Gate — DST-Aware Offset

**Priority: Medium**  
`bz/trigger-check.js:getETHour()` and `getETMinute()` need to use the same DST-correct logic already in `lib/zones.js:currentSession()`. This is a one-function swap — copy the DST offset calculation from `zones.js` into both helper functions in `bz/trigger-check.js`.

### III. Poly BTC-5 Outcome — Measure From Signal Bar Open

**Priority: Medium**  
The correct outcome for "will BTC go UP in the next 5 minutes?" is whether price 5 minutes later (`nextBarOpen` or `currentBarClose`) is higher than price at the signal's bar open. Currently the code compares `prevCompletedBar.close > prevCompletedBar.open` — the signal bar's own direction — which has a subtle bias: it conflates "the 5 minutes moved up" with "the candle was bullish." If price opened at $95,000, fell to $94,950 then recovered to $95,001, the outcome is scored UP, but a Polymarket "up" position starting at bar open would have barely profited. The measurement should be: `closeOfPrevBar > openOfPrevBar` (already is this) but tracked against what the Polymarket contract actually resolves against (usually the final price vs opening price of the 5-minute window). This needs validation against Polymarket's resolution rules.

### IV. BTC Lock Acquisition — BTC Should Join the Mutex

**Priority: Low / Architectural**  
`scripts/trigger-check.js` is the only cron script that does NOT acquire the `lib/lock.js` mutex before touching CDP. This means a BTC poll can collide with a BZ analysis (which does hold the lock), causing the BZ analysis to fail to find its tab or read stale data mid-timeframe-switch. The BTC script is labeled "legacy, untouched" — but the collision window is real: BTC polls every 10 minutes, BZ polls every minute. At 10 minutes × 6 per hour = 1 collision per hour on average.

### V. Dead Code — Remove Unused BOS/CHoCH Label Functions

**Priority: Low / Housekeeping**  
`parseBosChoch()` (line 633) and `buildLabelsExpr()` (line 370) in `scripts/trigger-check.js` are fully implemented but never called. Either wire them into `evaluateSetup()` as a structure confirmation criterion (adds genuine signal value) or remove them. Leaving them uncalled creates reader confusion about intent.

### VI. BTC CVD History — Bar-Accurate CVD Confirmation

**Priority: Low / Known Limitation**  
The `checkPendingConfirmation()` function attempts to use CVD at the 30M bar close rather than poll time, by looking up the nearest stored reading in `_cvdHistory`. However, CVD is sampled at 10-minute poll intervals, which doesn't align with 30M bar boundaries. A reading 15 minutes after a bar close is used as a proxy for bar-close CVD. This is called out in `TODO.md` and is inherent to the polling-based architecture — a legitimate constraint, not a fixable bug without moving to a push-based event system.

### VII. BZ! Outcome Tracking — Manual vs Automatic

**Priority: Medium / Feature Gap**  
BTC closes trades automatically via bar-by-bar OHLCV scanning every 10 minutes. BZ! requires manual `!exit` commands from Discord to close trades. This means BZ! weekly reports have no automated win/loss data unless the operator manually records every exit. The `bz-trades.json` file has the schema for automated tracking (it stores entry, SL, TP1–3) but no automated checker ever reads it. A BZ! outcome-checker similar to BTC's `updateOutcomes()` would close this gap.

### VIII. Weekly War Report — Architectural Separation

**Priority: Low / Observation**  
`scripts/weekly-war-report.js` is 1,142 lines — nearly as large as the full BZ analyze engine. It has its own inline `fetchCVD()`, `fetchOI()`, `httpGet()`, and a full BTC analysis pipeline (Deribit options, Fear & Greed, weekly closes, funding rate). This is entirely separate from the `weekly-report.js` (which reads `trades.json` statistics). The war report is more of a market intelligence digest than a performance report. Its size and inline API fetching suggest it has grown organically and could benefit from extracting the data-fetching layer into shared utilities when the MongoDB migration reaches Phase 2.

---

## Performance Monitoring Health

The three-track weekly report (`weekly-report.js`) is the best-designed component in the system. Separating confirmed from unconfirmed trades is the right call — it gives a clear view of whether the entry confirmation requirement (30M bar close beyond entry) is adding value. The additional breakdowns by level type (VAH/VAL/HVN/POC) and direction (long/short) provide actionable signal quality data.

The criteria accuracy section (which criteria were green when trades won vs lost) is particularly valuable. If "CVD positive" has 70% win rate but "4H MACD bullish" has 48%, you can start deprioritizing MACD as a gate. This is the foundation of a proper signal quality calibration loop.

The Poly BTC-5 weekly report similarly tracks `correct` rate per factor breakdown. This is a proper frequentist calibration loop — the only concern is sample size. 5-minute signals fire 12 per hour × 13 active hours = 156 bars per day, but at a score≥5 threshold, signals fire rarely. The actual weekly sample may be too small to draw statistical conclusions.

---

## Summary: System Strengths

1. **No hallucinated signals** — all logic is deterministic. No LLM decides when to fire.
2. **CDP architecture** is clever — reading TradingView's internal JS state avoids scraping and gets real-time institutional indicator values that no public API provides.
3. **Multi-layer confirmation** (approach → confirmation → outcome → reclaim watch) is well-thought-out. Most alert systems fire once and forget; this one tracks the full trade lifecycle.
4. **Session-aware design** for BZ! correctly gates around NYMEX settlement, avoiding the worst low-liquidity windows.
5. **The three-track weekly report** is exactly the right framework to measure if the system is generating alpha or noise.

## Summary: Top 5 Action Items

| Priority | Item                                                                                 | Effort    |
| -------- | ------------------------------------------------------------------------------------ | --------- |
| 1        | Fix BZ! ETH offset — replace hardcoded UTC-4 with DST-aware calculation              | 15 min    |
| 2        | Fix BZ! OI factor — replace static 45K threshold with trend comparison               | 30 min    |
| 3        | Validate Poly BTC-5 outcome measurement against Polymarket's actual resolution rules | 1 hour    |
| 4        | Wire or remove BOS/CHoCH label functions in BTC trigger-check.js                     | 30 min    |
| 5        | Add automated outcome tracking for BZ! trades (port `updateOutcomes` logic)          | 2–3 hours |
