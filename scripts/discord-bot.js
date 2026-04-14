#!/usr/bin/env node
'use strict';

/**
 * Ace Trading System — Discord Command Listener
 *
 * Polls your Discord channel every minute for !analyze (or !mtf).
 * When found: runs the full 4-TF analysis via mtf-analyze.js and posts
 * the verdict back to Discord. Zero Claude/AI — pure indicator synthesis.
 *
 * ─── ONE-TIME SETUP (5 minutes) ────────────────────────────────────────────
 *
 * 1. Go to https://discord.com/developers/applications
 * 2. New Application → give it a name (e.g. "Ace Bot")
 * 3. Left sidebar → Bot → "Add Bot" → confirm
 * 4. Under "Privileged Gateway Intents" → enable MESSAGE CONTENT INTENT → Save
 * 5. Click "Reset Token" → copy the token
 * 6. Add to .env:   DISCORD_BOT_TOKEN=your_token_here
 * 7. In Discord: right-click the channel you want to use → Copy Channel ID
 *    (Enable Developer Mode first: User Settings → Advanced → Developer Mode)
 * 8. Add to .env:   DISCORD_CHANNEL_ID=your_channel_id_here
 * 9. Invite the bot: Bot page → OAuth2 → URL Generator
 *    Scopes: bot   |   Permissions: Read Messages, Send Messages
 *    Open the generated URL → invite to your server
 *
 * ─── USAGE ─────────────────────────────────────────────────────────────────
 *
 * In Discord, type any of:
 *   !analyze          → full MTF analysis + verdict + trade plan
 *   !mtf              → same
 *   !analyze status   → quick price + nearest zone check (no full sweep)
 *   !stop             → pause all Discord notifications (signals, errors, alerts)
 *   !start            → resume notifications
 *
 * ─── CRON ENTRY (added automatically when you run setup) ──────────────────
 *
 * (star)/1 * * * * node /Users/vpm/trading/scripts/discord-bot.js >> .../discord-bot.log 2>&1
 */

const https  = require('https');
const path   = require('path');
const fs     = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT              = path.resolve(__dirname, '..');
const ENV_FILE          = path.join(ROOT, '.env');
const STATE_FILE        = path.join(ROOT, '.discord-bot-state.json');
const TRIGGER_STATE     = path.join(ROOT, '.trigger-state.json');
const PAUSE_FILE        = path.join(ROOT, '.discord-paused');
const NOTIFY            = path.join(ROOT, 'scripts', 'discord-notify.sh');
const ANALYZE           = path.join(ROOT, 'scripts', 'mtf-analyze.js');
const NODE              = process.execPath;

const SIGNAL_MSG_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours
const REACT_EMOJI        = '📊';
const REACT_EMOJI_ENC    = encodeURIComponent(REACT_EMOJI); // %F0%9F%93%8A

// ─── Env ─────────────────────────────────────────────────────────────────────

if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => { const i = l.indexOf('='); if (i > 0) process.env[l.slice(0,i).trim()] = l.slice(i+1).trim(); });
}

const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

if (!BOT_TOKEN || BOT_TOKEN === 'your_token_here') {
  console.log('[discord-bot] DISCORD_BOT_TOKEN not configured. See setup instructions at top of this file.');
  process.exit(0); // exit 0 — don't spam cron error logs until configured
}
if (!CHANNEL_ID || CHANNEL_ID === 'your_channel_id_here') {
  console.log('[discord-bot] DISCORD_CHANNEL_ID not configured. See setup instructions at top of this file.');
  process.exit(0);
}

// ─── State ────────────────────────────────────────────────────────────────────

function readState()   { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

function readTriggerState()   { try { return JSON.parse(fs.readFileSync(TRIGGER_STATE, 'utf8')); } catch { return {}; } }
function writeTriggerState(s) { try { fs.writeFileSync(TRIGGER_STATE, JSON.stringify(s, null, 2)); } catch {} }

// ─── Discord REST ─────────────────────────────────────────────────────────────

function discordRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'discord.com',
      path:     `/api/v10${urlPath}`,
      method,
      headers:  {
        Authorization:   `Bot ${BOT_TOKEN}`,
        'Content-Type':  'application/json',
        'User-Agent':    'AceTradingBot/1.0 (https://github.com/ace-trading)',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 204) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch(e) { reject(new Error(`Bad JSON (${res.statusCode}): ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Post a typing indicator so user sees bot is working
async function sendTyping() {
  try { await discordRequest('POST', `/channels/${CHANNEL_ID}/typing`); } catch {}
}

// Post a message directly via bot token (separate from the webhook)
async function sendMessage(content) {
  await discordRequest('POST', `/channels/${CHANNEL_ID}/messages`, { content });
}

// ─── Notify (via existing webhook) ───────────────────────────────────────────

function notify(type, message) {
  try { execFileSync('bash', [NOTIFY, type, message], { stdio: 'pipe' }); }
  catch(e) { console.error('[discord-bot] webhook notify failed:', e.message); }
}

// ─── Analysis Runner ─────────────────────────────────────────────────────────

function runAnalysis() {
  console.log('[discord-bot] Running mtf-analyze.js...');
  // --print suppresses the Discord post inside mtf-analyze — we handle posting here
  const result = spawnSync(NODE, [ANALYZE, '--print'], {
    encoding: 'utf8',
    timeout:  90_000, // 90s max for 4 TF switches
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'mtf-analyze exited non-zero');
  return result.stdout?.trim();
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleStop(user) {
  console.log(`[discord-bot] !stop from ${user}`);
  try {
    fs.writeFileSync(PAUSE_FILE, JSON.stringify({ pausedAt: new Date().toISOString(), by: user }, null, 2));
    await sendMessage([
      `⏸️ **Ace notifications paused** by **${user}**`,
      `All signals, alerts, and errors are now suppressed.`,
      `Type \`!start\` to resume.`,
    ].join('\n'));
    console.log('[discord-bot] Notifications paused');
  } catch(e) {
    console.error('[discord-bot] !stop error:', e.message);
  }
}

