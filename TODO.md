# Weathermen — TODO

Outstanding tasks grouped by priority. Check README.md for phase status and design context.

---

## Active / High Priority

### Phase A completion
- [ ] Reach 20+ resolved shadow YES+range trades under the dual filter (`sigmaF < 0.75°F AND |biasCorrection| < 2.0°F`) — currently tracking silently. Run `!performance` → 🔬 section to see progress.
- [ ] Reach 20+ resolved shadow YES+above trades under the dual filter (`sigmaF < 1.5°F AND biasCorrF > -2.0°F`) — same shadow pipeline. 78% WR on n=9 historical; validate before activating.
- [ ] Validate bias corrections have converged: run `!report` to recalibrate, then check `bias-corrections.json` — Houston and Dallas are missing (fewer than 5 resolved trades each).
- [ ] Consider blocking Jeddah (~14% WR) and Milan (~27% WR) once sample size crosses 10 trades each — add to `BLOCKED_CITIES` in `market-scan.js` with documented reason.

### Calibration
- [ ] Run `!report` to refresh `bias-corrections.json` — corrections were built on 348 trades; now 554+ resolved. Houston/Dallas have no entry yet.
- [ ] Monitor high-bias cities post-correction for 2–3 weeks: Miami (+5.72°F corr), Munich (+5.25°F), Warsaw (+4.85°F), Istanbul (blocked), Taipei (+3.13°F).

---

## Medium Priority

### Shadow filter activation (future)
- [ ] **YES+range**: when shadow resolved count reaches ~20, check `!performance` 🔬 section. If WR ≥ 55%: replace the hard block in `market-scan.js` with `if (sigmaF < 0.75 && Math.abs(biasCorrF) < 2.0)` gate.
- [ ] **YES+above**: same process. If WR ≥ 60% at n≥20: replace block with `if (sigmaF < 1.5 && biasCorrF > -2.0)` gate. Historical data shows 78% WR on n=9 — promising but needs validation.
- [ ] Add `sigmaF` and `biasCorrF` fields to the Discord signal card so they're visible at signal time.

### Stage 2 deep analysis (Sonnet)
- [ ] Currently gated behind `WEATHER_DEEP_ANALYSIS=false`. Enable only after Phase B activation and when API credits support it.
- [ ] Validate Stage 1 (Haiku) confidence calibration first — check `!performance` Embed B confidence buckets. If >0.85 confidence bucket WR ≥ 60% with n≥20, Stage 1 alone may be sufficient.

### Settlement accuracy
- [ ] Cross-check GHCN-Daily station IDs in `city-profiles.js` against Polymarket's stated settlement source for each city. Discrepancies are the #1 source of "model win, Polymarket loss" edge leakage.
- [ ] Add `--id <id>` dry-run output comparison: settle.js already supports `--id` flag. Use it on past trades to verify settlement values match Polymarket's recorded outcomes.

---

## Low Priority / Future

- [ ] `exit-monitor.js` — currently runs inside `market-scan.js` per cycle. Consider moving to a standalone Task Scheduler entry (every 5 min) for faster early-exit detection on live positions.
- [ ] Weekly war report — add a `weekly-war-report.js` that covers the coming week's forecast landscape: which cities have highest model uncertainty, which markets are already open with thin liquidity.
- [ ] Backtesting harness — replay `weather-trades.json` against different edge thresholds, Kelly fractions, and city blocklists without running live scans. Useful before Phase B tuning.

---

## Known Issues

| Issue | Impact | Status |
|---|---|---|
| Bias corrections don't exist for cities with <5 resolved trades | Probability calc uses uncorrected mean for these cities | Resolves naturally as sample grows |
| `sigmaF` not displayed in signal Discord cards | Can't eyeball model confidence at signal time | Low priority — add to card in next signal card revision |
| Shadow trades show as "open" in `!trades` before settling | Cosmetic — they're correctly filtered from stats | Fixed: `!t.shadow` guard added to `handleTrades()` |
| Stage 2 (Sonnet) disabled | Some complex setups get Haiku-only analysis | By design — cost control; revisit at Phase B |
| `weekly-report.js` bias recalibration requires 5+ trades per city | Houston/Dallas corrections absent | Resolves naturally |
