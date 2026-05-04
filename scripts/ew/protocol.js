'use strict';

/**
 * scripts/ew/protocol.js
 *
 * Pure analysis logic. Cycles 1D → 4H → 1H on the EW TradingView layout
 * via raw CDP, parses Pine indicator output, applies EW rule validation,
 * personality scoring, tiered invalidation, multi-degree synthesis,
 * stability comparison vs previous run, and confidence-floor check.
 *
 * Returns a forecast object matching the spec.md schema.
 *
 * Architecture conformance:
 *   - Uses scripts/lib/cdp.js (no MCP)
 *   - Acquires the project mutex (.tradingview-lock) via fs-based lock
 *     mirroring scripts/lib/lock.js (which we don't reuse to avoid coupling
 *     — but the pattern is identical)
 *   - Connects to the EW tab via cdpConnect('EW') (title match)
 *   - Never sets layout, never touches the Ace tab
 */

const path = require('path');
const fs   = require('fs');
const cdp  = require('../lib/cdp.js');
const storage = require('./storage.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SCREENSHOT_DIR = path.join(ROOT, 'tradingview-mcp', 'screenshots');
const LOCK_FILE = path.join(ROOT, '.tradingview-lock');
const LOCK_TTL_MS = 60_000;
const CONFIDENCE_FLOOR = 0.5;

// 4H bar close → slot label
const SLOT_BY_HOUR = {
  0:  'Asia',
  4:  'pre-London',
  8:  'London',
  12: 'NY-open',
  16: 'NY-mid',
  20: 'NY-close',
};

const TIMEFRAMES = [
  { tv: '1D',  label: '1D', degree: 'Intermediate', pivotMinForCount: 6 },
  { tv: '240', label: '4H', degree: 'Minor',        pivotMinForCount: 6 },
  { tv: '60',  label: '1H', degree: 'Minute',       pivotMinForCount: 6 },
];

// ─── Mutex (mirrors scripts/lib/lock.js semantics) ───────────────────────────

function acquireMutex(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, holder: 'ew', ts: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) fs.unlinkSync(LOCK_FILE);
      } catch {}
      sleepSync(500);
    }
  }
  throw new Error('Could not acquire .tradingview-lock — another script holds it');
}

function releaseMutex() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

// ─── Slot determination ──────────────────────────────────────────────────────

function determineSlot(date = new Date()) {
  const utcHour = date.getUTCHours();
  return SLOT_BY_HOUR[utcHour] || 'on-demand';
}

// ─── Pine label parser ───────────────────────────────────────────────────────
// Format emitted by elliott-wave.pine:
//   "EW-DATA|tf=<period>|atr=<atr14>|sym=<ticker>|pivots=p1,t1,y1;p2,t2,y2;..."

function parsePineDataLabel(text) {
  if (!text || !text.startsWith('EW-DATA')) return null;
  const out = { pivots: [] };
  const parts = text.split('|');
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (key === 'tf') out.tf = val;
    else if (key === 'atr') out.atr = Number(val);
    else if (key === 'sym') out.symbol = val;
    else if (key === 'pivots') {
      if (!val.trim()) { out.pivots = []; continue; }
      out.pivots = val.split(';').map(triple => {
        const [p, t, y] = triple.split(',');
        return { price: Number(p), time: Number(t), type: Number(y) };
      });
    }
  }
  return out;
}

// ─── EW rule validation (deterministic, in Node) ─────────────────────────────
// Given a sequence of N alternating-type pivots, attempt to label them as a
// 5-wave impulse and validate the canonical rules.
//
// Pivots are passed oldest-first. We assume the most recent 6 pivots represent
// the start (W0) plus the ends of W1, W2, W3, W4, W5 in that order.
// Direction is inferred from the first wave (up if W1 ends at a high).

