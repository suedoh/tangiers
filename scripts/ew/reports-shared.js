'use strict';

/**
 * scripts/ew/reports-shared.js — common helpers for daily/weekly/monthly reports
 */

const fs   = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, 'template');

/** Load a .tmpl file and substitute {{slot}} tokens. Unmatched slots become "—". */
function renderTemplate(name, slots) {
  const tmplPath = path.join(TEMPLATE_DIR, name);
  let text = fs.readFileSync(tmplPath, 'utf8');
  text = text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = slots[k];
    if (v == null || v === '') return '—';
    return String(v);
  });
  return text;
}

/** Format a price with $ + commas. */
function fmtPrice(p) {
  if (p == null || isNaN(p)) return 'n/a';
  return '$' + Number(p).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Detect direction from a count's direction string. */
function isUp(directionStr) { return /^up/i.test(directionStr || ''); }

/** Build a bias line like "aligned BULLISH across 1D + 4H + 1H." */
function biasLine(forecast) {
  if (!forecast || forecast.ambiguous) return 'AMBIGUOUS — no clear directional read across timeframes.';
  const flag = forecast.confluenceFlag;
  if (flag === 'aligned-bullish') return 'aligned **BULLISH** across 1D + 4H + 1H.';
  if (flag === 'aligned-bearish') return 'aligned **BEARISH** across 1D + 4H + 1H.';
  return 'mixed across timeframes — selective opportunities only.';
}

/** Compose a per-TF count block (multi-line). */
function countBlock(tf) {
  if (!tf || tf.ambiguous || !tf.primary) return '_no actionable count this run._';
  const p = tf.primary;
  const conf = p.confidence != null ? p.confidence.toFixed(2) : '—';
  const stab = tf.stability ? ` (${tf.stability})` : '';
  const lines = [
    `Wave **${p.currentWave || '?'}** ${p.direction || ''} — confidence ${conf}${stab}`,
  ];
  if (p.invalidations) {
    const inv = p.invalidations;
    const parts = [];
    if (inv.hard       != null) parts.push(`hard ${fmtPrice(inv.hard)}`);
    if (inv.soft       != null) parts.push(`soft ${fmtPrice(inv.soft)}`);
    if (inv.truncation != null) parts.push(`trunc ${fmtPrice(inv.truncation)}`);
    if (parts.length) lines.push(`Invalidation: ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

/** Aggregate all key levels across timeframes for a "KEY LEVELS" block. */
function keyLevelsBlock(forecast) {
  const out = [];
  for (const tf of ['1D', '4H', '1H']) {
    const t = forecast.timeframes?.[tf];
    if (!t || !t.primary || !t.primary.invalidations) continue;
    const inv = t.primary.invalidations;
    if (inv.hard != null) out.push(`• ${tf} hard invalidation ${fmtPrice(inv.hard)} — count dies if breached`);
    if (inv.soft != null) out.push(`• ${tf} soft invalidation ${fmtPrice(inv.soft)} — primary→alternate flip`);
    if (inv.truncation != null) out.push(`• ${tf} truncation ${fmtPrice(inv.truncation)} — wave 5 reversal warning`);
  }
  return out.length ? out.join('\n') : '—';
}

/** Aggregate upside or downside targets from primary counts. */
function targetsBlock(forecast, side /* 'up' | 'down' */) {
  const out = [];
  for (const tf of ['1D', '4H', '1H']) {
    const t = forecast.timeframes?.[tf];
    if (!t || !t.primary || !t.primary.targets) continue;
    const dir = isUp(t.primary.direction) ? 'up' : 'down';
    if (dir !== side) continue;
    for (const [k, v] of Object.entries(t.primary.targets)) {
      out.push(`• ${tf} ${k} → ${fmtPrice(v)}`);
    }
  }
  return out.length ? out.join('\n') : '—';
}

/** Compute the diff vs a previous forecast (used for "what changed overnight"). */
function whatChangedBlock(currentForecast, previousForecast) {
  if (!previousForecast) return 'first brief — no prior to compare.';

  const lines = [];
  for (const tf of ['1D', '4H', '1H']) {
    const cur  = currentForecast.timeframes?.[tf]?.primary;
    const prev = previousForecast.timeframes?.[tf]?.primary;
    if (!cur || !prev) continue;
    if (cur.direction !== prev.direction) {
      lines.push(`• ${tf}: direction flipped (${prev.direction} → ${cur.direction})`);
    } else if (cur.currentWave !== prev.currentWave) {
      lines.push(`• ${tf}: wave position changed (${prev.currentWave} → ${cur.currentWave})`);
    } else if (Math.abs((cur.confidence || 0) - (prev.confidence || 0)) > 0.15) {
      lines.push(`• ${tf}: confidence ${(prev.confidence || 0).toFixed(2)} → ${(cur.confidence || 0).toFixed(2)}`);
    }
  }
  if (lines.length === 0) return 'no material count changes since prior brief — structure stable.';
  return lines.join('\n');
}

/** Day-outlook heuristic from the forecast's confluence flag + 4H setup. */
function outlookBlock(forecast) {
  if (!forecast || forecast.ambiguous) {
    return 'No actionable bias this cycle. Wait for the next 4H bar close to clarify structure.';
  }
  const flag = forecast.confluenceFlag;
  const tf4h = forecast.timeframes?.['4H']?.primary;
  if (!tf4h) return 'Awaiting 4H structure read.';
  const tgt1 = tf4h.targets?.['1.0×W1'];
  const tgtBlowoff = tf4h.targets?.['1.618×W1'];
  const inv = tf4h.invalidations?.hard;
  const bias = flag === 'aligned-bullish' ? 'continuation higher' :
               flag === 'aligned-bearish' ? 'continuation lower' :
               'mixed — selective entries';

  const parts = [`Bias: ${bias}.`];
  if (tgt1)        parts.push(`Expect tactical move toward 4H 1.0×W1 ${fmtPrice(tgt1)}.`);
  if (tgtBlowoff)  parts.push(`Stretch target 1.618×W1 ${fmtPrice(tgtBlowoff)}.`);
  if (inv)         parts.push(`A break of 4H ${fmtPrice(inv)} invalidates the short-term thesis.`);
  return parts.join(' ');
}

module.exports = {
  TEMPLATE_DIR,
  renderTemplate,
  fmtPrice, isUp,
  biasLine, countBlock, keyLevelsBlock, targetsBlock,
  whatChangedBlock, outlookBlock,
};
