'use strict';

/**
 * Daily realized R + kill switch (rebuild spec 04.3, audit D7/R5/R10).
 *
 * The old switch summed ledger pnlR — a ledger that booked +1.2R/trade of
 * fictional fills could never reach −3R while the exchange account bled
 * (D7: three consecutive negative weeks, breaker inert). Re-anchored:
 *
 * PRIMARY — exchange-realized net R today (UTC) from BloFin orders-history
 * (durable server-side truth, survives local state loss — R10). Sum of
 * (pnl − fee) over today's filled orders; each order's contribution is
 * divided by its signal's actual dollar risk (spec-03 `riskPerUnit` × the
 * entry order's filled size), resolved via the deterministic entry
 * clientOrderId and, best-effort, the Mongo `blofin_orders` orderId→signalId
 * join. Orders that cannot be attributed divide by the standing risk budget
 * (equity × RISK_PER_TRADE_PCT) so unmatched losses still count against the
 * floor rather than vanishing.
 *
 * FALLBACK — if the BloFin API is unreachable, use the corrected ledger's
 * pnlR for trades closed today (post-spec-03 the ledger is honest money,
 * net of fees) and post a YELLOW alert that the kill switch is running on
 * fallback (rate-limited to one per 30 min via .daily-r-alert.json).
 *
 * DAILY_R_KILL_FLOOR = −3.0 unchanged — no evidence-based reason to move it;
 * threshold re-tuning is out of scope until spec 07's sample bar
 * (≥150 post-fix signals, ≥60 days, ≥2 regimes).
 *
 * Consumers:
 *   - trigger-check.js signal gate: `await isKillActive()` (primary path)
 *   - blofin-autotrade.js defense-in-depth gate: sync `todayUtcR()`
 *     (ledger measure — intentionally kept synchronous; the async primary
 *     already gated the signal upstream)
 */

const fs   = require('fs');
const path = require('path');

const ROOT        = path.resolve(__dirname, '..', '..');
const TRADES_FILE = path.join(ROOT, 'trades.json');
const ALERT_FILE  = path.join(ROOT, '.daily-r-alert.json');

const DAILY_R_KILL_FLOOR = -3.0;

const INST_ID            = 'BTC-USDT';
const CONTRACT_VALUE_BTC = 0.001; // BloFin BTC-USDT-PERP contract size
const FALLBACK_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

function utcMidnightMs(nowMs) {
  const d = new Date(nowMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function readTradesFile() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; }
}

// ─── Fallback measure: corrected ledger, today's closed trades ───────────────

function todayUtcR() {
  try {
    const cutoff = utcMidnightMs(Date.now());
    return readTradesFile().reduce((sum, t) => {
      if (!t.closedAt || t.pnlR == null) return sum;
      const ms = new Date(t.closedAt).getTime();
      return ms >= cutoff ? sum + t.pnlR : sum;
    }, 0);
  } catch { return 0; }
}

// ─── Primary measure: exchange orders-history ────────────────────────────────

