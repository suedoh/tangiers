# BTC Optimization Roadmap
**Status:** ACTIVE — Phase 1 shipped 2026-05-15
**Owner:** suedoh
**Baseline:** [btc-baseline-2026-05-15.json](btc-baseline-2026-05-15.json)
**Audit source:** [btc-audit-2026-05-14-v2.md](btc-audit-2026-05-14-v2.md)
**Tier-1 defect log:** [btc-tier1-defects-2026-05-15.md](btc-tier1-defects-2026-05-15.md)

---

## Why this exists

The audit produced 3 tiers of recommendations (defects / open questions / statistical hypotheses) that must be sequenced. Acting on tuning recommendations before correctness fixes ship pollutes the next dataset; acting on them simultaneously makes regressions impossible to attribute. This roadmap enforces order.

---

## Phase 1 — Ship now (DONE 2026-05-15)

Risk-reduction + calibration fixes. No new evidence required. Shipped in commit `0e01f2c` (Tier 1) + this commit (Phase 1).

| # | Change | File:line | Effect |
|---|---|---|---|
| **P1-1** | Probability constants 70/60/48 → 85/74/63; label thresholds re-anchored | [trigger-check.js:914](../scripts/trigger-check.js:914), [trigger-check.js:967](../scripts/trigger-check.js:967) | ECE 18pp → expected <5pp |
| **P1-2** | Daily-R kill switch: pause new signals if today's R ≤ −3 | [trigger-check.js:1494](../scripts/trigger-check.js:1494), gate at signal-fire | Caps tail drawdown; baseline had 11 consecutive stops |
| **P1-3** | Tier-aware suggested size in Discord alert (A=1.0×, B=0.7×, C=0.3×) | [trigger-check.js:968](../scripts/trigger-check.js:968) | Capital allocation reflects observed wr |
| **P1-4** | Extended cooldown 6h after same-zone stop (same-direction lock) | [trigger-check.js:1057](../scripts/trigger-check.js:1057), [trigger-check.js:1799](../scripts/trigger-check.js:1799) | Prevents same-zone re-fire patterns like 2026-04-13 |
| **P1-5** | **Position sizing math in alert** (added 2026-05-15 PM) — when `ACCOUNT_EQUITY_USD` set, alert shows exact $ risk, BTC size, notional, leverage. Tier multiplier scales risk %, not raw notional | [trigger-check.js:computeSizing](../scripts/trigger-check.js) | Without dollar sizing, tier multipliers were nominal; with it, account P&L tracks measured strategy edge |
| **P1-6** | **Drawdown-mode size suggestion** (added 2026-05-15 PM) — after 3 consecutive confirmed stops, suggested size halves until a winner clears the streak. Display only — doesn't suppress signals | [trigger-check.js:currentDrawdownMultiplier](../scripts/trigger-check.js) | Anti-martingale during losing streaks; finer-grained than the binary daily-R kill |

**Expected net effect:** +0.2 to +0.4 R per trade, 30–50% reduction in tail drawdown. No change to which trades fire (selection rules unchanged).

**Note on probability constants:** P1-1 values are in-sample point estimates from the 387-trade clean cohort on a single regime (uptrend). They are NOT statistically certified for tuning — but they replace constants that are demonstrably wrong (off by 14–22pp). The fix is a calibration correctness step, not a tuning decision. Re-evaluate in Phase 3.

---

## Phase 2 — Observation window (2026-05-15 → 2026-07-15)

**No code changes. Cron runs, data accumulates.**

Trigger to advance: ≥60 days of post-fix data AND ≥150 new closed trades AND at least one regime shift on the weekly chart (a meaningful test of the long-uptrend bias).

**Monitoring checkpoints (every 14 days):**

```bash
node scripts/audit/win-rate-diff.js --diff refactors/btc-baseline-2026-05-15.json --since 2026-05-15
```

| Anomaly counter | Must stay at | Action if grows |
|---|---|---|
| `unconfirmed_stops` | baseline (7) | D1 regression — investigate |
| `confirmed_after_close` | baseline (158) | D2 regression — investigate |
| `slow_confirms_over_1h` | baseline (79) | D2 regression — investigate |
| `zombie_setupType` | 0 | Cron is generating new ones — bug |

**Cohort health (look for patterns, not single-cohort movement):**
- `cleanFast` cohort wr should stabilize ~75% (was clean baseline)
- `confirmed` cohort wr should rise toward `cleanFast` as the late-confirm pollution stops accumulating
- Daily-R kill switch fires should be logged — count them; >3/month means the floor is too tight

---

