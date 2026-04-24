'use strict';

/**
 * lib/city-profiles.js — Meteorological microclimate profiles for Polymarket cities
 *
 * Used by deepAnalyzeSignal() (Stage 2) to provide city-specific context
 * to the Sonnet analysis prompt.
 *
 * Fields per city:
 *   uhi        Urban heat island delta in °F — typical difference between
 *              city centre and the ASOS/airport station used for settlement.
 *              Positive = city is warmer than the measuring station.
 *   coastal    null | 'ocean' | 'lake' | 'bay' — dominant water body affecting
 *              thermal inertia and sea/lake breeze dynamics.
 *   elevation  Airport ASOS station elevation in feet.
 *   notes      Hard meteorological facts passed verbatim into the AI prompt.
 *              No hedging — only known, documented biases and effects.
 */

const CITY_PROFILES = {

  'new york': {
    uhi:       4.5,
    coastal:   'bay',      // Upper New York Bay / Atlantic
    elevation: 11,         // KNYC (Central Park) — unusual: not an airport
    notes: 'Settlement station KNYC is Central Park, not an airport — UHI is partially baked in already. Sea-breeze from the Atlantic/Lower Bay suppresses summer afternoon highs by 3–6°F when winds are southerly. Cold-air pooling in the Hudson River corridor can trap cold air overnight in winter. ECMWF AIFS tends to over-smooth the urban heat signature. GFS has a documented cold bias overnight in winter over the Northeast corridor.',
  },

  'chicago': {
    uhi:       3.5,
    coastal:   'lake',     // Lake Michigan
    elevation: 672,        // KORD (O\'Hare Intl) — 17 miles NW of downtown
    notes: 'KORD is at O\'Hare, 17 miles northwest of downtown. Lake Michigan drives a pronounced sea-breeze that suppresses lakefront summer highs by 5–10°F vs inland readings. Downtown Chicago is warmer than O\'Hare in summer due to urban mass and reduced lake exposure. ICON performs well in the Great Lakes corridor. GFS systematically underestimates lake-breeze suppression. January lake-effect snow events cause sharp model divergence; ensemble spread widens considerably during these setups.',
  },

  'los angeles': {
    uhi:       3.0,
    coastal:   'ocean',    // Pacific / Santa Monica Bay
    elevation: 126,        // KLAX (Los Angeles Intl)
    notes: 'LAX is at the coast — downtown LA and the San Fernando Valley run 5–10°F warmer in summer. The marine layer suppresses morning temperatures at the coast; it typically burns off inland by midday but can persist all day during "June Gloom." Santa Ana wind events (fall and winter, occasionally spring) cause rapid warming of 10–20°F that all models underestimate. ECMWF IFS handles the marine boundary layer better than GFS. HRRR is the best short-range tool for Santa Ana onset timing.',
  },

  'miami': {
    uhi:       2.5,
    coastal:   'ocean',    // Biscayne Bay / Atlantic
    elevation: 9,          // KMIA (Miami Intl)
    notes: 'Subtropical maritime climate with structurally small temperature variability — model σ is inherently low here. Sea-breeze convergence triggers afternoon convection that regularly caps and sometimes depresses afternoon high temperatures. Models agree closely in winter; they diverge in summer convective season when mesoscale interactions drive daily outcomes. Extreme thresholds (very high or very low) are historically rare, making tail trades higher-risk. IFS and AIFS both perform well in the tropics.',
  },

  'phoenix': {
    uhi:       5.0,
    coastal:   null,
    elevation: 1083,       // KPHX (Phoenix Sky Harbor)
    notes: 'Desert urban environment with the strongest UHI in this city set. Sky Harbor airport is embedded in the urban core and captures most of the city heat signal — station bias is lower than most airports. Monsoon season (July–September) brings moisture surges that suppress afternoon highs via cloud cover and evaporative cooling; models frequently miss monsoon onset timing. Dry heat in spring and fall makes high-temperature thresholds among the most predictable of any US city. GFS underestimates overnight heat retention in summer.',
  },

  'houston': {
    uhi:       3.0,
    coastal:   'bay',      // Galveston Bay / Gulf of Mexico proximity
    elevation: 50,         // KHOU (William P. Hobby)
    notes: 'High Gulf humidity moderates extreme temperature events. Gulf moisture surges cause rapid warm-ups ahead of frontal systems. KHOU (Hobby) is in south-central Houston and may not represent northern suburbs that run warmer. GFS handles Gulf moisture transport reasonably well. Models tend to underestimate the speed and magnitude of temperature drops behind fast-moving cold fronts ("blue northers") in winter. Persistent cloud cover from Gulf onshore flow can suppress afternoon highs unexpectedly.',
  },

  'dallas': {
    uhi:       3.5,
    coastal:   null,
    elevation: 596,        // KDFW (Dallas/Fort Worth Intl) — between the two cities
    notes: 'Continental climate with high temperature variability — model σ is structurally wider than coastal cities. Fast-moving cold fronts ("blue northers") can drop temperatures 30°F in 2–3 hours; timing errors in front arrival are the primary source of model disagreement. KDFW is between Dallas and Fort Worth, not in either city centre. ECMWF IFS handles synoptic-scale fronts better than GFS at 3–5 day range. Summer heat is persistent and well-forecast; winter extremes carry higher uncertainty.',
  },

  'denver': {
    uhi:       2.5,
    coastal:   null,
    elevation: 5431,       // KDEN (Denver Intl) — on the high plains east of the city
    notes: 'High elevation environment. GFS has a documented cold bias of approximately 1–2°F at Denver\'s elevation — this is one of the most reliable model biases in this city set. Chinook wind events cause rapid warming of 10–20°F in just a few hours; all models consistently underestimate Chinook warming magnitude and occasionally miss the event entirely. ICON performs better than GFS in complex Rocky Mountain terrain. KDEN sits on the eastern plains, slightly lower elevation than Denver proper. Diurnal temperature range is very large (20–30°F common).',
  },

  'seattle': {
    uhi:       2.5,
    coastal:   'bay',      // Puget Sound
    elevation: 429,        // KSEA (Seattle-Tacoma Intl)
    notes: 'Marine west coast climate — temperature extremes are structurally rare, making extreme-threshold trades higher-risk. Puget Sound moderates temperatures significantly vs inland sites. KSEA (Sea-Tac) is elevated and in south King County; downtown Seattle runs 2–3°F warmer. Heat dome events (June–August) have become more frequent and remain poorly forecast at 5–7 day range; ECMWF AIFS handles the Pacific ridge pattern that drives heat domes better than GFS at extended range. East wind events through the Columbia Gorge bring dry, cold air and cause model divergence in winter.',
  },

  'boston': {
    uhi:       3.0,
    coastal:   'ocean',    // Massachusetts Bay / Atlantic
    elevation: 19,         // KBOS (Logan Intl) — on a peninsula in Boston Harbor
    notes: 'Logan airport sits on a peninsula in Boston Harbor, giving it significant ocean exposure that suppresses temperature extremes — downtown and especially western suburbs are 2–4°F warmer. Nor\'easters cause sharp model divergence 2–4 days ahead, particularly regarding track and precipitation phase. Sea-breeze off Massachusetts Bay suppresses summer afternoon highs near the coast. ECMWF IFS has a well-documented skill advantage over GFS on New England synoptic patterns. Winter cold events are better-forecast than summer heat.',
  },

  'atlanta': {
    uhi:       4.0,
    coastal:   null,
    elevation: 1026,       // KATL (Hartsfield-Jackson) — south of downtown
    notes: 'Subtropical humid climate with a meaningful UHI signal that has intensified as urban tree canopy has declined. Hartsfield-Jackson is south of downtown at 1026 ft — city centre runs warmer. Summer afternoon convective activity routinely limits afternoon highs by 2–5°F via cloud shading and rain-cooled outflow; models frequently overestimate summer peaks. Models agree well in fall and spring; they diverge in summer convective season. Winter ice storm events (rare but high-impact) carry significant model timing uncertainty.',
  },

  'portland': {
    uhi:       2.5,
    coastal:   'bay',      // Columbia River / Pacific proximity (~75 miles)
    elevation: 30,         // KPDX (Portland Intl) — near the Columbia River
    notes: 'Marine west coast climate, similar to Seattle but with greater continental influence via the Columbia River Gorge. East wind events (cold, dry air from the high desert plateau east of the Cascades) can rapidly cool the city in winter and spring; onset and magnitude are frequently underestimated by models. Heat dome events are high-impact and remain poorly forecast beyond 5 days — same Pacific ridge issue as Seattle. KPDX sits near the Columbia River; downtown Portland is slightly warmer due to lower effective elevation.',
  },

};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up a city profile by name (case-insensitive partial match).
 * Returns null for international cities not in the table.
 *
 * @param {string} cityName  e.g. 'new york', 'Chicago', 'los angeles'
 * @returns {{ uhi, coastal, elevation, notes }|null}
 */
function getCityProfile(cityName) {
  if (!cityName) return null;
  return CITY_PROFILES[cityName.toLowerCase().trim()] || null;
}

module.exports = { CITY_PROFILES, getCityProfile };
