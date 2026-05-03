# Weathermen — Backtesting & Performance Tracking

## Trade Lifecycle

```
SIGNAL FIRED → OPEN → RESOLVED → REPORTED
```

**Signal fired:** `market-scan.js` finds edge ≥ 8% on a Polymarket temperature bucket. Writes entry to `weather-trades.json` with `outcome: null`.

**Open:** Signal sits open until the market's resolution date. Use `!took <id>` to log a paper entry, which stamps `tookBy`, `tookAt`.

**Resolved:** Market settles via official NOAA/WMO observations (same source Polymarket uses). Use `!exit <id> win|loss|manual` to close. Stamps `signalResult`, `pnlDollars`, `closedAt`.

**Reported:** Every Sunday 18:00 → `weekly-report.js` reads `weather-trades.json` and posts P&L summary to `#weather-backtest`.

---

## Key Files

| File | Purpose |
|---|---|
| `weather-trades.json` | All signals + outcomes (gitignored, auto-created) |
| `scripts/weather/market-scan.js` | Fires signals, writes to weather-trades.json |
| `scripts/weather/weekly-report.js` | Sunday report → #weather-backtest |
| `scripts/discord-bot/handlers/weather.js` | !trades !took !exit !report |

---

## Paper Trading Commands

```
!trades                    → top 8 open signals (soonest resolving, highest edge)
!took <id>                 → log paper entry on a signal
!exit <id> win|loss|manual → close a paper trade
!report                    → generate weekly report now → #weather-backtest
```

---

## Signal Fields (weather-trades.json)

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

## Edge Tiers

| Tier | Edge | Meaning |
|---|---|---|
| High | ≥ 25% | Models strongly disagree with market |
| Medium | 15–25% | Meaningful mispricing |
| Minimum | 8–15% | Marginal — monitor before raising threshold |

**Current threshold:** 8% (conservative — review after first resolved batch)

---

## Weekly Report Sections

1. **Resolved this week** — win/loss per signal with P&L
2. **Edge-tier breakdown** — win rate by High / Medium / Min tier
3. **City breakdown** — P&L sorted by city
4. **Open positions** — up to 8, sorted by resolution date

---

## Validation Checklist (after first resolved markets)

- [ ] `signalResult` matches actual Polymarket settlement
- [ ] `pnlDollars` = `betDollars × (1 - price) / price` for wins, `-betDollars` for losses
- [ ] Win rate by edge tier — High tier should outperform Min tier
- [ ] Compare `modelProb` vs settlement — are we systematically high/low on any city?
- [ ] Review any edge ≥ 40% misses — indicates a model calibration issue
