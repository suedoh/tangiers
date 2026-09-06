#!/usr/bin/env node
'use strict';

/**
 * scripts/research/orderflow-engine.js — live order-flow hypothesis engine.
 *
 * WHAT THIS IS
 * A standalone, fully-isolated observation engine. Every hour, at the close of
 * the 1h BTCUSDT perp bar, it recomputes the eight order-flow hypotheses that
 * were pre-registered and tested in
 * `notes/flow-research/order-flow-academic-backtest-2026-09-06.md`, posts the
 * readings to Discord, and persists them to Mongo. It places no orders.
 *
 * WHY IT PLACES NO ORDERS
 * That backtest ran the family on 7 years of 1h bars (61,316) with BH-FDR at
 * q=0.05, drift-adjusted directional excess, walk-forward splits and clustered
 * bootstrap CIs. Its verdict line is "CLEARED: none." Two hypotheses (H4b, H6)
 * came back FDR-significant in the *opposite* direction to the one predicted.
 * So there is currently no hypothesis worth risking capital on, and the trading
 * path below stays gated shut. See TRADING GATE.
 *
 * WHAT IT IS FOR, THEN
 * Three things a backtest cannot give you:
 *   1. Live, observable readings today — the same rules, running forward, so
 *      "what would this have said?" stops being a retrospective question.
 *   2. Forward out-of-sample record. Every bar is written to Mongo whether or
 *      not anything triggered, which is the only honest denominator.
 *   3. A correctly-built execution path that is ready but off, rather than a
 *      hastily-bolted-on one written under pressure the day something clears.
 *
 * THE PAPER LAYER (added 2026-09-06, see PAPER LAYER banner further down)
 * Alongside the readings, a single simulated account trades a *composite* of
 * the nine — majority direction among whichever are triggered — with a full
 * position lifecycle: modelled fill, ATR stop, +2R target, time stop, per-bar
 * mark-to-market, realised P&L. It runs unconditionally and is INDEPENDENT of
 * the trading gate below.
 *   That composite has NOT been backtested. It is nine refuted components in a
 *   trenchcoat, built to be watched, not believed. Storage carries `mode:
 *   "paper"` on every document so the record can never be mistaken for fills.
 *
 * BLOFIN MARKET DATA (added 2026-09-06, same day, second pass)
 * The paper layer crosses BloFin's OWN book: each cycle takes a read-only
 * snapshot of BloFin's ticker, L2 book, mark/index price and funding rate, and
 * the paper fill uses BloFin's measured half-spread rather than a Binance-shaped
 * 2bp guess. Rationale: this project has already measured BloFin's funding at
 * 6.22%/yr against Binance's 11.67%/yr — never reuse Binance's number for a
 * BloFin position. Every snapshot is persisted so the venue gap is analysable
 * later instead of assumed away.
 *   READ-ONLY, ENFORCED BY CONSTRUCTION. The paper layer calls only
 *   getTicker / getOrderBook / getMarkPrice / getFundingRate / getBalance —
 *   all GETs. It never calls placeOrder, placeTPSL, cancelOrder, cancelTPSL,
 *   setLeverage, setPositionMode or applyDemoMoney. The demo balance is
 *   recorded for reference and never sizes a paper trade, which runs against
 *   the independent $3,000 paper notional. Every write endpoint belongs to
 *   maybeTrade(), which is separate and still gated shut.
 *
 * ISOLATION — this process shares nothing mutable with the live BTC pipeline
 *   script      scripts/research/orderflow-engine.js   (new, pm2 'orderflow-engine')
 *   collections orderflow_experiment_{signals,orders,state}   (never `trades`/`blofin_orders`)
 *   paper       orderflow_experiment_paper_{trades,equity}    (never `..._orders`)
 *   venue       orderflow_experiment_blofin_market             (read-only market snapshots)
 *   state       .orderflow-experiment-state.json
 *   config      .orderflow-experiment-config.json
 *   breaker     .orderflow-experiment-disabled.json
 *   orders      clientOrderId prefix `ofexp-`
 *   data        Binance public REST for features; BloFin read-only for venue
 *               truth — no TradingView, no CDP, no lock
 * It reads scripts/lib/{db,blofin,discord}.js and modifies none of them. It
 * does not read or write .autotrade-disabled.json, trades.json, or any file
 * belonging to scripts/trigger-check.js.
 *
 * TWO DEFECTS FROM refactors/btc-audit-2026-08-03.md DESIGNED OUT
 *   A4 — sizing against a risk budget that the account's actual margin cannot
 *        satisfy, producing zero orders silently for weeks. Here every size is
 *        checked against live available margin AND the exchange lot minimum
 *        before placing, and a size that does not fit is posted as a visible
 *        skip. There is no code path that drops an intended order quietly.
 *   A6 — a ledger that recorded the *planned* entry rather than the fill,
 *        understating losses ~2.4x. Here the canonical price on every order doc
 *        is the exchange fill, resolved after the fact; the plan is kept in a
 *        separate `planned` sub-document that is never read as P&L.
 *
 * RUN IT
 *   pm2 start scripts/research/orderflow-engine.js --name orderflow-engine && pm2 save
 *   node scripts/research/orderflow-engine.js --once     # one cycle, then exit
 *   node scripts/research/orderflow-engine.js --probe    # end-to-end self-check
 *   node scripts/research/orderflow-engine.js --status
 *   node scripts/research/orderflow-engine.js --once --paper-force=short  # verify the paper mechanism
 *   node scripts/research/orderflow-engine.js --once --paper-close        # close the paper position
 *   node scripts/research/orderflow-engine.js --blofin-probe              # read-only venue probe
 */

const fs   = require('fs');
const path = require('path');

const { loadEnv, ROOT } = require('../lib/env.js');
loadEnv();

const db      = require('../lib/db.js');
const discord = require('../lib/discord.js');
const blofin  = require('../lib/blofin.js');

// ─── paths ───────────────────────────────────────────────────────────────────

const STATE_FILE  = path.join(ROOT, '.orderflow-experiment-state.json');
const CONFIG_FILE = path.join(ROOT, '.orderflow-experiment-config.json');
const BREAKER     = path.join(ROOT, '.orderflow-experiment-disabled.json');

// ─── constants (mirrored from the backtest — do not retune casually) ──────────

const SYMBOL   = 'BTCUSDT';
const INST_ID  = 'BTC-USDT';
const BASE     = 'https://fapi.binance.com';

const W      = 720;   // trailing percentile window (30d @1h) — backtest engine.js
const VPW    = 168;   // volume-profile window (7d @1h)
const VPBINS = 50;
const VPIN_N = 50;    // VPIN span in bars

// History depth. W=720 must be fully warm before the first usable reading, and
// H2redo's volume buckets only start accumulating at t>=720, so fetch well past
// the window rather than exactly to it.
const BARS_1H = 2200;
const BARS_4H = 900;

const MARK    = '🧪 **ORDER-FLOW EXPERIMENT**';
const POLL_MS = 30_000;
const BAR_LAG_MS   = 25_000;      // let Binance settle the closed bar before reading it
const HEARTBEAT_MS = 24 * 3600_000;

const MS = { '1h': 3600_000, '4h': 4 * 3600_000 };

// ─── logging ─────────────────────────────────────────────────────────────────

const log = m => console.log(`[${new Date().toISOString()}] ${m}`);

// ─── config / state / circuit breaker ────────────────────────────────────────

const DEFAULT_CONFIG = {
  // ── THE TRADING GATE ──────────────────────────────────────────────────────
  // false = compute and post only; no order is ever sent. This is the shipped
  // default and it is correct as of 2026-09-06: the pre-registered family
  // cleared nothing, so there is no hypothesis to trade.
  //
  // Flipping this to true requires BOTH of:
  //   (a) `hypothesis` naming one specific id below, and
  //   (b) that hypothesis having actually cleared a fresh pre-registered test
  //       — not this file's author's opinion, and not a re-read of the 2026-09-06
  //       results, which already refuted every one of them.
  // The engine refuses to trade with tradingEnabled:true and hypothesis:null.
  tradingEnabled: false,
  hypothesis: null,            // e.g. 'H2redo' — must be one of the ids in HYPOTHESIS_IDS

  riskPerTradePct: 0.5,        // % of ACCOUNT_EQUITY_USD risked to the stop
  stopAtrMult: 1.5,            // stop distance = stopAtrMult x ATR14 of the signal bar
  holdBars: 6,                 // intended holding horizon in bars (backtest k)
  leverage: 10,
  marginUtilCap: 0.30,         // refuse if required initial margin > 30% of available
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    log(`created ${path.basename(CONFIG_FILE)} (tradingEnabled: false)`);
  }
  const cfg = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
  // Env override exists for ops convenience but can only ever be *restrictive*
  // in the sense that it must be set explicitly to the string 'true'; anything
  // else, including unset, leaves the file's value alone.
  if (process.env.ORDERFLOW_TRADING_ENABLED === 'true') cfg.tradingEnabled = true;
  return cfg;
}

let state = readJson(STATE_FILE, {
  startedAt: Date.now(), lastBarPosted: null, lastBar4h: null,
  lastHeartbeatAt: 0, barsProcessed: 0, triggersSeen: 0,
  ordersPlaced: 0, ordersSkipped: 0, lastError: null,
});

function saveState() {
  state.pid = process.pid;
  state.updatedAt = Date.now();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); }
  catch (e) { log(`state write failed: ${e.message}`); }
}

/**
 * Circuit breaker. Presence of the file = disabled. Checked immediately before
 * every order placement — it exists from day one rather than being retrofitted,
 * which is exactly how the old signal's falsification gate ended up bolted on
 * after the fact.
 */
function breakerStatus() {
  if (!fs.existsSync(BREAKER)) return { disabled: false };
  const d = readJson(BREAKER, { reason: 'unreadable breaker file' });
  return { disabled: true, reason: d.reason || 'unspecified', trippedAt: d.trippedAt, stats: d.stats };
}

async function tripBreaker(reason, stats) {
  const doc = { reason, stats: stats || null, trippedAt: new Date().toISOString() };
  fs.writeFileSync(BREAKER, JSON.stringify(doc, null, 2) + '\n');
  log(`CIRCUIT BREAKER TRIPPED: ${reason}`);
  await post('error', [
    `${MARK} · 🛑 **CIRCUIT BREAKER TRIPPED**`,
    ``,
    `**Reason** ${reason}`,
    stats ? `**Stats** \`${JSON.stringify(stats)}\`` : null,
    ``,
    `No further orders will be placed. Clear \`${path.basename(BREAKER)}\` to re-arm.`,
  ].filter(Boolean).join('\n'));
}

/**
 * EXTENSION POINT — automated falsification of a live hypothesis.
 *
 * Not wired to a schedule today, because nothing trades and there is therefore
 * no forward record to evaluate. The shape it should take, using the stack this
 * project already standardised on (memory: audit methodology, v3-validated):
 *
 *   const rows = await sig.find({ hypothesis: cfg.hypothesis, executed: true,
 *                                 outcome: { $ne: null } }).toArray();
 *   if (rows.length < MIN_N) return;                       // MIN_N ~ 60 forward trades
 *   wilson(wins, n)                    → lower bound of the hit rate
 *   fisherExact(wins, losses, baseWins, baseLosses)        → vs the non-triggered arm
 *   dayClusteredBootstrapMean(R)       → 95% CI on mean R, clustered by UTC day
 *   trip when: bootstrap upper bound on mean R < 0 (net of the 14bp round trip
 *   the backtest pre-registered), OR the Wilson lower bound sits below the
 *   non-triggered base rate for two consecutive evaluation windows.
 *
 * Reuse `notes/flow-research/backtest-2026-09-06/stats.js` — it is the validated
 * implementation of all three, not a re-derivation.
 */
