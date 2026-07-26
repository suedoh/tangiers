#!/usr/bin/env node
'use strict';

/**
 * recompute-history.js — one-shot historical recompute under design-intent
 * accounting (rebuild spec 03).
 *
 * Re-derives EVERY signal in a trades.json file from Binance 30m klines using
 * the SAME pure functions the live pipeline runs (required from
 * scripts/trigger-check.js — one implementation, no drift):
 *
 *   - strict confirmation: first COMPLETED 30M close beyond entry within 1h
 *   - fill = confirming close; riskPerUnit = |fill − stop|
 *   - 1/3 ladder re-anchored to the fill, stop-first, walked on completed bars
 *   - fees at the measured 6bp taker / 2bp maker schedule; pnlR net of fees
 *   - no strict confirmation ⇒ 'expired_unconfirmed', pnlR null (no trade)
 *
 * Old values are preserved once into legacy* fields (never deleted, never
 * overwritten on re-run). This is a RECOMPUTE, not a diff — existing
 * win-rate-diff baselines measure the old artifact; snapshot a FRESH baseline
 * after applying to the live file (scripts/audit/win-rate-diff.js --snapshot).
 *
 * EXPECTED RESULT on the full 2026-04→07 history (audit re-walk): total
 * ≈ −78R net, mean ≈ −0.10R, tp1-touch ~73%. If this prints ≈ +900R the
 * rewrite is broken (a fictional-fill path survived) — do NOT apply.
 *
 * Usage:
 *   node scripts/audit/recompute-history.js --trades <trades.json> --klines <dir> [--dry-run] [--verify]
 *
 *   --trades   path to a trades.json (run against a COPY first; the live
 *              file only at integration time with cron paused)
 *   --klines   dir containing klines-30m.json (+ klines-1m.json for --verify)
 *              produced by rebuild/tools/fetch-klines.js
 *   --dry-run  compute + print summary, write nothing
 *   --verify   independent 1m-resolution cross-walk per confirmed signal;
 *              reports outcome-class agreement (spec 03 acceptance ≥98%)
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  decideConfirmation, unconfirmedExpiry, walkBarsForOutcome,
  FEE_TAKER_RATE, FEE_MAKER_RATE,
} = require(path.join(ROOT, 'scripts', 'trigger-check.js'));

const BAR_30M_SEC = 1800;

// ─── CLI ─────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const TRADES_PATH = path.resolve(String(arg('trades', path.join(ROOT, 'trades.json'))));
const KLINES_DIR  = arg('klines', null);
const DRY_RUN     = process.argv.includes('--dry-run');
const VERIFY      = process.argv.includes('--verify');

if (!KLINES_DIR) {
  console.error('usage: recompute-history.js --trades <trades.json> --klines <dir> [--dry-run] [--verify]');
  process.exit(2);
}

// ─── Load data ───────────────────────────────────────────────────────────────

const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
const k30raw = JSON.parse(fs.readFileSync(path.join(String(KLINES_DIR), 'klines-30m.json'), 'utf8'));
// Normalize Binance klines (ms) to the walker's bar shape (seconds, like TV).
const bars30 = k30raw.map(b => ({
  time: b.openTime / 1000, open: b.open, high: b.high, low: b.low, close: b.close,
}));
const dataEndSec = bars30[bars30.length - 1].time + BAR_30M_SEC;

console.log(`trades: ${trades.length} from ${TRADES_PATH}`);
console.log(`klines: ${bars30.length}×30m, ${new Date(bars30[0].time * 1000).toISOString()} → ${new Date(dataEndSec * 1000).toISOString()}`);
console.log('');

// ─── Recompute ───────────────────────────────────────────────────────────────

const counts = { confirmed: 0, expired_unconfirmed: 0, pending: 0, expired_open: 0 };
const outcomeDist = {};
let totGross = 0, totFee = 0, totNet = 0, resolved = 0, tp1Touched = 0;
let legacyTotal = 0, legacyResolved = 0;
const results = []; // per-trade { t, walk } for --verify

for (const t of trades) {
  // Preserve old values ONCE (spec 03 field migration). Re-runs never clobber.
  if (!('legacyOutcome' in t)) {
    t.legacyOutcome        = t.outcome ?? null;
    t.legacyPnlR           = t.pnlR ?? null;
    t.legacyConfirmed      = t.confirmed ?? null;
    t.legacyConfirmedAt    = t.confirmedAt ?? null;
    t.legacyConfirmedPrice = t.confirmedPrice ?? null;
  }
  if (t.legacyPnlR != null) { legacyTotal += t.legacyPnlR; legacyResolved++; }

  // Strict confirmation from ground-truth completed bars.
  const conf = decideConfirmation(t, bars30, dataEndSec);

  if (!conf) {
    t.confirmed      = false;
    t.confirmedAt    = null;
    t.confirmedPrice = null;
    t.fillPrice      = null;
    t.riskPerUnit    = null;
    t.accounting     = 'design-intent-v1';
    t.grossR         = null;
    t.feeR           = null;
    if (unconfirmedExpiry(t, dataEndSec)) {
      t.outcome  = 'expired_unconfirmed';
      t.closedAt = new Date((new Date(t.firedAt).getTime()) + 5400 * 1000).toISOString();
      t.pnlR     = null;
      counts.expired_unconfirmed++;
    } else {
      // Confirmation window still open at data end — leave pending.
      t.outcome = null; t.closedAt = null; t.pnlR = null;
      counts.pending++;
    }
    continue;
  }

  counts.confirmed++;
  t.confirmed      = true;
  t.confirmedAt    = new Date(conf.barTime * 1000).toISOString();
  t.confirmedPrice = conf.confirmedPrice;
  t.fillPrice      = conf.confirmedPrice;
  t.riskPerUnit    = Math.abs(conf.confirmedPrice - t.stop);
  t.accounting     = 'design-intent-v1';

  const confirmCloseSec = conf.barTime + BAR_30M_SEC;
  const relevantBars = bars30.filter(b =>
    b.time + BAR_30M_SEC > confirmCloseSec && b.time + BAR_30M_SEC <= dataEndSec);

  const walk = walkBarsForOutcome(t, relevantBars);
  if (walk) {
    t.outcome  = walk.outcome;
    t.grossR   = walk.grossR;
    t.feeR     = walk.feeR;
    t.pnlR     = walk.pnlR;
    t.closedAt = new Date(walk.closedBarTime * 1000).toISOString();
    outcomeDist[walk.outcome] = (outcomeDist[walk.outcome] || 0) + 1;
    totGross += walk.grossR; totFee += walk.feeR; totNet += walk.pnlR;
    resolved++;
    if (walk.rungsBanked >= 1) tp1Touched++;
    results.push({ t, confirmCloseSec, walk });
  } else {
    // Ladder still open at data end.
    const ageDays = (dataEndSec - new Date(t.firedAt).getTime() / 1000) / 86400;
    if (ageDays > 30) {
      t.outcome = 'expired'; t.pnlR = 0; t.grossR = null; t.feeR = null;
      t.closedAt = new Date(dataEndSec * 1000).toISOString();
      counts.expired_open++;
    } else {
      t.outcome = null; t.pnlR = null; t.closedAt = null;
      counts.pending++;
    }
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('── design-intent recompute ──');
console.log(`confirmed (strict):        ${counts.confirmed}`);
console.log(`expired_unconfirmed:       ${counts.expired_unconfirmed}  (no trade — excluded from aggregates)`);
console.log(`still pending at data end: ${counts.pending}`);
console.log(`expired open >30d:         ${counts.expired_open}`);
console.log(`outcome distribution:      ${JSON.stringify(outcomeDist)}`);
console.log('');
console.log(`resolved trades:  ${resolved}`);
console.log(`gross R total:    ${totGross.toFixed(1)}`);
console.log(`fees R total:     ${totFee.toFixed(1)}  (mean ${(totFee / (resolved || 1)).toFixed(3)}R/trade)`);
console.log(`NET R total:      ${totNet.toFixed(1)}  (mean ${(totNet / (resolved || 1)).toFixed(3)}R/trade)`);
console.log(`tp1-touch rate:   ${(100 * tp1Touched / (resolved || 1)).toFixed(1)}%  (${tp1Touched}/${resolved})`);
console.log('');
console.log(`legacy (pre-rewrite) claim: ${legacyTotal.toFixed(1)}R over ${legacyResolved} resolved`);
console.log(`delta:                      ${(totNet - legacyTotal).toFixed(1)}R — expected: numbers get worse because they become true`);

// ─── Optional 1m cross-verification (spec 03 acceptance check 1) ─────────────

if (VERIFY) {
  const k1raw = JSON.parse(fs.readFileSync(path.join(String(KLINES_DIR), 'klines-1m.json'), 'utf8'));
  const opens = k1raw.map(b => b.openTime);

  // Binary search: first 1m bar with openTime >= ms.
  function idxAt(ms) {
    let lo = 0, hi = opens.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (opens[mid] < ms) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Same ladder semantics at 1m resolution (stop-first within a 1m bar).
  function walk1m(t, fromSec) {
    const fill = t.confirmedPrice, stop = t.stop;
    const risk = Math.abs(fill - stop);
    const isLong = t.direction === 'long';
    const tps = [t.tp1, t.tp2, t.tp3].filter(v => v != null);
    if (!(risk > 0) || tps.length === 0) return null;
    const rungs = tps.map(px => ({ px, rr: (isLong ? px - fill : fill - px) / risk }));
    let realized = 0, remaining = 1, hit = 0;
    for (let i = idxAt(fromSec * 1000); i < k1raw.length; i++) {
      const b = k1raw[i];
      const stopTouched = isLong ? b.low <= stop : b.high >= stop;
      if (stopTouched) { realized += remaining * -1; return { outcome: 'stop', grossR: realized }; }
      while (hit < rungs.length) {
        const r = rungs[hit];
        const touched = isLong ? b.high >= r.px : b.low <= r.px;
        if (!touched) break;
        realized += (1 / rungs.length) * r.rr; remaining -= 1 / rungs.length; hit++;
      }
      if (hit === rungs.length) return { outcome: `tp${hit}`, grossR: realized };
    }
    return null;
  }

  let agree = 0, checked = 0, sumAbsDiff = 0, bigDiff = 0;
  const disagreements = [];
  for (const { t, confirmCloseSec, walk } of results) {
    const v = walk1m(t, confirmCloseSec);
    if (!v) continue;
    checked++;
    const dGross = Math.abs(v.grossR - walk.grossR);
    sumAbsDiff += dGross;
    if (dGross > 0.05) bigDiff++;
    if (v.outcome === walk.outcome) agree++;
    else disagreements.push({ id: t.id, r30: walk.outcome, r1m: v.outcome, gross30: walk.grossR, gross1m: +v.grossR.toFixed(3) });
  }
  console.log('');
  console.log('── 1m cross-verification ──');
  console.log(`outcome-class agreement: ${agree}/${checked} = ${(100 * agree / (checked || 1)).toFixed(1)}%  (acceptance: ≥98%)`);
  // Terminal ladder labels can agree while banked rungs differ (30m stop-first
  // vs 1m sequencing) — report magnitude agreement too so 100% class match
  // can't hide payoff drift.
  console.log(`grossR mean |Δ| 30m-vs-1m: ${(sumAbsDiff / (checked || 1)).toFixed(4)}R  (|Δ|>0.05R on ${bigDiff}/${checked})`);
  if (disagreements.length) {
    console.log(`disagreements (${disagreements.length}) — acceptable cause is 30m-vs-1m same-bar granularity only:`);
    disagreements.forEach(d => console.log(`  ${d.id}: 30m=${d.r30} 1m=${d.r1m} (gross ${d.gross30} vs ${d.gross1m})`));
  }
}

// ─── Write ───────────────────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log('\n--dry-run: nothing written.');
} else {
  const bak = `${TRADES_PATH}.bak-${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(TRADES_PATH, bak);
  const tmp = TRADES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trades, null, 2));
  fs.renameSync(tmp, TRADES_PATH);
  console.log(`\nwritten in place: ${TRADES_PATH}`);
  console.log(`backup:           ${bak}`);
  console.log('\nNEXT (live apply only): snapshot a FRESH baseline —');
  console.log('  node scripts/audit/win-rate-diff.js --snapshot notes/baselines/post-spec03-<date>.json');
  console.log('Existing baselines measure the old artifact; never diff against them.');
}
