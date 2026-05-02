# Tangiers — Backtesting & Performance Tracking

---

## Ace (BTC / BZ!)

### Purpose

This section explains:
1. How Ace measures strategy performance
2. The three-phase build plan and what is complete
3. Exactly how a trade gets logged, confirmed, and closed
4. What you (or a future session) need to do to finish the build

---

### The Strategy in One Paragraph

Ace watches BINANCE:BTCUSDT.P perpetual futures every 10 minutes via TradingView's CDP (Chrome DevTools Protocol) connection. He reads Visible Range Volume Profile (VRVP) levels — specifically POC (Point of Control), VAH/VAL (Value Area High/Low), and HVNs (High Volume Nodes). When price approaches one of these levels with confirming order flow (rising OI, aligned CVD, correct VWAP position), he fires a signal to Discord. The signal is **not** an immediate trade — it is a setup alert. The actual trade trigger is waiting for a 30M candle to close beyond the entry price, which confirms the level is holding rather than breaking.

---

### How a Trade Moves Through the System

```
SIGNAL FIRED → UNCONFIRMED → CONFIRMED → CLOSED → REPORTED
```

#### 1. Signal Fired

`trigger-check.js` detects price within 0.35% of a VRVP level with order flow criteria met. He:
- Posts a Discord alert (🟢 LONG or 🔴 SHORT)
- Writes an entry to `trades.json` with:
  - Entry price, stop, TP1/TP2/TP3 levels
  - All setup criteria at signal time (snapshot)
  - `confirmed: false`, `outcome: null`

#### 2. Unconfirmed → Confirmed

Every 10-minute poll, `checkConfirmation()` in `trigger-check.js` fetches the last 48h of 30M bars and checks:

```
Long signal:  Has any 30M bar CLOSED above entry price, AND is CVD currently positive?
Short signal: Has any 30M bar CLOSED below entry price, AND is CVD currently negative?
```

If yes, the trade is stamped:
```json
"confirmed": true,
"confirmedAt": "2026-04-15T14:30:00.000Z",
"confirmedPrice": 75650
```

**This is the "entry trigger."** An unconfirmed trade means the level was approached but price never convincingly broke through with order flow — the trade setup was seen but the entry condition was never met. These trades are tracked separately in the report because their win rate is expected to be lower.

**Why CVD is checked at poll time, not per-bar:** CVD is a cumulative measure that's directionally persistent over 30-minute windows. Checking it per-bar would require storing historical CVD values which the system doesn't do. This is a known simplification — see Phase 3 for the improvement.

#### 3. Confirmed → Closed (Bar-Accurate Outcome Detection)

Every 10-minute poll, `updateOutcomes()` fetches the last 336 30M bars (7 days) and walks bar-by-bar from the signal's `firedAt` timestamp:

```
For each 30M bar after the signal:

  LONG trade:
    if bar.low  <= stop  AND bar.high < tp1  → LOSS  (stop hit, no TP reached)
    if bar.high >= tp3                        → WIN at TP3
    if bar.high >= tp2                        → WIN at TP2
    if bar.high >= tp1                        → WIN at TP1
    if bar.low  <= stop  AND bar.high >= tp1  → LOSS  (same bar — stop wins, conservative)

  SHORT trade: mirror logic (bar.high for stop, bar.low for TPs)
```

When an outcome is found, the trade is stamped:
```json
"outcome": "tp2",
"pnlR": 3.6,
"closedAt": "2026-04-15T16:00:00.000Z"
```

**Why bar-accurate matters:** The old system checked the current spot price every 10 minutes. This missed wicks, got the intrabar order wrong (stop hit before TP on the same candle), and could miss fast moves that happened between polls. Bar-accurate detection uses actual OHLCV data so a wick that touched TP1 at 14:32 and returned by the next poll will be correctly detected.

**Expiry:** Trades open for 30+ days with no outcome are marked `expired` and excluded from all stats.

#### 4. Closed → Reported

Every Monday at 09:00 UTC, `weekly-report.js` reads `trades.json` and computes stats. The report is posted to `#btc-backtest` via a separate webhook (`DISCORD_BTC_BACKTEST_WEBHOOK_URL` in `.env`).

---

### What the Weekly Report Shows

The report separates trades into three tracks:

| Track | What it means |
|---|---|
| **All signals** | Every trade that fired and closed, regardless of confirmation |
| **Confirmed only** ← *the real number* | Only trades where the 30M entry trigger actually happened |
| **Unconfirmed** | Signal fired but entry was never triggered — price backed away |

