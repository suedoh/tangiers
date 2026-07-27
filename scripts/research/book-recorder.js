#!/usr/bin/env node
'use strict';

/**
 * scripts/research/book-recorder.js — live order-book & flow recorder.
 *
 * WHY THIS EXISTS
 * The spec-07 hunt tested 98 hypotheses against 2 years of OHLCV and found no
 * edge that clears its own costs. That corpus is entirely *price-derived*: bars
 * are a summary of what already happened. This process records what bars cannot
 * see — resting liquidity and its asymmetry, how far back the book stands,
 * trade-by-trade aggression, and forced liquidations. Binance does not serve any
 * of it historically, so the only way to own that history is to start recording
 * and wait. Every day this runs is corpus that cannot be bought later.
 *
 * STREAM AVAILABILITY — VERIFIED, NOT ASSUMED (corrected 2026-07-27)
 * The first build (2026-07-26) recorded aggTrade / markPrice@1s / forceOrder as
 * "connect but deliver nothing" and worked around them. That diagnosis was
 * WRONG, and the workaround hid a real defect for a full day of recording: the
 * three silent streams were not broken, they were on a route this recorder was
 * not connected to. Binance's 2026-03-06 upgrade moved market data behind
 * /public, /market and /private paths and killed the legacy un-routed URL on
 * 2026-04-23; an un-routed socket still opens and still ACKs SUBSCRIBE (it will
 * even ACK `btcusdt@totallyFakeStreamXYZ`) while serving only the public bucket.
 *
 * Re-measured on the correct routes, 60s each:
 *   /public/ws/btcusdt@depth20@100ms   570      ✅ used
 *   /public/ws/btcusdt@bookTicker      14,410   ✅ used (touch sizes, full rate)
 *   /public/ws/btcusdt@trade           2,143    ✅ used (finer than aggTrade)
 *   /market/ws/!forceOrder@arr         23       ✅ used — liquidations DO flow
 *   /market/ws/btcusdt@aggTrade        751      ✅ available (not needed; @trade is finer)
 *   /market/ws/btcusdt@markPrice@1s    60       ✅ available (REST poll retained, see below)
 * The same names un-routed: 0 messages, every one of them.
 *
 * Rule learned: a silent Binance stream means "wrong route" until proven
 * otherwise. SUBSCRIBE acks and LIST_SUBSCRIPTIONS prove nothing — only frames
 * do. `scripts/research/route-check.js` re-verifies every stream on demand.
 *
 * `liqSeen` (BTC) and `liqAllSeen` (market-wide) remain in the state file as the
 * standing liveness check on the liquidation feed. Check them; do not assume.
 *
 * WHAT IT RECORDS  (one JSON line per UTC minute, per-day file)
 *   book      — imbalance at 1/5/20 levels (mean, sd, last), spread, resting
 *               depth per side, liquidity slope (volume-weighted distance from
 *               mid), microprice deviation
 *   touch     — best-bid/ask size imbalance at full update rate
 *   trades    — count, volume, taker-buy split, largest print, block (≥5 BTC) flow
 *   liq       — forced long vs short volume and notional  [see caveat above]
 *   mark      — mark price, funding rate, mark-index basis (REST, every 30s)
 *
 * HONESTY RULES BUILT IN
 *   - `samples` and `ticks` are on every row; a degraded minute is visible to
 *     research and filterable. Nothing is ever interpolated.
 *   - Minutes with no data are written as explicit `gap: true` rows. A missing
 *     row and a silent row mean different things.
 *   - Per-minute aggregates stay close to raw so a future feature idea is not
 *     blocked by today's feature choices.
 *
 * RUN IT (pm2, same pattern as bz-news-watch):
 *   pm2 start scripts/research/book-recorder.js --name book-recorder && pm2 save
 *   make book-status
 *
 * Read-only against the exchange: public market data, no key, no order ever.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ROOT    = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'orderbook');
const STATE   = path.join(ROOT, '.book-recorder-state.json');
const SYMBOL  = (process.env.BOOK_SYMBOL || 'btcusdt').toLowerCase();

// Binance's 2026-03-06 WebSocket upgrade split market data across ROUTED paths
// (/public, /market, /private) and decommissioned the legacy un-routed URLs on
// 2026-04-23. An un-routed connection still opens, still ACKs SUBSCRIBE, and
// still appears in LIST_SUBSCRIPTIONS — but only ever delivers the `public`
// bucket. That silent partial service is what made forceOrder look "connected
// but empty" for this recorder's entire first run. Measured 2026-07-27:
//   /public → @trade ✅ @bookTicker ✅ @depth20@100ms ✅
//   /market → @aggTrade ✅ @markPrice@1s ✅ @forceOrder ✅   (all ❌ un-routed)
// Verify with scripts/research/route-check.js before trusting any new stream.
const WS_BASE = 'wss://fstream.binance.com';

const PUBLIC_STREAMS = [
  `${SYMBOL}@depth20@100ms`,
  `${SYMBOL}@bookTicker`,
  `${SYMBOL}@trade`,
].join('/');
const PUBLIC_URL = `${WS_BASE}/public/stream?streams=${PUBLIC_STREAMS}`;

// Market-wide rather than `${SYMBOL}@forceOrder`: BTC alone liquidates too
// rarely to keep a 30s staleness timer honest, and cross-symbol cascade
// intensity is itself a candidate feature. BTC rows are filtered out of the
// merged feed; every symbol also aggregates into the liqAll* columns.
const MARKET_STREAMS = '!forceOrder@arr';
const MARKET_URL = `${WS_BASE}/market/stream?streams=${MARKET_STREAMS}`;

const STALE_MS     = 30_000;   // no message for 30s ⇒ the socket is dead
// The liquidation feed is event-driven and genuinely quiet in calm markets
// (~23/min market-wide when measured), so it needs a far looser liveness bar
// than the tick streams or it would reconnect-loop on nothing being wrong.
const LIQ_STALE_MS = 600_000;
const BLOCK_TRADE  = 5;        // BTC — "block" print threshold
const MARK_POLL_MS = 30_000;
const BACKOFF_BASE = 2_000;
const BACKOFF_MAX  = 120_000;

// ─── env guard (partner machines never run research collectors) ──────────────
(function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = s.slice(i + 1).trim();
  }
})();

const log = m => console.log(`[${new Date().toISOString()}] [book] ${m}`);

if (process.env.PRIMARY === 'false') {
  log('PRIMARY=false — recorder does not run on secondary machines');
  process.exit(0);
}

// ─── per-minute accumulator ──────────────────────────────────────────────────

function newBucket(minuteMs) {
  return {
    t: minuteMs,
    obi1: [], obi5: [], obi20: [],
    spread: [], dBid: [], dAsk: [], slopeBid: [], slopeAsk: [], mpDev: [],
    obiTouch: [], ticks: 0,
    trades: 0, tvol: 0, tbuy: 0, tmax: 0, tbigBuy: 0, tbigSell: 0,
    liqLong: 0, liqShort: 0, liqN: 0, liqNotional: 0,
    // Market-wide (all symbols) liquidation pressure — cascade intensity.
    liqAllLong: 0, liqAllShort: 0, liqAllN: 0, liqAllNotional: 0,
  };
}

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const push = (arr, v) => { if (v != null && Number.isFinite(v)) arr.push(v); };
const imb = (x, y) => (x + y > 0 ? (x - y) / (x + y) : null);

function onDepth(b, d) {
  const bids = d.b, asks = d.a;
  if (!bids?.length || !asks?.length) return;
  const bb = +bids[0][0], ba = +asks[0][0];
  const bq = +bids[0][1], aq = +asks[0][1];
  if (!(bb > 0) || !(ba > 0)) return;
  const mid = (bb + ba) / 2;

  const cum = (side, n) => {
    let q = 0, w = 0;
    for (let i = 0; i < Math.min(n, side.length); i++) {
      const px = +side[i][0], qty = +side[i][1];
      q += qty;
      w += qty * Math.abs(px - mid);
    }
    return { q, w };
  };
  const b1 = cum(bids, 1),   a1 = cum(asks, 1);
  const b5 = cum(bids, 5),   a5 = cum(asks, 5);
  const b20 = cum(bids, 20), a20 = cum(asks, 20);

  push(b.obi1,  imb(b1.q, a1.q));
  push(b.obi5,  imb(b5.q, a5.q));
  push(b.obi20, imb(b20.q, a20.q));
  push(b.spread, ((ba - bb) / mid) * 1e4);
  push(b.dBid, b20.q);
  push(b.dAsk, a20.q);
  // Volume-weighted distance of resting liquidity from mid, in bps: how far
  // back the book is standing. Thin-and-close reads very differently to
  // deep-and-far at identical imbalance.
  push(b.slopeBid, b20.q > 0 ? (b20.w / b20.q / mid) * 1e4 : null);
  push(b.slopeAsk, a20.q > 0 ? (a20.w / a20.q / mid) * 1e4 : null);
  // Microprice: size-weighted fair value between the touch prices.
  push(b.mpDev, bq + aq > 0 ? (((bb * aq + ba * bq) / (bq + aq)) - mid) / mid * 1e4 : null);
}

// bookTicker fires on every touch change — far faster than the 100ms book
// snapshot, so it captures queue dynamics the depth stream aliases away.
function onBookTicker(b, d) {
  const bq = +d.B, aq = +d.A;
  if (!Number.isFinite(bq) || !Number.isFinite(aq)) return;
  b.ticks++;
  push(b.obiTouch, imb(bq, aq));
}

function onTrade(b, d) {
  const q = +d.q;
  if (!Number.isFinite(q)) return;
  b.trades++;
  b.tvol += q;
  // m=true ⇒ the buyer was the maker ⇒ the aggressor was a seller.
  if (d.m === false) b.tbuy += q;
  if (q > b.tmax) b.tmax = q;
  if (q >= BLOCK_TRADE) { if (d.m === false) b.tbigBuy += q; else b.tbigSell += q; }
}

// The merged !forceOrder@arr feed carries every symbol; `o.s` says which.
// Post-CM-migration payloads also carry `st` (1=UM, 2=CM) and `ps` (pair).
function onForceOrder(b, d) {
  const o = d.o || {};
  const q = +o.q, p = +o.ap || +o.p;
  if (!Number.isFinite(q)) return;
  const notional = q * (Number.isFinite(p) ? p : 0);
  // A forced SELL is a long being liquidated, and vice versa.
  const isLong = o.S === 'SELL';

  b.liqAllN++;
  liqAllSeen++;
  b.liqAllNotional += notional;
  if (isLong) b.liqAllLong += q; else b.liqAllShort += q;

  if (o.s !== SYMBOL.toUpperCase()) return;
  b.liqN++;
  liqSeen++;
  b.liqNotional += notional;
  if (isLong) b.liqLong += q; else b.liqShort += q;
}

// ─── mark / funding / basis via REST (the WS stream delivers nothing here) ───

let markState = { mark: null, funding: null, basisBps: null, at: 0 };

function pollMark() {
  https.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${SYMBOL.toUpperCase()}`,
    { timeout: 10_000 }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const mk = +j.markPrice, ix = +j.indexPrice;
          markState = {
            mark: Number.isFinite(mk) ? mk : null,
            funding: Number.isFinite(+j.lastFundingRate) ? +j.lastFundingRate : null,
            basisBps: Number.isFinite(mk) && Number.isFinite(ix) && ix > 0 ? ((mk - ix) / ix) * 1e4 : null,
            at: Date.now(),
          };
        } catch { /* leave the previous value; staleness is visible via markAge */ }
      });
    }).on('error', () => { /* next poll retries */ });
}

