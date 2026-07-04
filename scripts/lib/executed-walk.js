'use strict';

/**
 * Executed-hypothetical ladder walk (Phase D attribution decision 4).
 *
 * Models what autotrade actually places — a 1/N TP ladder plus a full-size
 * structural SL — instead of flattening the whole position at the first
 * touched level. The prior walk (walkBarsForOutcome, canonical track) credits
 * the FULL position at the first level a bar crosses; a real tp3 run through
 * a 1/3 ladder pays (rr1+rr2+rr3)/3, not rr3. Full decomposition in
 * refactors/2026-07-02-phase-d-attribution.md (cause 1) and
 * refactors/2026-07-04-executed-track-ladder-rewalk.md.
 *
 * Semantics (kept aligned with the canonical walk where they overlap):
 *   - Bars are walked chronologically; the entry bar itself is excluded by
 *     the caller (bar.time > signal fire time).
 *   - Same-bar ambiguity: stop wins. If a bar touches the stop, the whole
 *     remaining position closes at -1R and NO rung is banked from that bar —
 *     conservative, same rule the canonical track documents.
 *   - Rungs bank in order (tp1 → tp2 → tp3); each closes 1/N of the position
 *     at its own plan R:R (|tp - entry| / |entry - stop|).
 *   - Outcome label is the TERMINAL event: 'tpN' when the last rung fills,
 *     'stop' when the stop closes the remainder — so a 'stop' outcome can
 *     still carry positive pnlR if rungs were banked first.
 *   - Returns null while the ladder is still live (partial rungs re-bank on
 *     the next stateless walk over the same history).
 */

function _num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the ladder from a trade record's plan prices. Rung R:R is derived
 * from prices (ground truth geometry); size is 1/N over the rungs present.
 * Returns null when the plan is unusable (no risk distance, no TPs).
 */
function ladderRungs(t) {
  const entry = _num(t.entry);
  const stop  = _num(t.stop);
  if (entry == null || stop == null) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  const tps = [t.tp1, t.tp2, t.tp3]
    .map(_num)
    .filter(v => v != null);
  if (tps.length === 0) return null;

  const size = 1 / tps.length;
  return tps.map(tp => ({
    price: tp,
    rr:    Math.abs(tp - entry) / risk,
    size,
  }));
}

/**
 * Walk bars ({time, high, low} — seconds, chronological) against a trade's
 * ladder. Returns { outcome, pnlR, closedBarTime } or null if still open.
 */
function walkExecutedLadder(t, bars) {
  const rungs = ladderRungs(t);
  const stop  = _num(t.stop);
  if (!rungs || stop == null) return null;
  const isLong = t.direction === 'long';

  let realized  = 0;
  let remaining = 1;
  let hit       = 0;

  for (const bar of bars) {
    const stopTouched = isLong ? bar.low <= stop : bar.high >= stop;
    if (stopTouched) {
      realized += remaining * -1;
      return { outcome: 'stop', pnlR: _round(realized), closedBarTime: bar.time };
    }
    while (hit < rungs.length) {
      const r = rungs[hit];
      const touched = isLong ? bar.high >= r.price : bar.low <= r.price;
      if (!touched) break;
      realized  += r.size * r.rr;
      remaining -= r.size;
      hit++;
    }
    if (hit === rungs.length) {
      return { outcome: `tp${hit}`, pnlR: _round(realized), closedBarTime: bar.time };
    }
  }
  return null;
}

function _round(r) {
  return Math.round(r * 100) / 100;
}

module.exports = { walkExecutedLadder, ladderRungs };