async function evaluateFalsification(/* cfg, signals */) {
  return { shouldTrip: false, reason: null };
}

// ─── Discord ─────────────────────────────────────────────────────────────────

async function post(type, body) {
  const url = process.env.BLOFIN_RECON_WEBHOOK;
  if (!url) { log('no BLOFIN_RECON_WEBHOOK — skipping post'); return null; }
  const footer = `order-flow experiment · BTCUSDT 1h · ${new Date().toUTCString().slice(5, 25)} UTC`;
  return discord.postWebhook(url, type, body, footer);
}

// ─── Binance public REST ─────────────────────────────────────────────────────

async function j(u, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 || r.status === 418) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`http ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await sleep(1200 * (i + 1)); }
  }
  throw last;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch the last `count` CLOSED klines. The final element Binance returns is the
 * in-progress bar; including it would make every feature at the newest index
 * look-ahead-contaminated in the one place it matters most, so it is dropped by
 * close time, not by position.
 */
async function klines(interval, count) {
  const step = MS[interval];
  const now = Date.now();
  const start = now - (count + 2) * step;
  const out = [];
  let t = start;
  for (let page = 0; page < 12; page++) {
    const d = await j(`${BASE}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${t}&limit=1500`);
    if (!d.length) break;
    for (const k of d) {
      out.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tbb: +k[9] });
    }
    const lastT = +d[d.length - 1][0];
    if (d.length < 1500 || lastT + step >= now) break;
    t = lastT + 1;
    await sleep(120);
  }
  const m = new Map();
  for (const b of out) if (b.t + step <= now) m.set(b.t, b);   // closed bars only
  return [...m.values()].sort((a, b) => a.t - b.t);
}

async function openInterestHist(period) {
  const rows = await j(`${BASE}/futures/data/openInterestHist?symbol=${SYMBOL}&period=${period}&limit=500`);
  return rows.map(r => ({ t: r.timestamp, oi: +r.sumOpenInterest }));
}

// ─── features — ported verbatim from backtest-2026-09-06/engine.js ───────────
// Causal by construction: every percentile at t uses only [t-W, t-1]. These are
// the exact definitions the 7-year family was measured with. Changing a
// threshold here silently invalidates the comparison to that backtest.

function trailingPctile(x, w = W) {
  const n = x.length, out = new Array(n).fill(null);
  for (let t = w; t < n; t++) {
    const v = x[t];
    if (!Number.isFinite(v)) continue;
    let cnt = 0, tot = 0;
    for (let i = t - w; i < t; i++) { if (!Number.isFinite(x[i])) continue; tot++; if (x[i] <= v) cnt++; }
    out[t] = tot > 0 ? cnt / tot * 100 : null;
  }
  return out;
}

function trailingMedian(x, w = W) {
  const n = x.length, out = new Array(n).fill(null);
  for (let t = w; t < n; t++) {
    const s = x.slice(t - w, t).filter(Number.isFinite).sort((a, b) => a - b);
    out[t] = s.length ? s[s.length >> 1] : null;
  }
  return out;
}

function ema(x, p) {
  const a = 2 / (p + 1), out = new Array(x.length).fill(null);
  let e = x[0];
  for (let i = 0; i < x.length; i++) { if (i) e = a * x[i] + (1 - a) * e; out[i] = i >= p ? e : null; }
  return out;
}

function buildFeatures(k) {
  const n = k.length;
  const O = k.map(b => b.o), H = k.map(b => b.h), L = k.map(b => b.l), C = k.map(b => b.c), V = k.map(b => b.v);
  const T = k.map(b => b.t);
  const delta = new Array(n), r = new Array(n), absr = new Array(n);
  for (let i = 0; i < n; i++) {
    delta[i] = 2 * k[i].tbb - k[i].v;         // exact aggressor delta, not a tick-rule proxy
    r[i] = O[i] > 0 ? (C[i] - O[i]) / O[i] : 0;
    absr[i] = Math.abs(r[i]);
  }
  const atr = new Array(n).fill(null);
  for (let t = 15; t < n; t++) {
    let s = 0;
    for (let i = t - 14; i < t; i++) {
      const pc = C[i - 1];
      s += Math.max(H[i] - L[i], Math.abs(H[i] - pc), Math.abs(L[i] - pc));
    }
    atr[t] = s / 14;
  }
  const medVol = trailingMedian(V);
  const Fn = new Array(n).fill(null);
  for (let t = 0; t < n; t++) Fn[t] = (medVol[t] && medVol[t] > 0) ? delta[t] / medVol[t] : null;
  const absFn = Fn.map(v => v == null ? NaN : Math.abs(v));
  const lam = new Array(n).fill(NaN);
  for (let t = 0; t < n; t++) {
    if (Fn[t] == null) continue;
    const a = Math.abs(Fn[t]);
    if (a > 1e-9) lam[t] = absr[t] / a;
  }
  const vpin = new Array(n).fill(NaN), cumF = new Array(n).fill(null);
  for (let t = VPIN_N - 1; t < n; t++) {
    let num = 0, den = 0, s = 0;
    for (let i = t - VPIN_N + 1; i <= t; i++) { num += Math.abs(delta[i]); den += V[i]; s += delta[i]; }
    if (den > 0) vpin[t] = num / den;
    cumF[t] = s;
  }
  const poc = new Array(n).fill(null), vah = new Array(n).fill(null), val = new Array(n).fill(null);
  for (let t = VPW; t < n; t++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = t - VPW; i < t; i++) { if (L[i] < lo) lo = L[i]; if (H[i] > hi) hi = H[i]; }
    if (!(hi > lo)) continue;
    const bins = new Float64Array(VPBINS), wdt = (hi - lo) / VPBINS;
    let tot = 0;
    for (let i = t - VPW; i < t; i++) {
      let b = Math.floor((C[i] - lo) / wdt); if (b < 0) b = 0; if (b >= VPBINS) b = VPBINS - 1;
      bins[b] += V[i]; tot += V[i];
    }
    let pi = 0; for (let b = 1; b < VPBINS; b++) if (bins[b] > bins[pi]) pi = b;
    let acc = bins[pi], loB = pi, hiB = pi;
    while (acc < 0.70 * tot && (loB > 0 || hiB < VPBINS - 1)) {
      const dn = loB > 0 ? bins[loB - 1] : -1, up = hiB < VPBINS - 1 ? bins[hiB + 1] : -1;
      if (up >= dn) { hiB++; acc += bins[hiB]; } else { loB--; acc += bins[loB]; }
    }
    poc[t] = lo + (pi + 0.5) * wdt;
    val[t] = lo + loB * wdt;
    vah[t] = lo + (hiB + 1) * wdt;
  }

  return {
    n, T, O, H, L, C, V, delta, r, absr, atr, medVol, Fn, absFn, lam, vpin, cumF, poc, vah, val,
    pLam: trailingPctile(lam),
    pAbsFn: trailingPctile(absFn),
    pFn: trailingPctile(Fn.map(v => v == null ? NaN : v)),
    pVol: trailingPctile(V),
    pAbsD: trailingPctile(delta.map(Math.abs)),
    pVpin: trailingPctile(vpin),
    pAbsR: trailingPctile(absr),
    ema50: ema(C, 50), ema200: ema(C, 200),
  };
}

/**
 * Volume-bucket VPIN — the H2redo construction from phase3.js. The pre-registered
 * H2 used time bars, whose positive control failed (forward-vol ratio < 1, i.e.
 * "high toxicity" bars were followed by *less* volatility, so the construct was
 * not validly reproduced). This is the corrected López de Prado construction:
 * 50 equal-volume buckets per day, VPIN over the trailing 50 buckets.
 */
function volumeBucketVpin(k, F) {
  const vpinVB = new Array(F.n).fill(NaN), cumFVB = new Array(F.n).fill(null);
  const buckets = []; let aB = 0, aS = 0, aV = 0, bs = null;
  for (let t = 0; t < F.n; t++) {
    if (t >= W) { let s = 0; for (let i = t - W; i < t; i++) s += F.V[i]; bs = (s / W) * 24 / 50; }
    if (bs > 0) {
      let vL = F.V[t]; const bf = F.V[t] > 0 ? k[t].tbb / F.V[t] : 0.5;
      while (vL > 0) {
        const take = Math.min(bs - aV, vL);
        aB += take * bf; aS += take * (1 - bf); aV += take; vL -= take;
        if (aV >= bs - 1e-9) { buckets.push({ buy: aB, sell: aS, vol: aV }); aB = aS = aV = 0; if (buckets.length > 400) buckets.shift(); }
      }
      if (buckets.length >= 50) {
        const last = buckets.slice(-50); let nu = 0, de = 0, sg = 0;
        for (const b of last) { nu += Math.abs(b.buy - b.sell); de += b.vol; sg += b.buy - b.sell; }
        vpinVB[t] = nu / de; cumFVB[t] = sg;
      }
    }
  }
  return { vpinVB, cumFVB, pVpinVB: trailingPctile(vpinVB) };
}

// ─── hypotheses ──────────────────────────────────────────────────────────────
// Ids, names, rules and thresholds are exactly those of the pre-registered
// family. `verdict` records the 2026-09-06 result so no future reader mistakes
// a live FIRE for evidence of an edge.

const HYPOTHESIS_IDS = ['H1', 'H1p', 'H2', 'H2redo', 'H3', 'H4a', 'H4b', 'H5', 'H6'];

function hypotheses1h(F, VB) {
  const base = t => F.pLam[t] != null && F.pAbsFn[t] != null && F.atr[t] != null && F.Fn[t] != null;
  return {
    H1: {
      name: 'Kyle-λ transient-impact fade',
      verdict: 'NOT CLEARED — insufficient n (46 events in 7y, p ≥ 0.66)',
      valid: t => base(t) && Number.isFinite(F.lam[t]) && F.delta[t] !== 0,
      dir:   t => -Math.sign(F.delta[t]),
      trig:  t => F.pLam[t] >= 90 && F.pAbsFn[t] >= 60,
    },
    H1p: {
      name: "High-λ alone → fade (disclosed variant)",
      verdict: 'NOT CLEARED — no effect; best cell points the wrong way',
      valid: t => base(t) && Number.isFinite(F.lam[t]) && F.delta[t] !== 0,
      dir:   t => -Math.sign(F.delta[t]),
      trig:  t => F.pLam[t] >= 90,
    },
    H2: {
      name: 'VPIN toxicity continuation (time bars)',
      verdict: 'NOT CLEARED — positive control failed, construct not validated',
      valid: t => F.pVpin[t] != null && F.cumF[t] != null && F.cumF[t] !== 0,
      dir:   t => Math.sign(F.cumF[t]),
      trig:  t => F.pVpin[t] >= 90,
    },
    H2redo: {
      name: 'VPIN toxicity continuation (volume buckets)',
      verdict: 'NOT CLEARED — k=6 net −6.9bp; k=24 q=0.135, both WF halves span zero',
      valid: t => VB.pVpinVB[t] != null && VB.cumFVB[t] != null && VB.cumFVB[t] !== 0,
      dir:   t => Math.sign(VB.cumFVB[t]),
      trig:  t => VB.pVpinVB[t] >= 90,
    },
    H3: {
      name: 'Absorption fade (repo v3.1 rule)',
      verdict: 'NOT CLEARED — refuted at n=358; significantly WRONG-SIGNED at 4h',
      valid: t => base(t) && F.delta[t] !== 0 && F.atr[t] > 0 && F.pVol[t] != null && F.pAbsD[t] != null,
      dir:   t => -Math.sign(F.delta[t]),
      trig:  t => F.pVol[t] >= 90 && F.pAbsD[t] >= 85 && Math.abs(F.C[t] - F.O[t]) <= 0.30 * F.atr[t],
    },
    H4a: {
      name: 'Value-area rejection → rotate to POC',
      verdict: 'NOT CLEARED — wrong-signed; k=24 excess −22.2bp, CI excludes zero negatively',
      valid: t => F.poc[t] != null && F.C[t] !== F.poc[t],
      dir:   t => Math.sign(F.poc[t] - F.C[t]),
      trig:  t => (F.H[t] > F.vah[t] && F.C[t] < F.vah[t]) || (F.L[t] < F.val[t] && F.C[t] > F.val[t]),
    },
    H4b: {
      name: 'Value-area acceptance → continuation',
      verdict: 'NOT CLEARED — FDR-significant in the OPPOSITE direction (q<0.01, all k)',
      valid: t => F.poc[t] != null && F.C[t] !== F.poc[t],
      dir:   t => Math.sign(F.C[t] - F.poc[t]),
      trig:  t => F.C[t] > F.vah[t] || F.C[t] < F.val[t],
    },
    H6: {
      name: 'TSMOM regime × flow alignment',
      verdict: 'NOT CLEARED — FDR-significant OPPOSITE direction (45.96% vs 51.17%, p=7.7e-24)',
      valid: t => F.ema50[t] != null && F.ema200[t] != null && F.pFn[t] != null,
      dir:   t => F.ema50[t] > F.ema200[t] ? 1 : -1,
      trig:  t => (F.ema50[t] > F.ema200[t] && F.pFn[t] >= 80) || (F.ema50[t] <= F.ema200[t] && F.pFn[t] <= 20),
    },
  };
}

/**
 * H5 lives on 4h bars because that is the only resolution where Binance's OI
 * history covers a usable span — /futures/data/openInterestHist is capped at 500
 * rows AND rejects any startTime older than ~30 days, which is precisely why H5
 * was underpowered (n=17 over 10 days) in the backtest.
 */
function hypothesis5(F4, oiArr) {
  return {
    name: 'OI-confirmed continuation (4h)',
    verdict: 'NOT CLEARED — underpowered (n=17) and regime-confounded in a +24.3% month',
    valid: t => oiArr[t] != null && oiArr[t - 1] != null && F4.pAbsR[t] != null && F4.r[t] !== 0,
    dir:   t => Math.sign(F4.r[t]),
    trig:  t => F4.pAbsR[t] >= 60 && (oiArr[t] - oiArr[t - 1]) / oiArr[t - 1] >= 0.0025,
  };
}

function readAll(F, VB, F4, oiArr) {
  const t = F.n - 1;                        // last CLOSED 1h bar
  const HS = hypotheses1h(F, VB);
  const out = [];
  for (const id of ['H1', 'H1p', 'H2', 'H2redo', 'H3', 'H4a', 'H4b', 'H6']) {
    const h = HS[id];
    const valid = !!h.valid(t);
    const trig = valid && !!h.trig(t);
    const d = valid ? h.dir(t) : 0;
    out.push({
      id, name: h.name, verdict: h.verdict, interval: '1h',
      valid, triggered: trig, dir: d || 0,
      side: !trig || !d ? null : (d > 0 ? 'long' : 'short'),
    });
  }
  // H5 on the last closed 4h bar
  if (F4 && oiArr) {
    const t4 = F4.n - 1;
    const h5 = hypothesis5(F4, oiArr);
    const valid = t4 > 0 && !!h5.valid(t4);
    const trig = valid && !!h5.trig(t4);
    const d = valid ? h5.dir(t4) : 0;
    out.push({
      id: 'H5', name: h5.name, verdict: h5.verdict, interval: '4h',
      barOpen: F4.T[t4], valid, triggered: trig, dir: d || 0,
      side: !trig || !d ? null : (d > 0 ? 'long' : 'short'),
    });
  } else {
    out.push({ id: 'H5', name: 'OI-confirmed continuation (4h)', interval: '4h',
               valid: false, triggered: false, dir: 0, side: null, note: 'OI history unavailable' });
  }
  return out;
}

// ─── the order path — built, verified, and gated shut ────────────────────────

/**
 * Attempt an order for a triggered reading.
 *
 * Returns a result object in every branch. There is deliberately no path that
 * returns silently: 'observed', 'skipped' and 'placed' are all posted or
 * summarised. A4's failure mode was a skip nobody could see.
 */
async function maybeTrade(reading, ctx, cfg) {
  // Gate 0 — the trading gate. Currently and correctly false.
  if (!cfg.tradingEnabled) {
    return { status: 'observed', detail: 'trading gate closed (tradingEnabled: false)' };
  }
  // Gate 1 — a live hypothesis must be named, and it must be this one.
  if (!cfg.hypothesis || !HYPOTHESIS_IDS.includes(cfg.hypothesis)) {
    const r = { status: 'skipped', detail: `tradingEnabled:true but hypothesis is ${cfg.hypothesis === null ? 'null' : `"${cfg.hypothesis}"`} — refusing to trade an unnamed or unknown rule` };
    await post('error', `${MARK} · ⚠️ **ORDER SKIPPED**\n\n${r.detail}`);
    return r;
  }
  if (reading.id !== cfg.hypothesis) return { status: 'observed', detail: `not the live hypothesis (${cfg.hypothesis})` };

  // Gate 2 — circuit breaker.
  const br = breakerStatus();
  if (br.disabled) {
    const r = { status: 'skipped', detail: `circuit breaker: ${br.reason}` };
    await post('error', `${MARK} · 🛑 **ORDER SKIPPED — CIRCUIT BREAKER**\n\n**Reason** ${br.reason}\n**Tripped** ${br.trippedAt || 'unknown'}`);
    return r;
  }

  const side = reading.side === 'long' ? 'buy' : 'sell';
  const entryRef = ctx.close;
  const stopDist = cfg.stopAtrMult * ctx.atr;
  if (!(stopDist > 0)) {
    const r = { status: 'skipped', detail: 'ATR unavailable — cannot size to a stop' };
    await post('error', `${MARK} · ⚠️ **ORDER SKIPPED**\n\n${r.detail}`);
    return r;
  }
  const slPrice = reading.side === 'long' ? entryRef - stopDist : entryRef + stopDist;

  const equity = Number(process.env.ACCOUNT_EQUITY_USD || 0);
  const riskUsd = equity * (cfg.riskPerTradePct / 100);
  const sizeBtc = riskUsd / stopDist;

  // ── A4: prove the size fits BEFORE placing, against real exchange numbers ──
  // The old defect was a risk budget evaluated in a vacuum. Contract size, lot
  // step, exchange minimum and available margin are all fetched live here, and
  // any one of them failing produces a visible skip rather than a no-op.
  let inst, bal;
  try {
    inst = (await blofin.getInstruments(INST_ID))?.[0];
    bal  = await blofin.getBalance('futures');
  } catch (e) {
    const r = { status: 'skipped', detail: `exchange read failed: ${e.message}` };
    await post('error', `${MARK} · ⚠️ **ORDER SKIPPED**\n\n${r.detail}`);
    return r;
  }
  const ctVal   = Number(inst?.contractValue || 0.001);
  const lotSize = Number(inst?.lotSize || 0.1);
  const minSize = Number(inst?.minSize || 0.1);
  // getBalance() returns a flat ARRAY of currency rows — probed 2026-09-06:
  // [{currency:'USDT', balance, available, frozen, bonus}]. An earlier
  // `bal?.details?.find(...) ?? bal?.available` read neither shape, resolved to
  // 0, and would have failed EVERY size against $0.00 available margin — i.e.
  // reintroduced audit defect A4 (zero orders, silently) in the very function
  // whose docblock claims to have designed it out. Idiom matches
  // scripts/lib/blofin-autotrade.js:530 and scripts/ops/watchdog.js:521.
  const available = Number((Array.isArray(bal) ? bal : []).find(b => b.currency === 'USDT')?.available ?? 0);

  const rawContracts = sizeBtc / ctVal;
  const contracts = Math.floor(rawContracts / lotSize) * lotSize;
  const notional  = contracts * ctVal * entryRef;
  const reqMargin = notional / cfg.leverage;

  const fail =
    contracts < minSize
      ? `sized at ${contracts} contracts (risk $${riskUsd.toFixed(2)} / stop $${stopDist.toFixed(0)} = ${sizeBtc.toFixed(4)} BTC), below the exchange minimum ${minSize}`
    : reqMargin > available * cfg.marginUtilCap
      ? `sized at ${contracts} contracts (notional $${notional.toFixed(0)}, initial margin $${reqMargin.toFixed(2)}), doesn't fit available margin $${available.toFixed(2)} at ${(cfg.marginUtilCap * 100).toFixed(0)}% cap`
      : null;

  if (fail) {
    const r = { status: 'skipped', detail: fail };
    await post('error', [
      `${MARK} · ⚠️ **ORDER SKIPPED — SIZE DOES NOT FIT**`,
      ``, `**${reading.id}** ${reading.side.toUpperCase()} @ $${entryRef.toFixed(0)}`,
      `${fail}`, ``,
      `Nothing was sent. Equity $${equity} · risk ${cfg.riskPerTradePct}% · leverage ${cfg.leverage}x`,
    ].join('\n'));
    state.ordersSkipped = (state.ordersSkipped || 0) + 1;
    return r;
  }

  // ── place ──────────────────────────────────────────────────────────────────
  const clientOrderId = `ofexp-${Date.now()}`;
  const planned = { entry: entryRef, stop: slPrice, contracts, notional, reqMargin,
                    riskUsd, stopDist, sizeBtc, leverage: cfg.leverage };
  let placed;
  try {
    placed = await blofin.placeOrder({
      instId: INST_ID, side, orderType: 'market', size: contracts,
      marginMode: 'isolated', positionSide: 'net', clientOrderId,
    });
  } catch (e) {
    const r = { status: 'skipped', detail: `placement rejected: ${e.message}` };
    await post('error', `${MARK} · ⚠️ **ORDER REJECTED**\n\n**${reading.id}** ${reading.side}\n\`${e.message.slice(0, 300)}\``);
    state.ordersSkipped = (state.ordersSkipped || 0) + 1;
    return r;
  }
  const orderId = Array.isArray(placed) ? placed[0]?.orderId : placed?.orderId;

  // ── A6: the canonical record is the FILL, never the plan ───────────────────
  const fill = await resolveFill(clientOrderId);

  // ── standalone SL (survives partial closes — attached SLs do not) ──────────
  let slId = null, slError = null;
  try {
    const sl = await blofin.placeTPSL({
      instId: INST_ID, side: side === 'buy' ? 'sell' : 'buy', size: contracts,
      marginMode: 'isolated', positionSide: 'net', reduceOnly: true,
      slTriggerPrice: slPrice.toFixed(1), slOrderPrice: '-1', slTriggerPriceType: 'mark',
    });
    slId = Array.isArray(sl) ? sl[0]?.tpslId : sl?.tpslId;
    const pending = await blofin.getPendingTPSL({ instId: INST_ID });
    if (!pending.some(o => String(o.tpslId) === String(slId))) throw new Error('SL not visible in pending TPSL after placement');
  } catch (e) {
    slError = e.message;
  }
  if (slError) {
    try {
      await blofin.placeOrder({ instId: INST_ID, side: side === 'buy' ? 'sell' : 'buy',
        orderType: 'market', size: contracts, marginMode: 'isolated', positionSide: 'net',
        reduceOnly: true, clientOrderId: `ofexp-flat-${Date.now()}` });
    } catch {}
    await post('error', [`${MARK} · 🛑 **SL VERIFICATION FAILED — POSITION FLATTENED**`, ``,
      `**${reading.id}** ${reading.side} ${contracts} contracts`, `\`${slError.slice(0, 300)}\``].join('\n'));
  }

  const doc = {
    _id: clientOrderId,
    clientOrderId, orderId, tpslId: slId, hypothesis: reading.id, side: reading.side,
    instId: INST_ID, env: process.env.BLOFIN_ENV || 'demo',
    // canonical = fill. `planned` is retained for slippage analysis and is
    // explicitly NOT the P&L basis.
    fillPrice: fill?.fillPrice ?? null,
    filledSize: fill?.filledSize ?? null,
    filledAt: fill?.filledAt ?? null,
    fillResolved: !!fill?.fillPrice,
    planned,
    slPrice, slVerified: !slError, slError,
    signalBarOpen: ctx.barOpen, holdBars: cfg.holdBars,
    createdAt: new Date(),
  };
  try { (await orders()).replaceOne({ _id: doc._id }, doc, { upsert: true }); }
  catch (e) { log(`order doc write failed: ${e.message}`); }

  state.ordersPlaced = (state.ordersPlaced || 0) + 1;
  await post(reading.side === 'long' ? 'long' : 'short', [
    `${MARK} · ✅ **ORDER PLACED**`, ``,
    `**${reading.id}** ${reading.side.toUpperCase()} ${contracts} contracts`,
    `**Fill** ${fill?.fillPrice ? `$${Number(fill.fillPrice).toFixed(1)}` : '_unresolved — recorded null, never the plan_'}`,
    `**Planned entry** $${entryRef.toFixed(1)} · **SL** $${slPrice.toFixed(1)} ${slError ? '❌ FAILED' : '✅ verified'}`,
    `**Risk** $${riskUsd.toFixed(2)} · **Margin** $${reqMargin.toFixed(2)} of $${available.toFixed(2)} available`,
    `\`${clientOrderId}\``,
  ].join('\n'));
  return { status: 'placed', detail: clientOrderId, doc };
}