**The confirmed win rate is the strategy's true win rate.** If it's materially higher than the all-signals rate, the confirmation bar is doing meaningful filtering work. If they're the same, the filter isn't adding value and the entry criteria need review.

The report also shows:
- Signal funnel (fired → confirmed rate → closed)
- Win rate by level type (HVN vs VAL vs VAH vs POC)
- Win rate by direction (longs vs shorts)
- Most predictive criteria (which of the 8 setup criteria correlate most strongly with wins)
- Time-to-outcome (avg hours for wins vs losses — fast wins = momentum; slow losses = stop placement issue)
- Current win/loss streak

---

### Three-Phase Build Plan

#### Phase 1 — System Track (Bar-Accurate) ✅ COMPLETE

**What it does:** Accurately tracks what the strategy would produce if you took every confirmed signal.

**Status:** Fully built and live.

**Files:**
- `scripts/trigger-check.js` — `logTrade()`, `updateOutcomes()`, `checkConfirmation()`
- `trades.json` — written by trigger-check, read by weekly-report
- `scripts/weekly-report.js` — all three tracks + confirmation filter analysis

**When to validate:** After 2-3 weeks of live signals, check `trades.json` directly to confirm:
- `confirmed` is being stamped correctly (should be ~60-70% of signals)
- `outcome` values match what you see on the chart
- `closedAt` timestamps look realistic (hours to days after signal, not minutes)

Use `!trades` in Discord to see open trades and recent closures without opening the file.

---

#### Phase 2 — Your Execution Track 🔲 BUILT, NOT YET ACTIVE

**What it does:** Lets you log which signals you actually traded and how you actually exited. Compares your win rate and R against the system baseline.

**Status:** Code is written and wired. Behind early-return guards in `discord-bot.js`. Activate once Phase 1 has 10+ confirmed closed trades.

**Files:**
- `scripts/discord-bot.js` — `handleTook()`, `handleExit()` (guarded with early-return)
- `my-trades.json` — will be created on first `!took` command
- `scripts/weekly-report.js` — execution section stub at bottom of report

**Commands (inactive):**
```
!took <trade-id>                 → log that you entered on a system signal
!exit tp1|tp2|tp3|stop           → log your actual exit
!exit manual <price>             → log a manual exit at a specific price
```

**How to activate:**

1. Open `scripts/discord-bot.js`
2. Find `handleTook()` — remove the two lines starting with `// Phase 2 — not yet active` and the `return;` line beneath it
3. Do the same in `handleExit()`
4. In `scripts/weekly-report.js`, find the `// ── Phase 2 stub: your execution track ──` comment block in `analyse()` — uncomment those lines
5. Update `formatReport()` to replace the `executionLines` stub with real `myTrack` data

**When to activate:** When `!trades` consistently shows 10+ entries with `outcome` populated and `confirmed: true` on most of them.

---

#### Phase 3 — Report Depth ✅ MOSTLY COMPLETE

| Feature | Status | Notes |
|---|---|---|
| Confirmation rate by level type | ✅ done | `BY LEVEL TYPE` in report |
| Criteria correlation (confirmed only) | ✅ done | `MOST PREDICTIVE CRITERIA` |
| Streak tracking | ✅ done | Shows current win/loss streak |
| Time-to-outcome | ✅ done | Avg hours wins vs losses |
| Execution section | ✅ stubbed | Shows Phase 2 pending message |
| Per-bar CVD confirmation | ❌ not built | See below |

**Remaining Phase 3 item — per-bar CVD confirmation:**

Currently `checkConfirmation()` checks CVD from the current poll's indicators, not from the specific bar when the 30M close happened. This is a quality-of-signal improvement, not a correctness fix — the current approach is directionally right ~85% of the time.

**How to implement when ready:**
1. In `trigger-check.js` `main()`, append `{ ts: Date.now(), cvd: indicators.cvd }` to `state._cvdHistory` (cap at last 200 entries)
2. In `checkConfirmation()`, for each confirmation bar, find the closest `_cvdHistory` entry by timestamp and use that CVD reading instead of `indicators.cvd`

---

### File Reference

| File | Purpose |
|---|---|
| `scripts/trigger-check.js` | Cron script — fires signals, logs trades, updates outcomes, checks confirmation |
| `scripts/discord-bot.js` | Discord command listener — `!trades`, `!stop`, `!start`, `!analyze`, `!took`/`!exit` (Phase 2) |
| `scripts/weekly-report.js` | Monday report — reads trades.json, computes all stats, posts to Discord |
| `trades.json` | System trade log — every signal, confirmed or not, with bar-accurate outcome |
| `my-trades.json` | Your execution log — created by `!took`, written by `!exit` (Phase 2) |
| `.env` | `DISCORD_BTC_BACKTEST_WEBHOOK_URL` required for weekly report |

