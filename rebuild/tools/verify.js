'use strict';
// Independent ground-truth verification of trades.json against Binance klines.
const fs = require('fs');
const trades = JSON.parse(fs.readFileSync(`${__dirname}/trades.json`, 'utf8'));
const k30 = JSON.parse(fs.readFileSync(`${__dirname}/klines-30m.json`, 'utf8'));
const k1  = JSON.parse(fs.readFileSync(`${__dirname}/klines-1m.json`, 'utf8'));

const k1ByOpen = new Map(k1.map(b => [b.openTime, b]));
const k30Opens = k30.map(b => b.openTime);

function bar1mAt(ms) { return k1ByOpen.get(Math.floor(ms / 60000) * 60000); }
function idx30After(ms) { // first 30m bar with openTime > ms (seconds semantics of code: bar.time > signalTs)
  let lo = 0, hi = k30.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (k30Opens[mid] > ms) hi = mid; else lo = mid + 1; }
  return lo;
}

// ---- code-faithful canonical walk (30m, stop-first, tp3->tp1, full position at rrN)
function walk30(t) {
  const stop = t.stop, tp1 = t.tp1, tp2 = t.tp2, tp3 = t.tp3;
  const rr1 = parseFloat(t.rr1), rr2 = parseFloat(t.rr2), rr3 = parseFloat(t.rr3);
  const fired = Date.parse(t.firedAt);
  for (let i = idx30After(fired); i < k30.length; i++) {
    const b = k30[i];
    if (t.direction === 'long') {
      if (b.low  <= stop) return { outcome: 'stop', pnlR: -1, at: b.openTime };
      if (b.high >= tp3)  return { outcome: 'tp3',  pnlR: rr3, at: b.openTime };
      if (b.high >= tp2)  return { outcome: 'tp2',  pnlR: rr2, at: b.openTime };
      if (b.high >= tp1)  return { outcome: 'tp1',  pnlR: rr1, at: b.openTime };
    } else {
      if (b.high >= stop) return { outcome: 'stop', pnlR: -1, at: b.openTime };
      if (b.low  <= tp3)  return { outcome: 'tp3',  pnlR: rr3, at: b.openTime };
      if (b.low  <= tp2)  return { outcome: 'tp2',  pnlR: rr2, at: b.openTime };
      if (b.low  <= tp1)  return { outcome: 'tp1',  pnlR: rr1, at: b.openTime };
    }
  }
  return null;
}

// ---- 1m walk with arbitrary fill price & ladder or full-position accounting
// fees charged separately by caller. Returns {outcome, grossR, at, rungsBanked}
function walk1m(t, fillPx, fromMs, mode /* 'full' | 'ladder' */, burnRule) {
  const stop = t.stop; const isLong = t.direction === 'long';
  const risk = Math.abs(fillPx - stop);
  if (!(risk > 0)) return { outcome: 'instant_invalid', grossR: null };
  let tps = [t.tp1, t.tp2, t.tp3].filter(v => v != null);
  if (burnRule) {
    const minGap = Math.max(fillPx * 0.0005, Math.abs(t.entry - t.stop) * 0.1);
    tps = tps.filter(px => isLong ? px >= fillPx + minGap : px <= fillPx - minGap);
    if (!tps.length) return { outcome: 'all_burned', grossR: 0, rungsBanked: 0 };
  }
  const rungs = tps.map(px => ({ px, rr: (isLong ? px - fillPx : fillPx - px) / risk }));
  let realized = 0, remaining = 1, hit = 0;
  const startIdx = Math.floor(fromMs / 60000) * 60000;
  for (let ms = startIdx; ; ms += 60000) {
    const b = k1ByOpen.get(ms);
    if (!b) { if (ms > k1[k1.length-1].openTime) break; else continue; }
    if (ms < fromMs) continue;
    const stopTouched = isLong ? b.low <= stop : b.high >= stop;
    if (stopTouched) {
      realized += remaining * -1;
      return { outcome: hit > 0 ? `stop_after_${hit}` : 'stop', grossR: realized, at: ms, rungsBanked: hit };
    }
    if (mode === 'full') {
      // full position exits at farthest rung touched this bar (mirrors canonical semantics)
      let best = -1;
      for (let j = rungs.length - 1; j >= 0; j--) {
        const touched = isLong ? b.high >= rungs[j].px : b.low <= rungs[j].px;
        if (touched) { best = j; break; }
      }
      if (best >= 0) return { outcome: `tp${best+1}`, grossR: rungs[best].rr, at: ms, rungsBanked: 1 };
    } else {
      while (hit < rungs.length) {
        const r = rungs[hit];
        const touched = isLong ? b.high >= r.px : b.low <= r.px;
        if (!touched) break;
        realized += (1 / rungs.length) * r.rr;   // equal thirds of ORIGINAL rung count? use 1/n of surviving rungs
        remaining -= 1 / rungs.length;
        hit++;
      }
      if (hit === rungs.length) return { outcome: `tp${hit}`, grossR: realized, at: ms, rungsBanked: hit };
    }
  }
  return { outcome: 'open', grossR: null, rungsBanked: hit, partial: realized };
}

