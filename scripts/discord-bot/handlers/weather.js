'use strict';

/**
 * handlers/weather.js — All weather channel commands
 *
 * Commands:
 *   !scan                       — run market-scan.js immediately
 *   !analyze <url|q>            — deep dive on a specific market or question
 *   !report                     — generate weekly report now
 *   !trades                     — list open/recent weather signals
 *   !settle [--force] [--dry] [--id <id>]
 *                               — resolve expired trades via GHCN-Daily / NWS METAR
 *   !took <id>                  — log that you manually entered a paper trade
 *   !exit <id> <outcome>        — log manual exit (win|loss|manual)
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, resolveWebhook } = require('../../lib/env');
const { postWebhook }          = require('../../lib/discord');

const SCAN_SCRIPT    = path.join(ROOT, 'scripts', 'weather', 'market-scan.js');
const ANALYZE_SCRIPT = path.join(ROOT, 'scripts', 'weather', 'analyze.js');
const REPORT_SCRIPT  = path.join(ROOT, 'scripts', 'weather', 'weekly-report.js');
const SETTLE_SCRIPT  = path.join(ROOT, 'scripts', 'weather', 'settle.js');
const TRADES_FILE    = path.join(ROOT, 'weather-trades.json');

const SIGNALS_HOOK  = resolveWebhook('WEATHER_DISCORD_SIGNALS_WEBHOOK');
const BACKTEST_HOOK = resolveWebhook('WEATHER_DISCORD_BACKTEST_WEBHOOK');
const NODE          = process.execPath;

function readTrades()   { try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; } }
function writeTrades(t) { try { fs.writeFileSync(TRADES_FILE, JSON.stringify(t, null, 2)); } catch {} }
function pct(v)         { return v != null ? (v * 100 ).toFixed(1) + '%' : 'N/A'; }
function usd(v)         { return v != null ? '$' + Math.abs(v).toFixed(2) : '?'; }

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function handle(message, api) {
  const text = (message.content || '').trim();
  const user = message.author?.username || 'unknown';
  const args = text.split(/\s+/).slice(1);

  if (/^!scan\b/i.test(text))            { await handleScan(user, api);              return true; }
  if (/^!analyze\b/i.test(text))         { await handleAnalyze(user, text, api);     return true; }
  if (/^!report\b/i.test(text))          { await handleReport(user, api);            return true; }
  if (/^!trades\b/i.test(text))          { await handleTrades(user, api);            return true; }
  if (/^!settle\b/i.test(text))          { await handleSettle(user, text, api);      return true; }
  if (/^!resolve-status\b/i.test(text))  { await handleResolveStatus(user, api);     return true; }
  if (/^!took\b/i.test(text))            { await handleTook(user, args[0], api);     return true; }
  if (/^!exit\b/i.test(text))            { await handleExit(user, args, api);        return true; }

  return false;
}

// ─── !scan ────────────────────────────────────────────────────────────────────

async function handleScan(user, api) {
  await api.sendTyping();
  await api.sendMessage(`🔄 **Weather scan triggered by ${user}**\nScanning Polymarket for temperature edge... (~30s)`);

  const result = spawnSync(NODE, [SCAN_SCRIPT], { encoding: 'utf8', timeout: 120_000 });

  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    await api.sendMessage(`❌ **Scan failed:** ${err.slice(0, 300)}`);
    return;
  }

  // market-scan.js posts its own Discord cards — just confirm completion
  const lastLine = (result.stdout || '').trim().split('\n').pop() || '';
  const signalMatch = lastLine.match(/(\d+) signal/);
  const signalCount = signalMatch ? signalMatch[1] : '?';
  await api.sendMessage(`✅ Scan complete — **${signalCount} signal(s)** fired. Check above for alerts.`);
}

// ─── !analyze ────────────────────────────────────────────────────────────────

async function handleAnalyze(user, text, api) {
  await api.sendTyping();

  // Strip "!analyze " prefix — remainder is either a URL or a question
  const input = text.replace(/^!analyze\s*/i, '').trim();
  if (!input) {
    await api.sendMessage([
      '**Usage:**',
      '`!analyze https://polymarket.com/event/will-nyc-reach-80f-on-apr-26`',
      '`!analyze Will NYC high exceed 75°F on April 28?`',
    ].join('\n'));
    return;
  }

  await api.sendMessage(`🔬 **Deep analysis triggered by ${user}**\n\`${input.slice(0, 100)}\`\nFetching forecasts... (~20s)`);

  const isUrl = input.startsWith('http');
  const args  = [ANALYZE_SCRIPT, '--source', `Manual | ${user}`,
    isUrl ? '--url' : '--question', input];

  const result = spawnSync(NODE, args, { encoding: 'utf8', timeout: 120_000 });

  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    if (SIGNALS_HOOK) {
      await postWebhook(SIGNALS_HOOK, 'error',
        `❌ **Weather analysis failed** (${user})\n${err.slice(0, 300)}`,
        'Weather • Error');
    }
    await api.sendMessage(`❌ **Analysis failed:** ${err.slice(0, 200)}`);
  }
  // analyze.js posts its own card to #weather-signals
}