function serialise(b) {
  return {
    t: b.t,
    samples: b.obi5.length, ticks: b.ticks,
    obi1: r4(mean(b.obi1)),
    obi5: r4(mean(b.obi5)), obi5sd: r4(sd(b.obi5)),
    obi20: r4(mean(b.obi20)), obi20sd: r4(sd(b.obi20)),
    obi20last: r4(b.obi20.length ? b.obi20[b.obi20.length - 1] : null),
    obiTouch: r4(mean(b.obiTouch)), obiTouchSd: r4(sd(b.obiTouch)),
    spread: r4(mean(b.spread)), spreadMax: r4(b.spread.length ? Math.max(...b.spread) : null),
    dBid: r2(mean(b.dBid)), dAsk: r2(mean(b.dAsk)),
    slopeBid: r2(mean(b.slopeBid)), slopeAsk: r2(mean(b.slopeAsk)),
    mpDev: r4(mean(b.mpDev)),
    trades: b.trades, tvol: r2(b.tvol), tbuy: r2(b.tbuy), tmax: r2(b.tmax),
    tbigBuy: r2(b.tbigBuy), tbigSell: r2(b.tbigSell),
    liqLong: r2(b.liqLong), liqShort: r2(b.liqShort), liqN: b.liqN,
    liqNotional: Math.round(b.liqNotional),
    liqAllLong: r2(b.liqAllLong), liqAllShort: r2(b.liqAllShort), liqAllN: b.liqAllN,
    liqAllNotional: Math.round(b.liqAllNotional),
    mark: r2(markState.mark), funding: markState.funding, basisBps: r4(markState.basisBps),
    // Age of the mark snapshot at write time — a stale REST poll must not
    // masquerade as a fresh reading.
    markAge: markState.at ? Math.round((Date.now() - markState.at) / 1000) : null,
  };
}

