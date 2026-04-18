#!/usr/bin/env node
'use strict';

/**
 * BZ! — News & AIS Intelligence Monitor
 *
 * Long-running process managed by pm2. Two independent signal layers:
 *
 *   LAYER 1 — AIS (aisstream.io WebSocket)
 *     Watches Fujairah and Jebel Ali anchorage areas (UAE side of Hormuz strait).
 *     Baseline: normal tanker count at anchor. If >20% increase over 4 hours →
 *     tankers are piling up because the strait is blocked → Catalyst alert fires.
 *     Coverage: terrestrial AIS, effective within port anchorage zones.
 *
 *   LAYER 2 — RSS Feeds (7 sources, polled every 60 seconds)
 *     Keyword-matched headlines → Catalyst alert fires if match found.
 *     Sources: Reuters, S&P Global Platts, OilPrice, EIA, Oil & Gas Journal,
 *              Energy Intelligence, EIA Weekly Petroleum.
 *
 * Both layers call scripts/bz/analyze.js with a generated context string.
 * Seen-article state is persisted to .bz-news-state.json to prevent re-fires.
 *
 * pm2 setup (run once):
 *   npm install -g pm2
 *   pm2 start /Users/vpm/trading/scripts/bz/news-watch.js --name bz-news-watch
 *   pm2 startup && pm2 save
 */

const https   = require('https');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const { spawnSync } = require('child_process');

const WS      = require('/Users/vpm/trading/tradingview-mcp/node_modules/ws');
const { loadEnv, ROOT } = require('../lib/env');
const { postWebhook }   = require('../lib/discord');

loadEnv();

const BZ_SIGNALS_HOOK  = process.env.BZ_DISCORD_SIGNALS_WEBHOOK;
const AISSTREAM_KEY    = process.env.AISSTREAM_API_KEY;
const ANALYZE_SCRIPT   = path.join(__dirname, 'analyze.js');
const NODE             = process.execPath;
const STATE_FILE       = path.join(ROOT, '.bz-news-state.json');

