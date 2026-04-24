'use strict';

/**
 * lib/weather-analysis.js — Claude AI signal quality filter for weather markets
 *
 * Sits on top of the quantitative edge calculation. After the model finds an
 * edge ≥ MIN_EDGE, this module sends the full forecast bundle to Claude Haiku
 * and receives a structured quality assessment:
 *
 *   decision:        'take' | 'reduce' | 'skip'
 *   confidence:      0.0–1.0 (AI's confidence in the decision)
 *   sizeMultiplier:  1.0 | 0.75 | 0.5 | 0.25 (applied to Kelly bet dollars)
 *   reasoning:       one-sentence explanation (shown on signal card)
 *   flags:           string[] — qualitative tags e.g. ['high_conviction', 'wide_uncertainty']
 *
 * Decision semantics:
 *   take   — edge is real and setup is high quality; fire at full Kelly × sizeMultiplier
 *   reduce — edge exists but setup has structural weakness; fire at reduced size
 *   skip   — suppress Discord signal (quant edge is noise or setup is fundamentally broken)
 *
 * Falls back to { decision: 'take', sizeMultiplier: 1.0, ... } if API unavailable,
 * so a missing key never silences a signal.
 *
 * Model: claude-haiku-4-5-20251001 — same as BZ! sentiment. ~$0.001 per call.
 * Only called when a signal already passes the MIN_EDGE threshold.
 */

const https = require('https');

const API_HOST = 'api.anthropic.com';
const API_PATH = '/v1/messages';
const MODEL    = 'claude-haiku-4-5-20251001';

// ─── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Build the analysis prompt. Sends the full quantitative picture and asks
 * Claude to assess setup quality — not to recalculate the edge.
 *
 * @param {object} signal  Full signal bundle (see analyzeSignal param docs)
 */
function buildPrompt(signal) {
  const {
    question, direction, bucketLabel, side, edge,
    marketPrice, modelProb, meanF, sigmaF,
    ensembleSpread, memberCount, membersOnSide,
    daysToResolution, historicalMean, thresholdPercentile, sources,
  } = signal;

  const daysStr    = daysToResolution != null ? daysToResolution.toFixed(1) : 'unknown';
  const spreadStr  = ensembleSpread   != null ? ensembleSpread.toFixed(1)   : 'N/A';
  const membersStr = memberCount      != null ? memberCount.toString()       : 'N/A';
  const sideStr    = membersOnSide    != null && memberCount != null
    ? `${membersOnSide}/${memberCount}`
    : 'N/A';
  const histMeanStr = historicalMean  != null ? historicalMean.toFixed(1)   : 'N/A';
  const percStr    = thresholdPercentile != null
    ? `${(thresholdPercentile * 100).toFixed(0)}th percentile historically`
    : 'unknown';
  const sigmaRatio = ensembleSpread != null && sigmaF > 0
    ? (ensembleSpread / sigmaF).toFixed(2)
    : null;

  return `You are a Polymarket weather market analyst. The quant model has already found an edge. Your job is to assess setup quality and decide whether to take, reduce, or skip.

SIGNAL:
Market: "${question}"
Side: ${side.toUpperCase()} | Bucket: ${bucketLabel} (${direction})
Edge: ${(edge * 100).toFixed(1)}% | Market price: ${(marketPrice * 100).toFixed(1)}¢ | Model P(YES): ${(modelProb * 100).toFixed(1)}%

TEMPERATURE FORECAST:
Model mean: ${meanF != null ? meanF.toFixed(1) : 'N/A'}°F | Model σ: ${sigmaF.toFixed(1)}°F
GFS ensemble: spread=${spreadStr}°F | members=${membersStr} | on-side=${sideStr}${sigmaRatio != null ? ` | spread/σ ratio=${sigmaRatio}` : ''}
Historical mean (same date): ${histMeanStr}°F | Threshold sits at ${percStr}
Days to resolution: ${daysStr}
Sources: ${Array.isArray(sources) ? sources.join(', ') : 'N/A'}

EVALUATION CRITERIA:
1. CONVICTION — Is σ tight enough that the edge is meaningful?
   σ < 2°F = high conviction. 2–4°F = moderate. >4°F = low.

2. DISTRIBUTION INTEGRITY — Does the ensemble spread support the Normal CDF assumption?
   spread/σ ≈ 1.0 = consistent. Ratio >1.5 = possible bimodal distribution where Normal CDF misfires.
   A high on-side member count (e.g. 26/30) is more reliable than a ratio alone.

3. THRESHOLD POSITION — Where does the bucket sit in history?
   Thresholds in the top or bottom 15% are harder to price and more susceptible to model error at tails.

4. TIME WINDOW — How reliable is the forecast?
   0–2 days: high accuracy. 3–5 days: moderate. >5 days: low, edge likely noise.

5. EDGE QUALITY — Is this a well-priced mispricing or just model noise?
   Large edges (>20%) at >4 days out are often model artifacts, not real opportunity.

Respond with ONLY valid JSON (no markdown, no extra text):
{
  "decision": "take" | "reduce" | "skip",
  "confidence": <0.0–1.0>,
  "sizeMultiplier": 1.0 | 0.75 | 0.5 | 0.25,
  "reasoning": "<one sentence for the trader, max 120 chars>",
  "flags": ["high_conviction" | "wide_uncertainty" | "extreme_threshold" | "bimodal_risk" | "far_out" | "short_runway" | "tail_risk" | "strong_ensemble"]
}

sizeMultiplier rules:
- 1.0  → take at full Kelly (high conviction, tight spread, reliable window)
- 0.75 → take with modest trim (good setup with minor concern)
- 0.5  → reduce (edge real but setup has structural weakness)
- 0.25 → minimal position (proceed with caution — significant uncertainty)
- skip → set decision to "skip" (sizeMultiplier ignored); use when Normal CDF assumption breaks down, edge is >4 days and >20%, or spread/σ ratio is very high without strong on-side consensus`;
}

