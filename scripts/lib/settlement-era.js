'use strict';

/**
 * Classify a resolved trade by which oracle settled it.
 *
 * 'wu'      — settled via Weather Underground (observedSource starts with 'WU:').
 *             Accurate: WU is Polymarket's actual oracle for wuStation cities.
 *
 * 'legacy'  — city has a wuStation but was settled on GHCN/NWS/ERA5.
 *             Potentially wrong: graded against the wrong oracle.
 *
 * 'native'  — no wuStation (istanbul, moscow, hong-kong).
 *             Accurate: their oracle IS GHCN/NWS timeseries / HK Observatory.
 *
 * @param {object} trade
 * @returns {'wu' | 'legacy' | 'native'}
 */
function getSettlementEra(trade) {
  if (typeof trade.observedSource === 'string' && trade.observedSource.startsWith('WU:')) {
    return 'wu';
  }
  if (trade.wuStation) {
    return 'legacy';
  }
  return 'native';
}

module.exports = { getSettlementEra };