// ─── PAPER LAYER ─────────────────────────────────────────────────────────────
// A parallel, always-on simulation of one account trading a composite of the
// nine readings. It cannot move a coin: nothing below this banner calls
// blofin.placeOrder / placeTPSL / cancelOrder / cancelTPSL / setLeverage /
// setPositionMode / applyDemoMoney — or any BloFin write endpoint at all.
//
// It DOES read BloFin (added later the same day, see BLOFIN MARKET DATA in the
// file header): ticker, L2 book, mark/index, funding rate, and the demo
// balance. All GETs. The market reads feed the fill model — a simulation that
// prices its fills off Binance while claiming to emulate BloFin is a Binance
// backtest wearing a BloFin label, and this project has measured the two
// venues disagreeing by 13pp on funding. The balance read is REFERENCE ONLY:
// paper sizing runs off state.paper's independent $3,000 notional and would be
// byte-identical if the balance call returned nothing.
//
// RELATIONSHIP TO THE ORDER PATH ABOVE
// None. maybeTrade(), cfg.tradingEnabled and cfg.hypothesis govern real orders
// and are untouched by this layer; the paper book runs whether that gate is
// open or shut, and flipping it would not change a single line here.
//
// ── HONESTY NOTE, AND WHERE IT LIVES ───────────────────────────────────────
// The composite defined in compositeSignal() HAS NOT BEEN BACKTESTED. It is
// assembled from nine components that were individually REFUTED on 7 years of
// history (2026-09-06 pre-registered family: "CLEARED: none"), two of them
// FDR-significant in the OPPOSITE direction to the one they predict. Combining
// refuted rules does not produce an edge, and no claim is made here that it
// does. This layer exists so the account owner can watch a full position
// lifecycle run forward on live data — it is an observation instrument, not an
// asserted strategy, and its P&L is not evidence of anything.
//
// That honesty lives in this comment, in the refactor note, and in the `mode:
// "paper"` provenance tag on every stored document — deliberately NOT in the
// Discord copy, which the owner asked to read as plain trade alerts.

