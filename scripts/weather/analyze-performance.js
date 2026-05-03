#!/usr/bin/env node
'use strict';

/**
 * weather/analyze-performance.js — Deep performance analysis
 *
 * Covers what weekly-report.js doesn't:
 *   - Recent vs historical win rate comparison
 *   - Bias correction impact (since 2026-04-27)
 *   - AI filter calibration (confidence buckets, flags, reduce vs take)
 *   - Direction/side breakdown (above/below/range × YES/NO)
 *
 * Usage:
 *   node scripts/weather/analyze-performance.js              # 30-day recent window
 *   node scripts/weather/analyze-performance.js --days 7    # 7-day window
 *   node scripts/weather/analyze-performance.js --days 60   # 60-day window
 */

const path = require('path');
const fs   = require('fs');
const { loadEnv, ROOT, resolveWebhook } = require('../lib/env');
const { postWebhook }                   = require('../lib/discord');

loadEnv();

// ── Config ────────────────────────────────────────────────────────────────────

const BACKTEST_HOOK = resolveWebhook('WEATHER_DISCORD_BACKTEST_WEBHOOK');
const TRADES_FILE   = path.join(ROOT, 'weather-trades.json');
const BIAS_FILE     = path.join(ROOT, 'scripts/lib/bias-corrections.json');

const RECENT_DAYS = (() => {
  const idx = process.argv.indexOf('--days');
  const v   = idx !== -1 ? parseInt(process.argv[idx + 1], 10) : NaN;
  return (Number.isFinite(v) && v > 0 && v <= 365) ? v : 30;
})();

// Dates when key changes landed
const BIAS_CUTOFF   = new Date('2026-04-27T00:00:00Z');
const AI_CUTOFF     = new Date('2026-04-23T00:00:00Z');
const YES_BLOCK_DATE = new Date('2026-04-28T00:00:00Z'); // YES+above + YES+range blocked

// High-bias cities (|bias| ≥ 3°F) — where correction matters most
const HIGH_BIAS_CITIES = new Set([
  'miami', 'chengdu', 'munich', 'warsaw', 'madrid',
  'los angeles', 'istanbul', 'amsterdam', 'denver', 'wuhan', 'karachi',
]);

// Keep these in sync with BLOCKED_CITIES / PAPER_ONLY_CITIES in market-scan.js
const CITY_BLOCKED = new Set([
  'istanbul', 'singapore', 'kuala lumpur', 'nairobi', 'lagos',
  'wellington', 'lucknow', 'london', 'cape town', 'jeddah', 'paris',
]);
const CITY_PAPER = new Set([
  'madrid', 'chengdu', 'milan',
]);

function log(msg) { console.log(`[${new Date().toISOString()}] [analyze-perf] ${msg}`); }
function pct(v, digits = 1) { return v != null ? (v * 100).toFixed(digits) + '%' : 'N/A'; }
function usd(v) { return v != null ? (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2) : '?'; }

// ── Data helpers ──────────────────────────────────────────────────────────────

function readTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); }
  catch { return []; }
}

function calcTrack(arr) {
  const wins = arr.filter(t => t.signalResult === 'win');
  const loss = arr.filter(t => t.signalResult === 'loss');
  const pnl  = arr.reduce((s, t) => s + (t.pnlDollars ?? 0), 0);
  const edge = arr.length ? arr.reduce((s, t) => s + (t.edge ?? 0), 0) / arr.length : null;
  return {
    count: arr.length, wins: wins.length, losses: loss.length,
    winRate: arr.length ? wins.length / arr.length : null,
    totalPnl: pnl, avgEdge: edge,
  };
}

