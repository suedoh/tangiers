# Falsification harness + reporting honesty (rebuild specs 07.2, 09.1, 09.2)

**What shipped**

1. `scripts/audit/falsification.js` — standing falsification gate, ported from
   `rebuild/tools/stats.js` (the audit's reference implementation). Two gates on the trailing
   ledger: symmetric ±1×ATR30m skill (pass = ≥55% AND day-clustered bootstrap CI excluding
   50%) and random-entry Monte Carlo (≥200 geometry-matched random books; pass = actual >
   95th percentile). Standard battery exported for reuse: `wilson`, `fisherExact`, `bhFDR`,
   `bootDayCI` (B=10k, day-clustered), `lag1AutocorrESS`, `brierECE`, `walkForwardWindows`,
   plus the honest fee-charged ladder walk. Data: Binance public REST + a trades-file path
   given by `--trades` (never mutated). `--dry-run` skips Discord; `--record` (cron only)
   feeds the trip logic.
2. **Trip contract (with the autotrade layer):** two consecutive `--record` runs failing ⇒
   write `.autotrade-disabled.json` at repo root (`{trippedAt, reason, runs[]}`) + red alert
   to `BLOFIN_RECON_WEBHOOK`. Autotrade skips entries while the file exists. The harness
   never deletes it — re-enable is a manual operator action. Consecutive-fail state lives in
   `.falsification-state.json` (last 12 runs).
3. `scripts/cron/ace.crontab` — Monday 08:30 UTC, `--days 90 --record`, before the 09:00
   weekly report so the report reads fresh gate state. No CDP dependency.
4. `scripts/weekly-report.js` — MEASUREMENT HONESTY section (spec 09.2): net-of-fee R,
   exchange cumulative net, fee totals in R and USD, paired ledger↔exchange mean |Δ|,
   falsification gate status. All read the spec-03/04 fields (`fillPrice/grossR/feeR`,
   `exchangeNetR/exchangeFeeUsd`) defensively — every figure renders **n/a** until the ledger
   rewrite lands. Every number labeled in-sample; legacy-accounting caveat on both embeds;
   `--dry-run` added. No tier probabilities anywhere.
5. `rebuild/research-log.md` seeded with both audits' already-run tests — 53 hypothesis
   cells to date, so future BH-FDR corrections start from the honest count.

**Self-test (acceptance gate)** — run against a scratch copy of the 801-signal book with
fresh klines: skill 47.4% [43.9, 50.9] vs audit 47.8 [44.3, 51.3] (Δ=3 trades of 768 —
ATR bar-inclusion convention; audit's ephemeral A4 code no longer exists; forming-bar ATR
variant gives 47.9%); clustered mean-R [−0.171, +0.065] vs [−0.17, +0.08]; claimed total
964.7R exact; MC (200 books) median 1081R, actual at 1st percentile (audit: median 1032 of
30 books, 0th pctile); ladder net −348.5R / fees 359.1R / mean 0.472R/trade / clustered
−0.458 [−0.695, −0.224] — all exact vs audit; Brier 0.2122 / ECE 12.0pp exact. Verdicts
identical: both gates FAIL on the historical book, as the audit proved they must.

**Schema handling** — legacy ledger (today) triggers a loud stderr warning and uses the
audit's conventions (fire-time reference price). Once spec 03 lands, the skill test
automatically prefers `fillPrice` @ `confirmedAt` and the ledger totals become net-of-fee.
Expect the recorded gate numbers to shift when that happens; that is the correction landing,
not a regression.

**Known follow-ups**

- `.falsification-state.json` and `.autotrade-disabled.json` need `.gitignore` entries
  (file untouched here — not in this change's ownership).
- The MC scores random books with the canonical accounting while a corrected ledger will
  report net R — after spec 03, actual-vs-random is conservatively biased (actual carries
  fees, random books don't). Acceptable for a tripwire; revisit if the gate should ever
  pass on net numbers.
- On the current signal the weekly gate WILL fail and WILL trip autotrade off after two
  recorded runs. That is the designed behavior per spec 09.1 — the signal has no measured
  edge (audit D2).
