// =============================================================================
// weather-display — Cloudflare Worker
// =============================================================================
// Fetches weather data from NWS and AirNow, and renders a full-screen HTML
// weather display page for fire station display boards.
//
// Layout variants (controlled via ?layout= URL parameter):
//   wide  — Radar map (left) + conditions panel (right) + 12-hour strip (bottom)
//   full  — Same as wide but taller (1920×1075). All sections expand slightly.
//   split — Either radar map OR conditions panel, full width. ?view=radar|conditions
//   tri   — Same as split but narrower. ?view=radar|conditions
//
// For split/tri layouts, the ?view= parameter selects which half is shown:
//   ?layout=split&view=radar      — full-width animated radar map
//   ?layout=split&view=conditions — full-width conditions + 3-day forecast
//   Default view when omitted: conditions
//
// Data sources (all free, no authentication except AirNow):
//   Current conditions  — NWS /stations/KFAR/observations/latest
//   Feels-like temp     — NWS /gridpoints/FGF/65,57 (apparentTemperature layer)
//   Daily forecast      — NWS /gridpoints/FGF/65,57/forecast
//   Hourly forecast     — NWS /gridpoints/FGF/65,57/forecast/hourly
//   Active alerts       — NWS /alerts/active?zone=NDZ039
//   AQI                 — EPA AirNow API (requires AIRNOW_API_KEY secret)
//   Sunrise / Sunset    — Calculated mathematically (no API needed)
//   Radar frame paths   — RainViewer public API (server-side; no auth required)
//   Radar tiles         — RainViewer tile CDN (fetched client-side by Leaflet)
//   Base map tiles      — OpenStreetMap via Leaflet CDN (fetched client-side)
//
// Radar source note:
//   NOAA nowCOAST was the original radar source but was abandoned: it returns
//   403 Forbidden from Cloudflare datacenter IPs (server-side) AND enforces a
//   CORS block on browser requests (client-side). Both paths are blocked with no
//   viable workaround. RainViewer's public API has neither restriction. Their
//   free tier covers personal/non-commercial use; public safety use is generally
//   accepted.
//
// Caching:
//   - Rendered HTML cached per layout+view in Workers Cache API for CACHE_SECONDS.
//   - NWS and AirNow responses edge-cached with per-source TTLs.
//   - Cache-Control: no-store on HTML responses; browser caching is suppressed.
//   - Increment CACHE_VERSION to immediately invalidate all cached pages.
//
// AQI graceful degradation:
//   - If AIRNOW_API_KEY secret is absent or empty, AQI is silently omitted.
//   - All other weather data renders normally without the key.
//
// Security:
//   - AIRNOW_API_KEY stored as a Cloudflare Worker secret — never in code.
//   - NWS_USER_AGENT stored as a plain wrangler.toml [vars] entry (not sensitive).
//   - URL parameters sanitized before use.
//   - All dynamic content HTML-escaped before page injection.
//   - No X-Frame-Options header — loaded as full-screen iframe by display system.
//   - Radar tile requests made client-side directly to RainViewer CDN (no proxying needed).
// =============================================================================


// =============================================================================
// CONFIGURATION — edit values in this section only for routine changes.
// =============================================================================

// Display location
const DISPLAY_CITY   = 'Fargo, ND';
const LOCATION_LAT   =  46.8772;    // Used for radar center + sunrise/sunset math
const LOCATION_LON   = -96.7898;

// NWS grid parameters for Fargo, ND.
// Verified via: https://api.weather.gov/points/46.8772,-96.7898
// These values are static and do not differ between fire stations within Fargo.
const NWS_OFFICE     = 'FGF';
const NWS_GRID_X     =  65;
const NWS_GRID_Y     =  57;
const NWS_ALERT_ZONE = 'NDZ039';    // Cass County, ND
const NWS_STATION    = 'KFAR';      // Fargo Hector International Airport

// Forecast display
const FORECAST_DAYS  = 3;    // number of days in the 3-day forecast
const HOURLY_COUNT   = 12;   // number of hourly slots in the bottom strip

// Radar animation (client-side)
const RADAR_FRAME_COUNT = 12;    // max number of radar frames to animate
const RADAR_ZOOM        =  8;    // Leaflet zoom level (~75 mi radius); adjust after hardware test
const RADAR_FRAME_MS    =  600;  // milliseconds per historical frame
const RADAR_HOLD_MS     = 2500;  // milliseconds to hold the latest frame before looping
const RADAR_OPACITY     =  0.7;  // radar overlay opacity (0–1)

// SVG icon sizes (px) — precomputed at module load; changing requires re-deploy
const ICON_SIZE_LG   = 36;   // current conditions icon (large)
const ICON_SIZE_SM   = 22;   // forecast rows + hourly strip icons

// Cache TTLs (seconds)
const CACHE_SECONDS        =  300;   // page cache + meta-refresh interval
const CACHE_VERSION        =    5;   // increment to invalidate all cached pages
const NWS_CONDITIONS_TTL   =  300;   // current observations (station updates ~hourly)
const NWS_GRIDDATA_TTL     =  300;   // apparent temperature from gridpoints
const NWS_FORECAST_TTL     = 1800;   // daily + hourly forecast (~4 updates/day)
const NWS_ALERTS_TTL       =  120;   // active alerts (safety-critical; short TTL)
const AQI_TTL              =  900;   // AirNow AQI (updates hourly)
const RAINVIEWER_TTL       =   60;   // RainViewer frame list (new frames every ~10 min)

// Layout pixel dimensions — must match all other station Workers exactly.
const LAYOUTS = {
  full:  { width: 1920, height: 1075 },
  wide:  { width: 1735, height: 720  },
  split: { width: 852,  height: 720  },
  tri:   { width: 558,  height: 720  },
};

// Conditions panel width (px) for wide/full layouts. Remainder goes to radar.
const CONDITIONS_WIDTH = { full: 520, wide: 460 };

// Hourly strip height (px) for wide/full layouts.
const HOURLY_HEIGHT = { full: 100, wide: 80 };

// Default values
const DEFAULT_LAYOUT     = 'wide';
const DEFAULT_VIEW_SMALL = 'conditions';  // default ?view= for split/tri
const ERROR_RETRY_SECONDS = 60;


// =============================================================================
// SVG WEATHER ICONS — precomputed at module load (zero cost per request)
// =============================================================================
// All SVG strings are built once when the Worker module initialises and stored
// as constants. No string construction occurs during request handling.
// Two sets are built: WX_LG (large, for current conditions) and
// WX_SM (small, for forecast rows and the hourly strip).

