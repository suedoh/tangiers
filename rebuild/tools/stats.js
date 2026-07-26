'use strict';
// Phase 3 statistical battery + falsification Monte Carlo.
const fs = require('fs');
const trades = JSON.parse(fs.readFileSync(`${__dirname}/trades.json`, 'utf8'));
const V = JSON.parse(fs.readFileSync(`${__dirname}/verified.json`, 'utf8'));
const k30 = JSON.parse(fs.readFileSync(`${__dirname}/klines-30m.json`, 'utf8'));
const k1 = JSON.parse(fs.readFileSync(`${__dirname}/klines-1m.json`, 'utf8'));
const k1ByOpen = new Map(k1.map(b => [b.openTime, b]));
const TAKER = 0.0006, MAKER = 0.0002; // measured from BloFin fills

// ---------- helpers ----------
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z / d) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [p, c - h, c + h];
}
const lgamma = (() => { // Lanczos
  const g = [676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  return function lg(z) { if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lg(1 - z);
    z -= 1; let x = 0.99999999999980993; for (let i = 0; i < 8; i++) x += g[i] / (z + i + 1);
    const t = z + 7.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x); };
})();
const lchoose = (n, k) => (k < 0 || k > n) ? -Infinity : lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
function fisher2(a, b, c, d) { // two-sided, sum of probs <= observed
  const r1 = a + b, r2 = c + d, c1 = a + c, n = a + b + c + d;
  const lp = x => lchoose(r1, x) + lchoose(r2, c1 - x) - lchoose(n, c1);
  const p0 = lp(a); let p = 0;
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
  for (let x = lo; x <= hi; x++) { const px = lp(x); if (px <= p0 + 1e-9) p += Math.exp(px); }
  return Math.min(1, p);
}
function bh(pvals, q = 0.10) { // returns significance flags
  const idx = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const m = pvals.length; let cut = -1;
  for (let r = 0; r < m; r++) if (idx[r][0] <= q * (r + 1) / m) cut = r;
  const sig = new Array(m).fill(false);
  for (let r = 0; r <= cut; r++) sig[idx[r][1]] = true;
  return sig;
}
let seed = 42;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function bootDayCI(rows, field, B = 10000) {
  const byDay = new Map();
  for (const r of rows) { const d = r.firedAt.slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r[field] ?? 0); }
  const days = [...byDay.values()]; const nD = days.length;
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, c = 0;
    for (let i = 0; i < nD; i++) { const d = days[(rnd() * nD) | 0]; for (const v of d) { s += v; c++; } }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);
  const mean = rows.reduce((s, r) => s + (r[field] ?? 0), 0) / rows.length;
  return { mean, lo: means[(0.025 * B) | 0], hi: means[(0.975 * B) | 0], nDays: nD };
}

// ---------- honest ladder walk with fees (models BloFin exactly: taker entry, maker TP rungs, taker SL) ----------
function ladderNet(t, fillPx, fromMs) {
  const stop = t.stop, isLong = t.direction === 'long';
  const risk = Math.abs(fillPx - stop); if (!(risk > 0)) return null;
  const ratio = fillPx / risk; // notional per dollar-risk
  const minGap = Math.max(fillPx * 0.0005, Math.abs(t.entry - t.stop) * 0.1);
  const tps = [t.tp1, t.tp2, t.tp3].filter(v => v != null)
    .filter(px => isLong ? px >= fillPx + minGap : px <= fillPx - minGap);
  const entryFeeR = ratio * TAKER;
  if (!tps.length) return { outcome: 'all_burned', grossR: 0, netR: -2 * ratio * TAKER, feeR: 2 * ratio * TAKER, at: fromMs };
  const rungs = tps.map(px => ({ px, rr: (isLong ? px - fillPx : fillPx - px) / risk }));
  const shr = 1 / rungs.length;
  let realized = 0, remaining = 1, hit = 0, feeR = entryFeeR;
  const lastMs = k1[k1.length - 1].openTime;
  for (let ms = Math.floor(fromMs / 60000) * 60000; ms <= lastMs; ms += 60000) {
    const b = k1ByOpen.get(ms); if (!b || ms < fromMs) continue;
    if (isLong ? b.low <= stop : b.high >= stop) {
      realized += remaining * -1; feeR += remaining * ratio * TAKER;
      return { outcome: hit ? `stop_after_${hit}` : 'stop', grossR: realized, feeR, netR: realized - feeR, at: ms };
    }
    while (hit < rungs.length) {
      const r = rungs[hit];
      if (!(isLong ? b.high >= r.px : b.low <= r.px)) break;
      realized += shr * r.rr; remaining -= shr; feeR += shr * ratio * MAKER; hit++;
    }
    if (hit === rungs.length) return { outcome: `tp${hit}`, grossR: realized, feeR, netR: realized - feeR, at: ms };
  }
  return { outcome: 'open', grossR: null, netR: null, feeR, at: null };
}

