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

  // ─── International cities (Batch 1) ──────────────────────────────────────────

  'london': {
    uhi:       3.5,
    coastal:   null,       // Thames estuary 30 miles east — indirect influence only
    elevation: 83,         // EGLL (Heathrow) — 15 miles WSW of central London
    notes: 'EGLL is Heathrow, 15 miles west of central London — central and east London run 3–5°F warmer in summer. ECMWF IFS (headquartered in Reading, UK) has exceptional skill on British Isles synoptic patterns and is the primary model to trust here. Persistent frontal systems from the North Atlantic cause model timing disagreement at 3–5 day range; IFS skill advantage over GFS is largest on this continent. Heat wave thresholds (>86°F / 30°C) are historically rare but have increased in frequency — models underestimate peak heat during omega-block events at 5–7 day range. Winter cold snaps from easterly continental air ("Beast from the East") cause sharp divergence between IFS and GFS at extended range.',
  },

  'tokyo': {
    uhi:       5.5,
    coastal:   'bay',      // Tokyo Bay / Pacific
    elevation: 35,         // RJTT (Haneda) — reclaimed land on Tokyo Bay
    notes: 'Haneda is on reclaimed land in Tokyo Bay — city centre and western wards run 5–7°F warmer due to one of the world\'s largest and best-documented urban heat islands. Typhoon season (June–November) causes sharp model divergence when systems approach; ECMWF IFS outperforms GFS on western Pacific typhoon track prediction. Tsuyu rainy season (mid-June to mid-July) depresses temperatures below climatology via persistent cloud cover. HRRR does not cover Japan — rely on AIFS/IFS ensemble consensus. Summer heat domes (subsidence from western Pacific subtropical high) increasingly drive extreme highs that exceed historical percentiles.',
  },

  'paris': {
    uhi:       3.0,
    coastal:   null,
    elevation: 387,        // LFPG (Charles de Gaulle) — 16 miles NE of central Paris
    notes: 'CDG is 16 miles northeast of central Paris in open agricultural land — city centre runs 3–5°F warmer in summer. ECMWF IFS and ICON both have exceptional skill over France; this is European model home turf. Summer heat waves can be extreme (2003, 2019 set all-time records) — models underestimate peak heat during omega-block anticyclone events at 5–7 day range. GFS performs adequately but IFS is the primary reference. Winter cold is relatively mild for the latitude; model agreement is strong in winter and autumn.',
  },

  'madrid': {
    uhi:       4.0,
    coastal:   null,
    elevation: 1998,       // LEMD (Barajas) — on the high Castilian Meseta
    notes: 'Barajas is on the high Castilian Meseta at ~2,000 ft — one of the highest major European airports. Continental semi-arid climate with extreme summer heat (95–105°F / 35–40°C routinely) and cold winters for the latitude. High-pressure blocking events in summer drive temperatures to extreme high thresholds; ECMWF IFS handles Iberian Peninsula blocking patterns well and is the primary reference. GFS underestimates intensity and duration of summer heat waves on the Meseta. Low humidity reduces cloud cover and makes high-temperature thresholds structurally more predictable in summer than coastal equivalents. GFS cold bias at elevation (documented at Denver) applies here too.',
  },

  'seoul': {
    uhi:       4.0,
    coastal:   'bay',      // Yellow Sea / Incheon Bay
    elevation: 23,         // RKSI (Incheon Intl) — reclaimed land off Yellow Sea coast
    notes: 'Incheon Intl is built on reclaimed land off the Yellow Sea coast — central Seoul runs 5–7°F warmer due to dense urban mass. East Asian summer monsoon (Changma, late June to late July) suppresses temperatures and limits extreme highs during the wet period. Winter cold waves driven by the Siberian high can be severe — models agree well on cold wave onset but underestimate absolute depths. Typhoon season (July–September) brings occasional direct hits; ECMWF IFS outperforms GFS on western Pacific track prediction. HRRR does not cover Korea.',
  },

  'singapore': {
    uhi:       2.5,
    coastal:   'ocean',    // South China Sea / Strait of Malacca
    elevation: 22,         // WSSS (Changi Intl) — eastern coast of Singapore
    notes: 'Equatorial maritime climate with structurally minimal temperature variability — mean daily range is only ~7°F. Threshold trades (very high or very low) carry very high risk due to the tight climatological distribution. ECMWF IFS and AIFS both perform well in the tropics; GFS has limited skill in equatorial convective environments. Inter-monsoon periods (April–May and October–November) bring the most convective variability and cloud shading that caps highs. Long-range forecasts (5+ days) have very low skill at temperature thresholds given the inherently tight spread.',
  },

  'istanbul': {
    uhi:       4.0,
    coastal:   'bay',      // Marmara Sea / Bosphorus
    elevation: 163,        // LTBA (Atatürk) — European side, Marmara coast
    notes: 'Settlement station is likely LTBA (Atatürk, European side, 163 ft) — this station remains active for METAR despite commercial closure. The new airport LTFM sits at 2,057 ft inland and would give dramatically different readings; verify which station Polymarket uses. Bosphorus moderates temperatures on both coasts; Asian side runs 2–3°F warmer in summer. Poyraz (northeasterly channelled through the Bosphorus) rapidly cools the European shore. ECMWF IFS performs well over the Eastern Mediterranean. GFS handles Black Sea blocking episodes less reliably.',
  },

  'toronto': {
    uhi:       3.5,
    coastal:   'lake',     // Lake Ontario
    elevation: 569,        // CYYZ (Pearson Intl) — suburban Mississauga, 16 miles NW of downtown
    notes: 'Pearson is in suburban Mississauga 16 miles northwest of downtown — similar offset to KORD/Chicago. Lake Ontario provides significant thermal inertia: suppresses summer highs near the lake by 4–8°F and delays winter cold-air penetration by several weeks. Lake-effect snow events from Lake Ontario cause sharp model divergence. ECMWF IFS handles Great Lakes mesoscale dynamics better than GFS. Canadian winter Arctic outbreaks are well-forecast by all models at 3–4 day range. ICON performs well in the Great Lakes corridor.',
  },

  'sao paulo': {
    uhi:       4.5,
    coastal:   null,       // 87 miles from Atlantic coast
    elevation: 2459,       // SBGR (Guarulhos Intl) — suburban plateau NE of city
    notes: 'Guarulhos is on the Paulista Plateau at 2,459 ft, 17 miles northeast of central São Paulo. Subtropical highland climate (Cwa) with distinct dry winters and wet summers. Brazil\'s summer monsoon (November–March) drives intense afternoon convection that suppresses peak temperatures via cloud cover and outflow cooling — models frequently overestimate summer highs when convective initiation occurs earlier than forecast. Dry season (May–September) is structurally more predictable; IFS and AIFS agree closely. HRRR does not cover Brazil. GFS skill drops more sharply beyond day 5 over South America than over North America.',
  },

  'mexico city': {
    uhi:       3.0,
    coastal:   null,
    elevation: 7316,       // MMMX (Benito Juárez Intl) — one of the world's highest major airports
    notes: 'Benito Juárez Intl sits at 7,316 ft on the Valley of Mexico — this dramatically compresses both absolute temperature levels and daily variability vs sea-level norms. Subtropical highland climate: rainy season (May–October) brings afternoon convective showers that cap highs via cloud shading; dry season (November–April) sees cold overnight lows from radiative cooling at altitude. GFS cold bias at elevation (documented at Denver at 5,431 ft) is amplified here — expect GFS to underestimate minimum temperatures more than at any other city in this profile set. ECMWF IFS handles the complex Mexican Plateau topography better than GFS. HRRR does not cover Mexico.',
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
