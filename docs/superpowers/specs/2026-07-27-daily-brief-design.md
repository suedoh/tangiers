# Daily BTC brief + forward-test collector — design

**Date:** 2026-07-27 · **Status:** awaiting operator review · **Target:** `#btc-backtest`

## Purpose

One job at 07:00 UTC that does two things which reinforce each other:

1. **Accumulates out-of-sample evidence** on the only research candidate that has survived
   205 hypothesis cells (4h high-volatility momentum). This candidate is blocked on a problem
   history cannot solve — it fires 24–99×/yr, so the sample it needs can only come from forward
   time. Every day the job runs, the sample grows.
2. **Keeps the operator informed daily** with genuine technical context — trend, volatility
   regime, and levels — plus the state of the research programme.

The order-book recorder continues untouched; this job neither depends on nor disturbs it.

## Why the two halves belong in one job

The forward test gives the brief something *true* to say. Without it, a daily TA report is a
well-formatted description of indicators that 205 tests found do not predict price after costs —
informative-feeling and predictively empty, which is the same failure mode as the retired
85/74/63% labels. Pairing them means the report's headline number is real and grows.

## Non-goals

- **No win probabilities, anywhere.** Enforced by test, not discipline (see Guardrails).
- **No LLM.** Project rule: zero AI in the automated pipeline. All prose is templated or read
  from a curated artifact.
- **No trade execution.** Paper only. This job never touches BloFin.
- **No TradingView/CDP.** Fully exchange-native, so it runs in Docker and works when the chart
  is closed.

## Architecture

```
scripts/daily-brief.js          entry point, 07:00 UTC, Docker ace-cron
  ├── lib/market-data.js        (existing) klines, volume profile, ATR, VWAP, CVD
  ├── lib/daily-context.js      NEW — pure functions: trend state, regime, levels
  ├── lib/paper-book.js         NEW — non-overlapping paper ledger + scoring
  └── lib/discord.js            (existing) postWebhook
```

`daily-context.js` and `paper-book.js` are pure and separately testable: given bars in, they
return state out. `daily-brief.js` orchestrates and renders. No network calls in the pure
modules.

## Execution order (deliberate)

Scoring runs **before** evaluation so the brief always reports a settled book, and so a crash in
rendering cannot lose a resolved outcome.

1. **Score** — resolve open paper trades whose barrier has been touched or horizon expired.
2. **Evaluate** — compute today's state; if the condition fires and the book is flat, open a
   paper trade. If it fires while a position is open, record `skipped_overlap` (this is the
   discipline that made round 4's numbers honest).
3. **Render + post.**

## The candidate under test

Fixed at design time, not tunable without a dated log entry (spec 07.5):

- **Timeframe** 4h · **Barrier** ±1×ATR14 and ±3×ATR14 tracked as two independent books
- **Condition** `atrPctl > 0.9` (trailing 180-bar percentile) **AND** momentum sign over 30 bars
- **Direction** long if momentum > 0, short if < 0
- **Accounting** non-overlapping, 6bp taker in / 2bp maker out, funding charged per 8h held

Both k=1 and k=3 run because round 4 found them inconsistent (k=1 Sharpe 0.25, k=3 1.30 raw /
0.76 deflated). Tracking both forward is how that inconsistency gets resolved rather than assumed.

**Overlap suppression is per-k, not global.** The two books are independent experiments measuring
the same condition at different barrier widths; a k=1 position must not suppress a k=3 entry or
the two samples become entangled and neither is interpretable. Each book maintains its own
`busyUntil`. This is a paper ledger, so there is no margin or position conflict to model —
if a candidate is ever promoted to live, the live sizing layer resolves conflicts, not this job.

## Report sections

| # | Section | Content |
|---|---|---|
| 1 | **Trend** | 1d/4h/1h: EMA20/50 spread, 5d and 7d momentum sign, structure (HH/HL vs LL/LH). Numbers, not adjectives. |
| 2 | **Volatility regime** | ATR%, ATR percentile, and whether today is in the top-10% band the candidate requires. |
| 3 | **Levels** | Volume profile POC/VAH/VAL (30d), swing high/low (7d + 30d), ATR-projected daily range. Liquidation clusters: slot present, dark until the corpus matures. |
| 4 | **Watch condition** | ACTIVE / INACTIVE, with the reason. Always carries the evidence tag. |
| 5 | **Forward test** | Paper book to date: n closed, open, hit%, net R after fees+funding, lift vs always-long, trades still needed for a verdict. **The section that grows.** |
| 6 | **Project status** | Falsification gate result + date, cumulative cells, order-book coverage and days to the 2026-08-25 decision, BloFin demo state. |
| 7 | **Outlook** | Rendered from `rebuild/status.json` — a curated, version-controlled artifact updated when a research round lands. Never generated prose. |

### Mandatory tags

- Section 3 carries: *"Context for where price is, not setups — these are the volume-profile
  zones that produced −131.4R."*
- Section 4 carries the candidate's true strength every time it renders, e.g.
  *"deflated Sharpe 0.76 · n=66 · NOT validated · do not size on this."*

## Data model

**`btc-paper-trades.json`** (gitignored, same convention as `trades.json`):

```
{ id, openedAt, k, side, entry, atrPct, barrierUp, barrierDn, horizonMs,
  atrPctl, momentum, status: 'open'|'closed'|'skipped_overlap',
  closedAt, outcome: 'up_first'|'dn_first'|'expired',
  grossR, feeR, fundR, netR, alwaysLongOutcome }
```

`alwaysLongOutcome` is stored per trade so the always-long benchmark is computed on the *same
entries*, never re-derived later.

**`rebuild/status.json`**: `{ phase, headline, findings[], nextMilestone, nextMilestoneDate, updatedAt }`.

## Guardrails

1. **`test/daily-brief.test.js` fails the build if any rendered setup line matches a probability
   pattern** (`\d+%` within sections 4–5 outside of measured-hit-rate fields explicitly
   whitelisted). Structural, not a matter of care.
2. Every paper trade records the accounting inputs used, so a later fee-model change can be
   re-applied rather than silently invalidating history.
3. If the falsification gate's last result was FAIL, the brief says so in section 6 — the report
   never reads more confident than the evidence.

## Error handling

- Binance fetch failure → post a short degraded notice to the same channel and exit non-zero;
  never post a brief with silently missing sections.
- Missing `rebuild/status.json` → render sections 1–6 and note section 7 unavailable.
- Paper-book write failure → loud, and the run exits non-zero so cron logs catch it.
- All network calls use the existing retry/timeout conventions in `market-data.js`.

## Testing

- Unit: `daily-context.js` level computations against a fixed kline fixture with hand-checked
  POC/VAH/VAL, ATR, and swing values.
- Unit: `paper-book.js` — overlap suppression, funding accrual across an 8h boundary, barrier
  resolution when both barriers fall inside one label bar (must record ambiguous, never guess).
- Integration: `--dry-run` renders the full brief to stdout and posts nothing.
- Guardrail test as above.

## Cron

`scripts/cron/ace.crontab`: `0 7 * * * node /app/scripts/daily-brief.js >> /app/logs/daily-brief.log 2>&1`

Docker, not host — no CDP dependency. Avoids the Monday 08:30 falsification job.

## What this does not solve

The forward test needs ~200 trades for a verdict. At the candidate's measured frequency that is
roughly 2 years at k=1 and considerably longer at k=3. **This job does not make the candidate
tradeable sooner; it makes the wait productive instead of idle.** If the order-book round
(2026-08-25) produces a higher-frequency candidate, it should be added to the same paper book
rather than replacing it.