// per-trade net table
const rows = [];
for (const t of trades) {
  const v = V.find(x => x.id === t.id);
  const fired = Date.parse(t.firedAt);
  const nextMin = (Math.floor(fired / 60000) + 1) * 60000;
  const lad = ladderNet(t, v.mktFill, nextMin);
  rows.push({
    id: t.id, firedAt: t.firedAt, direction: t.direction, tier: t.setupType.trim()[0],
    zoneType: t.zone?.type, probability: t.probability,
    claimedR: t.pnlR ?? 0, claimedWin: (t.pnlR ?? 0) > 0 ? 1 : 0,
    resolved: ['tp1','tp2','tp3','stop'].includes(t.outcome) ? 1 : 0,
    ladNetR: lad?.netR ?? null, ladGrossR: lad?.grossR ?? null, ladFeeR: lad?.feeR ?? null,
    ladOutcome: lad?.outcome, ladWin: lad?.netR != null ? (lad.netR > 0 ? 1 : 0) : null,
    ratio: v.notionalOverRisk,
  });
}
fs.writeFileSync(`${__dirname}/stats-rows.json`, JSON.stringify(rows, null, 1));

const res = rows.filter(r => r.resolved);
const ladRes = rows.filter(r => r.ladNetR != null);
console.log('=== HEADLINE ACCOUNTINGS (801 signals, 2026-04-13..07-26) ===');
console.log(`claimed canonical total: ${rows.reduce((s,r)=>s+r.claimedR,0).toFixed(1)}R  win ${res.filter(r=>r.claimedWin).length}/${res.length}`);
const [pC, loC, hiC] = wilson(res.filter(r => r.claimedWin).length, res.length);
console.log(`  claimed win rate ${(pC*100).toFixed(1)}% [${(loC*100).toFixed(1)}, ${(hiC*100).toFixed(1)}]`);
console.log(`honest ladder (market fill, fees taker6/maker2): gross ${ladRes.reduce((s,r)=>s+r.ladGrossR,0).toFixed(1)}R  fees ${ladRes.reduce((s,r)=>s+r.ladFeeR,0).toFixed(1)}R  NET ${ladRes.reduce((s,r)=>s+r.ladNetR,0).toFixed(1)}R  n=${ladRes.length}`);
const [pL, loL, hiL] = wilson(ladRes.filter(r => r.ladWin).length, ladRes.length);
console.log(`  honest win rate ${(pL*100).toFixed(1)}% [${(loL*100).toFixed(1)}, ${(hiL*100).toFixed(1)}]`);
console.log(`  mean fee per trade: ${(ladRes.reduce((s,r)=>s+r.ladFeeR,0)/ladRes.length).toFixed(3)}R  median notional/risk: ${[...ladRes.map(r=>r.ratio)].sort((a,b)=>a-b)[(ladRes.length/2)|0].toFixed(0)}x`);

// day-clustered bootstrap
console.log('\n=== DAY-CLUSTERED BOOTSTRAP (B=10000, resample days) ===');
const bClaim = bootDayCI(rows, 'claimedR');
console.log(`claimed mean R/trade: ${bClaim.mean.toFixed(3)} [${bClaim.lo.toFixed(3)}, ${bClaim.hi.toFixed(3)}]  days=${bClaim.nDays}`);
const bLad = bootDayCI(ladRes, 'ladNetR');
console.log(`honest ladder net mean R/trade: ${bLad.mean.toFixed(3)} [${bLad.lo.toFixed(3)}, ${bLad.hi.toFixed(3)}]`);

// lag-1 autocorr of claimed win sequence
console.log('\n=== SERIAL DEPENDENCE ===');
function lag1(xs) {
  const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { den += (xs[i] - m) ** 2; if (i) num += (xs[i] - m) * (xs[i - 1] - m); }
  return num / den;
}
const seq = res.map(r => r.claimedWin);
const rho = lag1(seq);
const z = 0.5 * Math.log((1 + rho) / (1 - rho)), se = 1 / Math.sqrt(seq.length - 3);
const zlo = z - 1.96 * se, zhi = z + 1.96 * se;
const f = v => (Math.exp(2 * v) - 1) / (Math.exp(2 * v) + 1);
const ess = seq.length * (1 - rho) / (1 + rho);
console.log(`lag-1 autocorr (claimed wins): ${rho.toFixed(3)} [${f(zlo).toFixed(3)}, ${f(zhi).toFixed(3)}]  ESS≈${ess.toFixed(0)} of ${seq.length}`);
// signals per day concurrency
const perDay = {}; rows.forEach(r => { const d = r.firedAt.slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; });
const counts = Object.values(perDay).sort((a, b) => a - b);
console.log(`signals/day: median ${counts[(counts.length/2)|0]}, max ${counts[counts.length-1]}, days ${counts.length}`);