/** Paper account seed. Not the BloFin balance — never read from, never written to. */
const PAPER_START_EQUITY = 3000;

// Cost model, taken from the backtest's pre-registration (§ "Costs pre-registered
// at 14bp round trip (5bp taker/side + 2bp slippage/side)"). Kept as its two
// components rather than one lump so the stored `feesUsd` means fees and the
// fill price means a filled price:
//   slippage → moves the FILL adversely on both legs (2bp each)
//   fee      → a separate USD debit on both legs (5bp of notional each)
// 2 x (5 + 2) = 14bp round trip, identical to what the family was scored on.
const PAPER_SLIP_BP = 2;
const PAPER_FEE_BP  = 5;

// ── BloFin market data (read-only) ──────────────────────────────────────────
// Added 2026-09-06. Everything above this line is computed from Binance; the
// venue the orders would actually go to is BloFin, and this project has already
// been burned once by assuming the two agree — the carry research measured
// BloFin funding at 6.22%/yr against Binance's 11.67%/yr, ~13pp apart and at
// one point opposite in sign. So the paper book now crosses BloFin's OWN book,
// and every cycle records BloFin's ticker/book/mark/funding next to the
// hypothesis readings so "did BloFin's market differ?" is answerable from the
// stored dataset rather than re-litigated.
//
// READ-ONLY BY CONSTRUCTION. This layer calls exactly four public market
// endpoints plus getBalance(), all GETs. It never calls placeOrder, placeTPSL,
// cancelOrder, cancelTPSL, setLeverage, setPositionMode or applyDemoMoney —
// those belong to maybeTrade(), which remains gated shut and separate.
//
// The demo balance is recorded FOR REFERENCE ONLY. Paper sizing runs off the
// independent $3,000 paper notional in state.paper and reads nothing from the
// exchange; if the balance read fails the paper book is unaffected.
const BLOFIN_BOOK_LEVELS = 5;
const BLOFIN_TRIES       = 3;   // the host's egress 403s intermittently — see blofinSnapshot()

// Composite gate. Chosen from the trigger distribution measured on the trailing
// 1,421 live bars (59 days) at build time:
//   n triggered per bar: 0 → 548, 1 → 551, 2 → 250, 3 → 63, 4 → 9
//   minN=1, agree>=0.60 →  790 bars (55.6%) — a single rule is not a composite
//   minN=2, agree>=0.60 →  239 bars (16.8%) — ~1 entry per 6 bars   ← chosen
//   minN=3, agree>=0.60 →   71 bars ( 5.0%) — ~1 entry per 20 bars
// At >=0.60 a 2-vote bar must be 2-0 (1/2 = 0.50 fails), a 3-vote bar 2-1, a
// 4-vote bar 3-1 — so split decisions are rejected rather than broken by a
// coin-flip tiebreak. These are activity-rate choices, not fitted parameters;
// nothing here was selected on outcomes, because no outcomes existed yet.
const PAPER_MIN_TRIGGERED = 2;
const PAPER_MIN_AGREEMENT = 0.60;

// Exit model. Single stop + single target + time stop, i.e. the v1 that the
// brief allows, not the live system's 3-rung TP ladder. Reason: the ladder's
// value is in partial fills and rung-burning against a real order book, and
// with no book to fill against, simulating it would add machinery whose
// realism it cannot actually deliver. The ladder's *spirit* — a structural
// stop, a defined R target, and a hard time-out — is kept.
const PAPER_TP_R = 2.0;              // target at +2R; stop is 1R by construction

// BloFin BTC-USDT granularity, hard-coded rather than fetched, so this layer has
// no exchange dependency at all: contractValue 0.001 BTC x lotSize 0.1 contracts.
const PAPER_LOT_BTC = 0.0001;

/**
 * One read-only snapshot of BloFin's own market, taken at the top of each cycle.
 *
 * Fails soft in every branch: a null snapshot degrades the paper book to the
 * pre-registered 2bp slippage model and the cycle continues. It never throws
 * into the readings pipeline, which was here first and does not depend on it.
 *
 * WHY THE RETRIES: this host's default route is intermittently a ProtonVPN
 * tunnel whose exit IP Cloudflare rejects, returning `http 403 <!DOCTYPE html>`
 * on signed and unsigned requests alike (see refactors/ + the 2026-07-10 and
 * 2026-08-03 incidents). Measured 2026-09-06 at build time: 1/6 success over
 * the tunnel, 6/6 over en0 in the same minute. Retrying lifts per-cycle
 * coverage; the real fix is operational (split-tunnel, or BLOFIN_BIND_INTERFACE
 * =en0 in .env, which lib/blofin.js now supports and which is OFF by default).
 * When all attempts fail the snapshot records `ok:false` and the reason, so a
 * gap in this dataset is always visible as a gap rather than as silence.
 */
