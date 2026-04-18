'use strict';

/**
 * lib/zones.js — Zone proximity evaluation for BZ (and future instruments)
 *
 * BZ uses ATR-based buffers rather than BTC's percentage-based approach.
 * buffer = max(atr14 × 0.35, 1.50)
 */

/**
 * Classify each zone relative to current price.
 * Returns zones enriched with { side, distance, midpoint, width, inBuffer }
 *
 * @param {Array<{high,low}>} zones   Supply/demand zones from LuxAlgo
 * @param {number}            price   Current price
 * @param {number}            buffer  ATR-derived proximity buffer in price units
 */
function classifyZones(zones, price, buffer) {
  return zones.map(z => {
    const mid      = (z.high + z.low) / 2;
    const width    = z.high - z.low;
    const inside   = price >= z.low && price <= z.high;
    const distEdge = inside ? 0
                   : price > z.high ? price - z.high   // price above zone
                   : z.low - price;                    // price below zone

    return {
      ...z,
      mid:      Math.round(mid * 100) / 100,
      width:    Math.round(width * 100) / 100,
      side:     price > z.high ? 'above'           // zone is below price (demand)
              : price < z.low  ? 'below'           // zone is above price (supply)
              : 'inside',
      distance: Math.round(distEdge * 100) / 100,
      inBuffer: distEdge <= buffer || inside,
    };
  });
}

/**
 * Find the nearest supply zone above price and nearest demand zone below price.
 * Returns { supply, demand } — either can be null if none found.
 */
function nearestZones(zones, price) {
  const above = zones.filter(z => z.low > price).sort((a, b) => a.low - b.low);
  const below = zones.filter(z => z.high < price).sort((a, b) => b.high - a.high);
  return { supply: above[0] || null, demand: below[0] || null };
}

/**
 * Determine session cooldown key for BZ.
 * One alert per zone per session (Asia / London / NY / Post).
 *
 * @param {Date} now  Optional date override (for testing)
 * @returns {string}  e.g. "2026-04-20-asia"
 */
function currentSession(now) {
  const d    = now || new Date();
  const utc  = d.getUTCHours() * 60 + d.getUTCMinutes();
  const date = d.toISOString().slice(0, 10);

  // ET = UTC-5 (EST) or UTC-4 (EDT). We approximate with UTC-4 (summer 2026)
  const etHour = (d.getUTCHours() - 4 + 24) % 24;

  let session;
  if (etHour >= 18 || etHour < 1)  session = 'asia';     // 18:00–01:00 ET
  else if (etHour >= 1  && etHour < 2)  session = 'asia';
  else if (etHour >= 2  && etHour < 8)  session = 'london';  // 02:00–08:00 ET
  else if (etHour >= 8  && etHour < 14) session = 'ny';       // 08:00–14:00 ET
  else if (etHour >= 14 && etHour < 15) session = 'ny';       // 14:00–14:30 ET
  else session = 'post';                                       // 14:30–18:00 ET

  return `${date}-${session}`;
}

/**
 * Check whether a zone has already fired this session.
 * @param {object} state     Parsed .bz-trigger-state.json
 * @param {string} zoneKey   e.g. "97.32:98.97"
 * @returns {boolean}
 */
function isOnCooldown(state, zoneKey) {
  const lastSession = state.cooldowns?.[zoneKey];
  if (!lastSession) return false;
  return lastSession === currentSession();
}

/**
 * Record that a zone fired this session.
 */
function setCooldown(state, zoneKey) {
  if (!state.cooldowns) state.cooldowns = {};
  state.cooldowns[zoneKey] = currentSession();
}

/**
 * Generate a stable string key for a zone.
 */
function zoneKey(zone) {
  return `${zone.low}:${zone.high}`;
}

module.exports = {
  classifyZones,
  nearestZones,
  currentSession,
  isOnCooldown,
  setCooldown,
  zoneKey,
};
