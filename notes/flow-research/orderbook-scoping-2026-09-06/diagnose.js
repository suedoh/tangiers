#!/usr/bin/env node
'use strict';
/**
 * Two diagnostics that decide how the Phase B results should be read.
 *
 * D1 — Is H-B1's null a "no effect" or a "wrong horizon"? If depth imbalance
 *      tracks the SAME minute's return but not the next one, the information is
 *      real and decays inside the corpus's 1-minute aggregation, which is a
 *      recorder-resolution problem rather than a refutation. The literature's
 *      OBI result lives at tick-to-seconds horizons, so this is the difference
 *      between "hypothesis dead" and "hypothesis untestable at this sampling".
 *
 * D2 — Win/loss decomposition of the liquidation-reversion arm. The prior
 *      study's §3.6 is the trap this corpus is most likely to spring: a high
 *      hit rate with wins smaller than losses is negative expectancy.
 *
 * D3 — Robustness of the headline cell to the `samples > 600` rows, which the
 *      integrity pass showed are double-counted depth snapshots.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BOOK = path.join(ROOT, 'data', 'orderbook');
const WIN_START = Date.parse('2026-07-26T00:00:00Z');
const WIN_END   = Date.parse('2026-08-14T23:59:00Z');
const LIQ_VALID_FROM = Date.parse('2026-07-27T12:45:00Z');
const WARMUP = 1440, KS = [1, 5, 15, 30];

const rows = [];
for (const f of fs.readdirSync(BOOK).filter(f => f.endsWith('.ndjson')).sort())
  for (const l of fs.readFileSync(path.join(BOOK, f), 'utf8').split('\n'))
    if (l) { try { rows.push(JSON.parse(l)); } catch {} }
rows.sort((a, b) => a.t - b.t);
const byT = new Map();
for (const r of rows) { const p = byT.get(r.t); if (!p || (r.samples||0) > (p.samples||0)) byT.set(r.t, r); }
const corpus = [...byT.values()].sort((a,b)=>a.t-b.t).filter(r => r.t >= WIN_START && r.t <= WIN_END);

const klines = JSON.parse(fs.readFileSync(path.join(__dirname, 'klines-1m.json'), 'utf8'));
const kByT = new Map(klines.map(k => [k.t, k]));

const F = [];
for (const r of corpus) {
  const k0 = kByT.get(r.t); if (!k0) continue;
  const row = { ...r, close: k0.c, open: k0.o, rSame: (k0.c / k0.o - 1) * 1e4,
    depth: (r.dBid != null && r.dAsk != null) ? r.dBid + r.dAsk : null,
    hasLiq: r.t >= LIQ_VALID_FROM && r.liqN != null };
  for (const k of KS) { const kk = kByT.get(r.t + k*60000); row['f'+k] = kk ? (kk.c/k0.c - 1)*1e4 : null; }
  F.push(row);
}
const mean = a => (a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN);
const corr = (a,b) => { const ma=mean(a), mb=mean(b); let n=0,da=0,db=0;
  for(let i=0;i<a.length;i++){n+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;} return n/Math.sqrt(da*db); };
const fmt = x => (Number.isFinite(x) ? (x>=0?'+':'')+x.toFixed(2) : 'n/a');

// ─── D1 — where does depth imbalance live on the clock? ──────────────────────
console.log('### D1 — depth imbalance vs return, SAME minute vs FORWARD minutes');
console.log('If the same-minute correlation is large and the forward ones are ~0, the information');
console.log('is real but decays inside the 1-minute bucket — a sampling limit, not a refutation.\n');
console.log('feature      corr w/ SAME-min return   corr w/ f1    corr w/ f5   corr w/ f15   corr w/ f30');
for (const key of ['obi1','obi5','obi20','obiTouch','mpDev']) {
  const v = F.filter(r => !r.gap && r[key] != null && Number.isFinite(r.rSame));
  const cs = KS.map(k => { const w = v.filter(r => r['f'+k] != null);
    return fmt(corr(w.map(r=>r[key]), w.map(r=>r['f'+k]))).padStart(11); });
  console.log(`${key.padEnd(12)} ${fmt(corr(v.map(r=>r[key]), v.map(r=>r.rSame))).padStart(21)}   ${cs.join('  ')}`);
}
// Signed aggressor flow as the reference: it MUST track the same minute strongly.
{
  const v = F.filter(r => !r.gap && r.tvol > 0 && r.tbuy != null && Number.isFinite(r.rSame));
  const flow = v.map(r => 2*r.tbuy - r.tvol);
  console.log(`${'flow (ref)'.padEnd(12)} ${fmt(corr(flow, v.map(r=>r.rSame))).padStart(21)}   ` +
    KS.map(k => { const w = v.filter(r=>r['f'+k]!=null);
      return fmt(corr(w.map(r=>2*r.tbuy-r.tvol), w.map(r=>r['f'+k]))).padStart(11); }).join('  '));
}
console.log('\n(flow is the reference: aggressor flow must move price within its own minute — it does,');
console.log(' which shows the same-minute column is measuring something real.)');

// ─── D2 — win/loss decomposition of the liquidation reversion arm ────────────
function trailingPctAll(arr, key, p) {
  const out = new Array(arr.length).fill(null); const win = [];
  const bs = v => { let lo=0,hi=win.length; while(lo<hi){const m=(lo+hi)>>1; if(win[m]<v)lo=m+1; else hi=m;} return lo; };
  for (let i=0;i<arr.length;i++){
    if(i>0){const a=arr[i-1][key]; if(a!=null&&Number.isFinite(a)) win.splice(bs(a),0,a);}
    if(i>WARMUP){const d=arr[i-1-WARMUP][key]; if(d!=null&&Number.isFinite(d)){const k=bs(d); if(win[k]===d) win.splice(k,1);}}
    const lo=i-WARMUP;
    if(lo<0||arr[i].t-arr[lo].t>WARMUP*60000*1.05||win.length<WARMUP*0.5) continue;
    out[i]=win[Math.min(win.length-1,Math.floor(p*win.length))];
  }
  return out;
}
const p95 = trailingPctAll(F, 'liqNotional', 0.95);
const picks = [];
for (let i=0;i<F.length;i++){
  const r=F[i];
  if (r.gap || !r.hasLiq || !r.liqNotional || p95[i]==null || r.liqNotional < p95[i]) continue;
  const L = (r.liqShort||0) - (r.liqLong||0);
  if (L === 0) continue;
  picks.push({ row: r, dir: -Math.sign(L) });   // reversion arm
}
console.log(`\n### D2 — liquidation REVERSION arm: why a 55% hit rate is still not money  (n=${picks.length})`);
console.log('  k      n    hit%    avg win bp   avg loss bp   expectancy bp   net@14bp');
for (const k of KS) {
  const v = picks.filter(p => p.row['f'+k] != null).map(p => p.dir * p.row['f'+k]);
  const w = v.filter(x=>x>0), l = v.filter(x=>x<=0);
  console.log(`${String(k).padStart(3)} ${String(v.length).padStart(6)}  ${(w.length/v.length*100).toFixed(2).padStart(6)}  ` +
    `${fmt(mean(w)).padStart(11)}  ${fmt(mean(l)).padStart(12)}  ${fmt(mean(v)).padStart(13)}  ${fmt(mean(v)-14).padStart(9)}`);
}
// What is the always-long return on these same minutes? (drift on liquidation bars)
console.log('\nsame minutes, always-long:');
for (const k of KS) {
  const v = picks.filter(p => p.row['f'+k] != null).map(p => p.row['f'+k]);
  console.log(`  k=${String(k).padStart(2)}  mean ${fmt(mean(v))}bp   up-share ${(v.filter(x=>x>0).length/v.length*100).toFixed(2)}%`);
}
// Which side is being liquidated on these minutes?
const longLiq = picks.filter(p => (p.row.liqLong||0) > (p.row.liqShort||0)).length;
console.log(`\ndirection of forced flow on triggered minutes: ${longLiq}/${picks.length} ` +
  `(${(longLiq/picks.length*100).toFixed(1)}%) are LONGS being liquidated → reversion arm is mostly "buy the flush".`);

// ─── D3 — robustness to the double-counted-depth rows ────────────────────────
const clean = picks.filter(p => (p.row.samples||0) <= 600);
console.log(`\n### D3 — excluding samples>600 rows (double-counted depth snapshots)`);
console.log(`triggered minutes: ${picks.length} → ${clean.length} after exclusion`);
for (const k of KS) {
  const a = picks.filter(p=>p.row['f'+k]!=null).map(p=>p.dir*p.row['f'+k]);
  const b = clean.filter(p=>p.row['f'+k]!=null).map(p=>p.dir*p.row['f'+k]);
  console.log(`  k=${String(k).padStart(2)}  all ${fmt(mean(a))}bp (hit ${(a.filter(x=>x>0).length/a.length*100).toFixed(2)}%)   ` +
    `clean ${fmt(mean(b))}bp (hit ${(b.filter(x=>x>0).length/b.length*100).toFixed(2)}%)`);
}

// ─── D4 — how many independent days does the headline cell actually live on? ──
const days = new Set(picks.map(p => new Date(p.row.t).toISOString().slice(0,10)));
const perDay = {};
for (const p of picks) { const d = new Date(p.row.t).toISOString().slice(0,10); perDay[d]=(perDay[d]||0)+1; }
console.log(`\n### D4 — clustering: ${picks.length} triggered minutes across ${days.size} distinct days`);
const top = Object.entries(perDay).sort((a,b)=>b[1]-a[1]).slice(0,5);
console.log('busiest days:', top.map(([d,n])=>`${d.slice(5)}:${n}`).join(' '),
  `— top day is ${(top[0][1]/picks.length*100).toFixed(1)}% of all triggers`);
