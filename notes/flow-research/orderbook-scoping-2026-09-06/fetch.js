#!/usr/bin/env node
'use strict';
// Fetch 1m BTCUSDT perp klines covering the order-book corpus window.
// Uses the repo's tested fetchKlines (pagination + parse), not a fresh client.
const fs = require('fs'), path = require('path');
const { fetchKlines } = require('../../../scripts/lib/market-data');

const OUT = path.join(__dirname, 'klines-1m.json');

(async () => {
  // Corpus spans 2026-07-26T21:15Z → 2026-08-14T04:01Z, plus today's restart.
  // Pad both ends so every corpus minute has a kline and a k=30 forward window.
  const start = Date.parse('2026-07-26T20:00:00Z');
  const end   = Date.now();
  console.log(`fetching 1m klines ${new Date(start).toISOString()} → ${new Date(end).toISOString()}`);
  const bars = await fetchKlines({ symbol: 'BTCUSDT', interval: '1m', startTime: start, endTime: end });
  console.log(`got ${bars.length} bars`);

  // Integrity: strictly increasing, exactly 60s apart where contiguous.
  let dups = 0, gaps = 0, missing = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = (bars[i].t - bars[i - 1].t) / 60000;
    if (d === 0) dups++;
    else if (d > 1) { gaps++; missing += d - 1; }
  }
  console.log(`duplicates=${dups} gapRuns=${gaps} missingMinutes=${missing}`);
  console.log(`first=${new Date(bars[0].t).toISOString()} last=${new Date(bars[bars.length-1].t).toISOString()}`);
  fs.writeFileSync(OUT, JSON.stringify(bars));
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
})().catch(e => { console.error('fetch failed:', e.message); process.exit(1); });