// ─── API call ─────────────────────────────────────────────────────────────────

/**
 * Analyse a weather signal using Claude Haiku.
 *
 * @param {object} signal
 *   @param {string}   signal.question            Full Polymarket question string
 *   @param {string}   signal.direction           'above' | 'below' | 'range'
 *   @param {string}   signal.bucketLabel         e.g. '≥58°F' or '62–63°F'
 *   @param {string}   signal.side                'yes' | 'no'
 *   @param {number}   signal.edge                e.g. 0.15
 *   @param {number}   signal.marketPrice         yes price (0–1)
 *   @param {number}   signal.modelProb           model P(YES) (0–1)
 *   @param {number}   signal.meanF               ensemble mean temperature °F
 *   @param {number}   signal.sigmaF              model σ in °F
 *   @param {number}   [signal.ensembleSpread]    GFS ensemble standard deviation °F
 *   @param {number}   [signal.memberCount]       number of ensemble members
 *   @param {number}   [signal.membersOnSide]     members agreeing with the signal side
 *   @param {number}   [signal.daysToResolution]  days until market resolves
 *   @param {number}   [signal.historicalMean]    GHCN historical mean °F for this date
 *   @param {number}   [signal.thresholdPercentile] 0–1 where threshold sits historically
 *   @param {string[]} [signal.sources]           active forecast sources
 *
 * @returns {Promise<{decision, confidence, sizeMultiplier, reasoning, flags, raw}>}
 */
async function analyzeSignal(signal) {
  const fallback = {
    decision:        'take',
    confidence:      null,
    sizeMultiplier:  1.0,
    reasoning:       null,
    flags:           [],
    raw:             null,
    skipped:         false,
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[weather-analysis] ANTHROPIC_API_KEY not set — skipping AI analysis');
    return fallback;
  }

  const body = JSON.stringify({
    model:      MODEL,
    max_tokens: 300,
    messages: [{
      role:    'user',
      content: buildPrompt(signal),
    }],
  });

  return new Promise(resolve => {
    const req = https.request({
      hostname: API_HOST,
      path:     API_PATH,
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          const text = resp.content?.[0]?.text?.trim() || '';

          // Haiku sometimes wraps output in ```json ... ``` despite being told not to.
          // Strip fences, then extract the first {...} block as a fallback.
          let jsonStr = text
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```\s*$/, '')
            .trim();
          if (!jsonStr.startsWith('{')) {
            const match = jsonStr.match(/\{[\s\S]*\}/);
            jsonStr = match ? match[0] : jsonStr;
          }

          const result = JSON.parse(jsonStr);

          const decision       = ['take', 'reduce', 'skip'].includes(result.decision) ? result.decision : 'take';
          const confidence     = typeof result.confidence === 'number'    ? Math.min(1, Math.max(0, result.confidence)) : null;
          const sizeMultiplier = [1.0, 0.75, 0.5, 0.25].includes(result.sizeMultiplier) ? result.sizeMultiplier : 1.0;
          const reasoning      = typeof result.reasoning === 'string'     ? result.reasoning.slice(0, 140)            : null;
          const flags          = Array.isArray(result.flags)              ? result.flags.filter(f => typeof f === 'string').slice(0, 6) : [];

          resolve({ decision, confidence, sizeMultiplier, reasoning, flags, raw: text, skipped: false });
        } catch (e) {
          const resp = (() => { try { return JSON.parse(data); } catch { return null; } })();
          const raw  = resp?.content?.[0]?.text?.slice(0, 300) || data.slice(0, 300);
          console.error('[weather-analysis] Parse error:', e.message, '| raw:', raw);
          resolve({ ...fallback, reasoning: 'AI parse error — defaulting to take.' });
        }
      });
    });

    req.on('error', e => {
      console.error('[weather-analysis] API error:', e.message);
      resolve(fallback);
    });

    req.setTimeout(12_000, () => {
      req.destroy();
      console.error('[weather-analysis] Timeout — defaulting to take');
      resolve(fallback);
    });

    req.write(body);
    req.end();
  });
}

module.exports = { analyzeSignal };
