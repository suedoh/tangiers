#!/usr/bin/env node
'use strict';

/**
 * weather/post-welcome.js — Post welcome/reference messages via Billy Sherbert
 *
 * Posts three pinned reference messages to the staging Discord server:
 *   Message 1 → #welcome (or any channel you pass as --welcome <channel-id>)
 *   Message 2 → #weather-signals  (WEATHER_DISCORD_SIGNALS_CHANNEL_ID_STAGING)
 *   Message 3 → #weather-backtest (WEATHER_DISCORD_BACKTEST_CHANNEL_ID_STAGING)
 *
 * Usage:
 *   node scripts/weather/post-welcome.js --welcome 1234567890123456789
 *
 * After running, go into Discord and pin each message manually:
 *   Right-click message → Pin Message
 */

const https = require('https');
const { loadEnv } = require('../lib/env');

loadEnv();

// ── Config ────────────────────────────────────────────────────────────────────

const TOKEN           = process.env.DISCORD_BOT_TOKEN_STAGING;
const SIGNALS_CHANNEL = process.env.WEATHER_DISCORD_SIGNALS_CHANNEL_ID_STAGING;
const BACKTEST_CHANNEL= process.env.WEATHER_DISCORD_BACKTEST_CHANNEL_ID_STAGING;

// --welcome <channel-id> from CLI args, or fall back to env
const welcomeIdx     = process.argv.indexOf('--welcome');
const WELCOME_CHANNEL = welcomeIdx !== -1
  ? process.argv[welcomeIdx + 1]
  : process.env.WEATHER_DISCORD_WELCOME_CHANNEL_ID_STAGING || null;

if (!TOKEN) {
  console.error('❌  DISCORD_BOT_TOKEN_STAGING not set in .env');
  process.exit(1);
}
if (!WELCOME_CHANNEL) {
  console.error('❌  Pass your welcome channel ID:');
  console.error('    node scripts/weather/post-welcome.js --welcome <channel-id>');
  console.error('\n    To get the ID: right-click the channel in Discord → Copy Channel ID');
  process.exit(1);
}

// ── Discord REST helper ───────────────────────────────────────────────────────