// ─── !report ─────────────────────────────────────────────────────────────────

async function handleReport(user, api) {
  await api.sendTyping();
  await api.sendMessage(`🔄 **Weekly report triggered by ${user}**\nGenerating... (~10s)`);

  const result = spawnSync(NODE, [REPORT_SCRIPT, '--force'], { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    await api.sendMessage(`❌ **Report failed:** ${err.slice(0, 200)}`);
  } else {
    await api.sendMessage(`✅ **Report posted to #weather-backtest**`);
  }
}

// ─── !trades ─────────────────────────────────────────────────────────────────

async function handleTrades(user, api) {
  const trades = readTrades().filter(t => t.outcome !== 'superseded');

  if (trades.length === 0) {
    await api.sendMessage('📭 No weather signals logged yet — run `!scan` to check for opportunities.');
    return;
  }

  const now      = Date.now();
  const weekMs   = 7 * 24 * 3_600_000;
  const resolved = trades.filter(t => t.signalResult != null);
  const wins     = resolved.filter(t => t.signalResult === 'win');
  const allPnl   = resolved.reduce((a, t) => a + (t.pnlDollars || 0), 0);
  const allWR    = resolved.length > 0 ? wins.length / resolved.length : null;

  // ── Dashboard message ────────────────────────────────────────────────────
  const dash = [];

  // This week
  const weekCutoff  = now - weekMs;
  const weekAll     = trades.filter(t => new Date(t.firedAt).getTime() > weekCutoff);
  const weekRes     = weekAll.filter(t => t.signalResult != null);
  const weekWins    = weekRes.filter(t => t.signalResult === 'win');
  const weekOpen    = weekAll.filter(t => t.outcome === null);
  const weekPnl     = weekRes.reduce((a, t) => a + (t.pnlDollars || 0), 0);
  const weekFrom    = new Date(weekCutoff).toISOString().slice(5, 10).replace('-', '/');
  const weekTo      = new Date(now).toISOString().slice(5, 10).replace('-', '/');
  const weekWR      = weekRes.length > 0 ? Math.round(100 * weekWins.length / weekRes.length) : null;

  dash.push(`## 🌡️ WEATHERMEN — TRADES`);
  dash.push(`### 📅 This Week (${weekFrom}–${weekTo})`);
  if (weekRes.length === 0 && weekOpen.length === 0) {
    dash.push('*No signals this week.*');
  } else {
    const weekPnlStr = weekPnl >= 0 ? `+$${weekPnl.toFixed(2)}` : `-$${Math.abs(weekPnl).toFixed(2)}`;
    dash.push(
      `Signals:   **${weekAll.length}** (${weekRes.length} resolved, ${weekOpen.length} open)`,
      weekRes.length > 0
        ? `Results:   **${weekWins.length}W / ${weekRes.length - weekWins.length}L** (${weekWR}% WR) · P&L: **${weekPnlStr}**`
        : `Results:   *awaiting resolution*`,
    );
  }

  // All-time headline
  dash.push('', `### 📊 All-Time (${resolved.length} resolved)`);
  if (resolved.length > 0) {
    const pnlStr = allPnl >= 0 ? `+$${allPnl.toFixed(2)}` : `-$${Math.abs(allPnl).toFixed(2)}`;
    dash.push(`Win rate: **${(allWR * 100).toFixed(1)}%** · Paper P&L: **${pnlStr}**`);

    // Edge tier breakdown
    const edgeTiers = [
      { label: 'High ≥25%',  min: 25, max: Infinity },
      { label: 'Mid 15–25%', min: 15, max: 25 },
      { label: 'Low 8–15%',  min: 8,  max: 15 },
    ];
    const tierLines = [];
    for (const tier of edgeTiers) {
      const tt  = resolved.filter(t => (t.edge || 0) >= tier.min && (t.edge || 0) < tier.max);
      if (tt.length === 0) continue;
      const tw  = tt.filter(t => t.signalResult === 'win');
      const twr = Math.round(100 * tw.length / tt.length);
      const tpnl = tt.reduce((a, t) => a + (t.pnlDollars || 0), 0);
      const tpnlStr = tpnl >= 0 ? `+$${tpnl.toFixed(0)}` : `-$${Math.abs(tpnl).toFixed(0)}`;
      tierLines.push(`  ${tier.label.padEnd(12)} ${tw.length}W/${tt.length - tw.length}L  ${twr}% WR  ${tpnlStr}`);
    }
    if (tierLines.length) {
      dash.push('', '**By edge:**');
      dash.push(...tierLines);
    }

    // Side breakdown (YES vs NO) — key calibration signal
    const sideRows = [
      { label: 'NO ',  trades: resolved.filter(t => t.side === 'no') },
      { label: 'YES',  trades: resolved.filter(t => t.side === 'yes') },
    ];
    const sideLines = sideRows
      .filter(r => r.trades.length > 0)
      .map(r => {
        const w   = r.trades.filter(t => t.signalResult === 'win');
        const wr  = Math.round(100 * w.length / r.trades.length);
        const pnl = r.trades.reduce((a, t) => a + (t.pnlDollars || 0), 0);
        const ps  = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
        return `  ${r.label}  ${w.length}W/${r.trades.length - w.length}L  ${wr}% WR  ${ps}`;
      });
    if (sideLines.length) {
      dash.push('', '**By side:**');
      dash.push(...sideLines);
    }

    // Direction breakdown (above/below/range)
    const dirRows = [
      { label: 'Above ', dir: 'above' },
      { label: 'Below ', dir: 'below' },
      { label: 'Range ', dir: 'range' },
    ];
    const dirLines = dirRows
      .map(r => ({ ...r, trades: resolved.filter(t => t.parsed?.direction === r.dir) }))
      .filter(r => r.trades.length > 0)
      .map(r => {
        const w  = r.trades.filter(t => t.signalResult === 'win');
        const wr = Math.round(100 * w.length / r.trades.length);
        return `  ${r.label}  ${w.length}W/${r.trades.length - w.length}L  ${wr}% WR`;
      });
    if (dirLines.length) {
      dash.push('', '**By direction:**');
      dash.push(...dirLines);
    }
  }

  await api.sendMessage(dash.join('\n').slice(0, 1950));

  // ── Positions message ────────────────────────────────────────────────────
  const allOpen = trades
    .filter(t => t.outcome === null)
    .sort((a, b) => {
      const dA = new Date(a.parsed?.date) - now;
      const dB = new Date(b.parsed?.date) - now;
      if (dA > 0 && dB <= 0) return -1;
      if (dB > 0 && dA <= 0) return 1;
      if (Math.abs(dA - dB) > 86_400_000) return dA - dB;
      return (b.edge || 0) - (a.edge || 0);
    });

  const SHOW_OPEN = 6;
  const openSlice = allOpen.slice(0, SHOW_OPEN);
  const pos = [];

  if (openSlice.length) {
    pos.push(`**OPEN (${allOpen.length} total)**`);
    for (const t of openSlice) {
      const daysLeft = ((new Date(t.parsed?.date) - now) / 86_400_000).toFixed(1);
      const icon     = t.side === 'yes' ? '🟢' : '🔴';
      const city     = (t.parsed?.city || '').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 14);
      pos.push(`${icon} **${t.side.toUpperCase()}** ${city} | Edge **${t.edge}%** | ${t.parsed?.date} (${daysLeft}d) | \`${t.id}\``);
    }
    if (allOpen.length > SHOW_OPEN) pos.push(`  *…and ${allOpen.length - SHOW_OPEN} more*`);
  } else {
    pos.push('**OPEN** — none');
  }

  const recent = trades
    .filter(t => t.signalResult != null)
    .sort((a, b) => new Date(b.firedAt) - new Date(a.firedAt))
    .slice(0, 5);

  if (recent.length) {
    pos.push('', `**LAST ${recent.length} RESOLVED**`);
    for (const t of recent) {
      const icon   = t.signalResult === 'win' ? '✅' : '❌';
      const pnlStr = t.pnlDollars != null
        ? (t.pnlDollars >= 0 ? `+$${t.pnlDollars.toFixed(2)}` : `-$${Math.abs(t.pnlDollars).toFixed(2)}`)
        : '?';
      const city   = (t.parsed?.city || '').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 14);
      const obs    = t.observedTemp != null ? ` | obs ${t.observedTemp.toFixed(1)}°F` : '';
      pos.push(`${icon} ${t.side === 'yes' ? '🟢' : '🔴'} **${t.side.toUpperCase()}** ${city} | **${pnlStr}**${obs} | ${t.parsed?.date}`);
    }
  }

  pos.push('', `*\`!took <id>\` to log entry · \`!exit <id> win|loss\` to close · \`!settle\` to resolve expired*`);

  await api.sendMessage(pos.join('\n').slice(0, 1950));
}

