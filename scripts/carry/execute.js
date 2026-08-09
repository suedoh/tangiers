#!/usr/bin/env node
'use strict';

/**
 * scripts/carry/execute.js — the carry's execution layer (demo).
 *
 * Turns the paper gate in monitor.js into real (demo) orders: buy BTC spot,
 * short the BTC-USDT perp at equal notional, hold, then unwind both. Price
 * direction cancels between the legs; the position earns the 8-hourly funding
 * the crowded side pays. There is no forecast anywhere in this file.
 *
 * ═══ SAFETY DESIGN — read before changing anything ═══
 *
 * 1. **Nothing fires without `--live`.** The default path is a full rehearsal:
 *    every size, price and payload is computed and printed, and no order is
 *    sent. `--live` is deliberately absent from every cron entry and Makefile
 *    target, so the first real fire is an explicit human act.
 * 2. **Demo only.** Refuses outright if BLOFIN_ENV !== 'demo'. Prod requires the
 *    spec 09 Phase E gate and an operator signature, not a flag.
 * 3. **Leg-1 failure unwinds leg 0.** A spot buy that succeeds followed by a
 *    failed perp short leaves naked long BTC — the exact class of failure Phase
 *    B.6 was built to prevent on the perp side. If the hedge cannot be
 *    established, the spot leg is sold back immediately.
 * 4. **Wallet precondition.** BloFin wallets do not pool: measured 2026-08-09,
 *    futures USDT 1680.98 / spot 0. Without USDT in the SPOT wallet the buy
 *    cannot fill. This script checks and refuses rather than half-executing —
 *    and it will NOT transfer funds for you. `transfer()` exists in lib but is
 *    unverified and requires its own explicit confirmation.
 * 5. **Sizes are floored to the venue's lot size**, and the perp leg is matched
 *    to the ACTUAL spot fill, not the intended size — an unhedged remainder is
 *    directional risk, which is the one thing this strategy must not carry.
 *
 * Usage:
 *   node scripts/carry/execute.js                 # rehearsal — computes, sends nothing
 *   node scripts/carry/execute.js --live          # places orders (demo)
 *   node scripts/carry/execute.js --unwind        # rehearse the close
 *   node scripts/carry/execute.js --unwind --live # close for real (demo)
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
loadEnv();

const spot = require('../lib/blofin-spot');
const perp = require('../lib/blofin');

const LIVE = process.argv.includes('--live');
const UNWIND = process.argv.includes('--unwind');
const STATE_FILE = path.join(ROOT, '.carry-exec-state.json');
const PERP_INST = 'BTC-USDT';
const PERP_CONTRACT_BTC = 0.001;          // contractValue from the instrument record
const NOTIONAL_USD = Number(process.env.CARRY_NOTIONAL_USD || 200);

const log = m => console.log(`[${new Date().toISOString()}] [carry-exec] ${m}`);
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { position: null }; } };
const writeState = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

function guardEnv() {
  if ((process.env.BLOFIN_ENV || 'demo') !== 'demo') {
    throw new Error('BLOFIN_ENV is not demo — refusing. Prod requires the spec 09 Phase E gate, not a flag.');
  }
}

/** Preconditions that must hold before either leg is touched. */
async function preflight(notionalUsd) {
  const [tick, book, spotWallet, perpBal] = await Promise.all([
    spot.getTicker(), spot.getBook(),
    spot.walletBalance('spot'),
    perp.getBalance().catch(() => null),
  ]);
  const ask = Number(book.asks?.[0]?.[0] ?? tick.askPrice);
  const bid = Number(book.bids?.[0]?.[0] ?? tick.bidPrice);
  const spreadBp = ((ask - bid) / bid) * 1e4;
  const usdtSpot = spotWallet.USDT || 0;
  const usdtPerp = (() => {
    const u = (perpBal || []).find(b => b.currency === 'USDT');
    return u ? Number(u.available) : 0;
  })();

  const btcSize = spot.roundLot(notionalUsd / ask);
  const contracts = Math.floor((btcSize / PERP_CONTRACT_BTC) * 10) / 10;   // perp lotSize 0.1
  const perpMarginNeeded = (contracts * PERP_CONTRACT_BTC * ask) / Number(process.env.CARRY_LEVERAGE || 3);

  const problems = [];
  if (usdtSpot < notionalUsd) problems.push(`spot wallet has $${usdtSpot.toFixed(2)} USDT, needs ~$${notionalUsd} — transfer futures→spot first (this script will not do it)`);
  if (usdtPerp < perpMarginNeeded) problems.push(`futures wallet has $${usdtPerp.toFixed(2)} available, perp leg needs ~$${perpMarginNeeded.toFixed(2)} margin`);
  if (!(btcSize >= spot.MIN_SIZE)) problems.push(`computed spot size ${btcSize} below venue minimum ${spot.MIN_SIZE}`);
  if (!(contracts > 0)) problems.push(`computed perp size ${contracts} contracts rounds to zero — raise CARRY_NOTIONAL_USD`);
  if (spreadBp > 20) problems.push(`spot spread ${spreadBp.toFixed(1)}bp is wide — crossing it would eat the carry`);

  return { ask, bid, spreadBp, usdtSpot, usdtPerp, btcSize, contracts, perpMarginNeeded, problems };
}

