#!/usr/bin/env node
'use strict';

/**
 * attribution.js — per-signal exchange-fill attribution (rebuild spec 04.2).
 *
 * Promoted from the 2026-07-26 audit's rebuild/tools/reconcile.js into a
 * standing daily job. After spec 04 there are exactly TWO books: the
 * design-intent ledger (what the strategy should earn) and exchange fills
 * (what it did earn) — this job measures the gap between them, per signal,
 * every day.
 *
 *   - Pulls BloFin orders-history since Phase D start (READ-ONLY API).
 *   - Joins orders → signalId via Mongo `blofin_orders` (orderId→signalId,
 *     the only join path for exits) + the deterministic entry clientOrderId.
 *   - Per signal: exchange pnl, fee, net USD, and net R with denominator =
 *     the signal's ACTUAL dollar risk — spec-03 `riskPerUnit` × the entry
 *     order's filled size. NOT the tier table (the audit's TIER_R was an
 *     approximation; per-signal risk is recorded now).
 *   - Persists `exchangeNetR`, `exchangeFeeUsd` (+ exchangeNetUsd,
 *     exchangeRiskUsd, exchangeAttributedAt) onto trade records; the hourly
 *     Mongo sync carries them through.
 *   - Posts a daily summary to #blofin-recon: paired-signal count, mean
 *     |ledger R − exchange R| over the trailing 30 paired signals,
 *     cumulative exchange net. RED alert when trailing mean |Δ| > 0.1R —
 *     the ledger-trust invariant from spec 09.
 *
 * Host cron (after the daily P&L report — integration step):
 *   10 17 * * *  cd ~/trading && node scripts/blofin/attribution.js >> logs/blofin-attribution.log 2>&1
 *
 * Usage:
 *   node scripts/blofin/attribution.js [--dry-run] [--trades <path>]
 *     --dry-run  compute + print only; no trades.json write, no Discord post
 *     --trades   alternate trades.json (testing against a copy)
 */

const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const fs   = require('fs');
const path = require('path');

const blofin  = require('../lib/blofin');
const db      = require('../lib/db');
const discord = require('../lib/discord');
const { acquireLock, releaseLock } = require('../lib/lock');

const PHASE_D_START_MS   = Date.parse('2026-06-15T00:00:00Z');
const INST_ID            = 'BTC-USDT';
const CONTRACT_VALUE_BTC = 0.001;
// Ledger-trust invariant (spec 09): mean |ledger R − exchange R| over the
// trailing 30 paired signals must stay ≤ 0.1R for the ledger to be trusted
// in any capital decision.
const DELTA_ALERT_R      = 0.1;
const TRAILING_PAIRS     = 30;

const DRY_RUN = process.argv.includes('--dry-run');
function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TRADES_PATH = path.resolve(argOf('trades', path.join(ROOT, 'trades.json')));