function validateImpulse(pivots, direction) {
  if (!pivots || pivots.length < 6) {
    return { valid: false, reason: 'fewer than 6 pivots' };
  }
  // Take last 6
  const p = pivots.slice(-6);
  const [p0, p1, p2, p3, p4, p5] = p;

  // Direction-adjusted helpers
  const hi = direction === 'up' ? Math.max : Math.min;
  const lo = direction === 'up' ? Math.min : Math.max;
  const goesUp = direction === 'up';

  // Wave magnitudes (signed in trade direction)
  const W1 = goesUp ? p1.price - p0.price : p0.price - p1.price;
  const W2 = goesUp ? p1.price - p2.price : p2.price - p1.price;  // retrace
  const W3 = goesUp ? p3.price - p2.price : p2.price - p3.price;
  const W4 = goesUp ? p3.price - p4.price : p4.price - p3.price;  // retrace
  const W5 = goesUp ? p5.price - p4.price : p4.price - p5.price;

  if (W1 <= 0 || W3 <= 0 || W5 <= 0) {
    return { valid: false, reason: 'impulse waves must move in trade direction' };
  }
  if (W2 <= 0 || W4 <= 0) {
    return { valid: false, reason: 'corrective waves must retrace' };
  }

  const issues = [];
  let confidence = 0.5;

  // Rule: W2 retrace ∈ [.382, .786] of W1 (allow .236 as borderline)
  const w2Pct = W2 / W1;
  if (w2Pct < 0.236) issues.push(`W2 retrace ${(w2Pct*100).toFixed(0)}% below .236 (very shallow)`);
  if (w2Pct >= 1.0) return { valid: false, reason: 'W2 retraces ≥100% of W1 — invalid impulse' };
  if (w2Pct >= 0.382 && w2Pct <= 0.786) confidence += 0.10;
  else if (w2Pct < 0.382 || w2Pct > 0.786) issues.push(`W2 ${(w2Pct*100).toFixed(0)}% outside .382–.786`);

  // Rule: W3 not the shortest of {W1, W3, W5}
  if (W3 < W1 && W3 < W5) {
    return { valid: false, reason: 'W3 is the shortest of {1,3,5}' };
  }
  confidence += 0.10;

  // Rule: W4 doesn't overlap W1 territory
  // For an up-impulse: p4 (low of W4) > p1 (high of W1). For down: p4 (high) < p1 (low)
  const overlap = goesUp ? (p4.price <= p1.price) : (p4.price >= p1.price);
  if (overlap) return { valid: false, reason: 'W4 overlaps W1 territory' };
  confidence += 0.10;

  // Rule: W3 ≥ 1.618×W1 (canonical case) — soft preference, not invalidation
  if (W3 >= 1.618 * W1) confidence += 0.05;
  else if (W3 < W1) issues.push(`W3 (${W3.toFixed(2)}) shorter than W1 (${W1.toFixed(2)})`);

  // Rule: W4 ∈ [.236, .5] of W3
  const w4Pct = W4 / W3;
  if (w4Pct >= 0.236 && w4Pct <= 0.5) confidence += 0.05;
  else issues.push(`W4 ${(w4Pct*100).toFixed(0)}% outside .236–.5`);

  // Alternation: W2 sharp + W4 flat OR vice-versa (heuristic via retrace depth)
  const w2Sharp = w2Pct > 0.5;
  const w4Sharp = w4Pct > 0.382;
  if (w2Sharp !== w4Sharp) confidence += 0.05;
  else issues.push('W2/W4 lack alternation');

  // Borderline penalty
  if (Math.abs(w2Pct - 0.382) < 0.05 || Math.abs(w2Pct - 0.786) < 0.05) confidence -= 0.05;
  if (Math.abs(w4Pct - 0.5)   < 0.05 || Math.abs(w4Pct - 0.236) < 0.05) confidence -= 0.05;

  confidence = Math.max(0, Math.min(1, confidence));

  // Targets (Fib extensions of W1 from end of W2)
  const w1from = goesUp ? p2.price : p2.price;
  const targets = goesUp
    ? {
        '1.0×W1':   p2.price + 1.0   * W1,
        '1.618×W1': p2.price + 1.618 * W1,
        '2.618×W1': p2.price + 2.618 * W1,
      }
    : {
        '1.0×W1':   p2.price - 1.0   * W1,
        '1.618×W1': p2.price - 1.618 * W1,
        '2.618×W1': p2.price - 2.618 * W1,
      };

  // Tiered invalidation
  const invalidations = {
    hard:        p0.price,                        // start of impulse
    soft:        goesUp ? p2.price : p2.price,    // end of W2 — break here = soft flip
    truncation:  goesUp ? p3.price : p3.price,    // W3 high — W5 truncates if doesn't exceed
  };

  return {
    valid: true,
    confidence,
    issues,
    waves: { W1, W2, W3, W4, W5, w2Pct, w4Pct },
    pivots: { p0, p1, p2, p3, p4, p5 },
    invalidations,
    targets,
    direction,
  };
}

