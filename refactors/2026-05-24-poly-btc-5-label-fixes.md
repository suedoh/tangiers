# Poly BTC-5 — Outcome label correctness fixes (ships audit Tier 1)
**Status:** DONE
**Owner:** suedoh
**Date:** 2026-05-24
**Audit:** [2026-05-24-poly-btc-5-label-audit.md](2026-05-24-poly-btc-5-label-audit.md)

---

## What changed

### Code

1. **New file** [scripts/lib/binance.js](../scripts/lib/binance.js) — Binance Futures REST helpers (`getKline5m`, `btcDirection5m`, `getKlines5mRange`). Used as ground-truth source for outcome resolution (TV CDP reads were 3.2% wrong).

2. **New helper** [scripts/lib/discord.js — `removeOwnReaction`](../scripts/lib/discord.js) — required to replace mismatched ✅/❌ emojis on historical signal messages.

3. **Rewrote outcome resolution** in [trigger-check.js](../scripts/poly/btc-5/trigger-check.js):
   - Old: single-prev-bar TV OHLCV read with no timestamp validation. Race against TF switch / chart tick. Orphans created on cron skips.
   - New: loops over ALL signaled bars with `outcome=null` whose `barOpen` is ≥6 minutes old (≤20 per run). Resolves each via Binance Futures klines. No TV dependency for the outcome step — works even when chart is offline.
   - Runs BEFORE `cdpConnect`, so an unhealthy chart doesn't block outcome resolution.

4. **Age-based `_signal_messages` pruning** in trigger-check.js:
   - Old: capped at 20 most-recent. Dropped IDs before outcome resolved for 95%+ of signals → reactions only posted via the (buggy) backfill.
   - New: 14-day TTL. Plenty of margin for outcome latency, still small enough to keep state file bounded.

5. **Fixed snowflake decoder** in [backfill-reactions.js](../scripts/poly/btc-5/backfill-reactions.js):
   - Old: `msToBarOpen` subtracted **90s** then floored to 5-min. Verified against 20 known message IDs in state: **0/20 correct.** Every match landed on the bar 5 min BEFORE the signal. A `prevBarOpen` fallback compounded the error by another 5 min — so historical emojis were posted as the outcome of a bar 10 minutes earlier than the actual signal.
   - New: subtracts 60s, floors. **20/20 correct** on the same samples. Removed the `prevBarOpen` fallback (it was masking the bug).

6. **Added `--fix-wrong` mode** to backfill-reactions.js: detects messages whose existing ✅/❌ disagrees with the (now-corrected) trade outcome, removes the wrong reaction, posts the right one. Default behavior (no flag) is non-destructive.

### One-time data backfill (executed)

1. **`scripts/poly/btc-5/backfill-outcomes.js`** (new) — recomputed outcome for all 420 signaled bars against Binance ground truth. Wrote 13 corrections; 14 orphans had already been resolved by the live cron at 10:11 UTC running the new code.
2. **`backfill-reactions.js --fix-wrong`** — checked 577 historical Discord messages, posted 45 new reactions and corrected 22 wrong ones.

### Sequence (what actually ran)

```
backfill-outcomes.js                  → JSON: 13 wrong labels corrected
backfill-reactions.js --fix-wrong     → Discord: 45 new + 22 fixed
```

Backups kept locally: `poly-btc-5-trades.json.bak-<ts>`.

---

## Risk

- **Selection rules unchanged.** No factor weights, no threshold, no scoring touched. This is label-correctness only.
- **No BTC impact.** Verified pre-flight — separate scripts, state files, trades files, webhooks, handlers. The one shared mutex (`scripts/lib/lock.js`) is now held for **less** wall time per poly run since outcome resolution moves off CDP.
- **Binance dependency added.** Outcome resolution requires `fapi.binance.com` reachable. If Binance is down or rate-limits us, outcome stays `outcome=null` and retries next cycle — non-destructive. Old TV path is gone; we accept this dependency as net positive (worked in audit; TV was the broken one).
- **22 emojis on Discord were just flipped.** If a user had screenshotted the old ones, they look different now. The change matches Binance Futures ground truth.

---

## Verification

- `node -c` on all 5 modified/new files — syntax OK
- Snowflake decoder: 20/20 correct on `_signal_messages` known-correct samples
- backfill-outcomes dry-run output matches audit findings exactly (13 wrong, 0 orphan post-cron-fire)
- Live backfill-reactions: 0 errors over 577 messages
- Next 7 days: re-run [/Users/vpm/trading/refactors/2026-05-24-poly-btc-5-label-audit.md](2026-05-24-poly-btc-5-label-audit.md)'s diff script. Disagreement rate should be ≤0.5%. If not, the live trigger-check fix didn't address root cause.

---

## What's still open

- **OQ1 (Polymarket resolution rule).** Our outcome rule is Binance Futures 5-min bar close ≥ open. If Polymarket resolves on a different oracle (Coinbase ref, exact HH:MM:00 mark price), labels are honest about Binance moves but not about whether the Polymarket bet won. Resolution path: open the discovered market URL, read methodology. **Not blocking** — Binance and Polymarket BTC 5-min markets generally agree at the bar boundary, and any systemic bias would be flagged once labels stabilize.
- **No factor / threshold work** until ≥150 new signaled bars accumulate under the fixed pipeline (Phase 2 observation discipline).

---

## Decision history

| Date | Decision | Reason |
|---|---|---|
| 2026-05-24 | Use Binance REST as outcome source instead of TV OHLCV | Audit found 3.2% TV-vs-truth disagreement; Binance is authoritative |
| 2026-05-24 | Resolve ALL unresolved signaled bars per run (not just prevBar) | Single-prev-bar logic created orphans on cron skips; new loop is self-healing |
| 2026-05-24 | Age-based message-ID pruning (14d) instead of count cap (20) | Reaction posting depends on the ID surviving until outcome resolves |
| 2026-05-24 | Run backfill-reactions with --fix-wrong immediately | User had been seeing wrong emojis; non-destructive default left available for future runs |
| 2026-05-24 | Skip OQ1 (Polymarket resolution rule) for now | Not blocking; can be addressed in a follow-up if labels drift again |
