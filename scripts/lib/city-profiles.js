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
    uhi:              4.5,
    coastal:          'bay',      // Upper New York Bay / Atlantic
    elevation:        11,         // KNYC (Central Park) — unusual: not an airport
    neighborStations: ['KJFK', 'KEWR'],  // JFK + Newark: cross-check for oracle anomalies
    notes: 'Settlement station KNYC is Central Park, not an airport — UHI is partially baked in already. Sea-breeze from the Atlantic/Lower Bay suppresses summer afternoon highs by 3–6°F when winds are southerly. Cold-air pooling in the Hudson River corridor can trap cold air overnight in winter. ECMWF AIFS tends to over-smooth the urban heat signature. GFS has a documented cold bias overnight in winter over the Northeast corridor.',
  },

  'chicago': {
    uhi:              3.5,
    coastal:          'lake',     // Lake Michigan
    elevation:        672,        // KORD (O\'Hare Intl) — 17 miles NW of downtown
    neighborStations: ['KMDW', 'KARR'],  // Midway + Aurora: cross-check for oracle anomalies
    notes: 'KORD is at O\'Hare, 17 miles northwest of downtown. Lake Michigan drives a pronounced sea-breeze that suppresses lakefront summer highs by 5–10°F vs inland readings. Downtown Chicago is warmer than O\'Hare in summer due to urban mass and reduced lake exposure. ICON performs well in the Great Lakes corridor. GFS systematically underestimates lake-breeze suppression. January lake-effect snow events cause sharp model divergence; ensemble spread widens considerably during these setups.',
  },

  'los angeles': {
    uhi:       3.0,
    coastal:   'ocean',    // Pacific / Santa Monica Bay
    elevation: 126,        // KLAX (Los Angeles Intl)
    notes: 'LAX is at the coast — downtown LA and the San Fernando Valley run 5–10°F warmer in summer. The marine layer suppresses morning temperatures at the coast; it typically burns off inland by midday but can persist all day during "June Gloom." Santa Ana wind events (fall and winter, occasionally spring) cause rapid warming of 10–20°F that all models underestimate. ECMWF IFS handles the marine boundary layer better than GFS. HRRR is the best short-range tool for Santa Ana onset timing.',
  },

  'miami': {
    uhi:              2.5,
    coastal:          'ocean',    // Biscayne Bay / Atlantic
    elevation:        9,          // KMIA (Miami Intl)
    neighborStations: ['KFLL', 'KOPF'],  // Fort Lauderdale + Opa-Locka: cross-check for oracle anomalies
    notes: 'Subtropical maritime climate with structurally small temperature variability — model σ is inherently low here. Sea-breeze convergence triggers afternoon convection that regularly caps and sometimes depresses afternoon high temperatures. Models agree closely in winter; they diverge in summer convective season when mesoscale interactions drive daily outcomes. Extreme thresholds (very high or very low) are historically rare, making tail trades higher-risk. IFS and AIFS both perform well in the tropics.',
  },

  'phoenix': {
    uhi:              5.0,
    coastal:          null,
    elevation:        1083,       // KPHX (Phoenix Sky Harbor)
    neighborStations: ['KCHD', 'KSDL'],  // Chandler + Scottsdale: cross-check for oracle anomalies
    notes: 'Desert urban environment with the strongest UHI in this city set. Sky Harbor airport is embedded in the urban core and captures most of the city heat signal — station bias is lower than most airports. Monsoon season (July–September) brings moisture surges that suppress afternoon highs via cloud cover and evaporative cooling; models frequently miss monsoon onset timing. Dry heat in spring and fall makes high-temperature thresholds among the most predictable of any US city. GFS underestimates overnight heat retention in summer.',
  },

  'houston': {
    uhi:       3.0,
    coastal:   'bay',      // Galveston Bay / Gulf of Mexico proximity
    elevation: 50,         // KHOU (William P. Hobby)
    notes: 'High Gulf humidity moderates extreme temperature events. Gulf moisture surges cause rapid warm-ups ahead of frontal systems. KHOU (Hobby) is in south-central Houston and may not represent northern suburbs that run warmer. GFS handles Gulf moisture transport reasonably well. Models tend to underestimate the speed and magnitude of temperature drops behind fast-moving cold fronts ("blue northers") in winter. Persistent cloud cover from Gulf onshore flow can suppress afternoon highs unexpectedly.',
  },

  'dallas': {
    uhi:              3.5,
    coastal:          null,
    elevation:        596,        // KDFW (Dallas/Fort Worth Intl) — between the two cities
    neighborStations: ['KDAL', 'KADS'],  // Love Field + Addison: cross-check for oracle anomalies
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
    uhi:              4.0,
    coastal:          null,
    elevation:        1026,       // KATL (Hartsfield-Jackson) — south of downtown
    neighborStations: ['KFTY', 'KPDK'],  // Fulton Co. + Peachtree-Dekalb: cross-check for oracle anomalies
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

  // ─── International cities (Batch 2) ──────────────────────────────────────────

  'beijing': {
    uhi:       6.0,
    coastal:   null,       // Bohai Sea ~80 miles east — negligible maritime influence
    elevation: 116,        // ZBAA (Capital Intl) — NE suburb, 17 miles from city centre
    notes: 'Capital Intl is 17 miles northeast of Tiananmen Square — one of the strongest urban heat islands in Asia, with the city core running 5–7°F warmer. Extreme continental seasonal swings: harsh Siberian cold waves in winter, hot humid summers driven by the East Asian monsoon (July–August). Spring dust storms from the Gobi Desert cause rapid temperature drops and reduce solar heating. East Asian monsoon onset is the primary source of summer model uncertainty. ECMWF IFS has good skill over East Asia; GFS degrades more steeply beyond day 5. HRRR does not cover China.',
  },

  'hong kong': {
    uhi:       4.5,
    coastal:   'ocean',    // South China Sea / Pearl River Estuary
    elevation: 28,         // VHHH (Hong Kong Intl) — Lantau Island, west of main urban area
    notes: 'Hong Kong Intl is on Lantau Island — the dense urban core of Kowloon and Hong Kong Island runs 4–6°F warmer due to intense urban mass. Typhoon season (May–November, peak August–September) causes the sharpest model divergence of any city in this set; typhoon track errors of 50–100 miles produce completely different temperature outcomes. ECMWF IFS outperforms GFS on western Pacific typhoon track prediction. South China Sea moisture drives very high summer humidity that suppresses temperature extremes relative to apparent heat index. HRRR does not cover Hong Kong.',
  },

  'sydney': {
    uhi:       3.0,
    coastal:   'bay',      // Botany Bay / Tasman Sea
    elevation: 21,         // YSSY (Kingsford Smith) — inner south suburbs, Botany Bay
    notes: 'Kingsford Smith sits on Botany Bay in the inner south — comparable ocean exposure to KBOS/Logan. Temperate oceanic climate (Cfb) moderated by the Tasman Sea. Hot westerly air masses from the interior drive extreme summer heat events (Foehn-type continental flow); all models underestimate peak temperatures during these "inland heat surge" events. East Coast Lows (ECLs) cause rapid temperature drops and model divergence at 2–4 day range — analogous to Nor\'easters for Boston. ECMWF IFS outperforms GFS in the Southern Hemisphere. HRRR does not cover Australia.',
  },

  'amsterdam': {
    uhi:       2.5,
    coastal:   'ocean',    // North Sea — 15 miles west
    elevation: -11,        // EHAM (Schiphol) — below sea level, in a drained lake basin
    notes: 'Schiphol is one of the few major airports in the world with a negative elevation (-11 ft) — sitting in a drained lake basin (Haarlemmermeer) with exceptional North Sea exposure. North Sea maritime influence is strong and suppresses temperature extremes significantly; the coast is only 15 miles west. ECMWF IFS (Reading HQ ~200 miles south) has exceptional skill over the Netherlands. Summer heat waves require a blocking anticyclone to overcome maritime cooling — models underestimate peak heat during prolonged blocks. Cold north-sea air intrusions in spring cause rapid cooling that GFS handles less reliably than IFS.',
  },

  'munich': {
    uhi:       3.5,
    coastal:   null,
    elevation: 1738,       // EDDM (Munich Intl) — NE of city, Bavarian Plain
    notes: 'Munich Intl sits at 1,738 ft on the Bavarian Plain northeast of the city. Continental climate with Alpine influence from the south. Föhn wind events (warm, dry downslope air from the Alps) cause rapid temperature rises of 10–15°F and are consistently underestimated by models in both timing and magnitude — the most reliable source of forecast error here. ICON, developed by the German Weather Service (DWD), has a well-documented skill advantage over GFS in Bavaria and the Alpine forelands; use ICON as the primary reference. IFS also performs well. Winter inversions trap cold air in the Munich basin, suppressing daytime highs below model predictions.',
  },

  'milan': {
    uhi:       4.0,
    coastal:   null,
    elevation: 768,        // LIMC (Malpensa) — 25 miles NW of city centre, Po Valley
    notes: 'Malpensa is 25 miles northwest of central Milan on the Po Plain. The Po Valley is enclosed by the Alps to the north and Apennines to the south, creating a basin that traps heat in summer and cold air in winter. Dense autumn/winter fog (nebbia) is a regional signature — cloud cover suppresses daytime highs below model predictions on foggy days. Alpine föhn from the north causes rapid warming events that models underestimate. ECMWF IFS and ICON both have strong skill over northern Italy. Summer heat waves in the Po Valley can be extreme; the enclosed basin amplifies urban heat.',
  },

  'warsaw': {
    uhi:       3.5,
    coastal:   null,       // Baltic Sea ~350 miles north
    elevation: 360,        // EPWA (Chopin Intl) — southern suburbs, 6 miles from city centre
    notes: 'Chopin Intl is just 6 miles south of central Warsaw — one of the closer airport-to-city offsets in this profile set, reducing station bias. Humid continental climate (Dfb) with strong seasonal contrast: very cold Siberian winters and warm summers. Cold wave onset from Siberian High is well-forecast by all models at 3–4 day range. Summer heat waves driven by central European blocking are increasingly common and moderately well-forecast by IFS. ECMWF IFS has strong skill over Central Europe. ICON is the secondary reference. GFS skill drops notably for Central European blocking patterns.',
  },

  'moscow': {
    uhi:       5.0,
    coastal:   null,       // Over 1,000 miles from any coast
    elevation: 623,        // UUEE (Sheremetyevo) — 18 miles N of city centre
    notes: 'Sheremetyevo is 18 miles north of the Kremlin — Moscow\'s urban heat island is one of Europe\'s strongest, with the city core running 5–7°F warmer. Humid continental climate with the most severe winter cold of any city in this profile set; Siberian anticyclone outbreaks can push temperatures to -22°F / -30°C. Cold wave onset and depth are both well-forecast at 3–5 day range. Summer blocking events cause extreme heat (2010 set an all-time record) — omega-block patterns are the primary model uncertainty, with all models tending to underestimate peak heat duration. ECMWF IFS has strong skill over Russia. HRRR does not cover Russia.',
  },

  'buenos aires': {
    uhi:       4.0,
    coastal:   'bay',      // Río de la Plata estuary
    elevation: 66,         // SAEZ (Ezeiza Intl) — 22 miles SW of city centre
    notes: 'Ezeiza Intl is 22 miles southwest of Buenos Aires city centre. Humid subtropical climate (Cfa) moderated by the Río de la Plata estuary. Pampero wind events — cold, dry southerly surges from Patagonia — cause rapid temperature drops of 15–25°F and are the primary source of forecast error: models underestimate both speed and magnitude of temperature fall. Sudestada (southeast wind with rain and cooling) is the second-most important local wind pattern. ECMWF IFS outperforms GFS in the Southern Hemisphere. HRRR does not cover Argentina. GFS skill drops more sharply beyond day 5 over South America.',
  },

  'lagos': {
    uhi:       3.5,
    coastal:   'ocean',    // Bight of Benin / Gulf of Guinea
    elevation: 135,        // DNMM (Murtala Muhammed Intl) — 14 miles NE of Lagos Island
    notes: 'Murtala Muhammed Intl is 14 miles northeast of Lagos Island. Tropical wet/dry climate with two distinct seasons: wet season (April–October) with persistent cloud cover that suppresses temperature variability, and dry season (November–March) dominated by the Harmattan — a dry, dusty NE wind from the Sahara that reduces humidity and increases diurnal temperature range. Temperature thresholds are structurally more reachable during the dry season than the wet. Model skill over tropical West Africa is substantially lower than over Europe or North America; all model outputs carry higher inherent uncertainty here. HRRR does not cover Africa.',
  },

  'cape town': {
    uhi:       2.5,
    coastal:   'ocean',    // Atlantic Ocean / False Bay
    elevation: 151,        // FACT (Cape Town Intl) — 14 miles SE of city centre
    notes: 'Cape Town Intl sits 14 miles southeast of the city bowl, between the Atlantic and False Bay. Mediterranean climate (Csa) with hot dry summers and mild wet winters — opposite seasonal pattern to Northern Hemisphere cities at similar latitudes. The Cape Doctor (persistent SE wind, September–March) suppresses summer afternoon high temperatures significantly; models tend to underestimate cooling from this sea breeze. The Benguela Current (cold Atlantic upwelling) keeps sea surface temperatures below 60°F year-round and moderates coastal temperatures. ECMWF IFS outperforms GFS in the Southern Hemisphere. HRRR does not cover South Africa.',
  },

  'nairobi': {
    uhi:       3.0,
    coastal:   null,       // Indian Ocean ~330 miles east — negligible direct influence
    elevation: 5327,       // HKJK (Jomo Kenyatta Intl) — SE suburb, 9 miles from city centre
    notes: 'Jomo Kenyatta Intl sits at 5,327 ft on the Kenyan Highlands — this high elevation compresses both absolute temperatures and daily range. Tropical highland climate (Cwb) with two rainy seasons: long rains (March–May) and short rains (October–December). Year-round temperatures are remarkably stable (60–80°F typical range) making threshold trades at extremes structurally high-risk. GFS cold bias at elevation applies here — similar amplification to Mexico City. Model skill in equatorial East Africa is limited; ECMWF IFS is the most reliable reference but uncertainty is structurally higher than temperate-zone cities. HRRR does not cover Africa.',
  },

  'kuala lumpur': {
    uhi:       3.5,
    coastal:   null,       // Strait of Malacca ~25 miles west — some indirect influence
    elevation: 69,         // WMKK (KLIA) — 45 miles south of city centre in Sepang
    notes: 'KLIA is 45 miles south of Kuala Lumpur city centre in Sepang — the largest city-to-airport offset in this profile set. Equatorial climate (Af) with year-round high temperatures and very limited variability — similar caution to Singapore for threshold trades. Two monsoon seasons modulate rainfall but cause limited temperature swings: SW monsoon (May–September) and NE monsoon (November–March). Afternoon convection reliably caps highs during wet periods via cloud shading. ECMWF IFS and AIFS both perform better than GFS in equatorial SE Asia. Long-range forecasts (5+ days) have very low skill at temperature thresholds. HRRR does not cover Malaysia.',
  },

  // ─── International cities (Batch 3) ──────────────────────────────────────────

  'taipei': {
    uhi:       4.0,
    coastal:   'ocean',    // Taiwan Strait (west) / Pacific (east)
    elevation: 106,        // RCTP (Taoyuan Intl) — 25 miles SW of downtown Taipei
    notes: 'RCTP is 25 miles southwest of downtown Taipei in Taoyuan county — outside the Taipei basin that traps heat in summer. Subtropical maritime climate (Cfa). Typhoon season (May–November, peak August–September) causes sharp model divergence; ECMWF IFS outperforms GFS on western Pacific typhoon tracks. Plum rain season (May–June) suppresses temperatures below climatology via persistent stratiform cloud. The Taipei basin topography amplifies UHI in the city core — RCTP reads cooler than central Taipei during calm summer nights. HRRR does not cover Taiwan.',
  },

  'shanghai': {
    uhi:       5.0,
    coastal:   'ocean',    // East China Sea / Yangtze River delta
    elevation: 13,         // ZSPD (Pudong Intl) — reclaimed land 19 miles east of city centre
    notes: 'Pudong Intl is on reclaimed land 19 miles east of the Bund at the Yangtze delta — the city core runs 5–6°F warmer due to one of Asia\'s largest urban heat islands. Humid subtropical climate (Cfa). East Asian summer monsoon brings plum rains in June–July followed by an intense heat period in July–August. Typhoon season (May–November) with greatest impact July–September; ECMWF IFS outperforms GFS on western Pacific track prediction. Strong westerly flow from the interior drives summer heat episodes that exceed what the coastal position would suggest. HRRR does not cover China.',
  },

  'helsinki': {
    uhi:       3.0,
    coastal:   'bay',      // Gulf of Finland / Baltic Sea
    elevation: 179,        // EFHK (Helsinki-Vantaa) — 12 miles north of city centre
    notes: 'Vantaa airport is 12 miles north of central Helsinki. The highest-latitude city in this profile set — extreme seasonal daylight variation strongly influences temperature patterns. Gulf of Finland moderates coastal temperatures; winter sea ice temporarily reduces the maritime effect. ECMWF IFS has strong skill over Scandinavia. Cold season (November–March) cold waves from the Siberian anticyclone are well-forecast. Summer can bring surprising warmth during blocking high events that models underestimate due to Arctic amplification patterns.',
  },

  'ankara': {
    uhi:       4.0,
    coastal:   null,       // Landlocked Anatolian Plateau
    elevation: 3127,       // LTAC (Esenboğa Intl) — 18 miles north of city centre
    notes: 'Esenboğa airport sits at 3,127 ft on the Anatolian Plateau, 18 miles north of central Ankara. Semi-arid continental climate (BSk) with extreme seasonal contrast — hotter than Istanbul in summer, considerably colder in winter. GFS cold bias at elevation (documented at Denver 5,431 ft and Madrid 1,998 ft) applies here. Strong winter cold from the Siberian anticyclone is well-forecast. Summer heat is variable but elevated plateau amplifies diurnal swings. ECMWF IFS performs well over Anatolia. Do not conflate with Istanbul — these are structurally different climates despite being in the same country.',
  },

  'wellington': {
    uhi:       2.0,
    coastal:   'ocean',    // Cook Strait / Tasman Sea / Pacific
    elevation: 41,         // NZWN (Wellington Intl) — south end of the city, near CBD
    notes: 'Wellington airport is at the southern tip of the city on Cook Strait — one of the world\'s windiest straits, generating persistent strong winds (the "Windy Wellington" moniker is meteorologically accurate). Persistent wind suppresses temperature extremes making threshold trades structurally higher-risk than other maritime cities. Temperature extremes are rarely reached in either direction. ECMWF IFS outperforms GFS in the Southern Hemisphere. HRRR does not cover New Zealand. Seasonal calendar is reversed relative to Northern Hemisphere — January is midsummer.',
  },

  'jeddah': {
    uhi:       3.5,
    coastal:   'bay',      // Red Sea
    elevation: 48,         // OEJN (King Abdulaziz Intl) — ~30 miles north of city centre
    notes: 'King Abdulaziz Intl is ~30 miles north of central Jeddah. Hot desert climate (BWh) with year-round extreme heat — summer temperatures (104–113°F / 40–45°C) are among the most consistently predictable of any city in this profile set due to stable high-pressure dominance. Red Sea proximity adds persistent humidity that distinguishes Jeddah from interior Saudi cities (Riyadh, Mecca) — humid heat rather than purely dry. Haboob (dust storm) events from the Arabian interior occasionally suppress solar heating. GFS and IFS agree closely given synoptic stability. HRRR does not cover Saudi Arabia.',
  },

  'bangkok': {
    uhi:       4.5,
    coastal:   null,       // Gulf of Thailand ~30 miles south
    elevation: 5,          // VTBS (Suvarnabhumi Intl) — 25 miles east of city centre
    notes: 'Suvarnabhumi is 25 miles east of central Bangkok — city core runs 4–6°F warmer due to intense urban density and limited green space. Tropical wet/dry climate (Aw) with three seasons: hot dry (March–May), SW monsoon (May–October), cool dry (November–February). Persistent cloud cover during the SW monsoon caps temperature peaks — models frequently overestimate summer highs when active convection initiates earlier than forecast. Cool season (November–February) temperatures are the most predictable. ECMWF IFS performs better than GFS in tropical SE Asia. HRRR does not cover Thailand.',
  },

  'vienna': {
    uhi:       3.5,
    coastal:   null,
    elevation: 600,        // LOWW (Vienna Intl / Schwechat) — 11 miles SE of city centre
    notes: 'Vienna Intl (Schwechat) is 11 miles southeast of the Ringstrasse. Humid continental climate (Dfb) with Pannonian plain influence — drier and with greater temperature extremes than western European cities at comparable latitude. Danube valley provides a cold-air drainage corridor in winter that suppresses overnight lows below model predictions. ECMWF IFS and ICON (DWD) both perform very well over Austria. Föhn wind events from the Alps via the Wienerwald can rapidly warm the city in spring — onset timing is the primary model uncertainty, similar to Munich.',
  },

  'zurich': {
    uhi:       3.0,
    coastal:   null,
    elevation: 1416,       // LSZH (Zurich Airport) — 8 miles NE of city centre
    notes: 'Zurich airport sits at 1,416 ft on the Swiss Plateau, 8 miles northeast of the city. Alpine continental climate with significant orographic influence. ICON (co-developed with MeteoSchweiz) is the primary model reference for Switzerland and has a documented skill advantage here. IFS also strong. Föhn events from the Alps cause rapid warming of 10–15°F — onset timing is the primary model uncertainty. Winter high-pressure inversions trap cold foggy air on the plateau below 2,000–3,000 ft, suppressing daytime highs significantly below model predictions that do not resolve the inversion layer.',
  },

  'dubai': {
    uhi:       4.0,
    coastal:   'bay',      // Persian Gulf
    elevation: 62,         // OMDB (Dubai Intl) — embedded in the urban core
    notes: 'Dubai Intl is embedded within the urban area and captures significant UHI directly, reducing the city-to-airport offset. Hot desert climate (BWh) with summer temperatures among the world\'s most extreme for a major city (113–120°F / 45–49°C). Persian Gulf sea surface temperatures drive elevated humidity that makes Dubai significantly hotter in apparent terms than interior desert cities. Summer high-pressure dominance means model agreement is strong for synoptic-scale patterns. Shamal wind events (dry NW wind from Arabia) occasionally cause rapid temperature rises with dust; haboob-related cooling is underestimated by models. HRRR does not cover UAE.',
  },

};