## Phase 3 — Data-validated tuning + quant infra (begins ~2026-07-15)

**Two classes of work, both gated on Phase 2 passing:**
- **Data-validated** (P3-1 → P3-4): each contingent on a specific statistical test using the v3 stat stack (Wilson + Fisher + BH-FDR + day-clustered bootstrap + Brier/ECE). Don't ship until the trigger condition is met.
- **Quant infra** (P3-5 → P3-9): institutional-grade selection/exposure controls. Independent of statistical triggers — ship when the observation window ends. These are the items recommended on 2026-05-15 in the "must-haves for high-probability execution" review.

### Data-validated

| # | Change | Trigger condition | Effort |
|---|---|---|---|
| **P3-1** | Pause or hard-gate short book | Short mean-R 95% CI still includes zero after 90 days post-fix | 30m code + 1h analysis |
| **P3-2** | Drop, invert, or replace OI factor | OI factor still BH-FDR non-significant after 90 days; consider interaction term `OI rising × CVD aligned` | 1–2h |
| **P3-3** | Switch fill model to `min(bar.close, TP_N)` | TP3 first-bar rate stays > 80% after 90 days (current: 88%) | 30m code; will retroactively change historic R |
| **P3-4** | Re-derive probability constants from the post-fix walk-forward fit (or implement the weighted formula from spec) | Phase 2 ECE < 8pp validates current constants; otherwise recalibrate | 1–2h |

### Quant infra (selection + exposure controls)

| # | Change | Why | Effort |
|---|---|---|---|
| **P3-5** | **Funding rate filter** — read Binance `premiumIndex` per poll. If predicted funding > +0.05%/8h AND direction=long, downgrade tier by one (A→B, B→C, C→suppress). Symmetric for shorts at extreme negative funding | Extreme funding = crowded one-sided positioning = vulnerable to liquidation cascade. Documented BTC perp edge | 1h |
| **P3-6** | **Concurrent-trade exposure cap** — refuse `!took` when ≥3 BTC trades open. Optionally cap total open R at 2.0× single-trade risk | Signal clustering = correlated risk concentration. Standard institutional book-level control | 1h |
| **P3-7** | **Two-close confirmation for Setup C** — Setup C requires 2 consecutive 30M closes beyond entry; A and B unchanged | Setup C is the weakest cell (63% wr). Tightening entry on weakest setups is more surgical than dropping the tier | 30m |
| **P3-8** | **Liquidity-aware stop placement** — pull recent liquidation cluster data (Coinglass / Binance liq stream). If proposed stop falls within a known cluster, push 0.3% further away | Stops at obvious liq levels get hunted. Pushing past makes the same setup survive the sweep | 2-3h |
| **P3-9** | **Multi-exchange divergence check** — read BTC from Coinbase + Binance + Bybit at signal time. If venue spread > 0.05% on entry, downgrade or reject | Binance-only VRVP levels can be venue-specific artifacts; cross-venue agreement filters out single-exchange noise | 2h |

---

## Phase 4 — Architectural (only if Phase 3 confirms edge)

| # | Change | Why gate this |
|---|---|---|
| **P4-1** | Regime detector: BTC weekly close vs 20w SMA → long-bias / short-bias / flat modes | Current weeklyTrend filter never produced a counter-trend case in 31d — coarse |
| **P4-2** | Investigate TP1 over-representation; consider wider TPs with smaller initial size | Phase 3 fill-model fix may reveal that TP3 hits were genuinely rare |

---

## Order discipline (DO NOT SKIP)

```
Phase 1 (DONE) → Phase 2 (wait + measure) → Phase 3 (tune with data) → Phase 4 (architecture)
```

Skipping Phase 2 means tuning against polluted data. Skipping Phase 3 and jumping to Phase 4 means building architecture on unverified edge.

---

## Decision history

| Date | Decision | Reason |
|---|---|---|
| 2026-05-15 | Ship Phase 1 immediately | User-approved; correctness + risk infrastructure |
| 2026-05-15 | Defer D5 (probability constants per weighted formula from spec) to Phase 3 | smc-setups.md spec doesn't match current setup taxonomy; alignment is a refactor, not a quick fix |
| 2026-05-15 | Defer all factor tuning (OI, weeklyTrend) to Phase 3 | Single-regime data; need ≥60d to certify |
| 2026-05-15 | Daily-R floor set at −3R, not −2R or −5R | −3R = 3 consecutive stops; tighter would fire too often; looser undermines the protection |
| 2026-05-15 | Extended cooldown set at 6h, not 4h or 12h | 6h spans the typical session transition (one major session per zone) |
