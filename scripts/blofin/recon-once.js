#!/usr/bin/env node
'use strict';

/**
 * Single-pass reconciliation between local Mongo state and BloFin's
 * exchange truth. Posts a Discord summary when something material
 * happened (fills, cancellations, retroactive discoveries, errors);
 * silent on no-op heartbeats so the channel stays signal-rich.
 *
 * Usage:  make blofin-recon-once
 *    or:  node scripts/blofin/recon-once.js [BTC-USDT]
 *
 * Env (all optional — if BLOFIN_RECON_WEBHOOK unset, no Discord post):
 *   BLOFIN_RECON_WEBHOOK — Discord webhook URL for recon summaries
 */

const { loadEnv } = require('../lib/env');
loadEnv();

const blofin   = require('../lib/blofin');
const store    = require('../lib/blofin-store');
const db       = require('../lib/db');
const discord  = require('../lib/discord');

function fmtFill(f) {
  const side  = (f.side || '').padEnd(4);
  const price = Number(f.fillPrice).toFixed(1);
  const sig   = f.signalId ? ` · signal=${f.signalId}` : '';
  return `• \`${f.orderId}\`  ${f.instId}  ${side}  @ ${price}  size=${f.fillSize}${sig}`;
}

function buildSummary(report) {
  const lines = [];
  lines.push(`**Matched (live):** ${report.matched}`);

  if (report.filled?.length) {
    lines.push('', `**Filled:** ${report.filled.length}`);
    report.filled.slice(0, 10).forEach(f => lines.push(fmtFill(f)));
    if (report.filled.length > 10) lines.push(`…and ${report.filled.length - 10} more`);
  }

  if (report.cancelled?.length) {
    lines.push('', `**Cancelled:** ${report.cancelled.length}`);
    report.cancelled.slice(0, 5).forEach(id => lines.push(`• \`${id}\``));
    if (report.cancelled.length > 5) lines.push(`…and ${report.cancelled.length - 5} more`);
  }

  if (report.retroactive?.length) {
    lines.push('', `**Retroactive (UI-placed or race):** ${report.retroactive.length}`);
    report.retroactive.slice(0, 5).forEach(id => lines.push(`• \`${id}\``));
  }

  if (report.disappeared?.length) {
    // Disappeared THIS pass but resolveDisappeared couldn't classify (e.g.
    // fills API errored). These will get retried next cycle.
    const unresolved = report.disappeared.length - (report.filled?.length || 0) - (report.cancelled?.length || 0);
    if (unresolved > 0) lines.push('', `**Disappeared, unresolved (retry next cycle):** ${unresolved}`);
  }

  if (report.unprotectedPositions?.length) {
    lines.push('', `🚨 **UNPROTECTED POSITIONS — NO ACTIVE SL** 🚨`);
    report.unprotectedPositions.forEach(p => lines.push(fmtUnprotected(p)));
    lines.push('**Action:** flip BLOFIN_AUTOTRADE=false and set SL via UI immediately.');
  }

  if (report.resolveErrors?.length || report.errors?.length) {
    const errs = [...(report.resolveErrors || []), ...(report.errors || [])];
    lines.push('', `**Errors:** ${errs.length}`);
    errs.slice(0, 5).forEach(e => lines.push(`• \`${e.orderId}\`: ${e.error}`));
  }

  return lines.join('\n');
}

function isMaterial(report) {
  return (report.filled?.length || 0) > 0
      || (report.cancelled?.length || 0) > 0
      || (report.retroactive?.length || 0) > 0
      || (report.resolveErrors?.length || 0) > 0
      || (report.errors?.length || 0) > 0
      || (report.unprotectedPositions?.length || 0) > 0;
}

function fmtUnprotected(p) {
  return `• ${p.instId}  ${p.side.toUpperCase()}  size=${p.size}  avgPx=${Number(p.avgPrice).toFixed(2)}`;
}

async function main() {
  const instId = process.argv[2] || undefined;

  console.log('─── BloFin reconciliation ───');
  console.log('env:    ', blofin.isDemo() ? 'demo' : 'PROD');
  console.log('instId: ', instId || '(all)');
  console.log('');

  const report = await store.reconcileOnce({ instId });

  console.log(`matched (still live):    ${report.matched}`);
  console.log(`disappeared (this pass): ${report.disappeared.length}`);
  console.log(`resolved → filled:       ${report.resolvedFilled}`);
  console.log(`resolved → cancelled:    ${report.resolvedCancelled}`);
  console.log(`retroactive (new local): ${report.retroactive.length}`);
  if (report.resolveErrors?.length) {
    console.log(`resolve errors: ${report.resolveErrors.length}`);
    report.resolveErrors.forEach(e => console.log('  ', e.orderId, '→', e.error));
  }
  if (report.errors.length) {
    console.log(`reconcile errors: ${report.errors.length}`);
    report.errors.forEach(e => console.log('  ', e.orderId, '→', e.error));
  }

  // Post a Discord summary only when something happened.
  const webhook = process.env.BLOFIN_RECON_WEBHOOK;
  if (webhook && isMaterial(report)) {
    const isUnprotected = (report.unprotectedPositions?.length || 0) > 0;
    const hasErrors     = (report.resolveErrors?.length || 0) + (report.errors?.length || 0) > 0;
    // Unprotected positions are the loudest alert — error type, takes priority.
    const type    = (isUnprotected || hasErrors) ? 'error' : 'info';
    const summary = buildSummary(report);
    const footer  = `BloFin recon · ${blofin.isDemo() ? 'demo' : 'PROD'} · ${new Date().toUTCString().slice(5, 25)} UTC`;
    await discord.postWebhook(webhook, type, summary, footer);
  }

  console.log('');
  console.log('─── Done. ───');
  await db.disconnect();
}

main().catch(async e => {
  console.error('unexpected:', e);
  try { await db.disconnect(); } catch (_) {}
  process.exit(1);
});