function shortCity(city) {
  return (city || 'unknown').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 14);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const all      = readTrades();
  const resolved = all.filter(t => (t.signalResult === 'win' || t.signalResult === 'loss') && !t.shadow);

  if (resolved.length === 0) {
    log('No resolved trades found — nothing to report');
    return;
  }

  const now        = Date.now();
  const recentCut  = now - RECENT_DAYS * 86_400_000;
  const recentDate = new Date(recentCut).toISOString().slice(0, 10);
  const todayDate  = new Date(now).toISOString().slice(0, 10);

  const recent     = resolved.filter(t => new Date(t.closedAt ?? t.firedAt).getTime() >= recentCut);
  const historical = resolved.filter(t => new Date(t.closedAt ?? t.firedAt).getTime() <  recentCut);

  const preCorrection  = resolved.filter(t => new Date(t.closedAt ?? t.firedAt) <  BIAS_CUTOFF);
  const postCorrection = resolved.filter(t => new Date(t.closedAt ?? t.firedAt) >= BIAS_CUTOFF);
  const withAI         = resolved.filter(t => t.aiDecision != null);

  log(`Resolved: ${resolved.length} total | Recent (${RECENT_DAYS}d): ${recent.length} | Historical: ${historical.length} | With AI: ${withAI.length}`);

  // ── Section A: Overview ──────────────────────────────────────────────────

  const rTrack = calcTrack(recent);
  const hTrack = calcTrack(historical);
  const aTrack = calcTrack(resolved);

  const wrDelta  = (rTrack.winRate != null && hTrack.winRate != null)
    ? rTrack.winRate - hTrack.winRate : null;

  const edgeTiers = [
    { label: 'High ≥25%',   min: 25,  max: Infinity },
    { label: 'Mid 15–25%',  min: 15,  max: 25 },
    { label: 'Min 8–15%',   min: 8,   max: 15 },
  ];

  const tierLines = [];
  for (const tier of edgeTiers) {
    const bucket = resolved.filter(t => (t.edge ?? 0) >= tier.min && (t.edge ?? 0) < tier.max);
    if (bucket.length === 0) continue;
    const tk = calcTrack(bucket);
    const arrow = tk.winRate != null && tk.winRate >= 0.5 ? '✅' : '⚠️';
    tierLines.push(`${arrow} ${tier.label.padEnd(12)} ${tk.wins}W/${tk.losses}L  ${pct(tk.winRate)}  ${usd(tk.totalPnl)}`);
  }

  const aLines = [
    `## 📊 WEATHERMEN — PERFORMANCE ANALYSIS`,
    `**${recentDate} → ${todayDate}** · ${resolved.length} resolved trades`,
    '',
    `### Recent (${RECENT_DAYS}d) vs Historical`,
    `Recent:    **${rTrack.wins}W / ${rTrack.losses}L** — ${pct(rTrack.winRate)} WR  ${usd(rTrack.totalPnl)}  (n=${rTrack.count})`,
    `Historical: **${hTrack.wins}W / ${hTrack.losses}L** — ${pct(hTrack.winRate)} WR  ${usd(hTrack.totalPnl)}  (n=${hTrack.count})`,
  ];

  if (wrDelta != null) {
    const arrow = wrDelta >= 0 ? '▲' : '▼';
    const sign  = wrDelta >= 0 ? '+' : '';
    aLines.push(`Delta:     **${arrow} ${sign}${(wrDelta * 100).toFixed(1)}%** WR`);
  }

  aLines.push('', '**Edge tiers (all-time):**');
  aLines.push(...tierLines);

  // Bias correction block
  aLines.push('', `### 📐 Bias Correction Impact (since 2026-04-27)`);

  const preBias      = preCorrection.filter(t => HIGH_BIAS_CITIES.has(t.parsed?.city));
  const postBias     = postCorrection.filter(t => HIGH_BIAS_CITIES.has(t.parsed?.city));
  const preBiasTrack = calcTrack(preBias);
  const poBTrack     = calcTrack(postBias);

  aLines.push(
    `High-bias cities pre:   **${preBiasTrack.wins}W/${preBiasTrack.losses}L** — ${pct(preBiasTrack.winRate)} WR  (n=${preBiasTrack.count})`,
    `High-bias cities post:  **${poBTrack.wins}W/${poBTrack.losses}L** — ${pct(poBTrack.winRate)} WR  (n=${poBTrack.count})${poBTrack.count < 10 ? ' ⚠️ low N' : ''}`,
  );

  // YES+range pre vs post
  const yesRangePre  = preCorrection.filter(t => t.parsed?.direction === 'range' && t.side === 'yes');
  const yesRangePost = postCorrection.filter(t => t.parsed?.direction === 'range' && t.side === 'yes');
  const yrPreT  = calcTrack(yesRangePre);
  const yrPostT = calcTrack(yesRangePost);

  aLines.push(
    `YES+range pre:   **${yrPreT.wins}W/${yrPreT.losses}L** — ${pct(yrPreT.winRate)} WR  (n=${yrPreT.count})`,
    `YES+range post:  **${yrPostT.wins}W/${yrPostT.losses}L** — ${pct(yrPostT.winRate)} WR  (n=${yrPostT.count})${yrPostT.count < 5 ? ' ⚠️ low N (gated ≥20% edge now)' : ''}`,
  );

  if (postBias.count < 10) {
    aLines.push('', `*⏳ Post-correction window is very new — revisit after 2–3 weeks of data.*`);
  }

  // Shadow validation sections — YES+range and YES+above tracked separately
  const shadowSections = [
    {
      direction: 'range',
      label:     'YES+range',
      filter:    'σ<0.75°F + |bias|<2°F',
      target:    20,
    },
    {
      direction: 'above',
      label:     'YES+above',
      filter:    'σ<1.5°F + bias>-2°F',
      target:    20,
    },
  ];

  let anyShadow = false;
  for (const sec of shadowSections) {
    const secResolved = all.filter(t => t.shadow && t.parsed?.direction === sec.direction && (t.signalResult === 'win' || t.signalResult === 'loss'));
    const secOpen     = all.filter(t => t.shadow && t.parsed?.direction === sec.direction && t.outcome === null);
    if (secResolved.length === 0 && secOpen.length === 0) continue;
    anyShadow = true;
    const swins = secResolved.filter(t => t.signalResult === 'win').length;
    const sloss = secResolved.length - swins;
    const swr   = secResolved.length > 0 ? swins / secResolved.length : null;
    aLines.push(
      '',
      `### 🔬 Shadow ${sec.label} (${sec.filter})`,
      `Resolved: **${swins}W/${sloss}L**${swr != null ? ` — ${pct(swr)} WR` : ''}  (n=${secResolved.length})${secOpen.length > 0 ? `  |  Open: ${secOpen.length}` : ''}`,
      `*Not real trades — validation data. Deploy at ~${sec.target} resolved.*`,
    );
    if (secResolved.length < sec.target) {
      aLines.push(`*${sec.target - secResolved.length} more needed before filter activation.*`);
    }
  }
  if (!anyShadow) {
    // No shadow records yet — nothing to show
  }

  // Post-block era: signals fired after YES bets were blocked (2026-04-28)
  // Temporary section — remove after ~1 week of data accumulates
  const postBlock  = all.filter(t => !t.shadow && new Date(t.firedAt) >= YES_BLOCK_DATE);
  const pbResolved = postBlock.filter(t => t.signalResult === 'win' || t.signalResult === 'loss');
  const pbOpen     = postBlock.filter(t => t.outcome === null);
  const pbTrack    = calcTrack(pbResolved);

  aLines.push('', `### 📵 Post-Block Era (since 2026-04-28 — NO bets only)`);
  if (postBlock.length === 0) {
    aLines.push('*No signals fired yet since YES bets were blocked.*');
  } else {
    aLines.push(
      `Signals fired: **${postBlock.length}** (${pbResolved.length} resolved, ${pbOpen.length} open)`,
      `Win / Loss:    **${pbTrack.wins}W / ${pbTrack.losses}L**${pbTrack.winRate != null ? ` — **${pct(pbTrack.winRate)} WR**` : ''}`,
      `Paper P&L:     **${usd(pbTrack.totalPnl)}**`,
    );
    const comboLines = [];
    for (const side of ['no', 'yes']) {
      for (const dir of ['above', 'below', 'range']) {
        const g = pbResolved.filter(t => t.side === side && t.parsed?.direction === dir);
        if (g.length === 0) continue;
        const tk   = calcTrack(g);
        const icon = tk.winRate != null && tk.winRate >= 0.55 ? '✅' : (tk.winRate != null && tk.winRate >= 0.45 ? '⚠️' : '❌');
        comboLines.push(`  ${icon} **${side.toUpperCase()}+${dir.padEnd(6)}** ${tk.wins}W/${tk.losses}L — ${pct(tk.winRate)} WR  (n=${tk.count})`);
      }
    }
    if (comboLines.length > 0) {
      aLines.push('', '**By type:**');
      aLines.push(...comboLines);
    }
    if (pbResolved.length < 10) {
      aLines.push(`*⏳ Low sample (n=${pbResolved.length}) — check back in a few days.*`);
    }
  }

  const bodyA  = aLines.join('\n');
  const footerA = `Ace/Weathermen • ${RECENT_DAYS}-day analysis • ${todayDate}`;

  // ── Section B: AI Filter Effectiveness ──────────────────────────────────

  const bLines = [
    `## 🤖 AI FILTER EFFECTIVENESS`,
    `*(trades after 2026-04-23 — Stage 1 Haiku live)*`,
    `Resolved with AI: **${withAI.length}** of ${resolved.length} total`,
    '',
  ];

  if (withAI.length === 0) {
    bLines.push('*No resolved AI-filtered trades yet.*');
  } else {
    // Decision distribution (all AI-tagged trades, not just resolved)
    const allAI    = all.filter(t => t.aiDecision != null && t.outcome !== 'superseded');
    const aiTake   = allAI.filter(t => t.aiDecision === 'take').length;
    const aiReduce = allAI.filter(t => t.aiDecision === 'reduce').length;
    const aiSkip   = allAI.filter(t => t.aiDecision === 'skip').length;
    const aiTotal  = allAI.length;

    bLines.push(
      `**Decision distribution** (n=${aiTotal} AI-tagged signals):`,
      `  Take:   **${aiTake}** (${pct(aiTotal ? aiTake / aiTotal : null)})`,
      `  Reduce: **${aiReduce}** (${pct(aiTotal ? aiReduce / aiTotal : null)})`,
      `  Skip:   **${aiSkip}** (${pct(aiTotal ? aiSkip / aiTotal : null)})`,
      '',
    );

    // Confidence calibration (resolved only)
    const confBuckets = [
      { label: '>0.85',    min: 0.85, max: 1.01 },
      { label: '0.70–0.85', min: 0.70, max: 0.85 },
      { label: '0.50–0.70', min: 0.50, max: 0.70 },
      { label: '<0.50',    min: 0,    max: 0.50 },
    ];

    bLines.push('**Confidence calibration** (resolved AI trades):');
    for (const bkt of confBuckets) {
      const grp = withAI.filter(t => {
        const c = t.aiConfidence ?? 0;
        return c >= bkt.min && c < bkt.max;
      });
      if (grp.length === 0) continue;
      const tk   = calcTrack(grp);
      const icon = tk.winRate != null && tk.winRate >= 0.55 ? '✅' : (tk.winRate != null && tk.winRate >= 0.45 ? '⚠️' : '❌');
      bLines.push(`  ${icon} **${bkt.label}**: ${tk.wins}W/${tk.losses}L — ${pct(tk.winRate)} WR  (n=${grp.length})`);
    }

    // Size multiplier impact
    const fullSize = withAI.filter(t => (t.aiSizeMultiplier ?? 1.0) >= 1.0);
    const reduced  = withAI.filter(t => (t.aiSizeMultiplier ?? 1.0) <  1.0);
    const fsTrack  = calcTrack(fullSize);
    const rdTrack  = calcTrack(reduced);

    bLines.push(
      '',
      '**Size multiplier:**',
      `  Full size (×1.0):   ${fsTrack.wins}W/${fsTrack.losses}L — **${pct(fsTrack.winRate)} WR**  (n=${fsTrack.count})`,
      `  Reduced (<×1.0):    ${rdTrack.wins}W/${rdTrack.losses}L — **${pct(rdTrack.winRate)} WR**  (n=${rdTrack.count})`,
    );

    // Flag analysis — min 3 samples
    const flagStats = {};
    for (const t of withAI) {
      for (const flag of (t.aiFlags || [])) {
        if (!flagStats[flag]) flagStats[flag] = { wins: 0, losses: 0 };
        t.signalResult === 'win' ? flagStats[flag].wins++ : flagStats[flag].losses++;
      }
    }

    const flagEntries = Object.entries(flagStats)
      .map(([flag, s]) => ({ flag, ...s, total: s.wins + s.losses, wr: s.wins / (s.wins + s.losses) }))
      .filter(f => f.total >= 3)
      .sort((a, b) => b.wr - a.wr);

    if (flagEntries.length > 0) {
      bLines.push('', '**AI flag performance** (min 3 samples, sorted by WR):');
      for (const f of flagEntries.slice(0, 8)) {
        const icon = f.wr >= 0.60 ? '✅' : (f.wr >= 0.45 ? '⚠️' : '❌');
        const name = f.flag.replace(/_/g, ' ').padEnd(22);
        bLines.push(`  ${icon} ${name} ${f.wins}W/${f.losses}L — ${pct(f.wr)} WR`);
      }
    }
  }

  const bodyB  = bLines.join('\n');
  const footerB = `Ace/Weathermen • AI calibration • ${todayDate}`;

  // ── Section C: Direction & Side ──────────────────────────────────────────

  const cLines = [
    `## 🧭 DIRECTION & SIDE BREAKDOWN`,
    `*(all ${resolved.length} resolved trades)*`,
    '',
  ];

  // By direction
  const dirs = ['above', 'below', 'range'];
  cLines.push('**By direction:**');
  for (const dir of dirs) {
    const grp = resolved.filter(t => t.parsed?.direction === dir);
    if (grp.length === 0) continue;
    const tk   = calcTrack(grp);
    const icon = tk.winRate != null && tk.winRate >= 0.55 ? '✅' : (tk.winRate != null && tk.winRate >= 0.45 ? '⚠️' : '❌');
    cLines.push(`  ${icon} **${dir.padEnd(7)}** ${tk.wins}W/${tk.losses}L — ${pct(tk.winRate)} WR  avg edge ${tk.avgEdge?.toFixed(1) ?? '?'}%  (n=${tk.count})`);
  }

  // By side
  cLines.push('', '**By side:**');
  for (const side of ['no', 'yes']) {
    const grp  = resolved.filter(t => t.side === side);
    const tk   = calcTrack(grp);
    const icon = tk.winRate != null && tk.winRate >= 0.55 ? '✅' : (tk.winRate != null && tk.winRate >= 0.45 ? '⚠️' : '❌');
    cLines.push(`  ${icon} **${side.toUpperCase().padEnd(4)}** ${tk.wins}W/${tk.losses}L — ${pct(tk.winRate)} WR  ${usd(tk.totalPnl)}  (n=${tk.count})`);
  }

  // Key combos: side × direction
  const combos = [
    { side: 'no',  dir: 'above' },
    { side: 'no',  dir: 'below' },
    { side: 'yes', dir: 'below' },
    { side: 'yes', dir: 'above' },
    { side: 'yes', dir: 'range' },
    { side: 'no',  dir: 'range' },
  ];

  cLines.push('', '**Key combos:**');
  for (const { side, dir } of combos) {
    const grp = resolved.filter(t => t.side === side && t.parsed?.direction === dir);
    if (grp.length === 0) continue;
    const tk   = calcTrack(grp);
    const icon = tk.winRate != null && tk.winRate >= 0.60 ? '✅' : (tk.winRate != null && tk.winRate >= 0.45 ? '⚠️' : '❌');
    const note = (side === 'yes' && dir === 'range') ? ' ← gated ≥20% edge' : '';
    cLines.push(`  ${icon} **${side.toUpperCase()}+${dir.padEnd(6)}** ${tk.wins}W/${tk.losses}L — ${pct(tk.winRate)} WR${note}  (n=${tk.count})`);
  }

  // By temp type (high vs low)
  cLines.push('', '**By temp type:**');
  for (const type of ['high', 'low']) {
    const grp = resolved.filter(t => t.parsed?.type === type);
    if (grp.length === 0) continue;
    const tk  = calcTrack(grp);
    cLines.push(`  **${type.padEnd(4)}** ${tk.wins}W/${tk.losses}L — ${pct(tk.winRate)} WR  (n=${tk.count})`);
  }

  // Bottom 5 cities by win rate (min 5 trades)
  const cityMap = {};
  for (const t of resolved) {
    const city = t.parsed?.city || 'unknown';
    if (!cityMap[city]) cityMap[city] = { wins: 0, losses: 0, pnl: 0 };
    t.signalResult === 'win' ? cityMap[city].wins++ : cityMap[city].losses++;
    cityMap[city].pnl += t.pnlDollars ?? 0;
  }
  const cityEntries = Object.entries(cityMap)
    .map(([city, s]) => ({ city, ...s, total: s.wins + s.losses, wr: s.wins / (s.wins + s.losses) }))
    .filter(c => c.total >= 5)
    .sort((a, b) => a.wr - b.wr);

  if (cityEntries.length > 0) {
    cLines.push('', '**Worst cities (min 5 trades):**');
    for (const c of cityEntries.slice(0, 5)) {
      const icon = c.wr >= 0.50 ? '⚠️' : '❌';
      cLines.push(`  ${icon} ${shortCity(c.city).padEnd(16)} ${c.wins}W/${c.losses}L — ${pct(c.wr)} WR  ${usd(c.pnl)}`);
    }
  }

  const bodyC  = cLines.join('\n');
  const footerC = `Ace/Weathermen • ${resolved.length} resolved trades • ${todayDate}`;

  // ── Section D: Full City Leaderboard ─────────────────────────────────────

  const allCityMap = {};
  for (const t of resolved) {
    const city = t.parsed?.city;
    if (!city) continue;
    if (!allCityMap[city]) allCityMap[city] = { wins: 0, losses: 0, pnl: 0 };
    t.signalResult === 'win' ? allCityMap[city].wins++ : allCityMap[city].losses++;
    allCityMap[city].pnl += t.pnlDollars ?? 0;
  }

  const cityRows = Object.entries(allCityMap)
    .map(([city, s]) => {
      const n      = s.wins + s.losses;
      const wr     = n ? s.wins / n : 0;
      const status = CITY_BLOCKED.has(city) ? 'BLOCKED' : CITY_PAPER.has(city) ? 'PAPER' : 'ACTIVE';
      return { city, wins: s.wins, losses: s.losses, n, wr, pnl: s.pnl, status };
    })
    .sort((a, b) => a.wr - b.wr || b.n - a.n); // WR ascending; break ties by sample size desc

  const noRange   = resolved.filter(t => t.side === 'no' && t.parsed?.direction === 'range');
  const sysAvgWR  = noRange.length ? noRange.filter(t => t.signalResult === 'win').length / noRange.length : null;

  function cityIcon(row) {
    if (row.n < 5)       return '🔬'; // too small to call
    if (row.wr < 0.40)   return '❌';
    if (row.wr < 0.60)   return '⚠️';
    if (row.wr < 0.75)   return '👀';
    return '✅';
  }

  const dLines = [
    `## 🏙️ CITY LEADERBOARD — ALL-TIME`,
    `*(${resolved.length} resolved non-shadow trades · sys avg ${sysAvgWR != null ? pct(sysAvgWR) : '?'} WR on NO+range)*`,
    '',
  ];

  for (const row of cityRows) {
    const icon   = cityIcon(row);
    const label  = shortCity(row.city).padEnd(15);
    const wl     = `${row.wins}W/${row.losses}L`.padEnd(9);
    const wrStr  = (row.wr * 100).toFixed(1).padStart(5) + '%';
    const pnlStr = (row.pnl >= 0 ? '+$' : '-$') + Math.abs(row.pnl).toFixed(0);
    const tag    = row.status === 'BLOCKED' ? '  [BLOCKED]' : row.status === 'PAPER' ? '  [PAPER]' : '';
    dLines.push(`${icon} ${label} ${wl} ${wrStr}  ${pnlStr}${tag}`);
  }

  // Auto-flag ACTIVE cities only
  const blockCandidates = cityRows.filter(r => r.status === 'ACTIVE' && r.n >= 10 && r.wr <  0.50);
  const paperCandidates = cityRows.filter(r => r.status === 'ACTIVE' && r.n >= 15 && r.wr >= 0.50 && r.wr < 0.60);
  const watchCandidates = cityRows.filter(r => r.status === 'ACTIVE' && r.n >= 20 && r.wr >= 0.60 && r.wr < 0.75);

  dLines.push('');
  dLines.push('**─── Recommendations ───**');

  if (blockCandidates.length > 0) {
    dLines.push('🚨 **Block candidates** (n≥10, WR<50%):');
    for (const r of blockCandidates)
      dLines.push(`  • ${r.city} — ${pct(r.wr)} WR (${r.n} trades, ${usd(r.pnl)} P&L)`);
  }
  if (paperCandidates.length > 0) {
    dLines.push('⚠️ **Paper-only candidates** (n≥15, WR 50–60%):');
    for (const r of paperCandidates)
      dLines.push(`  • ${r.city} — ${pct(r.wr)} WR (${r.n} trades, ${usd(r.pnl)} P&L)`);
  }
  if (watchCandidates.length > 0) {
    dLines.push('👀 **Watch list** (n≥20, WR 60–75%):');
    for (const r of watchCandidates)
      dLines.push(`  • ${r.city} — ${pct(r.wr)} WR (${r.n} trades, ${usd(r.pnl)} P&L)`);
  }
  if (blockCandidates.length === 0 && paperCandidates.length === 0 && watchCandidates.length === 0) {
    dLines.push('✅ *No new candidates to flag — city roster looks clean.*');
  }

  const bodyD  = dLines.join('\n');
  const footerD = `Ace/Weathermen • city leaderboard • ${todayDate}`;

  // ── Post to Discord ───────────────────────────────────────────────────────

  if (BACKTEST_HOOK) {
    await postWebhook(BACKTEST_HOOK, 'info',     bodyA, footerA);
    await postWebhook(BACKTEST_HOOK, 'info',     bodyB, footerB);
    await postWebhook(BACKTEST_HOOK, 'catalyst', bodyC, footerC);
    await postWebhook(BACKTEST_HOOK, 'catalyst', bodyD, footerD);
    log('Analysis posted (4 embeds)');
  } else {
    log('WEATHER_DISCORD_BACKTEST_WEBHOOK not set — printing to stdout');
    console.log('\n' + [bodyA, bodyB, bodyC, bodyD].join('\n\n---\n\n') + '\n');
  }
}

main().catch(err => {
  console.error('[analyze-perf] Fatal:', err);
  process.exit(1);
});