function _buildIconSet(s) {
  const op = '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s +
             '" viewBox="0 0 24 24" style="display:block;flex-shrink:0;">';
  const cl = '</svg>';

  // Sun: filled circle + 8 short rays
  const SUNNY = op +
    '<circle cx="12" cy="12" r="4.5" fill="#f0c040"/>' +
    '<line x1="12" y1="2"  x2="12" y2="5"  stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="12" y1="19" x2="12" y2="22" stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="2"  y1="12" x2="5"  y2="12" stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="19" y1="12" x2="22" y2="12" stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="4.9"  y1="4.9"  x2="7.1"  y2="7.1"  stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="16.9" y1="16.9" x2="19.1" y2="19.1" stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="16.9" y1="7.1"  x2="19.1" y2="4.9"  stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="4.9"  y1="19.1" x2="7.1"  y2="16.9" stroke="#f0c040" stroke-width="2" stroke-linecap="round"/>' +
    cl;

  // Mostly sunny: offset sun + small overlapping cloud
  const MOSTLY_SUNNY = op +
    '<circle cx="9" cy="9" r="3.5" fill="#f0c040"/>' +
    '<line x1="9" y1="2"    x2="9" y2="4.5"  stroke="#f0c040" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="9" y1="13.5" x2="9" y2="16"   stroke="#f0c040" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="2" y1="9"    x2="4.5" y2="9"  stroke="#f0c040" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="13.5" y1="9" x2="16"  y2="9"  stroke="#f0c040" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="3.8"  y1="3.8"  x2="5.5" y2="5.5"   stroke="#f0c040" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="12.5" y1="12.5" x2="14.2" y2="14.2"  stroke="#f0c040" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M10 16 a4 4 0 0 1 8 0 a2.5 2.5 0 0 1 0 5 H10 a3 3 0 0 1 0-5Z" fill="#5b7a94"/>' +
    cl;

  // Partly cloudy: sun peeking behind a larger cloud
  const PARTLY_CLOUDY = op +
    '<circle cx="8" cy="8" r="3" fill="#c8a830"/>' +
    '<line x1="8" y1="2"  x2="8" y2="4"  stroke="#c8a830" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="8" y1="12" x2="8" y2="14" stroke="#c8a830" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="2" y1="8"  x2="4" y2="8"  stroke="#c8a830" stroke-width="1.8" stroke-linecap="round"/>' +
    '<line x1="12" y1="8" x2="14" y2="8" stroke="#c8a830" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M8 15 a5 5 0 0 1 10 0 a3 3 0 0 1 0 6 H8 a4 4 0 0 1 0-6Z" fill="#4a6880"/>' +
    cl;

  // Mostly cloudy: small sun peek + large dominant cloud
  const MOSTLY_CLOUDY = op +
    '<circle cx="7" cy="7" r="2.5" fill="#c8a830" opacity="0.8"/>' +
    '<path d="M6 13 a6 6 0 0 1 12 0 a3.5 3.5 0 0 1 0 7 H6 a4.5 4.5 0 0 1 0-7Z" fill="#4a6880"/>' +
    '<path d="M4 16 a4 4 0 0 1 8 0 a2.5 2.5 0 0 1 0 5 H4 a3 3 0 0 1 0-5Z" fill="#5b7a94"/>' +
    cl;

  // Cloudy: two overlapping cloud shapes, no sun
  const CLOUDY = op +
    '<path d="M5 14 a6 6 0 0 1 12 0 a3.5 3.5 0 0 1 0 7 H5 a4.5 4.5 0 0 1 0-7Z" fill="#4a6880"/>' +
    '<path d="M3 17 a4 4 0 0 1 8 0 a2.5 2.5 0 0 1 0 5 H3 a3 3 0 0 1 0-5Z" fill="#5b7a94"/>' +
    cl;

  // Rain: cloud + 3 angled rain lines
  const RAIN = op +
    '<path d="M4 10 a6 6 0 0 1 12 0 a3.5 3.5 0 0 1 0 7 H4 a4.5 4.5 0 0 1 0-7Z" fill="#4a6880"/>' +
    '<line x1="7"  y1="19" x2="5"  y2="23" stroke="#60b0f0" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="12" y1="19" x2="10" y2="23" stroke="#60b0f0" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="17" y1="19" x2="15" y2="23" stroke="#60b0f0" stroke-width="2" stroke-linecap="round"/>' +
    cl;

  // Drizzle: cloud + light, numerous short lines
  const DRIZZLE = op +
    '<path d="M4 10 a6 6 0 0 1 12 0 a3.5 3.5 0 0 1 0 7 H4 a4.5 4.5 0 0 1 0-7Z" fill="#4a6880"/>' +
    '<line x1="7"  y1="19" x2="6"  y2="22" stroke="#60b0f0" stroke-width="1.5" stroke-linecap="round"/>' +
    '<line x1="11" y1="19" x2="10" y2="22" stroke="#60b0f0" stroke-width="1.5" stroke-linecap="round"/>' +
    '<line x1="15" y1="19" x2="14" y2="22" stroke="#60b0f0" stroke-width="1.5" stroke-linecap="round"/>' +
    '<line x1="9"  y1="22" x2="8"  y2="24" stroke="#60b0f0" stroke-width="1.5" stroke-linecap="round"/>' +
    '<line x1="13" y1="22" x2="12" y2="24" stroke="#60b0f0" stroke-width="1.5" stroke-linecap="round"/>' +
    cl;

  // Snow: cloud + 5 small filled dots
  const SNOW = op +
    '<path d="M4 9 a6 6 0 0 1 12 0 a3.5 3.5 0 0 1 0 7 H4 a4.5 4.5 0 0 1 0-7Z" fill="#4a6880"/>' +
    '<circle cx="7"  cy="20" r="1.8" fill="#a8d8f0"/>' +
    '<circle cx="12" cy="18" r="1.8" fill="#a8d8f0"/>' +
    '<circle cx="17" cy="20" r="1.8" fill="#a8d8f0"/>' +
    '<circle cx="9"  cy="23" r="1.8" fill="#a8d8f0"/>' +
    '<circle cx="15" cy="23" r="1.8" fill="#a8d8f0"/>' +
    cl;

  // Wintry mix: cloud + alternating rain line and snow dot
  const WINTRY_MIX = op +
    '<path d="M4 9 a6 6 0 0 1 12 0 a3.5 3.5 0 0 1 0 7 H4 a4.5 4.5 0 0 1 0-7Z" fill="#4a6880"/>' +
    '<line x1="7"  y1="18" x2="6"  y2="22" stroke="#60b0f0" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="12" cy="20" r="2"   fill="#a0b0e0"/>' +
    '<line x1="17" y1="18" x2="16" y2="22" stroke="#60b0f0" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="9"  cy="23" r="1.8" fill="#a0b0e0"/>' +
    '<circle cx="15" cy="23" r="1.8" fill="#a0b0e0"/>' +
    cl;

  // Fog: three horizontal lines of decreasing width
  const FOG = op +
    '<line x1="2"  y1="12" x2="22" y2="12" stroke="#b0c4d4" stroke-width="2.5" stroke-linecap="round"/>' +
    '<line x1="2"  y1="16" x2="22" y2="16" stroke="#b0c4d4" stroke-width="2.5" stroke-linecap="round"/>' +
    '<line x1="6"  y1="20" x2="18" y2="20" stroke="#b0c4d4" stroke-width="2"   stroke-linecap="round"/>' +
    cl;

  // Wind: three curved horizontal lines
  const WIND = op +
    '<path d="M2 8 Q10 8 14 4 a4 4 0 0 1 4 4 a4 4 0 0 1-4 4 H2" fill="none" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M2 14 Q8 14 11 11 a3 3 0 0 1 3 3 a3 3 0 0 1-3 3 H2" fill="none" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="2" y1="19" x2="16" y2="19" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    cl;

  // Thunderstorm: dark cloud + lightning bolt
  const THUNDERSTORM = op +
    '<path d="M3 8 a6 6 0 0 1 12 0 a3.5 3.5 0 0 1 0 7 H3 a4.5 4.5 0 0 1 0-7Z" fill="#3a5068"/>' +
    '<polyline points="13,15 9,21 13,21 9,27" fill="none" stroke="#f0d040" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' +
    cl;

  // Default: simple thermometer shape
  const DEFAULT = op +
    '<rect x="10" y="3" width="4" height="13" rx="2" fill="#b0c4d4"/>' +
    '<circle cx="12" cy="18" r="4" fill="#b0c4d4"/>' +
    '<rect x="11" y="6"  width="2" height="9" fill="#0a0a0a"/>' +
    cl;

  return {
    SUNNY, MOSTLY_SUNNY, PARTLY_CLOUDY, MOSTLY_CLOUDY, CLOUDY,
    RAIN, DRIZZLE, SNOW, WINTRY_MIX, FOG, WIND, THUNDERSTORM, DEFAULT,
  };
}

// Precompute both icon sets at module load — zero per-request cost.
const WX_LG = _buildIconSet(ICON_SIZE_LG);
const WX_SM = _buildIconSet(ICON_SIZE_SM);

// Maps an NWS shortForecast string to the appropriate precomputed SVG icon.
// Checks are case-insensitive and ordered most-specific to least-specific to
// prevent broad matches (e.g. "rain") from shadowing specific ones (e.g. "freezing rain").
function getConditionIcon(shortForecast, iconSet) {
  if (!shortForecast) return iconSet.DEFAULT;
  const f = shortForecast.toLowerCase();
  if (f.includes('thunderstorm'))                              return iconSet.THUNDERSTORM;
  if (f.includes('blizzard') || f.includes('snow'))           return iconSet.SNOW;
  if (f.includes('freezing rain') || f.includes('freezing drizzle') ||
      f.includes('wintry mix')    || f.includes('sleet'))     return iconSet.WINTRY_MIX;
  if (f.includes('rain') || f.includes('shower'))             return iconSet.RAIN;
  if (f.includes('drizzle'))                                   return iconSet.DRIZZLE;
  if (f.includes('fog')   || f.includes('haze') ||
      f.includes('smoke') || f.includes('mist'))              return iconSet.FOG;
  if (f.includes('blustery') || f.includes('windy') ||
      f.includes('breezy'))                                    return iconSet.WIND;
  if (f.includes('mostly cloudy'))                             return iconSet.MOSTLY_CLOUDY;
  if (f.includes('partly cloudy') || f.includes('partly sunny')) return iconSet.PARTLY_CLOUDY;
  if (f.includes('mostly sunny')  || f.includes('mostly clear'))  return iconSet.MOSTLY_SUNNY;
  if (f.includes('sunny') || f.includes('clear'))             return iconSet.SUNNY;
  if (f.includes('cloudy') || f.includes('overcast'))         return iconSet.CLOUDY;
  return iconSet.DEFAULT;
}


// =============================================================================
// MAIN WORKER ENTRY POINT
// =============================================================================