// ─── writer ──────────────────────────────────────────────────────────────────

function fileFor(ms) {
  const d = new Date(ms);
  return path.join(OUT_DIR, `${SYMBOL}-${d.toISOString().slice(0, 10)}.ndjson`);
}

let rowsWritten = 0, reconnects = 0, liqSeen = 0, liqAllSeen = 0;
const startedAt = Date.now();

function writeRow(obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(fileFor(obj.t), JSON.stringify(obj) + '\n');
  rowsWritten++;
  try {
    fs.writeFileSync(STATE, JSON.stringify({
      pid: process.pid, symbol: SYMBOL, startedAt, lastRowAt: Date.now(),
      lastRowMinute: new Date(obj.t).toISOString(), rowsWritten, reconnects,
      lastSamples: obj.samples ?? null, lastTicks: obj.ticks ?? null,
      lastTrades: obj.trades ?? null,
      // Liveness of the liquidation feed. liqAllSeen should climb within
      // minutes on any live market; if IT is 0 the /market route is broken.
      // liqSeen (BTC only) climbs far more slowly and a quiet hour is normal.
      liqSeen, liqAllSeen,
    }, null, 2));
  } catch (e) { log(`state write failed: ${e.message}`); }
}

// ─── connection ──────────────────────────────────────────────────────────────