// calibration
console.log('\n=== CALIBRATION (published probability vs canonical win) ===');
let brier = 0, briefN = 0; const bins = new Map();
for (const r of res) { const p = r.probability / 100; brier += (p - r.claimedWin) ** 2; briefN++;
  if (!bins.has(r.probability)) bins.set(r.probability, [0, 0]); const b = bins.get(r.probability); b[0] += r.claimedWin; b[1]++; }
console.log(`Brier: ${(brier / briefN).toFixed(4)}  (reference: 0.25 = coin flip at p=0.5)`);
let ece = 0;
for (const [p, [k, n]] of [...bins].sort((a, b) => a[0] - b[0])) {
  const [obs, lo, hi] = wilson(k, n);
  ece += (n / briefN) * Math.abs(obs - p / 100);
  console.log(`  p=${p}%: realized ${(obs*100).toFixed(1)}% [${(lo*100).toFixed(1)}, ${(hi*100).toFixed(1)}] n=${n}`);
}
console.log(`ECE: ${(ece*100).toFixed(1)}pp`);
// honest calibration
let brierH = 0, nH = 0;
for (const r of ladRes) { if (r.ladWin == null) continue; brierH += (r.probability/100 - r.ladWin) ** 2; nH++; }
console.log(`Brier vs honest ladder win: ${(brierH / nH).toFixed(4)} (n=${nH})`);

// segments — Fisher + BH across all cells, on claimed wins AND on honest net mean sign
console.log('\n=== SEGMENTS (claimed win rate; Fisher two-sided vs complement; BH-FDR q=0.10) ===');
const segDefs = [];
const addSeg = (name, pred) => segDefs.push({ name, pred });
addSeg('dir=long', r => r.direction === 'long'); addSeg('dir=short', r => r.direction === 'short');
for (const tier of ['A', 'B', 'C']) addSeg(`tier=${tier}`, r => r.tier === tier);
for (const zt of ['HVN', 'VAL', 'VAH', 'POC']) addSeg(`zone=${zt}`, r => r.zoneType === zt);
for (const p of [...new Set(rows.map(r => r.probability))].sort((a,b)=>a-b)) addSeg(`prob=${p}`, r => r.probability === p);
const pvals = [], cells = [];
for (const { name, pred } of segDefs) {
  const inn = res.filter(pred), out = res.filter(r => !pred(r));
  if (inn.length < 5) continue;
  const a = inn.filter(r => r.claimedWin).length, b = inn.length - a;
  const c = out.filter(r => r.claimedWin).length, d = out.length - c;
  const p = fisher2(a, b, c, d);
  const [wp, wlo, whi] = wilson(a, inn.length);
  const laddSeg = ladRes.filter(pred);
  const boot = laddSeg.length >= 20 ? bootDayCI(laddSeg, 'ladNetR', 3000) : null;
  cells.push({ name, n: inn.length, wr: wp, wlo, whi, fisherP: p, lift: wp - c / (c + d),
    ladNetMean: boot ? boot.mean : null, ladLo: boot ? boot.lo : null, ladHi: boot ? boot.hi : null });
  pvals.push(p);
}
const sig = bh(pvals);
cells.forEach((c, i) => {
  console.log(`${c.name.padEnd(10)} n=${String(c.n).padEnd(4)} wr=${(c.wr*100).toFixed(1)}% [${(c.wlo*100).toFixed(1)},${(c.whi*100).toFixed(1)}] lift=${(c.lift*100).toFixed(1)}pp p=${c.fisherP.toExponential(1)} ${sig[i]?'BH-SIG':''} | ladderNet ${c.ladNetMean!=null?c.ladNetMean.toFixed(3)+' ['+c.ladLo.toFixed(3)+','+c.ladHi.toFixed(3)+']':'n/a'}`);
});
console.log(`cells tested: ${pvals.length}, BH-significant: ${sig.filter(Boolean).length}`);

// walk-forward 15d windows
console.log('\n=== WALK-FORWARD (15-day windows) ===');
const t0 = Date.parse('2026-04-13');
const wf = new Map();
for (const r of rows) { const w = Math.floor((Date.parse(r.firedAt) - t0) / (15 * 864e5)); if (!wf.has(w)) wf.set(w, []); wf.get(w).push(r); }
for (const [w, rs] of [...wf].sort((a, b) => a[0] - b[0])) {
  const rr = rs.filter(r => r.resolved), lr = rs.filter(r => r.ladNetR != null);
  const wr = rr.length ? rr.filter(r => r.claimedWin).length / rr.length : 0;
  console.log(`w${w} (${new Date(t0 + w * 15 * 864e5).toISOString().slice(5, 10)}..): n=${rs.length} claimedΣ=${rs.reduce((s,r)=>s+r.claimedR,0).toFixed(0)}R wr=${(wr*100).toFixed(0)}% | ladderNetΣ=${lr.reduce((s,r)=>s+r.ladNetR,0).toFixed(1)}R (n=${lr.length})`);
}