function log(msg) { console.log(`[${new Date().toISOString()}] [bz-news] ${msg}`); }
function readState()   { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { seenArticles: [], aisBaseline: null, aisHistory: [] }; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

// ─── Analysis trigger ─────────────────────────────────────────────────────────

// Rate-limit: don't fire analysis more than once every 10 minutes
let lastAnalysisAt = 0;
const ANALYSIS_COOLDOWN_MS = 10 * 60 * 1000;

function triggerAnalysis(source, context) {
  const now = Date.now();
  if (now - lastAnalysisAt < ANALYSIS_COOLDOWN_MS) {
    log(`Analysis cooldown active (${Math.round((ANALYSIS_COOLDOWN_MS - (now - lastAnalysisAt)) / 60000)}min remaining) — skipping trigger`);
    return;
  }
  lastAnalysisAt = now;

  log(`Triggering analysis | source="${source}" | context="${context}"`);
  const args   = [ANALYZE_SCRIPT, '--source', source, '--context', context];
  const result = spawnSync(NODE, args, { encoding: 'utf8', timeout: 120_000, detached: false });
  if (result.error) log(`analyze.js error: ${result.error.message}`);
  else log(`analyze.js exited ${result.status}`);
}

// ─── ────────────────────────────────────────────────────────────────────────
// LAYER 2: RSS Feed Monitor
// ─── ────────────────────────────────────────────────────────────────────────

const RSS_FEEDS = [
  { name: 'Reuters',      url: 'https://feeds.reuters.com/reuters/businessNews' },
  { name: 'S&P Platts',   url: 'https://www.spglobal.com/energy/en/news-research/rss-feed' },
  { name: 'OilPrice',     url: 'https://feeds.feedburner.com/oilpricecom' },
  { name: 'EIA Energy',   url: 'https://www.eia.gov/tools/rssfeeds/rss.cfm?t=jpt' },
  { name: 'OGJ',          url: 'https://www.ogj.com/rss' },
  { name: 'EnergyIntel',  url: 'https://www.energyintel.com/rss-feed' },
  { name: 'EIA Petroleum',url: 'https://www.eia.gov/petroleum/supply/weekly/rss.xml' },
];

const TRIGGER_KEYWORDS = [
  'strait of hormuz', 'irgc', 'iran oil', 'iranian tanker',
  'hormuz blockade', 'hormuz closure', 'hormuz closed',
  'opec emergency', 'nuclear deal', 'iran ceasefire',
  'iran sanctions', 'tanker attack', 'oil supply disruption',
  'persian gulf', 'iran war', 'brent surge', 'oil spike',
];

function fetchRSS(feedUrl) {
  return new Promise(resolve => {
    const lib = feedUrl.startsWith('https') ? https : http;
    const req = lib.get(feedUrl, {
      headers: { 'User-Agent': 'AceTradingBot/1.1', 'Accept': 'application/rss+xml, application/xml, text/xml' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', e => { log(`RSS fetch error (${feedUrl}): ${e.message}`); resolve(''); });
    req.setTimeout(10000, () => { req.destroy(); resolve(''); });
  });
}

function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>(.*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
    const link  = (block.match(/<link>(.*?)<\/link>/i)?.[1] || block.match(/<guid>(.*?)<\/guid>/i)?.[1] || '').trim();
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/i)?.[1] || '';
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}

function matchesKeyword(title) {
  const lower = title.toLowerCase();
  return TRIGGER_KEYWORDS.find(kw => lower.includes(kw)) || null;
}

async function pollRSSFeeds() {
  const state = readState();
  if (!Array.isArray(state.seenArticles)) state.seenArticles = [];

  for (const feed of RSS_FEEDS) {
    try {
      const xml   = await fetchRSS(feed.url);
      if (!xml) continue;
      const items = parseRSSItems(xml);

      for (const item of items) {
        // Deduplicate by link (or title if no link)
        const id = item.link || item.title;
        if (state.seenArticles.includes(id)) continue;

        const keyword = matchesKeyword(item.title);
        if (keyword) {
          state.seenArticles.push(id);
          // Keep state bounded
          if (state.seenArticles.length > 500) state.seenArticles = state.seenArticles.slice(-300);
          writeState(state);

          log(`RSS MATCH: [${feed.name}] "${item.title}" (keyword: "${keyword}")`);

          const source  = `${feed.name} RSS`;
          const context = item.title;

          // Post immediate notification
          if (BZ_SIGNALS_HOOK) {
            await postWebhook(BZ_SIGNALS_HOOK, 'info',
              `📰 **NEWS TRIGGER — BZ!**\n**Source:** ${feed.name}\n**Headline:** "${item.title}"\n\n🔄 Running full MTF analysis...`,
              `BZ! • RSS Monitor • ${new Date().toUTCString().slice(5,25)} UTC`);
          }

          triggerAnalysis(source, context);
          // Don't fire multiple triggers in one poll cycle
          return;
        } else {
          // Mark as seen even if no keyword match (avoid reprocessing)
          state.seenArticles.push(id);
        }
      }
    } catch (e) {
      log(`RSS poll error (${feed.name}): ${e.message}`);
    }
  }

  // Prune seen list
  if (state.seenArticles.length > 500) {
    state.seenArticles = state.seenArticles.slice(-300);
    writeState(state);
  }
}

// ─── ────────────────────────────────────────────────────────────────────────
// LAYER 1: AIS Stream Monitor (Fujairah / Jebel Ali anchorage proxy)
// ─── ────────────────────────────────────────────────────────────────────────

// Fujairah anchorage bounding box (UAE side of strait approach)
// Ships pile up here when the strait is blocked
const FUJAIRAH_BOX = {
  minLat: 25.0, maxLat: 25.5,
  minLon: 56.2, maxLon: 56.6,
};

// Jebel Ali (Dubai port approach — secondary signal)
const JEBEL_ALI_BOX = {
  minLat: 24.9, maxLat: 25.1,
  minLon: 55.0, maxLon: 55.2,
};

// Vessel types we care about (tankers)
const TANKER_TYPES = [80, 81, 82, 83, 84, 85, 86, 87, 88, 89]; // AIS ship type codes for tankers

let aisConnected = false;
let aisReconnectTimer = null;

function inBox(lat, lon, box) {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

function trackAIS(state) {
  if (!AISSTREAM_KEY) {
    log('AISSTREAM_API_KEY not set — AIS layer disabled, RSS-only mode');
    return;
  }

  const ws = new WS('wss://stream.aisstream.io/v0/stream');

  ws.on('open', () => {
    aisConnected = true;
    log('AIS WebSocket connected');

    // Subscribe to both anchorage areas — only tankers
    ws.send(JSON.stringify({
      APIKey: AISSTREAM_KEY,
      BoundingBoxes: [
        [[FUJAIRAH_BOX.minLat, FUJAIRAH_BOX.minLon], [FUJAIRAH_BOX.maxLat, FUJAIRAH_BOX.maxLon]],
        [[JEBEL_ALI_BOX.minLat, JEBEL_ALI_BOX.minLon], [JEBEL_ALI_BOX.maxLat, JEBEL_ALI_BOX.maxLon]],
      ],
      FilterMessageTypes: ['PositionReport'],
    }));

    // Notify if we were in offline mode
    if (state._aisOffline) {
      delete state._aisOffline;
      writeState(state);
      if (BZ_SIGNALS_HOOK) {
        postWebhook(BZ_SIGNALS_HOOK, 'info',
          '📡 **AIS Monitor — Back Online**\naisstream.io WebSocket reconnected. Full monitoring resumed.',
          'BZ! • AIS Monitor').catch(() => {});
      }
    }
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      const pos = msg.Message?.PositionReport;
      if (!pos) return;

      const lat     = pos.Latitude;
      const lon     = pos.Longitude;
      const mmsi    = pos.UserID || pos.MMSI;
      const speed   = pos.SpeedOverGround || 0; // knots
      const shipType= msg.MetaData?.ShipType || 0;

      // Only track tankers
      if (!TANKER_TYPES.includes(shipType)) return;
      // Only track vessels at anchor (speed < 0.5 knots)
      if (speed > 0.5) return;
      // Only track vessels in our bounding boxes
      if (!inBox(lat, lon, FUJAIRAH_BOX) && !inBox(lat, lon, JEBEL_ALI_BOX)) return;

      const now   = Date.now();
      const entry = { mmsi, lat, lon, speed, time: now, box: inBox(lat, lon, FUJAIRAH_BOX) ? 'fujairah' : 'jebel-ali' };

      // Track in rolling 4-hour window
      const s = readState();
      if (!Array.isArray(s.aisHistory)) s.aisHistory = [];
      s.aisHistory.push(entry);

      // Prune entries older than 4 hours
      const cutoff = now - 4 * 60 * 60 * 1000;
      s.aisHistory = s.aisHistory.filter(e => e.time > cutoff);

      // Count unique MMSIs currently at anchor in last 30 minutes
      const recentCutoff  = now - 30 * 60 * 1000;
      const recent1h      = now - 60 * 60 * 1000;
      const currentCount  = new Set(s.aisHistory.filter(e => e.time > recentCutoff).map(e => e.mmsi)).size;
      const priorCount    = new Set(s.aisHistory.filter(e => e.time > recent1h && e.time <= recentCutoff).map(e => e.mmsi)).size;

      // Establish baseline
      if (!s.aisBaseline && priorCount > 5) {
        s.aisBaseline = priorCount;
        log(`AIS baseline established: ${priorCount} tankers at anchor`);
      }

      writeState(s);

      // Check for surge
      if (s.aisBaseline && priorCount > 0) {
        const changePct = (currentCount - priorCount) / priorCount;
        if (changePct > 0.20 && currentCount > s.aisBaseline * 1.15) {
          // Surge detected — check cooldown
          const lastAisTrigger = s._lastAisTriggerAt || 0;
          if (now - lastAisTrigger > 2 * 60 * 60 * 1000) { // 2-hour cooldown
            s._lastAisTriggerAt = now;
            writeState(s);

            const context = `Hormuz tanker anchorage surge: ${currentCount} vessels at anchor in Fujairah/Jebel Ali (was ${priorCount}, +${Math.round(changePct*100)}% in 30min vs prior hour). Baseline: ${s.aisBaseline}.`;
            log(`AIS TRIGGER: ${context}`);

            if (BZ_SIGNALS_HOOK) {
              postWebhook(BZ_SIGNALS_HOOK, 'info',
                `📡 **AIS TRIGGER — BZ!**\n🚢 ${currentCount} tankers at anchor near Fujairah (was ${priorCount}, +${Math.round(changePct*100)}%)\n\nShips piling up at strait approach — possible blockade or closure signal.\n\n🔄 Running full MTF analysis...`,
                `BZ! • AIS Monitor • ${new Date().toUTCString().slice(5,25)} UTC`
              ).catch(() => {});
            }

            triggerAnalysis('AIS Monitor | Fujairah Anchorage', context);
          }
        }
      }
    } catch (e) {
      // Malformed message — ignore silently
    }
  });

  ws.on('close', (code, reason) => {
    aisConnected = false;
    log(`AIS WebSocket closed: code=${code} reason=${reason || 'none'}`);

    // Notify offline — then fall back to RSS only
    const s = readState();
    if (!s._aisOffline) {
      s._aisOffline = true;
      writeState(s);
      if (BZ_SIGNALS_HOOK) {
        postWebhook(BZ_SIGNALS_HOOK, 'info',
          '⚠️ **AIS Monitor — Offline**\naisstream.io WebSocket disconnected. Falling back to RSS-only monitoring.\nWill reconnect automatically.',
          'BZ! • AIS Monitor').catch(() => {});
      }
    }

    // Reconnect with exponential backoff (30s → 60s → 120s max)
    const backoff = Math.min(120_000, 30_000 * Math.pow(2, (s._aisReconnectCount || 0)));
    s._aisReconnectCount = (s._aisReconnectCount || 0) + 1;
    writeState(s);
    log(`AIS reconnecting in ${backoff/1000}s`);
    if (aisReconnectTimer) clearTimeout(aisReconnectTimer);
    aisReconnectTimer = setTimeout(() => {
      const fresh = readState();
      trackAIS(fresh);
    }, backoff);
  });

  ws.on('error', e => {
    log(`AIS WebSocket error: ${e.message}`);
    // close event will handle reconnect
  });
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  log('BZ! News & AIS monitor starting...');

  const state = readState();

  // Start AIS WebSocket
  trackAIS(state);

  // Start RSS polling loop (every 60 seconds)
  log('Starting RSS poll loop (60s interval, 7 feeds)');
  async function rssLoop() {
    await pollRSSFeeds();
    setTimeout(rssLoop, 60_000);
  }
  rssLoop();

  log('All monitors active. Waiting for triggers...');
}

main().catch(e => { console.error('[bz-news] Fatal:', e.message); process.exit(1); });