async function blofinSnapshot() {
  const snap = {
    at: new Date(), instId: INST_ID, env: process.env.BLOFIN_ENV || 'demo',
    ok: false, error: null, attempts: 0,
    last: null, bid: null, ask: null, mid: null, bidSize: null, askSize: null,
    spread: null, spreadBps: null, halfSpreadBps: null,
    bookBid: null, bookAsk: null, bookSpreadBps: null, bookTs: null,
    markPrice: null, indexPrice: null,
    fundingRate: null, fundingIntervalHours: null, fundingAprPct: null,
    vol24h: null, high24h: null, low24h: null, tickerTs: null,
    // Binance's LIVE top of book, read in the same breath. A venue basis has to
    // compare two quotes taken at the same instant; comparing BloFin's live tick
    // against the 1h bar close (up to an hour stale) measures elapsed time, not
    // the venue gap, and would have written a junk number into the dataset.
    binanceBid: null, binanceAsk: null, binanceMid: null, binanceSpreadBps: null,
    basisBps: null, binanceQuoteError: null,
    account: { available: null, balance: null, frozen: null, error: null },
  };

  for (let i = 0; i < BLOFIN_TRIES; i++) {
    snap.attempts = i + 1;
    try {
      const [tk, bk, mp, fr] = await Promise.all([
        blofin.getTicker(INST_ID),
        blofin.getOrderBook(INST_ID, BLOFIN_BOOK_LEVELS),
        blofin.getMarkPrice(INST_ID),
        blofin.getFundingRate(INST_ID),
      ]);
      if (!tk) throw new Error('ticker returned no row');

      snap.last    = Number(tk.last);
      snap.bid     = Number(tk.bidPrice);
      snap.ask     = Number(tk.askPrice);
      snap.bidSize = Number(tk.bidSize);
      snap.askSize = Number(tk.askSize);
      snap.vol24h  = Number(tk.vol24h);
      snap.high24h = Number(tk.high24h);
      snap.low24h  = Number(tk.low24h);
      snap.tickerTs = Number(tk.ts);
      if (snap.bid > 0 && snap.ask > 0) {
        snap.mid           = (snap.bid + snap.ask) / 2;
        snap.spread        = snap.ask - snap.bid;
        snap.spreadBps     = (snap.spread / snap.mid) * 10_000;
        snap.halfSpreadBps = snap.spreadBps / 2;
      }
      if (bk?.asks?.length && bk?.bids?.length) {
        snap.bookAsk = Number(bk.asks[0][0]);
        snap.bookBid = Number(bk.bids[0][0]);
        snap.bookTs  = Number(bk.ts);
        const bmid = (snap.bookAsk + snap.bookBid) / 2;
        if (bmid > 0) snap.bookSpreadBps = ((snap.bookAsk - snap.bookBid) / bmid) * 10_000;
      }
      if (mp) { snap.markPrice = Number(mp.markPrice); snap.indexPrice = Number(mp.indexPrice); }
      if (fr) {
        snap.fundingRate = Number(fr.fundingRate);
        snap.fundingIntervalHours = Number(fr.fundingInterval) || 8;
        // Annualised for comparability with the Binance figure the carry work used.
        snap.fundingAprPct = snap.fundingRate * (24 / snap.fundingIntervalHours) * 365 * 100;
      }
      snap.ok = true;
      break;
    } catch (e) {
      snap.error = e.message;
      if (i < BLOFIN_TRIES - 1) await sleep(1500 * (i + 1));
    }
  }

  // Binance's live quote for the same instant, so `basisBps` is a venue
  // difference rather than a clock difference. Its own try: Binance being slow
  // must not void a BloFin snapshot we already hold.
  try {
    const bt = await j(`${BASE}/fapi/v1/ticker/bookTicker?symbol=${SYMBOL}`, 2);
    snap.binanceBid = Number(bt.bidPrice);
    snap.binanceAsk = Number(bt.askPrice);
    if (snap.binanceBid > 0 && snap.binanceAsk > 0) {
      snap.binanceMid = (snap.binanceBid + snap.binanceAsk) / 2;
      snap.binanceSpreadBps = ((snap.binanceAsk - snap.binanceBid) / snap.binanceMid) * 10_000;
      if (snap.ok && snap.mid > 0) {
        snap.basisBps = ((snap.mid - snap.binanceMid) / snap.binanceMid) * 10_000;
      }
    }
  } catch (e) { snap.binanceQuoteError = e.message; }

  // Reference only — never sizes anything. Separate try so a balance failure
  // cannot cost us the market snapshot we already have.
  try {
    const rows = await blofin.getBalance('futures');
    const usdt = (Array.isArray(rows) ? rows : []).find(r => r.currency === 'USDT');
    if (usdt) {
      snap.account.available = Number(usdt.available);
      snap.account.balance   = Number(usdt.balance);
      snap.account.frozen    = Number(usdt.frozen);
    } else {
      snap.account.error = 'no USDT row';
    }
  } catch (e) { snap.account.error = e.message; }

  log(snap.ok
    ? `blofin: last ${snap.last} bid ${snap.bid} ask ${snap.ask} spread ${snap.spreadBps?.toFixed(3)}bp mark ${snap.markPrice} funding ${snap.fundingAprPct?.toFixed(2)}%/yr · basis vs binance ${snap.basisBps == null ? 'n/a' : snap.basisBps.toFixed(2) + 'bp'} · demo avail ${snap.account.available ?? 'n/a'}`
    : `blofin: UNAVAILABLE after ${snap.attempts} attempts — ${snap.error}`);
  return snap;
}

/**
 * Slippage in bp to apply to a paper fill, and where the number came from.
 *
 * Rule: `max(BloFin's measured half-spread, the pre-registered 2bp)`.
 *   - Taking the max means BloFin's real book can only ever make the simulation
 *     MORE expensive, never cheaper. A venue quoting a 0.02bp top-of-book would
 *     otherwise silently hand the paper account a cost model far kinder than
 *     the one the 7-year family was scored on, and the P&L would stop being
 *     comparable to that backtest.
 *   - Crossing the spread is the honest floor of a market order's cost, not its
 *     whole cost — top-of-book depth is not walked here. Sizes are ~0.02 BTC
 *     against a book quoting whole BTC at the touch, so impact beyond level 1
 *     is not the binding term; if sizing ever grows this needs revisiting.
 */
function slipBpFor(bf) {
  const measured = bf?.ok && Number.isFinite(bf.halfSpreadBps) && bf.halfSpreadBps >= 0
    ? bf.halfSpreadBps : null;
  if (measured == null) return { bp: PAPER_SLIP_BP, source: 'model', measuredBp: null };
  const bp = Math.max(measured, PAPER_SLIP_BP);
  return { bp, source: bp === measured ? 'blofin-book' : 'model-floor', measuredBp: measured };
}

/**
 * Collapse the nine readings into ONE directional decision for ONE account.
 *
 * Nine uncorrelated toy strategies on one balance is not what an automation
 * looks like, so the readings vote instead. Only hypotheses that are both
 * triggered and directional this bar get a vote; quiet and n/a ones abstain
 * rather than counting as disagreement.
 *
 * Scoring follows the shape scripts/poly/btc-5/trigger-check.js already uses on
 * the Polymarket instrument (score the directions separately, take the winner,
 * require a threshold) — the pattern, not its thresholds, which are tuned for a
 * 5-minute binary market and would be meaningless here.
 */
function compositeSignal(readings) {
  const voters = readings.filter(r => r.triggered && (r.side === 'long' || r.side === 'short'));
  const longVotes  = voters.filter(r => r.side === 'long').length;
  const shortVotes = voters.filter(r => r.side === 'short').length;
  const n = voters.length;

  const majority  = longVotes === shortVotes ? null : (longVotes > shortVotes ? 'long' : 'short');
  const votes     = Math.max(longVotes, shortVotes);
  const agreement = n > 0 ? votes / n : 0;
  const pass      = !!majority && n >= PAPER_MIN_TRIGGERED && agreement >= PAPER_MIN_AGREEMENT;

  return {
    side: pass ? majority : null,
    nTriggered: n, longVotes, shortVotes, votes,
    agreement: Number(agreement.toFixed(3)),
    total: readings.length,
    drivers: voters.map(r => `${r.id}:${r.side}`),
    majorityDrivers: majority ? voters.filter(r => r.side === majority).map(r => r.id) : [],
  };
}

/** Lazily initialise the paper book on `state`. Persisted by saveState() like everything else. */
function paperBook() {
  if (!state.paper) {
    state.paper = {
      startEquity: PAPER_START_EQUITY, equity: PAPER_START_EQUITY,
      realizedPnl: 0, trades: 0, wins: 0, losses: 0,
      open: null, lastBarProcessed: null, startedAt: Date.now(),
    };
  }
  return state.paper;
}

const money = v => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const px    = v => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/**
 * Adverse slippage on a fill: a buy pays up, a sell gets hit down. `bp` comes
 * from slipBpFor() — BloFin's measured half-spread when the venue answered,
 * the pre-registered 2bp floor when it did not.
 */
function slipped(price, action, bp = PAPER_SLIP_BP) {
  const s = bp / 10_000;
  return action === 'buy' ? price * (1 + s) : price * (1 - s);
}

/**
 * The venue difference this project refuses to assume away: BloFin mid vs
 * Binance mid, both live, both sampled inside the same snapshot. Computed in
 * blofinSnapshot(); this is just the accessor.
 */
const venueBasisBps = bf => (bf?.ok && Number.isFinite(bf.basisBps)) ? bf.basisBps : null;

/**
 * BloFin's live last against the Binance BAR CLOSE the signal was computed
 * from. Explicitly NOT a basis — it is dominated by however long ago the bar
 * closed, so reading it as a venue gap would be wrong. It is recorded because
 * it IS the drift a paper entry priced at the bar close actually eats, which is
 * a real and separate cost question.
 */
function driftFromBarCloseBps(binanceClose, bf) {
  if (!bf?.ok || !(bf.last > 0) || !(binanceClose > 0)) return null;
  return ((bf.last - binanceClose) / binanceClose) * 10_000;
}

/**
 * Open a paper position at the close of the just-closed bar.
 *
 * Sizing uses the SAME config knobs as the real path (riskPerTradePct,
 * stopAtrMult, leverage, marginUtilCap) but against the paper balance. One
 * deliberate difference from maybeTrade(): where the real path posts a visible
 * SKIP when required margin breaches marginUtilCap, the paper book scales the
 * size DOWN to the largest that fits and records `sizeCappedByMargin`. A real
 * account going silent is a defect worth shouting about (audit A4); a paper
 * account going silent just stops showing the owner anything.
 */
