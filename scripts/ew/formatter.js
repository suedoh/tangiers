'use strict';

/**
 * scripts/ew/formatter.js
 *
 * Converts forecast objects (the schema in spec.md) into Discord embed
 * payloads. Two shapes:
 *
 *   formatActive(forecast)    — full report with primary + alternate per TF,
 *                                tiered invalidation, targets, personality,
 *                                stability tag, confluence flag.
 *   formatAmbiguous(forecast) — compact "no actionable count" post for
 *                                cases where confidence floor wasn't met.
 *
 * Returns { embeds: [...] } — to be combined with file attachments by
 * discord-upload.js.
 */

const COLORS = {
  bull:      0x57f287,   // green
  bear:      0xed4245,   // red
  mixed:     0xfee75c,   // yellow
  ambiguous: 0x99aab5,   // grey
};

function fmtPrice(p) {
  if (p == null || isNaN(p)) return 'n/a';
  return '$' + Number(p).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function pct(x) {
  return (x * 100).toFixed(1) + '%';
}

/** Build the slot label for the Source line. */
function slotLabel(forecast) {
  if (forecast.generatedBy && forecast.generatedBy.startsWith('manual:')) {
    return 'manual:' + forecast.generatedBy.slice('manual:'.length);
  }
  return 'scheduled (' + (forecast.scheduleSlot || 'on-demand') + ')';
}

function colorFor(forecast) {
  if (forecast.ambiguous) return COLORS.ambiguous;
  switch (forecast.confluenceFlag) {
    case 'aligned-bullish': return COLORS.bull;
    case 'aligned-bearish': return COLORS.bear;
    case 'mixed':           return COLORS.mixed;
    default:                return COLORS.ambiguous;
  }
}

// ─── Active forecast ─────────────────────────────────────────────────────────

/**
 * @param {Object} forecast — populated forecast object (status='open')
 * @param {Object} screenshots — { '1D': filename, '4H': filename, '1H': filename }
 * @returns {{embeds: Array}}
 */
function formatActive(forecast, screenshots = {}) {
  const ts = forecast.generatedAt || new Date().toISOString();
  const tsHuman = ts.replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');

  const header = [
    `🌊 ELLIOTT WAVE — ${forecast.symbol} | ${fmtPrice(forecast.price)} | ${tsHuman}`,
    `Source: ${slotLabel(forecast)} · Layout: EW · CDP read`,
    '',
    `Confluence: ${formatConfluence(forecast)}`,
    '',
  ].join('\n');

  const sections = [];
  for (const tf of ['1D', '4H', '1H']) {
    const t = forecast.timeframes && forecast.timeframes[tf];
    if (!t) continue;
    sections.push(formatTfBlock(tf, t, !!screenshots[tf]));
  }

  const description = header + sections.join('\n\n');
  const color = colorFor(forecast);

  // Primary embed (header + 4H screenshot if present, since 4H is the
  // tradable timeframe)
  const embeds = [{
    title:       'Wave count update',
    description,
    color,
    timestamp:   ts,
    footer:      { text: 'Ace EW · informational only · not financial advice' },
  }];
  if (screenshots['4H']) {
    embeds[0].image = { url: 'attachment://' + screenshots['4H'] };
  }

  // Secondary embeds — one per remaining screenshot, so all three render inline
  const extras = [];
  if (screenshots['1D']) extras.push({ title: '1D pane', color, image: { url: 'attachment://' + screenshots['1D'] } });
  if (screenshots['1H']) extras.push({ title: '1H pane', color, image: { url: 'attachment://' + screenshots['1H'] } });

  return { embeds: [embeds[0], ...extras] };
}

function formatConfluence(forecast) {
  const counts = [];
  for (const tf of ['1D', '4H', '1H']) {
    const t = forecast.timeframes && forecast.timeframes[tf];
    if (!t || !t.primary) continue;
    counts.push(`${tf} ${t.primary.currentWave || '?'}`);
  }
  const flag = forecast.confluenceFlag || 'mixed';
  const emoji = flag === 'aligned-bullish' ? '✅'
              : flag === 'aligned-bearish' ? '❌'
              : flag === 'ambiguous'       ? '⚠️'
              :                              '~';
  const word = flag === 'aligned-bullish' ? 'BULLISH'
             : flag === 'aligned-bearish' ? 'BEARISH'
             : flag === 'ambiguous'       ? 'unclear'
             :                              'mixed';
  if (counts.length === 0) return `${word} ${emoji}`;
  return `${counts.join(' + ')} — ${word.toLowerCase() === 'mixed' ? 'mixed' : 'aligned ' + word} ${emoji}`;
}

function formatTfBlock(tfLabel, tf, hasScreenshot) {
  const degree = tf.degree || '';
  const stability = tf.stability ? ` · ${tf.stability}` : '';
  const screenshotNote = hasScreenshot ? '   ⟶  [screenshot attached]' : '';

  const lines = [
    `${tfLabel} (${degree})${screenshotNote}`,
  ];
  if (tf.primary) {
    lines.push(formatCount('Primary  ', tf.primary, stability));
  }
  if (tf.alternate) {
    lines.push(formatCount('Alternate', tf.alternate, ''));
  }
  return lines.join('\n');
}

function formatCount(slotLabel, count, stability) {
  const dir = count.direction || '';
  const conf = count.confidence != null ? `confidence ${count.confidence.toFixed(2)}` : '';
  const lines = [
    `  ${slotLabel}: wave ${count.currentWave || '?'} ${dir} — ${conf}${stability}`,
  ];
  if (count.invalidations) {
    const inv = count.invalidations;
    const parts = [];
    if (inv.hard       != null) parts.push(`hard ${fmtPrice(inv.hard)}`);
    if (inv.soft       != null) parts.push(`soft ${fmtPrice(inv.soft)}`);
    if (inv.truncation != null) parts.push(`trunc ${fmtPrice(inv.truncation)}`);
    if (parts.length) lines.push(`    invalidation:  ${parts.join('  ·  ')}`);
  }
  if (count.targets && Object.keys(count.targets).length) {
    const targetParts = Object.entries(count.targets)
      .map(([k, v]) => `${k} ${fmtPrice(v)}`);
    lines.push(`    targets:       ${targetParts.join('  ·  ')}`);
  }
  if (count.personality && Object.keys(count.personality).length) {
    const pers = Object.entries(count.personality)
      .map(([w, s]) => `${w}:${s}`).join(' ');
    lines.push(`    personality:   ${pers}`);
  }
  if (count.notes) {
    lines.push(`    note: ${count.notes}`);
  }
  return lines.join('\n');
}

// ─── Ambiguous forecast ──────────────────────────────────────────────────────

function formatAmbiguous(forecast, screenshots = {}, reason) {
  const ts = forecast.generatedAt || new Date().toISOString();
  const tsHuman = ts.replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');

  // Find max confidence across all TFs for the reason line
  let maxConf = 0;
  for (const tf of ['1D', '4H', '1H']) {
    const t = forecast.timeframes && forecast.timeframes[tf];
    if (!t) continue;
    if (t.primary && t.primary.confidence > maxConf) maxConf = t.primary.confidence;
    if (t.alternate && t.alternate.confidence > maxConf) maxConf = t.alternate.confidence;
  }

  const description = [
    `🌊 ELLIOTT WAVE — ${forecast.symbol} | ${fmtPrice(forecast.price)} | ${tsHuman}`,
    `Source: ${slotLabel(forecast)} · Layout: EW · CDP read`,
    '',
    `⚠️ AMBIGUOUS STRUCTURE — no actionable count this cycle.`,
    '',
    reason || `Reason: max confidence across all TFs = ${maxConf.toFixed(2)} (below 0.50 floor).`,
    'Possible causes: ranging price action / overlapping pivots / unclear wave personality.',
    'Screenshots attached for visual inspection.',
  ].join('\n');

  const embeds = [{
    title: 'No actionable count',
    description,
    color: COLORS.ambiguous,
    timestamp: ts,
    footer: { text: 'Ace EW · informational only · ambiguous post' },
  }];
  if (screenshots['4H']) embeds[0].image = { url: 'attachment://' + screenshots['4H'] };
  if (screenshots['1D']) embeds.push({ title: '1D pane', color: COLORS.ambiguous, image: { url: 'attachment://' + screenshots['1D'] } });
  if (screenshots['1H']) embeds.push({ title: '1H pane', color: COLORS.ambiguous, image: { url: 'attachment://' + screenshots['1H'] } });

  return { embeds };
}

// ─── Backtest event (used by backtest.js) ────────────────────────────────────

/**
 * Format a backtest state-transition event (invalidation, target hit, flip).
 * @param {Object} forecast        original forecast doc
 * @param {Object} event           { tf, slot, type, level?, target?, hitAt, currentPrice, originalConfidence }
 * @returns {{embeds: Array}}
 */
function formatBacktestEvent(forecast, event) {
  const tsHuman = (event.hitAt || new Date().toISOString())
    .replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
  const genHuman = (forecast.generatedAt || '').replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');

  let title, color, lead;
  switch (event.type) {
    case 'invalidated_hard':
      title = `⚠️ INVALIDATED (hard) — ${event.tf} ${forecast.timeframes[event.tf][event.slot].currentWave}`;
      color = COLORS.bear;
      lead  = `Count is dead. Hard invalidation level reached.`;
      break;
    case 'invalidated_soft':
      title = `🔄 SOFT FLIP — ${event.tf} ${event.slot} count downgraded`;
      color = COLORS.mixed;
      lead  = `Soft invalidation hit. Primary count downgraded; alternate is now primary.`;
      break;
    case 'truncation_warning':
      title = `🚨 TRUNCATION WARNING — ${event.tf} ${forecast.timeframes[event.tf][event.slot].currentWave}`;
      color = COLORS.mixed;
      lead  = `Truncation level reached. Count survives but reversal warning is elevated.`;
      break;
    case 'target_hit':
      title = `🎯 TARGET HIT (${event.target}) — ${event.tf} ${forecast.timeframes[event.tf][event.slot].currentWave}`;
      color = COLORS.bull;
      lead  = `Target reached. Count progresses toward subsequent levels.`;
      break;
    default:
      title = `EW backtest event — ${event.type}`;
      color = COLORS.ambiguous;
      lead  = '';
  }

  const description = [
    lead,
    '',
    `Forecast generated: ${genHuman} at ${fmtPrice(forecast.price)} (slot: ${forecast.scheduleSlot || 'on-demand'})`,
    `Level: ${event.level != null ? fmtPrice(event.level) : '—'}   ·   Hit at: ${tsHuman}, ${fmtPrice(event.currentPrice)}`,
    `Time open: ${event.timeOpen || '—'}`,
    `Confidence at gen: ${event.originalConfidence != null ? event.originalConfidence.toFixed(2) : '—'} (${event.tf} ${event.slot})`,
  ].join('\n');

  const embeds = [{
    title, description, color,
    timestamp: event.hitAt || new Date().toISOString(),
    footer: { text: 'Ace EW backtest · forward-only verification' },
  }];

  return { embeds };
}

module.exports = {
  formatActive, formatAmbiguous, formatBacktestEvent,
  fmtPrice, slotLabel, colorFor,
};
