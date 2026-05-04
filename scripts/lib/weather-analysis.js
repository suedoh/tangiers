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
 *
 * Stage 2 — deepAnalyzeSignal():
 * Fires only when Stage 1 returns 'take' or 'reduce'. Uses claude-sonnet-4-6
 * to run a structured 5-step meteorological analysis: individual model biases,
 * synoptic pattern, microclimate factors, observational reality check, and
 * market pricing comparison. ~$0.015 per call. Falls back to Stage 1 result
 * on any API error so signals are never silenced by a Stage 2 failure.
 */

const https = require('https');

const API_HOST     = 'api.anthropic.com';
const API_PATH     = '/v1/messages';
const MODEL        = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

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

  // Compute distance from mean to range center — the primary predictive feature for NO+range
  const rangeCenterStr = signal.thresholdHighF != null && meanF != null
    ? (() => {
        const center = (signal.thresholdF + signal.thresholdHighF) / 2;
        const dist   = Math.abs(meanF - center);
        return `Range center: ${center.toFixed(1)}°F | Mean→center distance: ${dist.toFixed(1)}°F`;
      })()
    : null;

  return `You are a Polymarket weather market analyst. A quant model found a statistical edge. Your job is NOT to confirm it — your job is to find reasons to REDUCE or SKIP.

Target filter rate: skip ~5–10% of signals, reduce ~20–25%. If you are approving everything, you are not doing your job.

SIGNAL:
Market: "${question}"
Side: ${side.toUpperCase()} | Bucket: ${bucketLabel} (${direction})
Edge: ${(edge * 100).toFixed(1)}% | Market price: ${(marketPrice * 100).toFixed(1)}¢ | Model P(YES): ${(modelProb * 100).toFixed(1)}%

TEMPERATURE FORECAST:
Model mean: ${meanF != null ? meanF.toFixed(1) : 'N/A'}°F | Model σ: ${sigmaF.toFixed(1)}°F
${rangeCenterStr != null ? rangeCenterStr + '\n' : ''}GFS ensemble: spread=${spreadStr}°F | members=${membersStr} | on-side=${sideStr}
Historical mean (same date): ${histMeanStr}°F | Threshold sits at ${percStr}
Days to resolution: ${daysStr}
Sources: ${Array.isArray(sources) ? sources.join(', ') : 'N/A'}

EVALUATION CRITERIA — look for reasons to reduce or skip:

1. MEAN-TO-RANGE DISTANCE (primary criterion for NO+range bets)
   Empirically validated on 173 resolved NO+range trades:
   distance ≥ 5°F  → 94% WR — take at full size
   distance 3–5°F  → 82–89% WR — take, minor concern
   distance 2–3°F  → 91% WR but watch σ — take with small trim if σ > 2°F
   distance < 2°F  → 80% WR, model mean is near the range — REDUCE (0.5×)
   distance < 1°F  → model mean is inside or touching the range — SKIP

2. FORECAST STABILITY — Does the ensemble actually agree?
   on-side members < 20/31 → meaningful dissent, trim to 0.75×
   on-side members < 15/31 → majority of ensemble disagrees — REDUCE (0.5×)
   spread > 5°F at ≤2 days → pattern unsettled, trim to 0.75×

3. EDGE QUALITY — Is this a structural edge or noise?
   Edge > 40% is suspicious — quant model may be miscalculating. REDUCE (0.5×) unless on-side ≥ 26/31.
   Edge 8–10% with distance < 3°F → marginal setup, insufficient cushion — SKIP.

4. THRESHOLD EXTREMITY — Tail outcomes are harder to price
   Threshold in top or bottom 5% historically (percStr) → elevated model error risk, trim to 0.75×.

Respond with ONLY valid JSON (no markdown, no extra text):
{
  "decision": "take" | "reduce" | "skip",
  "confidence": <0.0–1.0>,
  "sizeMultiplier": 1.0 | 0.75 | 0.5 | 0.25,
  "reasoning": "<one sentence for the trader citing the specific factor, max 120 chars>",
  "flags": ["high_conviction" | "mean_near_range" | "mean_far_from_range" | "weak_ensemble" | "strong_ensemble" | "extreme_threshold" | "high_edge_suspicious" | "marginal_edge" | "settled_pattern" | "unsettled_pattern"]
}

sizeMultiplier rules:
- 1.0  → mean ≥ 3°F from range, ensemble agrees, edge 10–30% — strong setup
- 0.75 → one minor concern (slight ensemble dissent, or edge >35%, or tail threshold)
- 0.5  → mean < 2°F from range, OR ensemble majority disagrees, OR edge >40%
- 0.25 → multiple concerns but edge is real — hold minimal position
- skip → mean inside/touching range, OR edge 8–10% with mean < 3°F from range`;
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
  const result = await _analyzeSignal(signal);
  if (result._parseError) {
    await new Promise(r => setTimeout(r, 1000));
    console.log('[weather-analysis] Retrying after parse error...');
    const retry = await _analyzeSignal(signal);
    delete retry._parseError;
    return retry;
  }
  delete result._parseError;
  return result;
}