async function handleStart(user) {
  console.log(`[discord-bot] !start from ${user}`);
  try {
    const wasPaused = fs.existsSync(PAUSE_FILE);
    if (wasPaused) fs.unlinkSync(PAUSE_FILE);
    await sendMessage([
      `▶️ **Ace notifications resumed** by **${user}**`,
      wasPaused
        ? `Signals, alerts, and errors will now post normally.`
        : `System was already running — no change.`,
    ].join('\n'));
    console.log('[discord-bot] Notifications resumed');
  } catch(e) {
    console.error('[discord-bot] !start error:', e.message);
  }
}

async function handleAnalyze(user) {
  console.log(`[discord-bot] !analyze from ${user}`);
  // Show typing indicator immediately so user knows it's running
  await sendTyping();
  notify('info', `🔄 **MTF analysis triggered by ${user}**\nRunning 12H→4H→1H→30M sweep... (takes ~15 seconds)`);

  let reportText;
  try {
    reportText = runAnalysis();
  } catch(e) {
    const errMsg = e.message || String(e);
    console.error('[discord-bot] Analysis error:', errMsg);
    notify('error', [
      `❌ **MTF Analysis failed** (triggered by ${user})`,
      `**Error:** ${errMsg}`,
      `**Fix:** Ensure TradingView Desktop is open on the 🕵Ace layout with BINANCE:BTCUSDT.P`,
    ].join('\n'));
    return;
  }

  if (!reportText) {
    notify('error', `❌ MTF Analysis returned empty output (triggered by ${user})`);
    return;
  }

  // Determine type from verdict line in the report
  const vType = reportText.includes('🟢') ? 'long'
              : reportText.includes('🔴') ? 'short'
              : reportText.includes('⚠️') ? 'approaching'
              : 'info';

  notify(vType, reportText);
  console.log(`[discord-bot] Analysis posted to Discord as [${vType}]`);
}

// ─── Emoji Reaction Polling ───────────────────────────────────────────────────
//
// Each poll cycle: scan _signal_messages in .trigger-state.json for any message
// that has a 📊 reaction from a human user. When found, run mtf-analyze.js and
// post the report as a reply (message_reference) to the original signal post.
//
// Lifecycle:
//   trigger-check.js fires signal → stores {id, firedAt, levelKey, direction, analyzed: false}
//   discord-bot.js polls reactions → 📊 found → marks analyzed: true → runs analysis → replies

async function handleReaction(entry) {
  const { id: msgId, direction, levelKey } = entry;
  console.log(`[discord-bot] 📊 reaction detected on msg ${msgId} (${direction} ${levelKey}) — running MTF analysis`);

  // Acknowledge immediately via reaction (add ⏳ to show it's running)
  try {
    await discordRequest('PUT', `/channels/${CHANNEL_ID}/messages/${msgId}/reactions/%E2%8F%B3/@me`);
  } catch {}

  await sendTyping();

  let reportText;
  try {
    reportText = runAnalysis();
  } catch(e) {
    const errMsg = e.message || String(e);
    console.error('[discord-bot] Reaction analysis error:', errMsg);
    // Reply to the original message with the error
    try {
      await discordRequest('POST', `/channels/${CHANNEL_ID}/messages`, {
        content: `❌ **MTF Analysis failed** (📊 triggered on ${direction.toUpperCase()} signal)\n**Error:** ${errMsg}`,
        message_reference: { message_id: msgId },
        allowed_mentions:  { replied_user: false },
      });
    } catch {}
    return;
  }

  if (!reportText) {
    try {
      await discordRequest('POST', `/channels/${CHANNEL_ID}/messages`, {
        content: `❌ MTF Analysis returned empty output (📊 triggered)`,
        message_reference: { message_id: msgId },
        allowed_mentions:  { replied_user: false },
      });
    } catch {}
    return;
  }

  // Post reply to the original signal message — split if over Discord's 2000 char limit
  const chunks = [];
  let remaining = reportText;
  while (remaining.length > 1900) {
    const splitAt = remaining.lastIndexOf('\n', 1900);
    chunks.push(remaining.slice(0, splitAt > 0 ? splitAt : 1900));
    remaining = remaining.slice(splitAt > 0 ? splitAt + 1 : 1900);
  }
  chunks.push(remaining);

  for (let i = 0; i < chunks.length; i++) {
    try {
      await discordRequest('POST', `/channels/${CHANNEL_ID}/messages`, {
        content:           chunks[i],
        // Only thread the first chunk to the original signal
        ...(i === 0 ? {
          message_reference: { message_id: msgId },
          allowed_mentions:  { replied_user: false },
        } : {}),
      });
    } catch(e) {
      console.error(`[discord-bot] Failed to post reply chunk ${i}:`, e.message);
    }
  }

  // Remove ⏳ reaction now that we're done
  try {
    await discordRequest('DELETE', `/channels/${CHANNEL_ID}/messages/${msgId}/reactions/%E2%8F%B3/@me`);
  } catch {}

  console.log(`[discord-bot] MTF analysis reply posted for signal ${msgId}`);
}

