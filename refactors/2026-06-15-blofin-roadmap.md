# Roadmap: Tangiers → Real Capital Trading via BloFin

**Date:** 2026-06-15
**End goal:** Automated live capital trading on BloFin
**Timeline:** ~3 months to first live capital, ~5 months to comfortable size
**Guiding principle:** Earn each phase by proving the prior one. Never advance on optimism.

---

## Phase A — BloFin Integration Foundation (1–2 weeks)

**Goal:** Read-only API client talking to BloFin demo/testnet.

**Deliverables**
- [scripts/lib/blofin.js](../scripts/lib/blofin.js) — auth, request signing, REST client, rate-limit handling
- Read endpoints only: account balance, open positions, recent fills, symbol info
- Credentials in `.env`, never in code, never logged
- Demo-env confirmed via `make blofin-status` health check

**Exit criteria**
- Can query demo account state programmatically
- Zero credential exposure

---

## Phase B — Paper-Trade Execution Layer (2–3 weeks)

**Goal:** System places real orders on BloFin demo on every signal, end-to-end lifecycle tracked.

**Deliverables**
- Order placement: market entry, stop-loss as hard exchange order, TP1/TP2/TP3 as OCO or staged limits
- Order state persisted to **MongoDB** (this consumes [MongoDB Phase 3](2026-05-09-mongodb-migration-plan-status.md) — ships as part of Phase B, not separately)
- Reconciliation loop: poll fills every ~30s, update local position state to match exchange truth
- Position sizing uses existing `ACCOUNT_EQUITY_USD` + Phase 1 tier logic
- **Hard kill switch**: when daily-R floor breached, system cancels all pending and refuses new orders (not just advisory like today)
- Signal → order → fill → close lifecycle persisted with every state transition timestamped

**Exit criteria**
- 2 consecutive weeks of zero divergence between system state and exchange state on demo
- Every signal either becomes an order or logs an explicit reason why not

---

## Phase C — Signal Quality Hardening (parallel with B, 2–3 weeks)

**Goal:** Tighten signal quality so demo trading exercises the *best* signals, not the average ones.

**Deliverables**
- **Per-direction tier recalibration** (low-risk part of short-bias fix) — refit 85/74/63 probability constants separately for longs and shorts using n=629 cohort
- Verify `short | C | VAH` gate (shipped 2026-06-15, commit [974e099](../refactors/2026-06-15-short-c-vah-gate.md)) is dropping ~1.3 signals/day as predicted
- Backtest replay framework: rerun historical signals against simulated fills to estimate slippage impact
- Tighten `short | B | VAH` if Phase B fill data confirms the 63% wr survives execution

**Exit criteria**
- Cohort wr trending up
- Recalibrated tier labels backtest within ±2pp of declared probability
- No signal-pipeline regression vs `notes/audits/baselines/2026-06-15-pre-short-c-vah-gate.json`

> **NOT in this phase:** the short-specific criteria rebuild. Deferred to Phase E earliest because it's high-risk and only worth doing if real-fill data confirms the longs/shorts gap survives execution friction.

---

## Phase D — Paper Trading Forward-Test (4–8 weeks)

**Goal:** Prove the system captures the modeled edge under real execution friction.

**Deliverables**
- Run automated demo trading continuously
- Daily reconciliation report posted to a new Discord channel: `#blofin-recon`
- **Slippage attribution:** paper P&L vs hypothetical P&L from `trades.json` — quantify the gap
- **Fee drag analysis:** BloFin maker/taker fees × signal frequency
- Order-type tuning: market vs limit-at-zone, based on fill data
- Operational drill log: simulated exchange outages, network drops, mid-trade system crashes — every failure mode documented and patched

**Exit criteria — ALL of:**
- Paper P&L within ±20% of `trades.json` hypothetical expectancy
- Zero operational incidents (unintended positions, orphaned orders, state desync) in 30 consecutive days
- Daily-R kill switch has fired and held at least once in a real drawdown
- Daily reconciliation reviewed by you for 30 days, nothing broken found

