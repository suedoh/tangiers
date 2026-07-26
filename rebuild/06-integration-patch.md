# 06 — Integration patch: trigger-check.js exchange-native cutover

**Prepared by Agent D against `main` @ `447f3cb` (trigger-check.js byte-identical to 7d12e84).**
Agent A owns `scripts/trigger-check.js`; this file is the exact change set to apply after the
spec-03 ledger rewrite lands. Every hunk that spec 03 will move is tagged **[spec-03 RE-ANCHOR]**
with what to re-anchor against. Library support (all committed on this branch, tested):
`lib/market-data.js` now provides `fetchLastPrice`, `fetchOpenInterest`, `computeATR`,
`completedBars`, `sessionBars`, and `12h`/`6h`/`8h`/`3d` intervals.

## Design

- **Flag:** `BTC_DATA_SOURCE=native` in `.env` switches every market read to Binance via
  `lib/market-data.js`. Default (unset / `tv`) = legacy CDP path, byte-identical behavior —
  this is the rollback lever the plan's P4 requires (keep ≥2 weeks).
- **Zones:** the **frozen** calibration `config/btc-zones.json` — currently
  `14d × 5m × rowSize 34.7` (P2 re-freeze against the production 30M read state; the P1 commit
  message's "30d/47.5" was the 60-TF chart state and was superseded same-day). Calibrate-then-
  freeze: **no recalibration without operator sign-off.**
- **Same brain:** `computeVRVPLevels` / `checkVRVPProximity` / `evaluateSetup` / all gates,
  cooldowns, daily-R kill, autotrade — untouched. Only the histogram/indicator *source* changes.
  Native profile feeds the same `{poc, vah, val, rows}` shape the VRVP_EXPR read produced, and
  natively **rows and store are the same data** — the stale-row defect class (D10) cannot exist.
- **Failure semantics unchanged:** Binance unreachable → skip cycle + error alert. Never signal
  off stale/partial data (`loadKlinesCached` propagates fetch errors; no silent cache serve).
- **Flipping the flag is a signal-brain change:** snapshot `win-rate-diff.js` baseline BEFORE
  the flip, note the Phase D clean-clock restart, and the 14-day parity clock starts at flip
  (and restarts on any cutover code change — plan rule).

### Known behavior deltas under `native` (intended, list them in the cutover commit)

1. **CVD definition unifies** to the 1h-rolling Binance sum (`computeCVD` over last 12
   completed 5m bars) — the same definition as the existing `fetchCVDBinance` fallback. The TV
   CVD study is an anchored cumulative series; audit D10 measured only 61.6% sign agreement
   between the two. Criteria #3, the C-short CVD gate, and CVD cooldown comparisons will
   disagree with the TV path on some cycles. This is the point: one definition, computable
   offline, backtestable.
2. **Confirmation + outcome bars are completed bars only** (`completedBars`) — fixes audit D4
   on the native path (TV's series includes the forming 30M bar). Spec 03 requires this anyway.
3. **HTF closes (4h MACD / 12h RSI / 1w trend) keep the forming bar** — matching what the TV
   chart series showed, so momentum criteria stay comparable across the flip.
4. **OI is continuous:** native `fetchOpenInterest` returns coins, the same unit the CDP read
   has used since 4f175b3; `_previousOI` state carries over, and `getOITrend`'s 10× guard
   absorbs any residue.
5. **VWAP / Session VP are UTC-day anchored** (`sessionBars`), matching the chart's session
   anchor on the Binance perp.

---

## H1 — requires + flag  (lines 26, 52–62)

The env loader runs at :54–62, so the flag cannot be read at :26. Delete the top-level CDP
require; make it lazy inside `cdpConnect()`; define the flag after the env block.

```js
// :26 — DELETE
const CDP   = require(require('path').resolve(__dirname, '../tradingview-mcp/node_modules/chrome-remote-interface'));
```

```js
// after the env loader block (:62) — ADD
// ─── Data source (spec 06 cutover flag) ──────────────────────────────────────
// 'tv' (default) = legacy CDP path, byte-identical. 'native' = Binance-computed
// via lib/market-data.js + frozen config/btc-zones.json. Rollback: unset.
const DATA_SOURCE = process.env.BTC_DATA_SOURCE === 'native' ? 'native' : 'tv';
const mkt = require('./lib/market-data');
```

```js
// cdpConnect() first line (:129) — ADD (lazy require; native mode and partner
// machines never load chrome-remote-interface)
async function cdpConnect() {
  const CDP = require(path.resolve(__dirname, '../tradingview-mcp/node_modules/chrome-remote-interface'));
  ...
```

## H2 — native snapshot readers  (new section after `fetchOIBinance`, :462)

```js
// ─── Native market snapshot (BTC_DATA_SOURCE=native) ─────────────────────────
// Everything main() otherwise reads via CDP, computed from Binance Futures
// REST. Zones use the FROZEN calibration (calibrate-then-freeze). Any fetch
// error throws → cycle skipped with an error alert — never signal off stale
// or partial data.
async function readNativeSnapshot() {
  const now = Date.now();
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'btc-zones.json'), 'utf8'));

  const [price, oi, bars5m, bars30raw] = await Promise.all([
    mkt.fetchLastPrice({ symbol: 'BTCUSDT' }),
    mkt.fetchOpenInterest({ symbol: 'BTCUSDT' }),
    mkt.loadKlinesCached({
      symbol: cfg.instrument, interval: cfg.interval,
      windowMs: cfg.windowDays * 86_400_000,
      cacheFile: path.join(ROOT, '.market-data-cache', `btc-${cfg.interval}.json`),
    }),
    mkt.fetchKlines({ symbol: 'BTCUSDT', interval: '30m',
                      startTime: now - 337 * 1_800_000, endTime: now }),
  ]);
  if (price == null) throw new Error('native: ticker price unavailable');

  const profile = mkt.buildVolumeProfile(bars5m, { rowSize: cfg.rowSize });
  if (!profile) throw new Error('native: volume profile empty');

  const done5m = mkt.completedBars(bars5m, '5m', now);
  const sess   = mkt.sessionBars(done5m, now);
  const svp    = mkt.computeSessionVP(sess);

  return {
    price,
    vrvpRaw: profile,                                    // {poc,vah,val,rows} — VRVP_EXPR shape
    cvd: Math.round(mkt.computeCVD(done5m.slice(-12))),  // 1h rolling, fetchCVDBinance definition
    oi,                                                  // coins
    sessionVP: { up: Math.round(svp.up), down: Math.round(svp.down) },
    vwap: mkt.computeVWAP(sess),
    volumes: mkt.completedBars(bars30raw, '30m', now).slice(-12).map(b => b.v),
  };
}

// HTF closes for MACD/RSI/weekly — native replacement for fetchHTFCloses.
// Keeps the forming bar, matching the TV chart series (delta #3 above).
async function fetchNativeHTFCloses(interval, count) {
  const now = Date.now();
  const bars = await mkt.fetchKlines({
    symbol: 'BTCUSDT', interval,
    startTime: now - (count + 1) * mkt.INTERVAL_MS[interval], endTime: now,
  });
  return bars.slice(-count).map(b => b.c);
}

// 30M OHLCV for confirmation + outcome walking. COMPLETED bars only (audit
// D4 — TV's series includes the forming bar). TV bar shape preserved:
// time in SECONDS + open/high/low/close, so existing walkers consume it as-is.
// [spec-03 RE-ANCHOR: the ledger rewrite replaces the walkers that CONSUME
// this; keep this provider and point the new walker at it.]
async function fetchNative30mOHLCV(count) {
  const now = Date.now();
  const raw = await mkt.fetchKlines({ symbol: 'BTCUSDT', interval: '30m',
    startTime: now - (count + 1) * 1_800_000, endTime: now });
  return mkt.completedBars(raw, '30m', now).slice(-count)
    .map(b => ({ time: b.t / 1000, open: b.o, high: b.h, low: b.l, close: b.c }));
}
```

## H3 — bar-source swap in the two walkers  **[spec-03 RE-ANCHOR]**

Spec 03 rewrites `checkConfirmation` (:1628) and `updateOutcomes` (:1890) wholesale. If this
patch applies **after** the rewrite (expected order), the only requirement is: *the new
functions obtain their 30M bars from `fetchNative30mOHLCV(n)` when `DATA_SOURCE === 'native'`,
else the existing CDP read.* Against current main the hunks are:

```js
// checkConfirmation, :1644–1650 — REPLACE
  let bars;
  if (DATA_SOURCE === 'native') {
    bars = await fetchNative30mOHLCV(96).catch(() => []);
  } else {
    const confirmTF = await cdpEval(client, GET_TF_EXPR).catch(() => '30');
    await cdpEval(client, buildSetTFExpr('30')).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    bars = await cdpEval(client, buildOHLCVExpr(96)).catch(() => []); // 48h of 30M bars
    if (confirmTF && confirmTF !== '30') {
      await cdpEval(client, buildSetTFExpr(confirmTF)).catch(() => {});
    }
  }
```

```js
// updateOutcomes, :1898–1915 — REPLACE (same pattern, 336 bars)
  let bars;
  if (DATA_SOURCE === 'native') {
    bars = await fetchNative30mOHLCV(336).catch(() => []);
  } else {
    const originalTF = await cdpEval(client, GET_TF_EXPR).catch(() => '30');
    await cdpEval(client, buildSetTFExpr('30'));
    await new Promise(r => setTimeout(r, 800));
    bars = await cdpEval(client, buildOHLCVExpr(336)).catch(() => []);
    if (originalTF && originalTF !== '30') {
      await cdpEval(client, buildSetTFExpr(originalTF));
    }
  }
  if (!bars || bars.length === 0) {
    log('updateOutcomes: no bar data returned — skipping this cycle');
    return;
  }
```

Both functions keep their `client` parameter (null in native mode; never dereferenced there).

## H4 — main(): native branch  (:2085–2296)  **[partially spec-03]**

Wrap the existing steps 1–6 (lock :2091 → CDP connect :2113 → quote/TF/VRVP/studies/HTF
:2150–2261 → parseStudies + Binance fallback :2263–2283) in the `else` arm of a data-source
branch. The native arm replaces all of it — **no lock, no CDP, no TF management**:

```js
async function main() {
  log(`Stage 1 trigger check starting (source: ${DATA_SOURCE})...`);

  let client = null, userTF = null, price, indicators;
  const restoreUserTF = async () => { /* unchanged body, no-ops when client==null */ };

  if (DATA_SOURCE === 'native') {
    try {
      const snap = await readNativeSnapshot();
      price = snap.price;
      indicators = {
        cvd: snap.cvd, oi: snap.oi, sessionVP: snap.sessionVP, vwap: snap.vwap,
        volumes: snap.volumes,
        vrvpLevels: computeVRVPLevels(snap.vrvpRaw),
        // Natively, histogram rows and the level store are the SAME data —
        // the stale-row split (D10) does not exist on this path.
        _vrvpPocFresh: snap.vrvpRaw.poc,
        macd4h: null, rsi12h: null, weeklyTrend: null,
      };
      log(`Native read: $${Math.round(price).toLocaleString()} | POC ${indicators.vrvpLevels?.poc} VAH ${indicators.vrvpLevels?.vah} VAL ${indicators.vrvpLevels?.val} | CVD ${snap.cvd} | OI ${snap.oi?.toFixed(0)}`);

      if (checkVRVPProximity(price, indicators.vrvpLevels)) {
        indicators.macd4h      = computeMACD(await fetchNativeHTFCloses('4h', 60));
        indicators.rsi12h      = computeRSI(await fetchNativeHTFCloses('12h', 30));
        indicators.weeklyTrend = analyseWeeklyTrend(await fetchNativeHTFCloses('1w', 10));
      }
    } catch (e) {
      errorAlert(`Native data read failed: ${e.message}`,
                 'Binance fapi via lib/market-data.js',
                 'Check network / Binance status. No signal was evaluated this cycle.');
      process.exit(1);
    }
  } else {
    // ── existing steps 1–6 verbatim, INCLUDING acquireLock/cdpConnect ──
    // (the `const lock = await acquireLock(...)` at :2091 moves inside here;
    //  all its exit paths already release correctly)
  }

  indicators.oiTrend = getOITrend(indicators.oi);           // :2285 — unchanged
  // ... CVD history append (:2289–2291) — unchanged ...

  await checkConfirmation(client, indicators);              // [spec-03 RE-ANCHOR]
  await updateOutcomes(client);                             // [spec-03 RE-ANCHOR]
  if (client) await client.close();

  // steps 7–9 (:2300–2509) unchanged — pure JS over `indicators`
  // sidecar call (:2513) unchanged
  await restoreUserTF();                                    // no-op in native
  log('Stage 1 complete.');
  if (DATA_SOURCE !== 'native') releaseLock('btc-trigger');
}
```

Also the crash handler (:2534): `releaseLock` call becomes conditional on `DATA_SOURCE !== 'native'`
(it is already a no-op-safe best-effort; conditioning it just avoids a misleading log line).

## H5 — signal tagging in `logTrade`  (:1724–1731)  **[spec-03 RE-ANCHOR: schema]**

Per plan P4, every signal carries its zone source for attribution:

```js
  trades.push({
    id,
    firedAt:    new Date().toISOString(),
    zoneSource: DATA_SOURCE === 'native' ? 'computed' : 'tv',   // ← ADD
    ...
```

Spec 03 renames/extends the trade schema (`accounting: 'design-intent-v1'` etc.) — keep the
`zoneSource` field through that migration; `import-trades.js` carries unknown fields as-is.

## H6 — parity sidecar inversion  (:2047–2081)

Post-cutover the sidecar's job flips: **native is primary; TV is the shadow** for the 14-day
gate (spec 06 item 3). Same JSONL schema — `tv.*` = TV feed, `mkt.*` = native — so
`scripts/audit/zone-parity-report.js` (already updated on this branch: live-cycles trigger
agreement + 0-native-blind gate) consumes it unchanged. Replace the body's head:

```js
async function zoneParitySidecar(price, indicators, tvTrigger) {
  if (process.env.ZONE_PARITY === 'false') return;
  try {
    if (DATA_SOURCE === 'native') {
      // Native primary: indicators/trigger ARE the mkt side. Best-effort TV
      // shadow read for the 14-day post-cutover gate; TV closed/unreadable →
      // tv fields null (tvBlind — informational in the report).
      const tvSide = await readTVShadow(price).catch(e => {
        log(`tv-shadow unavailable (non-fatal): ${e.message}`); return null;
      });
      const slim = t => t ? { type: t.type, direction: t.direction, mid: t.mid } : null;
      const lv = indicators.vrvpLevels;
      const entry = {
        ts: new Date().toISOString(), price,
        tv:  tvSide ?? { poc: null, pocFresh: null, vah: null, val: null, trigger: null },
        mkt: { poc: lv?.poc ?? null, vah: lv?.vah ?? null, val: lv?.val ?? null,
               trigger: slim(tvTrigger /* = the live native trigger in this mode */) },
        cvdTv: tvSide?.cvd ?? null, cvdMkt: indicators.cvd ?? null,
        oiTv:  tvSide?.oi  ?? null, oiMkt:  indicators.oi  ?? null,
      };
      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
      fs.appendFileSync(path.join(ROOT, 'logs', 'zone-parity.jsonl'), JSON.stringify(entry) + '\n');
      return;
    }
    // ... existing tv-primary body verbatim ...
```

New helper (place next to the sidecar). It is the ONLY remaining CDP consumer in native mode,
strictly best-effort, and holds the mutex because BZ/EW still share the TV session:

```js
// TV shadow read for the post-cutover parity gate. Never blocks the signal
// path (called after all signal work); every failure degrades to null.
async function readTVShadow(price) {
  const lock = await acquireLock(5_000, 'btc-tv-shadow');
  if (!lock) throw new Error('lock busy');
  let client;
  try {
    ({ client } = await cdpConnect());
    const tf = await cdpEval(client, GET_TF_EXPR).catch(() => null);
    if (tf !== '30') { await cdpEval(client, buildSetTFExpr('30')); await new Promise(r => setTimeout(r, 800)); }
    let vrvpRaw = null;
    for (let i = 0; i < 4; i++) {
      vrvpRaw = await cdpEval(client, VRVP_EXPR);
      if (vrvpRaw && !vrvpRaw.error && vrvpRaw.rows?.length) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const studies = await cdpEval(client, STUDY_VALUES_EXPR).catch(() => []);
    const parsed  = parseStudies(Array.isArray(studies) ? studies : []);
    const levels  = computeVRVPLevels(vrvpRaw);
    if (tf && tf !== '30') await cdpEval(client, buildSetTFExpr(tf)).catch(() => {});
    return {
      poc: levels?.poc ?? null, pocFresh: vrvpRaw?.poc ?? null,
      vah: levels?.vah ?? null, val: levels?.val ?? null,
      trigger: levels ? (t => t ? { type: t.type, direction: t.direction, mid: t.mid } : null)(checkVRVPProximity(price, levels)) : null,
      cvd: parsed.cvd ?? null, oi: parsed.oi ?? null,
    };
  } finally {
    try { await client?.close(); } catch {}
    releaseLock('btc-tv-shadow');
  }
}
```

## H7 — what dies when the 14-day gate passes (separate follow-up commit)

Delete, in one commit, after `zone-parity-report.js` exits 0 on ≥14 post-cutover days:

- `cdpConnect` / `cdpEval` (:127–179), all TV expressions (:181–417 — QUOTE/STUDY/TF/closes/
  OHLCV/volume/boxes/VRVP), `fetchHTFCloses` (:544–557), `readTVShadow`, every `DATA_SOURCE`
  conditional (native becomes the only path), the `acquireLock`/`releaseLock` pair, the CDP
  error-alert branches (:2119–2148), and `parseStudies`' TV-name matching (CVD/OI/VWAP/SVP now
  arrive structured). `parseFloat_`/`parse-num` stays only if any TV string still flows (none).
- THEN container migration (`ace-cron`) as its own commit + smoke, per spec 06 item 4.
- BZ!/Poly/EW keep CDP — BTC scope only. The `🕵Ace` layout requirement drops for BTC alone.

## Smoke test (run after applying, in order)

```bash
# 0. Baseline BEFORE the flip (metrics protocol)
node scripts/audit/win-rate-diff.js; echo $?

# 1. Unit suites
node --test test/*.test.js; echo $?
node --test scripts/tests/market-data.test.js; echo $?

# 2. The definitive no-CDP proof (spec 06 acceptance check 4):
#    QUIT TradingView Desktop, then:
BTC_DATA_SOURCE=native node scripts/trigger-check.js; echo $?
#    Expect: exit 0, "Native read: $..." log line, "Stage 1 complete.",
#    NO CDP error alert in #btc-signals, and logs/zone-parity.jsonl gains a
#    line with mkt.* populated and tv.* all null.

# 3. Gate report runs (fresh clock → INSUFFICIENT is the expected verdict)
node scripts/audit/zone-parity-report.js; echo $?   # expect 2 right after flip

# 4. Rollback check: with TradingView open again,
node scripts/trigger-check.js; echo $?              # flag unset → legacy path, exit 0
```

Reset the parity clock at flip: `mv logs/zone-parity.jsonl logs/zone-parity.pre-cutover.jsonl`
(keep the old file — it is the D10/stale-row evidence base).

## Open item for the operator (do not decide in code)

The 14-day post-cutover gate as specced compares native decisions to a TV feed that is 14.9%
blind and whose visible-range zones drift with chart zoom (VAH/VAL median Δ 0.42% on 14.3d of
pre-cutover data — above the 0.10% median gate). If the operator wants the trigger-agreement
gate to be passable, the chart state must be pinned during the window (VRVP visible, 30M TF,
stable zoom) — otherwise expect the gate to fail on trigger agreement while every native-side
check (0 blind cycles, decision determinism) passes. Flag at gate-evaluation time; the
alternative is an operator-approved gate restatement (native-vs-native determinism + spot
checks), which is spec-09 territory.
