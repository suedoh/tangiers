#!/usr/bin/env node
'use strict';

/**
 * scripts/carry/monitor.js — autonomous delta-neutral funding-carry engine (paper).
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * Rounds 1–6 of spec 07 established that BTC direction is not predictable at these
 * horizons: 255 FDR cells, 0 actionable, and the live zone signal measured at
 * 50.40% [50.20, 50.60] over 237,735 instances. Round 7 found the one structure
 * that does clear its costs — funding carry — because it contains no forecast:
 * long spot + short perp, collect the 8-hourly payment the crowded side pays,
 * with price direction cancelling between the legs (measured basis P&L per trade:
 * 0.000–0.002%).
 *
 * This engine runs that trade on PAPER against live Binance public data. It holds
 * no credentials, places no orders, and cannot move money. Its job is to produce a
 * real, dated, out-of-sample track record of a strategy whose in-sample economics
 * are already known — because round 7 also measured the carry decaying from 30.61%
 * annualised (2021) to 1.83% (2026), which is the difference between a business and
 * a rounding error. Whether it is worth executing is a question about the FUTURE
 * carry, and only forward data answers that.
 *
 * WIN RATE IS NOT THE OBJECTIVE. It is a free parameter — measured on this repo's
 * own corpus, a 1:9 target:stop on the (edgeless) zone signal yields exactly 90.0%
 * wins and −0.0254R/trade. This engine reports win rate because it is asked for,
 * but it gates on EXPECTANCY. A configuration that wins 90% of the time and loses
 * money will be reported as failing.
 *
 * ECONOMICS (all costs charged, no exceptions)
 *   entry  = 2 legs (buy spot, sell perp)
 *   exit   = 2 legs (sell spot, buy perp)
 *   carry  = Σ funding over the held settlements, received by the short perp when
 *            funding > 0 (and PAID when it is negative — 33% of 2026 settlements)
 *   P&L    = (basis_entry − basis_exit) + Σfunding − costs
 *   capital = spot notional (1.0×) + perp initial margin (1/leverage)
 *
 * THE GATE. Opens only when the trailing carry, annualised, exceeds the round-trip
 * cost amortised over MIN_HOLD_DAYS plus a safety margin. That is the whole
 * decision — there is no prediction anywhere in it.
 *
 * Usage:
 *   node scripts/carry/monitor.js              # one cycle (cron entrypoint)
 *   node scripts/carry/monitor.js --status     # print book + ledger, no side effects
 *   node scripts/carry/monitor.js --dry-run    # no Discord, no state write
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const STATE_FILE  = path.join(ROOT, '.carry-state.json');
const LEDGER_FILE = path.join(ROOT, 'carry-trades.json');

// ─── Economics. Every number here is measured, not assumed. ──────────────────
// Perp fees: BloFin real fills (2026-07-26 audit §2). Spot fees: Binance retail.
// Both sides assumed PASSIVE — round 7 showed taker execution turns the current
// regime negative, so maker fills are a precondition, not an optimisation.
const FEE_PERP_MAKER = 0.0002;
const FEE_SPOT_MAKER = 0.0002;
const ROUND_TRIP     = 2 * (FEE_PERP_MAKER + FEE_SPOT_MAKER);   // 8 bp
const LEVERAGE       = Number(process.env.CARRY_LEVERAGE || 3);  // perp leg only
const CAPITAL_MULT   = 1 + 1 / LEVERAGE;

// Round 7: at 30–60 day holds the trade is positive in the current regime; at
// 15 days it is not. MIN_HOLD is therefore a measured floor, not a preference.
const MIN_HOLD_DAYS  = Number(process.env.CARRY_MIN_HOLD_DAYS || 30);
// Safety margin over pure break-even. Round 7's 2026 net at maker fees was
// +0.2%/yr — indistinguishable from zero — so the gate demands real headroom
// before committing capital.
const MIN_EDGE_ANN   = Number(process.env.CARRY_MIN_EDGE_ANN || 0.04);  // 4%/yr
const TRAIL_SETTLES  = 90;    // 30 days of 8h settlements for the carry estimate

const DRY  = process.argv.includes('--dry-run');
const STAT = process.argv.includes('--status');

const log = m => console.log(`[${new Date().toISOString()}] [carry] ${m}`);

function get(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: 20000, family: 4 }, r => {
      let b = ''; r.on('data', d => (b += d));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error(b.slice(0, 160))); } });
    });
    req.on('error', rej);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { if (!DRY) fs.writeFileSync(f, JSON.stringify(o, null, 2)); };

// ─── Market snapshot ─────────────────────────────────────────────────────────
async function snapshot() {
  const [spotT, perpP, fundHist] = await Promise.all([
    get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
    get('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=${TRAIL_SETTLES}`),
  ]);
  const spot = Number(spotT.price);
  const mark = Number(perpP.markPrice);
  const rates = fundHist.map(f => Number(f.fundingRate)).filter(Number.isFinite);
  if (!(spot > 0) || !(mark > 0) || rates.length < 10) throw new Error('incomplete market snapshot');
  const meanRate = rates.reduce((s, x) => s + x, 0) / rates.length;
  return {
    spot, mark,
    basis: (mark - spot) / spot,
    nextFunding: Number(perpP.lastFundingRate),
    trailMean: meanRate,
    trailAnn: meanRate * 3 * 365,
    posShare: rates.filter(x => x > 0).length / rates.length,
    nRates: rates.length,
  };
}

/** The entire decision. No forecast — just: does the payment beat the toll? */
function evaluateGate(m) {
  const costAnn = ROUND_TRIP * (365 / MIN_HOLD_DAYS);   // round trip amortised
  const netAnn  = (m.trailAnn - costAnn) / CAPITAL_MULT;
  return {
    costAnn, netAnn,
    open: netAnn >= MIN_EDGE_ANN && m.trailMean > 0,
    // Diagnose the binding constraint, most specific first: a negative carry is a
    // different condition from a merely thin one and must not be reported as
    // "below threshold" — we would be PAYING funding, not collecting it.
    reason: m.trailMean <= 0
      ? 'trailing carry is negative — the crowd is short, we would pay to hold this'
      : netAnn < MIN_EDGE_ANN
        ? `net ${(netAnn * 100).toFixed(2)}%/yr < required ${(MIN_EDGE_ANN * 100).toFixed(2)}%/yr`
        : 'carry clears cost plus margin',
  };
}