const TOL = 0.0005; // 5bp feed tolerance TV vs Binance (same venue, should be ~0)
const out = [];
let priceOk = 0, priceBad = 0, priceNoBar = 0;

for (const t of trades) {
  const fired = Date.parse(t.firedAt);
  const fb = bar1mAt(fired);
  const rec = { id: t.id, firedAt: t.firedAt, direction: t.direction, setupType: t.setupType,
    probability: t.probability, price: t.price, entry: t.entry, stop: t.stop,
    tp1: t.tp1, tp2: t.tp2, tp3: t.tp3, rr1: parseFloat(t.rr1), rr2: parseFloat(t.rr2), rr3: parseFloat(t.rr3),
    zoneType: t.zone?.type, confirmed: t.confirmed, confirmedAt: t.confirmedAt, confirmedPrice: t.confirmedPrice,
    outcome: t.outcome, pnlR: t.pnlR, closedAt: t.closedAt,
    executionStatus: t.executionStatus ?? null, executedOutcome: t.executedOutcome ?? null, executedPnlR: t.executedPnlR ?? null };

  // 1. price consistency at fire time
  if (!fb) { rec.priceCheck = 'no_bar'; priceNoBar++; }
  else {
    const lo = fb.low * (1 - TOL), hi = fb.high * (1 + TOL);
    rec.priceCheck = (t.price >= lo && t.price <= hi) ? 'ok' : 'out_of_bar';
    rec.priceDevBp = t.price > fb.high ? (t.price / fb.high - 1) * 1e4 : t.price < fb.low ? (t.price / fb.low - 1) * 1e4 : 0;
    if (rec.priceCheck === 'ok') priceOk++; else priceBad++;
  }

  // fire-time market reference: open of NEXT 1m bar (earliest achievable market fill)
  const nextMin = (Math.floor(fired / 60000) + 1) * 60000;
  const nb = k1ByOpen.get(nextMin);
  rec.mktFill = nb ? nb.open : (fb ? fb.close : t.price);
  // limit-advantage: how much better is planned entry than achievable market, in plan-R units
  const planRisk = Math.abs(t.entry - t.stop);
  rec.planRiskPts = planRisk;
  rec.limitAdvR = t.direction === 'long' ? (rec.mktFill - t.entry) / planRisk : (t.entry - rec.mktFill) / planRisk;

  // 2. strict confirmation: first 30m bar with openTime in (fired, fired+3600s] whose CLOSE is beyond entry
  let strictConf = null;
  for (let i = idx30After(fired); i < k30.length; i++) {
    const b = k30[i];
    if (b.openTime > fired + 3600e3) break;
    const ok = t.direction === 'long' ? b.close > t.entry : b.close < t.entry;
    if (ok) { strictConf = { at: b.openTime + 1800e3, close: b.close, barOpen: b.openTime }; break; }
  }
  rec.strictConfirm = !!strictConf;
  rec.strictConfirmAt = strictConf ? new Date(strictConf.at).toISOString() : null;
  // recorded confirmedPrice vs the true final close of the bar it claims confirmed on
  if (t.confirmed && t.confirmedAt) {
    const cbOpen = Date.parse(t.confirmedAt);
    const cb = k30.find(b => b.openTime === cbOpen);
    rec.confirmBarTrueClose = cb ? cb.close : null;
    rec.confirmPriceMatchesBarClose = cb ? Math.abs(cb.close - t.confirmedPrice) <= cb.close * TOL : null;
    rec.confirmBarWouldConfirmAtClose = cb ? (t.direction === 'long' ? cb.close > t.entry : cb.close < t.entry) : null;
  }

  // 3. code-faithful reproduction
  const rep = walk30(t);
  rec.repOutcome = rep ? rep.outcome : 'open';
  rec.repPnlR = rep ? rep.pnlR : null;
  rec.repAt = rep ? new Date(rep.at).toISOString() : null;
  rec.repMatch = (t.outcome === rec.repOutcome) || (['invalidated','expired'].includes(t.outcome));

  // 4a. market-at-fire, full-position first-touch (honest denominator)
  const mFull = walk1m(t, rec.mktFill, nextMin, 'full', false);
  rec.mktFullOutcome = mFull.outcome; rec.mktFullR = mFull.grossR;
  // 4b. market-at-fire, 1/3 ladder with burn rule (models BloFin path)
  const mLad = walk1m(t, rec.mktFill, nextMin, 'ladder', true);
  rec.mktLadOutcome = mLad.outcome; rec.mktLadR = mLad.grossR; rec.mktLadRungs = mLad.rungsBanked;
  rec.notionalOverRisk = rec.mktFill / Math.abs(rec.mktFill - t.stop) > 0 ? rec.mktFill / Math.abs(rec.mktFill - t.stop) : null;

  // 4c. limit-at-entry fill-aware: does price trade through entry before any TP touch?
  let filledAt = null, tpFirst = false;
  outer:
  for (let ms = nextMin; ms <= k1[k1.length-1].openTime; ms += 60000) {
    const b = k1ByOpen.get(ms); if (!b) continue;
    const tpsTouched = [t.tp1, t.tp2, t.tp3].some(px => px != null && (t.direction === 'long' ? b.high >= px : b.low <= px));
    const entryTouched = t.direction === 'long' ? b.low <= t.entry : b.high >= t.entry;
    const stopTouched = t.direction === 'long' ? b.low <= t.stop : b.high >= t.stop;
    // conservative ordering inside the bar: entry-touch counts before TP (limit sits between fire px and stop)
    if (entryTouched) { filledAt = ms; break outer; }
    if (tpsTouched) { tpFirst = true; break outer; }
    if (stopTouched) { filledAt = ms; break outer; } // stop beyond entry — entry necessarily crossed
  }
  if (tpFirst) { rec.limitFilled = false; rec.limitOutcome = 'never_filled_tp_first'; rec.limitR = 0; }
  else if (!filledAt) { rec.limitFilled = false; rec.limitOutcome = 'never_filled_open'; rec.limitR = 0; }
  else {
    rec.limitFilled = true;
    const lFull = walk1m(t, t.entry, filledAt, 'full', false);
    rec.limitOutcome = lFull.outcome; rec.limitR = lFull.grossR;
  }
  out.push(rec);
}