async function paperOpen(book, comp, ctx, cfg, forcedSide, bf) {
  const side = forcedSide || comp.side;
  const stopDist = cfg.stopAtrMult * ctx.atr;
  if (!(stopDist > 0)) { log('paper: no ATR — cannot size to a stop'); return null; }

  const riskUsd = book.equity * (cfg.riskPerTradePct / 100);
  let sizeBtc = riskUsd / stopDist;

  // Margin cap, evaluated against the paper balance.
  const maxMargin = book.equity * cfg.marginUtilCap;
  const maxSizeBtc = (maxMargin * cfg.leverage) / ctx.close;
  const capped = sizeBtc > maxSizeBtc;
  if (capped) sizeBtc = maxSizeBtc;

  sizeBtc = Math.floor(sizeBtc / PAPER_LOT_BTC) * PAPER_LOT_BTC;
  if (sizeBtc < PAPER_LOT_BTC) { log(`paper: size ${sizeBtc} below lot ${PAPER_LOT_BTC} — no entry`); return null; }
  sizeBtc = Number(sizeBtc.toFixed(4));

  // Fill modelled against BloFin's own book, not a Binance-shaped guess.
  const slip = slipBpFor(bf);
  const entryPrice = slipped(ctx.close, side === 'long' ? 'buy' : 'sell', slip.bp);
  const notional   = sizeBtc * entryPrice;
  const entryFee   = notional * (PAPER_FEE_BP / 10_000);
  const stop   = side === 'long' ? entryPrice - stopDist : entryPrice + stopDist;
  const target = side === 'long' ? entryPrice + PAPER_TP_R * stopDist : entryPrice - PAPER_TP_R * stopDist;

  book.open = {
    id: `paper-${ctx.barOpen}-${side}`,
    side, sizeBtc, entryPrice, entrySignalPrice: ctx.close,
    entryBarOpen: ctx.barOpen, entryAt: Date.now(),
    stop, target, stopDist, riskUsd, notional, entryFee,
    leverage: cfg.leverage, marginUsd: notional / cfg.leverage,
    holdBars: cfg.holdBars, barsHeld: 0,
    equityAtEntry: book.equity,
    sizeCappedByMargin: capped,
    composite: comp, forced: !!forcedSide,
    // venue provenance for this fill
    entrySlipBp: slip.bp, entrySlipSource: slip.source, entryMeasuredHalfSpreadBp: slip.measuredBp,
    entryBlofin: bf?.ok ? {
      last: bf.last, bid: bf.bid, ask: bf.ask, mid: bf.mid, spreadBps: bf.spreadBps,
      markPrice: bf.markPrice, fundingAprPct: bf.fundingAprPct, ts: bf.tickerTs,
    } : null,
    entryVenueBasisBps: venueBasisBps(bf),
    entryDriftFromBarCloseBps: driftFromBarCloseBps(ctx.close, bf),
  };

  await post(side === 'long' ? 'long' : 'short', [
    `${MARK} · ${side === 'long' ? '📈' : '📉'} **OPENED ${side.toUpperCase()}**`,
    ``,
    // A forced entry has no composite behind it — saying "composite 0/9" would
    // be a false attribution on the one post most likely to be read as a signal.
    `opened ${side.toUpperCase()} ${sizeBtc.toFixed(4)} BTC @ ${px(entryPrice)} (${forcedSide ? '--paper-force, mechanism test' : `composite ${comp.votes}/${comp.total} ${side === 'long' ? 'bullish' : 'bearish'}`})`,
    `**Stop** ${px(stop)} · **Target** ${px(target)} (+${PAPER_TP_R.toFixed(1)}R) · **Time stop** ${cfg.holdBars} bars`,
    `**Risk** ${money(riskUsd)} (${cfg.riskPerTradePct}%) · **Notional** ${money(notional)} · **Margin** ${money(notional / cfg.leverage)} @ ${cfg.leverage}x`,
    `**Driving** ${comp.majorityDrivers.join(', ') || '—'}${comp.nTriggered > comp.votes ? ` (against ${comp.nTriggered - comp.votes})` : ''}`,
    bf?.ok
      ? `**BloFin** bid ${px(bf.bid)} / ask ${px(bf.ask)} · spread ${bf.spreadBps.toFixed(2)}bp · mark ${px(bf.markPrice)} · slip ${slip.bp.toFixed(2)}bp (${slip.source})`
      : `**BloFin** book unavailable — slip ${slip.bp.toFixed(2)}bp (model)`,
    `**Equity** ${money(book.equity)}`,
  ].join('\n'));

  log(`paper OPEN ${side} ${sizeBtc} BTC @ ${entryPrice.toFixed(1)} stop ${stop.toFixed(1)} target ${target.toFixed(1)}`);
  return book.open;
}

/** Close the open paper position, write the trade doc, post the alert. */
async function paperClose(book, exitRef, reason, ctx, bf) {
  const p = book.open;
  const exitSlip = slipBpFor(bf);
  const exitPrice = slipped(exitRef, p.side === 'long' ? 'sell' : 'buy', exitSlip.bp);
  const exitNotional = p.sizeBtc * exitPrice;
  const exitFee = exitNotional * (PAPER_FEE_BP / 10_000);
  const fees = p.entryFee + exitFee;

  const gross = p.side === 'long'
    ? (exitPrice - p.entryPrice) * p.sizeBtc
    : (p.entryPrice - exitPrice) * p.sizeBtc;
  const pnl = gross - fees;
  const pnlR   = p.riskUsd > 0 ? pnl / p.riskUsd : 0;
  const pnlPct = p.equityAtEntry > 0 ? (pnl / p.equityAtEntry) * 100 : 0;

  book.equity += pnl;
  book.realizedPnl += pnl;
  book.trades += 1;
  if (pnl >= 0) book.wins += 1; else book.losses += 1;

  const doc = {
    _id: p.id,
    mode: 'paper',                 // provenance tag — see the honesty note above
    engine: 'orderflow-composite', engineVersion: 1,
    symbol: SYMBOL, instId: INST_ID,
    side: p.side, sizeBtc: p.sizeBtc,
    entryPrice: p.entryPrice, entrySignalPrice: p.entrySignalPrice,
    entryBarOpen: p.entryBarOpen, entryAt: new Date(p.entryAt),
    exitPrice, exitRef, exitBarOpen: ctx.barOpen, exitAt: new Date(),
    exitReason: reason, barsHeld: p.barsHeld,
    stop: p.stop, target: p.target, stopDist: p.stopDist,
    riskUsd: p.riskUsd, notional: p.notional, leverage: p.leverage,
    marginUsd: p.marginUsd, sizeCappedByMargin: p.sizeCappedByMargin,
    grossPnlUsd: gross, feesUsd: fees,
    entryFeeUsd: p.entryFee, exitFeeUsd: exitFee,
    // Slippage is now per-leg and venue-sourced. `slippageModelBp` is the
    // pre-registered 2bp floor kept for comparability with the 7-year backtest;
    // the applied numbers are max(BloFin half-spread, floor) — see slipBpFor().
    slippageModelBp: PAPER_SLIP_BP, feeBpPerLeg: PAPER_FEE_BP,
    entrySlipBp: p.entrySlipBp ?? PAPER_SLIP_BP, entrySlipSource: p.entrySlipSource ?? 'model',
    exitSlipBp: exitSlip.bp, exitSlipSource: exitSlip.source,
    entryBlofin: p.entryBlofin ?? null,
    exitBlofin: bf?.ok ? {
      last: bf.last, bid: bf.bid, ask: bf.ask, mid: bf.mid, spreadBps: bf.spreadBps,
      markPrice: bf.markPrice, fundingAprPct: bf.fundingAprPct, ts: bf.tickerTs,
    } : null,
    entryVenueBasisBps: p.entryVenueBasisBps ?? null, exitVenueBasisBps: venueBasisBps(bf),
    entryDriftFromBarCloseBps: p.entryDriftFromBarCloseBps ?? null,
    exitDriftFromBarCloseBps: driftFromBarCloseBps(ctx.close, bf),
    realizedPnlUsd: pnl, pnlR, pnlPct,
    equityBefore: p.equityAtEntry, equityAfter: book.equity,
    // which hypotheses were driving it
    composite: p.composite, drivers: p.composite?.drivers ?? [],
    majorityDrivers: p.composite?.majorityDrivers ?? [],
    forced: !!p.forced,
    createdAt: new Date(),
  };
  try { (await paperTrades()).replaceOne({ _id: doc._id }, doc, { upsert: true }); }
  catch (e) { log(`paper trade write failed: ${e.message}`); }

  const reasonLabel = { stop: 'stop', target: 'target', time: `time stop (${p.holdBars} bars)`, manual: 'manual close' }[reason] || reason;
  await post(pnl >= 0 ? 'long' : 'short', [
    `${MARK} · ${pnl >= 0 ? '✅' : '🔻'} **CLOSED ${p.side.toUpperCase()}**`,
    ``,
    `closed ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))} (${pnl >= 0 ? '+' : '−'}${Math.abs(pnlPct).toFixed(2)}%), running P&L: ${book.realizedPnl >= 0 ? '+' : '−'}${money(Math.abs(book.realizedPnl))}`,
    `**Exit** ${reasonLabel} @ ${px(exitPrice)} · held ${p.barsHeld} bar${p.barsHeld === 1 ? '' : 's'} · ${pnlR >= 0 ? '+' : '−'}${Math.abs(pnlR).toFixed(2)}R`,
    `**Entry** ${px(p.entryPrice)} · ${p.sizeBtc.toFixed(4)} BTC · fees ${money(fees)}`,
    bf?.ok
      ? `**BloFin** bid ${px(bf.bid)} / ask ${px(bf.ask)} · spread ${bf.spreadBps.toFixed(2)}bp · exit slip ${exitSlip.bp.toFixed(2)}bp (${exitSlip.source})`
      : `**BloFin** book unavailable — exit slip ${exitSlip.bp.toFixed(2)}bp (model)`,
    `**Equity** ${money(book.equity)} · ${book.trades} trade${book.trades === 1 ? '' : 's'} · ${book.wins}W/${book.losses}L`,
  ].join('\n'));

  log(`paper CLOSE ${p.side} ${reason} @ ${exitPrice.toFixed(1)} pnl ${pnl.toFixed(2)} (${pnlR.toFixed(2)}R) equity ${book.equity.toFixed(2)}`);
  book.open = null;
  return doc;
}

/** Unrealised P&L of the open position at a given mark, net of both legs' fees. */
function paperUnrealised(p, mark) {
  if (!p) return 0;
  const gross = p.side === 'long'
    ? (mark - p.entryPrice) * p.sizeBtc
    : (p.entryPrice - mark) * p.sizeBtc;
  return gross - p.entryFee - (p.sizeBtc * mark * (PAPER_FEE_BP / 10_000));
}

/**
 * One paper bar: manage the open position against the bar that just closed,
 * then consider a new entry at its close. Exactly one position at a time —
 * mirroring BloFin's net position mode, where a fresh opposite entry would
 * silently close the existing one against its cost basis rather than hedge it
 * (CLAUDE.md, execution layer, one-direction book guard).
 */
async function paperCycle(readings, ctx, cfg, bf, opts = {}) {
  const book = paperBook();
  const comp = compositeSignal(readings);

  // Re-running the same bar (--probe / --once --force) must not double-count
  // barsHeld or re-enter. An explicit paper-force is the one intentional override.
  const replay = book.lastBarProcessed === ctx.barOpen;
  if (replay && !opts.forceSide && !opts.forceClose) {
    return { comp, book, skipped: 'bar already processed' };
  }

  let closed = null;
  if (book.open && !replay) book.open.barsHeld += 1;

  // ── manage the open position ───────────────────────────────────────────────
  if (book.open) {
    const p = book.open;
    if (opts.forceClose) {
      closed = await paperClose(book, ctx.close, 'manual', ctx, bf);
    } else if (!replay) {
      const stopHit = p.side === 'long' ? ctx.low <= p.stop : ctx.high >= p.stop;
      const tpHit   = p.side === 'long' ? ctx.high >= p.target : ctx.low <= p.target;
      // Both touched inside one bar and we have no intrabar path: assume the
      // stop first. Pessimistic by construction, and stated rather than hidden.
      if (stopHit)        closed = await paperClose(book, p.stop, 'stop', ctx, bf);
      else if (tpHit)     closed = await paperClose(book, p.target, 'target', ctx, bf);
      else if (p.barsHeld >= p.holdBars) closed = await paperClose(book, ctx.close, 'time', ctx, bf);
    }
  }

  // ── consider an entry ──────────────────────────────────────────────────────
  let opened = null;
  if (!book.open && (opts.forceSide || comp.side)) {
    opened = await paperOpen(book, comp, ctx, cfg, opts.forceSide, bf);
  }

  // ── mark to market, one equity point per bar ───────────────────────────────
  const unrealised = paperUnrealised(book.open, ctx.close);
  const equityMark = book.equity + unrealised;
  const eqDoc = {
    _id: `eq-1h-${ctx.barOpen}`,
    mode: 'paper',
    engine: 'orderflow-composite',
    symbol: SYMBOL, barOpen: ctx.barOpen, barOpenIso: new Date(ctx.barOpen).toISOString(),
    close: ctx.close,
    equity: equityMark, realisedEquity: book.equity,
    realizedPnlUsd: book.realizedPnl, unrealizedPnlUsd: unrealised,
    startEquity: book.startEquity,
    returnPct: book.startEquity > 0 ? ((equityMark - book.startEquity) / book.startEquity) * 100 : 0,
    trades: book.trades, wins: book.wins, losses: book.losses,
    position: book.open ? {
      side: book.open.side, sizeBtc: book.open.sizeBtc, entryPrice: book.open.entryPrice,
      stop: book.open.stop, target: book.open.target, barsHeld: book.open.barsHeld,
    } : null,
    composite: {
      side: comp.side, votes: comp.votes, nTriggered: comp.nTriggered,
      longVotes: comp.longVotes, shortVotes: comp.shortVotes,
      agreement: comp.agreement, drivers: comp.drivers,
    },
    // Venue truth at the mark. `close` above is Binance; these are BloFin's own
    // numbers for the same instant, kept side by side so the two can be diffed
    // rather than assumed equal.
    blofin: bf ? {
      ok: bf.ok, last: bf.last, bid: bf.bid, ask: bf.ask, mid: bf.mid,
      spreadBps: bf.spreadBps, markPrice: bf.markPrice, indexPrice: bf.indexPrice,
      fundingRate: bf.fundingRate, fundingAprPct: bf.fundingAprPct,
      binanceMid: bf.binanceMid, venueBasisBps: venueBasisBps(bf),
      driftFromBarCloseBps: driftFromBarCloseBps(ctx.close, bf), error: bf.error,
    } : null,
    createdAt: new Date(),
  };
  try { (await paperEquity()).replaceOne({ _id: eqDoc._id }, eqDoc, { upsert: true }); }
  catch (e) { log(`paper equity write failed: ${e.message}`); }

  book.lastBarProcessed = ctx.barOpen;
  return { comp, book, opened, closed, unrealised, equityMark };
}