function clientOrderIdFor(signalId) {
  return String(signalId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

// Full orders-history pull, newest-first pagination by orderId cursor.
async function pullOrderHistory() {
  const out = [];
  const seen = new Set();
  let after;
  for (let page = 0; page < 100; page++) {
    const batch = await blofin.getOrderHistory({ instId: INST_ID, limit: 100, after });
    if (!Array.isArray(batch) || batch.length === 0) break;
    let added = 0;
    for (const o of batch) {
      const id = String(o.orderId);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(o);
      added++;
    }
    const oldest = batch.reduce((m, o) => Math.min(m, +o.createTime || Infinity), Infinity);
    if (added === 0 || oldest < PHASE_D_START_MS || batch.length < 100) break;
    after = batch[batch.length - 1].orderId;
  }
  return out;
}

async function main() {
  console.log(`─── BloFin attribution ─── ${new Date().toISOString()}`);
  console.log('env:', blofin.isDemo() ? 'demo' : 'PROD', '| trades:', TRADES_PATH, DRY_RUN ? '| DRY RUN' : '');

  const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
  const byCid  = new Map(trades.map(t => [clientOrderIdFor(t.id), t]));
  const byId   = new Map(trades.map(t => [t.id, t]));

  // Mongo join (exits have no deterministic clientOrderId — this is the only
  // path linking them to signals; see rebuild/tools/reconcile.js).
  const sigByOrderId = new Map();
  try {
    await db.connect();
    const env = blofin.isDemo() ? 'demo' : 'prod';
    const docs = await db.blofinOrders()
      .find({ env, signalId: { $ne: null } })
      .project({ orderId: 1, signalId: 1 })
      .toArray();
    for (const d of docs) if (d.orderId) sigByOrderId.set(String(d.orderId), d.signalId);
    console.log(`mongo join: ${sigByOrderId.size} orderId→signalId links`);
  } catch (e) {
    console.log(`mongo unavailable (${e.message}) — entry-clientOrderId joins only this run`);
  }

  const exOrders = await pullOrderHistory();
  console.log(`orders-history: ${exOrders.length} orders pulled`);

  // ── Per-signal aggregation ────────────────────────────────────────────────
  const bySig = new Map();
  let unmatchedOrders = 0, unmatchedNet = 0;
  const FILLED = new Set(['filled', 'partially_filled', 'partial_filled']);

  for (const o of exOrders) {
    const ct = +o.createTime;
    if (!(ct >= PHASE_D_START_MS)) continue;
    let sig = sigByOrderId.get(String(o.orderId));
    if (!sig && o.clientOrderId && byCid.has(o.clientOrderId)) sig = byCid.get(o.clientOrderId).id;
    const isFilled = FILLED.has(String(o.state).toLowerCase());
    if (!sig) {
      if (isFilled) { unmatchedOrders++; unmatchedNet += (+o.pnl || 0) - (+o.fee || 0); }
      continue;
    }
    if (!bySig.has(sig)) bySig.set(sig, { pnl: 0, fee: 0, orders: 0, filled: 0, entrySizeBtc: 0, firstTs: ct });
    const s = bySig.get(sig);
    s.orders++;
    s.firstTs = Math.min(s.firstTs, ct);
    if (isFilled) {
      s.filled++;
      s.pnl += +o.pnl || 0;
      s.fee += +o.fee || 0;
      // The entry is the order carrying our deterministic clientOrderId —
      // its filled size defines the signal's actual dollar risk.
      if (o.clientOrderId && byCid.has(o.clientOrderId)) {
        s.entrySizeBtc += (Number(o.filledSize) || 0) * CONTRACT_VALUE_BTC;
      }
    }
  }

  // ── Rows: exchange truth vs ledger claim, actual-risk denominator ─────────
  const rows = [];
  let riskFallbacks = 0;
  for (const [sig, s] of bySig) {
    const t = byId.get(sig);
    const perUnit = t?.riskPerUnit != null ? t.riskPerUnit
      : (t && t.entry != null && t.stop != null ? Math.abs(t.entry - t.stop) : null);
    if (t && t.riskPerUnit == null) riskFallbacks++;
    const riskUsd = perUnit > 0 && s.entrySizeBtc > 0 ? perUnit * s.entrySizeBtc : null;
    const netUsd  = s.pnl - s.fee;
    rows.push({
      sig,
      firstTs:    new Date(s.firstTs).toISOString(),
      execStatus: t?.executionStatus ?? 'NOT_IN_TRADES',
      ledgerOutcome: t?.outcome ?? null,
      ledgerR:    t?.pnlR ?? null,
      exPnl:      +s.pnl.toFixed(2),
      exFee:      +s.fee.toFixed(2),
      exNetUsd:   +netUsd.toFixed(2),
      exRiskUsd:  riskUsd != null ? +riskUsd.toFixed(2) : null,
      exNetR:     riskUsd > 0 ? +(netUsd / riskUsd).toFixed(3) : null,
      nOrders:    s.orders,
      nFilled:    s.filled,
    });
  }
  rows.sort((a, b) => a.firstTs.localeCompare(b.firstTs));

  const sum = (a, f) => a.reduce((x, r) => x + (r[f] || 0), 0);
  console.log('');
  console.log(`signals with exchange orders since 2026-06-15: ${rows.length}`);
  console.log(`unmatched filled orders (no signal mapping):   ${unmatchedOrders} (net $${unmatchedNet.toFixed(2)})`);
  console.log(`EXCHANGE truth: gross $${sum(rows, 'exPnl').toFixed(2)}  fees $${sum(rows, 'exFee').toFixed(2)}  NET $${(sum(rows, 'exNetUsd') + unmatchedNet).toFixed(2)} (matched $${sum(rows, 'exNetUsd').toFixed(2)})`);
  console.log(`net R (actual-risk denominator): ${sum(rows, 'exNetR').toFixed(2)}R over ${rows.filter(r => r.exNetR != null).length} risk-resolved signals`);
  if (riskFallbacks) console.log(`riskPerUnit fallback to |entry−stop| on ${riskFallbacks} pre-rewrite signals`);

  // ── Ledger↔exchange agreement (trailing pairs) ────────────────────────────
  const paired = rows.filter(r => r.ledgerR != null && r.exNetR != null);
  const trailing = paired.slice(-TRAILING_PAIRS);
  const meanAbsDelta = trailing.length
    ? trailing.reduce((x, r) => x + Math.abs(r.ledgerR - r.exNetR), 0) / trailing.length
    : null;
  console.log(`paired signals (ledger R + exchange R): ${paired.length}; trailing ${trailing.length} mean |Δ| = ${meanAbsDelta != null ? meanAbsDelta.toFixed(3) + 'R' : 'n/a'}`);

  // ── Persist onto trade records ────────────────────────────────────────────
  if (!DRY_RUN) {
    // Serialize with the pipeline scripts, then re-read fresh so a signal
    // logged mid-run isn't clobbered by our in-memory copy.
    const gotLock = await acquireLock(20_000, 'blofin-attribution');
    try {
      const fresh = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
      const freshById = new Map(fresh.map(t => [t.id, t]));
      let patched = 0;
      for (const r of rows) {
        const t = freshById.get(r.sig);
        if (!t) continue;
        t.exchangeNetUsd  = r.exNetUsd;
        t.exchangeFeeUsd  = r.exFee;
        t.exchangeRiskUsd = r.exRiskUsd;
        t.exchangeNetR    = r.exNetR;
        t.exchangeAttributedAt = new Date().toISOString();
        patched++;
      }
      const tmp = TRADES_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(fresh, null, 2));
      fs.renameSync(tmp, TRADES_PATH);
      console.log(`persisted exchange fields onto ${patched} trade records`);
    } finally {
      if (gotLock) releaseLock('blofin-attribution');
    }
  }

  // ── Daily Discord post ────────────────────────────────────────────────────
  const webhook = process.env.BLOFIN_RECON_WEBHOOK;
  if (!DRY_RUN && webhook) {
    const breach = meanAbsDelta != null && meanAbsDelta > DELTA_ALERT_R;
    const lines = [
      `**Paired signals (ledger↔exchange):** ${paired.length}`,
      `**Trailing ${trailing.length} mean |ledger R − exchange R|:** ${meanAbsDelta != null ? meanAbsDelta.toFixed(3) + 'R' : 'n/a'} (invariant ≤ ${DELTA_ALERT_R}R)`,
      `**Cumulative exchange net since 2026-06-15:** $${(sum(rows, 'exNetUsd') + unmatchedNet).toFixed(2)} (fees $${sum(rows, 'exFee').toFixed(2)})`,
      `**Exchange net in R (actual risk):** ${sum(rows, 'exNetR').toFixed(2)}R`,
    ];
    if (breach) {
      lines.unshift(`🚨 **LEDGER-TRUST INVARIANT BREACHED** — mean |Δ| > ${DELTA_ALERT_R}R over the trailing ${trailing.length} paired signals. Do not trust ledger numbers for capital decisions until reconciled.`, '');
    }
    await discord.postWebhook(
      webhook,
      breach ? 'error' : 'info',
      lines.join('\n'),
      `BloFin attribution · ${blofin.isDemo() ? 'demo' : 'PROD'} · ${new Date().toUTCString().slice(5, 25)} UTC`
    );
  }

  await db.disconnect().catch(() => {});
  console.log('─── Done. ───');
}

main().catch(async e => {
  console.error('attribution failed:', e.message || e);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