export default {
  async fetch(request, env) {

    // Reject non-GET requests with a generic error to reduce attack surface.
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Parse and validate URL parameters before the try block so the error
    // page renderer always has a valid layout to fall back to.
    const url         = new URL(request.url);
    const layoutParam = sanitizeParam(url.searchParams.get('layout')) || DEFAULT_LAYOUT;
    const layoutKey   = (layoutParam in LAYOUTS) ? layoutParam : DEFAULT_LAYOUT;
    const layout      = LAYOUTS[layoutKey];

    const isSmall     = (layoutKey === 'split' || layoutKey === 'tri');
    const viewParam   = sanitizeParam(url.searchParams.get('view')) || DEFAULT_VIEW_SMALL;
    // Treat any value other than 'conditions' as 'radar'.
    const viewKey     = (viewParam === 'conditions') ? 'conditions' : 'radar';

    // Build a versioned cache key that incorporates layout and (for small
    // layouts) the view. Wide/full always render both components, so view
    // is not part of their cache key.
    const cacheKeyUrl = 'https://weather-display-cache.internal/v' + CACHE_VERSION +
      '/' + layoutKey + (isSmall ? '-' + viewKey : '');
    const cache    = caches.default;
    const cacheReq = new Request(cacheKeyUrl, { method: 'GET' });

    const cached = await cache.match(cacheReq);
    if (cached) return cached;

    try {
      const now = new Date();

      // Determine which data sources are needed for this layout+view combination.
      // Avoid unnecessary fetches: radar-only views skip all weather data;
      // conditions-only views skip radar frames.
      const needsWeather = !isSmall || viewKey === 'conditions';
      const needsRadar   = !isSmall || viewKey === 'radar';

      // Fetch all required data in parallel to minimise total latency.
      // Unneeded fetches resolve immediately with null so the destructuring
      // pattern stays consistent regardless of layout.
      const [
        obsData,
        gridData,
        dailyPeriods,
        hourlyPeriods,
        alertFeatures,
        aqiData,
        radarFrames,
      ] = await Promise.all([
        needsWeather ? fetchNwsObservations(env.NWS_USER_AGENT) : Promise.resolve(null),
        needsWeather ? fetchNwsGridData(env.NWS_USER_AGENT)     : Promise.resolve(null),
        needsWeather ? fetchNwsDaily(env.NWS_USER_AGENT)        : Promise.resolve(null),
        needsWeather ? fetchNwsHourly(env.NWS_USER_AGENT)       : Promise.resolve(null),
        fetchNwsAlerts(env.NWS_USER_AGENT),   // always fetched — alert banner on all views
        needsWeather ? fetchAirNowAqi(env.AIRNOW_API_KEY) : Promise.resolve(null),
        needsRadar   ? fetchRainViewerFrames()             : Promise.resolve(null),
      ]);

      // Process raw API responses into display-ready objects.
      // Each processor returns null-safe results — missing data is handled gracefully.
      const wx       = processObservations(obsData);
      const apparent = getApparentTemp(gridData, now);
      const daily    = buildDailyForecast(dailyPeriods, FORECAST_DAYS);
      const hourly   = buildHourlySlots(hourlyPeriods, now, HOURLY_COUNT);
      const alerts   = processAlerts(alertFeatures, now);
      const aqi      = processAqi(aqiData);
      const sunTimes = calcSunriseSunset(now, LOCATION_LAT, LOCATION_LON);

      // Render the appropriate HTML page for this layout+view.
      let html;
      if (isSmall && viewKey === 'radar') {
        html = renderRadarOnly(radarFrames, alerts, layout, layoutKey);
      } else if (isSmall && viewKey === 'conditions') {
        html = renderConditionsOnly(
          wx, apparent, daily, alerts, aqi, sunTimes, layout, layoutKey
        );
      } else {
        html = renderFullPage(
          wx, apparent, daily, hourly, alerts, aqi, sunTimes,
          radarFrames, layout, layoutKey
        );
      }

      // Return the response to the display without browser caching.
      const response = new Response(html, {
        status: 200,
        headers: {
          'Content-Type':           'text/html; charset=utf-8',
          'Cache-Control':          'no-store',
          'X-Content-Type-Options': 'nosniff',
          // NOTE: X-Frame-Options intentionally omitted — this Worker is loaded
          // as a full-screen iframe. Adding SAMEORIGIN causes white error screens.
        },
      });

      // Store a separately-headered copy in the Workers Cache API.
      // The public max-age here controls the Worker cache TTL only and does
      // NOT reach the display browser (which sees no-store above).
      const toCache = new Response(html, {
        status: 200,
        headers: {
          'Content-Type':           'text/html; charset=utf-8',
          'Cache-Control':          'public, max-age=' + CACHE_SECONDS,
          'X-Content-Type-Options': 'nosniff',
        },
      });
      await cache.put(cacheReq, toCache);

      return response;

    } catch (err) {
      console.error('Worker unhandled error:', err);
      return renderErrorPage('A system error occurred. Retrying shortly.', layout);
    }
  },
};


// =============================================================================
// NWS DATA FETCHING
// =============================================================================
// All fetch functions follow the same pattern:
//   - Include a User-Agent header (required by NWS for all API requests).
//   - Use cf.cacheTtl to let Cloudflare's edge cache hold responses, reducing
//     how often the Worker contacts api.weather.gov.
//   - Return null on any error so callers degrade gracefully rather than
//     returning an error page to the display.

// Fetches the latest surface observation from the KFAR weather station.
// Returns the properties object or null on failure.
async function fetchNwsObservations(userAgent) {
  const url = 'https://api.weather.gov/stations/' + NWS_STATION + '/observations/latest';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_CONDITIONS_TTL },
    });
    if (!res.ok) {
      console.error('NWS observations fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return data.properties || null;
  } catch (e) {
    console.error('NWS observations error:', e);
    return null;
  }
}

// Fetches the gridpoints data for the Fargo grid cell.
// Used to retrieve the apparentTemperature (feels-like) time series.
// Returns the full properties object or null on failure.
async function fetchNwsGridData(userAgent) {
  const url = 'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_GRIDDATA_TTL },
    });
    if (!res.ok) {
      console.error('NWS griddata fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return data.properties || null;
  } catch (e) {
    console.error('NWS griddata error:', e);
    return null;
  }
}

// Fetches the 7-day daily forecast for the Fargo grid point.
// Returns the periods array or null on failure.
async function fetchNwsDaily(userAgent) {
  const url = 'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y + '/forecast';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_FORECAST_TTL },
    });
    if (!res.ok) {
      console.error('NWS daily forecast fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return (data.properties && data.properties.periods) ? data.properties.periods : null;
  } catch (e) {
    console.error('NWS daily forecast error:', e);
    return null;
  }
}

// Fetches the hourly forecast for the Fargo grid point.
// Returns the periods array or null on failure.
async function fetchNwsHourly(userAgent) {
  const url = 'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y + '/forecast/hourly';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_FORECAST_TTL },
    });
    if (!res.ok) {
      console.error('NWS hourly forecast fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return (data.properties && data.properties.periods) ? data.properties.periods : null;
  } catch (e) {
    console.error('NWS hourly forecast error:', e);
    return null;
  }
}

// Fetches active weather alerts for Cass County, ND (zone NDZ039).
// Returns the features array or null on failure.
async function fetchNwsAlerts(userAgent) {
  const url = 'https://api.weather.gov/alerts/active?zone=' + NWS_ALERT_ZONE;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_ALERTS_TTL },
    });
    if (!res.ok) {
      console.error('NWS alerts fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return (data.features && Array.isArray(data.features)) ? data.features : null;
  } catch (e) {
    console.error('NWS alerts error:', e);
    return null;
  }
}

