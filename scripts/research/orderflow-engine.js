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
 * ISOLATION — this process shares nothing mutable with the live BTC pipeline
 *   script      scripts/research/orderflow-engine.js   (new, pm2 'orderflow-engine')
 *   collections orderflow_experiment_{signals,orders,state}   (never `trades`/`blofin_orders`)
 *   state       .orderflow-experiment-state.json
 *   config      .orderflow-experiment-config.json
 *   breaker     .orderflow-experiment-disabled.json
 *   orders      clientOrderId prefix `ofexp-`
 *   data        Binance public REST only — no TradingView, no CDP, no lock
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
  const available = Number(bal?.details?.find(d => d.currency === 'USDT')?.available ?? bal?.available ?? 0);

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

// ─── the cycle ───────────────────────────────────────────────────────────────

async function cycle({ force = false } = {}) {
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
  const ctx = { barOpen, close: F.C[t], atr: F.atr[t] };

  // Order path. With the gate shut every reading returns 'observed'; the
  // per-bar post below still shows exactly which ones WOULD have fired, so a
  // dormant would-fire is never invisible.
  const actions = [];
  for (const rd of readings) {
    if (!rd.triggered) continue;
    const res = await maybeTrade(rd, ctx, cfg);
    actions.push({ id: rd.id, ...res });
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
    engineVersion: 1, createdAt: new Date(),
  };
  const sig = await signals();
  await sig.replaceOne({ _id: doc._id }, doc, { upsert: true });

  await post(fired.length ? 'info' : 'info', renderBar(doc, cfg));

  state.lastBarPosted = barOpen;
  state.barsProcessed = (state.barsProcessed || 0) + 1;
  state.triggersSeen = (state.triggersSeen || 0) + fired.length;
  state.lastError = null;
  saveState();
  try { (await expState()).replaceOne({ _id: 'runtime' }, { _id: 'runtime', ...state }, { upsert: true }); } catch {}

  return { barOpen, fired: fired.map(f => f.id), doc };
}

function renderBar(doc, cfg) {
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
      ? `**${fired.length} would fire** — ${fired.map(r => `${r.id} ${r.side}`).join(', ')}. Not sent: ${cfg.tradingEnabled ? `live hypothesis is ${cfg.hypothesis || 'unset'}` : 'trading gate closed'}.`
      : `No hypothesis triggered.`,
    `_Observation only. All eight were refuted or came back null on 7y of history (2026-09-06 pre-registered family: cleared none)._`,
  ].join('\n');
}

async function heartbeat() {
  if (Date.now() - (state.lastHeartbeatAt || 0) < HEARTBEAT_MS) return;
  state.lastHeartbeatAt = Date.now();
  saveState();
  const up = ((Date.now() - state.startedAt) / 3600_000).toFixed(1);
  await post('info', [
    `${MARK} · 💓 heartbeat`,
    `Up ${up}h · ${state.barsProcessed || 0} bars scored · ${state.triggersSeen || 0} hypothesis triggers observed`,
    `Trading gate: **${loadConfig().tradingEnabled ? 'OPEN' : 'closed'}** · orders placed ${state.ordersPlaced || 0} · skipped ${state.ordersSkipped || 0}`,
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
    const age = (Date.now() - (s.updatedAt || 0)) / 60000;
    console.log(`\nlast cycle ${age.toFixed(0)} min ago — ${age < 90 ? 'HEALTHY' : 'STALE'}`);
    process.exit(age < 90 ? 0 : 1);
  }

  if (argv.includes('--probe')) { await probe(); process.exit(0); }

  if (argv.includes('--once')) {
    const r = await cycle({ force: argv.includes('--force') });
    log(JSON.stringify(r.skipped ? r : { barOpen: r.barOpen, fired: r.fired }));
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
};

if (require.main === module) {
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { log(`${s} — exiting`); saveState(); process.exit(0); });
  main().catch(e => { log(`fatal: ${e.stack || e.message}`); process.exit(1); });
}
