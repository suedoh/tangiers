# Elliott Wave (EW) Protocol — Operator Guide

This is the institutional-grade Elliott Wave analysis layer for
`BINANCE:BTCUSDT.P`. Six scheduled runs per day plus on-demand `!ew`,
deterministic Pine indicator + Node orchestrator, three Discord channels.

---

## Channels

| Channel | Purpose | Cadence |
|---|---|---|
| `#btc-ew-signals` | Live wave-count posts (1D + 4H + 1H, with screenshots) | 6×/day at 00:05, 04:05, 08:05, 12:05, 16:05, 20:05 UTC + on-demand `!ew` |
| `#btc-ew-backtest` | Cron-driven invalidation/target hit events + daily statistics | After each run (+5 min) and 23:55 UTC daily |
| `#btc-ew-report` | Template-rendered narrative writeups | Daily 12:15 UTC, Sunday 22:00 UTC, 1st-of-month 14:00 UTC |

The existing `#btc-signals`, `#btc-backtest`, and `#btc-weekly-war-report`
channels and the trigger-check pipeline are **not** touched by EW code.

---

## One-time TradingView setup

1. **Create a new layout from a blank chart.** In TradingView Desktop:
   File → New Layout. Do NOT clone or copy `🕵Ace`. Start blank.
2. **Save the layout under the exact name `EW`.** No emoji, no decoration.
   The orchestrator finds the tab by title match (`cdpConnect('EW')`), so
   the literal name matters.
3. **Open `BINANCE:BTCUSDT.P`** on the chart.
4. **Add the Pine indicator.** In the Pine Editor (bottom panel):
   File → Open → New Pine Script → paste the contents of
   `scripts/pine/elliott-wave.pine` → Save → Add to Chart.
5. **Add three more indicators** from the Indicators dialog (📈 button):
   - VWAP
   - Cumulative Volume Delta
   - Volume (panel below price — most TV setups have this by default)
6. **Chart settings (per pane):**
   - Auto-scale on
   - Show ~250 bars (use the Bar Replay timestamps if needed)
   - Faint horizontal grid only; vertical grid off
   - Clean theme (dark or light — be consistent across runs)
   - Pin Fib retracement and Fib extension drawing tools to the toolbar
7. **Open the EW layout in a separate Desktop tab from `🕵Ace`.** Both
   tabs stay open. The cron scripts target only the EW tab.
8. **Verify Ace is byte-identical** to before phase 2 — switch to it
   manually and confirm symbol, timeframe, and indicator stack are
   unchanged.

The Pine indicator has three inputs: `pivotK` (ATR multiplier; default
2.0 for 1H/1D, 2.5 for 4H), `maxPivots` (15 default), and `showVisual`
(numbered pivot labels). Tune `pivotK` after a week of
`#btc-ew-backtest` calibration data accumulates if pivots are too noisy
or too sparse for your taste.

---

## What the system does

A custom Pine indicator (`elliott-wave.pine`) detects ATR-scaled
ZigZag pivots and emits them as a JSON-encoded hidden chart label. The
Node orchestrator (`scripts/ew/protocol.js`) cycles the EW chart
through 1D → 4H → 1H using `setTimeframe` (matching the
`mtf-analyze.js` pattern), reads the Pine pivot data and indicator
study values via raw CDP, captures one PNG screenshot per timeframe,
applies canonical EW rule validation in JS, computes confidence and
tiered invalidation, synthesizes cross-timeframe confluence, and posts
to `#btc-ew-signals` with all three screenshots inline.

Every forecast is persisted to `ew-forecasts.json` (gitignored
flat-file) with a schema identical to the future Mongo
`wave_forecasts` collection — when `feat/mongodb-docker` Phase 2 lands,
migration is mechanical.

---

## EW rules and guidelines

The validator (`protocol.js::validateImpulse`) enforces the canonical
five-wave impulse rules:

- Wave 2 retraces ∈ [0.382, 0.786] of wave 1 (≥1.0 = invalid)
- Wave 3 is never the shortest of waves 1, 3, 5
- Wave 4 doesn't overlap wave 1 territory (impulse, non-leading-diagonal)
- Alternation: waves 2 and 4 differ in retrace depth (sharp/flat pairing)
- Wave 4 retraces ∈ [0.236, 0.5] of wave 3
- Wave 3 ≥ 1.618×W1 in the canonical case (soft preference)

Targets are Fib-projected from the end of wave 2: 1.0×, 1.618×, 2.618×W1.

When the rules don't admit a clean impulse, the orchestrator builds a
**B-wave-of-expanded-flat** alternate — interpreting the move as
corrective rather than impulsive. Both primary and alternate counts
travel together with their own invalidation tiers.

---

## Tiered invalidation

Every count carries three invalidation prices:

- **Hard** — count is dead (e.g., wave 4 overlaps wave 1, or the
  start of wave 1 is breached). Status promotes to `invalidated`.
- **Soft** — primary count weakens; alternate is promoted to primary.
- **Truncation** — wave 5 fails to exceed wave 3. Count survives but a
  five-wave reversal becomes elevated.

The backtest script tracks each tier independently and posts a
distinct event to `#btc-ew-backtest` when any tier crosses.

---

## Confidence scoring

Bayesian-flavored: prior 0.5, +0.10 per rule passed, −0.05 per
borderline (within 5% of band edge), +0.05 for alternation,
+0.05 for 1.618×W1 W3 extension. Personality scoring (W3 volume peak,
W5 CVD divergence, etc.) is recorded but not yet weighted in v1 —
calibration data drives future tuning.

If neither primary nor alternate clears **0.50** confidence on any
timeframe, the orchestrator declares the structure **ambiguous** and
posts a "no actionable count this cycle" message with screenshots
only. This discipline is non-negotiable: silence is information.

---

## Reading a `#btc-ew-signals` post

```
🌊 ELLIOTT WAVE — BINANCE:BTCUSDT.P | $73,500 | 2026-05-03 12:05 UTC
Source: scheduled (NY-open) · Layout: EW · CDP read

Confluence: 1D (III) + 4H (3) + 1H iii — aligned BULLISH ✅

1D (Intermediate)             ⟶  [screenshot attached]
  Primary  : wave (III) up — confidence 0.74 · stable
    invalidation:  hard $63,900  ·  soft $66,200  ·  trunc $74,500
    targets:       1.0×W1 $71,200  ·  1.618×W1 $76,800
  Alternate: wave (B) up (corrective) — confidence 0.31

4H (Minor)                    ⟶  [screenshot attached]
  ...

1H (Minute)                   ⟶  [screenshot attached]
  ...
```

`Confluence` line shows whether the three timeframes agree. `aligned
BULLISH` or `aligned BEARISH` is the high-conviction case; `mixed`
warns of conflicting structure.

`stable` / `refined` / `flipped` / `new` is the stability tag —
how this run's primary count compares to the previous run's. Stable
counts that hold across runs are worth more than flipping ones.

---

## Reading a `#btc-ew-backtest` event

```
⚠️ INVALIDATED (hard) — 4H (3) primary count
Forecast generated: 2026-05-03 12:05 UTC at $67,432 (slot: NY-open)
Level: $65,120  ·  Hit at: 2026-05-03 18:32 UTC, $65,094
Time open: 6h 27m
Confidence at gen: 0.78 (4H primary)
[original 4H screenshot attached]
```

The original screenshot is re-attached for context — you can scroll
the channel and immediately see what the count looked like at the
moment it was generated.

The 23:55 UTC daily summary posts a calibration table per
TF + slot + bucket. Any bucket where realized hit rate diverges from
the bucket midpoint (50, 60, 70, 80, 90) by more than 15% is
flagged with ⚠️ — that's the indicator-tuning signal.

---

## When to use `!ew` manually

The schedule is the primary path. `!ew` is for ad-hoc re-counts
between scheduled runs:

- Surprise wick or news-driven move that may have invalidated the
  prior count
- Explicit confluence check before a discretionary trade
- Curiosity / education

Manual runs are tagged `Source: manual:!ew by @user` in the post and
participate in calibration the same way scheduled runs do.

---

## When to read each channel