fs.writeFileSync(`${__dirname}/verified.json`, JSON.stringify(out, null, 1));

// ---- summary
const n = out.length;
const resolved = out.filter(r => ['tp1','tp2','tp3','stop'].includes(r.outcome));
const rep = resolved.filter(r => r.repOutcome === r.outcome);
console.log(`n=${n} priceOk=${priceOk} priceBad=${priceBad} priceNoBar=${priceNoBar}`);
console.log(`tp/stop-resolved=${resolved.length} outcome reproduction: ${rep.length}/${resolved.length} = ${(100*rep.length/resolved.length).toFixed(1)}%`);
const mm = resolved.filter(r => r.repOutcome !== r.outcome);
const dirFav = mm.filter(r => (r.pnlR ?? 0) > (r.repPnlR ?? 0)).length;
console.log(`mismatches=${mm.length} of which recorded>rederived (favourable): ${dirFav}`);
const conf = out.filter(r => r.confirmed);
const strictOk = conf.filter(r => r.strictConfirm).length;
console.log(`confirmed recorded=${conf.length} strict-close would confirm=${strictOk}`);
const cpm = conf.filter(r => r.confirmPriceMatchesBarClose === false);
console.log(`confirmedPrice != true bar close (forming-bar confirm evidence): ${cpm.length}/${conf.filter(r=>r.confirmPriceMatchesBarClose!=null).length}`);
const sum = a => a.reduce((s, x) => s + (x || 0), 0);
console.log(`claimed pnlR total: ${sum(out.map(r => r.pnlR)).toFixed(1)}`);
console.log(`rederived canonical (walk30) total: ${sum(out.map(r => r.repPnlR)).toFixed(1)}`);
console.log(`market-fill full-position gross R total: ${sum(out.map(r => r.mktFullR)).toFixed(1)}  (n resolved ${out.filter(r=>r.mktFullR!=null).length})`);
console.log(`market-fill 1/3-ladder gross R total: ${sum(out.map(r => r.mktLadR)).toFixed(1)}  (n resolved ${out.filter(r=>r.mktLadR!=null).length})`);
console.log(`limit fill-aware: filled=${out.filter(r=>r.limitFilled).length} neverFilled_tpFirst=${out.filter(r=>r.limitOutcome==='never_filled_tp_first').length} total R=${sum(out.map(r=>r.limitR)).toFixed(1)}`);
const med = a => { const s=[...a].sort((x,y)=>x-y); return s[(s.length/2)|0]; };
console.log(`limit-advantage (plan entry vs achievable mkt) R units: median=${med(out.map(r=>r.limitAdvR)).toFixed(2)}`);
console.log(`notional/risk ratio: median=${med(out.filter(r=>r.notionalOverRisk).map(r=>r.notionalOverRisk)).toFixed(0)}x`);