async function post(type, body) {
  const hook = process.env.CARRY_WEBHOOK || process.env.BLOFIN_RECON_WEBHOOK;
  if (!hook || DRY) return;
  try {
    const { postWebhook } = require('../lib/discord');
    await postWebhook(hook, type, body, `Carry engine · ${new Date().toUTCString().slice(5, 25)} UTC`);
  } catch (e) { log(`discord post failed: ${e.message}`); }
}

// ─── Book ────────────────────────────────────────────────────────────────────
function openPosition(m, state) {
  state.position = {
    openedAt: new Date().toISOString(),
    entrySpot: m.spot, entryPerp: m.mark, entryBasis: m.basis,
    fundingAccrued: 0, settlementsHeld: 0,
    lastFundingAt: null,
    entryCostR: ROUND_TRIP / 2,      // the two opening legs
  };
  return state.position;
}

function accrueFunding(state, m, nowMs) {
  const p = state.position;
  if (!p) return 0;
  // Settlements land at 00/08/16 UTC. Credit each one once, keyed by its timestamp.
  const period = 8 * 3600 * 1000;
  const lastSettle = Math.floor(nowMs / period) * period;
  if (p.lastFundingAt === lastSettle) return 0;
  // Only credit if we were open before this settlement.
  if (Date.parse(p.openedAt) > lastSettle) { p.lastFundingAt = lastSettle; return 0; }
  p.fundingAccrued += m.nextFunding;   // short perp receives when positive
  p.settlementsHeld += 1;
  p.lastFundingAt = lastSettle;
  return m.nextFunding;
}

function closePosition(state, m, why) {
  const p = state.position;
  const basisPnl = p.entryBasis - m.basis;
  const gross = p.fundingAccrued + basisPnl;
  const net = (gross - ROUND_TRIP) / CAPITAL_MULT;
  const heldDays = (Date.now() - Date.parse(p.openedAt)) / 864e5;
  const rec = {
    openedAt: p.openedAt, closedAt: new Date().toISOString(), heldDays: +heldDays.toFixed(2),
    entrySpot: p.entrySpot, exitSpot: m.spot,
    entryBasis: p.entryBasis, exitBasis: m.basis,
    settlementsHeld: p.settlementsHeld,
    fundingPct: +(p.fundingAccrued * 100).toFixed(4),
    basisPnlPct: +(basisPnl * 100).toFixed(4),
    costPct: +(ROUND_TRIP * 100).toFixed(4),
    netPct: +(net * 100).toFixed(4),
    annualisedPct: heldDays > 0 ? +((net * 365 / heldDays) * 100).toFixed(2) : null,
    closeReason: why,
  };
  const ledger = readJson(LEDGER_FILE, []);
  ledger.push(rec);
  writeJson(LEDGER_FILE, ledger);
  state.position = null;
  return rec;
}