- **Live trading decisions:** `#btc-ew-signals`. Look at the latest
  post and the confluence flag.
- **Pre-trade morning prep:** `#btc-ew-report` daily brief at 12:15 UTC.
  Reads as a one-page institutional brief.
- **Weekly review:** `#btc-ew-report` Sunday 22:00 UTC outlook + the
  `#btc-ew-backtest` Sunday rollup.
- **Indicator tuning:** `#btc-ew-backtest` daily calibration tables.
  After 30+ days of data, divergent buckets indicate Pine `pivotK`
  tuning is warranted.

---

## Architecture notes

- **All cron uses raw CDP** via `scripts/lib/cdp.js`. The TradingView
  MCP server is **not** invoked in cron. The existing `CLAUDE.md` rule
  (*"automated pipeline never calls the MCP server or Claude API"*)
  is preserved verbatim.
- **Mutex** via `.tradingview-lock` (file-based, 60s TTL). EW
  competes with `trigger-check.js` and `bz/trigger-check.js` for the
  TradingView Desktop CDP session. `+5min` stagger reduces collisions.
- **Storage** is flat-file (`ew-forecasts.json`, `.ew-state.json`)
  matching the `trades.json` / `bz-trades.json` pattern. Schema
  matches the future Mongo `wave_forecasts` collection.
- **Reports** are template-rendered (no LLM in cron). Templates live in
  `scripts/ew/template/` and can be tuned without code changes.
- **Partner machine** (`PRIMARY=false`, `TRADINGVIEW_ENABLED=false`):
  unaffected — every cron script exits early via the standard guard.

---

## Files

```
scripts/
├── pine/
│   └── elliott-wave.pine         # Pine v5 — pivot detector
├── ew/
│   ├── protocol.js               # CDP analysis pass (1D/4H/1H sweep)
│   ├── run.js                    # Cron entry — scheduled + manual !ew
│   ├── backtest.js               # Open-forecast lifecycle tracker
│   ├── daily-summary.js          # 23:55 UTC stats to #btc-ew-backtest
│   ├── daily-brief.js            # 12:15 UTC narrative brief
│   ├── weekly-outlook.js         # Sunday 22:00 UTC outlook
│   ├── monthly-review.js         # 1st of month 14:00 UTC review
│   ├── formatter.js              # Discord embed builders
│   ├── discord-upload.js         # Multipart webhook poster
│   ├── storage.js                # Flat-file persistence
│   ├── reports-shared.js         # Common report renderer helpers
│   └── template/
│       ├── daily-brief.tmpl
│       ├── weekly-outlook.tmpl
│       └── monthly-review.tmpl
├── discord-bot/handlers/
│   └── btc-ew.js                 # !ew command handler
└── lib/
    └── cdp.js                    # +captureScreenshot helper

ew-forecasts.json                  # Forecast log (gitignored)
.ew-state.json                     # State + calibration buckets (gitignored)
```

---

## Cron schedule

```
5  0,4,8,12,16,20 * * *  scripts/ew/run.js            — six-times-daily EW analysis
10 0,4,8,12,16,20 * * *  scripts/ew/backtest.js       — backtest sweep (+5min after run)
55 23             * * *  scripts/ew/daily-summary.js  — daily stats to #btc-ew-backtest
15 12             * * *  scripts/ew/daily-brief.js    — daily narrative brief
0  22             * * 0  scripts/ew/weekly-outlook.js — Sunday weekly outlook
0  14             1 * *  scripts/ew/monthly-review.js — 1st of month cycle review
```

Install all six idempotently with: `make ew-cron`.

---

## v1 boundaries (intentionally out of scope)

- No EW influence on `trigger-check.js` setup probability — revisit
  after ≥30 days of `#btc-ew-backtest` calibration evidence.
- No weekly/monthly TFs (Primary, Cycle, Supercycle degrees).
- No multi-instrument context (BTC.D, ETH/BTC, total cap).
- No LLM-rendered narrative writeups — all reports are deterministic
  template substitution.
- No live MongoDB integration — flat-file storage until
  `feat/mongodb-docker` Phase 2 lands.
- No historical-replay backtest — verification is forward-only.