// ─── !settle ─────────────────────────────────────────────────────────────────

async function handleSettle(user, text, api) {
  await api.sendTyping();

  // Optional flags: !settle --force, !settle --id wx-abc123, !settle --dry
  const extraArgs = text.replace(/^!settle\s*/i, '').trim().split(/\s+/).filter(Boolean);
  const force     = extraArgs.includes('--force');
  const dry       = extraArgs.includes('--dry');
  const idIdx     = extraArgs.indexOf('--id');
  const targetId  = idIdx !== -1 ? extraArgs[idIdx + 1] : null;

  const modeStr = [force && '--force', dry && '--dry', targetId && `--id ${targetId}`]
    .filter(Boolean).join(' ') || 'default';

  await api.sendMessage(`🔍 **Settlement run triggered by ${user}** (${modeStr})\nChecking GHCN-Daily + NWS METAR for expired markets...`);

  const args = [SETTLE_SCRIPT, ...extraArgs];
  const result = spawnSync(NODE, args, { encoding: 'utf8', timeout: 120_000 });

  if (result.error || result.status !== 0) {
    const err = result.error?.message || result.stderr?.trim() || 'Unknown error';
    await api.sendMessage(`❌ **Settlement failed:** ${err.slice(0, 300)}`);
    return;
  }

  // Extract summary from last few lines of stdout
  const lines    = (result.stdout || '').trim().split('\n');
  const lastLine = lines[lines.length - 1] || '';
  const match    = lastLine.match(/Resolved: (\d+) \| Skipped[^|]*\| Lifetime: (.+)/);

  if (match) {
    const [, resolved, lifetime] = match;
    const msg = dry
      ? `✅ **[DRY RUN]** Would resolve **${resolved}** trade(s). Re-run without \`--dry\` to commit.`
      : `✅ **Settlement complete** — **${resolved}** resolved | Lifetime: ${lifetime}\nResolution cards posted to #weather-backtest.`;
    await api.sendMessage(msg);
  } else {
    await api.sendMessage(`✅ **Settlement run complete.** Check #weather-backtest for results.`);
  }
}