---

### Data Validation Checklist (run after first 2 weeks)

Before activating Phase 2, manually verify these in `trades.json`:

- [ ] At least 10 entries exist
- [ ] `confirmed: true` on 50-75% of entries (lower = entry criteria too strict; higher = filter not filtering)
- [ ] `confirmedAt` is hours after `firedAt`, not seconds (seconds = confirmation logic too loose)
- [ ] `outcome` is populated on closed trades (null on open is correct)
- [ ] `pnlR` values match actual RR ratios in the signal (e.g. TP2 = rr2 value)
- [ ] `closedAt` times are realistic (not all within 30 minutes, not all 29 days)
- [ ] Check one trade manually: find the `firedAt` date on TradingView 30M chart, verify the outcome matches what price actually did

---

## Billy Sherbert (Polymarket Weather)

### Trade Lifecycle

```
SIGNAL FIRED → OPEN → RESOLVED → REPORTED
```

**Signal fired:** `market-scan.js` finds edge ≥ 8% on a Polymarket temperature bucket. Writes entry to `weather-trades.json` with `outcome: null`.

**Open:** Signal sits open until the market's resolution date. Use `!took <id>` to log a paper entry, which stamps `tookBy`, `tookAt`.

**Resolved:** Market settles via official NOAA/WMO observations (same source Polymarket uses). Use `!exit <id> win|loss|manual` to close. Stamps `signalResult`, `pnlDollars`, `closedAt`.

**Reported:** Every Sunday 18:00 → `weekly-report.js` reads `weather-trades.json` and posts P&L summary to `#weather-backtest`.

---

### Key Files

| File | Purpose |
|---|---|
| `weather-trades.json` | All signals + outcomes (gitignored, auto-created) |
| `scripts/weather/market-scan.js` | Fires signals, writes to weather-trades.json |
| `scripts/weather/weekly-report.js` | Sunday report → #weather-backtest |
| `scripts/discord-bot/handlers/weather.js` | !trades !took !exit !report |

---

### Paper Trading Commands

```
!trades                    → top 8 open signals (soonest resolving, highest edge)
!took <id>                 → log paper entry on a signal
!exit <id> win|loss|manual → close a paper trade
!report                    → generate weekly report now → #weather-backtest
```

---

### Signal Fields (weather-trades.json)

| Field | Meaning |
|---|---|
| `id` | e.g. `wx-mob6ouqjcd56` |
| `side` | `yes` or `no` |
| `edge` | Model P vs market price gap (%) |
| `modelProb` | Weighted consensus across 5 models + ensemble |
| `yesPrice` / `noPrice` | Polymarket prices at signal time |
| `betDollars` | Kelly-suggested stake |
| `parsed.date` | Resolution date |
| `tookBy` / `tookAt` | Paper entry (null if not taken) |
| `signalResult` | `win` / `loss` / `manual` / null |
| `pnlDollars` | Paper P&L on close |

---

### Edge Tiers

| Tier | Edge | Meaning |
|---|---|---|
| High | ≥ 25% | Models strongly disagree with market |
| Medium | 15–25% | Meaningful mispricing |
| Minimum | 8–15% | Marginal — monitor before raising threshold |

**Current threshold:** 8% (conservative — review after first resolved batch)

---

### Weekly Report Sections

1. **Resolved this week** — win/loss per signal with P&L
2. **Edge-tier breakdown** — win rate by High / Medium / Min tier
3. **City breakdown** — P&L sorted by city
4. **Open positions** — up to 8, sorted by resolution date

---

### Phase Status

| Phase | Description | Status |
|---|---|---|
| A | Signal validation — paper trading, bias correction, AI filter calibration | **Active** |
| B | Live execution — activate after ≥20 confirmed resolved trades with 55%+ WR | Pending |

Advance to Phase B when: `allResolved ≥ 20` AND `lifetimeWinRate ≥ 55%` AND bias corrections have converged (≥5 trades per city).

---

### Validation Checklist (after first resolved markets)

- [ ] `signalResult` matches actual Polymarket settlement
- [ ] `pnlDollars` = `betDollars × (1 - price) / price` for wins, `-betDollars` for losses
- [ ] Win rate by edge tier — High tier should outperform Min tier
- [ ] Compare `modelProb` vs settlement — are we systematically high/low on any city?
- [ ] Review any edge ≥ 40% misses — indicates a model calibration issue