async function open() {
  const st = readState();
  if (st.position) throw new Error('a carry position is already recorded — unwind before opening another');

  const pf = await preflight(NOTIONAL_USD);
  log(`spot ask $${pf.ask.toFixed(2)} · spread ${pf.spreadBp.toFixed(1)}bp`);
  log(`plan: BUY ${pf.btcSize} BTC spot (~$${(pf.btcSize * pf.ask).toFixed(2)}) + SHORT ${pf.contracts} perp contracts (~$${pf.perpMarginNeeded.toFixed(2)} margin)`);
  log(`wallets: spot $${pf.usdtSpot.toFixed(2)} USDT · futures $${pf.usdtPerp.toFixed(2)} available`);

  if (pf.problems.length) {
    log('PREFLIGHT FAILED:');
    for (const p of pf.problems) log(`  ✗ ${p}`);
    if (LIVE) throw new Error('preflight failed — refusing to place orders');
    log('(rehearsal: would have refused)');
    return;
  }
  log('preflight OK');

  if (!LIVE) {
    const dry = await spot.placeOrder({ side: 'buy', size: pf.btcSize, clientOrderId: 'rehearsal', dryRun: true });
    log(`REHEARSAL — no orders sent. Spot payload: ${JSON.stringify(dry.body)}`);
    log(`Perp would be: SHORT ${pf.contracts} ${PERP_INST}`);
    log('Re-run with --live to place these on demo.');
    return;
  }

  // ── leg 0: spot buy ──
  const coid = `carry${Date.now()}`;
  log(`placing spot BUY ${pf.btcSize} BTC …`);
  const spotOrder = await spot.placeOrder({ side: 'buy', size: pf.btcSize, clientOrderId: coid });
  log(`spot order accepted: ${JSON.stringify(spotOrder).slice(0, 200)}`);

  // Resolve the ACTUAL fill — the perp leg must match what filled, not what we asked for.
  await new Promise(r => setTimeout(r, 2000));
  const fills = await spot.fillsHistory(20).catch(() => []);
  const mine = (fills || []).filter(f => (f.clientOrderId || '') === coid);
  const filledBtc = mine.reduce((s, f) => s + Number(f.fillSize ?? f.size ?? 0), 0) || pf.btcSize;
  const avgPx = mine.length
    ? mine.reduce((s, f) => s + Number(f.fillPrice ?? f.price) * Number(f.fillSize ?? f.size), 0) / filledBtc
    : pf.ask;
  log(`spot filled ${filledBtc} BTC @ ~$${avgPx.toFixed(2)}`);

  const feeNow = await spot.feeFromFills(20);
  if (feeNow) log(`📏 SPOT FEE MEASURED: median ${feeNow.medianBp.toFixed(2)}bp over ${feeNow.n} fill(s) — set CARRY_SPOT_FEE_BP=${feeNow.medianBp.toFixed(1)}`);

  // ── leg 1: perp short, sized to the actual spot fill ──
  const hedgeContracts = Math.floor((filledBtc / PERP_CONTRACT_BTC) * 10) / 10;
  try {
    if (!(hedgeContracts > 0)) throw new Error(`hedge rounds to zero contracts for ${filledBtc} BTC`);
    log(`placing perp SHORT ${hedgeContracts} contracts …`);
    const perpOrder = await perp.placeOrder({
      instId: PERP_INST, marginMode: 'cross', side: 'sell', positionSide: 'net',
      orderType: 'market', size: String(hedgeContracts), clientOrderId: coid + 'p',
    });
    log(`perp order accepted: ${JSON.stringify(perpOrder).slice(0, 200)}`);
    writeState({ position: { openedAt: new Date().toISOString(), coid, filledBtc, avgPx, hedgeContracts } });
    log('✅ carry position OPEN and hedged.');
  } catch (e) {
    // Safety rule 3: never leave a naked long.
    log(`🚨 PERP LEG FAILED: ${e.message}`);
    log('unwinding the spot leg immediately to avoid naked directional exposure …');
    try {
      await spot.placeOrder({ side: 'sell', size: filledBtc, clientOrderId: coid + 'r' });
      log('spot leg sold back — flat.');
    } catch (e2) {
      log(`🚨🚨 UNWIND ALSO FAILED: ${e2.message} — YOU ARE NAKED LONG ${filledBtc} BTC. Close manually.`);
    }
    throw e;
  }
}

async function unwind() {
  const st = readState();
  if (!st.position) { log('no recorded carry position — nothing to unwind'); return; }
  const p = st.position;
  log(`unwinding: sell ${p.filledBtc} BTC spot + buy back ${p.hedgeContracts} perp contracts`);
  if (!LIVE) { log('REHEARSAL — no orders sent. Re-run with --unwind --live.'); return; }
  await spot.placeOrder({ side: 'sell', size: p.filledBtc, clientOrderId: p.coid + 'x' });
  await perp.placeOrder({
    instId: PERP_INST, marginMode: 'cross', side: 'buy', positionSide: 'net',
    orderType: 'market', size: String(p.hedgeContracts), clientOrderId: p.coid + 'xp',
  });
  writeState({ position: null, lastClosedAt: new Date().toISOString() });
  log('✅ unwound — flat.');
}

(async () => {
  guardEnv();
  log(`env=${spot.ENV} host=${spot.HOST} notional=$${NOTIONAL_USD} ${LIVE ? '*** LIVE ***' : '(rehearsal)'}`);
  await (UNWIND ? unwind() : open());
})().catch(e => { console.error(`[carry-exec] FAILED: ${e.message}`); process.exit(1); });