// ─── !took ───────────────────────────────────────────────────────────────────

async function handleTook(user, tradeId, api) {
  if (!tradeId) {
    await api.sendMessage('Usage: `!took <signal-id>` — get the ID from `!trades`');
    return;
  }

  const trades = readTrades();
  const trade  = trades.find(t => t.id === tradeId);

  if (!trade) {
    await api.sendMessage(`❌ Signal \`${tradeId}\` not found. Use \`!trades\` to list open signals.`);
    return;
  }
  if (trade.tookBy) {
    await api.sendMessage(`⚠️ Signal \`${tradeId}\` was already logged by **${trade.tookBy}**.`);
    return;
  }

  trade.tookBy  = user;
  trade.tookAt  = new Date().toISOString();
  writeTrades(trades);

  const icon = trade.side === 'yes' ? '🟢' : '🔴';
  const msg  = [
    `${icon} **Paper Entry Logged — ${trade.side.toUpperCase()} YES**`,
    `**${(trade.question || '').slice(0, 80)}**`,
    `Price: **${pct(trade.side === 'yes' ? trade.yesPrice : trade.noPrice)}** | Suggested: ${usd(trade.betDollars)}`,
    `Edge: ${trade.edge}% | Model: ${pct(trade.modelProb / 100)} | Resolves: ${trade.parsed?.date}`,
    `\`ID: ${tradeId}\``,
    `*Use \`!exit ${tradeId} win|loss\` when the market resolves.*`,
  ].join('\n');

  await api.sendMessage(msg);

  if (BACKTEST_HOOK) {
    await postWebhook(BACKTEST_HOOK, 'info',
      `📋 **PAPER ENTRY LOGGED**\nBy: ${user} | ${new Date().toISOString().slice(0, 16)}\n${msg}`,
      'Weather • Paper Trade');
  }
}

// ─── !exit ───────────────────────────────────────────────────────────────────