async function _analyzeSignal(signal) {
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

          // Handle API-level errors (auth failure, quota, overload, etc.)
          // Set _parseError so analyzeSignal() retries once before falling back to take.
          if (resp.type === 'error') {
            const msg = resp.error?.message || resp.error?.type || 'unknown API error';
            console.error('[weather-analysis] API error response:', msg);
            resolve({ ...fallback, reasoning: `API error (${resp.error?.type || 'unknown'}) — defaulting to take.`, _parseError: true });
            return;
          }

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

          if (!jsonStr) {
            console.error('[weather-analysis] Empty response from API');
            resolve({ ...fallback, reasoning: 'Empty API response — defaulting to take.' });
            return;
          }

          const parsed = JSON.parse(jsonStr);

          const VALID_FLAGS    = [
            'high_conviction', 'mean_near_range', 'mean_far_from_range',
            'weak_ensemble', 'strong_ensemble', 'extreme_threshold',
            'high_edge_suspicious', 'marginal_edge', 'settled_pattern', 'unsettled_pattern',
          ];
          const decision       = ['take', 'reduce', 'skip'].includes(parsed.decision) ? parsed.decision : 'take';
          const confidence     = typeof parsed.confidence === 'number'    ? Math.min(1, Math.max(0, parsed.confidence)) : null;
          const sizeMultiplier = [1.0, 0.75, 0.5, 0.25].includes(parsed.sizeMultiplier) ? parsed.sizeMultiplier : 1.0;
          const reasoning      = typeof parsed.reasoning === 'string'     ? parsed.reasoning.slice(0, 140)            : null;
          // Whitelist flags so arbitrary strings from Haiku never land in trade records
          const flags          = Array.isArray(parsed.flags)
            ? parsed.flags.filter(f => typeof f === 'string' && VALID_FLAGS.includes(f)).slice(0, 6)
            : [];

          resolve({ decision, confidence, sizeMultiplier, reasoning, flags, raw: text, skipped: false });
        } catch (e) {
          const resp = (() => { try { return JSON.parse(data); } catch { return null; } })();
          const raw  = resp?.content?.[0]?.text?.slice(0, 300) || data.slice(0, 300);
          console.error('[weather-analysis] Parse error:', e.message, '| raw:', raw);
          resolve({ ...fallback, reasoning: 'AI parse error — defaulting to take.', _parseError: true });
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

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 2 — Deep Analysis (claude-sonnet-4-6)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Weather Underground PWS fetch ────────────────────────────────────────────

/**
 * Fetch the nearest Personal Weather Station observation from Weather Underground.
 * Returns null gracefully if WU_API_KEY is absent or on any fetch/parse error.
 *
 * Acquire a free key (10 calls/min, 500/day) at:
 *   https://www.wunderground.com/member/api-keys
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{ stationId, tempF, humidity, reportedAt }|null>}
 */
function fetchWUObservation(lat, lon) {
  const apiKey = process.env.WU_API_KEY;
  if (!apiKey) return Promise.resolve(null);

  const path = `/v2/pws/observations/current?geocode=${lat},${lon}&numericPrecision=decimal&format=json&units=e&apiKey=${apiKey}`;

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.weather.com',
      path,
      method:  'GET',
      headers: { 'User-Agent': 'Weathermen/1.0 (Tangiers)' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          const obs  = body?.observations?.[0];
          if (!obs) { resolve(null); return; }
          resolve({
            stationId:  obs.stationID            ?? null,
            tempF:      obs.imperial?.temp        ?? null,
            humidity:   obs.humidity              ?? null,
            reportedAt: obs.obsTimeLocal          ?? null,
          });
        } catch { resolve(null); }
      });
    });
    req.setTimeout(8_000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ─── Known model biases (referenced in prompt) ────────────────────────────────

const MODEL_BIASES = {
  ecmwf_aifs025: 'Best average global skill score (WeatherBench 2 benchmark). Slight warm bias over dense urban areas in summer. Skill advantage narrows at tail thresholds (top/bottom 10% historically).',
  ecmwf_ifs025:  'Physics-based gold standard. Strongest skill on extreme events: Nor\'easters, cold outbreaks, heat dome intensification. Better than AIFS when threshold is in historical top/bottom 10%.',
  icon_global:   'DWD ICON — strong in complex terrain and Great Lakes corridor. Can run warm in summer, especially in orographic (mountain-adjacent) regions. Recommended for Denver and Seattle setups.',
  gfs_seamless:  'NOAA GFS — widely-used reference model. Documented cold bias ~1–2°F at high elevation (Denver). Warm bias overnight in winter over eastern US. Skill drops sharply beyond day 5. Underestimates lake-breeze suppression (Chicago).',
  gfs_hrrr:      'NOAA HRRR 3km — best near-term accuracy for convective and mesoscale events in the US. Skill falls sharply beyond 48h. Treat any HRRR signal beyond 2 days with low confidence.',
};

// ─── Deep prompt builder ───────────────────────────────────────────────────────

/**
 * Build the 5-section structured prompt for Stage 2 (Sonnet).
 *
 * @param {object} signal   Signal object with stageOneDecision/stageOneSizeMultiplier added
 * @param {object} ctx      Extended context:
 *   ctx.perModels        object  — forecast.models.models (per-model forecasts)
 *   ctx.nwsObs           object|null — fetchNWSObserved() result
 *   ctx.wuObs            object|null — fetchWUObservation() result
 *   ctx.cityProfile      object|null — getCityProfile() result
 *   ctx.historicalSigma  number|null — forecast.historical.sigma
 */
function buildDeepPrompt(signal, ctx) {
  const {
    question, direction, bucketLabel, side, edge,
    marketPrice, modelProb, meanF, sigmaF,
    ensembleSpread, memberCount,
    daysToResolution, historicalMean, thresholdPercentile,
    stageOneDecision, stageOneSizeMultiplier,
  } = signal;

  const { perModels = {}, nwsObs, wuObs, cityProfile, historicalSigma } = ctx;

  const f1  = v => v != null ? v.toFixed(1)        : 'N/A';
  const f2  = v => v != null ? v.toFixed(2)        : 'N/A';
  const pct = v => v != null ? (v * 100).toFixed(1) + '%' : 'N/A';

  // ── Section 1: per-model block ────────────────────────────────────────────
  let modelsBlock;
  const modelKeys = Object.keys(perModels);
  if (modelKeys.length > 0) {
    const forecastVals = modelKeys
      .map(k => perModels[k]?.forecast)
      .filter(v => v != null);
    const modelRange = forecastVals.length > 1
      ? (Math.max(...forecastVals) - Math.min(...forecastVals)).toFixed(1) + '°F'
      : 'N/A';

    modelsBlock = `Model forecast range (max − min): ${modelRange}\n\n` +
      modelKeys.map(key => {
        const mv    = perModels[key] || {};
        const delta = meanF != null && mv.forecast != null
          ? ((mv.forecast - meanF) >= 0 ? '+' : '') + (mv.forecast - meanF).toFixed(1) + '°F vs ensemble mean'
          : '';
        const bias  = MODEL_BIASES[key] || '(no documented bias on record)';
        return `  ${key}:\n    forecast=${f1(mv.forecast)}°F  prob=${pct(mv.prob)}  weight=${f2(mv.weight)}  ${delta}\n    Known bias: ${bias}`;
      }).join('\n');
  } else {
    modelsBlock = '  (per-model data unavailable — ensemble-only signal)';
  }

  // ── Section 2: synoptic indicators ───────────────────────────────────────
  const spreadRatio = ensembleSpread != null && sigmaF > 0
    ? (ensembleSpread / sigmaF).toFixed(2) : 'N/A';

  // ── Section 3: city microclimate ─────────────────────────────────────────
  let cityBlock;
  if (cityProfile) {
    const coastStr = cityProfile.coastal ? `coastal (${cityProfile.coastal})` : 'inland';
    cityBlock = [
      `  UHI delta:         +${cityProfile.uhi}°F (city centre vs. settlement station)`,
      `  Coastal:           ${coastStr}`,
      `  Station elevation: ${cityProfile.elevation} ft`,
      `  Notes: ${cityProfile.notes}`,
    ].join('\n');
  } else {
    cityBlock = '  No profile available (international city or not in table). Apply generic caution.';
  }

  // ── Section 4: observational check ───────────────────────────────────────
  let obsBlock = '';
  if (nwsObs?.high != null) {
    const modelVsObs = meanF != null
      ? ' (' + ((nwsObs.high - meanF) >= 0 ? '+' : '') + (nwsObs.high - meanF).toFixed(1) + '°F vs model mean today)'
      : '';
    obsBlock += `NWS METAR: today's high=${f1(nwsObs.high)}°F  low=${f1(nwsObs.low)}°F  obs_count=${nwsObs.obsCount ?? 'N/A'}  source=${nwsObs.source || 'NWS'}${modelVsObs}`;
  } else {
    obsBlock += 'NWS METAR: unavailable (international city or station not responding).';
  }
  if (wuObs) {
    obsBlock += `\nWU PWS (${wuObs.stationId || 'unknown'}): temp=${f1(wuObs.tempF)}°F  humidity=${wuObs.humidity != null ? wuObs.humidity + '%' : 'N/A'}  reported=${wuObs.reportedAt || 'N/A'}`;
  } else {
    obsBlock += process.env.WU_API_KEY
      ? '\nWU PWS: key present but no nearby station found or fetch failed.'
      : '\nWU PWS: WU_API_KEY not configured — NWS METAR is the only obs source.';
  }

  // ── Section 5: market pricing ─────────────────────────────────────────────
  const histBaseRate = thresholdPercentile != null
    ? (() => {
        const histProb = direction === 'above' ? 1 - thresholdPercentile : thresholdPercentile;
        const histEdge = histProb - marketPrice;
        const align    = histEdge > 0
          ? `Climatology also favours ${side.toUpperCase()} (+${(histEdge * 100).toFixed(1)}% vs market) — structural edge signal`
          : `Climatology leans AGAINST ${side.toUpperCase()} (${(histEdge * 100).toFixed(1)}% vs market) — model-only edge, higher noise risk`;
        return `Historical base rate at this threshold: ~${pct(histProb)} (${(thresholdPercentile * 100).toFixed(0)}th percentile)\n${align}`;
      })()
    : 'Historical base rate: unavailable.';

  return `You are a Polymarket weather market analyst performing a structured 5-step deep analysis. Stage 1 (Haiku pre-screen) approved this signal as '${stageOneDecision}' at ${stageOneSizeMultiplier}× Kelly. Your job is to confirm, tighten, or override that decision using meteorological depth.

SIGNAL:
Market: "${question}"
Side: ${side.toUpperCase()} | Bucket: ${bucketLabel} (${direction})
Edge: ${(edge * 100).toFixed(1)}% | Market price: ${(marketPrice * 100).toFixed(1)}¢ | Model P(YES): ${(modelProb * 100).toFixed(1)}%
Ensemble mean: ${f1(meanF)}°F | σ: ${f1(sigmaF)}°F | Historical mean (same date): ${f1(historicalMean)}°F | Historical σ: ${f1(historicalSigma)}°F
Days to resolution: ${f1(daysToResolution)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — INDIVIDUAL MODEL EXAMINATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ensemble spread (σ): ${f1(ensembleSpread)}°F | Members: ${memberCount ?? 'N/A'}

${modelsBlock}

Assess: Which models agree vs. diverge? Does the outlier have a documented bias explaining the deviation? Is a HRRR vs. IFS disagreement meaningful at this lead time?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — SYNOPTIC PATTERN ASSESSMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ensemble spread: ${f1(ensembleSpread)}°F | Spread/σ ratio: ${spreadRatio} | Lead time: ${f1(daysToResolution)} days

Interpretation guide:
  spread < 2°F + model range < 2°F → settled pattern, high confidence
  spread 2–4°F or model range 2–4°F → transitional setup, moderate confidence
  spread > 4°F or model range > 4°F → unsettled/uncertain — actual uncertainty wider than σ implies
  HRRR diverging from IFS/AIFS at 2–3 day range → mesoscale event that IFS is not yet resolving

Assess: Is the atmospheric pattern settled or unsettled? Does high spread indicate a genuine bimodal scenario (e.g. front arrives vs. misses the city)?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — MICROCLIMATE FACTORS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${cityBlock}

Assess: Does the settlement station (typically an airport ASOS) systematically differ from the city centre that Polymarket's question implies? Is UHI relevant given the forecast mean vs. threshold? Are city-specific phenomena (marine layer, lake breeze, Chinook, Santa Ana) likely active given this season and synoptic context?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — OBSERVATIONAL REALITY CHECK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${obsBlock}

Assess: Are models running systematically warm or cold vs. today's actual observations? A persistent model warm/cold bias today is evidence the same bias may affect the forecast date. Note: these are today's observations — the market resolves on a future date. Use this as a bias indicator, not a direct temperature comparison.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — MARKET PRICING ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Model P(YES): ${pct(modelProb)} | Market price: ${pct(marketPrice)} | Edge: +${(edge * 100).toFixed(1)}%
${histBaseRate}

Assess: Is this a structural edge (both model AND climatology agree the market is underpriced) or is it model noise (only the model sees it, climatology is neutral or opposed)? Are sharp bettors likely already aware of this setup?

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Stage 1 said: ${stageOneDecision} at ${stageOneSizeMultiplier}× Kelly.
You may CONFIRM, TIGHTEN (reduce size), or OVERRIDE to skip.
Only override to skip if you find a clear structural reason (e.g. active marine layer makes threshold unreachable, all models running warm vs. reality, genuinely bimodal synoptic setup).

Respond with ONLY valid JSON (no markdown, no extra text):
{
  "decision": "take" | "reduce" | "skip",
  "confidence": <0.0–1.0>,
  "sizeMultiplier": 1.0 | 0.75 | 0.5 | 0.25,
  "summary": "<2–3 sentence synthesis of all 5 steps for the trader, max 300 chars>",
  "steps": {
    "models":       "<1–2 sentences: which models agree/disagree and why it matters>",
    "synoptic":     "<1–2 sentences: settled vs. unsettled, what the spread tells you>",
    "microclimate": "<1 sentence: UHI/coastal/station bias relevant to this specific trade>",
    "observations": "<1 sentence: models running warm or cold today, confidence impact>",
    "pricing":      "<1 sentence: structural vs. noise edge assessment>"
  },
  "flags": ["model_agreement" | "model_divergence" | "settled_synoptic" | "unsettled_synoptic" | "uhi_relevant" | "marine_layer_active" | "lake_breeze_active" | "chinook_risk" | "front_timing_risk" | "obs_warm_bias" | "obs_cold_bias" | "structural_edge" | "noise_edge" | "climatology_aligned" | "climatology_opposed" | "hrrr_diverging"]
}

sizeMultiplier rules:
  1.0  → all 5 steps confirm: settled pattern, models agree, no microclimate headwind, obs neutral, structural edge
  0.75 → minor concern in 1–2 steps but setup remains solid overall
  0.5  → meaningful concern: unsettled synoptic OR strong microclimate headwind OR significant model divergence
  0.25 → multiple concerns: borderline skip but edge is real enough to hold a minimal position
  skip → clear structural reason why the edge itself or the Normal CDF assumption is broken`;
}

// ─── Stage 2 API call ─────────────────────────────────────────────────────────

/**
 * Stage 2 deep analysis — calls claude-sonnet-4-6 with a structured 5-section prompt.
 *
 * @param {object} signal         Stage 1 signal + stageOneDecision + stageOneSizeMultiplier
 * @param {object} ctx            Extended context (perModels, nwsObs, wuObs, cityProfile, historicalSigma)
 * @param {object} stage1Result   Full result from analyzeSignal() — returned on any Stage 2 error
 * @returns {Promise<object>}     Stage 2 result with stage:2, or stage1Result with stage:1 on fallback
 */
async function deepAnalyzeSignal(signal, ctx, stage1Result) {
  const result = await _deepAnalyzeSignal(signal, ctx, stage1Result);
  if (result._parseError) {
    await new Promise(r => setTimeout(r, 1500));
    console.log('[weather-analysis] Stage 2: retrying after parse error...');
    const retry = await _deepAnalyzeSignal(signal, ctx, stage1Result);
    delete retry._parseError;
    return retry;
  }
  delete result._parseError;
  return result;
}

async function _deepAnalyzeSignal(signal, ctx, stage1Result) {
  const fallback = { ...stage1Result, stage: 1, deepSkipped: true };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[weather-analysis] Stage 2: ANTHROPIC_API_KEY not set — using Stage 1 result');
    return fallback;
  }

  const body = JSON.stringify({
    model:      SONNET_MODEL,
    max_tokens: 800,
    messages: [{
      role:    'user',
      content: buildDeepPrompt(signal, ctx),
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

          if (resp.type === 'error') {
            const msg = resp.error?.message || resp.error?.type || 'unknown';
            console.error('[weather-analysis] Stage 2 API error:', msg);
            resolve(fallback);
            return;
          }

          const text = resp.content?.[0]?.text?.trim() || '';
          let jsonStr = text
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```\s*$/, '')
            .trim();
          if (!jsonStr.startsWith('{')) {
            const match = jsonStr.match(/\{[\s\S]*\}/);
            jsonStr = match ? match[0] : jsonStr;
          }

          if (!jsonStr) {
            console.error('[weather-analysis] Stage 2: empty response');
            resolve({ ...fallback, _parseError: true });
            return;
          }

          const parsed        = JSON.parse(jsonStr);
          const decision      = ['take', 'reduce', 'skip'].includes(parsed.decision) ? parsed.decision : stage1Result.decision;
          const confidence    = typeof parsed.confidence === 'number'    ? Math.min(1, Math.max(0, parsed.confidence)) : null;
          const sizeMult      = [1.0, 0.75, 0.5, 0.25].includes(parsed.sizeMultiplier) ? parsed.sizeMultiplier : stage1Result.sizeMultiplier;
          const summary       = typeof parsed.summary === 'string'       ? parsed.summary.slice(0, 320)   : null;
          const steps         = parsed.steps && typeof parsed.steps === 'object' ? {
            models:       String(parsed.steps.models       || '').slice(0, 220),
            synoptic:     String(parsed.steps.synoptic     || '').slice(0, 220),
            microclimate: String(parsed.steps.microclimate || '').slice(0, 220),
            observations: String(parsed.steps.observations || '').slice(0, 220),
            pricing:      String(parsed.steps.pricing      || '').slice(0, 220),
          } : null;
          const STAGE2_VALID_FLAGS = [
            'model_agreement', 'model_divergence', 'settled_synoptic', 'unsettled_synoptic',
            'uhi_relevant', 'marine_layer_active', 'lake_breeze_active', 'chinook_risk',
            'front_timing_risk', 'obs_warm_bias', 'obs_cold_bias', 'structural_edge',
            'noise_edge', 'climatology_aligned', 'climatology_opposed', 'hrrr_diverging',
          ];
          const flags         = Array.isArray(parsed.flags)
            ? parsed.flags.filter(f => typeof f === 'string' && STAGE2_VALID_FLAGS.includes(f)).slice(0, 10)
            : [];

          resolve({
            decision,
            confidence,
            sizeMultiplier: sizeMult,
            summary,
            steps,
            flags,
            reasoning:     stage1Result.reasoning,   // keep Stage 1 one-liner for the card
            raw:           text,
            skipped:       false,
            stage:         2,
            deepSkipped:   false,
          });
        } catch (e) {
          const resp = (() => { try { return JSON.parse(data); } catch { return null; } })();
          const raw  = resp?.content?.[0]?.text?.slice(0, 300) || data.slice(0, 300);
          console.error('[weather-analysis] Stage 2 parse error:', e.message, '| raw:', raw);
          resolve({ ...fallback, _parseError: true });
        }
      });
    });

    req.on('error', e => {
      console.error('[weather-analysis] Stage 2 request error:', e.message);
      resolve(fallback);
    });

    req.setTimeout(25_000, () => {
      req.destroy();
      console.error('[weather-analysis] Stage 2 timeout — falling back to Stage 1 result');
      resolve(fallback);
    });

    req.write(body);
    req.end();
  });
}

module.exports = { analyzeSignal, deepAnalyzeSignal, fetchWUObservation };