/** One-line book status for the per-bar post. No hedging words by design. */
function renderBook(paper) {
  if (!paper) return null;
  const b = paper.book;
  const c = paper.comp;
  const eq = `**Equity** ${money(paper.equityMark ?? b.equity)} · ${b.realizedPnl >= 0 ? '+' : '−'}${money(Math.abs(b.realizedPnl))} realised · ${b.trades}T ${b.wins}W/${b.losses}L`;
  if (b.open) {
    const p = b.open;
    const u = paper.unrealised ?? 0;
    return [
      `**Open** ${p.side.toUpperCase()} ${p.sizeBtc.toFixed(4)} BTC @ ${px(p.entryPrice)} · ${u >= 0 ? '+' : '−'}${money(Math.abs(u))} · bar ${p.barsHeld}/${p.holdBars} · stop ${px(p.stop)} · target ${px(p.target)}`,
      eq,
    ].join('\n');
  }
  return [
    `**Flat** · composite ${c.side ? `${c.votes}/${c.total} ${c.side === 'long' ? 'bullish' : 'bearish'}` : `${c.nTriggered} triggered, no ${PAPER_MIN_TRIGGERED}+ majority`}`,
    eq,
  ].join('\n');
}

/** Resolve the actual fill by clientOrderId. Order history carries it; fills-history does not. */
async function resolveFill(clientOrderId, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await sleep(1000 * (i + 1));
    try {
      const rows = await blofin.getOrderHistory({ instId: INST_ID, clientOrderId });
      const o = (Array.isArray(rows) ? rows : []).find(x => x.clientOrderId === clientOrderId);
      if (o && Number(o.averagePrice) > 0) {
        return { fillPrice: Number(o.averagePrice), filledSize: Number(o.filledSize ?? o.size), filledAt: Number(o.updateTime || Date.now()) };
      }
    } catch (e) { log(`fill resolve attempt ${i + 1} failed: ${e.message}`); }
  }
  return null;
}

// ─── Mongo — new collections only ────────────────────────────────────────────

const signals = () => db.connect().then(d => d.collection('orderflow_experiment_signals'));
const orders  = () => db.connect().then(d => d.collection('orderflow_experiment_orders'));
const expState = () => db.connect().then(d => d.collection('orderflow_experiment_state'));

// Paper layer — separate collections on purpose. `orderflow_experiment_orders`
// is reserved for the dormant real-order path and must never receive a
// simulated fill; an analyst joining these two later would otherwise be unable
// to tell an exchange fill from a modelled one. Every doc written here carries
// `mode: "paper"`.
const paperTrades = () => db.connect().then(d => d.collection('orderflow_experiment_paper_trades'));
const paperEquity = () => db.connect().then(d => d.collection('orderflow_experiment_paper_equity'));

// BloFin's own market, one row per 1h bar. Kept as its own collection rather
// than only as a field on the signals doc so the venue-comparison question
// ("how far does BloFin drift from Binance, and when?") can be asked without
// dragging 9 hypothesis readings and a feature block along with every row.
// Read-only data: nothing in here was produced by an order.
const blofinMarket = () => db.connect().then(d => d.collection('orderflow_experiment_blofin_market'));

// ─── the cycle ───────────────────────────────────────────────────────────────

async function cycle({ force = false, paperForceSide = null, paperForceClose = false } = {}) {
  const cfg = loadConfig();

  const k1 = await klines('1h', BARS_1H);
  if (k1.length < W + 60) throw new Error(`only ${k1.length} closed 1h bars — need > ${W + 60}`);
  const barOpen = k1[k1.length - 1].t;
  if (!force && state.lastBarPosted === barOpen) return { skipped: 'already posted' };

  const F  = buildFeatures(k1);
  const VB = volumeBucketVpin(k1, F);

  let F4 = null, oiArr = null;
  try {
    const k4 = await klines('4h', BARS_4H);
    F4 = buildFeatures(k4);
    const oi = await openInterestHist('4h');
    const m = new Map(oi.map(r => [r.t, r.oi]));
    oiArr = k4.map(b => m.has(b.t) ? m.get(b.t) : null);
  } catch (e) {
    log(`4h/OI leg unavailable (H5 will read invalid): ${e.message}`);
  }

  const t = F.n - 1;
  const readings = readAll(F, VB, F4, oiArr);
  const ctx = { barOpen, close: F.C[t], atr: F.atr[t], high: F.H[t], low: F.L[t] };

  // Order path. With the gate shut every reading returns 'observed'; the
  // per-bar post below still shows exactly which ones WOULD have fired, so a
  // dormant would-fire is never invisible.
  const actions = [];
  for (const rd of readings) {
    if (!rd.triggered) continue;
    const res = await maybeTrade(rd, ctx, cfg);
    actions.push({ id: rd.id, ...res });
  }

  // BloFin's own market, read-only. Fails soft: a null/!ok snapshot degrades
  // the paper fill model to the pre-registered 2bp and records the gap.
  let bf = null;
  try { bf = await blofinSnapshot(); }
  catch (e) { log(`blofin snapshot threw (paper falls back to model slippage): ${e.message}`); }

  // Paper layer — always on, independent of cfg.tradingEnabled, and incapable
  // of reaching the exchange with a WRITE. Wrapped so a paper fault can never
  // take down the readings pipeline that was here first.
  let paper = null;
  try {
    paper = await paperCycle(readings, ctx, cfg, bf, { forceSide: paperForceSide, forceClose: paperForceClose });
  } catch (e) {
    log(`paper layer error (readings unaffected): ${e.stack || e.message}`);
  }

  if (bf) {
    const mktDoc = {
      _id: `bf-1h-${barOpen}`,
      barOpen, barOpenIso: new Date(barOpen).toISOString(),
      instId: INST_ID, env: bf.env, ok: bf.ok, attempts: bf.attempts, error: bf.error,
      last: bf.last, bid: bf.bid, ask: bf.ask, mid: bf.mid,
      bidSize: bf.bidSize, askSize: bf.askSize,
      spread: bf.spread, spreadBps: bf.spreadBps, halfSpreadBps: bf.halfSpreadBps,
      bookBid: bf.bookBid, bookAsk: bf.bookAsk, bookSpreadBps: bf.bookSpreadBps, bookTs: bf.bookTs,
      markPrice: bf.markPrice, indexPrice: bf.indexPrice,
      fundingRate: bf.fundingRate, fundingIntervalHours: bf.fundingIntervalHours,
      fundingAprPct: bf.fundingAprPct,
      vol24h: bf.vol24h, high24h: bf.high24h, low24h: bf.low24h, tickerTs: bf.tickerTs,
      // Binance side. `binanceBid/Ask/Mid` are the live quote sampled inside the
      // same snapshot — that pairing is what makes venueBasisBps a basis.
      // `binanceClose` is the 1h bar the signal was computed from, and the drift
      // against it is a lag measure, deliberately named so nobody reads it as basis.
      binanceBid: bf.binanceBid, binanceAsk: bf.binanceAsk, binanceMid: bf.binanceMid,
      binanceSpreadBps: bf.binanceSpreadBps, binanceQuoteError: bf.binanceQuoteError,
      venueBasisBps: venueBasisBps(bf),
      binanceClose: F.C[t], driftFromBarCloseBps: driftFromBarCloseBps(F.C[t], bf),
      // Reference only — the paper book never sizes off this.
      demoAccount: bf.account,
      readOnly: true, createdAt: new Date(),
    };
    try { (await blofinMarket()).replaceOne({ _id: mktDoc._id }, mktDoc, { upsert: true }); }
    catch (e) { log(`blofin market doc write failed: ${e.message}`); }
  }

  const fired = readings.filter(r => r.triggered);
  const doc = {
    _id: `1h-${barOpen}`,
    interval: '1h', symbol: SYMBOL, barOpen, barOpenIso: new Date(barOpen).toISOString(),
    close: F.C[t], atr14: F.atr[t],
    features: {
      pLam: F.pLam[t], pAbsFn: F.pAbsFn[t], pFn: F.pFn[t], pVol: F.pVol[t],
      pAbsD: F.pAbsD[t], pVpin: F.pVpin[t], pVpinVB: VB.pVpinVB[t], pAbsR: F.pAbsR[t],
      delta: F.delta[t], Fn: F.Fn[t], lambda: F.lam[t],
      poc: F.poc[t], vah: F.vah[t], val: F.val[t],
      ema50: F.ema50[t], ema200: F.ema200[t],
    },
    readings, anyTriggered: fired.length > 0, nTriggered: fired.length,
    tradingEnabled: cfg.tradingEnabled, liveHypothesis: cfg.hypothesis,
    breaker: breakerStatus(), actions,
    // Composite decision + paper book snapshot. Recorded on the signals doc so
    // the bar's readings and the decision taken from them stay joined.
    composite: paper ? paper.comp : null,
    paper: paper ? {
      mode: 'paper', equity: paper.equityMark, realizedPnl: paper.book.realizedPnl,
      openSide: paper.book.open?.side ?? null, opened: !!paper.opened, closed: !!paper.closed,
    } : null,
    // BloFin's own market at this bar, read-only. Joined here so a single
    // signals row carries both the Binance-derived readings and the venue truth
    // they would have been executed against; the full row lives in
    // orderflow_experiment_blofin_market.
    blofin: bf ? {
      ok: bf.ok, error: bf.error, last: bf.last, bid: bf.bid, ask: bf.ask,
      spreadBps: bf.spreadBps, markPrice: bf.markPrice, indexPrice: bf.indexPrice,
      fundingRate: bf.fundingRate, fundingAprPct: bf.fundingAprPct,
      binanceMid: bf.binanceMid, venueBasisBps: venueBasisBps(bf),
      driftFromBarCloseBps: driftFromBarCloseBps(F.C[t], bf),
      demoAvailable: bf.account.available,
    } : null,
    engineVersion: 2, createdAt: new Date(),
  };
  const sig = await signals();
  await sig.replaceOne({ _id: doc._id }, doc, { upsert: true });

  await post(fired.length ? 'info' : 'info', renderBar(doc, cfg, paper, bf));

  state.lastBarPosted = barOpen;
  state.barsProcessed = (state.barsProcessed || 0) + 1;
  state.triggersSeen = (state.triggersSeen || 0) + fired.length;
  state.lastError = null;
  saveState();
  try { (await expState()).replaceOne({ _id: 'runtime' }, { _id: 'runtime', ...state }, { upsert: true }); } catch {}

  return { barOpen, fired: fired.map(f => f.id), doc, paper, blofin: bf };
}

