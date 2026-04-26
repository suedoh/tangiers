#!/usr/bin/env node
/**
 * Ace Trading System — Weekly Performance Report
 *
 * Reads trades.json, computes 7-day stats, posts to #backtest-btc via Discord.
 * Run via cron every Monday at 09:00 UTC.
 *
 * Usage: node scripts/weekly-report.js
 *        node scripts/weekly-report.js --days 30   (custom lookback)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT        = path.resolve(__dirname, '..');
const ENV_FILE    = path.join(ROOT, '.env');
const TRADES_FILE = path.join(ROOT, 'trades.json');

// ─── Env ─────────────────────────────────────────────────────────────────────

if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const idx = l.indexOf('=');
      if (idx > 0) process.env[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
    });
}

const WEBHOOK_URL = process.env.DISCORD_BTC_BACKTEST_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error('ERROR: DISCORD_BTC_BACKTEST_WEBHOOK_URL not set in .env');
  process.exit(1);
}

// ─── Args ─────────────────────────────────────────────────────────────────────

const daysArg = process.argv.indexOf('--days');
const LOOKBACK_DAYS = daysArg !== -1 ? parseInt(process.argv[daysArg + 1], 10) : 7;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function postToDiscord(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      if (res.statusCode === 204) resolve();
      else reject(new Error(`Discord returned HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function pct(n, d) {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

function fmt(n) {
  if (n == null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function calcTrack(closed) {
  const wins   = closed.filter(t => t.outcome?.startsWith('tp'));
  const losses = closed.filter(t => t.outcome === 'stop' || t.outcome === 'invalidated');
  const totalR = closed.reduce((sum, t) => sum + (t.pnlR ?? 0), 0);
  const avgR   = closed.length ? totalR / closed.length : null;
  const tp1hits = wins.filter(t => t.outcome === 'tp1').length;
  const tp2hits = wins.filter(t => t.outcome === 'tp2').length;
  const tp3hits = wins.filter(t => t.outcome === 'tp3').length;
  return {
    count: closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    totalR, avgR, tp1hits, tp2hits, tp3hits,
  };
}

function analyse(trades, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const window = trades.filter(t => new Date(t.firedAt).getTime() >= cutoff);

  const closed  = window.filter(t => t.outcome !== null && t.outcome !== 'expired');
  const open    = window.filter(t => t.outcome === null);
  const expired = window.filter(t => t.outcome === 'expired');

  // All-signals track (every closed trade regardless of confirmation)
  const allTrack = calcTrack(closed);

  // Confirmed-only track (only trades where 30M close above entry happened)
  const confirmedClosed = closed.filter(t => t.confirmed === true);
  const confirmedTrack  = calcTrack(confirmedClosed);

  // Unconfirmed track (signal fired but entry never triggered)
  const unconfirmedClosed = closed.filter(t => !t.confirmed);
  const unconfirmedTrack  = calcTrack(unconfirmedClosed);

  // Confirmation rate
  const allWindow      = window.length;
  const confirmedTotal = window.filter(t => t.confirmed === true).length;

  // By level type (HVN, VAL, VAH, POC) — confirmed only
  const byLevel = {};
  for (const t of confirmedClosed) {
    const key = t.zone?.type || 'Unknown';
    if (!byLevel[key]) byLevel[key] = { wins: 0, losses: 0, totalR: 0, confirmed: 0, unconfirmed: 0 };
    if (t.outcome?.startsWith('tp')) byLevel[key].wins++;
    else byLevel[key].losses++;
    byLevel[key].totalR += t.pnlR ?? 0;
  }
  // Add confirmation rate per level type
  for (const t of window) {
    const key = t.zone?.type || 'Unknown';
    if (!byLevel[key]) byLevel[key] = { wins: 0, losses: 0, totalR: 0, confirmed: 0, unconfirmed: 0 };
    if (t.confirmed) byLevel[key].confirmed++;
    else byLevel[key].unconfirmed++;
  }

  // By direction — confirmed only
  const confLongs  = confirmedClosed.filter(t => t.direction === 'long');
  const confShorts = confirmedClosed.filter(t => t.direction === 'short');
  const confLongWins  = confLongs.filter(t => t.outcome?.startsWith('tp'));
  const confShortWins = confShorts.filter(t => t.outcome?.startsWith('tp'));

  // Best / worst (confirmed only — unconfirmed outcomes aren't real entries)
  const sorted = [...confirmedClosed].sort((a, b) => (b.pnlR ?? 0) - (a.pnlR ?? 0));
  const best   = sorted[0]  ?? null;
  const worst  = sorted[sorted.length - 1] ?? null;

  // Criteria accuracy — confirmed trades only (gives cleaner signal)
  const criteriaStats = {};
  for (const t of confirmedClosed) {
    for (const c of (t.criteria || [])) {
      if (!c.auto || c.pass === null) continue;
      const k = c.label.replace(/\$[\d,]+/g, '$X').replace(/[+-]?\d+(\.\d+)?/g, 'N');
      if (!criteriaStats[k]) criteriaStats[k] = { aligned_wins: 0, aligned_losses: 0 };
      const won = t.outcome?.startsWith('tp');
      if (c.pass) { won ? criteriaStats[k].aligned_wins++ : criteriaStats[k].aligned_losses++; }
    }
  }

  // Streak — current consecutive wins or losses in confirmed closed trades
  // Walk from most recent backward and count until the streak breaks
  const streakTrades = [...confirmedClosed]
    .filter(t => t.closedAt)
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  let streak = 0, streakType = null;
  for (const t of streakTrades) {
    const won = t.outcome?.startsWith('tp');
    if (streakType === null) { streakType = won ? 'win' : 'loss'; streak = 1; }
    else if ((streakType === 'win') === won) streak++;
    else break;
  }

  // Time-to-outcome — avg hours from signal fired to outcome bar (confirmed only)
  const timesToClose = confirmedClosed
    .filter(t => t.firedAt && t.closedAt)
    .map(t => (new Date(t.closedAt) - new Date(t.firedAt)) / 3600000); // hours
  const avgHoursToClose = timesToClose.length
    ? timesToClose.reduce((a, b) => a + b, 0) / timesToClose.length
    : null;
  const winTimes  = confirmedClosed
    .filter(t => t.outcome?.startsWith('tp') && t.firedAt && t.closedAt)
    .map(t => (new Date(t.closedAt) - new Date(t.firedAt)) / 3600000);
  const lossTimes = confirmedClosed
    .filter(t => t.outcome === 'stop' && t.firedAt && t.closedAt)
    .map(t => (new Date(t.closedAt) - new Date(t.firedAt)) / 3600000);
  const avgWinHours  = winTimes.length  ? winTimes.reduce((a,b)=>a+b,0)  / winTimes.length  : null;
  const avgLossHours = lossTimes.length ? lossTimes.reduce((a,b)=>a+b,0) / lossTimes.length : null;

  // ── Phase 2 stub: your execution track ──────────────────────────────────────
  // Reads my-trades.json once it exists. All values are null until !took / !exit
  // are activated (remove the early-return guards in discord-bot.js handleTook/handleExit).
  // TODO (Phase 2): uncomment and wire into formatReport()
  //
  // const MY_TRADES_FILE = path.join(ROOT, 'my-trades.json');
  // function readMyTrades() { try { return JSON.parse(fs.readFileSync(MY_TRADES_FILE,'utf8')); } catch { return []; } }
  // const myTrades = readMyTrades();
  // const myWindow = myTrades.filter(t => new Date(t.tookAt).getTime() >= cutoff);
  // const myClosed = myWindow.filter(t => t.outcome !== null);
  // const myTrack  = calcTrack(myClosed);
  // const selectivity = allWindow > 0 ? myWindow.length / allWindow : null; // % of signals you took
  // return { ..., myTrack, selectivity };

  return {
    days,
    allWindow, open: open.length, expired: expired.length,
    confirmedTotal,
    allTrack, confirmedTrack, unconfirmedTrack,
    confLongs: confLongs.length, confLongWins: confLongWins.length,
    confShorts: confShorts.length, confShortWins: confShortWins.length,
    byLevel, best, worst, criteriaStats,
    streak, streakType,
    avgHoursToClose, avgWinHours, avgLossHours,
  };
}

// ─── Format ───────────────────────────────────────────────────────────────────

function formatReport(s) {
  const dateRange = (() => {
    const end   = new Date();
    const start = new Date(Date.now() - s.days * 24 * 60 * 60 * 1000);
    return `${start.toLocaleDateString('en-CA')} → ${end.toLocaleDateString('en-CA')}`;
  })();

  const { allTrack: all, confirmedTrack: conf, unconfirmedTrack: unconf } = s;
  const confirmRate = s.allWindow > 0 ? `${Math.round(s.confirmedTotal / s.allWindow * 100)}%` : '—';

  // ── Signal funnel ──
  const funnelLines = [
    `Signals fired:   ${s.allWindow} (${s.open} still open | ${s.expired} expired)`,
    `Confirmed entry: ${s.confirmedTotal} of ${s.allWindow} (${confirmRate}) — 30M close beyond entry with CVD`,
    ``,
    `**ALL SIGNALS** (bar-accurate)`,
    `Closed: ${all.count} | Wins: ${all.wins} | Losses: ${all.losses} | Win Rate: **${all.winRate != null ? Math.round(all.winRate*100)+'%' : '—'}**`,
    `Total R: **${fmt(all.totalR)}** | Avg R: ${fmt(all.avgR)}`,
    `TP distribution: TP1 ${all.tp1hits} · TP2 ${all.tp2hits} · TP3 ${all.tp3hits}`,
    ``,
    `**CONFIRMED SIGNALS ONLY** ← *real win rate*`,
    `Closed: ${conf.count} | Wins: ${conf.wins} | Losses: ${conf.losses} | Win Rate: **${conf.winRate != null ? Math.round(conf.winRate*100)+'%' : '—'}**`,
    `Total R: **${fmt(conf.totalR)}** | Avg R: ${fmt(conf.avgR)}`,
    `TP distribution: TP1 ${conf.tp1hits} · TP2 ${conf.tp2hits} · TP3 ${conf.tp3hits}`,
    ``,
    `**UNCONFIRMED SIGNALS** (entry never triggered)`,
    `Closed: ${unconf.count} | Wins: ${unconf.wins} | Losses: ${unconf.losses} | Win Rate: ${unconf.winRate != null ? Math.round(unconf.winRate*100)+'%' : '—'}`,
  ].join('\n');

  // ── By level type ──
  const levelLines = Object.entries(s.byLevel)
    .sort((a, b) => (b[1].confirmed + b[1].unconfirmed) - (a[1].confirmed + a[1].unconfirmed))
    .map(([type, d]) => {
      const total = d.wins + d.losses;
      const confR = d.confirmed + d.unconfirmed > 0
        ? `${Math.round(d.confirmed / (d.confirmed + d.unconfirmed) * 100)}% confirmed`
        : '—';
      return `  ${type}: ${d.wins}/${total} wins (${pct(d.wins, total)}) | ${fmt(d.totalR)} | ${confR}`;
    }).join('\n') || '  No data yet';

  // ── By direction (confirmed only) ──
  const dirLines = [
    `  Longs:  ${s.confLongWins}/${s.confLongs} wins (${pct(s.confLongWins, s.confLongs)})`,
    `  Shorts: ${s.confShortWins}/${s.confShorts} wins (${pct(s.confShortWins, s.confShorts)})`,
  ].join('\n');

  // ── Criteria — top 4 most predictive (confirmed trades, min 3 samples) ──
  const criteriaLines = Object.entries(s.criteriaStats)
    .map(([label, d]) => {
      const aligned = d.aligned_wins + d.aligned_losses;
      const rate    = aligned >= 3 ? d.aligned_wins / aligned : null;
      return { label, rate, aligned };
    })
    .filter(c => c.rate !== null)
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 4)
    .map(c => `  ${Math.round(c.rate * 100)}% win when ✅ — ${c.label} (${c.aligned} samples)`)
    .join('\n') || '  Not enough data yet (need 3+ confirmed closed trades per criterion)';

  // ── Best / worst ──
  const bestLine  = s.best  ? `  ${s.best.direction.toUpperCase()} ${s.best.zone?.type ?? ''} ${s.best.firedAt.slice(0,10)} → ${fmt(s.best.pnlR)} (${s.best.outcome})` : '  —';
  const worstLine = s.worst ? `  ${s.worst.direction.toUpperCase()} ${s.worst.zone?.type ?? ''} ${s.worst.firedAt.slice(0,10)} → ${fmt(s.worst.pnlR)} (${s.worst.outcome})` : '  —';

  // ── Streak ──
  const streakLine = s.streakType
    ? `Current streak: **${s.streak} ${s.streakType}${s.streak > 1 ? 's' : ''}** in a row (confirmed trades)`
    : 'Current streak: — (no confirmed closed trades yet)';

  // ── Time to outcome ──
  const h = n => n != null ? `${n.toFixed(1)}h` : '—';
  const timeLines = [
    `Avg time to close: ${h(s.avgHoursToClose)} | Wins: ${h(s.avgWinHours)} | Losses: ${h(s.avgLossHours)}`,
    s.avgWinHours != null && s.avgLossHours != null
      ? (s.avgWinHours < s.avgLossHours
          ? `  ✅ Wins resolve faster than losses — momentum-driven, healthy`
          : `  ⚠️ Losses resolving faster — stops being hit quickly, review stop placement`)
      : '',
  ].filter(Boolean).join('\n');

  // ── Confirmation filter value ──
  const filterNote = conf.winRate != null && unconf.winRate != null
    ? (conf.winRate > unconf.winRate
        ? `✅ Confirmation filter adds +${Math.round((conf.winRate - unconf.winRate) * 100)}pp — keep waiting for the close`
        : `⚠️ Confirmation filter not adding value this week — review entry criteria`)
    : '';

  // ── Phase 2 execution stub ──
  // Replace this block once !took / !exit are activated in discord-bot.js.
  // When my-trades.json has data, uncomment the myTrack/selectivity lines in analyse()
  // and replace this stub with real numbers.
  const executionLines = [
    `*Phase 2 not yet active — use \`!took <id>\` and \`!exit\` to track your entries.*`,
    `*Once active: your win rate vs system win rate, selectivity %, and R comparison will appear here.*`,
  ].join('\n');

  const noDataNote = all.count === 0
    ? '\n⚠️ No closed trades yet — outcomes populate automatically each poll cycle.'
    : '';

  return [
    `📊 **WEEKLY PERFORMANCE REPORT** | BINANCE:BTCUSDT.P`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `**Period**  ${dateRange} (${s.days} days)`,
    ``,
    `**SIGNAL FUNNEL**`,
    funnelLines,
    ...(filterNote ? [``, filterNote] : []),
    ``,
    `**BY LEVEL TYPE** (confirmed trades)`,
    levelLines,
    ``,
    `**BY DIRECTION** (confirmed trades)`,
    dirLines,
    ``,
    `**MOST PREDICTIVE CRITERIA** (confirmed trades)`,
    criteriaLines,
    ``,
    `**TIME TO OUTCOME** (confirmed trades)`,
    timeLines,
    ``,
    streakLine,
    ``,
    `**BEST TRADE**`,
    bestLine,
    `**WORST TRADE**`,
    worstLine,
    ``,
    `**YOUR EXECUTION** (Phase 2)`,
    executionLines,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    noDataNote,
  ].filter(l => l !== undefined).join('\n');
}

// ─── Plain-English Summary ────────────────────────────────────────────────────

function formatSummary(s) {
  const { confirmedTrack: conf, unconfirmedTrack: unconf } = s;
  const lines = [];

  if (conf.count === 0) {
    return [
      `🔍 **WHAT THIS MEANS**`,
      `No confirmed trades in this period — signals fired but none reached the 30M entry trigger. This is normal in choppy or range-bound conditions. If it persists beyond 2 weeks, check whether the confirmation threshold is too tight or whether the VRVP indicator is visible on the chart.`,
    ].join('\n');
  }

  // Win rate
  const wr = conf.winRate;
  if      (wr >= 0.60) lines.push(`✅ **Win rate is strong at ${Math.round(wr*100)}%.** The strategy is identifying high-probability levels well this period.`);
  else if (wr >= 0.50) lines.push(`🟡 **Win rate of ${Math.round(wr*100)}% is acceptable** but below the 55–65% target. You're still profitable if avg R stays above 0.5R, but look at what the losing trades have in common.`);
  else if (wr >= 0.40) lines.push(`⚠️ **Win rate of ${Math.round(wr*100)}% is below 50%.** You need avg R above 1.0 per trade to stay profitable at this rate. Review whether stops are placed at logical structure or just a fixed distance.`);
  else                 lines.push(`🔴 **Win rate of ${Math.round(wr*100)}% needs attention.** Check if market structure has changed — a trending market can make mean-reversion zone plays consistently fail. Consider pausing and reviewing the last 5 losses on a chart.`);

  // R profitability
  if (conf.avgR != null) {
    if      (conf.avgR >= 1.5) lines.push(`💰 **Avg ${fmt(conf.avgR)} per confirmed trade — excellent.** The strategy is not just winning more than losing; it's winning bigger. This is the ideal profile.`);
    else if (conf.avgR >= 0.5) lines.push(`💰 **Avg ${fmt(conf.avgR)} per confirmed trade — healthy.** The strategy is profitable. Look for ways to let TP2/TP3 hit more often to push this higher.`);
    else if (conf.avgR >= 0)   lines.push(`⚠️ **Avg ${fmt(conf.avgR)} per confirmed trade — barely breakeven.** Even with a decent win rate, small average R means transaction costs and slippage eat the edge. Try scaling out at TP1 less aggressively.`);
    else                       lines.push(`🔴 **Avg ${fmt(conf.avgR)} per confirmed trade — negative.** The strategy lost money on confirmed entries this period. Losses are likely larger than wins on average, which points to a stop placement issue.`);
  }

  // Confirmation filter value
  if (conf.winRate != null && unconf.winRate != null && unconf.count >= 3) {
    const diffPp = Math.round((conf.winRate - unconf.winRate) * 100);
    if      (diffPp >= 10)  lines.push(`🔍 **The 30M entry confirmation is earning its keep** — confirmed trades win ${diffPp}pp more than unconfirmed ones. Keep waiting for the bar close before entering; jumping in early costs you edge.`);
    else if (diffPp >= 0)   lines.push(`🔍 **The confirmation filter adds a small edge (+${diffPp}pp).** It's working but only marginally. If this stays flat over several weeks, consider tightening the CVD threshold alongside the bar close.`);
    else                    lines.push(`⚠️ **Unconfirmed signals are currently outperforming confirmed ones by ${Math.abs(diffPp)}pp.** This may mean you're entering late after the move has already played out. Check whether confirmation bars are happening far from the zone centre.`);
  }

  // Confirmation rate health
  const confRate = s.allWindow > 0 ? s.confirmedTotal / s.allWindow : null;
  if (confRate != null) {
    if      (confRate < 0.30) lines.push(`⚠️ **Only ${Math.round(confRate*100)}% of signals are triggering entry** — lower than the healthy 50–70% range. Either market conditions are choppy (price approaches zones but never commits), or the confirmation criteria are too strict. Watch the next week before adjusting.`);
    else if (confRate > 0.80) lines.push(`⚠️ **${Math.round(confRate*100)}% of signals are confirming — unusually high.** A very high confirmation rate can mean the filter isn't screening out weak setups. Make sure CVD alignment is genuinely directional, not just noise.`);
  }

  // Best / worst level type (min 3 confirmed closed trades)
  const levelEntries = Object.entries(s.byLevel)
    .map(([type, d]) => ({ type, total: d.wins + d.losses, wr: d.wins + d.losses >= 3 ? d.wins / (d.wins + d.losses) : null }))
    .filter(l => l.wr !== null);
  if (levelEntries.length >= 2) {
    const sorted = [...levelEntries].sort((a, b) => b.wr - a.wr);
    const best  = sorted[0];
    const worst = sorted[sorted.length - 1];
    const note  = worst.wr < 0.40 ? ` Consider reducing size on **${worst.type}** setups until this improves.` : ' Both are within an acceptable range.';
    lines.push(`📊 **Best level type: ${best.type}** (${Math.round(best.wr*100)}% win rate). **Weakest: ${worst.type}** (${Math.round(worst.wr*100)}%).${note}`);
  }

  // Direction bias
  const longWR  = s.confLongs  >= 2 ? s.confLongWins  / s.confLongs  : null;
  const shortWR = s.confShorts >= 2 ? s.confShortWins / s.confShorts : null;
  if (longWR != null && shortWR != null) {
    const diffPp = Math.abs(Math.round((longWR - shortWR) * 100));
    if (diffPp >= 20) {
      const better = longWR > shortWR ? 'longs' : 'shorts';
      const worse  = longWR > shortWR ? 'shorts' : 'longs';
      lines.push(`📐 **Strong direction bias: ${better} are winning ${diffPp}pp more than ${worse}.** This usually reflects the broader market trend. Consider sizing down ${worse} or skipping them entirely until the bias narrows.`);
    }
  } else if (longWR != null && s.confShorts < 2) {
    lines.push(`📐 **Not enough short trades to assess direction balance.** All or most confirmed signals were longs this period — normal in a trending market.`);
  } else if (shortWR != null && s.confLongs < 2) {
    lines.push(`📐 **Not enough long trades to assess direction balance.** All or most confirmed signals were shorts this period — check whether a downtrend is dominating the zone structure.`);
  }

  // Time to outcome
  if (s.avgWinHours != null && s.avgLossHours != null) {
    if (s.avgLossHours > s.avgWinHours * 1.5) {
      lines.push(`⏱️ **Losses are taking ${s.avgLossHours.toFixed(1)}h vs ${s.avgWinHours.toFixed(1)}h for wins.** When losses grind slowly to stop, it usually means stops are placed too far away — the market is dragging against you before finally taking you out. Try tightening stops to just below the zone rather than below the wider structure.`);
    } else if (s.avgWinHours > s.avgLossHours * 1.5) {
      lines.push(`⏱️ **Wins take ${s.avgWinHours.toFixed(1)}h vs ${s.avgLossHours.toFixed(1)}h for losses.** Losses are fast, wins are slow — this is a healthy momentum pattern. It means when the zone fails you know quickly, and when it holds the trade trends in your favour.`);
    }
  }

  // Streak warning
  if (s.streakType === 'loss' && s.streak >= 3) {
    lines.push(`🔴 **${s.streak}-loss streak on confirmed trades.** This is within normal variance for a ~55% strategy but worth watching. Before taking the next signal, manually verify on the chart that the setup criteria are genuinely met — drawdown periods often coincide with forcing setups in low-quality conditions.`);
  } else if (s.streakType === 'win' && s.streak >= 4) {
    lines.push(`🟢 **${s.streak}-win streak — the strategy is dialled in right now.** Stay disciplined and resist the urge to increase size mid-streak; let the edge compound at the same risk per trade.`);
  }

  return [`🔍 **WHAT THIS MEANS**`, ...lines].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const trades = readTrades();
  const stats  = analyse(trades, LOOKBACK_DAYS);
  const report = formatReport(stats);
  const summary = formatSummary(stats);

  console.log(report);
  console.log('');
  console.log(summary);
  console.log('');

  const summaryColor = (() => {
    const conf = stats.confirmedTrack;
    if (conf.count === 0)       return 16776960; // yellow — no data
    if (conf.avgR >= 0.5 && conf.winRate >= 0.55) return 5763719;  // green — healthy
    if (conf.avgR < 0 || conf.winRate < 0.40)     return 15548997; // red — needs work
    return 16744272; // orange — marginal
  })();

  await postToDiscord({
    embeds: [{
      description: report,
      color: 3447003,
      footer: { text: `Ace • BINANCE:BTCUSDT.P • ${LOOKBACK_DAYS}-day report` },
      timestamp: new Date().toISOString(),
    }],
  });

  await postToDiscord({
    embeds: [{
      description: summary,
      color: summaryColor,
      footer: { text: `Ace • BINANCE:BTCUSDT.P • ${LOOKBACK_DAYS}-day interpretation` },
      timestamp: new Date().toISOString(),
    }],
  });

  console.log(`Report posted to #backtest-btc (${stats.allTrack.count} closed trades analysed)`);
}

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; }
}

main().catch(err => {
  console.error('weekly-report failed:', err.message);
  process.exit(1);
});