// signalId → exchange-legal clientOrderId (mirrors blofin-autotrade.js).
function clientOrderIdFor(signalId) {
  return String(signalId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

function defaultRiskUsd() {
  const equity  = Number(process.env.ACCOUNT_EQUITY_USD);
  const riskPct = Number(process.env.RISK_PER_TRADE_PCT || 1.0);
  if (!Number.isFinite(equity) || equity <= 0) return null;
  return equity * (riskPct / 100);
}

/**
 * Exchange-realized net R for the current UTC day. Throws when the BloFin
 * API is unreachable — the caller decides on fallback.
 *
 * `deps` is test-injectable: { getOrderHistory, readTrades, lookupSignalIds,
 * now }. lookupSignalIds(orderIds) → Map(orderId → signalId) may reject or
 * be absent — Mongo is best-effort here, never load-bearing.
 */
async function todayExchangeR(deps = {}) {
  const getOrderHistory = deps.getOrderHistory
    || (q => require('./blofin').getOrderHistory(q));
  const readTrades = deps.readTrades || readTradesFile;
  const nowMs   = deps.now ? deps.now() : Date.now();
  const cutoff  = utcMidnightMs(nowMs);

  // Page newest-first until a page reaches back past UTC midnight.
  const orders = [];
  let after;
  for (let page = 0; page < 10; page++) {
    const batch = await getOrderHistory({ instId: INST_ID, limit: 100, after });
    if (!Array.isArray(batch) || batch.length === 0) break;
    orders.push(...batch);
    const oldest = batch.reduce((m, o) => Math.min(m, +o.createTime || Infinity), Infinity);
    if (oldest < cutoff || batch.length < 100) break;
    after = batch[batch.length - 1].orderId;
  }

  const FILLED = new Set(['filled', 'partially_filled', 'partial_filled']);
  const filledToday = orders.filter(o => {
    if (!FILLED.has(String(o.state).toLowerCase())) return false;
    const ts = +o.updateTime || +o.createTime || 0;
    return ts >= cutoff && ts <= nowMs;
  });
  if (filledToday.length === 0) return 0;

  // Attribute orders → signals. Entry orders carry our deterministic
  // clientOrderId; exits resolve via Mongo when it's up.
  const trades = readTrades();
  const byCid = new Map();
  for (const t of trades) byCid.set(clientOrderIdFor(t.id), t);

  const sigByOrderId = new Map();
  const unmatchedIds = filledToday
    .filter(o => !(o.clientOrderId && byCid.has(o.clientOrderId)))
    .map(o => String(o.orderId));
  if (unmatchedIds.length) {
    try {
      const lookup = deps.lookupSignalIds || defaultLookupSignalIds;
      const found = await lookup(unmatchedIds);
      if (found) for (const [oid, sig] of found) sigByOrderId.set(String(oid), sig);
    } catch (_) { /* Mongo down — unattributed orders use the default budget */ }
  }

  const byId = new Map(trades.map(t => [t.id, t]));
  // Per-signal dollar risk: spec-03 riskPerUnit × the signal's filled entry
  // size (contracts × 0.001 BTC). Falls back to |entry − stop| for
  // pre-rewrite records, then to the standing budget.
  const riskUsdForSignal = (t, entryOrder) => {
    const perUnit = t?.riskPerUnit != null ? t.riskPerUnit
      : (t && t.entry != null && t.stop != null ? Math.abs(t.entry - t.stop) : null);
    const sizeBtc = entryOrder ? (Number(entryOrder.filledSize) || 0) * CONTRACT_VALUE_BTC : 0;
    if (perUnit > 0 && sizeBtc > 0) return perUnit * sizeBtc;
    // Entry filled on a previous day (only exits today): use the risk the
    // daily attribution job persisted for this signal, if present.
    if (t?.exchangeRiskUsd > 0) return t.exchangeRiskUsd;
    return defaultRiskUsd();
  };

  // Group today's flow per signal so one riskUsd divides one net.
  const groups = new Map(); // signalId|'__unmatched' → { netUsd, entryOrder, trade }
  for (const o of filledToday) {
    let sig = null;
    if (o.clientOrderId && byCid.has(o.clientOrderId)) sig = byCid.get(o.clientOrderId).id;
    else if (sigByOrderId.has(String(o.orderId)))      sig = sigByOrderId.get(String(o.orderId));
    const key = sig || '__unmatched';
    if (!groups.has(key)) groups.set(key, { netUsd: 0, entryOrder: null, trade: sig ? byId.get(sig) || byCid.get(o.clientOrderId) : null });
    const g = groups.get(key);
    g.netUsd += (+o.pnl || 0) - (+o.fee || 0);
    if (sig && o.clientOrderId && byCid.has(o.clientOrderId)) g.entryOrder = o;
  }

  let totalR = 0;
  for (const [key, g] of groups) {
    const riskUsd = key === '__unmatched' ? defaultRiskUsd() : riskUsdForSignal(g.trade, g.entryOrder);
    if (!(riskUsd > 0)) continue; // no sizing configured — nothing sensible to divide by
    totalR += g.netUsd / riskUsd;
  }
  return totalR;
}

async function defaultLookupSignalIds(orderIds) {
  const db = require('./db');
  await db.connect();
  const docs = await db.blofinOrders()
    .find({ orderId: { $in: orderIds }, signalId: { $ne: null } })
    .project({ orderId: 1, signalId: 1 })
    .toArray();
  return new Map(docs.map(d => [String(d.orderId), d.signalId]));
}

// ─── Fallback alert (yellow, rate-limited) ───────────────────────────────────

function postFallbackAlert(errMsg, deps = {}) {
  try {
    const alertFile = deps.alertFile || ALERT_FILE;
    const st = (() => { try { return JSON.parse(fs.readFileSync(alertFile, 'utf8')); } catch { return {}; } })();
    if (st.lastFallbackAlertAt && Date.now() - st.lastFallbackAlertAt < FALLBACK_ALERT_COOLDOWN_MS) return;
    st.lastFallbackAlertAt = Date.now();
    fs.writeFileSync(alertFile, JSON.stringify(st));

    const post = deps.postAlert || ((body) => {
      const webhook = process.env.DISCORD_WEBHOOK_URL;
      if (!webhook) return;
      const { postWebhook } = require('./discord');
      return postWebhook(webhook, 'approaching', body,
        `Daily-R kill switch · ${new Date().toUTCString().slice(5, 25)} UTC`);
    });
    const body = [
      `⚠️ **DAILY-R KILL SWITCH ON FALLBACK — EXCHANGE UNREACHABLE**`,
      `Today's R is being measured from the corrected ledger instead of BloFin orders-history.`,
      ``,
      `**Error** \`${String(errMsg).split('\n')[0].slice(0, 200)}\``,
      `**Action** Check BloFin API reachability / VPN egress (Cloudflare-403 class). One alert per 30 min.`,
    ].join('\n');
    Promise.resolve(post(body)).catch(() => {});
  } catch (_) { /* alerting must never break the gate */ }
}

// ─── Kill switch ─────────────────────────────────────────────────────────────

/**
 * Async, never throws. Returns { active, todayR, source } where source is
 * 'exchange' (primary) or 'ledger-fallback' (API unreachable — yellow alert
 * posted, rate-limited).
 */
async function isKillActive(deps = {}) {
  try {
    const r = await todayExchangeR(deps);
    return { active: r <= DAILY_R_KILL_FLOOR, todayR: r, source: 'exchange' };
  } catch (e) {
    postFallbackAlert(e.message || e, deps);
    const r = todayUtcR();
    return { active: r <= DAILY_R_KILL_FLOOR, todayR: r, source: 'ledger-fallback' };
  }
}

module.exports = { DAILY_R_KILL_FLOOR, todayUtcR, todayExchangeR, isKillActive };
