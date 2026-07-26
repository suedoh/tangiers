'use strict';
// Reconcile per-signal exchange P&L (orders-history: pnl+fee per order) vs local ledger claims.
const fs = require('fs');
const trades = JSON.parse(fs.readFileSync(`${__dirname}/trades.json`, 'utf8'));
const exOrders = JSON.parse(fs.readFileSync(`${__dirname}/blofin-orders-history.json`, 'utf8'));
const mongo = JSON.parse(fs.readFileSync(`${__dirname}/mongo-blofin-orders.json`, 'utf8'));
const snap = JSON.parse(fs.readFileSync(`${__dirname}/blofin-snapshot.json`, 'utf8'));

const TIER_R = { A: 15, B: 10.5, C: 4.5 };

// orderId -> signalId (Mongo is the only source that links exits to signals)
const sigByOrderId = new Map();
for (const d of mongo) if (d.orderId && d.signalId) sigByOrderId.set(String(d.orderId), d.signalId);
// entry orders also carry clientOrderId derived from signalId
const cidToSig = new Map();
for (const t of trades) if (t.executionStatus) cidToSig.set(t.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32), t.id);

const bySig = new Map();
let unmatchedOrders = 0, unmatchedNotional = 0;
for (const o of exOrders) {
  const ct = +o.createTime;
  if (ct < Date.parse('2026-06-15T00:00:00Z')) continue; // Phase D start
  let sig = sigByOrderId.get(String(o.orderId));
  if (!sig && o.clientOrderId) sig = cidToSig.get(o.clientOrderId);
  if (!sig) { if (o.state === 'filled') { unmatchedOrders++; unmatchedNotional += (+o.filledSize||0) * 0.001 * (+o.averagePrice||0); } continue; }
  if (!bySig.has(sig)) bySig.set(sig, { pnl: 0, fee: 0, orders: 0, filled: 0, firstTs: ct, lastTs: ct });
  const s = bySig.get(sig);
  s.orders++;
  s.firstTs = Math.min(s.firstTs, ct); s.lastTs = Math.max(s.lastTs, ct);
  if (o.state === 'filled') { s.filled++; s.pnl += +o.pnl || 0; s.fee += +o.fee || 0; }
}

const tByid = new Map(trades.map(t => [t.id, t]));
const rows = [];
for (const [sig, s] of bySig) {
  const t = tByid.get(sig);
  const tier = t?.setupType?.trim()[0];
  const rDollar = TIER_R[tier] ?? null;
  const netUsd = s.pnl - s.fee;
  rows.push({ sig, tier, execStatus: t?.executionStatus ?? 'NOT_IN_TRADES', canonOutcome: t?.outcome, canonR: t?.pnlR,
    execOutcome: t?.executedOutcome ?? null, execR: t?.executedPnlR ?? null,
    exPnl: +s.pnl.toFixed(2), exFee: +s.fee.toFixed(2), exNetUsd: +netUsd.toFixed(2),
    exNetR: rDollar ? +(netUsd / rDollar).toFixed(2) : null, rDollar, nOrders: s.orders, nFilled: s.filled,
    firstTs: new Date(s.firstTs).toISOString() });
}
rows.sort((a, b) => a.firstTs.localeCompare(b.firstTs));
fs.writeFileSync(`${__dirname}/reconciled.json`, JSON.stringify(rows, null, 1));

const sum = (a, f) => a.reduce((x, r) => x + (r[f] || 0), 0);
const placed = rows.filter(r => r.execStatus === 'placed');
console.log(`signals with exchange orders (since 06-15): ${rows.length}; 'placed' in trades.json: ${placed.length}`);
console.log(`unmatched filled orders (no signal mapping): ${unmatchedOrders} notional $${unmatchedNotional.toFixed(0)}`);
console.log(`EXCHANGE truth: gross pnl $${sum(rows,'exPnl').toFixed(2)}  fees $${sum(rows,'exFee').toFixed(2)}  NET $${sum(rows,'exNetUsd').toFixed(2)}`);
console.log(`  in R (tier rDollar): net ${sum(rows,'exNetR').toFixed(2)}R over ${rows.filter(r=>r.exNetR!=null).length} signals`);
const cmp = placed.filter(r => r.canonR != null);
console.log(`LEDGER claims for same 'placed' signals: canonical ${sum(cmp,'canonR').toFixed(2)}R; executed-track ${sum(placed.filter(r=>r.execR!=null),'execR').toFixed(2)}R (n=${placed.filter(r=>r.execR!=null).length})`);
console.log(`  exchange net for those placed: ${sum(placed,'exNetR').toFixed(2)}R`);
// fee burden
console.log(`fee burden: fees/gross|pnl| = ${(sum(rows,'exFee')/Math.abs(sum(rows,'exPnl'))*100).toFixed(0)}%; mean fee per signal $${(sum(rows,'exFee')/rows.length).toFixed(2)}`);
// balance
const bal = Array.isArray(snap.balance) ? snap.balance.find(b => b.currency === 'USDT') : snap.balance;
console.log('balance snapshot:', JSON.stringify(bal));
console.log('open positions:', JSON.stringify(snap.positions));
// distribution
const w = rows.filter(r => r.exNetUsd > 0).length, l = rows.filter(r => r.exNetUsd < 0).length;
console.log(`exchange win/loss by net$: ${w}W/${l}L  (${(100*w/(w+l)).toFixed(1)}% win)`);