// ---------- FALSIFICATION: random-entry Monte Carlo, same geometry, both accountings ----------
console.log('\n=== FALSIFICATION MC: random-time entries, geometry resampled from real trades ===');
const k30Opens = k30.map(b => b.openTime);
function idx30After(ms) { let lo = 0, hi = k30.length; while (lo < hi) { const m = (lo + hi) >> 1; if (k30Opens[m] > ms) hi = m; else lo = m + 1; } return lo; }
function walk30G(g) { // canonical accounting on synthetic geometry
  for (let i = idx30After(g.t); i < k30.length; i++) {
    const b = k30[i];
    if (g.long) { if (b.low <= g.stop) return -1; if (b.high >= g.tp3) return g.rr3; if (b.high >= g.tp2) return g.rr2; if (b.high >= g.tp1) return g.rr1; }
    else { if (b.high >= g.stop) return -1; if (b.low <= g.tp3) return g.rr3; if (b.low <= g.tp2) return g.rr2; if (b.low <= g.tp1) return g.rr1; }
  }
  return 0;
}
const geoms = trades.map((t, i) => ({
  fr: Math.abs(t.entry - t.stop) / t.price, advR: V[i].limitAdvR,
  rr1: parseFloat(t.rr1), rr2: parseFloat(t.rr2), rr3: parseFloat(t.rr3), long: t.direction === 'long' })).filter(g => isFinite(g.advR));
const tMin = Date.parse('2026-04-13'), tMax = Date.parse('2026-07-19'); // leave room to resolve
const NSIM = 30, NSIG = 801;
const simTotals = [], simWr = [], simLadTotals = [];
for (let s = 0; s < NSIM; s++) {
  let tot = 0, wins = 0, resl = 0, ladTot = 0, ladN = 0;
  for (let i = 0; i < NSIG; i++) {
    const g = geoms[(rnd() * geoms.length) | 0];
    const τ = tMin + rnd() * (tMax - tMin);
    const ms = Math.floor(τ / 60000) * 60000;
    const b = k1ByOpen.get(ms); if (!b) { i--; continue; }
    const p = b.close, risk = g.fr * p;
    const entry = g.long ? p - g.advR * risk : p + g.advR * risk;
    const stop = g.long ? entry - risk : entry + risk;
    const geo = { t: ms, long: g.long, stop, tp1: g.long ? entry + g.rr1 * risk : entry - g.rr1 * risk,
      tp2: g.long ? entry + g.rr2 * risk : entry - g.rr2 * risk, tp3: g.long ? entry + g.rr3 * risk : entry - g.rr3 * risk,
      rr1: g.rr1, rr2: g.rr2, rr3: g.rr3 };
    const r = walk30G(geo);
    tot += r; if (r !== 0) { resl++; if (r > 0) wins++; }
    // honest ladder on synthetic
    const lad = ladderNet({ entry, stop, tp1: geo.tp1, tp2: geo.tp2, tp3: geo.tp3, direction: g.long ? 'long' : 'short' }, p, ms + 60000);
    if (lad && lad.netR != null) { ladTot += lad.netR; ladN++; }
  }
  simTotals.push(tot); simWr.push(wins / resl); simLadTotals.push(ladTot);
}
simTotals.sort((a, b) => a - b); simWr.sort((a, b) => a - b); simLadTotals.sort((a, b) => a - b);
const pct = (arr, v) => arr.filter(x => x < v).length / arr.length;
console.log(`MC canonical-accounting totals over ${NSIM} sims of ${NSIG} random signals:`);
console.log(`  median ${simTotals[(NSIM/2)|0].toFixed(0)}R  range [${simTotals[0].toFixed(0)}, ${simTotals[NSIM-1].toFixed(0)}]  | actual claimed: 964.7R → percentile ${(100*pct(simTotals,964.7)).toFixed(0)}%`);
console.log(`  MC win rates: median ${(simWr[(NSIM/2)|0]*100).toFixed(1)}%  range [${(simWr[0]*100).toFixed(1)}, ${(simWr[NSIM-1]*100).toFixed(1)}]  | actual: ${(pC*100).toFixed(1)}%`);
console.log(`MC honest-ladder net totals: median ${simLadTotals[(NSIM/2)|0].toFixed(0)}R  range [${simLadTotals[0].toFixed(0)}, ${simLadTotals[NSIM-1].toFixed(0)}]  | actual: ${ladRes.reduce((s,r)=>s+r.ladNetR,0).toFixed(0)}R`);
