# MongoDB Migration — Architecture & Refactor Plan

**Date:** 2026-05-09
**Scope:** feat/mongodb-docker branch update + Phases 2–5 + weathermen guard + data analysis enhancements

---

## ✅ Completion Status

| Phase | Status | Commit |
|---|---|---|
| 0 — Docker + db.js skeleton | ✅ Complete | pre-existing |
| 1 — Migration scripts, indexes, BTC factors, poly TTL, EW collection | ✅ Complete | `65e3be9` |
| 2 — Weekly reports read from Mongo, hourly sync cron | ✅ Complete | `f24ceb9` |
| 3 — Trigger scripts write to Mongo | ⏳ Pending entry criteria check |
| 4 — Containerize Discord bot + news-watch | ⏳ Pending Phase 3 |
| 5 — Remove JSON dual-writes, archive flat files | ⏳ Pending Phase 4 |

**Merged to main:** 2026-05-09. Branch `feat/mongodb-docker` deleted.

---

## Step 1: Confirm the Claim

**Claim:** "The flat files are getting too big and analyzing them is becoming costly."

Measured file state as of 2026-05-09:

| File | Size | Records | Growth rate |
|---|---|---|---|
| `trades.json` | 667 KB | 396 BTC signals | ~13/day (signal rate ~1.3/hr) |
| `bz-trades.json` | 24 KB | 42 BZ signals | Slow — session-gated |
| `poly-btc-5-trades.json` | 666 KB | 1,261 bar evals | ~288 bars/day = ~152 KB/day |
| `ew-forecasts.json` | 80 KB | 22 EW forecasts | 6/day × 22KB avg ≈ slow |

**Finding:** The poly-btc-5 file is the acute problem. It logs every 5-min bar regardless of signal, with only 12.1% of records ever signaling. At ~152KB/day it doubles in size every ~4 days. `trades.json` grows more slowly but the weekly report reads the entire 667KB file every Monday to extract last 7 days.

The cost is not disk — it's O(n) full-file reads every analysis cycle. MongoDB with a compound index on `{instrument, firedAt}` makes a 7-day query O(log n) regardless of total history size.

**Claim confirmed.** Evidence is in the numbers, not the gut feeling.

---

## Step 2: Understand the Original Intent

The MongoDB migration was designed from the start with a specific layered approach:

- **Phase 0–1** (done): Docker + db.js + migrate scripts + initial data import. Already on `main`.
- **Phases 2–5** (not started): Switch cron scripts one by one; containerize bot and news-watch; remove JSON dual-writes.

The `scripts/ew/storage.js` comment explicitly states the EW schema is "locked to be identical to the future Mongo `wave_forecasts` collection so the migrator is mechanical." This shows the migration was designed holistically, not as an afterthought.

---

## Step 3: Can the Code Work As Wired?

**Yes.** What already exists on `main`:
- `scripts/lib/db.js` — CJS module, connects to `127.0.0.1:27017`, exposes 5 collection accessors
- `scripts/migrate/` — `create-indexes.js`, `import-state.js`, `import-trades.js` (BTC + BZ only)
- `docker-compose.yml` — MongoDB 7.0 with named volume

**Gaps in the current migration:**
1. `poly-btc-5-trades.json` is NOT imported — no collection accessor, no index, no normalizer
2. `ew-forecasts.json` is NOT imported — EW storage.js says it should go to `wave_forecasts` collection but db.js has no accessor for it
3. BTC `criteria` array stored as label strings — not queryable by factor name without `$filter + $map` pipelines

---

## Step 4: What Gap Does This Fill?

### Gap 1 — Weekly report query cost
`weekly-report.js` reads all 667KB of `trades.json` to compute 7-day stats. With MongoDB: one indexed query. Same for poly weekly report and BZ weekly report. The cost is real and compounds as history grows.

### Gap 2 — Factor correlation analysis
The BTC criteria are stored as `[{label: "CVD +5 (bullish)", pass: true}]` — human-readable strings, not structured flags. The weekly report identifies `pass: true` records by matching substring patterns against the label field. To answer "what is the win rate when CVD passes?" you parse a string. This is fragile (label format changes break it) and cannot be aggregated efficiently in MongoDB.

### Gap 3 — Poly bar record growth
87% of poly bar records will never be signaled and are only needed for outcome tracking of the prior bar (one-cycle lookback). After `outcome` is determined, unsignaled records serve no analytical purpose. Storing them forever is accumulating noise.

---

## Step 5: Correct Home for Each Concern

| Concern | Correct home |
|---|---|
| BTC/BZ trades | `trades` collection (instrument field discriminates) |
| Poly BTC-5 bar evals | `trades` collection, `instrument: 'POLY-BTC-5'`, TTL on non-signaled after outcome determined |
| EW forecasts | Separate `wave_forecasts` collection (complex nested schema, different lifecycle) |
| Weathermen trades | `trades` collection, `instrument: 'WEATHERMEN'`, added before branch merges |
| BTC factor verdicts | Add normalized `factors: {}` field alongside existing `criteria` array |