function renderBar(doc, cfg, paper, bf) {
  const f = doc.features;
  const pct = v => v == null ? ' — ' : `P${Math.round(v)}`;
  const rows = doc.readings.map(r => {
    const tag = !r.valid ? '·  n/a'
      : r.triggered ? (r.side === 'long' ? '🟢 LONG ' : '🔴 SHORT') : '·  quiet';
    return `\`${r.id.padEnd(6)}\` ${tag}  ${r.name}`;
  });
  const fired = doc.readings.filter(r => r.triggered);
  return [
    `${MARK} · 1h bar close ${new Date(doc.barOpen).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `**BTCUSDT** $${doc.close.toLocaleString('en-US', { maximumFractionDigits: 0 })} · ATR14 $${doc.atr14?.toFixed(0) ?? '—'}`,
    `λ ${pct(f.pLam)} · |Fn| ${pct(f.pAbsFn)} · vol ${pct(f.pVol)} · |δ| ${pct(f.pAbsD)} · VPIN(vb) ${pct(f.pVpinVB)}`,
    ``,
    ...rows,
    ``,
    fired.length
      ? `**${fired.length} triggered** — ${fired.map(r => `${r.id} ${r.side}`).join(', ')}. No exchange order: ${cfg.tradingEnabled ? `live hypothesis is ${cfg.hypothesis || 'unset'}` : 'trading gate closed'}.`
      : `No hypothesis triggered.`,
    // Book line. Deliberately free of hedging words — the provenance tag lives
    // on the stored documents (`mode: "paper"`), per the honesty note in code.
    ...(renderBook(paper) ? ['', renderBook(paper)] : []),
    ...(bf ? [bf.ok
      ? `**BloFin** ${px(bf.last)} · bid ${px(bf.bid)} / ask ${px(bf.ask)} · spread ${bf.spreadBps.toFixed(3)}bp · mark ${px(bf.markPrice)} · funding ${bf.fundingAprPct >= 0 ? '+' : '−'}${Math.abs(bf.fundingAprPct).toFixed(2)}%/yr · basis vs Binance ${venueBasisBps(bf) == null ? 'n/a' : `${venueBasisBps(bf) >= 0 ? '+' : '−'}${Math.abs(venueBasisBps(bf)).toFixed(2)}bp`} · demo avail ${bf.account.available == null ? 'n/a' : money(bf.account.available)}`
      : `**BloFin** market read unavailable (${bf.attempts} attempts) — \`${String(bf.error).slice(0, 90)}\``] : []),
    `_Readings above are the 2026-09-06 pre-registered family, which cleared none of the eight on 7y of history._`,
  ].join('\n');
}

async function heartbeat() {
  if (Date.now() - (state.lastHeartbeatAt || 0) < HEARTBEAT_MS) return;
  state.lastHeartbeatAt = Date.now();
  saveState();
  const up = ((Date.now() - state.startedAt) / 3600_000).toFixed(1);
  const b = paperBook();
  const ret = b.startEquity > 0 ? ((b.equity - b.startEquity) / b.startEquity) * 100 : 0;
  await post('info', [
    `${MARK} · 💓 heartbeat`,
    `Up ${up}h · ${state.barsProcessed || 0} bars scored · ${state.triggersSeen || 0} hypothesis triggers observed`,
    `Trading gate: **${loadConfig().tradingEnabled ? 'OPEN' : 'closed'}** · orders placed ${state.ordersPlaced || 0} · skipped ${state.ordersSkipped || 0}`,
    `**Equity** ${money(b.equity)} (${ret >= 0 ? '+' : '−'}${Math.abs(ret).toFixed(2)}% from ${money(b.startEquity)}) · ${b.trades} trades · ${b.wins}W/${b.losses}L${b.open ? ` · open ${b.open.side.toUpperCase()} ${b.open.sizeBtc.toFixed(4)} BTC` : ' · flat'}`,
  ].join('\n'));
}

// ─── entrypoints ─────────────────────────────────────────────────────────────

async function probe() {
  log('PROBE — end-to-end self-check');
  const cfg = loadConfig();
  log(`config: tradingEnabled=${cfg.tradingEnabled} hypothesis=${cfg.hypothesis}`);
  log(`breaker: ${JSON.stringify(breakerStatus())}`);

  const k1 = await klines('1h', BARS_1H);
  log(`binance 1h: ${k1.length} closed bars, last ${new Date(k1[k1.length - 1].t).toISOString()} close $${k1[k1.length - 1].c}`);

  const r = await cycle({ force: true });
  log(`cycle: bar ${new Date(r.barOpen).toISOString()} · triggered [${r.fired.join(', ') || 'none'}]`);

  const sig = await signals();
  const back = await sig.findOne({ _id: `1h-${r.barOpen}` });
  log(`mongo readback: _id=${back._id} readings=${back.readings.length} anyTriggered=${back.anyTriggered}`);
  for (const rd of back.readings) log(`   ${rd.id.padEnd(6)} valid=${String(rd.valid).padEnd(5)} trig=${String(rd.triggered).padEnd(5)} side=${rd.side || '-'}`);

  log('probe complete');
  await db.disconnect();
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--status')) {
    const s = readJson(STATE_FILE, null);
    if (!s) { console.error('no state yet'); process.exit(1); }
    console.log(JSON.stringify({ ...s, config: loadConfig(), breaker: breakerStatus() }, null, 2));
    const p = s.paper;
    if (p) {
      const ret = p.startEquity > 0 ? ((p.equity - p.startEquity) / p.startEquity) * 100 : 0;
      console.log(`\npaper book — equity ${money(p.equity)} (${ret >= 0 ? '+' : '−'}${Math.abs(ret).toFixed(2)}%) · ` +
        `${p.trades} trades ${p.wins}W/${p.losses}L · ` +
        (p.open ? `OPEN ${p.open.side.toUpperCase()} ${p.open.sizeBtc} BTC @ ${px(p.open.entryPrice)} (bar ${p.open.barsHeld}/${p.open.holdBars})` : 'flat'));
    }
    const age = (Date.now() - (s.updatedAt || 0)) / 60000;
    console.log(`\nlast cycle ${age.toFixed(0)} min ago — ${age < 90 ? 'HEALTHY' : 'STALE'}`);
    process.exit(age < 90 ? 0 : 1);
  }

  // Read-only venue probe. Confirms the BloFin market paths still answer and
  // prints the raw shapes, so a future 403/shape change is diagnosed in one
  // command instead of by reading a null in Mongo three days later.
  if (argv.includes('--blofin-probe')) {
    const bf = await blofinSnapshot();
    console.log(JSON.stringify(bf, null, 2));
    process.exit(bf.ok ? 0 : 1);
  }

  if (argv.includes('--probe')) { await probe(); process.exit(0); }

  if (argv.includes('--once')) {
    // --paper-force=long|short and --paper-close are mechanism-verification
    // levers for the PAPER book only. They cannot reach the exchange: neither
    // touches maybeTrade(), cfg.tradingEnabled or cfg.hypothesis.
    const fArg = argv.find(a => a.startsWith('--paper-force='));
    const paperForceSide = fArg ? fArg.split('=')[1] : null;
    if (paperForceSide && !['long', 'short'].includes(paperForceSide)) {
      console.error('--paper-force must be long or short'); process.exit(1);
    }
    const r = await cycle({
      force: argv.includes('--force') || !!paperForceSide || argv.includes('--paper-close'),
      paperForceSide,
      paperForceClose: argv.includes('--paper-close'),
    });
    log(JSON.stringify(r.skipped ? r : {
      barOpen: r.barOpen, fired: r.fired,
      composite: r.paper?.comp?.side ?? null,
      opened: r.paper?.opened?.id ?? null,
      closed: r.paper?.closed?._id ?? null,
      equity: r.paper?.book?.equity ?? null,
    }));
    await db.disconnect();
    process.exit(0);
  }

  log(`order-flow experiment engine starting · gate ${loadConfig().tradingEnabled ? 'OPEN' : 'CLOSED'}`);
  state.startedAt = state.startedAt || Date.now();
  saveState();

  const tick = async () => {
    try {
      // Only act once a 1h bar has closed and Binance has had a moment to settle it.
      const now = Date.now();
      const lastClose = Math.floor(now / MS['1h']) * MS['1h'];
      if (now - lastClose < BAR_LAG_MS) return;
      await cycle();
      await heartbeat();
    } catch (e) {
      log(`cycle error: ${e.message}`);
      state.lastError = { at: Date.now(), message: e.message };
      saveState();
    }
  };

  await tick();
  setInterval(tick, POLL_MS);
}

// Exported so the port can be diffed against the original backtest engine on
// its own dataset (see refactors/2026-09-06-orderflow-experiment-engine.md).
// Requiring this file must never start the loop.
module.exports = {
  buildFeatures, volumeBucketVpin, hypotheses1h, hypothesis5, readAll,
  trailingPctile, trailingMedian, ema, klines, openInterestHist,
  HYPOTHESIS_IDS, W, VPW, VPIN_N,
  // paper layer
  compositeSignal, paperUnrealised, slipped, slipBpFor,
  venueBasisBps, driftFromBarCloseBps,
  PAPER_START_EQUITY, PAPER_MIN_TRIGGERED, PAPER_MIN_AGREEMENT,
  PAPER_SLIP_BP, PAPER_FEE_BP, PAPER_TP_R,
  // blofin read-only venue layer
  blofinSnapshot,
};

if (require.main === module) {
  // Exit WITHOUT writing state. The daemon's in-memory `state` is a snapshot
  // taken at module load; anything written to the file since (a `--once` run,
  // a `--paper-force` verification, a hand edit) is NOT in it. Saving on the
  // way out therefore overwrites newer on-disk state with older memory —
  // observed 2026-09-06, when a `pm2 restart` destroyed a freshly-seeded paper
  // book on exit. Nothing is lost by skipping it: cycle() already saves at the
  // end of every completed cycle and on every error, so the file is never more
  // than one cycle behind.
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { log(`${s} — exiting (state left as-is on disk)`); process.exit(0); });
  main().catch(e => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
}
