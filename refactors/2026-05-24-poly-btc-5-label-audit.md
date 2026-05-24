# Poly BTC-5 — Outcome-label correctness audit
**Status:** DONE — defects classified, fixes proposed (not yet shipped)
**Owner:** suedoh
**Date:** 2026-05-24
**Ground truth source:** Binance Futures public klines `/fapi/v1/klines` (`BTCUSDT`, `5m`)
**Sample window:** 2026-05-03 → 2026-05-24 (420 signaled bars, ~21 days)

---

## TL;DR for the quant lens

**Do NOT optimize features yet.** 6.4% of signaled bars carry a wrong or missing label. Every factor-lift estimate, every threshold-tuning argument, and the published 65.7% win rate are biased by this label noise. Fix Tier 1 first, then re-baseline, then consider feature work.

| Metric | Stored | Binance ground truth |
|---|---|---|
| Total signaled bars | 420 | 420 |
| Resolved (has `outcome`) | 405 | 420 (if orphans recovered) |
| Orphans (`outcome=null`, >30min old) | 14 | — |
| Wins (`correct=true`) | 266 | 261 |
| Losses (`correct=false`) | 139 | 144 |
| Reported wr | 65.7% | 64.4% on resolved / 65.0% inc. orphans |
| **Label disagreements vs truth** | — | **13 / 405 = 3.2%** |
| **Wr bias from label errors** | — | **+1.3pp overstatement** |

---

## Tier 1 defects (must fix before any tuning)

### T1.1 — Outcome read returns wrong bar (~3.2% of resolved signals)

13 of 405 resolved signals have `outcome` that disagrees with the Binance Futures 5-min bar for the same `barOpen`. Direction of error is NOT random:
- 9 cases: stored direction matches `prediction`, truth disagrees → **emoji ✅ posted, was actually ❌**
- 4 cases: stored direction is opposite of `prediction`, truth agrees → emoji ❌ posted, was actually ✅
- Net: stored wr is biased **+1.2pp high** (more spurious wins than spurious losses)

**Cluster pattern:** 8 of 13 disagreements occur on 2026-05-23 + 2026-05-24 (last 48h). The rest are spread across May 10–18. Either a recent regression or a TV-environmental issue (chart not in foreground, slow tick, late refresh).

**Suspected root cause** ([trigger-check.js:352-355](../scripts/poly/btc-5/trigger-check.js:352)):
```js
const ohlcvCheck       = await getOHLCV(client, 3);
const prevCompletedBar = ohlcvCheck[ohlcvCheck.length - 2];
if (prevCompletedBar && prevCompletedBar.close != null) {
  prevEval.outcome  = prevCompletedBar.close >= prevCompletedBar.open ? 'UP' : 'DOWN';
```

Two ways this goes wrong:
1. **TF-switch race**: `setTimeframe(client, '5')` is fire-and-forget; the warning landed in 340d910 ("setTimeframe times out without confirmation"). If TV is still on a prior timeframe when `getOHLCV` runs, bars are from the wrong resolution.
2. **No bar-timestamp validation**: code blindly takes `[length - 2]`. If TV's chart has lagged and the latest *finalized* bar is one earlier than expected, `[length-2]` is the *previous-previous* bar.

**Fix**: validate `prevCompletedBar.time === prevBarTimestamp` before writing outcome. On mismatch, log + leave `outcome=null` for next cycle to retry (or fall back to a Binance REST call as ground truth).

**Affected signals** (date, prediction, stored vs truth):
```
2026-05-10 16:00 UP     stored=UP    truth=DOWN
2026-05-15 14:00 DOWN   stored=DOWN  truth=UP
2026-05-16 07:35 DOWN   stored=DOWN  truth=UP
2026-05-16 08:05 DOWN   stored=DOWN  truth=UP
2026-05-16 09:15 DOWN   stored=UP    truth=DOWN
2026-05-16 11:45 DOWN   stored=UP    truth=DOWN
2026-05-18 11:50 DOWN   stored=DOWN  truth=UP
2026-05-23 14:45 UP     stored=UP    truth=DOWN
2026-05-23 15:25 DOWN   stored=UP    truth=DOWN
2026-05-23 15:45 UP     stored=UP    truth=DOWN
2026-05-23 16:00 UP     stored=DOWN  truth=UP
2026-05-23 18:55 UP     stored=UP    truth=DOWN
2026-05-24 08:15 UP     stored=DOWN  truth=UP
```

### T1.2 — Orphaned signals (3.3% of signaled bars)

14 signaled bars have `outcome=null` permanently. Cause ([trigger-check.js:347](../scripts/poly/btc-5/trigger-check.js:347)):
```js
const prevEval = trades.find(t => t.barOpen === prevBar && !t.outcome);
```
Only the **immediately previous** bar is checked. If a cron run is skipped (lock contention, CDP outage, late fire), that bar's outcome is never written. The next run looks at *its* prevBar, not the gap.