---

## Step 6: Risk Assessment

| Phase | Risk | Mitigation |
|---|---|---|
| Branch rebase | Zero — mongo branch HEAD is main's ancestor | `git checkout -B feat/mongodb-docker main` (no conflicts) |
| Add missing imports | Zero — additive only, doesn't change existing collections | Run on dev before prod |
| Weekly reports → Mongo reads | Low — reports are read-only, failure just posts nothing | Keep JSON reads as fallback during transition |
| Trigger scripts → Mongo writes | Medium — state corruption on write failure | Atomic writes via session/transaction; keep JSON as fallback for 2-week window |
| Remove JSON dual-writes | Low — final cleanup after Mongo is proven stable | Do last |

---

## The Plan

### Immediate: Fix the Branch

`feat/mongodb-docker` HEAD is the merge-base with main (both point to `68976058`). The branch has no unique commits — Phase 0–1 was already merged to main. The branch is a stale pointer.

**Action:** Reset the branch to main, then all subsequent work goes on the branch:

```bash
git checkout feat/mongodb-docker
git reset --hard main
```

This costs nothing. The branch becomes current with all 28 mainline improvements.

---

### Phase 2A: Extend the Migration (Foundation)

These are additive changes to existing files. No behavioral change to any cron script.

**`scripts/lib/db.js`** — add two collection accessors:
```js
const polyTrades    = () => _db.collection('trades');    // same collection, filtered by instrument
const waveForecasts = () => _db.collection('wave_forecasts');
module.exports = { ..., waveForecasts };
```
Note: poly trades reuse the `trades` collection with `instrument: 'POLY-BTC-5'` — no separate collection needed. EW forecasts get their own collection because the schema is structurally incompatible (nested timeframes object vs flat signal document).

**`scripts/migrate/create-indexes.js`** — add:
```js
// trades — time-series compound index (used by weekly reports and backtest queries)
await trades().createIndex({ instrument: 1, firedAt: -1 });
await trades().createIndex({ instrument: 1, 'outcome': 1, firedAt: -1 });

// poly-btc-5 — TTL on non-signaled records after outcome is set
// expiresAt is set by trigger-check.js when outcome is written for non-signaled bars
await trades().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

// wave_forecasts
await waveForecasts().createIndex({ generatedAt: -1 });
await waveForecasts().createIndex({ 'timeframes.1D.primary.currentWave': 1 });
```

**`scripts/migrate/import-trades.js`** — add poly and EW importers:
```js
function normalizePoly(t) {
  return { ...t, instrument: 'POLY-BTC-5',
    barOpen: t.barOpen ? new Date(t.barOpen) : null,
    closedAt: t.closedAt ? new Date(t.closedAt) : null,
    // TTL: non-signaled records with known outcome expire after 7 days
    expiresAt: (!t.signaled && t.outcome) ? new Date(new Date(t.closedAt || t.barOpen).getTime() + 7*24*60*60*1000) : null,
  };
}
// In main():
await importFile('poly-btc-5-trades.json', normalizePoly, 'Poly BTC-5 bar evals');
await importFileToCollection('ew-forecasts.json', waveForecasts, normalizeEW, 'EW forecasts');
```

**Weathermen guard** — add before weathermen merges:
```js
function normalizeWeathermen(t) {
  return { ...t, instrument: 'WEATHERMEN',
    firedAt: t.firedAt ? new Date(t.firedAt) : null,
    closedAt: t.closedAt ? new Date(t.closedAt) : null,
    // factors field is already normalized in weathermen schema (YES/NO, range/above/below)
  };
}
await importFile('weathermen-trades.json', normalizeWeathermen, 'Weathermen trades');
```

This hook is added NOW, before the merge. When weathermen lands, the only additional work is verifying the normalizer matches the actual schema — the infrastructure is already there.

---

### Phase 2B: Structured Factors for BTC Trades (Evidence-based addition)

**Evidence:** `weekly-report.js` identifies which criteria passed by matching against label strings:
```js
const cvdPass = t.criteria?.find(c => c.label?.includes('CVD') && c.pass)
```
This cannot be aggregated in MongoDB without `$filter + $map` pipelines and string matching — it's O(n) over every document. As history grows and analytical questions get more complex ("win rate when CVD + VWAP both pass vs just CVD"), this becomes expensive.

**Fix:** When a BTC trade is written to MongoDB (in Phase 4, when trigger-check.js migrates), store:
```js
factors: {
  cvd: criteria.find(c => c.label.includes('CVD'))?.pass ?? null,
  vwap: criteria.find(c => c.label.includes('VWAP'))?.pass ?? null,
  sessionVP: criteria.find(c => c.label.includes('Session VP'))?.pass ?? null,
  oi: criteria.find(c => c.label.includes('OI'))?.pass ?? null,
  macd4h: criteria.find(c => c.label.includes('MACD'))?.pass ?? null,
  rsi12h: criteria.find(c => c.label.includes('RSI'))?.pass ?? null,
  weeklyTrend: criteria.find(c => c.label.includes('Weekly'))?.pass ?? null,
}
```
The `criteria` array is preserved unchanged — nothing breaks. `factors` is additive. Now factor correlation queries are:
```js
db.trades.aggregate([
  { $match: { instrument: 'BTC', firedAt: { $gte: cutoff } } },
  { $group: { _id: '$factors.cvd', wins: { $sum: { $cond: [{ $eq: ['$outcome', 'tp1'] }, 1, 0] } }, total: { $sum: 1 } } }
])
```
This is the query the weekly report already wants to run — it just can't run it efficiently against label strings.