let bucket = null;

function rollIfNeeded(nowMs) {
  const minute = Math.floor(nowMs / 60_000) * 60_000;
  if (!bucket) { bucket = newBucket(minute); return; }
  if (minute === bucket.t) return;
  // Emit every elapsed minute, including empty ones.
  for (let m = bucket.t; m < minute; m += 60_000) {
    if (m === bucket.t) writeRow(serialise(bucket));
    else writeRow({ t: m, samples: 0, ticks: 0, gap: true });
  }
  bucket = newBucket(minute);
}

// One supervised connection per route. They are kept independent on purpose:
// the tick feed going down must not drop the liquidation feed, and the
// liquidation feed is orders of magnitude quieter so it cannot share a
// staleness threshold with a 14,000-msg/min bookTicker stream.
function connect(feed) {
  log(`connecting ${feed.name} → ${feed.streams}`);
  const sock = new WebSocket(feed.url);
  feed.ws = sock;
  feed.lastMsgAt = Date.now();

  let done = false;
  const reconnect = why => {
    if (done) return;              // close+error both fire; only reconnect once
    done = true;
    if (feed.staleTimer) { clearInterval(feed.staleTimer); feed.staleTimer = null; }
    try { sock.close(); } catch {}
    reconnects++;
    const wait = Math.min(feed.backoff, BACKOFF_MAX);
    log(`${feed.name}: ${why} — reconnecting in ${(wait / 1000).toFixed(0)}s (reconnect #${reconnects})`);
    feed.backoff = Math.min(feed.backoff * 2, BACKOFF_MAX);
    setTimeout(() => connect(feed), wait + Math.floor(Math.random() * 1000));
  };

  sock.addEventListener('open', () => {
    log(`${feed.name}: connected`);
    feed.backoff = BACKOFF_BASE;
    feed.lastMsgAt = Date.now();
  });

  sock.addEventListener('message', ev => {
    feed.lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { stream, data } = msg;
    if (!stream || !data) return;
    rollIfNeeded(Date.now());
    if (stream.endsWith('@depth20@100ms'))   onDepth(bucket, data);
    else if (stream.endsWith('@bookTicker')) onBookTicker(bucket, data);
    else if (stream.endsWith('@trade'))      onTrade(bucket, data);
    // NB: the merged feed's stream name is `!forceOrder@arr` — it does NOT end
    // with "forceOrder", so this must be a substring test, not endsWith.
    else if (stream.includes('forceOrder'))  onForceOrder(bucket, data);
  });

  sock.addEventListener('close', () => reconnect('socket closed'));
  sock.addEventListener('error', e => log(`${feed.name}: socket error: ${e.message || 'unknown'}`));

  feed.staleTimer = setInterval(() => {
    if (Date.now() - feed.lastMsgAt > feed.staleMs) {
      reconnect(`no data for ${feed.staleMs / 1000}s`);
    }
  }, 5_000);
}