/**
 * Pick the best impulse interpretation given a pivot array. We try both
 * directions (up-impulse, down-impulse) and return the higher-confidence valid
 * count as primary, and the next-best as alternate.
 */
function pickCounts(pineData) {
  const pivots = pineData?.pivots || [];
  if (pivots.length < 6) {
    return {
      ambiguous: true,
      reason: `only ${pivots.length} pivots detected (need ≥6 for an impulse count)`,
    };
  }

  // Try both directions
  const upResult   = validateImpulse(pivots, 'up');
  const downResult = validateImpulse(pivots, 'down');

  const candidates = [];
  if (upResult.valid)   candidates.push({ ...upResult, label: 'impulse-up' });
  if (downResult.valid) candidates.push({ ...downResult, label: 'impulse-down' });

  if (candidates.length === 0) {
    return {
      ambiguous: true,
      reason: 'no valid impulse interpretation across both directions',
      issues: [upResult.reason, downResult.reason].filter(Boolean),
    };
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  const primary = candidates[0];
  const alternate = candidates[1] || buildCorrectiveAlternate(primary, pivots);

  return { ambiguous: false, primary, alternate };
}

/**
 * If only one impulse direction validates, build a corrective B-wave alternate
 * — the impulsive move is interpreted as a B-wave of an expanded flat. The
 * invalidation flips: the W3 high becomes the alternate's hard invalidation.
 */
function buildCorrectiveAlternate(primary, pivots) {
  const goesUp = primary.direction === 'up';
  return {
    valid: true,
    confidence: Math.max(0.2, primary.confidence - 0.4),
    issues: ['interpretation as B-wave of expanded flat — corrective, not impulsive'],
    waves: primary.waves,
    pivots: primary.pivots,
    direction: goesUp ? 'up (corrective)' : 'down (corrective)',
    label: goesUp ? 'b-wave-up' : 'b-wave-down',
    invalidations: {
      hard: primary.pivots.p3.price,    // primary's W3 — if exceeded, alt dies
      soft: primary.pivots.p2.price,
      truncation: null,
    },
    targets: goesUp
      ? { 'C-target': primary.pivots.p0.price - (primary.waves.W1 * 0.5) }
      : { 'C-target': primary.pivots.p0.price + (primary.waves.W1 * 0.5) },
  };
}

/**
 * Build the timeframe block for the forecast doc.
 */
function buildTfBlock(tfMeta, pineData, studyValues, previousTf) {
  const counts = pickCounts(pineData);

  if (counts.ambiguous) {
    return {
      degree: tfMeta.degree,
      ambiguous: true,
      reason: counts.reason,
      issues: counts.issues || [],
      primary: null, alternate: null,
      stability: 'new',
      previousForecastId: previousTf?._previousForecastId || null,
    };
  }

  const stability = computeStability(counts.primary, previousTf);

  // Personality is a stub in v1: we record the placeholder and let backtest
  // calibration drive future tuning. A future iteration validates W3 volume
  // peak + CVD divergence here using studyValues.
  const personality = {
    W1: 'unchecked', W2: 'unchecked', W3: 'unchecked', W4: 'unchecked',
  };

  const formatCount = (c) => ({
    count: c.label,
    currentWave: nameWave(tfMeta.degree, /* impulse complete = at W5 */ 5),
    direction: c.direction,
    invalidations: c.invalidations,
    targets: c.targets,
    confidence: round2(c.confidence),
    confidenceBreakdown: {
      rules: 0.40, personality: 0, multiDegree: 0, calibration: 0,
    },
    personality,
    notes: c.issues && c.issues.length ? c.issues.join('; ') : null,
  });

  return {
    degree: tfMeta.degree,
    primary:   formatCount(counts.primary),
    alternate: formatCount(counts.alternate),
    stability,
    previousForecastId: previousTf?._previousForecastId || null,
  };
}

function nameWave(degree, idx) {
  // Classical Elliott degree notation by position
  const minute = ['i', 'ii', 'iii', 'iv', 'v'];
  const minor  = ['(1)', '(2)', '(3)', '(4)', '(5)'];
  const intermed = ['(I)', '(II)', '(III)', '(IV)', '(V)'];
  const i = Math.max(0, Math.min(4, idx - 1));
  if (degree === 'Minute')       return minute[i];
  if (degree === 'Minor')        return minor[i];
  if (degree === 'Intermediate') return intermed[i];
  return String(idx);
}

function computeStability(primaryCount, previousTf) {
  if (!previousTf || !previousTf.primary) return 'new';
  if (previousTf.primary.count === primaryCount.label) {
    if (previousTf.primary.direction === primaryCount.direction) return 'stable';
    return 'flipped';
  }
  return 'refined';
}

function round2(x) { return Math.round(x * 100) / 100; }

// ─── Confluence flag ─────────────────────────────────────────────────────────

function computeConfluence(timeframes) {
  const dirs = [];
  for (const tf of ['1D', '4H', '1H']) {
    const t = timeframes[tf];
    if (t && t.primary && !t.ambiguous) {
      dirs.push(t.primary.direction.includes('up') ? 'up' : t.primary.direction.includes('down') ? 'down' : null);
    }
  }
  if (dirs.length === 0) return 'ambiguous';
  const allUp   = dirs.every(d => d === 'up');
  const allDown = dirs.every(d => d === 'down');
  if (allUp)   return 'aligned-bullish';
  if (allDown) return 'aligned-bearish';
  return 'mixed';
}

// ─── Main entry ──────────────────────────────────────────────────────────────

/**
 * Run a complete EW analysis pass. Acquires mutex, connects to EW tab,
 * cycles through 1D/4H/1H, captures screenshots, returns a populated
 * forecast object ready to persist + post.
 *
 * @param {Object} opts
 * @param {string} [opts.generatedBy] e.g. 'scheduled' or 'manual:!ew by @user'
 * @param {Date}   [opts.now]
 * @returns {Promise<Object>} forecast doc (status='open' or 'ambiguous')
 */
async function runProtocol(opts = {}) {
  const now  = opts.now || new Date();
  const slot = determineSlot(now);
  const ts   = now.toISOString();
  const id   = storage.newId();

  acquireMutex();
  let client;
  try {
    client = await cdp.cdpConnect('EW');

    // Resolve last forecast for stability comparison (per-TF prior count)
    const previousForecast = storage.getLatestForecast(f => f.symbol === 'BINANCE:BTCUSDT.P');
    const previousByTf = {};
    if (previousForecast && previousForecast.timeframes) {
      for (const tf of ['1D', '4H', '1H']) {
        if (previousForecast.timeframes[tf]) {
          previousByTf[tf] = {
            primary: previousForecast.timeframes[tf].primary,
            _previousForecastId: previousForecast._id,
          };
        }
      }
    }

    const timeframesOut = {};
    const screenshots   = {};
    const rawPineLabels = {};
    const studyValuesByTf = {};

    for (const tfMeta of TIMEFRAMES) {
      try {
        await cdp.setTimeframe(client, tfMeta.tv);
        await cdp.sleep(700);  // allow indicator to recompute

        // Read all visible labels; filter EW-DATA prefix
        const labels = await cdp.getPineLabels(client) || [];
        const dataLabel = labels.find(l => l.text && l.text.startsWith('EW-DATA'));
        rawPineLabels[tfMeta.label] = labels.filter(l => l.text && (l.text.startsWith('EW-PIV') || l.text.startsWith('EW-DATA')));

        let pineData = null;
        if (dataLabel) pineData = parsePineDataLabel(dataLabel.text);

        // Study values for personality scoring (v1 records but doesn't yet score)
        const sv = await cdp.getStudyValues(client).catch(() => ({}));
        studyValuesByTf[tfMeta.label] = sv;

        // Screenshot
        const shotName = `ew_${tfMeta.label}_${ts.replace(/[:.]/g, '-')}.png`;
        const shotPath = path.join(SCREENSHOT_DIR, shotName);
        try {
          await cdp.captureScreenshot(client, shotPath);
          screenshots[tfMeta.label] = shotPath;
        } catch (e) {
          console.error(`[ew/protocol] screenshot failed on ${tfMeta.label}: ${e.message}`);
        }

        // Build TF block
        timeframesOut[tfMeta.label] = buildTfBlock(tfMeta, pineData, sv, previousByTf[tfMeta.label]);
      } catch (e) {
        console.error(`[ew/protocol] ${tfMeta.label} pass failed: ${e.message}`);
        timeframesOut[tfMeta.label] = {
          degree: tfMeta.degree,
          ambiguous: true,
          reason: `read failed: ${e.message}`,
          primary: null, alternate: null,
          stability: 'new',
        };
      }
    }

    // Read the current price (last close from the 1H pass — we just left 1H)
    const quote = await cdp.getQuote(client).catch(() => null);
    const price = quote && quote.last ? Number(quote.last) : null;

    // Confluence
    const confluenceFlag = computeConfluence(timeframesOut);

    // Confidence floor — declare ambiguous if no count clears 0.5 anywhere
    let maxConfidence = 0;
    for (const tf of ['1D', '4H', '1H']) {
      const t = timeframesOut[tf];
      if (t && t.primary)   maxConfidence = Math.max(maxConfidence, t.primary.confidence || 0);
      if (t && t.alternate) maxConfidence = Math.max(maxConfidence, t.alternate.confidence || 0);
    }
    const ambiguous = maxConfidence < CONFIDENCE_FLOOR;

    const forecast = {
      _id: id,
      symbol: 'BINANCE:BTCUSDT.P',
      generatedAt: ts,
      generatedBy: opts.generatedBy || 'scheduled',
      scheduleSlot: slot,
      price,
      ambiguous,
      confluenceFlag: ambiguous ? 'ambiguous' : confluenceFlag,
      timeframes: timeframesOut,
      rawPineLabels,
      studyValuesAtGen: studyValuesByTf,
      chartScreenshots: screenshots,
      discordMessageId: null,
      status: ambiguous ? 'ambiguous' : 'open',
      outcomes: { '1D': {}, '4H': {}, '1H': {} },
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    return forecast;
  } finally {
    if (client && client.close) {
      try { await client.close(); } catch {}
    }
    releaseMutex();
  }
}

module.exports = {
  runProtocol,
  // Exposed for testing
  parsePineDataLabel, validateImpulse, pickCounts, computeConfluence,
  determineSlot, nameWave,
  CONFIDENCE_FLOOR,
};