function sendMessage(channelId, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content });
    const req  = https.request({
      hostname: 'discord.com',
      path:     `/api/v10/channels/${channelId}/messages`,
      method:   'POST',
      headers:  {
        'Authorization': `Bot ${TOKEN}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':    'Weathermen/1.0 (Tangiers)',
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(raw));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Discord has a 2000 character limit per message.
 * This splits on blank lines to keep sections together.
 */
function splitMessage(text, limit = 1990) {
  if (text.length <= limit) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n/);
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length > limit) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function post(channelId, label, text) {
  const parts = splitMessage(text);
  console.log(`\n📤  Posting to ${label} (${parts.length} message${parts.length > 1 ? 's' : ''})...`);
  for (let i = 0; i < parts.length; i++) {
    const msg = await sendMessage(channelId, parts[i]);
    console.log(`    ✅  Message ${i + 1}/${parts.length} sent (id: ${msg.id})`);
    // Small delay to respect rate limits
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
}

// ── Message content ───────────────────────────────────────────────────────────

const MSG_OVERVIEW = `# 🌡️ Weathermen — Staging Server

**What this is:** A test environment for the Weathermen bot — an automated edge-finder for Polymarket temperature markets. All signals here are paper trades. Nothing posted here affects the live Tangiers server.

**The idea:** Polymarket runs temperature markets for 50+ cities ("Will NYC's high be between 62–63°F on April 25?"). Each city/date has ~11 bucket markets. We forecast the temperature using GFS ensemble + ECMWF AIFS/IFS + ICON + HRRR, find the bucket where the model disagrees most with Polymarket's price, and flag it if the edge is ≥ 8%.

**Paper bankroll:** $500 · Fractional Kelly: 15% · Max bet: $100 per trade

## 📡 Channels

**#weather-signals**
Live edge alerts — posted automatically every 15 minutes when a signal fires. Each card shows the model forecast, bucket probability, edge %, and suggested paper bet size. Use \`!scan\` here to trigger an immediate sweep.

**#weather-backtest**
Signal log + outcome tracking. Every signal is auto-logged here. When a market resolves, the bot fetches the actual observed temperature and posts a win/loss result. Sunday report posts here automatically.

## ⚙️ How It Works
\`\`\`
Every 15 min       →  Scanner checks 50+ cities × 5 days of Polymarket bucket markets
                       Best-edge bucket signalled if edge ≥ 8%

24h after resolve  →  Actual temp fetched (GHCN-Daily / NWS METAR) → WIN or LOSS posted to #weather-backtest

Every Sunday       →  Weekly report: win rate, P&L, edge breakdown, open positions
\`\`\``;

const MSG_COMMANDS = `## 🤖 Weathermen Bot Commands
All commands work in #weather-signals or #weather-backtest.

## 🔭 Scanning
!scan
Triggers an immediate market sweep across all cities (~30s). Signals post above.

!analyze <url or question>
Deep-dive on one specific market. Pass a Polymarket URL or a plain English question.
→ !analyze https://polymarket.com/event/highest-temperature-in-nyc-on-april-28-2026
→ !analyze Will Miami's high be above 85°F on April 27?
Posts a full model breakdown to #weather-signals.

## 📋 Tracking
!trades
Shows all open signals + last 6 resolved. Includes edge %, market price, days to resolution, and suggested bet size. Signal IDs are listed here — needed for !took and !exit.

!took <signal-id>
Log that you entered a paper trade on a signal.
→ !took wx-mob6otqe947e
Records who took it and when. Appears in the weekly report.

!exit <signal-id> win|loss|manual
Close a paper trade. Calculates P&L and posts to #weather-backtest.
→ !exit wx-mob6otqe947e win
→ !exit wx-mob6otqe947e loss
Use manual if closing early (e.g. price moved, changed your mind).

## 📊 Reports
!report
Generate the weekly P&L summary right now instead of waiting for Sunday.
Posts to #weather-backtest: win rate, edge-tier breakdown, city breakdown, open positions.

## 🔧 Settlement
!settle
Resolve expired trades using official NOAA observations (GHCN-Daily station data → NWS hourly METAR → ERA5 fallback). Runs automatically every 30 min, but use this to resolve immediately after a market date passes.
→ !settle --force — use a 6h buffer instead of 24h (NWS data is near real-time)
→ !settle --dry — preview what would resolve without writing anything
→ !settle --id wx-abc123 — resolve one specific trade by ID
Each resolved trade posts a result card to #weather-backtest showing the observed temperature, data source, and model bias (how far off the forecast was). --dry and --force can be combined: !settle --dry --force.

!resolve-status
Show the current resolution queue. Lists open/superseded/resolved counts broken down by eligibility tier, plus up to 8 pending trades with their age (hours past target date) and whether a Polymarket condition ID is available.
→ Eligible for Polymarket check = 12h+ past target date (oracle price converged to ~0 or ~1)
→ Eligible for GHCN check = 36h+ past target date (NOAA data typically posted within 36h)
Useful for diagnosing why a trade hasn't resolved yet.`;

const MSG_WORKFLOW = `## 📋 Paper Trading Workflow

**Phase A — Signal Validation (current)**
Building a track record. Goal: 20+ resolved signals to evaluate model accuracy before going live.

**Signal lifecycle:**

1️⃣  **SIGNAL FIRES** → #weather-signals + logged to #weather-backtest
    Edge %, suggested bet, model temperature, and bucket probabilities shown.

2️⃣  **OPTIONAL: log your entry**
    \`!took <id>\` — marks that you paper-traded it.

3️⃣  **AUTO-RESOLUTION** (24h after market resolves)
    Bot fetches actual observed temp from NOAA (GHCN-Daily station → NWS METAR → ERA5) → marks WIN or LOSS → posts to #weather-backtest.
    Or trigger immediately with \`!settle\` (use \`!settle --force\` for same-day resolution via NWS).

4️⃣  **OR: manual close**
    \`!exit <id> win|loss\` — override auto-resolution or close early.

5️⃣  **SUNDAY REPORT** → #weather-backtest
    Win rate · Paper P&L · Edge-tier breakdown · City breakdown · Open positions

**Reading a signal card:**
🟢 BUY YES — model says 68%, market prices 45% → +23% edge → buy YES
🔴 BUY NO  — model says 12%, market prices 45% → buy NO at 55% → +22% edge

**Phase B** (after 20+ resolved signals with positive edge):
Live execution via Polymarket CLOB API — the bot places orders automatically.

*Staging only · Billy Sherbert bot · all signals are paper trades*`;

// Split across two messages to stay under Discord's 2000-char limit
const MSG_BUCKET_1 = `## 🪣 Understanding Model P(bucket)

**How Polymarket temperature markets are structured**
For each city and date, Polymarket doesn't run one market ("will NYC hit 65°F?"). They run ~11 markets covering every possible outcome as non-overlapping buckets:
\`\`\`
Will NYC high be 47°F or below?     ← floor bucket
Will NYC high be between 48–49°F?
Will NYC high be between 50–51°F?
      ... (middle buckets) ...
Will NYC high be between 64–65°F?
Will NYC high be 66°F or higher?    ← ceiling bucket
\`\`\`
Exactly one bucket resolves YES. The rest resolve NO.

**What Model P(bucket) means**
The scanner builds a bell curve centred on the forecast mean temperature, with a spread (σ) from the GFS ensemble + ECMWF models. For each bucket it calculates what fraction of that bell curve falls inside the bucket's range.

For a **range bucket** like 62–63°F:
> P(bucket) = P(temp > 62°F) − P(temp > 63°F)

For the **ceiling bucket** (≥ 66°F):
> P(bucket) = P(temp > 66°F)   ← area in the right tail

For the **floor bucket** (≤ 47°F):
> P(bucket) = P(temp < 47°F)   ← area in the left tail`;

const MSG_BUCKET_2 = `**A concrete example**
Model forecasts NYC at **64°F ± 3.6°F** on April 25:
\`\`\`
Bucket       Model P  Market price  Edge
─────────────────────────────────────────
≥ 66°F         16%     45% YES    → 🔴 BUY NO (+29%) ← fires
64–65°F        21%     20% YES    → tiny edge, skip
62–63°F        21%     20% YES    → tiny edge, skip
60–61°F        16%     20% YES    → below 8% min
≤ 47°F         <1%      5% YES    → below 8% min
\`\`\`
The scanner picks **one signal per city/date** — the bucket with the highest edge above 8%.

**Why tails get mispriced**
Traders anchor to round numbers and overprice ceiling/floor buckets. The scanner finds where the market's implied probability diverges most from the model's bell curve.

**What σ (sigma) means on the signal card**
σ = how wide the bell curve is. Tight σ (±1.5°F for tomorrow) = confident forecast, large edges possible on individual buckets. Wide σ (±5°F for 7 days out) = more uncertainty, probability spreads across many buckets, smaller individual edges.`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌡️  Weathermen — Posting welcome messages via Billy Sherbert\n');
  console.log(`   Welcome channel:  ${WELCOME_CHANNEL}`);
  console.log(`   Signals channel:  ${SIGNALS_CHANNEL}`);
  console.log(`   Backtest channel: ${BACKTEST_CHANNEL}`);

  await post(WELCOME_CHANNEL,  '#welcome',          MSG_OVERVIEW);
  await post(WELCOME_CHANNEL,  '#welcome',          MSG_BUCKET_1);
  await post(WELCOME_CHANNEL,  '#welcome',          MSG_BUCKET_2);
  await post(SIGNALS_CHANNEL,  '#weather-signals',  MSG_COMMANDS);
  await post(BACKTEST_CHANNEL, '#weather-backtest', MSG_WORKFLOW);

  console.log('\n✅  All messages posted!');
  console.log('\nNext steps:');
  console.log('  1. Go into Discord and pin each message (right-click → Pin Message)');
  console.log('  2. To re-run at any time: node scripts/weather/post-welcome.js --welcome <id>');
}

main().catch(err => {
  console.error('\n❌  Failed:', err.message);
  process.exit(1);
});