const FEEDS = [
  { name: 'public', url: PUBLIC_URL, streams: PUBLIC_STREAMS, staleMs: STALE_MS,
    backoff: BACKOFF_BASE, ws: null, staleTimer: null, lastMsgAt: Date.now() },
  { name: 'market', url: MARKET_URL, streams: MARKET_STREAMS, staleMs: LIQ_STALE_MS,
    backoff: BACKOFF_BASE, ws: null, staleTimer: null, lastMsgAt: Date.now() },
];

function connectAll() { for (const f of FEEDS) connect(f); }

// Flush the open minute on the way out so a restart loses seconds, not a minute.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — flushing`);
    try { if (bucket && bucket.obi5.length) writeRow(serialise(bucket)); } catch {}
    process.exit(0);
  });
}

if (process.argv.includes('--status')) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const ageS = (Date.now() - s.lastRowAt) / 1000;
    console.log(JSON.stringify(s, null, 2));
    const files = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.ndjson')) : [];
    let rows = 0;
    for (const f of files) rows += fs.readFileSync(path.join(OUT_DIR, f), 'utf8').split('\n').filter(Boolean).length;
    console.log(`\n${files.length} day-file(s), ${rows} minute rows (${(rows / 1440).toFixed(1)} days of coverage)`);
    console.log(`last row ${ageS.toFixed(0)}s ago — ${ageS < 120 ? 'HEALTHY' : 'STALE'}`);
    // liqAllSeen is the route-health check: market-wide liquidations occur every
    // few seconds, so a zero there means the /market feed is not arriving.
    // liqSeen (BTC only) legitimately sits at 0 through a quiet stretch.
    if (!s.liqAllSeen) {
      console.log('⚠️  liqAllSeen=0 — /market route is NOT delivering; liq* columns are empty.');
      console.log('    diagnose with: node scripts/research/route-check.js');
    } else if (!s.liqSeen) {
      console.log(`note: liqSeen=0 BTC-specific (market-wide ${s.liqAllSeen} seen — route is healthy);`);
      console.log('      normal in a quiet market, BTC liquidates far less often than the tape.');
    } else {
      console.log(`liq feed healthy — BTC ${s.liqSeen}, market-wide ${s.liqAllSeen}`);
    }
    process.exit(ageS < 120 ? 0 : 1);
  } catch (e) {
    console.error('no recorder state yet:', e.message);
    process.exit(1);
  }
}

log(`recording ${SYMBOL} → ${path.relative(ROOT, OUT_DIR)}/`);
pollMark();
setInterval(pollMark, MARK_POLL_MS);
connectAll();
