#!/usr/bin/env node
'use strict';

/**
 * scripts/research/book-report.js — weekly order-book corpus report → Discord.
 *
 * `make book-status` answers "is it alive right now". This answers the question
 * that actually matters over a month: **is the corpus good enough to research
 * with when the 30-day threshold arrives?** A recorder can be online and still
 * be producing junk — degraded sample rates, missing minutes, a dead
 * sub-stream — and none of that is visible from a liveness check.
 *
 * Reports, per week:
 *   - coverage: minutes recorded vs minutes elapsed, and explicit gap rows
 *   - quality:  median book samples and touch ticks per minute, plus the share
 *               of minutes below a usable threshold
 *   - liqSeen:  the open question from day one. Until it moves off zero the
 *               forceOrder stream is unverified and the liq* columns are junk.
 *   - shape:    a few distribution stats, so a silently-broken field (all-null,
 *               all-zero, stuck constant) shows up as an anomaly rather than
 *               waiting to be discovered during analysis
 *   - countdown to the 30-day research threshold
 *
 * Cron (Docker ace-cron): Monday 08:00 UTC, ahead of the falsification gate.
 * Target channel: BOOK_STATUS_WEBHOOK, else BLOFIN_RECON_WEBHOOK (the ops
 * channel the recorder watchdog already posts to).
 *
 * Usage:
 *   node scripts/research/book-report.js            # post to Discord
 *   node scripts/research/book-report.js --dry-run  # print only
 *   node scripts/research/book-report.js --days 30  # window (default 7)
 */

const fs   = require('fs');
const path = require('path');
const { loadEnv, ROOT } = require('../lib/env');
const { postWebhook } = require('../lib/discord');

loadEnv();

