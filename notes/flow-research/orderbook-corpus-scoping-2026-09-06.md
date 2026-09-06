# Order-book corpus — reliability fix and Phase B scoping

**Date:** 2026-09-06 · **Status:** Phase A shipped; Phase B is scoping only, **no verdict**
**Pre-registration:** `notes/flow-research/orderbook-scoping-2026-09-06/PREREG.md` — written before any
forward return was joined to any feature.
**Scripts:** `notes/flow-research/orderbook-scoping-2026-09-06/{fetch,engine,diagnose}.js`
**Phase A commit:** `d07a81f`

---

## Part 1 — Phase A: the reliability fix

### The premise was wrong, and the real failure is worse

The brief described the outage as "looked running in `pm2 status` while silently producing nothing
for 12 days" — implying detection was the gap. **It was not.** `logs/watchdog.log` records the
opposite:

| | |
|---|---|
| Last row written | 2026-08-14T04:01Z |
| Watchdog strike 1 | 04:20Z — **19 minutes later** |
| Alert posted to `#blofin-recon` | 04:25Z — **24 minutes later** |
| Alerts posted 08-14 → 08-26 | **144**, one every 2h |
| Alerts that failed to send | **6** (`getaddrinfo ENOTFOUND discord.com`) |
| Alerts that reached Discord | **~138** |
| Result | **nothing changed for 12 days** |

`checkBookRecorder` was added in `4e955d9` on the day the recorder started and worked correctly on the
first attempt. The freshness check the brief asked for **already existed, already fired, and was
already ignored.** Adding a second detector would have produced a 145th unread alert.

The outage also ran longer than described: the recorder wrote nothing from 2026-08-14 until the manual
restart on 2026-09-06 — **23 days**, not 12. `~33,600` minutes of unbackfillable corpus.

### What was actually missing: remediation

`checkDocker` has self-healed since day one (`open -g -a Docker`). `checkBookRecorder` had a sentence
of advice inside a Discord embed. One `pm2 restart book-recorder` is what eventually fixed it.

**All changes in `scripts/ops/watchdog.js`** (data-collection only — no signal, trigger, or execution
path touched):

