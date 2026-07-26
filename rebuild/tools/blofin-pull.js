'use strict';
// READ-ONLY pull of BloFin demo order + fill history. No order placement/cancel/modify.
const fs = require('fs');
// load .env exactly like the repo does
require('/Users/vpm/trading/scripts/lib/env.js').loadEnv();
const blofin = require('/Users/vpm/trading/scripts/lib/blofin.js');

(async () => {
  if (!blofin.isDemo()) { console.error('NOT DEMO — aborting'); process.exit(1); }
  const instId = 'BTC-USDT';

  // paginate orders-history by `after` cursor (orderId) — newest first per API
  async function pullAll(fn, label) {
    const out = []; let before; let guard = 0;
    while (guard++ < 100) {
      const batch = await fn({ instId, limit: 100, after: before });
      if (!batch || batch.length === 0) break;
      out.push(...batch);
      const ids = batch.map(o => String(o.orderId ?? o.tradeId ?? '')).filter(Boolean);
      const next = ids[ids.length - 1];
      if (!next || next === before) break;
      before = next;
      if (batch.length < 100) break;
    }
    console.log(label, out.length);
    return out;
  }

  const orders = await pullAll(a => blofin.getOrderHistory(a), 'orders-history');
  const fills  = await pullAll(a => blofin.getTradeHistory(a), 'fills-history');
  const positions = await blofin.getPositions(instId).catch(e => ({ error: e.message }));
  const balance = await blofin.getBalance().catch(e => ({ error: e.message }));
  const pendingTpsl = await blofin.getPendingTPSL({ instId }).catch(e => ({ error: e.message }));

  fs.writeFileSync(`${__dirname}/blofin-orders-history.json`, JSON.stringify(orders, null, 1));
  fs.writeFileSync(`${__dirname}/blofin-fills-history.json`, JSON.stringify(fills, null, 1));
  fs.writeFileSync(`${__dirname}/blofin-snapshot.json`, JSON.stringify({ positions, balance, pendingTpsl }, null, 1));
  if (fills.length) console.log('sample fill:', JSON.stringify(fills[0]));
  if (orders.length) console.log('sample order:', JSON.stringify(orders[0]));
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