// Fetches the current AQI from EPA AirNow for the Fargo area.
// Returns the raw observations array or null on failure or missing key.
// Gracefully omitted if AIRNOW_API_KEY is absent — no key, no AQI badge.
async function fetchAirNowAqi(apiKey) {
  if (!apiKey) return null;  // key not yet configured; omit silently
  const url = 'https://www.airnowapi.org/aq/observation/latLong/current/' +
    '?format=application/json' +
    '&latitude='  + LOCATION_LAT +
    '&longitude=' + LOCATION_LON +
    '&distance=25' +
    '&API_KEY=' + apiKey;
  try {
    const res = await fetch(url, {
      cf: { cacheTtl: AQI_TTL },
    });
    if (!res.ok) {
      console.error('AirNow AQI fetch failed (' + res.status + ')');
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('AirNow AQI error:', e);
    return null;
  }
}

// Fetches the list of available radar frames from the RainViewer public API.
// RainViewer allows server-side requests from datacenter IPs, and their tile CDN
// includes proper CORS headers for client-side Leaflet tile loading.
//
// Returns an array of frame objects { tileBase: String, time: Number } where:
//   tileBase — full CDN URL prefix for this frame, ready for Leaflet tile URL
//              construction. Append "/{z}/{x}/{y}/4/0_0.png" to get a tile URL.
//   time     — Unix timestamp in seconds (used for the on-screen time label)
//
// Tile URL colour scheme 4 = Meteored (closest to standard NWS radar palette).
// Options 0_0 = smooth:off, snow:off — the most universally supported setting.
//
// Returns null on any error so callers degrade gracefully.
async function fetchRainViewerFrames() {
  const url = 'https://api.rainviewer.com/public/weather-maps.json';
  try {
    const res = await fetch(url, {
      cf: { cacheTtl: RAINVIEWER_TTL },
    });
    if (!res.ok) {
      console.error('RainViewer fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();

    // data.radar.past is an ascending array of { time, path } objects.
    // data.host is the CDN base URL (e.g. "https://tilecache.rainviewer.com").
    if (!data.radar || !data.radar.past || !data.radar.past.length) {
      console.error('RainViewer: no past frames in response');
      return null;
    }

    const host   = data.host || 'https://tilecache.rainviewer.com';
    const frames = data.radar.past
      .slice(-RADAR_FRAME_COUNT)
      .map(function(f) {
        return {
          tileBase: host + f.path,   // full CDN prefix, e.g. ".../v2/radar/1744300800"
          time:     f.time,          // Unix seconds — for on-screen timestamp label
        };
      });

    return frames.length > 0 ? frames : null;
  } catch (e) {
    console.error('RainViewer error:', e);
    return null;
  }
}


// =============================================================================
// DATA PROCESSING
// =============================================================================

// Processes NWS observation properties into a flat display-ready object.
// All unit conversions are applied here. Returns an object with null fields
// for any values that are unavailable from the station.
//
// NWS observation units:
//   temperature, dewpoint, windChill, heatIndex: wmoUnit:degC → °F
//   windSpeed, windGust:  wmoUnit:km_h-1 → mph
//   windDirection:        wmoUnit:degree_(angle) (degrees, 0–360)
//   barometricPressure:   wmoUnit:Pa → mb (hPa)
//   visibility:           wmoUnit:m → miles
//   relativeHumidity:     wmoUnit:percent (already %)
function processObservations(props) {
  const result = {
    temp:      null, dewpoint: null, windDir:  null,
    windSpeed: null, windGust: null, pressure: null,
    visibility: null, humidity: null, condition: null,
  };
  if (!props) return result;

  result.temp       = nwsCToF(props.temperature);
  result.dewpoint   = nwsCToF(props.dewpoint);
  result.windDir    = degreesToCardinal(props.windDirection && props.windDirection.value);
  result.windSpeed  = nwsKmhToMph(props.windSpeed);
  result.windGust   = nwsKmhToMph(props.windGust);
  result.pressure   = nwsPaToMb(props.barometricPressure);
  result.visibility = nwsMToMi(props.visibility);
  result.humidity   = props.relativeHumidity ? Math.round(props.relativeHumidity.value) : null;
  result.condition  = props.textDescription  || null;
  return result;
}

// Extracts the apparent temperature (feels-like) for the current hour from
// the NWS gridpoints apparentTemperature layer.
// The gridpoints layer uses ISO 8601 duration intervals (e.g. "PT1H", "PT3H").
// Returns °F or null if unavailable.
function getApparentTemp(gridProps, now) {
  if (!gridProps || !gridProps.apparentTemperature ||
      !gridProps.apparentTemperature.values) return null;

  for (const entry of gridProps.apparentTemperature.values) {
    if (entry.value === null) continue;
    const parts = (entry.validTime || '').split('/');
    if (parts.length !== 2) continue;

    const start = new Date(parts[0]);
    const hours = parsePTHours(parts[1]);
    const end   = new Date(start.getTime() + hours * 3600000);

    if (now >= start && now < end) {
      // gridpoints temperature is always in degC
      return Math.round(entry.value * 9 / 5 + 32);
    }
  }
  return null;
}

// Parses an ISO 8601 duration string of the form "PTnH" (e.g. "PT1H", "PT3H").
// Returns the number of hours as an integer, defaulting to 1 on parse failure.
function parsePTHours(str) {
  if (!str) return 1;
  const m = str.match(/PT(\d+)H/);
  return m ? parseInt(m[1], 10) : 1;
}

// Builds the 3-day forecast array from NWS daily forecast periods.
// Each element: { dateStr, dayName, high, low, precip, shortForecast, hasBadge }
// hasBadge and badgeAlerts are populated later by processAlerts.
// Daytime periods supply the high temp and condition; nighttime supply the low.
// Edge case: if only a nighttime period exists for a date (daytime already
// passed), high is null and only the low is shown.
function buildDailyForecast(periods, count) {
  if (!periods) return [];

  const map = {};

  for (const p of periods) {
    const startDate = new Date(p.startTime);
    const dateStr   = toLocalDateStr(startDate);

    if (!map[dateStr]) {
      map[dateStr] = {
        dateStr,
        dayName:       formatDayName(startDate),
        high:          null,
        low:           null,
        precip:        null,
        shortForecast: null,
      };
    }

    const precip = (p.probabilityOfPrecipitation &&
                    p.probabilityOfPrecipitation.value !== null)
      ? p.probabilityOfPrecipitation.value
      : null;

    if (p.isDaytime) {
      map[dateStr].high          = p.temperature;
      map[dateStr].shortForecast = p.shortForecast;
      map[dateStr].precip        = precip;
    } else {
      map[dateStr].low = p.temperature;
      // Use nighttime condition only when no daytime period exists for this date.
      if (!map[dateStr].shortForecast) {
        map[dateStr].shortForecast = p.shortForecast;
        map[dateStr].precip        = precip;
      }
    }
  }

  // Return the next `count` calendar dates that have forecast data.
  return Object.values(map).slice(0, count);
}

// Builds the hourly strip slot array from NWS hourly forecast periods.
// Returns up to `count` slots starting from the current hour, each with:
//   { label, temp, precip, shortForecast }
// "NOW" is used as the label for the first (current) slot.
function buildHourlySlots(periods, now, count) {
  if (!periods) return [];

  // Floor to the start of the current UTC hour so the current period is included.
  const currentHourMs = now.getTime() - (now.getTime() % 3600000);

  const slots = [];
  for (const p of periods) {
    if (slots.length >= count) break;
    const pStart = new Date(p.startTime);
    if (pStart.getTime() < currentHourMs) continue;

    const isFirst = slots.length === 0;
    slots.push({
      label:         isFirst ? 'NOW' : formatHourLabel(pStart),
      temp:          p.temperature,
      precip:        (p.probabilityOfPrecipitation &&
                      p.probabilityOfPrecipitation.value !== null)
                       ? p.probabilityOfPrecipitation.value : null,
      shortForecast: p.shortForecast,
    });
  }
  return slots;
}

// Extracts today's high and tonight's low from the daily forecast periods.
// Scans the first few periods to find the next daytime high and nighttime low.
// Returns { high: Number|null, low: Number|null }.
function getDailyHiLo(periods) {
  if (!periods) return { high: null, low: null };
  let high = null, low = null;
  for (let i = 0; i < Math.min(periods.length, 6); i++) {
    if (periods[i].isDaytime  && high === null) high = periods[i].temperature;
    if (!periods[i].isDaytime && low  === null) low  = periods[i].temperature;
    if (high !== null && low !== null) break;
  }
  return { high, low };
}

// Processes raw NWS alert features into two arrays:
//   active  — alerts currently in effect (shown as full-width banners)
//   future  — alerts not yet started (shown as badges in the forecast section)
// Filters out test/cancelled alerts. Sorts active alerts by descending severity.
// Returns { active: [], future: [] }.
function processAlerts(features, now) {
  if (!features) return { active: [], future: [] };

  const active  = [];
  const future  = [];

  for (const f of features) {
    const p = f.properties;
    if (!p || p.status !== 'Actual' || p.messageType === 'Cancel') continue;

    const onset   = p.onset   ? new Date(p.onset)   : null;
    const expires = p.expires ? new Date(p.expires) : null;
    if (!onset || !expires) continue;
    if (expires <= now) continue;

    if (onset <= now) {
      active.push(p);
    } else {
      future.push(p);
    }
  }

  // Sort active alerts: extreme/severe first, then moderate, then minor.
  const ORDER = { extreme: 0, severe: 1, moderate: 2, minor: 3 };
  active.sort(function(a, b) {
    const sa = ORDER[(a.severity || '').toLowerCase()];
    const sb = ORDER[(b.severity || '').toLowerCase()];
    return (sa !== undefined ? sa : 4) - (sb !== undefined ? sb : 4);
  });

  return { active, future };
}

// Returns the alert banner severity class for CSS styling.
// extreme/severe → alert-warning (red), moderate → alert-watch (orange),
// minor/unknown  → alert-advisory (yellow).
function alertSeverityClass(severity) {
  const s = (severity || '').toLowerCase();
  if (s === 'extreme' || s === 'severe') return 'alert-warning';
  if (s === 'moderate')                  return 'alert-watch';
  return 'alert-advisory';
}

// Returns the forecast badge severity class for CSS styling.
function badgeSeverityClass(severity) {
  const s = (severity || '').toLowerCase();
  if (s === 'extreme' || s === 'severe') return 'badge-warning';
  if (s === 'moderate')                  return 'badge-watch';
  return 'badge-advisory';
}

// Processes AirNow observations array and returns the highest-AQI observation.
// Returns { aqi: Number, category: String, color: String, textColor: String }
// or null if no data is available.
function processAqi(observations) {
  if (!observations || !observations.length) return null;
  const best = observations.reduce(function(max, obs) {
    return (obs.AQI > (max ? max.AQI : -1)) ? obs : max;
  }, null);
  if (!best) return null;
  return {
    aqi:       best.AQI,
    parameter: best.ParameterName,
    category:  aqiCategory(best.AQI),
  };
}

// Maps an AQI integer to a display category object.
function aqiCategory(aqi) {
  if (aqi <= 50)  return { label: 'GOOD',          color: '#00c050', text: '#000' };
  if (aqi <= 100) return { label: 'MODERATE',       color: '#e8c800', text: '#000' };
  if (aqi <= 150) return { label: 'UNHEALTHY (SG)', color: '#ff7400', text: '#000' };
  if (aqi <= 200) return { label: 'UNHEALTHY',      color: '#e00000', text: '#fff' };
  if (aqi <= 300) return { label: 'VERY UNHEALTHY', color: '#7c2d8b', text: '#fff' };
  return               { label: 'HAZARDOUS',        color: '#5e001e', text: '#fff' };
}


// =============================================================================
// SUNRISE / SUNSET CALCULATION
// =============================================================================
// Computes sunrise and sunset times using the NOAA Solar Calculator algorithm.
// Pure math — no external API required.
// Returns { sunrise: Date, sunset: Date } or { sunrise: null, sunset: null }
// if the sun does not rise or set (polar night / midnight sun).
// Accurate to within ~1–2 minutes for Fargo's latitude, which is more than
// sufficient for display purposes.

function calcSunriseSunset(date, lat, lon) {
  const DEG = Math.PI / 180;
  const RAD = 180   / Math.PI;

  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();

  // Julian Day Number (noon UTC on the given date)
  const JD = 367 * y
    - Math.floor(7 * (y + Math.floor((m + 9) / 12)) / 4)
    + Math.floor(275 * m / 9)
    + d + 1721013.5 + 0.5;

  // Julian Century from J2000.0
  const T = (JD - 2451545.0) / 36525.0;

  // Geometric mean longitude (degrees, 0–360)
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;

  // Sun's mean anomaly (degrees)
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);

  // Sun's equation of center (degrees)
  const C = Math.sin(M * DEG) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * T)
          + Math.sin(3 * M * DEG) * 0.000289;

  // Sun's true longitude and apparent longitude
  const sunLon = L0 + C;
  const omega  = 125.04 - 1934.136 * T;
  const lambda = sunLon - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Mean and corrected obliquity of the ecliptic (degrees)
  const e0 = 23 + (26 + (21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const e  = e0 + 0.00256 * Math.cos(omega * DEG);

  // Sun's declination (degrees)
  const dec = Math.asin(Math.sin(e * DEG) * Math.sin(lambda * DEG)) * RAD;

  // Equation of time (minutes)
  const y2  = Math.tan((e * DEG) / 2) * Math.tan((e * DEG) / 2);
  const ecc = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const L0r = L0 * DEG;
  const Mr  = M  * DEG;
  const eot = 4 * RAD * (
    y2 * Math.sin(2 * L0r)
    - 2 * ecc * Math.sin(Mr)
    + 4 * ecc * y2 * Math.sin(Mr) * Math.cos(2 * L0r)
    - 0.5 * y2 * y2 * Math.sin(4 * L0r)
    - 1.25 * ecc * ecc * Math.sin(2 * Mr)
  );

  // Hour angle at sunrise / sunset
  // 90.833° accounts for solar disc radius (0.833°) and atmospheric refraction.
  const cosHA = Math.cos(90.833 * DEG) / (Math.cos(lat * DEG) * Math.cos(dec * DEG))
              - Math.tan(lat * DEG) * Math.tan(dec * DEG);

  if (cosHA >  1) return { sunrise: null, sunset: null }; // polar night
  if (cosHA < -1) return { sunrise: null, sunset: null }; // midnight sun

  const HA = Math.acos(cosHA) * RAD; // degrees

  // Solar noon, sunrise, and sunset in minutes past midnight UTC
  const solarNoon  = 720 - 4 * lon - eot;
  const sunriseMin = solarNoon - 4 * HA;
  const sunsetMin  = solarNoon + 4 * HA;

  // Convert to Date objects
  const midnight = new Date(Date.UTC(y, m - 1, d));
  return {
    sunrise: new Date(midnight.getTime() + sunriseMin * 60000),
    sunset:  new Date(midnight.getTime() + sunsetMin  * 60000),
  };
}


// =============================================================================
// LAYOUT RENDERERS
// =============================================================================

// Renders the full weather page (wide / full layouts).
// Contains: alert banners, radar panel (left), conditions panel (right),
// hourly strip (bottom).
function renderFullPage(wx, apparent, daily, hourly, alerts, aqi,
                        sunTimes, radarFrames, layout, layoutKey) {
  const { width, height } = layout;
  const isFull    = (layoutKey === 'full');
  const condWidth = CONDITIONS_WIDTH[layoutKey];
  const radarWidth = width - condWidth;
  const stripH    = HOURLY_HEIGHT[layoutKey];

  const scale = isFull ? 1.18 : 1.0;

  const alertsHtml   = buildAlertBannersHtml(alerts.active, width, scale);
  const radarHtml    = buildRadarPanelHtml(radarWidth, scale);
  const condHtml     = buildConditionsPanelHtml(
    wx, apparent, daily, alerts, aqi, sunTimes, condWidth, stripH, scale, isFull
  );
  const hourlyHtml   = buildHourlyStripHtml(hourly, width, stripH, scale);

  const styles = buildFullPageStyles(width, height, condWidth, stripH, scale);

  const body =
    '<div class="alerts">'  + alertsHtml + '</div>' +
    '<div class="main-row">' +
      '<div class="radar-panel">' + radarHtml + '</div>' +
      '<div class="cond-panel">'  + condHtml  + '</div>' +
    '</div>' +
    '<div class="hourly-strip">' + hourlyHtml + '</div>';

  const headExtra =
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>';

  return buildHtmlDoc(width, height, styles,
    body + buildRadarScript(radarFrames),
    headExtra
  );
}

// Renders a radar-only page for split/tri layouts with ?view=radar.
// Contains: optional alert banner, full-width animated radar map.
function renderRadarOnly(radarFrames, alerts, layout, layoutKey) {
  const { width, height } = layout;
  const scale = 1.0;

  const alertsHtml = buildAlertBannersHtml(alerts.active, width, scale);
  const radarHtml  = buildRadarPanelHtml(width, scale);

  const styles = buildRadarOnlyStyles(width, height, scale);

  const body =
    '<div class="alerts">' + alertsHtml + '</div>' +
    '<div class="radar-wrap">' + radarHtml + '</div>';

  const headExtra =
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>';

  return buildHtmlDoc(width, height, styles,
    body + buildRadarScript(radarFrames),
    headExtra
  );
}

// Renders a conditions-only page for split/tri layouts with ?view=conditions.
// Contains: alert banners, current conditions, stats, sunrise/sunset, 3-day forecast.
// No hourly strip (too narrow for split/tri widths).
function renderConditionsOnly(wx, apparent, daily, alerts, aqi,
                               sunTimes, layout, layoutKey) {
  const { width, height } = layout;
  const scale = layoutKey === 'split' ? 1.0 : 0.88;

  const alertsHtml = buildAlertBannersHtml(alerts.active, width, scale);
  const condHtml   = buildConditionsPanelHtml(
    wx, apparent, daily, alerts, aqi, sunTimes, width, 0, scale, false
  );

  const styles = buildConditionsOnlyStyles(width, height, scale);

  const body =
    '<div class="alerts">'    + alertsHtml + '</div>' +
    '<div class="cond-panel">' + condHtml   + '</div>';

  return buildHtmlDoc(width, height, styles, body, '');
}


// =============================================================================
// HTML COMPONENT BUILDERS
// =============================================================================

// Builds the HTML for stacked active alert banners.
// Returns an empty string if there are no active alerts.
function buildAlertBannersHtml(activeAlerts, width, scale) {
  if (!activeAlerts || activeAlerts.length === 0) return '';

  const fontSize  = Math.round(13 * scale);
  const typeSize  = Math.round(12 * scale);
  const padV      = Math.round(7  * scale);
  const padH      = Math.round(16 * scale);

  let html = '';
  for (const p of activeAlerts) {
    const cls     = alertSeverityClass(p.severity);
    const event   = escapeHtml(p.event || 'Weather Alert');
    const headline = escapeHtml(
      (p.headline || p.description || '').replace(/\n/g, ' ').substring(0, 200)
    );

    // Use p.ends (actual event end) in preference to p.expires (product expiry)
    // for the "until" time, consistent with the calendar-display alert pattern.
    const endDate = p.ends ? new Date(p.ends) : (p.expires ? new Date(p.expires) : null);
    const untilStr = endDate ? 'Until ' + formatShortAlertTime(endDate) : '';

    html +=
      '<div class="alert-banner ' + cls + '" style="' +
        'padding:' + padV + 'px ' + padH + 'px;' +
        'font-size:' + fontSize + 'px;' +
      '">' +
        '<span class="alert-type" style="font-size:' + typeSize + 'px;">' +
          '⚠ ' + event +
        '</span>' +
        '<span class="alert-divider"></span>' +
        '<span class="alert-text">' + headline + '</span>' +
        (untilStr ? '<span class="alert-until">' + escapeHtml(untilStr) + '</span>' : '') +
      '</div>';
  }
  return html;
}

// Builds the HTML for the radar panel (map container + overlay elements).
// The Leaflet map and radar animation are initialised by the client-side script.
function buildRadarPanelHtml(panelWidth, scale) {
  const legendFontSize = Math.round(10 * scale);
  const stampFontSize  = Math.round(11 * scale);

  // dBZ color legend — mirrors the standard NWS reflectivity colour scale.
  const legendHtml =
    '<div class="radar-legend">' +
      '<div class="legend-title" style="font-size:' + legendFontSize + 'px;">dBZ</div>' +
      '<div class="legend-bar"></div>' +
      '<div class="legend-labels" style="font-size:' + legendFontSize + 'px;">' +
        '<span>5</span><span>30</span><span>50</span><span>75</span>' +
      '</div>' +
    '</div>';

  // Timestamp and attribution overlaid at the bottom of the map.
  const stampHtml =
    '<div class="radar-stamp" style="font-size:' + stampFontSize + 'px;">' +
      'RADAR · <span id="radar-time">--:-- --</span> CDT' +
    '</div>' +
    '<div class="radar-credit">© OpenStreetMap · RainViewer</div>';

  // Thin progress bar along the very bottom of the map showing loop position.
  const progressHtml =
    '<div class="loop-bar">' +
      '<div id="radar-progress" class="loop-bar-fill"></div>' +
    '</div>';

  // Fallback message shown if JavaScript fails or NOAA is unavailable.
  const fallbackHtml =
    '<div id="radar-unavailable" style="display:none;" class="radar-unavailable">' +
      'Radar data unavailable' +
    '</div>';

  return (
    '<div id="radar-map"></div>' +
    legendHtml + stampHtml + progressHtml + fallbackHtml
  );
}

// Builds the HTML for the right-side conditions panel.
// panelWidth: pixel width of the panel.
// stripH: height (px) of the hourly strip below; 0 for conditions-only pages.
function buildConditionsPanelHtml(wx, apparent, daily, alerts, aqi,
                                   sunTimes, panelWidth, stripH, scale, isFull) {
  // Derive font sizes and padding from scale.
  const hdrFont    = Math.round(11 * scale);
  const bigTempFont = Math.round(52 * scale);
  const unitFont   = Math.round(26 * scale);
  const feelFont   = Math.round(12 * scale);
  const condFont   = Math.round(11 * scale);
  const statFont   = Math.round(13 * scale);
  const statLblFont = Math.round(10 * scale);
  const sunFont    = Math.round(15 * scale);
  const sunLblFont = Math.round(10 * scale);
  const fcDayFont  = Math.round(13 * scale);
  const fcDescFont = Math.round(12 * scale);
  const fcTempFont = Math.round(13 * scale);
  const pad        = Math.round(10 * scale);
  const hdrPad     = Math.round(6  * scale);

  // ── Section header helper ────────────────────────────────────────────────
  function sectionHeader(label) {
    return '<div class="sec-hdr" style="padding:' + hdrPad + 'px ' + pad + 'px;' +
      'font-size:' + hdrFont + 'px;">' + escapeHtml(label) + '</div>';
  }

  // ── Current conditions block ─────────────────────────────────────────────
  const tempStr    = wx.temp  !== null ? String(wx.temp)  : '--';
  const feelsStr   = apparent !== null ? apparent + '°F'  : (wx.temp !== null ? wx.temp + '°F' : '--');
  const condText   = wx.condition || '';
  const condIcon   = getConditionIcon(condText, WX_LG);

  // AQI badge — omitted silently if key was not configured.
  const aqiBadge = aqi
    ? '<span class="aqi-badge" style="background:' + aqi.category.color +
      ';color:' + aqi.category.text + ';font-size:' + Math.round(10 * scale) + 'px;">' +
      'AQI ' + aqi.aqi + ' · ' + escapeHtml(aqi.category.label) + '</span>'
    : '';

  const currentHtml =
    '<div class="current-block" style="padding:' + pad + 'px;">' +
      '<div class="temp-side">' +
        '<div class="temp-main">' +
          '<span class="temp-val" style="font-size:' + bigTempFont + 'px;">' +
            escapeHtml(tempStr) +
          '</span>' +
          '<span class="temp-unit" style="font-size:' + unitFont + 'px;">°F</span>' +
        '</div>' +
        '<div class="feels" style="font-size:' + feelFont + 'px;">' +
          'Feels like ' + feelsStr +
        '</div>' +
        (aqiBadge ? '<div style="margin-top:' + Math.round(4*scale) + 'px;">' + aqiBadge + '</div>' : '') +
      '</div>' +
      '<div class="cond-side">' +
        condIcon +
        '<div class="cond-text" style="font-size:' + condFont + 'px;">' +
          escapeHtml(condText) +
        '</div>' +
      '</div>' +
    '</div>';

  // ── Stats grid ────────────────────────────────────────────────────────────
  // Wind: show gusts only if available.
  const windDir   = wx.windDir   !== null ? wx.windDir   : '--';
  const windSpd   = wx.windSpeed !== null ? wx.windSpeed + ' mph' : '--';
  const gustStr   = wx.windGust  !== null ? ' (gusts ' + wx.windGust + ')' : '';
  const windVal   = windDir + ' ' + windSpd + gustStr;

  const humVal    = wx.humidity !== null
    ? wx.humidity + '%' + (wx.dewpoint !== null ? ' · Dew ' + wx.dewpoint + '°F' : '')
    : '--';

  const pressVal  = wx.pressure   !== null ? wx.pressure   + ' mb' : '--';
  const visVal    = wx.visibility !== null ? wx.visibility + ' mi' : '--';

  // Hi/Lo from the daily forecast periods (first daytime = high, first night = low).
  const hiLo      = getDailyHiLo(daily.map ? daily.map(function(d) { return d; }) : []);
  // Build hi/lo using raw forecast periods for accuracy.
  const hiLoVal   = buildHiLoString(daily);

  function statCell(label, value) {
    return (
      '<div class="stat-cell">' +
        '<div class="stat-lbl" style="font-size:' + statLblFont + 'px;">' +
          escapeHtml(label) +
        '</div>' +
        '<div class="stat-val" style="font-size:' + statFont + 'px;">' +
          escapeHtml(value) +
        '</div>' +
      '</div>'
    );
  }

  const statsHtml =
    '<div class="stats-grid">' +
      statCell('WIND',       windVal)  +
      statCell('HUMIDITY',   humVal)   +
      statCell('PRESSURE',   pressVal) +
      statCell('VISIBILITY', visVal)   +
      '<div class="stat-cell stat-span2">' +
        '<div class="stat-lbl" style="font-size:' + statLblFont + 'px;">TODAY HI / TONIGHT LO</div>' +
        '<div class="stat-val" style="font-size:' + statFont + 'px;">' +
          escapeHtml(hiLoVal) +
        '</div>' +
      '</div>' +
    '</div>';

  // ── Sunrise / Sunset row ─────────────────────────────────────────────────
  const srStr = sunTimes.sunrise ? formatTime12h(sunTimes.sunrise) : '--';
  const ssStr = sunTimes.sunset  ? formatTime12h(sunTimes.sunset)  : '--';

  const sunHtml =
    '<div class="sun-row">' +
      '<div class="sun-cell">' +
        '<span class="sun-icon">🌅</span>' +
        '<div>' +
          '<div class="sun-lbl" style="font-size:' + sunLblFont + 'px;">SUNRISE</div>' +
          '<div class="sun-time" style="font-size:' + sunFont + 'px;">' +
            escapeHtml(srStr) +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sun-cell">' +
        '<span class="sun-icon">🌇</span>' +
        '<div>' +
          '<div class="sun-lbl" style="font-size:' + sunLblFont + 'px;">SUNSET</div>' +
          '<div class="sun-time" style="font-size:' + sunFont + 'px;">' +
            escapeHtml(ssStr) +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // ── 3-day forecast rows ──────────────────────────────────────────────────
  let forecastRowsHtml = '';
  for (const day of daily) {
    const icon     = getConditionIcon(day.shortForecast, WX_SM);
    const precip   = day.precip !== null ? day.precip + '%' : '';
    const hi       = day.high  !== null ? day.high  + '°' : '--';
    const lo       = day.low   !== null ? day.low   + '°' : '--';

    // Check whether any future alert overlaps this forecast date.
    const badgeHtml = buildForecastAlertBadge(alerts.future, day.dateStr, scale);

    forecastRowsHtml +=
      '<div class="fc-row">' +
        '<div class="fc-day" style="font-size:' + fcDayFont + 'px;">' +
          escapeHtml(day.dayName) +
        '</div>' +
        '<div class="fc-icon">' + icon + '</div>' +
        '<div class="fc-desc" style="font-size:' + fcDescFont + 'px;">' +
          escapeHtml(day.shortForecast || '') +
        '</div>' +
        (precip
          ? '<div class="fc-precip" style="font-size:' + fcDescFont + 'px;">💧 ' +
              escapeHtml(precip) + '</div>'
          : '<div class="fc-precip"></div>'
        ) +
        '<div class="fc-temp" style="font-size:' + fcTempFont + 'px;">' +
          escapeHtml(hi) +
          '<span class="fc-sep">/</span>' +
          escapeHtml(lo) +
        '</div>' +
        (badgeHtml ? '<div class="fc-badge">' + badgeHtml + '</div>' : '') +
      '</div>';
  }

  const forecastHtml =
    '<div class="forecast">' + forecastRowsHtml + '</div>';

  return (
    sectionHeader('Current Conditions') +
    currentHtml +
    statsHtml   +
    sunHtml     +
    sectionHeader('3-Day Forecast') +
    forecastHtml
  );
}

// Builds the hourly strip HTML for wide/full layouts.
// Distributes HOURLY_COUNT cards evenly across the full page width.
function buildHourlyStripHtml(hourly, width, stripH, scale) {
  if (!hourly || hourly.length === 0) {
    return '<div class="hourly-empty">Hourly data unavailable</div>';
  }

  const timeFontSize  = Math.round(11 * scale);
  const tempFontSize  = Math.round(14 * scale);
  const precipFontSize = Math.round(10 * scale);

  let cardsHtml = '';
  for (const slot of hourly) {
    const icon    = getConditionIcon(slot.shortForecast, WX_SM);
    const precip  = slot.precip !== null ? slot.precip + '%' : '';

    cardsHtml +=
      '<div class="hour-card">' +
        '<div class="hour-time" style="font-size:' + timeFontSize + 'px;">' +
          escapeHtml(slot.label) +
        '</div>' +
        '<div class="hour-icon">' + icon + '</div>' +
        '<div class="hour-temp" style="font-size:' + tempFontSize + 'px;">' +
          escapeHtml(slot.temp !== null ? slot.temp + '°' : '--') +
        '</div>' +
        (precip
          ? '<div class="hour-precip" style="font-size:' + precipFontSize + 'px;">💧 ' +
              escapeHtml(precip) + '</div>'
          : '<div class="hour-precip"></div>'
        ) +
      '</div>';
  }

  return cardsHtml;
}

// Builds a small future-alert badge for a forecast day, if any future alert
// overlaps that date. Returns an HTML string or empty string.
function buildForecastAlertBadge(futureAlerts, dateStr, scale) {
  if (!futureAlerts || futureAlerts.length === 0) return '';

  const badgeFontSize = Math.round(9 * scale);

  for (const p of futureAlerts) {
    const onset  = p.onset   ? new Date(p.onset)   : null;
    const ends   = p.ends    ? new Date(p.ends)     :
                   p.expires ? new Date(p.expires)  : null;
    if (!onset || !ends) continue;

    const onsetDate = toLocalDateStr(onset);
    const endsDate  = toLocalDateStr(ends);

    if (onsetDate <= dateStr && endsDate >= dateStr) {
      const cls   = badgeSeverityClass(p.severity);
      const label = escapeHtml((p.event || 'Alert').substring(0, 20));
      return '<span class="alert-badge ' + cls + '" style="font-size:' +
        badgeFontSize + 'px;">' + label + '</span>';
    }
  }
  return '';
}

// Builds the client-side JavaScript block that initialises the Leaflet map
// and runs the radar animation loop using RainViewer tile data.
//
// RainViewer frame data is fetched server-side and embedded directly into the
// rendered HTML as a JSON array — no client-side fetch required. Each frame:
//   tileBase — CDN URL prefix, e.g. "https://tilecache.rainviewer.com/v2/radar/1744300800"
//   time     — Unix timestamp in seconds (used for the on-screen time label)
//
// Tile URL format: {tileBase}/256/{z}/{x}/{y}/4/0_0.png
//   256    = tile size in pixels
//   4      = Meteored colour scheme (closest to standard NWS radar palette)
//   0_0    = smooth:off / snow:off — the most universally supported option set
//
// If radarFrames is null (server fetch failed), the "Radar data unavailable"
// fallback message is shown over the base map.
function buildRadarScript(radarFrames) {
  const frames     = radarFrames || [];
  const framesJson = JSON.stringify(frames);

  return (
    '<script>' +
    // Configuration values embedded by the Worker at render time.
    'var RADAR_LAT='      + LOCATION_LAT   + ';' +
    'var RADAR_LON='      + LOCATION_LON   + ';' +
    'var RADAR_ZOOM='     + RADAR_ZOOM     + ';' +
    'var RADAR_OPACITY='  + RADAR_OPACITY  + ';' +
    'var RADAR_FRAME_MS=' + RADAR_FRAME_MS + ';' +
    'var RADAR_HOLD_MS='  + RADAR_HOLD_MS  + ';' +
    'var RADAR_FRAMES='   + framesJson     + ';' +

    'document.addEventListener("DOMContentLoaded",function(){' +

      // Create the Leaflet map centred on Fargo. All interaction disabled —
      // this is a passive display board, not an interactive map.
      'var map=L.map("radar-map",{' +
        'center:[RADAR_LAT,RADAR_LON],' +
        'zoom:RADAR_ZOOM,' +
        'zoomControl:false,' +
        'attributionControl:true,' +
        'dragging:false,' +
        'scrollWheelZoom:false,' +
        'doubleClickZoom:false,' +
        'touchZoom:false,' +
        'keyboard:false' +
      '});' +

      // OpenStreetMap base tiles.
      'L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{' +
        'attribution:"© <a href=\'https://www.openstreetmap.org/copyright\'>OpenStreetMap</a> contributors",' +
        'maxZoom:18' +
      '}).addTo(map);' +

      // If no frames were embedded (server fetch failed), show fallback.
      'if(!RADAR_FRAMES||!RADAR_FRAMES.length){' +
        'var el=document.getElementById("radar-unavailable");' +
        'if(el)el.style.display="flex";' +
        'return;' +
      '}' +

      // Pre-create one tile layer per radar frame. All start at opacity 0.
      // Adding them all immediately triggers background pre-loading so that
      // subsequent frames render without visible delay.
      // Tile URL: {tileBase}/256/{z}/{x}/{y}/4/0_0.png
      'var layers=RADAR_FRAMES.map(function(f){' +
        'return L.tileLayer(f.tileBase+"/256/{z}/{x}/{y}/4/0_0.png",{' +
          'opacity:0,' +
          'tileSize:256' +
        '});' +
      '});' +
      'layers.forEach(function(l){l.addTo(map);});' +

      'var frameIdx=0;' +
      'var progressEl=document.getElementById("radar-progress");' +
      'var timeEl=document.getElementById("radar-time");' +

      'function showFrame(){' +
        // Reveal current frame; hide all others.
        'layers.forEach(function(l,i){' +
          'l.setOpacity(i===frameIdx?RADAR_OPACITY:0);' +
        '});' +
        // Update timestamp label. RainViewer times are Unix seconds.
        'if(timeEl){' +
          'var ts=new Date(RADAR_FRAMES[frameIdx].time*1000);' +
          'timeEl.textContent=ts.toLocaleTimeString("en-US",{' +
            'timeZone:"America/Chicago",' +
            'hour:"numeric",minute:"2-digit",hour12:true' +
          '});' +
        '}' +
        // Update loop progress bar.
        'if(progressEl){' +
          'progressEl.style.width=((frameIdx+1)/layers.length*100)+"%";' +
        '}' +
        // Advance frame; hold longer on the latest frame before looping.
        'var isLast=(frameIdx===layers.length-1);' +
        'frameIdx=(frameIdx+1)%layers.length;' +
        'setTimeout(showFrame,isLast?RADAR_HOLD_MS:RADAR_FRAME_MS);' +
      '}' +

      'setTimeout(showFrame,RADAR_FRAME_MS);' +
    '});' +
    '</script>'
  );
}


// =============================================================================
// CSS STYLE BUILDERS
// =============================================================================

// Shared base styles used by all layout renderers.
function baseStyles(width, height) {
  return (
    '*, *::before, *::after{box-sizing:border-box;margin:0;padding:0;}' +
    'html,body{' +
      'width:' + width + 'px;height:' + height + 'px;' +
      'overflow:hidden;' +
      'background:#0a0a0a;color:#e8eaec;' +
      'font-family:"Helvetica Neue",Arial,Helvetica,sans-serif;' +
    '}' +

    // Alert banners — stacked above all content, colour-coded by severity.
    '.alerts{flex-shrink:0;}' +
    '.alert-banner{' +
      'display:flex;align-items:center;gap:12px;' +
      'border-left:4px solid;overflow:hidden;' +
    '}' +
    '.alert-warning {background:#7a0a0a;border-color:#ff3030;}' +
    '.alert-watch   {background:#7a3800;border-color:#ff8000;}' +
    '.alert-advisory{background:#4a4a00;border-color:#d4c000;}' +
    '.alert-type{font-weight:700;letter-spacing:.06em;text-transform:uppercase;' +
      'white-space:nowrap;flex-shrink:0;}' +
    '.alert-divider{width:2px;height:16px;background:rgba(255,255,255,.2);flex-shrink:0;}' +
    '.alert-text{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}' +
    '.alert-until{margin-left:auto;white-space:nowrap;flex-shrink:0;' +
      'opacity:.75;padding-right:8px;}' +

    // Radar panel
    '#radar-map{width:100%;height:100%;}' +
    '.radar-legend{' +
      'position:absolute;top:10px;left:10px;z-index:1000;' +
      'background:rgba(10,10,10,.78);border:1px solid #2a2e32;' +
      'border-radius:4px;padding:5px 8px;' +
    '}' +
    '.legend-title{color:#8a9199;text-transform:uppercase;letter-spacing:.05em;' +
      'margin-bottom:3px;}' +
    '.legend-bar{' +
      'height:8px;width:120px;border-radius:2px;' +
      'background:linear-gradient(90deg,' +
        '#04e9e7 0%,#019ff4 12%,#0300f4 22%,#02fd02 34%,#01c501 45%,' +
        '#008e00 54%,#fdf802 63%,#e5bc00 72%,#fd9500 81%,#fd0000 90%,#a10000 100%);}' +
    '.legend-labels{display:flex;justify-content:space-between;width:120px;' +
      'color:#8a9199;margin-top:2px;}' +
    '.radar-stamp{' +
      'position:absolute;bottom:28px;left:10px;z-index:1000;' +
      'background:rgba(0,0,0,.6);padding:3px 7px;border-radius:3px;' +
      'color:rgba(255,255,255,.75);letter-spacing:.03em;' +
    '}' +
    '.radar-credit{' +
      'position:absolute;bottom:10px;right:8px;z-index:1000;' +
      'font-size:10px;color:rgba(255,255,255,.35);' +
    '}' +
    '.loop-bar{position:absolute;bottom:0;left:0;right:0;height:4px;' +
      'background:rgba(255,255,255,.08);z-index:1000;}' +
    '.loop-bar-fill{height:100%;width:0;' +
      'background:linear-gradient(90deg,#a01515,#cc1f1f);' +
      'border-radius:0 2px 2px 0;transition:width .2s ease;}' +
    '.radar-unavailable{' +
      'position:absolute;inset:0;z-index:999;' +
      'display:flex;align-items:center;justify-content:center;' +
      'background:rgba(10,10,10,.85);color:#8a9199;' +
      'font-size:14px;letter-spacing:.05em;' +
    '}' +

    // Conditions panel
    '.cond-panel{' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'background:#111416;border-left:1px solid #1e2428;' +
    '}' +
    '.sec-hdr{' +
      'background:#b01818;' +
      'font-weight:700;letter-spacing:.1em;text-transform:uppercase;' +
      'flex-shrink:0;' +
    '}' +
    '.current-block{' +
      'display:flex;align-items:flex-start;gap:10px;' +
      'background:#181c1f;flex-shrink:0;border-bottom:1px solid #1e2428;' +
    '}' +
    '.temp-side{flex:1;}' +
    '.temp-main{display:flex;align-items:flex-end;line-height:1;}' +
    '.temp-val{font-weight:600;color:#fff;}' +
    '.temp-unit{color:#8a9199;margin-bottom:4px;margin-left:2px;}' +
    '.feels{color:#8a9199;margin-top:4px;}' +
    '.aqi-badge{' +
      'display:inline-block;padding:2px 7px;border-radius:3px;' +
      'font-weight:700;letter-spacing:.05em;' +
    '}' +
    '.cond-side{' +
      'display:flex;flex-direction:column;align-items:center;gap:4px;' +
      'flex-shrink:0;' +
    '}' +
    '.cond-text{color:#8a9199;text-align:center;text-transform:uppercase;' +
      'letter-spacing:.04em;}' +

    // Stats grid — 2-column grid, last row spans both columns
    '.stats-grid{' +
      'display:grid;grid-template-columns:1fr 1fr;flex-shrink:0;' +
      'border-bottom:1px solid #1e2428;' +
    '}' +
    '.stat-cell{' +
      'padding:6px 10px;border-bottom:1px solid #1e2428;' +
    '}' +
    '.stat-cell:nth-child(odd){border-right:1px solid #1e2428;}' +
    '.stat-span2{grid-column:span 2;border-right:none;}' +
    '.stat-lbl{color:#8a9199;text-transform:uppercase;letter-spacing:.05em;}' +
    '.stat-val{color:#e8eaec;margin-top:1px;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;}' +

    // Sunrise / sunset row
    '.sun-row{' +
      'display:grid;grid-template-columns:1fr 1fr;flex-shrink:0;' +
      'border-bottom:1px solid #1e2428;background:#181c1f;' +
    '}' +
    '.sun-cell{display:flex;align-items:center;gap:8px;padding:6px 10px;}' +
    '.sun-cell:first-child{border-right:1px solid #1e2428;}' +
    '.sun-icon{font-size:18px;}' +
    '.sun-lbl{color:#8a9199;text-transform:uppercase;letter-spacing:.05em;}' +
    '.sun-time{color:#f0c040;font-weight:600;}' +

    // 3-day forecast
    '.forecast{flex:1;display:flex;flex-direction:column;min-height:0;}' +
    '.fc-row{' +
      'flex:1;display:grid;' +
      'grid-template-columns:50px auto 1fr auto auto auto;' +
      'align-items:center;gap:6px;' +
      'padding:0 10px;' +
      'border-bottom:1px solid #1e2428;min-height:0;' +
    '}' +
    '.fc-row:last-child{border-bottom:none;}' +
    '.fc-row:nth-child(even){background:#181c1f;}' +
    '.fc-day{font-weight:700;color:#cc1f1f;text-transform:uppercase;' +
      'letter-spacing:.05em;}' +
    '.fc-icon{flex-shrink:0;}' +
    '.fc-desc{color:#e8eaec;white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
    '.fc-precip{color:#4db8ff;font-weight:600;white-space:nowrap;}' +
    '.fc-temp{color:#e8eaec;font-weight:600;white-space:nowrap;text-align:right;}' +
    '.fc-sep{color:#8a9199;margin:0 2px;}' +
    '.fc-badge{white-space:nowrap;}' +
    '.alert-badge{display:inline-block;padding:1px 5px;border-radius:3px;' +
      'font-weight:700;letter-spacing:.04em;}' +
    '.badge-warning {background:#cc2222;color:#fff;}' +
    '.badge-watch   {background:#cc6000;color:#fff;}' +
    '.badge-advisory{background:#888800;color:#fff;}' +

    // Hourly strip
    '.hourly-strip{' +
      'display:flex;flex-direction:row;align-items:stretch;' +
      'border-top:1px solid #1e2428;background:#0e1214;flex-shrink:0;' +
    '}' +
    '.hour-card{' +
      'flex:1;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:3px;' +
      'border-right:1px solid #1e2428;padding:4px 0;' +
    '}' +
    '.hour-card:last-child{border-right:none;}' +
    '.hour-time{color:#8a9199;text-transform:uppercase;letter-spacing:.04em;}' +
    '.hour-icon{flex-shrink:0;}' +
    '.hour-temp{color:#fff;font-weight:600;}' +
    '.hour-precip{color:#4db8ff;}' +
    '.hourly-empty{flex:1;display:flex;align-items:center;justify-content:center;' +
      'color:#8a9199;font-size:12px;}'
  );
}

// CSS for the wide / full layout (radar + conditions side by side + hourly strip).
function buildFullPageStyles(width, height, condWidth, stripH, scale) {
  return (
    baseStyles(width, height) +
    'body{display:flex;flex-direction:column;}' +
    '.main-row{flex:1;min-height:0;display:flex;flex-direction:row;}' +
    '.radar-panel{flex:1;min-width:0;position:relative;}' +
    '.cond-panel{width:' + condWidth + 'px;flex-shrink:0;}' +
    '.hourly-strip{height:' + stripH + 'px;}'
  );
}

// CSS for split/tri radar-only layout.
function buildRadarOnlyStyles(width, height, scale) {
  return (
    baseStyles(width, height) +
    'body{display:flex;flex-direction:column;}' +
    '.radar-wrap{flex:1;min-height:0;position:relative;}'
  );
}

// CSS for split/tri conditions-only layout.
function buildConditionsOnlyStyles(width, height, scale) {
  return (
    baseStyles(width, height) +
    'body{display:flex;flex-direction:column;}' +
    '.cond-panel{flex:1;min-height:0;border-left:none;}'
  );
}


// =============================================================================
// ERROR PAGE
// =============================================================================

function renderErrorPage(message, layout) {
  const { width, height } = layout;
  const fontSize = Math.floor(Math.min(width, height) * 0.022);

  return new Response(
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head><meta charset="UTF-8">' +
    '<meta http-equiv="refresh" content="' + ERROR_RETRY_SECONDS + '">' +
    '<title>FFD Weather</title>' +
    '<style>' +
    'html,body{width:' + width + 'px;height:' + height + 'px;margin:0;padding:0;' +
      'overflow:hidden;background:#0a0a0a;color:#8a9199;' +
      'font-family:Arial,sans-serif;font-size:' + fontSize + 'px;' +
      'display:flex;align-items:center;justify-content:center;text-align:center;}' +
    '</style></head>' +
    '<body>' + escapeHtml(message) + '</body></html>',
    {
      status: 200,
      headers: {
        'Content-Type':           'text/html; charset=utf-8',
        'Cache-Control':          'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}


// =============================================================================
// DATE AND TIME HELPERS
// =============================================================================

// Returns the YYYY-MM-DD date string for a JS Date in Central time.
function toLocalDateStr(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// Formats a JS Date as a short weekday abbreviation (e.g. "SAT").
function formatDayName(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
  }).format(date).toUpperCase();
}

// Formats a JS Date as a short 12-hour time string, e.g. "2 PM" or "6:30 AM".
function formatHourLabel(date) {
  const raw = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', hour12: true,
  }).format(date);
  return raw;
}

// Formats a JS Date as a 12-hour time string for sunrise/sunset, e.g. "6:48 AM".
function formatTime12h(date) {
  if (!date) return '--';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

// Formats a Date for use in alert "until" text, e.g. "Fri 9:00 PM".
function formatShortAlertTime(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

// Builds the Hi/Lo string for today from the daily forecast array.
// Shows "Hi 50°F / Lo 32°F", or just one if the other is unavailable.
function buildHiLoString(daily) {
  if (!daily || daily.length === 0) return '--';
  const d = daily[0];
  if (d.high !== null && d.low !== null) return d.high + '°F / ' + d.low + '°F';
  if (d.high !== null)                   return 'Hi ' + d.high + '°F';
  if (d.low  !== null)                   return 'Lo ' + d.low  + '°F tonight';
  return '--';
}


// =============================================================================
// UNIT CONVERSION HELPERS
// =============================================================================
// All NWS observation fields have a .value property. Null values pass through
// as null so callers can display "--" rather than a misleading "0".

// Converts a NWS temperature value object (degC) to °F, rounded to integer.
function nwsCToF(valueObj) {
  if (!valueObj || valueObj.value === null || valueObj.value === undefined) return null;
  return Math.round(valueObj.value * 9 / 5 + 32);
}

// Converts a NWS wind speed value object (km/h) to mph, rounded to integer.
function nwsKmhToMph(valueObj) {
  if (!valueObj || valueObj.value === null || valueObj.value === undefined) return null;
  return Math.round(valueObj.value * 0.6214);
}

// Converts a NWS pressure value object (Pa) to mb (hPa), rounded to integer.
function nwsPaToMb(valueObj) {
  if (!valueObj || valueObj.value === null || valueObj.value === undefined) return null;
  return Math.round(valueObj.value / 100);
}

// Converts a NWS visibility value object (metres) to miles, one decimal place.
function nwsMToMi(valueObj) {
  if (!valueObj || valueObj.value === null || valueObj.value === undefined) return null;
  const miles = valueObj.value / 1609.344;
  // Cap at 10 miles (standard "unlimited" visibility reporting).
  return miles >= 10 ? 10 : Math.round(miles * 10) / 10;
}

// Converts a wind direction in degrees (0–360) to a cardinal abbreviation.
// Returns null for null input. 0° and 360° both map to "N".
function degreesToCardinal(deg) {
  if (deg === null || deg === undefined) return null;
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                'S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}


// =============================================================================
// GENERAL UTILITIES
// =============================================================================

// Escapes HTML special characters to prevent injection from API data.
function escapeHtml(str) {
  if (!str && str !== 0) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Strips non-alphanumeric characters (except hyphen/underscore) from a URL
// parameter value to prevent injection attacks. Returns null for empty input.
function sanitizeParam(value) {
  if (!value) return null;
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50);
}

// Assembles the full HTML document string.
// headExtra: optional additional <head> content (e.g. Leaflet CDN links).
function buildHtmlDoc(width, height, styles, body, headExtra) {
  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta http-equiv="refresh" content="' + CACHE_SECONDS + '">' +
    '<title>FFD Weather</title>' +
    (headExtra || '') +
    '<style>' + styles + '</style>' +
    '</head>' +
    '<body>' + body + '</body>' +
    '</html>'
  );
}