async function handleExit(user, args, api) {
  const tradeId = args[0];
  const outcome = (args[1] || '').toLowerCase();

  if (!tradeId || !['win', 'loss', 'manual'].includes(outcome)) {
    await api.sendMessage('Usage: `!exit <signal-id> win|loss|manual`');
    return;
  }

  const trades = readTrades();
  const idx    = trades.findIndex(t => t.id === tradeId);

  if (idx === -1) {
    await api.sendMessage(`❌ Signal \`${tradeId}\` not found.`);
    return;
  }

  const trade = trades[idx];
  if (trade.signalResult != null) {
    await api.sendMessage(`⚠️ Signal \`${tradeId}\` is already closed (${trade.signalResult}).`);
    return;
  }

  const signalWon = outcome === 'win';
  const price     = trade.side === 'yes' ? trade.yesPrice : trade.noPrice;
  const pnl       = trade.betDollars > 0
    ? signalWon
      ? Math.round(trade.betDollars * (1 - price) / price * 100) / 100
      : -trade.betDollars
    : null;

  trades[idx].signalResult = outcome === 'manual' ? 'manual' : (signalWon ? 'win' : 'loss');
  trades[idx].pnlDollars   = pnl;
  trades[idx].closedAt     = new Date().toISOString();
  trades[idx].closedBy     = user;
  trades[idx].outcome      = outcome;
  writeTrades(trades);

  const icon = signalWon ? '✅' : outcome === 'manual' ? '📋' : '❌';
  const pnlStr = pnl != null ? (pnl >= 0 ? `+${usd(pnl)}` : `-${usd(pnl)}`) : '?';

  const msg = [
    `${icon} **Paper Trade Closed — ${outcome.toUpperCase()}**`,
    `${(trade.question || '').slice(0, 70)}...`,
    `Side: ${trade.side.toUpperCase()} | P&L: **${pnlStr}**`,
    `\`ID: ${tradeId}\``,
  ].join('\n');

  await api.sendMessage(msg);

  if (BACKTEST_HOOK) {
    await postWebhook(BACKTEST_HOOK, signalWon ? 'long' : 'error', msg, 'Weather • Paper Trade');
  }
}

// ─── !resolve-status ─────────────────────────────────────────────────────────

async function handleResolveStatus(user, api) {
  await api.sendTyping();

  const trades = readTrades();
  const now    = Date.now();

  const open        = trades.filter(t => t.outcome === null || t.outcome === undefined);
  const superseded  = trades.filter(t => t.outcome === 'superseded');
  const resolved    = trades.filter(t => t.signalResult === 'win' || t.signalResult === 'loss');
  const wins        = resolved.filter(t => t.signalResult === 'win');

  // Classify open trades by resolution eligibility
  const pending = open.map(t => {
    const targetMs = new Date(t.parsed?.date || 0).getTime();
    const hoursAgo = (now - targetMs) / 3_600_000;
    return { trade: t, hoursAgo };
  }).sort((a, b) => b.hoursAgo - a.hoursAgo);  // oldest first

  const polyEligible = pending.filter(p => p.hoursAgo >= 12);
  const obsEligible  = pending.filter(p => p.hoursAgo >= 36);
  const tooEarly     = pending.filter(p => p.hoursAgo < 12);

  const lines = [
    `📊 **RESOLUTION STATUS**`,
    `Open (unresolved): **${open.length}**`,
    `  • ${obsEligible.length} eligible for GHCN check (36h+ past date)`,
    `  • ${polyEligible.length - obsEligible.length} eligible for Polymarket check only (12–36h past date)`,
    `  • ${tooEarly.length} too early (< 12h past date)`,
    `Superseded: ${superseded.length} | Resolved: ${wins.length}W / ${resolved.length - wins.length}L`,
  ];

  if (polyEligible.length > 0) {
    lines.push('', '**Pending (oldest first):**');
    for (const { trade: t, hoursAgo } of polyEligible.slice(0, 8)) {
      const hasCondId = t.conditionId ? '✓' : '✗';
      const age       = hoursAgo >= 36 ? `${hoursAgo.toFixed(0)}h ⚠️` : `${hoursAgo.toFixed(1)}h`;
      lines.push(`\`${t.id}\` | ${t.parsed?.city || '?'} ${t.parsed?.type || 'high'} | ${t.parsed?.date || '?'} | ${age} | condId ${hasCondId}`);
    }
    if (polyEligible.length > 8) lines.push(`  ...and ${polyEligible.length - 8} more`);
  }

  await api.sendMessage(lines.join('\n').slice(0, 1950));
}

module.exports = { handle };
