#!/usr/bin/env node
'use strict';

/**
 * Debug helper — dumps all study names and values on 15M, 5M, and 1H charts.
 * Run once to see exactly what's available on your TradingView layout.
 *
 * Usage: node scripts/poly/btc-15/debug-studies.js
 */

const { loadEnv }              = require('../../lib/env');
const { acquireLock, releaseLock } = require('../../lib/lock');
const {
  cdpConnect, setSymbol, setTimeframe, waitForPrice,
  getStudyValues, getOHLCV, cdpEval, sleep,
} = require('../../lib/cdp');

loadEnv();

const SYMBOL = 'BINANCE:BTCUSDT.P';

// Same CVD history expression from trigger-check
const CVD_HISTORY_EXPR = `(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources = chart.model().model().dataSources();
    var found = [];
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si]; if (!s.metaInfo) continue;
      var name = ''; try { name = (s.metaInfo().description || ''); } catch(e) { continue; }
      var hasSeries = !!(s._series && s._series.length);
      found.push({ name: name, hasSeries: hasSeries });
    }
    return found;
  } catch(e) { return []; }
})()`;

async function dumpTF(client, tf) {
  await setTimeframe(client, tf);
  await waitForPrice(client);
  await sleep(500);

  const studies = await getStudyValues(client);
  const sources = await cdpEval(client, CVD_HISTORY_EXPR);
  const ohlcv   = await getOHLCV(client, 2);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Timeframe: ${tf}M`);
  console.log(`Price: ${ohlcv[ohlcv.length-1]?.close}`);
  console.log(`\nStudy values (getStudyValues):`);
  if (!studies.length) {
    console.log('  (none returned)');
  } else {
    for (const s of studies) {
      console.log(`  "${s.name}":`);
      for (const [k, v] of Object.entries(s.values || {})) {
        console.log(`    ${k} = ${v}`);
      }
    }
  }

  console.log(`\nAll data sources with series data:`);
  for (const s of (sources || [])) {
    if (s.hasSeries) console.log(`  ✅ "${s.name}" (has _series)`);
    else             console.log(`  ○  "${s.name}"`);
  }
}

async function main() {
  const lock = await acquireLock(30_000, 'poly-debug');
  if (!lock) { console.log('Could not acquire lock'); return; }

  let client;
  try {
    client = await cdpConnect('BTC');
    await setSymbol(client, SYMBOL);

    await dumpTF(client, '15');
    await dumpTF(client, '5');
    await dumpTF(client, '60');

    await setTimeframe(client, '15');
    console.log('\n' + '─'.repeat(60));
    console.log('Done. Use the output above to fix parseStudies() key names.');
  } finally {
    try { if (client) await client.close(); } catch {}
    releaseLock('poly-debug');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
