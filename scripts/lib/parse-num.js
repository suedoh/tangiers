'use strict';

/**
 * parseStudyNum — parse a TradingView data-window value string into a raw
 * number. Replaces the old inline `parseFloat_` in trigger-check.js, which
 * had two defects (2026-07-05 signal-brain audit):
 *
 *   1. It stripped `[^0-9.\-]`, which DROPS TradingView's Unicode minus
 *      (U+2212) — every negative CVD/OI reading parsed positive. Empirical
 *      proof: 7,841 CDP-path CVD reads since April contained zero negatives
 *      while the Binance fallback (same market) split 252/503 negative.
 *   2. It stripped K/M/B magnitude suffixes, so "1.92K" → 1.92 while "980"
 *      → 980 — deltas and thresholds compared incompatible scales.
 *
 * This parser normalizes U+2212 to '-', strips commas, and expands K/M/B
 * to raw magnitude. The suffix must not be followed by another letter, so
 * "106.84 BTC" parses as 106.84 (not 106.84 billion).
 */
function parseStudyNum(str) {
  if (str == null) return null;
  if (typeof str === 'number') return Number.isFinite(str) ? str : null;
  const s = String(str).replace(/−/g, '-').replace(/,/g, '');
  const m = s.match(/(-?\d*\.?\d+)\s*([KMB])?(?![A-Za-z])/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return n * mult;
}

module.exports = { parseStudyNum };