const OUT_DIR   = path.join(ROOT, 'data', 'orderbook');
const STATE     = path.join(ROOT, '.book-recorder-state.json');
const DRY       = process.argv.includes('--dry-run');
// NB: indexOf returns -1 when the flag is absent, and argv[0] is the node
// binary — reading it unguarded made the window NaN and silently matched zero
// rows, which read exactly like a dead recorder. Guard the index, not the value.
const WINDOW_D  = (() => {
  const i = process.argv.indexOf('--days');
  const v = i > -1 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 7;
})();
const RESEARCH_THRESHOLD_D = 30;
const MIN_SAMPLES = 300;   // a healthy minute sees ~600 depth snapshots
const MIN_TICKS   = 200;   // and ~13,000 touch updates; 200 is generously low

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const pctl = (a, q) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function loadRows(sinceMs) {
  if (!fs.existsSync(OUT_DIR)) return [];
  const rows = [];
  for (const f of fs.readdirSync(OUT_DIR).filter(x => x.endsWith('.ndjson'))) {
    for (const line of fs.readFileSync(path.join(OUT_DIR, f), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r.t >= sinceMs) rows.push(r);
      } catch { /* a torn final line during an append is not a corpus problem */ }
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

function corpusTotals() {
  if (!fs.existsSync(OUT_DIR)) return { files: 0, rows: 0, bytes: 0, firstMs: null };
  const files = fs.readdirSync(OUT_DIR).filter(x => x.endsWith('.ndjson')).sort();
  let rows = 0, bytes = 0, firstMs = null;
  for (const f of files) {
    const p = path.join(OUT_DIR, f);
    bytes += fs.statSync(p).size;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    rows += lines.length;
    if (firstMs == null && lines.length) { try { firstMs = JSON.parse(lines[0]).t; } catch {} }
  }
  return { files: files.length, rows, bytes, firstMs };
}

function build() {
  const now = Date.now();
  const since = now - WINDOW_D * 86_400_000;
  const rows = loadRows(since);
  const totals = corpusTotals();

  let state = null;
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* handled below */ }

  if (!rows.length) {
    return {
      type: 'error',
      body: ['📕 **Order-book corpus — weekly report**', '',
        '**No rows in the reporting window.** The recorder is not producing data.',
        state ? `Last row: ${state.lastRowMinute} (${((now - state.lastRowAt) / 3600e3).toFixed(1)}h ago)`
              : 'No recorder state file — the process may never have started.',
        '', '`pm2 restart book-recorder` · `make book-logs`'].join('\n'),
    };
  }

  const live = rows.filter(r => !r.gap);
  const gaps = rows.length - live.length;
  const elapsedMin = Math.floor((Math.min(now, rows[rows.length - 1].t + 60_000) - rows[0].t) / 60_000);
  const coverage = elapsedMin > 0 ? live.length / elapsedMin : 0;

  const samples = live.map(r => r.samples ?? 0);
  const ticks   = live.map(r => r.ticks ?? 0);
  const thinS   = samples.filter(x => x < MIN_SAMPLES).length;
  const thinT   = ticks.filter(x => x < MIN_TICKS).length;

  const num = key => live.map(r => r[key]).filter(v => v != null && Number.isFinite(v));
  const obi20 = num('obi20'), spread = num('spread'), trades = num('trades');
  const tvol = num('tvol'), mark = num('mark'), funding = num('funding');

  // A field that is present but constant, or entirely absent, is broken in a
  // way liveness checks never catch. Flag it rather than discover it later.
  const anomalies = [];
  for (const [name, vals, expect] of [
    ['obi20', obi20, live.length], ['spread', spread, live.length],
    ['trades', trades, live.length], ['mark', mark, live.length],
    ['funding', funding, live.length],
  ]) {
    if (vals.length < expect * 0.9) anomalies.push(`\`${name}\` null in ${(100 * (1 - vals.length / expect)).toFixed(0)}% of rows`);
    else if (vals.length > 10 && new Set(vals).size === 1) anomalies.push(`\`${name}\` is a stuck constant (${vals[0]})`);
  }
  if (trades.length && median(trades) === 0) anomalies.push('`trades` median is 0 — trade stream may be dead');

  const totalDays = totals.firstMs ? (now - totals.firstMs) / 86_400_000 : 0;
  const remaining = Math.max(0, RESEARCH_THRESHOLD_D - totalDays);
  const liqSeen = state?.liqSeen ?? 0;

  const healthy = coverage >= 0.95 && thinS / live.length < 0.05 && !anomalies.length;

  const body = [
    '📘 **Order-book corpus — weekly report**',
    '',
    `**Coverage (last ${WINDOW_D}d)** — ${live.length} minutes recorded of ${elapsedMin} elapsed `
      + `(**${(100 * coverage).toFixed(1)}%**)${gaps ? `, ${gaps} gap row(s)` : ', no gaps'}`,
    `**Quality** — median ${median(samples)} book samples/min (p05 ${pctl(samples, 0.05)}), `
      + `${median(ticks)} touch ticks/min`,
    thinS || thinT
      ? `⚠️ ${thinS} minute(s) below ${MIN_SAMPLES} samples · ${thinT} below ${MIN_TICKS} ticks`
      : `✅ no degraded minutes`,
    '',
    `**Shape** — obi20 median ${median(obi20)?.toFixed(3)} `
      + `(p05 ${pctl(obi20, 0.05)?.toFixed(2)} / p95 ${pctl(obi20, 0.95)?.toFixed(2)}) · `
      + `spread median ${median(spread)?.toFixed(4)}bps · `
      + `${median(trades)} trades/min · ${median(tvol)?.toFixed(2)} BTC/min`,
    anomalies.length ? `🚨 **Anomalies:** ${anomalies.join(' · ')}` : '✅ no field anomalies',
    '',
    liqSeen > 0
      ? `✅ **liqSeen ${liqSeen}** — forceOrder stream verified; \`liq*\` columns are usable`
      : `⚠️ **liqSeen 0** — forceOrder still unverified. If this is still zero after a volatile `
        + `week, treat the \`liq*\` columns as dead and exclude them from research`,
    '',
    `**Corpus total** — ${totals.rows.toLocaleString()} rows across ${totals.files} day-file(s), `
      + `${(totals.bytes / 1e6).toFixed(1)} MB, ${totalDays.toFixed(1)} days`,
    remaining > 0
      ? `⏳ **${remaining.toFixed(1)} days** until the 30-day research threshold`
      : `🎯 **Threshold reached** — the corpus is ready to join to barrier labels and run through `
        + `\`scripts/research/\`. Every cell tested counts toward the cumulative BH-FDR family in `
        + `rebuild/research-log.md`,
  ].join('\n');

  return { type: healthy ? 'info' : 'approaching', body };
}

(async () => {
  const { type, body } = build();
  if (DRY) { console.log(body); return; }
  const hook = process.env.BOOK_STATUS_WEBHOOK || process.env.BLOFIN_RECON_WEBHOOK;
  if (!hook) {
    console.error('[book-report] no webhook configured (BOOK_STATUS_WEBHOOK / BLOFIN_RECON_WEBHOOK)');
    process.exit(1);
  }
  const id = await postWebhook(hook, type, body,
    `Order-book recorder · ${new Date().toUTCString().slice(5, 22)} UTC`);
  console.log(id ? `[book-report] posted id=${id}` : '[book-report] post failed');
  process.exit(id ? 0 : 1);
})().catch(e => { console.error('[book-report] failed:', e.message); process.exit(1); });