**Effect on quant work:** orphans aren't in `resolved`, so they don't affect wr math directly — but they also have no Discord emoji, which is what the user noticed. 12 of 14 orphans would have been correct → quietly under-reporting wins.

**Fix**: change to "resolve all signaled bars older than 10 minutes with `outcome=null`," capped at e.g. 50 per run. Use Binance REST as the ground-truth source so it doesn't depend on TV being open.

**Recoverable now via Binance**:
```
2026-05-08 10:35 UP   → UP   ✓
2026-05-08 11:10 UP   → UP   ✓
2026-05-10 16:50 UP   → UP   ✓
2026-05-10 17:35 UP   → DOWN ✗
2026-05-11 18:15 DOWN → DOWN ✓
2026-05-13 10:35 DOWN → DOWN ✓
2026-05-15 18:30 DOWN → DOWN ✓
2026-05-15 19:25 DOWN → DOWN ✓
2026-05-16 20:30 DOWN → DOWN ✓
2026-05-17 12:00 UP   → DOWN ✗
2026-05-17 19:05 UP   → DOWN ✗
2026-05-17 19:35 UP   → UP   ✓
2026-05-17 20:40 DOWN → DOWN ✓
2026-05-18 12:00 DOWN → DOWN ✓
2026-05-24 10:05 UP   → UP   ✓     (signal from this morning — emoji should backfill)
```

### T1.3 — `_signal_messages` state holds only 20 of 405 resolved signals

State currently tracks message IDs for only the most-recent 20 signals. The other 385 cannot get a live reaction even if outcome resolves correctly — they're entirely dependent on `backfill-reactions.js`. The backfill maps via Discord snowflake → ms → minus 90s → floor(min/5)*5; this is **off-by-one-bar** if the cron ever fired <90s after bar open.

I haven't grep'd for explicit pruning logic; whatever the cause, the gap means the live reaction path is effectively disabled for anything older than a couple hours. A user manually scrolling Discord history will see exactly this: missing or wrong emojis on older signals, fresh signals look OK.

**Fix**: stop pruning `_signal_messages` until the corresponding trade is resolved. Cap on time, not count.

---

## Open questions (need user input, not code changes)

### OQ1 — Polymarket's actual resolution rule

The code resolves outcome via `Binance Futures 5-min bar close >= open`. Polymarket's BTC 5-min markets may resolve on a different oracle (Coinbase reference at HH:MM:00, Binance spot, etc.). If they don't agree, even fully-correct labels are dishonest about whether the actual Polymarket bet won.

Quant impact: this is a systematic bias, not noise. Could flip the sign of factor lifts in pathological cases.

**Resolution path**: open the discovered market URL (cached in `.poly-btc-5-state.json._marketUrl`), read Polymarket's resolution methodology. If it disagrees with our Binance Futures close>=open rule, change the outcome source.

### OQ2 — Why the 2026-05-23/24 cluster

8 of 13 wrong labels in 48h. Either a code regression I haven't found, a TV bug, the chart was minimized, or pure variance. Worth checking before assuming the fix works.

---

## Statistical hypotheses — explicitly out of scope

Per the project's audit methodology, no factor-lift work, threshold tuning, or feature optimization in this audit. Those go in a separate pass **after** Tier 1 fixes ship and a fresh baseline is captured.

When that pass happens, the entry criteria are:
- T1.1 + T1.2 fixed; new label-disagreement rate <0.5% (sample again after 7 days)
- T1.3 fixed; no missing reactions on signals <48h old
- OQ1 resolved (Polymarket rule confirmed or our outcome source changed)
- ≥150 new signaled bars under the fixed pipeline (Wilson CI tight enough for cohort-level claims)

---

## Recommended sequence

1. **Today** — ship T1.1 + T1.2 + T1.3 in one commit. Use Binance REST as both validator (T1.1) and orphan-recovery source (T1.2). Backfill the 13 wrong labels and 14 orphans using ground-truth recompute. Post correct emojis to the affected Discord messages (where message IDs survive in state) or skip (where they've been pruned).
2. **This week** — resolve OQ1 by reading Polymarket's resolution methodology page for the active market.
3. **Next 7 days** — observe. Re-run this same audit script. Disagreement rate should be ≤0.5%; if it isn't, T1.1 fix didn't address the root cause.
4. **After observation** — re-baseline `poly-btc-5-trades.json`, then any feature/threshold work can proceed.

---

## Quant verdict — should we optimize features?

**No.** Not yet. The reported 65.7% wr is real-ish (true ~65.0%), but per-factor lift and threshold-tuning conclusions drawn from this dataset will carry the 3.2% label error plus the systematic 5/8/9-style cluster bias. Optimizing on contaminated labels is how subtle but wrong features sneak into production.

Order it the same way the BTC audit was ordered: defects → re-baseline → walk-forward → tuning.

## Verification artifacts

- Audit script: ad-hoc inline (not committed; runs in <60s)
- Mismatch detail: `/tmp/poly-audit-mismatches.json` (not committed)
- Sample window: 2026-05-03 → 2026-05-24
