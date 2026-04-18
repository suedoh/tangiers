#!/usr/bin/env node
'use strict';

/**
 * BZ! — Weekly War Report
 *
 * Posts an institutional-grade weekly preview to ##bz-weekly-war-report
 * every Sunday at 5:00pm ET (before Asia open).
 *
 * Data sources:
 *   - TradingView Desktop (CDP): price, OHLCV, LuxAlgo zones, CVD, OI, VWAP, Session VP
 *   - EIA Weekly Petroleum API: latest inventory data
 *
 * Usage:
 *   node scripts/bz/weekly-report.js          → auto (only runs Sunday 5pm ET)
 *   node scripts/bz/weekly-report.js --force  → run immediately regardless of day/time
 *
 * Crontab:
 *   0 21 * * 0 node /Users/vpm/trading/scripts/bz/weekly-report.js >> .../bz-weekly.log 2>&1
 *   (21:00 UTC = 17:00 ET in summer/EDT)
 */

const path = require('path');
const https = require('https');

const { loadEnv }     = require('../lib/env');
const { acquireLock, releaseLock } = require('../lib/lock');
const {
  cdpConnect, getSymbol, setSymbol, setTimeframe, switchLayout, waitForPrice,
  getQuote, getStudyValues, getPineBoxes, getPineLabels,
  getOHLCV, calcATR, sleep,
} = require('../lib/cdp');
const { classifyZones, nearestZones, currentSession } = require('../lib/zones');
const { postWebhook } = require('../lib/discord');

loadEnv();

const BZ_SYMBOL      = 'NYMEX:BZ1!';
const BZ_LAYOUT_ID   = process.env.BZ_LAYOUT_ID  || null;
const ACE_LAYOUT_ID  = process.env.ACE_LAYOUT_ID || null;
const WAR_HOOK       = process.env.BZ_DISCORD_WAR_REPORT_WEBHOOK;
const SIGNALS_HOOK   = process.env.BZ_DISCORD_SIGNALS_WEBHOOK;
const FORCE          = process.argv.includes('--force');
const GEO_FLAG       = process.env.BZ_GEOPOLITICAL_FLAG === 'active';

function log(msg) { console.log(`[${new Date().toISOString()}] [bz-weekly] ${msg}`); }

// ─── Time gate ────────────────────────────────────────────────────────────────

function shouldRun() {
  if (FORCE) return true;
  const now    = new Date();
  const day    = now.getUTCDay();           // 0 = Sunday
  const etHour = (now.getUTCHours() - 4 + 24) % 24;
  const etMin  = now.getUTCMinutes();
  // Run Sunday 5:00pm–5:05pm ET
  return day === 0 && etHour === 17 && etMin < 5;
}

// ─── EIA inventory (latest weekly data) ──────────────────────────────────────