async function checkEmojiReactions() {
  const ts = readTriggerState();
  const signalMsgs = ts._signal_messages;
  if (!Array.isArray(signalMsgs) || signalMsgs.length === 0) return;

  const now = Date.now();
  let changed = false;

  for (const entry of signalMsgs) {
    // Skip already analyzed or expired entries
    if (entry.analyzed) continue;
    if (now - entry.firedAt > SIGNAL_MSG_MAX_AGE) {
      entry.analyzed = true; // expire silently
      changed = true;
      continue;
    }

    // Fetch reactions for this emoji on this message
    let reactors;
    try {
      reactors = await discordRequest(
        'GET',
        `/channels/${CHANNEL_ID}/messages/${entry.id}/reactions/${REACT_EMOJI_ENC}?limit=5`
      );
    } catch(e) {
      // 404 = message deleted; 10008 = unknown message — expire it
      if (e.message?.includes('10008') || e.message?.includes('404')) {
        entry.analyzed = true;
        changed = true;
      }
      continue;
    }

    if (!Array.isArray(reactors) || reactors.length === 0) continue;

    // Check if any human (non-bot) reacted
    const humanReacted = reactors.some(u => !u.bot);
    if (!humanReacted) continue;

    // Mark analyzed first so a crash mid-analysis doesn't cause double-fire
    entry.analyzed = true;
    changed = true;
    writeTriggerState(ts);

    await handleReaction(entry);
  }

  if (changed) {
    // Prune fully analyzed entries older than 24h to keep state tidy
    ts._signal_messages = signalMsgs.filter(e => !e.analyzed || (now - e.firedAt < SIGNAL_MSG_MAX_AGE));
    writeTriggerState(ts);
  }
}

// ─── Main Poll Loop ───────────────────────────────────────────────────────────

async function main() {
  const state  = readState();
  const lastId = state.lastMessageId || null;

  // Fetch messages newer than last seen (up to 20 to catch any burst)
  const qs       = lastId ? `?limit=20&after=${lastId}` : `?limit=5`;
  let messages;
  try {
    messages = await discordRequest('GET', `/channels/${CHANNEL_ID}/messages${qs}`);
  } catch(e) {
    // Common causes: bad token, wrong channel ID, no permission
    if (e.message?.includes('401') || e.message?.includes('403')) {
      console.error('[discord-bot] Discord auth error — check DISCORD_BOT_TOKEN and bot channel permissions:', e.message);
    } else {
      console.error('[discord-bot] Discord API error:', e.message);
    }
    return;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    console.log('[discord-bot] No new messages');
    return;
  }

  // Discord returns newest-first; save newest ID before processing
  state.lastMessageId = messages[0].id;
  writeState(state);

  // Reverse to process oldest-first (natural order); skip bot messages
  const humanMsgs = messages.reverse().filter(m => !m.author?.bot);

  for (const msg of humanMsgs) {
    const text = (msg.content || '').trim();
    const user = msg.author?.username || 'unknown';

    if (/^!stop\b/i.test(text)) {
      await handleStop(user);
      break;
    }

    if (/^!start\b/i.test(text)) {
      await handleStart(user);
      break;
    }

    if (/^!analyze\b|^!mtf\b/i.test(text)) {
      await handleAnalyze(user);
      break; // one command per poll cycle — prevents double-firing in message bursts
    }
  }
}

// Run both pipelines — command poll + reaction scan — concurrently
Promise.all([
  main().catch(e => console.error('[discord-bot] Fatal (main):', e.message)),
  checkEmojiReactions().catch(e => console.error('[discord-bot] Fatal (reactions):', e.message)),
]);
