'use strict';
// Pull Binance USDT-M futures klines (public REST) for the audit window.
// Reuses the repo's paginated helper after verifying its logic (limit/forward-progress OK).
const fs = require('fs');
const { getKlinesRange } = require('/Users/vpm/trading/scripts/lib/binance.js');

(async () => {
  const start = Date.parse('2026-04-12T00:00:00Z');
  const end   = Date.now();
  for (const interval of ['30m', '1m']) {
    const t0 = Date.now();
    const bars = await getKlinesRange(start, end, interval);
    // integrity: monotonic, no gaps
    let gaps = 0;
    const step = interval === '30m' ? 1800000 : 60000;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].openTime - bars[i-1].openTime !== step) gaps++;
    }
    fs.writeFileSync(`${__dirname}/klines-${interval}.json`, JSON.stringify(bars));
    console.log(interval, 'bars:', bars.length, 'gaps:', gaps,
      'range:', new Date(bars[0].openTime).toISOString(), '→', new Date(bars[bars.length-1].openTime).toISOString(),
      `(${((Date.now()-t0)/1000).toFixed(0)}s)`);
  }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
