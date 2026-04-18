'use strict';

/**
 * lib/sentiment.js — Claude API sentiment classifier for oil trade context
 *
 * Takes a free-text context string (from !analyze, AIS monitor, or RSS feed)
 * and returns structured sentiment that factors into the trade quality score.
 *
 * Uses Anthropic Messages API directly via HTTPS (no SDK dependency).
 * Cost: ~$0.001 per call (Haiku 4.5). Only fires when a trigger actually occurs.
 *
 * Returns:
 *   { direction, severity, confirmed, modifier, reasoning, raw }
 *   direction:  'bullish' | 'bearish' | 'neutral' | 'mixed'
 *   severity:   'high' | 'medium' | 'low'
 *   confirmed:  true | false
 *   modifier:   +1 (bullish+confirmed) | -1 (bearish+confirmed) | 0 (otherwise)
 *   reasoning:  one-sentence explanation
 */

const https = require('https');

const API_HOST  = 'api.anthropic.com';
const API_PATH  = '/v1/messages';
const MODEL     = 'claude-haiku-4-5-20251001';  // cheapest, fast, sufficient for classification

function buildPrompt(context) {
  return `You are classifying a news context string for an oil futures trader who is deciding whether to enter a long or short position on Brent crude (BZ!).

Context: "${context}"

Classify this context and respond with ONLY valid JSON (no markdown, no explanation):
{
  "direction": "bullish" | "bearish" | "neutral" | "mixed",
  "severity": "high" | "medium" | "low",
  "confirmed": true | false,
  "reasoning": "one sentence explaining your classification"
}

Rules:
- direction: bullish = oil price goes up (supply disruption, escalation, closure), bearish = oil price goes down (deal, ceasefire, strait opening), neutral = no oil impact, mixed = conflicting signals
- severity: high = physical escalation or confirmed supply disruption, medium = credible threat or policy change, low = rumor, conditional, or speculative
- confirmed: true only if this is a CONFIRMED physical event (shots fired, strait actually closed, deal signed), false if speculative, conditional, or from unnamed sources`;
}

/**
 * Classify a context string using Claude Haiku.
 * Falls back gracefully if API key missing or call fails.
 *
 * @param {string} context  Free-text trigger context
 * @returns {Promise<object>}
 */
async function classifySentiment(context) {
  const fallback = { direction: 'neutral', severity: 'low', confirmed: false, modifier: 0, reasoning: 'No context provided or classification unavailable.', raw: null };

  if (!context || !context.trim()) return fallback;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[sentiment] ANTHROPIC_API_KEY not set — skipping sentiment classification');
    return { ...fallback, reasoning: 'No API key — sentiment not classified.' };
  }

  const body = JSON.stringify({
    model:      MODEL,
    max_tokens: 200,
    messages: [{
      role:    'user',
      content: buildPrompt(context),
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
          const resp    = JSON.parse(data);
          const text    = resp.content?.[0]?.text?.trim() || '';
          const result  = JSON.parse(text);

          // Compute modifier
          let modifier = 0;
          if (result.confirmed) {
            if (result.direction === 'bullish') modifier = 1;
            if (result.direction === 'bearish') modifier = -1;
          }

          resolve({
            direction: result.direction || 'neutral',
            severity:  result.severity  || 'low',
            confirmed: Boolean(result.confirmed),
            modifier,
            reasoning: result.reasoning || '',
            raw:       text,
          });
        } catch (e) {
          console.error('[sentiment] Parse error:', e.message);
          resolve({ ...fallback, reasoning: 'Classification parse error.' });
        }
      });
    });

    req.on('error', e => {
      console.error('[sentiment] API error:', e.message);
      resolve({ ...fallback, reasoning: 'API request failed.' });
    });

    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ ...fallback, reasoning: 'API timeout.' });
    });

    req.write(body);
    req.end();
  });
}

module.exports = { classifySentiment };