// ─── Public API ───────────────────────────────────────────────────────────────

// Common aliases Polymarket uses in market titles that differ from our profile keys.
// Add entries here whenever a new city name variant appears in market questions.
const CITY_ALIASES = {
  'new york city':  'new york',
  'nyc':            'new york',
  'ny':             'new york',
  'la':             'los angeles',
  'chi':            'chicago',
  'phx':            'phoenix',
  'pdx':            'portland',
  'cdg':            'paris',       // airport code sometimes used in API responses
};

/**
 * Look up a city profile by name (case-insensitive, alias-aware).
 * Returns null for cities not in the table.
 *
 * @param {string} cityName  e.g. 'new york', 'New York City', 'NYC'
 * @returns {{ uhi, coastal, elevation, notes }|null}
 */
function getCityProfile(cityName) {
  if (!cityName) return null;
  const key = cityName.toLowerCase().trim();
  return CITY_PROFILES[CITY_ALIASES[key] ?? key] || null;
}

/**
 * Normalise a city name to the canonical profile key.
 * Used by weekly-report.js when writing bias-corrections.json.
 *
 * @param {string} cityName
 * @returns {string}
 */
function normaliseCityKey(cityName) {
  if (!cityName) return cityName;
  const key = cityName.toLowerCase().trim();
  return CITY_ALIASES[key] ?? key;
}

module.exports = { CITY_PROFILES, getCityProfile, normaliseCityKey };
