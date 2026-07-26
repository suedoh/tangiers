#!/usr/bin/env node
'use strict';

/**
 * Ledger rewrite acceptance tests (rebuild specs 03/04/05).
 * Plain node assert — no framework (repo has none).
 *
 * Run: node scripts/tests/ledger.test.js; echo $?
 *
 * Optional: TRADES_COPY=/path/to/trades-copy.json enables the spec-05
 * incident-replay section against a snapshot of the real signal history
 * (never point it at the live trades.json — read-only either way).
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const tc     = require(path.resolve(__dirname, '..', 'trigger-check.js'));

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const H = 1800; // 30M bar seconds
const t0 = 1_753_500_000; // arbitrary epoch (sec), signal fire time
const bar = (time, high, low, close) => ({ time, open: close, high, low, close });

const mkLong = (over = {}) => ({
  id: 'test-long', firedAt: new Date(t0 * 1000).toISOString(), direction: 'long',
  entry: 100, stop: 95, tp1: 110, tp2: 120, tp3: 130,
  confirmed: false, confirmedAt: null, confirmedPrice: null, outcome: null, pnlR: null,
  ...over,
});

console.log('── spec 03: confirmation on completed bars only ──');

ok('forming bar beyond entry must NOT confirm', () => {
  const b = bar(t0 + 900, 106, 99, 105); // opens after signal, close beyond entry
  const nowSec = b.time + 900;           // bar still in progress
  assert.strictEqual(tc.decideConfirmation(mkLong(), [b], nowSec), null);
});

ok('same bar, completed, confirms at its close', () => {
  const b = bar(t0 + 900, 106, 99, 105);
  const nowSec = b.time + H;             // bar just completed
  const conf = tc.decideConfirmation(mkLong(), [b], nowSec);
  assert.ok(conf, 'expected confirmation');
  assert.strictEqual(conf.confirmedPrice, 105);
  assert.strictEqual(conf.barTime, t0 + 900);
});

ok('bar opening after the 1h cap never confirms', () => {
  const b = bar(t0 + tc.CONFIRM_MAX_AGE_SEC + 1, 106, 99, 105);
  assert.strictEqual(tc.decideConfirmation(mkLong(), [b], b.time + 2 * H), null);
});

ok('short confirms only on completed close BELOW entry', () => {
  const t = mkLong({ direction: 'short', entry: 100, stop: 105, tp1: 90, tp2: 80, tp3: 70 });
  const forming  = bar(t0 + 900, 101, 94, 95);
  assert.strictEqual(tc.decideConfirmation(t, [forming], forming.time + 900), null);
  const conf = tc.decideConfirmation(t, [forming], forming.time + H);
  assert.strictEqual(conf.confirmedPrice, 95);
});

console.log('── spec 03: no-entry-touch ⇒ expired_unconfirmed, not a win ──');

ok('price runs to TP3 on wicks but never closes beyond entry ⇒ no trade', () => {
  const t = mkLong();
  // Highs sweep through all TPs; closes stay below entry the whole window.
  const bars = [
    bar(t0 + 900,           135, 96, 99),
    bar(t0 + 900 + H,       135, 96, 98),
    bar(t0 + 900 + 2 * H,   135, 96, 99.5),
  ];
  const nowSec = t0 + tc.CONFIRM_MAX_AGE_SEC + H + 1; // window fully closed
  assert.strictEqual(tc.decideConfirmation(t, bars, nowSec), null, 'must not confirm');
  assert.strictEqual(tc.unconfirmedExpiry(t, nowSec), true, 'must retire as expired_unconfirmed');
  // Boundary: while the last candidate bar can still complete, not expired yet.
  assert.strictEqual(tc.unconfirmedExpiry(t, t0 + tc.CONFIRM_MAX_AGE_SEC + H - 1), false);
});

console.log('── spec 03: design-intent walker (fill = confirmed close, ladder, fees) ──');

// Confirmed long: fill 105, stop 95 → riskPerUnit 10.
// Re-anchored rungs: rr1=(110−105)/10=0.5, rr2=1.5, rr3=2.5 — 1/3 each.
const confLong = mkLong({
  confirmed: true,
  confirmedAt: new Date((t0 + 900) * 1000).toISOString(),
  confirmedPrice: 105, fillPrice: 105, riskPerUnit: 10,
});

ok('full TP run: gross = mean(rr), fees charged, pnlR net', () => {
  const w = tc.walkBarsForOutcome(confLong, [
    bar(t0 + 900 + H,     121, 99, 120),  // banks tp1 + tp2
    bar(t0 + 900 + 2 * H, 131, 118, 130), // banks tp3
  ]);
  assert.strictEqual(w.outcome, 'tp3');
  assert.strictEqual(w.rungsBanked, 3);
  assert.strictEqual(w.grossR, 1.5); // (0.5+1.5+2.5)/3
  // fees: entry 6bp×105 + maker 2bp×(110+120+130)/3 = 0.063 + 0.024 = 0.087 → /10
  assert.strictEqual(w.feeR, 0.009);       // round3(0.0087)
  assert.strictEqual(w.pnlR, 1.491);       // round3(1.5 − 0.0087)
});

ok('same-bar stop+TP ambiguity: stop first, no rungs banked', () => {
  const w = tc.walkBarsForOutcome(confLong, [
    bar(t0 + 900 + H, 131, 94, 96), // touches tp3 AND stop in one bar
  ]);
  assert.strictEqual(w.outcome, 'stop');
  assert.strictEqual(w.rungsBanked, 0);
  assert.strictEqual(w.grossR, -1);
  // fees: entry 6bp×105 + stop 6bp×95 = 0.063+0.057 = 0.12 → feeR 0.012
  assert.strictEqual(w.feeR, 0.012);
  assert.strictEqual(w.pnlR, -1.012);
});

ok('partial ladder then stop: banked rung survives, remainder −1R', () => {
  const w = tc.walkBarsForOutcome(confLong, [
    bar(t0 + 900 + H,     111, 99, 110),  // banks tp1 only: +0.5/3
    bar(t0 + 900 + 2 * H, 112, 94, 95),   // stop: remaining 2/3 × −1
  ]);
  assert.strictEqual(w.outcome, 'stop');
  assert.strictEqual(w.rungsBanked, 1);
  assert.strictEqual(w.grossR, -0.5); // 0.1667 − 0.6667
  // fees: 0.063 + 2bp×110/3 (0.00733) + 6bp×95×2/3 (0.038) = 0.10833 → 0.011
  assert.strictEqual(w.feeR, 0.011);
  assert.strictEqual(w.pnlR, -0.511);
});

ok('fill beyond TP1 banks the rung at its negative re-anchored rr (no phantom win)', () => {
  const t = mkLong({
    confirmed: true, confirmedAt: new Date((t0 + 900) * 1000).toISOString(),
    confirmedPrice: 112, fillPrice: 112, riskPerUnit: 17,
  });
  const w = tc.walkBarsForOutcome(t, [bar(t0 + 900 + H, 113, 111, 112)]);
  assert.strictEqual(w, null, 'ladder still open — only tp1 touched');
  const w2 = tc.walkBarsForOutcome(t, [
    bar(t0 + 900 + H,     113, 111, 112),
    bar(t0 + 900 + 2 * H, 131, 111, 130),
  ]);
  assert.strictEqual(w2.outcome, 'tp3');
  // rr1 = (110−112)/17 < 0 — the run-through rung must DRAG the total down.
  const rr1 = (110 - 112) / 17, rr2 = (120 - 112) / 17, rr3 = (130 - 112) / 17;
  assert.strictEqual(w2.grossR, Math.round(((rr1 + rr2 + rr3) / 3) * 1000) / 1000);
  assert.ok(rr1 < 0);
});

ok('open ladder returns null (still live)', () => {
  assert.strictEqual(tc.walkBarsForOutcome(confLong, [bar(t0 + 900 + H, 108, 99, 107)]), null);
});

ok('walker refuses a trade with no fill (unconfirmed can never be walked)', () => {
  assert.strictEqual(tc.walkBarsForOutcome(mkLong(), [bar(t0 + 900 + H, 131, 94, 96)]), null);
});

// ─── spec 04: kill switch reads exchange truth, falls back with alert ────────

const dailyR = require(path.resolve(__dirname, '..', 'lib', 'daily-r.js'));
const os = require('os');

async function spec04() {
  console.log('── spec 04: daily-R kill switch (exchange primary, ledger fallback) ──');

  assert.strictEqual(dailyR.DAILY_R_KILL_FLOOR, -3.0); // unchanged per spec 04.3

  // Mock: one signal, entry filled today (30 contracts = 0.03 BTC at
  // riskPerUnit $500 ⇒ $15 risk), exit realized −$44 with $4 fee ⇒ −$48 net
  // ⇒ −3.2R — must trip the −3.0 floor.
  const nowMs = Date.UTC(2026, 6, 26, 15, 0, 0);
  const midnight = Date.UTC(2026, 6, 26, 0, 0, 0);
  const trade = { id: 'sigA-1', riskPerUnit: 500, entry: 100000, stop: 99500 };
  const cid = 'sigA1';
  const orders = [
    { orderId: '1', clientOrderId: cid, state: 'filled', createTime: midnight + 1000,
      updateTime: midnight + 1000, filledSize: '30', pnl: '0', fee: '0' },
    { orderId: '2', state: 'filled', createTime: midnight + 2000,
      updateTime: midnight + 2000, filledSize: '30', pnl: '-44', fee: '4' },
  ];
  const deps = {
    getOrderHistory: async () => orders,
    readTrades: () => [trade],
    lookupSignalIds: async () => new Map([['2', 'sigA-1']]),
    now: () => nowMs,
  };

  {
    const r = await dailyR.todayExchangeR(deps);
    assert.ok(Math.abs(r - (-3.2)) < 1e-9, `expected −3.2R, got ${r}`);
    const k = await dailyR.isKillActive(deps);
    assert.strictEqual(k.active, true);
    assert.strictEqual(k.source, 'exchange');
    passed++; console.log('  ✓ −3.2R of exchange fills today ⇒ isKillActive true (exchange source)');
  }

  {
    // −2.9R must NOT trip.
    const okOrders = orders.map(o => o.orderId === '2' ? { ...o, pnl: '-39.5' } : o);
    const k = await dailyR.isKillActive({ ...deps, getOrderHistory: async () => okOrders });
    assert.strictEqual(k.active, false);
    assert.strictEqual(k.source, 'exchange');
    passed++; console.log('  ✓ −2.9R does not trip the floor');
  }

  {
    // API error ⇒ ledger fallback + yellow alert fires (rate-limited state
    // in a temp file so re-runs stay clean).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-r-test-'));
    let alerted = null;
    const k = await dailyR.isKillActive({
      ...deps,
      getOrderHistory: async () => { throw new Error('http 403 cloudflare'); },
      alertFile: path.join(tmpDir, 'alert.json'),
      postAlert: body => { alerted = body; },
    });
    assert.strictEqual(k.source, 'ledger-fallback');
    assert.ok(alerted && alerted.includes('FALLBACK'), 'yellow fallback alert must fire');
    passed++; console.log('  ✓ API error ⇒ ledger fallback + yellow alert fires');
  }
}

// ─── spec 05: price-time cell dedup ──────────────────────────────────────────

function spec05() {
  console.log('── spec 05: price-time cell dedup ──');

  const DAY = tc.CELL_EXPIRY_MS;
  const now = 1_785_000_000_000;
  const P   = 64_000;                    // reference price; band = $192 at 0.3%
  const fresh = () => ({});

  ok('same direction, same band, within 24h ⇒ suppressed', () => {
    const st = fresh();
    tc.markCellFired(st, 'long', 64_000, P, now);
    // $100 away — inside the $192 band
    assert.ok(tc.findBlockingCell(st, 'long', 64_100, now + 3 * 3600e3),
      'a same-idea refire inside the band must be blocked');
  });

  ok('adjacent band (outside band width) ⇒ fires', () => {
    const st = fresh();
    tc.markCellFired(st, 'long', 64_000, P, now);
    assert.strictEqual(tc.findBlockingCell(st, 'long', 64_000 + 250, now + 3600e3), null,
      'a genuinely different price level must not be suppressed');
  });

  ok('same band, opposite direction ⇒ fires (failed-breakout flips survive)', () => {
    const st = fresh();
    tc.markCellFired(st, 'long', 64_000, P, now);
    assert.strictEqual(tc.findBlockingCell(st, 'short', 64_010, now + 3600e3), null,
      'cells are direction-keyed — the flip trade must still be allowed');
  });

  ok('cell expiry ⇒ fires again after 24h', () => {
    const st = fresh();
    tc.markCellFired(st, 'long', 64_000, P, now);
    assert.ok(tc.findBlockingCell(st, 'long', 64_010, now + DAY - 60e3), 'blocked at 23h59m');
    assert.strictEqual(tc.findBlockingCell(st, 'long', 64_010, now + DAY + 1), null,
      'must fire once the cell expires');
  });

  ok('pruneCells drops only expired cells', () => {
    const st = fresh();
    tc.markCellFired(st, 'long',  64_000, P, now - DAY - 1);  // expired
    tc.markCellFired(st, 'short', 64_000, P, now);            // live
    tc.pruneCells(st, now);
    assert.strictEqual(st[tc.FIRED_CELLS_KEY].length, 1);
    assert.strictEqual(st[tc.FIRED_CELLS_KEY][0].direction, 'short');
  });

  ok('state survives a JSON write/reload round-trip', () => {
    const st = fresh();
    tc.markCellFired(st, 'long', 64_000, P, now);
    const reloaded = JSON.parse(JSON.stringify(st));   // exactly what writeState/readState do
    assert.ok(tc.findBlockingCell(reloaded, 'long', 64_050, now + 3600e3),
      'cells must still block after a restart');
  });

  // ── Incident replay (spec 05 acceptance 1) ────────────────────────────────
  // Replays the real signal burst that stacked the 238.3-contract position.
  // Requires TRADES_COPY pointing at a *snapshot* of trades.json.
  //
  // SPEC CORRECTION (verified 2026-07-26): spec 05 stated the acceptance as
  // "1 fire + 47 suppressed", assuming a single-day burst. The ledger shows
  // the burst is 40 long signals (34 placed, 6 skipped) spanning 47.7 HOURS,
  // not one day. With a 24h cell, the correct expectation is ONE fire per
  // 24h cell period — 2 fires, 24.5h apart, the second only after the first
  // cell legitimately expired. Asserting 1 here would demand a cell that
  // never re-arms, which is not the design. The invariant actually worth
  // enforcing: no fire ever lands while a same-direction cell is live.
  const copy = process.env.TRADES_COPY;
  if (!copy || !fs.existsSync(copy)) {
    console.log('  ⚠ incident replay SKIPPED (set TRADES_COPY to a trades.json snapshot)');
    return;
  }

  ok('incident replay: 47.7h burst collapses to one fire per 24h cell', () => {
    const all = JSON.parse(fs.readFileSync(copy, 'utf8'));
    const burst = all
      .filter(t => t.firedAt >= '2026-07-24' && t.firedAt < '2026-07-27' && t.direction === 'long')
      .sort((a, b) => a.firedAt.localeCompare(b.firedAt));
    assert.ok(burst.length >= 35, `expected the ~40-signal burst, found ${burst.length}`);

    const st = {};
    const fires = [];
    let suppressed = 0;
    for (const t of burst) {
      const ts = Date.parse(t.firedAt);
      const zonePrice = t.zone?.mid ?? t.entry;
      tc.pruneCells(st, ts);
      if (tc.findBlockingCell(st, t.direction, zonePrice, ts)) { suppressed++; continue; }
      tc.markCellFired(st, t.direction, zonePrice, t.entry, ts);
      fires.push(ts);
    }
    const spanH = (Date.parse(burst[burst.length - 1].firedAt) - Date.parse(burst[0].firedAt)) / 3600e3;
    console.log(`      replay: ${burst.length} signals over ${spanH.toFixed(1)}h → ${fires.length} fired, ${suppressed} suppressed`);

    // Hard invariant: consecutive fires must be ≥24h apart (i.e. every fire
    // after the first is a legitimate post-expiry re-arm, never a refire).
    for (let i = 1; i < fires.length; i++) {
      assert.ok(fires[i] - fires[i - 1] >= tc.CELL_EXPIRY_MS,
        `fire ${i} came ${((fires[i] - fires[i - 1]) / 3600e3).toFixed(1)}h after the previous — a live cell was not honoured`);
    }
    // Ceiling: at most one fire per 24h period the burst spans.
    const maxFires = Math.ceil(spanH / 24);
    assert.ok(fires.length <= maxFires,
      `${fires.length} fires exceeds the ${maxFires} the burst's ${spanH.toFixed(1)}h span allows`);
    // Containment: production placed 34 orders here; dedup must cut ≥90%.
    assert.ok(suppressed / burst.length >= 0.90,
      `suppression ${(100 * suppressed / burst.length).toFixed(0)}% — expected ≥90%`);
  });
}

// ─── run async sections, then report ─────────────────────────────────────────

(async () => {
  await spec04();
  spec05();
  console.log(`\nledger.test.js: all ${passed} assertions passed`);
})().catch(e => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