function ledgerStats() {
  const l = readJson(LEDGER_FILE, []);
  if (!l.length) return null;
  const nets = l.map(r => r.netPct);
  const wins = nets.filter(x => x > 0).length;
  const totalDays = l.reduce((s, r) => s + r.heldDays, 0);
  const totalNet = nets.reduce((s, x) => s + x, 0);
  return {
    n: l.length, wins, winPct: (wins / l.length) * 100,
    totalNetPct: totalNet,
    annualisedPct: totalDays > 0 ? (totalNet * 365 / totalDays) : null,
    meanHoldDays: totalDays / l.length,
  };
}

// ─── Cycle ───────────────────────────────────────────────────────────────────
async function main() {
  const state = readJson(STATE_FILE, { position: null, lastRunAt: null, openedCount: 0 });

  if (STAT) {
    const s = ledgerStats();
    console.log('position:', state.position ? JSON.stringify(state.position, null, 2) : 'flat');
    console.log('ledger  :', s ? JSON.stringify(s, null, 2) : 'empty');
    return;
  }

  const m = await snapshot();
  const g = evaluateGate(m);
  log(`spot $${m.spot.toFixed(0)} · basis ${(m.basis * 1e4).toFixed(2)}bp · trailing carry `
    + `${(m.trailAnn * 100).toFixed(2)}%/yr (${m.nRates} settles, ${(m.posShare * 100).toFixed(0)}% positive)`);
  log(`gate: cost ${(g.costAnn * 100).toFixed(2)}%/yr at ${MIN_HOLD_DAYS}d hold → net ${(g.netAnn * 100).toFixed(2)}%/yr — ${g.reason}`);

  const nowMs = Date.now();

  if (state.position) {
    const credited = accrueFunding(state, m, nowMs);
    const p = state.position;
    const heldDays = (nowMs - Date.parse(p.openedAt)) / 864e5;
    if (credited) log(`funding credited ${(credited * 1e4).toFixed(3)}bp — accrued ${(p.fundingAccrued * 100).toFixed(4)}% over ${p.settlementsHeld} settlements`);

    // Exit only after the measured minimum hold, and only when the trade has
    // stopped paying. Exiting early is what makes the cost dominate (round 7:
    // 3×8h holds are −95%/yr at taker fees).
    if (heldDays >= MIN_HOLD_DAYS && !g.open) {
      const rec = closePosition(state, m, g.reason);
      log(`CLOSED after ${rec.heldDays}d: funding ${rec.fundingPct}% + basis ${rec.basisPnlPct}% − cost ${rec.costPct}% = net ${rec.netPct}% (${rec.annualisedPct}%/yr)`);
      const s = ledgerStats();
      await post(rec.netPct > 0 ? 'long' : 'error', [
        `**CARRY TRADE CLOSED** — held ${rec.heldDays}d over ${rec.settlementsHeld} settlements`,
        `funding **${rec.fundingPct}%** · basis ${rec.basisPnlPct}% · cost −${rec.costPct}% → **net ${rec.netPct}%** (${rec.annualisedPct}%/yr)`,
        ``,
        `Book to date: ${s.n} trades · **${s.winPct.toFixed(0)}% wins** · ${s.totalNetPct.toFixed(3)}% total · ${s.annualisedPct?.toFixed(2)}%/yr`,
        `_Paper only. Win rate is reported, not optimised — the gate is expectancy._`,
      ].join('\n'));
    } else {
      log(`holding — ${heldDays.toFixed(1)}d / ${MIN_HOLD_DAYS}d min, gate ${g.open ? 'still open' : 'closed (waiting for min hold)'}`);
    }
  } else if (g.open) {
    const p = openPosition(m, state);
    state.openedCount = (state.openedCount || 0) + 1;
    log(`OPENED: long spot @ $${m.spot.toFixed(0)}, short perp @ $${m.mark.toFixed(0)}, basis ${(m.basis * 1e4).toFixed(2)}bp`);
    await post('info', [
      `**CARRY TRADE OPENED** (paper)`,
      `long spot $${m.spot.toFixed(0)} · short perp $${m.mark.toFixed(0)} · basis ${(m.basis * 1e4).toFixed(2)}bp`,
      `trailing carry **${(m.trailAnn * 100).toFixed(2)}%/yr** · net of cost **${(g.netAnn * 100).toFixed(2)}%/yr** · min hold ${MIN_HOLD_DAYS}d`,
    ].join('\n'));
  } else {
    log(`flat — ${g.reason}`);
  }

  state.lastRunAt = new Date().toISOString();
  state.lastGate = { trailAnn: m.trailAnn, netAnn: g.netAnn, open: g.open, at: state.lastRunAt };
  writeJson(STATE_FILE, state);
}

if (require.main === module) {
  const { finishCron } = require('../lib/cron-exit');
  main().then(() => finishCron(0)).catch(e => {
    log(`FATAL: ${e.message}`);
    finishCron(1);
  });
}

module.exports = { evaluateGate, ROUND_TRIP, CAPITAL_MULT, MIN_HOLD_DAYS, ledgerStats };