| What | Where | Why |
|---|---|---|
| **Bounded self-heal** — `pm2 restart book-recorder`, 3 per 6h, ledger in `.watchdog-state.json.bookRestarts` | `healBookRecorder`, **:419** | Fires at strike **1**, before the alert waits for strike 2. Past the cap it stops restarting and escalates to "needs hands", so a recorder broken for a reason restarting cannot fix is not hammered. Ledger is persisted *immediately* on each attempt so a later throw cannot reset the cap into a restart loop. |
| **`PM2_BIN` explicit resolution** | **:76** | pm2 is **not on the cron PATH** (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`) — it lives under nvm. `execFileSync('pm2', …)` from cron would `ENOENT` and make the whole self-heal a silent no-op: the identical failure class this check exists to end. Verified under a scrubbed cron env. |
| **Content health** — 10 consecutive `samples=0`/`gap` rows | `evaluateBookRecorder`, **:380** | A minute row is written by *any* inbound frame, so the market-wide liquidation feed alone (~25 msg/min) keeps rows flowing with the depth and tick feeds dead. Freshness reads that as perfectly healthy. Threshold set from the corpus itself: 24 scattered empty rows and 393 gap rows exist, so short runs must stay green. |
| **File-vs-state cross-check** | **:396** | `writeRow()` appends to the day file *then* rewrites state. A state file advancing while the newest `.ndjson` mtime does not means rows are not reaching disk. |

`test/watchdog-book.test.js` — 10 tests on the pure evaluator, built from the incident's real numbers
(`25396 rows, 6716 reconnects`).

### Verification

- All four detection paths driven against the live corpus file: healthy → ok; 24-min-stale → stale;
  47-min file divergence → stale; all-empty tail → empty.
- **Self-heal proved end-to-end** by injecting the real 24-min-stale shape: restart issued, pm2
  `restart_time` 1→2, recorder reconnected both feeds, ledger recorded 1/3, **no alert at strike 1**.
- **Cap proved** by preloading 3 attempts: no restart issued (`restart_time` unchanged), message
  escalated to "needs hands".
- 55/55 tests pass across all 6 test files. Live watchdog run: all classes green.

### Not fixed, and worth knowing

Why the recorder cannot recover from its own reconnect loop. **6,716 reconnects** preceded the stall
and it never re-established a usable connection. The watchdog now papers over that from outside; the
loop itself is untouched and unexplained. Separately, every other watchdog class is detect-and-tell —
`zombieProcs` (158 hung crons, two weeks) and `discordBot` (23,772 errors, weeks) are the same story
as this one and are both `pm2`/`kill`-remediable.

---

## Part 2 — Data integrity of the 19 days

**26,383 rows across 21 day-files; 25,990 non-gap; 0 malformed lines; 0 missing minutes within the
recorded span.** Four structural defects found, all previously undocumented except the first.

### I1 — Liquidation columns are structurally empty before 2026-07-27T12:45Z ⚠️ affects analysis

Verified independently against the files, not taken from `refactors/2026-07-27-liq-stream-route-fix.md`.
The `liqAll*` keys are **absent** from 931 non-gap rows (all 165 rows of 07-26, plus 07-27 up to
12:45Z), and `liqN` on those rows is `0` — which reads as "no liquidations occurred" but means "the
feed was on the wrong route". The route fix is real and the boundary is sharp: first row carrying
`liqAllN` is **2026-07-27T12:45:00Z**.

> **Exclusion applied:** all liquidation analysis uses only `t ≥ 2026-07-27T12:45Z` → 25,003 of 26,326
> in-window rows. Anyone computing a mean liquidation rate over the full corpus gets a downward-biased
> estimate.

### I2 — `liqAllLong` / `liqAllShort` are dimensionally invalid ⚠️ research trap, new finding

These sum raw base quantity `q` across **every symbol** on `!forceOrder@arr` — BTC contracts added to
SHIB contracts. The largest row reads `liqAllLong = 2,174,672,579` "units" against only `$70,860` of
notional across 49 events, implying an average price near `$0.00003`: the column is dominated by
micro-priced altcoins and means nothing.

> `liqAllNotional` (USD) is the only usable market-wide aggregate. `liqLong`/`liqShort` (BTC-only,
> filtered to `SYMBOL`) are correct and in BTC. **Recommend deleting `liqAllLong`/`liqAllShort` from
> the recorder** rather than leaving a trap in the schema.

### I3 — 718 rows (2.8%) exceed the physical sample cap

`@depth20@100ms` can deliver at most ~600 messages/minute. 718 rows report more, up to **1,556** (2.6×).
The message handler closes over a module-global `bucket`, so during a reconnect the old socket keeps
writing into the same bucket as the new one until it finishes closing — **both sockets double-count**.
Concentrated on high-reconnect days (07-29: 104, 08-03: 64) and absent on calm ones (08-08 → 08-10: 0),
so the artefact is **correlated with volatility**, which is exactly when it would bias a result.

> Effect on the headline cell is negligible (D3: k=5 mean `+0.65bp` → `+0.67bp` excluding them), but
> `samples` cannot be trusted as a data-quality weight, and `obi*sd` is understated on those rows.

### I4 — One duplicate minute

`2026-07-27T12:45:00Z` appears twice in the same file — the SIGTERM flush of the pre-route-fix process
plus the first row of its replacement. Exactly the minute the schema changes. Deduplicated by keeping
the richer row.

### Clean

Zero malformed lines. Zero missing minutes inside the recorded span. `mark`/`funding`/`basisBps` never
null. `markAge` p50 14s / p99 31s (max 1,037s on a handful of rows). Depth, spread, and imbalance
columns are never all-zero or all-null. **The `liqSeen`/`liqAllSeen` liveness counters did their job** —
they are the reason I1 is detectable at all.

---

## Part 3 — Phase B: pre-registered hypotheses and descriptive statistics

> ### ⛔ NOT A VERDICT — READ THIS FIRST
> Everything below is **descriptive**. No p-value, no confidence interval, no FDR correction, no
> walk-forward, and no significance is claimed anywhere. The sample is **19 days in one regime** with
> overlapping horizons. This project has been burned twice this session by small-n results
> (`order-flow-academic-backtest-2026-09-06.md` §3.5, n=17 in one regime). The purpose here is to fix
> the hypotheses **now**, while the data is too thin to tempt anyone, so Phase C is confirmatory
> rather than a search.

### The regime, stated before any conditional number

| | Corpus window (07-26 → 08-14) | Since (08-14 → 09-06) |
|---|---|---|
| BTC | 64,671 → 63,256 (**−2.19%**) | 63,256 → **79,797** (**+26%**) |
| Range | 62,229 – 65,723 (5.6%) | 62,484 – 82,283 (32%) |
| Annualized realized vol | **27.5%** | **45.2%** |

**The corpus is a narrow, low-volatility range** — the regime that maximally flatters mean-reversion
and maximally suppresses continuation. Every reversion result below must be read against that. The
market has since moved somewhere completely different, which is good news for Phase C's regime
diversity and is the strongest single argument against acting on anything here.

### Method

Row `t=T` aggregates `[T, T+60s)`, so its features are known at `T+60s` = the close of kline `T`.
Forward returns run close(`T`) → close(`T+k`). No feature can see a price used in its own outcome.
Thresholds are trailing causal percentiles over the prior 1,440 minutes; the first 1,440 minutes are
warm-up. 1m klines from Binance (`fetchKlines`): 60,084 bars, **0 gaps, 0 duplicates**. The fast
sliding-window percentile path was verified against a naive implementation — 1,088 probes, 0 mismatches.
Cost reference carried from the prior study: **14bp round trip**.

---

### H-B1 — Resting depth imbalance → short-horizon direction

**Grounding.** Cartea, Jaimungal & Penalva (2015); Lipton, Pesavento & Sotiropoulos (2013);
Stoikov (2018) micro-price. Bid-heavy books drift up over very short horizons.
**Rule.** `obi5 ≥ P80` → long, `≤ P20` → short (continuation), trailing-1440.
**Requires the corpus:** resting depth does not exist in trade prints.

| feature | k | n | hit% | long-hit% | mean | drift | **excess** |
|---|---|---|---|---|---|---|---|
| obi5 | 1 | 9,935 | 49.66 | 46.60 | +0.1bp | +0.0bp | **+0.1bp** |
| obi5 | 5 | 9,935 | 50.68 | 48.01 | +0.1bp | +0.0bp | **+0.1bp** |
| obi5 | 15 | 9,935 | 49.83 | 47.92 | +0.2bp | +0.1bp | **+0.1bp** |
| obi5 | 30 | 9,935 | 49.38 | 48.69 | +0.2bp | −0.1bp | **+0.3bp** |

`obi1`, `obi20`, `obiTouch` are materially identical (excess −0.1 to +0.1bp at every k). Against a
14bp hurdle these are zero.

**But the null is ambiguous, and the diagnostic says why.** Correlation of each feature with the
**same** minute's return versus **forward** minutes:

| feature | same minute | k=1 | k=5 | k=15 | k=30 |
|---|---|---|---|---|---|
| obi5 | **+0.32** | +0.02 | +0.01 | +0.00 | +0.00 |
| obiTouch | **+0.48** | +0.02 | +0.01 | +0.00 | +0.00 |
| signed flow *(reference)* | **+0.52** | −0.02 | −0.01 | −0.00 | −0.02 |

Depth imbalance carries **substantial contemporaneous association** (r≈0.32–0.48, 10–23% of same-minute
return variance) and **none whatsoever forward**. Two readings are equally consistent with this, and
**this corpus cannot separate them**:

1. the effect is real but decays inside the 1-minute bucket (the literature's OBI horizon is
   ticks-to-seconds, not minutes); or
2. the association is mechanically simultaneous — price rose, asks were consumed, the book *became*
   bid-heavy — with no lead at all.

> **⛔ NOT A VERDICT.** H-B1 is **not refuted**; it is **untestable at this sampling**. Revisiting it
> at 60 or 90 days will not help, because more days of 1-minute aggregation cannot recover a
> sub-minute effect. **Phase C prerequisite: a recorder change**, emitting sub-minute (1–5s) OBI /
> forward-return pairs. Until that ships, H-B1 stays open and unmeasured.

**Also pre-registered and confirmed:** this is **not** Cont, Kukanov & Stoikov (2014). CKS's Order
Flow Imbalance is built from per-update *increments* at the touch (`e_n = ΔV_bid − ΔV_ask`); the corpus
stores the per-minute mean *level*, from which OFI cannot be reconstructed at any aggregation. Testing
CKS needs the same recorder change.

**Redundancy found — matters for Phase C's FDR family.** `mpDev` is not an independent feature:
algebraically `micro − mid ≡ obi1 × spread/2`, confirmed empirically at
**corr = 0.9909** (n=25,910). Measured collinearity: `corr(obi1,obi5)=0.986`, `corr(obi5,obi20)=0.951`,
`corr(obi5,obiTouch)=0.841`. The five "separate" imbalance features are **roughly one and a half
independent tests**, and must be entered into Phase C's multiplicity correction as such rather than as
five.

---

### H-B2 — Price impact scales inversely with measured depth (Kyle λ)

**Grounding.** Kyle (1985): λ = price move per unit signed flow = inverse depth. Amihud (2002) uses
volume as a depth proxy *because* real depth is normally unobservable.
**Rule.** Signed flow `F = 2·tbuy − tvol` (exact aggressor, not tick-rule). Depth `D = dBid + dAsk`.
Terciles of `D`; λ = OLS slope through origin of same-minute return on `F`.

| tercile | n | median depth | **λ (bp per BTC of signed flow)** | mean \|flow\| |
|---|---|---|---|---|
| thin | 7,978 | 20.2 BTC | **4.714e-2** | 17.6 |
| mid | 7,954 | 26.0 BTC | 3.872e-2 | 24.7 |
| thick | 8,538 | 34.6 BTC | **2.550e-2** | 33.4 |

**λ falls monotonically as measured depth rises.** λ_thin/λ_thick = **1.85×** against a depth ratio of
**1.71×** — i.e. λ ≈ 1/D almost exactly, which is Kyle's prediction in its original form, measured with
real depth rather than a volume proxy. The prior study's H1 could not do this: its depth proxy was λ's
own denominator, which made the trigger near-empty by construction (n=46, 0.08% — its §3.1).

**H-B2b — reversion.** mean(sign(flow) × forward return) by tercile:

| tercile | k=1 | k=5 | k=15 | k=30 |
|---|---|---|---|---|
| thin | +0.0 | +0.0 | **−0.1** | **−0.1** |
| mid | +0.1 | −0.0 | −0.1 | −0.0 |
| thick | +0.1 | +0.1 | **+0.3** | **+0.2** |

The *sign pattern* is as hypothesised — thin-book impact reverts, thick-book impact persists — but the
magnitudes are 0.1–0.3bp, roughly **1/50th of the cost hurdle**.

> **⛔ NOT A VERDICT.** The λ∝1/D result is a **structural measurement**, not a tradeable edge, and it
> is the strongest positive control the dataset has: it says the depth columns are economically real
> and behave as theory demands. The *reversion* half is directionally as-hypothesised and
> economically nil. **Revisit at ≥60 days spanning ≥2 regimes** — the open question is whether the
> depth–λ relation is stable across volatility regimes (window vol was 27.5%; it is 45.2% now), not
> whether it exists.

---

### H-B3 — Liquidation cascades: continuation or reversion

**Grounding.** Brunnermeier & Pedersen (2009), liquidity spirals: forced deleveraging is
price-insensitive supply that both moves price and creates reversal pressure once exhausted.
**Rule.** `liqNotional ≥ P95` trailing-1440. `L = liqShort − liqLong` (sign convention verified against
the recorder: `o.S==='SELL'` is a long being liquidated). Both arms reported, neither privileged.
**Requires the corpus:** trade prints do not identify forced orders, and Binance serves no
`forceOrder` history — this feed exists only going forward.

| arm | k | n | hit% | long-hit% | mean | drift | **excess** | net@14bp |
|---|---|---|---|---|---|---|---|---|
| continuation | 5 | 1,267 | 43.96 | 47.43 | −0.6bp | −0.5bp | −0.1bp | −14.6bp |
| continuation | 30 | 1,267 | 46.09 | 44.75 | −0.7bp | −3.3bp | +2.6bp | −14.7bp |
| **reversion** | 1 | 1,267 | 52.41 | 46.49 | +0.2bp | −0.3bp | +0.5bp | −13.8bp |
| **reversion** | **5** | 1,267 | **55.56** | 47.43 | +0.6bp | −0.5bp | +1.2bp | −13.4bp |
| **reversion** | 15 | 1,267 | 54.93 | 47.12 | +0.4bp | −1.9bp | +2.3bp | −13.6bp |
| **reversion** | **30** | 1,267 | 53.67 | 44.75 | +0.7bp | −3.3bp | **+4.0bp** | −13.3bp |

This is the most interesting-looking cell in the study — and it is **precisely the trap the prior
study identified in its §3.6**. The decomposition:

| k | hit% | avg win | avg loss | **expectancy** | net@14bp |
|---|---|---|---|---|---|
| 1 | 52.41 | +4.13bp | −4.17bp | **+0.18bp** | −13.82bp |
| **5** | **55.56** | +8.06bp | **−8.62bp** | **+0.65bp** | −13.35bp |
| 15 | 54.93 | +12.90bp | −14.79bp | **+0.42bp** | −13.58bp |
| 30 | 53.67 | +17.87bp | −19.19bp | **+0.70bp** | −13.30bp |

**A 55.56% hit rate produces +0.65bp of expectancy**, because the wins are smaller than the losses at
every horizon. This is the same finding the prior study called the one it would most want carried
forward — reproduced here independently on order-book data.

Two further caveats specific to this arm:
- **The excess is mostly "don't be long", not "be right".** Always-long on these same minutes returns
  −0.34/−0.53/−1.92/−3.26bp with a 44.75% up-share at k=30. The +4.0bp excess at k=30 is dominated by
  that −3.26bp drift.
- **The regime is maximally favourable.** A reversion signal measured in a −2.19%, 27.5%-vol range is
  measured in the one environment that flatters it most.

Strengths worth recording, because they are unusual here: triggers are **well distributed** — 1,267
minutes across **all 19 days**, busiest day only 8.4% of triggers (contrast the prior study's H5:
n=17 across 10 days, 8 consecutive). Forced flow is **balanced** — 53.0% long-liquidations, so this is
not purely "buy the dip". And it is **robust to the I3 artefact** (k=5: +0.65 → +0.67bp excluding
`samples>600` rows). Corpus context: 17.9% of valid minutes carry ≥1 BTC liquidation; median
`liqNotional` when active is only **$3,666** (max $8.48M).

> **⛔ NOT A VERDICT.** This is the one lead worth carrying to Phase C, and it currently **loses 13.3bp
> per round trip**. For it to become interesting, expectancy must rise above 14bp — a **20×** change,
> not a rounding error — so the realistic path is not this rule but a variant with a far more selective
> trigger and an exit that fixes the win/loss asymmetry. **Revisit at ≥60 days spanning ≥2 regimes**
> (n is not the binding constraint at ~67 triggers/day; regime diversity is). The full family
> — both arms × 4 horizons — must enter one BH-FDR correction with every other hypothesis here.

---

### H-B4 — Block prints (≥5 BTC): permanent vs temporary impact

**Grounding.** Holthausen, Leftwich & Mayers (1987); Keim & Madhavan (1996) — block impact decomposes
into a permanent (information) and a temporary (liquidity) component.
**Rule.** `B = tbigBuy − tbigSell`, trigger `|B| ≥ P90` trailing-1440. Both arms reported.
**Requires the corpus:** the prior study had per-bar aggregate taker-buy volume, so one 5 BTC print and
a hundred 0.05 BTC prints were identical to it.

| arm | k | n | hit% | long-hit% | mean | drift | excess | net@14bp |
|---|---|---|---|---|---|---|---|---|
| permanent | 5 | 2,438 | 48.03 | 48.28 | −0.2bp | −0.0bp | −0.2bp | −14.2bp |
| permanent | 30 | 2,438 | 49.14 | 47.01 | +0.2bp | −1.4bp | +1.6bp | −13.8bp |
| reversion | 5 | 2,438 | 51.72 | 48.28 | +0.2bp | −0.0bp | +0.2bp | −13.8bp |
| reversion | 15 | 2,438 | 52.05 | 48.44 | +0.1bp | −0.5bp | +0.6bp | −13.9bp |

Neither arm shows anything. Corpus context: **83.6% of minutes contain no block print at all**, median
block share of volume 0.0%, p90 8.5% — so the ≥5 BTC threshold is selective, and the P90-of-|B| trigger
is effectively selecting "a block happened".

> **⛔ NOT A VERDICT.** Flat at every horizon in both directions, on n=2,438 in one regime.
> **Revisit at ≥60 days spanning ≥2 regimes.** Worth reconsidering the 5 BTC threshold at that point —
> at current prices 5 BTC ≈ $400k, and whether that is the right "block" cut for this venue has never
> been measured, only assumed.

---

### VPIN — closed for this corpus, per pre-registration

The pre-registered question was narrow: **does this corpus permit a materially better VPIN
construction** than the one that failed its own positive control in the prior study?

| | prior study | this corpus |
|---|---|---|
| Aggressor classification | Bulk Volume Classification (inferred) | **true side** from the `@trade` maker flag |
| Bucketing | 50 volume buckets/day | 46.8/day, **quantized to whole minutes** |
| `corr(\|imbalance ratio\|, volume)` | **−0.44** (the diagnosed pathology) | **−0.037** |
| **Positive control:** fwd-vol ratio, high-VPIN vs rest | 0.85 / 0.93 | **0.876** |

**The specific pathology the prior study diagnosed is gone** — exact aggressor side removed the
−0.44 anti-correlation between imbalance ratio and volume almost entirely (−0.037). **And the positive
control still fails:** high VPIN predicts *lower* forward 60-min realized volatility (3.67 vs
4.19 bp/min, ratio **0.876**, `corr(VPIN, fwd vol) = −0.127`), the opposite of the documented
signature.

So the classification fix was not the binding problem. The most likely remaining culprit is the
50-bucket smoothing window (≈1.07 days here), which makes VPIN too slow to track 60-minute-ahead
volatility.

> **⛔ Per pre-registration, VPIN is CLOSED for this corpus at this aggregation and no directional
> VPIN result is reported.** Reopening it requires a *different construction* whose positive control
> passes first — not more days of the same one. This is the third independent construction to fail the
> same control; the honest reading is that VPIN as defined does not transfer to 1-minute crypto perp
> data, and a fourth attempt needs a reason beyond "try again".

---

## Summary — what Phase C inherits

| # | Hypothesis | Phase B status | Gate to test it |
|---|---|---|---|
| **H-B1** | Depth imbalance → direction | **Untestable at this sampling.** Contemporaneous r≈0.32–0.48, forward r≈0.00. Not refuted. | **Recorder change** — sub-minute (1–5s) OBI/return pairs. Days do not help. |
| **H-B1′** | CKS (2014) Order Flow Imbalance | **Not computable** from stored fields (levels, not increments). | Same recorder change: accumulate signed touch-size deltas. |
| **H-B2a** | λ ∝ 1/measured depth | **Holds structurally** — 1.85× λ ratio vs 1.71× depth ratio. A dataset positive control, not an edge. | ≥60 days, ≥2 regimes — is it stable across vol regimes? |
| **H-B2b** | Thin-book impact reverts | Sign as hypothesised, magnitude ~1/50th of costs. | ≥60 days, ≥2 regimes. |
| **H-B3** | Liquidation cascade reversion | **The one live lead.** 55.6% hit at k=5 — and **+0.65bp expectancy, −13.4bp net.** Well distributed, robust to artefacts, measured in the regime that flatters it most. | ≥60 days, ≥2 regimes. Needs a 20× expectancy change, i.e. a different trigger/exit, not this rule. |
| **H-B4** | Block-print impact | Flat both directions, n=2,438. | ≥60 days, ≥2 regimes; revisit the 5 BTC threshold. |
| **VPIN** | Flow toxicity | **Closed** — positive control fails a third time (0.876). | A new construction that passes the control *first*. |

**Timeline.** Recording resumed 2026-09-06 at ~$79.8k with 45.2% realized vol, against the corpus
window's ~$63k and 27.5% — a genuinely different regime, which is what Phase C needs. 60 new days
lands around **2026-11-05**; 90 days around **2026-12-05**. Phase A's self-heal is what makes that
timeline credible: the previous attempt lost 23 of its first 42 days.

**Recommended recorder changes before Phase C** (none are signal-path changes):
1. **Sub-minute OBI/return pairs** — without this, H-B1 and CKS OFI stay unmeasured no matter how many
   days accumulate. This is the highest-value change on the list.
2. **Drop `liqAllLong`/`liqAllShort`** (I2) — dimensionally invalid, and a trap left in the schema.
3. **Bind the message handler to a per-feed bucket** (I3) — stops reconnect double-counting and makes
   `samples` trustworthy as a quality weight.

**Standing caution.** Nothing in Part 3 may influence a live rule. The one cell that looks like a
signal — 55.6% at k=5 — is the same shape as the prior study's most-cited finding: a high hit rate with
wins smaller than losses is a negative-expectancy strategy before a single basis point of fees.