---

## Phase E — Live Capital Pilot, micro-size (4 weeks minimum)

**Goal:** Prove live trading works at a size where being wrong costs the price of a dinner.

**Deliverables**
- **Capital cap: $500–$1000 maximum. Non-negotiable.**
- Signals fire on **demo and live simultaneously** — demo is the control group, live is the test
- All Phase D drills repeated with real money on the line
- Daily P&L review with eyeballs, not just dashboards
- Optional: **short-specific criteria rebuild** if Phase D data confirmed the long/short gap survived execution (otherwise defer)

**Exit criteria — ALL of:**
- 4+ consecutive weeks of live trading
- Live expectancy within ±15% of demo expectancy
- Zero operational incidents
- Maximum drawdown stayed within modeled risk envelope

---

## Phase F — Capital Ramp (ongoing)

**Goal:** Scale capital safely.

**Discipline**
- 2× capital every 4 consecutive weeks of clean operation
- **Hard regression rule:** any operational incident OR drawdown beyond -3R/day → halve size, freeze ramp for 4 weeks, root-cause and ship fix before resuming
- Quarterly signal-quality recalibration using `scripts/audit/win-rate-diff.js`
- Cap any single instrument at no more than 25% of total trading capital

---

## Parallel work — what slots in, what doesn't

| Existing work | Slot |
|---|---|
| MongoDB migration Phase 3–5 | **Consumed by Phase B.** Order/position state goes straight to Mongo; trigger script's Mongo dual-write rides this phase. Phases 4–5 finish post-Phase D. |
| EW "all ambiguous" investigation | **Parallel, independent.** Schedule for the gap during Phase D's wait-and-watch period. See [project_pending_followups.md](https://...). |
| Poly BTC-5 Phase 2 (factor tuning) | **Parallel, gated separately.** Different instrument. Don't let it block BloFin work. |
| BTC short-criteria rebuild (bigger fix) | **Phase E earliest.** Wait until execution data tells you whether it's worth the risk. |

---

## Sequencing rationale

1. **Demo before any signal-pipeline changes you can't revert.** Bigger fixes (short criteria) carry forward-test risk; demo trading lets you measure execution risk first so you don't conflate the two.
2. **MongoDB Phase 3 merges into Phase B by necessity** — order state needs durable storage anyway. Ship both together rather than running JSON for orders and Mongo for trades.
3. **Live capital is gated on three things, not one:**
   - Signal expectancy (you have this — 69% wr, +1.07R/signal over last 30d)
   - Execution fidelity (Phase D proves)
   - Operational maturity (Phase E proves)
   Skipping any of these is how systems that "backtested fine" blow up live.
4. **The short-criteria rebuild is deliberately late.** Highest-risk, highest-effort signal work; demo phase will tell you whether it's actually needed or whether execution friction makes it noise.

---

## Hard gates between phases

These are non-skippable:

| From | To | Gate |
|---|---|---|
| A → B | — | Read-only client works, demo env confirmed |
| B → D | (C parallel) | 2 weeks zero state divergence |
| C → D | — | Recalibration validated, no regression vs baseline |
| D → E | — | 30 consecutive days clean + paper P&L within ±20% of expectancy |
| E → F | — | 4 weeks live with ±15% expectancy and zero ops incidents |
| Within F | next size tier | 4 consecutive clean weeks at current size |

---

## Risk bounds

| Phase | Capital at risk | Operational risk |
|---|---|---|
| A–D | $0 | Low (demo only) |
| E | $500–$1000 | Medium (real money, tiny size) |
| F | Ramping | Medium-high (real money, growing size) |

The system never advances to a size where a single bad week threatens the account. If you can't afford to lose 30% of current trading capital in a month, halve the cap before the next ramp tier.