Poly BTC-5 already stores a normalized `factors` object (`{cvdDir, cvdScore, vwapDir, structDir, cleanAir, goodSession}`) — no change needed there.

---

### Phase 3: Weekly Reports → MongoDB (Low Risk, High Value)

Migrate reads in weekly reports first. These are read-only, run on a schedule, and failure just means no Discord post — no data corruption possible.

**Order:**
1. `scripts/weekly-report.js` (BTC) — replace `fs.readFileSync(TRADES_FILE)` with `db.trades().find({instrument:'BTC', firedAt:{$gte:cutoff}}).toArray()`
2. `scripts/poly/btc-5/weekly-report.js` — same pattern, `instrument:'POLY-BTC-5'`, `signaled:true` filter
3. `scripts/bz/weekly-report.js`

During this phase: JSON files still exist and are still written by cron scripts. MongoDB is read-only for reports.

---

### Phase 4: Trigger Scripts → MongoDB (Medium Risk)

Migrate writes in order of complexity:

1. `scripts/poly/btc-5/trigger-check.js` — simplest state: `lastBarFired`, `prevCVD`, `prevOI`, `marketUrl`. State fits in a single `trigger_state` document. Trades write to `trades` collection.
2. `scripts/bz/trigger-check.js` — adds session-based cooldowns. State + cooldowns use existing `trigger_state` + `trigger_cooldowns` collections.
3. `scripts/bz/analyze.js` — writes BZ trades. Reads cooldowns from mongo.
4. `scripts/trigger-check.js` (BTC) — most complex: inline CDP code, OI history, pending confirmations, reclaim list, signal message IDs. Migrate last.

**Critical constraint:** CDP scripts (`trigger-check.js`, `bz/trigger-check.js`, `bz/analyze.js`) MUST remain native cron processes — Docker for Mac cannot reach TradingView Desktop on `localhost:9222`. They connect to MongoDB via `127.0.0.1:27017` (port-forwarded from Docker container). This constraint never changes.

**During phase 4:** Run a 2-week dual-write window — scripts write to both MongoDB and JSON files. After 2 weeks of error-free operation, remove JSON writes.

---

### Phase 5: Containerize Bot and News-Watch

After all state is in MongoDB:
- `discord-bot/index.js` → Docker service (reads state from MongoDB, no JSON dependency)
- `bz/news-watch.js` → Docker service (writes to `news_state` collection, removes pm2 dependency)
- Remove from crontab/pm2 respectively

---

## Weathermen Merge Strategy

The weathermen branch is in active development with no merge timeline. The protection strategy is:

**Before the merge:**
1. `normalizeWeathermen()` is added to `import-trades.js` NOW (this PR)
2. Schema is confirmed by reading `weathermen-trades.json` from the weathermen branch at merge time
3. Weathermen scripts use MongoDB for state and trades from day 1 of the merge — they do not add JSON file debt

**At merge time:**
1. Rebase weathermen onto main
2. Verify `normalizeWeathermen()` matches actual weathermen trade schema
3. Replace JSON reads/writes in weathermen scripts with MongoDB calls
4. Run `import-trades.js` — weathermen historical trades import automatically

**The invariant:** weathermen never writes to `weathermen-trades.json` after it merges to main. The hook in `import-trades.js` only matters for data that accumulated during development on the branch.

---

## What's NOT Included

- **Elliott Wave analysis changes** — EW storage.js already works correctly; migration is mechanical
- **New Discord channels or commands** — out of scope
- **BZ! OI trending fix** — valid improvement but separate from MongoDB migration
- **Cross-instrument dashboard** — the MongoDB schema enables it, but building it is a separate task after Phase 3 proves out

These are separate refactors. The MongoDB migration's job is to replace the persistence layer — not to redesign the analytics layer at the same time.

---

## Risk Summary

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| CDP scripts fail to connect to Docker-hosted Mongo | Low | High | Scripts are native; connect to 127.0.0.1:27017 which is port-forwarded — same as now |
| Weathermen schema mismatch at merge | Medium | Low | normalizeWeathermen() reviewed at merge time; import is idempotent |
| Poly TTL deletes records needed for outcome tracking | Low | Medium | Only set expiresAt when `outcome != null`; trigger-check.js checks outcome before writing TTL field |
| Weekly reports fail during MongoDB migration | Low | Low | Reports are read-only; JSON files still exist as fallback |
| Dual-write window introduces inconsistency | Low | Medium | Always write MongoDB first; JSON write failure is logged but not fatal during transition |
