# BTC Weekly Game Plan — Week of 2026-05-15

**Goal:** generate enough clean post-fix data to validate the strategy works, with you tracking your own execution against it.

---

## Daily routine (5 min/day)

1. **Open TradingView Desktop on `🕵Ace` layout, BINANCE:BTCUSDT.P.** Leave it open. Chart TF can be anything now (canonical-TF fix handles it).
2. **Confirm VRVP indicator is visible** on the chart (the fix doesn't help if VRVP itself is hidden).
3. **Check `#btc-signals` once in the morning, once before bed.** Don't compulsively monitor — alerts come to you.

---

## When a signal fires

```
Signal posts in #btc-signals
        ↓
Setup A — 💰 TAKE THIS TRADE          → take it
Setup B — ⚠️ WATCHLIST                → take if you have the screen time + risk capacity
Setup C — 🚫 SKIP                     → skip
```

**If you take it:**
1. Place the trade on your exchange at the suggested entry/SL/TPs.
2. In `#btc-signals`, reply: `!took <id>` (id is on the alert).
3. When you close (any TP or stop), reply: `!exit tp1` / `!exit tp2` / `!exit tp3` / `!exit stop` / `!exit manual <price>`.

**Sizing per the new alerts:**
- Setup A → **1.0× your base unit**
- Setup B → **0.7×**
- Setup C → **0.3×** (probably skipping)

The "base unit" is whatever single-trade risk you've already committed to. If you don't have one, pick a fixed dollar amount you'd be OK losing on a stop and use that as 1.0×.

---

## Don't do this week

- **Don't take signals when the daily-R kill switch has fired** ("DAILY-R KILL ACTIVE" in #btc-signals). Stop for the day.
- **Don't take stale signals.** The `!took` handler enforces a 24h cap; respect the spirit even before that.
- **Don't override the suggested SL.** The system measures R-multiples against the signal's stop; moving it makes your `!exit` math wrong.
- **Don't switch instruments mid-week.** This week is about clean BTC data.

---

## Mid-week checkpoint — automated

A Docker cron runs **every Wednesday at 13:00 UTC** and writes the result to:

```
notes/audits/latest.txt              ← always the most recent run
notes/audits/mid-week-diff-<ts>.txt  ← per-run history
```

Open `notes/audits/latest.txt` to see Wednesday's diff. You don't need to run anything by hand.

If you want to run it ad-hoc:
```bash
cd ~/trading && node scripts/audit/win-rate-diff.js --diff refactors/btc-baseline-2026-05-15-pre-tf-fix.json --since 2026-05-15
```

What to look at:
- **Anomaly counters** — `unconfirmed_stops`, `confirmed_after_close`, `slow_confirms_over_1h` should be **flat** (Tier-1 fixes prevent new instances).
- **Signal volume** — expect roughly half what you'd have seen pre-TF-fix.
- **No win-rate verdict yet** — diff harness will say "unchanged" because n is too small. That's fine.

If `confirmed_after_close` or `slow_confirms_over_1h` grew, ping me — that's a regression.

---

## End of week (Monday 09:00 UTC)

The weekly report auto-posts to `#btc-backtest`. New for you: a **YOUR EXECUTION** section showing selectivity %, your wr vs system, your avg R vs system.

| Outcome | Means | Do |
|---|---|---|
| Your wr ≥ system wr | You're picking good setups | Keep doing what you're doing |
| Your wr ≫ system | Cherry-picking | Look at which signals you skipped — were they Cs? Good. Were they As? Bad |
| Your wr < system | Marginal entries or fumbled execution | Compare wins you missed; usually TP/stop placement |
| Selectivity < 30% | Not enough sample | Take more Bs next week |
| Selectivity > 80% | Indiscriminate | Tighten to As + strong Bs |

---

## What "right strategy" looks like at end of week

1. **Anomaly counters at zero growth** — Tier-1 fixes holding.
2. **Confirmed-only win rate ≥ 70%** (single-week sample, noisy — directional check only).
3. **Your execution track exists** — you've used `!took`/`!exit` enough that YOUR EXECUTION has real numbers.

Whether the strategy itself is "right" cannot be answered in one week. Roadmap verdict needs ≥60 days and a regime shift. This week is about **building the data**, not making the call.

---

## If something is off

- **Signals stop firing entirely** → TradingView open? VRVP visible? 🕵Ace layout?
- **Daily-R kill fires twice in one week** → floor may be too tight; flag for me
- **You take 0 trades** → fine for the system, no comparison track for you. Take at least 2-3 Bs+ to seed it.
- **Anomaly counter grows** → flag immediately

---

## TL;DR

| When | Do |
|---|---|
| All week | Leave TV open, react to Discord, use `!took` + `!exit` |
| Signal fires | Read tier, take As (1.0×) and Bs (0.7×), skip Cs |
| Wednesday | Open `notes/audits/latest.txt` (auto-generated) |
| Monday | Read the weekly report's YOUR EXECUTION section |