function fetchEIA() {
  return new Promise(resolve => {
    const url = 'https://api.eia.gov/v2/petroleum/sum/sndw/data/?frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=2&api_key=DEMO_KEY';
    const req = https.get(url, { headers: { 'User-Agent': 'AceTradingBot/1.1' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const rows = json.response?.data || [];
          if (rows.length >= 2) {
            const curr = rows[0].value;
            const prev = rows[1].value;
            const chg  = curr - prev;
            resolve({ current: curr, prior: prev, change: chg, period: rows[0].period });
          } else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

// ─── Parse studies ────────────────────────────────────────────────────────────

function parseStudies(studies) {
  const out = { vwap: null, vwapUpper: null, vwapLower: null, cvd: null, oi: null, sessionUp: 0, sessionDown: 0 };
  for (const s of (studies || [])) {
    const n = s.name || '', v = s.values || {};
    if (/vwap/i.test(n)) {
      out.vwap      = parseFloat(v['VWAP']) || null;
      out.vwapUpper = parseFloat(v['Upper Band #1']) || null;
      out.vwapLower = parseFloat(v['Lower Band #1']) || null;
    }
    if (/cumulative volume delta/i.test(n)) {
      const raw = v['CVD'] || '';
      const neg = raw.includes('−') || raw.startsWith('-');
      const num = parseFloat(raw.replace(/[^0-9.]/g, '')) || 0;
      out.cvd = neg ? -num : num;
    }
    if (/open interest/i.test(n)) {
      out.oi = parseFloat((v['Open Interest'] || '').replace(/[^0-9.]/g, '')) || null;
    }
    if (/session volume profile/i.test(n)) {
      out.sessionUp   = parseInt(v['Up']   || '0', 10) || 0;
      out.sessionDown = parseInt(v['Down'] || '0', 10) || 0;
    }
  }
  return out;
}

// ─── Build report ────────────────────────────────────────────────────────────

function buildReport({ price, ind, boxes4h, boxes1h, labels4h, atr14, buffer, inventory }) {
  const SEP  = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

  const { vwap, vwapUpper, vwapLower, cvd, oi, sessionUp, sessionDown } = ind;
  const sessionTotal = sessionUp + sessionDown;
  const sessionUpPct = sessionTotal > 0 ? Math.round(100 * sessionUp / sessionTotal) : 50;

  // Zone analysis
  const classified4h = classifyZones(boxes4h, price, buffer);
  const { supply: nearSupply, demand: nearDemand } = nearestZones(classified4h, price);

  // All supply zones above, all demand zones below
  const suppliesAbove = boxes4h.filter(z => z.low > price).sort((a,b) => a.low - b.low).slice(0, 3);
  const demandsBelow  = boxes4h.filter(z => z.high < price).sort((a,b) => b.high - a.high).slice(0, 3);

  // BOS/CHoCH structure
  const bosAbove  = labels4h.filter(l => l.text === 'BOS'   && l.price > price).sort((a,b) => a.price - b.price)[0];
  const chochBelow= labels4h.filter(l => l.text === 'CHoCH' && l.price < price).sort((a,b) => b.price - a.price)[0];

  // Bias determination
  const bias = vwap ? (price > vwap ? 'BULLISH' : 'BEARISH') : 'NEUTRAL';
  const biasIcon = bias === 'BULLISH' ? '🟢' : bias === 'BEARISH' ? '🔴' : '⚪';

  // Inventory read
  let invLine = '';
  if (inventory) {
    const chgStr = inventory.change > 0 ? `+${inventory.change.toFixed(1)}M bbl (BUILD)` : `${inventory.change.toFixed(1)}M bbl (DRAW)`;
    invLine = `• EIA Crude Inventory (${inventory.period}): ${chgStr}`;
  }

  // Geopolitical status
  const geoLines = GEO_FLAG
    ? ['• Strait of Hormuz: ⚠️ CLOSED / CONTESTED (active conflict)', '• US-Iran ceasefire: fragile — expires this week', '• BZ_GEOPOLITICAL_FLAG=active: long catalyst premium applied']
    : ['• Strait of Hormuz: ✅ Open', '• Geopolitical flag: inactive'];

  const sections = [
    `🛢️ **BZ! Weekly War Report — ${date}**`,
    SEP,
    '',
    `🌍 **GEOPOLITICAL STATUS**`,
    ...geoLines,
    invLine,
    '',
    SEP,
    `📊 **TECHNICAL SUMMARY — 4H Structure**`,
    SEP,
    `Current Price:  $${price.toFixed(2)}   NYMEX:BZ1!`,
    `Bias:           ${biasIcon} ${bias}`,
    vwap ? `VWAP 4H:        $${vwap.toFixed(2)}  ${price > vwap ? '↑ Price above' : '↓ Price below'}` : '',
    vwapUpper ? `VWAP Bands:     $${vwapLower?.toFixed(2)} – $${vwapUpper?.toFixed(2)}` : '',
    cvd  != null ? `CVD:            ${cvd.toFixed(0)}  ${cvd > 0 ? '↑ Buyers in control' : '↓ Sellers in control'}` : '',
    oi   != null ? `Open Interest:  ${(oi/1000).toFixed(1)}K` : '',
    `Session VP:     ${sessionUpPct}% Up / ${100-sessionUpPct}% Down`,
    `ATR 14 (4H):    $${atr14.toFixed(2)} | Proximity buffer: $${buffer.toFixed(2)}`,
    '',
    `**4H Supply Zones (resistance above)**`,
    ...suppliesAbove.map(z => `  ⬆ $${z.low.toFixed(2)} – $${z.high.toFixed(2)}  [+$${(z.low - price).toFixed(2)}]`),
    '',
    `**4H Demand Zones (support below)**`,
    ...demandsBelow.map(z => `  ⬇ $${z.low.toFixed(2)} – $${z.high.toFixed(2)}  [−$${(price - z.high).toFixed(2)}]`),
    '',
    bosAbove   ? `Last BOS above:   $${bosAbove.price.toFixed(2)}` : '',
    chochBelow ? `Last CHoCH below: $${chochBelow.price.toFixed(2)}` : '',
    '',
    SEP,
    `📅 **WEEK AHEAD SCENARIOS**`,
    SEP,
    GEO_FLAG ? [
      `**Scenario A — Ceasefire expires, no deal (most likely)**`,
      `  → Oil re-prices $10–15 higher at Asia open`,
      `  → Target: ${nearSupply ? '$' + nearSupply.low.toFixed(2) + '–$' + nearSupply.high.toFixed(2) : 'first supply zone above'}`,
      `  → Entry: pullback to $${vwap?.toFixed(2) || (price - 2).toFixed(2)} (VWAP cluster)`,
      `  → Stop: $${vwapLower ? (vwapLower - 0.5).toFixed(2) : (price - 4).toFixed(2)}`,
      '',
      `**Scenario B — Deal announced mid-week**`,
      `  → Oil drops $8–15 instantly on strait opening`,
      `  → Invalidates long setup — stand aside`,
      `  → Watch for fade to $${nearDemand ? '$' + nearDemand.high.toFixed(2) : (price - 10).toFixed(2)} demand`,
      '',
      `**Scenario C — Ceasefire extended, negotiations ongoing**`,
      `  → Range bound $${nearDemand ? nearDemand.high.toFixed(2) : (price-5).toFixed(2)}–$${nearSupply ? nearSupply.low.toFixed(2) : (price+5).toFixed(2)}`,
      `  → Trade the range, reduce size`,
    ].join('\n') : [
      `**Scenario A — Technical long from demand**`,
      `  → Entry: $${nearDemand ? nearDemand.high.toFixed(2) : (price - 3).toFixed(2)} | TP1: $${nearSupply ? nearSupply.low.toFixed(2) : (price + 5).toFixed(2)}`,
      '',
      `**Scenario B — Range continuation**`,
      `  → Chop between demand ($${nearDemand?.high.toFixed(2) || '?'}) and supply ($${nearSupply?.low.toFixed(2) || '?'})`,
    ].join('\n'),
    '',
    SEP,
    `⚙️ **SYSTEM STATUS**`,
    SEP,
    `• Zone poller:    Active (1-min during sessions, 15-min post-settle)`,
    `• AIS monitor:    ${process.env.AISSTREAM_API_KEY ? 'Active — Fujairah/Jebel Ali anchorage watch' : 'Inactive (no AISSTREAM_API_KEY)'}`,
    `• RSS feeds:      Active (7 feeds, 60-second polling)`,
    `• Geopolitical:   ${GEO_FLAG ? '🔴 ACTIVE — long catalyst premium on' : '⚪ Inactive'}`,
    '',
    `*Type \`!analyze\` in ##bz-signals at any time for a fresh MTF read.*`,
    `*Type \`!report\` to regenerate this report on demand.*`,
  ].filter(l => l !== null && l !== undefined);

  return sections.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!shouldRun()) {
    log('Not Sunday 5pm ET — use --force to run manually');
    return;
  }

  if (!WAR_HOOK) {
    log('ERROR: BZ_DISCORD_WAR_REPORT_WEBHOOK not set in .env');
    process.exit(1);
  }

  log('Starting weekly war report...');

  const lock = await acquireLock(30_000, 'bz-weekly');
  if (!lock) { log('Could not acquire lock'); return; }

  let client;
  let originalSymbol;
  let switchedLayout = false;

  try {
    // Fetch inventory in parallel with CDP connect
    const inventoryPromise = fetchEIA();

    client = await cdpConnect();
    originalSymbol = await getSymbol(client);

    const alreadyOnBZ = originalSymbol === BZ_SYMBOL || (originalSymbol || '').endsWith('BZ1!');
    if (!alreadyOnBZ) {
      if (BZ_LAYOUT_ID) {
        await client.Page.enable();
        await switchLayout(client, BZ_LAYOUT_ID, BZ_SYMBOL);
        switchedLayout = true;
        log(`Switched to BZ! layout (${BZ_LAYOUT_ID})`);
      } else {
        await setSymbol(client, BZ_SYMBOL);
        log(`Switched symbol to ${BZ_SYMBOL}`);
      }
    }

    // 4H sweep
    await setTimeframe(client, '240');
    const quote = await waitForPrice(client);
    const [studies, boxes4h, labels4h, ohlcv] = await Promise.all([
      getStudyValues(client),
      getPineBoxes(client, 'LuxAlgo'),
      getPineLabels(client, 'LuxAlgo'),
      getOHLCV(client, 20),
    ]);

    const price = quote.last;

    // 1H boxes for additional level context
    await setTimeframe(client, '60');
    const boxes1h = await getPineBoxes(client, 'LuxAlgo');

    await setTimeframe(client, '240');

    // Restore layout/symbol
    if (switchedLayout && ACE_LAYOUT_ID) {
      await client.Page.enable();
      await switchLayout(client, ACE_LAYOUT_ID);
      log(`Restored Ace layout`);
    } else if (!switchedLayout && !alreadyOnBZ && originalSymbol) {
      await setSymbol(client, originalSymbol);
    }

    const { atr14, buffer } = calcATR(ohlcv);
    const ind               = parseStudies(studies);
    const inventory         = await inventoryPromise;

    log(`price=$${price.toFixed(2)} atr14=${atr14} zones4h=${boxes4h.length}`);

    const report = buildReport({ price, ind, boxes4h, boxes1h, labels4h, atr14, buffer, inventory });

    const footer = `BZ! • Weekly War Report • ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`;
    await postWebhook(WAR_HOOK, 'info', report, footer);
    log('Weekly war report posted to ##bz-weekly-war-report');

    // Also post a summary card to signals channel
    if (SIGNALS_HOOK) {
      const summary = [
        `📋 **BZ! Weekly War Report Posted**`,
        `See **##bz-weekly-war-report** for the full institutional preview.`,
        `Price: $${price.toFixed(2)} | Bias: ${ind.vwap ? (price > ind.vwap ? '🟢 Bullish' : '🔴 Bearish') : '⚪ Neutral'}`,
        GEO_FLAG ? `⚠️ Geopolitical flag ACTIVE — active conflict, elevated volatility` : '',
      ].filter(Boolean).join('\n');
      await postWebhook(SIGNALS_HOOK, 'info', summary, footer);
    }

  } catch (e) {
    log(`Error: ${e.message}`);
    if (WAR_HOOK) {
      await postWebhook(WAR_HOOK, 'error',
        `❌ **BZ! Weekly Report failed**\n**Error:** ${e.message}\n**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout.`,
        'BZ! • Weekly Report');
    }
  } finally {
    try {
      if (client) {
        if (switchedLayout && ACE_LAYOUT_ID) { await client.Page.enable(); await switchLayout(client, ACE_LAYOUT_ID); }
        else if (!switchedLayout && originalSymbol && originalSymbol !== BZ_SYMBOL) await setSymbol(client, originalSymbol);
      }
    } catch {}
    try { if (client) await client.close(); } catch {}
    releaseLock('bz-weekly');
    log('Done');
  }
}

main().catch(e => { console.error('[bz-weekly] Fatal:', e.message); process.exit(1); });
