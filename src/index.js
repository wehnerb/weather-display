import { fetchWithTimeout } from './shared/fetch-helpers.js';
import { escapeHtml, sanitizeParam } from './shared/html.js';
import { DARK_BG_COLOR, FONT_STACK, ACCENT_COLOR, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, BORDER_SUBTLE, BORDER_STRONG, CARD_BASE, CARD_ELEVATED, CARD_HEADER, CARD_RECESSED } from './shared/colors.js';
import { LAYOUTS } from './shared/layouts.js';
import { ALERT_WARNING_BG, ALERT_WARNING_BORDER, ALERT_WARNING_TEXT, ALERT_WATCH_BG, ALERT_WATCH_BORDER, ALERT_WATCH_TEXT, ALERT_ADVISORY_BG, ALERT_ADVISORY_BORDER, ALERT_ADVISORY_TEXT } from './shared/alert-colors.js';
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
//   AQI                 — EPA AirNow API (needs AIRNOW_API_KEY secret)
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
//   RainViewer tile size note:
//   256px tiles only support zoom levels 0–6. Zoom 8 requires 512px tiles.
//   Leaflet's zoomOffset:-1 compensates so the visual zoom level is unchanged.
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
const FORECAST_DAYS  = 3;		// number of days in the 3-day forecast section of the display
const HOURLY_COUNT   = 12;   // number of hourly slots in the bottom strip

// Radar animation (client-side)
const RADAR_FRAME_COUNT = 18;    // max number of radar frames to animate
const RADAR_ZOOM        =  8;    // Leaflet zoom level (~75 mi radius); adjust after hardware test
const RADAR_FRAME_MS    =  200;  // milliseconds per historical frame
const RADAR_HOLD_MS     = 2500;  // milliseconds to hold the latest frame before looping
const RADAR_OPACITY     =  0.7;  // radar overlay opacity (0–1)

// SVG icon sizes (px) — precomputed at module load; changing requires re-deploy
const ICON_SIZE_LG   = 45;   // current conditions icon (large)
const ICON_SIZE_SM   = 26;   // forecast rows + hourly strip icons

// Cache TTLs (seconds)
const CACHE_SECONDS        =  300;   // page cache + meta-refresh interval
const CACHE_VERSION        =   11;   // increment to invalidate all cached pages
const NWS_CONDITIONS_TTL   =  300;   // current observations (station updates ~hourly)
const NWS_GRIDDATA_TTL     =  300;   // apparent temperature from gridpoints
const NWS_FORECAST_TTL     = 1800;   // daily + hourly forecast (~4 updates/day)
const NWS_ALERTS_TTL       =  120;   // active alerts (safety-critical; short TTL)
const AQI_TTL              =  900;   // AirNow AQI (updates hourly)
const RAINVIEWER_TTL       =   60;   // RainViewer frame list (new frames every ~10 min)

// Conditions panel width (px) for wide/full layouts. Remainder goes to radar.
const CONDITIONS_WIDTH = { full: 780, wide: 690 };

// Hourly strip height (px) for wide/full layouts.
const HOURLY_HEIGHT = { full: 120, wide: 90 };

// Alert banner configuration.
// ALERT_BANNER_HEIGHT_PX: vertical pixels reserved per active alert banner.
// Increase if alert text wraps; decrease to reserve less space per alert.
const ALERT_BANNER_HEIGHT_PX = 52;

// Maximum number of alert banners to display simultaneously.
// Alerts are sorted by severity (most severe first) so the most important
// alerts are always shown when more than this number are active.
// Each additional alert consumes ALERT_BANNER_HEIGHT_PX of vertical space.
const MAX_DISPLAY_ALERTS = 3;

// Default values
const DEFAULT_LAYOUT     = 'wide';
const DEFAULT_VIEW_SMALL = 'conditions';  // default ?view= for split/tri
const ERROR_RETRY_SECONDS = 60;

// Maximum age (in hours) of a cached wind reading to use as fallback
// when the latest NWS observation returns a null wind speed.
// NWS occasionally returns null wind with qualityControl:"Z" (flagged bad).
// When this happens, the last valid reading within this window is used
// and displayed silently as if current. Set to 0 to disable fallback.
const WIND_STALE_MAX_HOURS = 2;

// Sanity bounds for forecast high and low temperatures (°F).
// NWS occasionally returns erroneous sentinel values (e.g. -100°F).
// Any temperature outside this range is treated as missing data.
// Fargo ND all-time records: -43°F (1996) to 114°F (1936).
// Bounds are wider than records to allow for future extremes.
const TEMP_MIN_PLAUSIBLE_F = -80;
const TEMP_MAX_PLAUSIBLE_F = 140;


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

  // Wind: three horizontal lines of decreasing length with curled ends,
  // suggesting airflow. Replaces the previous curved streamlines design.
  const WIND = op +
    '<line x1="3"  y1="6"  x2="16" y2="6"  stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="3"  y1="12" x2="21" y2="12" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="3"  y1="18" x2="13" y2="18" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M16 3 a3 3 0 0 1 3 3 a3 3 0 0 1-3 3" fill="none" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M21 9 a3 3 0 0 1 0 6" fill="none" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M13 15 a3 3 0 0 1 3 3 a3 3 0 0 1-3 3" fill="none" stroke="#b0c4d4" stroke-width="2" stroke-linecap="round"/>' +
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

const WX_SVG_SUNRISE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + ICON_SIZE_SM + '" height="' + ICON_SIZE_SM + '" viewBox="0 0 18 18" style="display:inline-block;vertical-align:middle;">' +
  '<circle cx="6" cy="9" r="3" fill="#f0c040"/>' +
  '<line x1="6" y1="4.5" x2="6" y2="6" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="6" y1="12" x2="6" y2="13.5" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="1.5" y1="9" x2="3" y2="9" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="9" y1="9" x2="10.5" y2="9" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="2.8" y1="5.8" x2="3.9" y2="6.9" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="8.1" y1="11.1" x2="9.2" y2="12.2" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="2.8" y1="12.2" x2="3.9" y2="11.1" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="8.1" y1="6.9" x2="9.2" y2="5.8" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M 14 14 L 14 4 M 11.5 6.5 L 14 4 L 16.5 6.5" stroke="#f0c040" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
  '</svg>';

const WX_SVG_SUNSET =
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + ICON_SIZE_SM + '" height="' + ICON_SIZE_SM + '" viewBox="0 0 18 18" style="display:inline-block;vertical-align:middle;">' +
  '<circle cx="6" cy="9" r="3" fill="#f0c040"/>' +
  '<line x1="6" y1="4.5" x2="6" y2="6" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="6" y1="12" x2="6" y2="13.5" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="1.5" y1="9" x2="3" y2="9" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="9" y1="9" x2="10.5" y2="9" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="2.8" y1="5.8" x2="3.9" y2="6.9" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="8.1" y1="11.1" x2="9.2" y2="12.2" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="2.8" y1="12.2" x2="3.9" y2="11.1" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<line x1="8.1" y1="6.9" x2="9.2" y2="5.8" stroke="#f0c040" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M 14 4 L 14 14 M 11.5 11.5 L 14 14 L 16.5 11.5" stroke="#f0c040" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
  '</svg>';

const WX_SVG_DROP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + ICON_SIZE_SM + '" height="' + ICON_SIZE_SM + '" viewBox="0 0 12 12" style="display:inline-block;vertical-align:middle;">' +
  '<path d="M6 1 C6 1 2 6 2 8.5 C2 10.5 3.8 12 6 12 C8.2 12 10 10.5 10 8.5 C10 6 6 1 6 1 Z" fill="#4db8ff"/>' +
  '</svg>';

const WX_SVG_DROP_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 12 12" style="display:inline-block;vertical-align:middle;">' +
  '<path d="M6 1 C6 1 2 6 2 8.5 C2 10.5 3.8 12 6 12 C8.2 12 10 10.5 10 8.5 C10 6 6 1 6 1 Z" fill="#4db8ff"/>' +
  '</svg>';

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

    if (url.pathname === '/healthz') {
      var healthStatus = 'healthy';
      var details = [];

      try {
        var nwsProbeRes = await fetchWithTimeout(
          'https://api.weather.gov/',
          {
            headers: {
              'User-Agent': env.NWS_USER_AGENT || 'FFD-Station-Display/1.0',
              'Accept': 'application/json',
            },
          },
          5000
        );
        if (nwsProbeRes.ok) {
          details.push('nws: reachable');
        } else {
          healthStatus = 'degraded';
          details.push('nws: unexpected status ' + nwsProbeRes.status);
        }
      } catch (e) {
        healthStatus = 'degraded';
        details.push('nws: unreachable (' + (e && e.message ? e.message : String(e)) + ')');
      }

      try {
        var rvProbeRes = await fetchWithTimeout(
          'https://api.rainviewer.com/public/weather-maps.json',
          {},
          5000
        );
        if (rvProbeRes.ok) {
          details.push('rainviewer: reachable');
        } else {
          healthStatus = 'degraded';
          details.push('rainviewer: unexpected status ' + rvProbeRes.status);
        }
      } catch (e) {
        healthStatus = 'degraded';
        details.push('rainviewer: unreachable (' + (e && e.message ? e.message : String(e)) + ')');
      }

      var airnowKey = env.AIRNOW_API_KEY || '';
      if (!airnowKey) {
        details.push('airnow: secret not configured (AQI will be omitted)');
      } else {
        try {
          var airnowProbeRes = await fetchWithTimeout(
            'https://www.airnowapi.org/aq/observation/zipCode/current/?format=application/json&zipCode=58102&distance=25&API_KEY=' + airnowKey,
            {},
            5000
          );
          if (airnowProbeRes.ok) {
            details.push('airnow: reachable');
          } else {
            details.push('airnow: unexpected status ' + airnowProbeRes.status);
          }
        } catch (e) {
          details.push('airnow: unreachable (' + (e && e.message ? e.message : String(e)) + ')');
        }
      }

      return new Response(
        'status: ' + healthStatus + '\n' +
        'worker: weather-display\n' +
        details.join('\n') + '\n',
        {
          status: healthStatus === 'healthy' ? 200 : 503,
          headers: {
            'Content-Type':  'text/plain; charset=UTF-8',
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    const layoutParam = sanitizeParam(url.searchParams.get('layout')) || DEFAULT_LAYOUT;
    const layoutKey   = (layoutParam in LAYOUTS) ? layoutParam : DEFAULT_LAYOUT;
    const layout      = LAYOUTS[layoutKey];

    const isSmall     = (layoutKey === 'split' || layoutKey === 'tri');
    const viewParam   = sanitizeParam(url.searchParams.get('view')) || DEFAULT_VIEW_SMALL;
    // Treat any value other than 'conditions' as 'radar'.
    const viewKey     = (viewParam === 'conditions') ? 'conditions' : 'radar';

    // ?bg=dark renders with a solid dark background for browser-based testing.
    // Matches the probationary-firefighter-display ?bg=dark parameter behaviour.
    const darkBg = sanitizeParam(url.searchParams.get('bg')) === 'dark';

    // Build a versioned cache key that incorporates layout and (for small
    // layouts) the view. Wide/full always render both components, so view
    // is not part of their cache key.
    // ?bg=dark requests bypass the cache entirely — they are for testing only
    // and should not pollute the production cache or receive stale pages.
    const cacheKeyUrl = 'https://weather-display-cache.internal/v' + CACHE_VERSION +
      '/' + layoutKey + (isSmall ? '-' + viewKey : '');
    const cache    = caches.default;
    const cacheReq = new Request(cacheKeyUrl, { method: 'GET' });

    if (!darkBg) {
      const cached = await cache.match(cacheReq);
      if (cached) return cached;
    }

    try {
      const now = new Date();

      // Determine which data sources are needed for this layout+view combination.
      // Avoid unnecessary fetches: radar-only views skip all weather data;
      // conditions-only views skip radar frames.
      const needsWeather = !isSmall || viewKey === 'conditions';
      const needsRadar   = !isSmall || viewKey === 'radar';

      // Fetch all required data in parallel to minimise total latency.
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
        fetchNwsAlerts(env.NWS_USER_AGENT),
        needsWeather ? fetchAirNowAqi(env.AIRNOW_API_KEY) : Promise.resolve(null),
        needsRadar   ? fetchRainViewerFrames()             : Promise.resolve(null),
      ]);

      // Process raw API responses into display-ready objects.
      // Each processor returns null-safe results — missing data is handled gracefully.
      const wx       = processObservations(obsData);

      // Wind fallback: if the latest observation returned null wind speed,
      // try to use the most recent valid reading within WIND_STALE_MAX_HOURS.
      if (wx.windSpeed === null && WIND_STALE_MAX_HOURS > 0) {
        try {
          var recentObs = await fetchNwsRecentObservations(env.NWS_USER_AGENT);
          var windFallback = findLastValidWind(recentObs, now);
          if (windFallback) {
            wx.windDir   = windFallback.windDir;
            wx.windSpeed = windFallback.windSpeed;
            wx.windGust  = windFallback.windGust;
            console.log('wind-fallback: using cached wind reading — latest obs had null wind');
          }
        } catch (e) {
          console.error('wind-fallback error:', e && e.message ? e.message : e);
        }
      }

      const apparent = getApparentTemp(gridData, now);
      const daily    = buildDailyForecast(dailyPeriods, FORECAST_DAYS);
      const todayHiLo = getDailyHiLo(dailyPeriods);
      const hourly   = buildHourlySlots(hourlyPeriods, now, HOURLY_COUNT);
      const alerts   = processAlerts(alertFeatures, now);
      // ===== TEMPORARY TEST ALERT — REMOVE BEFORE PRODUCTION =====
      // Injects fake alerts to verify proportional scaling behavior.
      // Remove this block before merging to main.
      if (url.searchParams.get('testalerts')) {
        var testCount = parseInt(url.searchParams.get('testalerts'), 10) || 1;
        var testAlerts = [];
        var severities = ['Extreme', 'Severe', 'Moderate'];
        var events     = ['Tornado Warning', 'Severe Thunderstorm Warning', 'Winter Storm Watch'];
        var classes    = ['warning', 'warning', 'watch'];
        for (var ti = 0; ti < Math.min(testCount, MAX_DISPLAY_ALERTS); ti++) {
          testAlerts.push({
            event:    events[ti]    || 'Weather Alert',
            severity: severities[ti] || 'Moderate',
            ends:     new Date(Date.now() + 3600000).toISOString(),
            expires:  new Date(Date.now() + 3600000).toISOString(),
            cls:      classes[ti]   || 'watch',
          });
        }
        alerts.active = testAlerts;
      }
      // ===== END TEMPORARY TEST ALERT =====
      const aqi      = processAqi(aqiData);
      const sunTimes = calcSunriseSunset(now, LOCATION_LAT, LOCATION_LON);

      let html;
      if (isSmall && viewKey === 'radar') {
        html = renderRadarOnly(radarFrames, alerts, layout, layoutKey, darkBg);
      } else if (isSmall && viewKey === 'conditions') {
        html = renderConditionsOnly(
          wx, apparent, daily, todayHiLo, alerts, aqi, sunTimes, layout, layoutKey, darkBg
        );
      } else {
        html = renderFullPage(
          wx, apparent, daily, todayHiLo, hourly, alerts, aqi, sunTimes,
          radarFrames, layout, layoutKey, darkBg
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

      // Only write to the Workers Cache when not in dark-bg testing mode.
      if (!darkBg) {
        const toCache = new Response(html, {
          status: 200,
          headers: {
            'Content-Type':           'text/html; charset=utf-8',
            'Cache-Control':          'public, max-age=' + CACHE_SECONDS,
            'X-Content-Type-Options': 'nosniff',
          },
        });
        await cache.put(cacheReq, toCache);
      }

      return response;

    } catch (err) {
      console.error('Worker unhandled error:', err);
      return renderErrorPage('WEATHER UNAVAILABLE', 'Retrying shortly', layout, darkBg);
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
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_CONDITIONS_TTL },
    }, 8000);
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

// Fetches the last several observations from KFAR to find a recent valid
// wind reading. Used as fallback when the latest observation has null wind.
// Returns an array of observation properties objects, newest first.
// Returns empty array on failure.
async function fetchNwsRecentObservations(userAgent) {
  var url = 'https://api.weather.gov/stations/' + NWS_STATION + '/observations?limit=5';
  try {
    var res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_CONDITIONS_TTL },
    }, 8000);
    if (!res.ok) {
      console.error('NWS recent observations fetch failed (' + res.status + ')');
      return [];
    }
    var data = await res.json();
    if (!data.features || !Array.isArray(data.features)) return [];
    return data.features.map(function(f) { return f.properties || null; }).filter(Boolean);
  } catch (e) {
    console.error('NWS recent observations error:', e && e.message ? e.message : e);
    return [];
  }
}

// Finds the most recent valid wind reading from a list of observation
// properties objects. A reading is valid if windSpeed.value is non-null
// and the observation timestamp is within WIND_STALE_MAX_HOURS of now.
// Returns { windDir, windSpeed, windGust } or null if no valid reading found.
function findLastValidWind(observations, now) {
  if (!observations || !observations.length || WIND_STALE_MAX_HOURS <= 0) return null;
  var maxAgeMs = WIND_STALE_MAX_HOURS * 3600 * 1000;

  for (var i = 0; i < observations.length; i++) {
    var props = observations[i];
    if (!props) continue;

    // Check timestamp is within the allowed window
    var ts = props.timestamp ? new Date(props.timestamp) : null;
    if (!ts || isNaN(ts.getTime())) continue;
    if (now - ts > maxAgeMs) break; // observations are newest-first; stop once too old

    // Check wind speed is valid
    if (!props.windSpeed || props.windSpeed.value === null ||
        props.windSpeed.value === undefined) continue;

    // Found a valid reading — extract and return
    return {
      windDir:   degreesToCardinal(props.windDirection && props.windDirection.value),
      windSpeed: nwsKmhToMph(props.windSpeed),
      windGust:  nwsKmhToMph(props.windGust),
    };
  }
  return null;
}

// Fetches the gridpoints data for the Fargo grid cell.
// Used to retrieve the apparentTemperature (feels-like) time series.
// Returns the full properties object or null on failure.
async function fetchNwsGridData(userAgent) {
  const url = 'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_GRIDDATA_TTL },
    }, 8000);
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
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_FORECAST_TTL },
    }, 8000);
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
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_FORECAST_TTL },
    }, 8000);
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
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_ALERTS_TTL },
    }, 8000);
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
    const res = await fetchWithTimeout(url, {
      cf: { cacheTtl: AQI_TTL },
    }, 8000);
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
// Server-side fetch from a Cloudflare Worker is allowed (no IP blocking).
// The tile CDN includes proper CORS headers for client-side Leaflet tile loading.
//
// Returns an array of { tileBase, time } objects:
//   tileBase — CDN URL prefix (append "/512/{z}/{x}/{y}/4/0_0.png" for a tile URL)
//   time     — Unix timestamp in seconds (for the on-screen time label)
//
// 512px tiles are required — RainViewer's 256px tiles only support zoom 0–6.
// Using 512px tiles with Leaflet's zoomOffset:-1 keeps the visual zoom unchanged.
//
// Returns null on any error so callers degrade gracefully.
async function fetchRainViewerFrames() {
  const url = 'https://api.rainviewer.com/public/weather-maps.json';
  try {
    const res = await fetchWithTimeout(url, {
      cf: { cacheTtl: RAINVIEWER_TTL },
    }, 8000);
    if (!res.ok) {
      console.error('RainViewer fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();

    if (!data.radar || !data.radar.past || !data.radar.past.length) {
      console.error('RainViewer: no past frames in response');
      return null;
    }

    const host   = data.host || 'https://tilecache.rainviewer.com';
    const frames = data.radar.past
      .slice(-RADAR_FRAME_COUNT)
      .map(function(f) {
        return {
          tileBase: host + f.path,   // e.g. "https://tilecache.rainviewer.com/v2/radar/1744300800"
          time:     f.time,          // Unix seconds — converted to Date for display
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
  result.pressure   = nwsPaToInHg(props.barometricPressure);
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
// Each element: { dateStr, dayName, high, low, precip, shortForecast,
//                 windSpeed, windDir }
// Daytime periods supply the high temp, condition, and wind forecast;
// nighttime periods supply the low temp.
// windSpeed is a pre-formatted NWS string (e.g. "10 to 20 mph" or "15 mph").
// windDir is a NWS cardinal string (e.g. "NW"). Both are display-ready as-is.
// Edge case: if only a nighttime period exists for a date (daytime already
// passed), high is null, only the low is shown, and wind is omitted.
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
        windSpeed:     null,   // NWS pre-formatted string, e.g. "10 to 20 mph"
        windDir:       null,   // NWS cardinal string, e.g. "NW"
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
      // Wind forecast from daytime period only — most actionable for display.
      // NWS provides these as ready-to-display strings; no conversion needed.
      map[dateStr].windSpeed     = p.windSpeed     || null;
      map[dateStr].windDir       = p.windDirection || null;
    } else {
      map[dateStr].low = p.temperature;
      // Use nighttime condition only when no daytime period exists for this date.
      if (!map[dateStr].shortForecast) {
        map[dateStr].shortForecast = p.shortForecast;
        map[dateStr].precip        = precip;
      }
    }
  }

  // Drop today's entry so the forecast starts from tomorrow — today's
  // conditions are already shown in the current conditions panel.
  // Fetch one extra day (FORECAST_DAYS = 4) so that after filtering
  // today out, exactly 3 future days remain.
  const todayStr = toLocalDateStr(new Date());
  return Object.values(map).filter(function(d) {
    return d.dateStr !== todayStr;
  }).slice(0, count);
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
    var hiTemp = periods[i].temperature;
    var loTemp = periods[i].temperature;
    if (periods[i].isDaytime  && high === null &&
        hiTemp !== null && hiTemp !== undefined &&
        hiTemp >= TEMP_MIN_PLAUSIBLE_F && hiTemp <= TEMP_MAX_PLAUSIBLE_F) {
      high = hiTemp;
    }
    if (!periods[i].isDaytime && low === null &&
        loTemp !== null && loTemp !== undefined &&
        loTemp >= TEMP_MIN_PLAUSIBLE_F && loTemp <= TEMP_MAX_PLAUSIBLE_F) {
      low = loTemp;
    }
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

// Calculates the effective content height after reserving space for alert banners.
// Returns an object with:
//   alertCount    — number of alerts to display (capped at MAX_DISPLAY_ALERTS)
//   alertsHeight  — total pixels consumed by alert banners
//   contentHeight — remaining pixels available for all other content
//   contentScale  — scale factor derived from contentHeight vs full height,
//                   applied proportionally to font sizes, icon sizes, strip height
function calcEffectiveHeight(activeAlerts, totalHeight, baseScale) {
  var alertCount   = activeAlerts ? Math.min(activeAlerts.length, MAX_DISPLAY_ALERTS) : 0;
  var alertsHeight = alertCount * ALERT_BANNER_HEIGHT_PX;
  var contentHeight = totalHeight - alertsHeight;
  var heightRatio   = alertCount > 0 ? contentHeight / totalHeight : 1;
  var contentScale  = baseScale * heightRatio;
  return {
    alertCount:    alertCount,
    alertsHeight:  alertsHeight,
    contentHeight: contentHeight,
    contentScale:  contentScale,
  };
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
function renderFullPage(wx, apparent, daily, todayHiLo, hourly, alerts, aqi,
                        sunTimes, radarFrames, layout, layoutKey, darkBg) {
  const { width, height } = layout;
  const isFull    = (layoutKey === 'full');
  const condWidth = CONDITIONS_WIDTH[layoutKey];
  const radarWidth = width - condWidth;
  const stripH    = HOURLY_HEIGHT[layoutKey];

  const scale = isFull ? 1.18 : 1.0;

  const eff         = calcEffectiveHeight(alerts.active, height, scale);
  const activeAlerts = alerts.active ? alerts.active.slice(0, eff.alertCount) : [];
  const effectiveStripH = Math.round(HOURLY_HEIGHT[layoutKey] * (eff.contentScale / scale));

  const alertsHtml   = buildAlertBannersHtml(alerts.active, width, scale, eff.alertCount);
  const radarHtml    = buildRadarPanelHtml(radarWidth, scale);
  const condHtml     = buildConditionsPanelHtml(
    wx, apparent, daily, todayHiLo, alerts, aqi, sunTimes, condWidth, effectiveStripH, eff.contentScale, isFull
  );
  const hourlyHtml   = buildHourlyStripHtml(hourly, width, effectiveStripH, eff.contentScale);

  const styles = buildFullPageStyles(width, height, condWidth, effectiveStripH, eff.contentScale, isFull || darkBg);

  const body =
    '<div class="alerts">'  + alertsHtml + '</div>' +
    '<div class="main-row">' +
      '<div class="radar-panel">' + radarHtml + '</div>' +
      '<div class="cond-panel">'  + condHtml  + '</div>' +
    '</div>' +
    '<div class="hourly-strip">' + hourlyHtml + '</div>';

  const headExtra =
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" crossorigin="anonymous" referrerpolicy="no-referrer">' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>';

  return buildHtmlDoc(width, height, styles,
    body + buildRadarScript(radarFrames),
    headExtra
  );
}

// Renders a radar-only page for split/tri layouts with ?view=radar.
// Contains: optional alert banner, full-width animated radar map.
function renderRadarOnly(radarFrames, alerts, layout, layoutKey, darkBg) {
  const { width, height } = layout;
  const scale = 1.0;

  const eff = calcEffectiveHeight(alerts.active, height, scale);

  const alertsHtml = buildAlertBannersHtml(alerts.active, width, eff.contentScale, eff.alertCount);
  const radarHtml  = buildRadarPanelHtml(width, scale);

  const styles = buildRadarOnlyStyles(width, height, scale, darkBg);

  const body =
    '<div class="alerts">' + alertsHtml + '</div>' +
    '<div class="radar-wrap">' + radarHtml + '</div>';

  const headExtra =
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" crossorigin="anonymous" referrerpolicy="no-referrer">' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>';

  return buildHtmlDoc(width, height, styles,
    body + buildRadarScript(radarFrames),
    headExtra
  );
}

// Renders a conditions-only page for split/tri layouts with ?view=conditions.
// Contains: alert banners, current conditions, stats, sunrise/sunset, 3-day forecast.
// No hourly strip (too narrow for split/tri widths).
function renderConditionsOnly(wx, apparent, daily, todayHiLo, alerts, aqi,
                               sunTimes, layout, layoutKey, darkBg) {
  const { width, height } = layout;
  const scale = layoutKey === 'split' ? 1.0 : 0.88;

  const eff = calcEffectiveHeight(alerts.active, height, scale);

  const alertsHtml = buildAlertBannersHtml(alerts.active, width, eff.contentScale, eff.alertCount);
  const condHtml   = buildConditionsPanelHtml(
    wx, apparent, daily, todayHiLo, alerts, aqi, sunTimes, width, 0, eff.contentScale, false
  );

  const styles = buildConditionsOnlyStyles(width, height, eff.contentScale, darkBg);

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
// Format matches calendar-display: "⚠ EVENT NAME — until Day H:MM AM"
// The NWS p.headline field is intentionally omitted — it contains the full
// "issued [date] at [time] by NWS [office]" string which overflows the banner.
function buildAlertBannersHtml(activeAlerts, width, scale, maxAlerts) {
  if (!activeAlerts || activeAlerts.length === 0) return '';

  var alertsToShow = (maxAlerts !== undefined)
    ? activeAlerts.slice(0, maxAlerts)
    : activeAlerts;

  const fontSize = Math.round(18 * scale);
  const padV     = Math.round(9  * scale);
  const padH     = Math.round(16 * scale);

  let html = '';
  for (const p of alertsToShow) {
    const cls = alertSeverityClass(p.severity);

    // Use p.ends (actual event end) in preference to p.expires (product expiry)
    // for the "until" time, consistent with the calendar-display alert pattern.
    const endDate = p.ends ? new Date(p.ends) : (p.expires ? new Date(p.expires) : null);

    // Build the banner text as a single string: "⚠ EVENT — until Day H:MM AM"
    // Matches the calendar-display alert format — no headline body text.
    const txt = '\u26A0 ' +
      (p.event || 'Weather Alert') +
      (endDate ? ' \u2014 until ' + formatShortAlertTime(endDate) : '');

    html +=
      '<div class="alert-banner ' + cls + '" style="' +
        'padding:' + padV + 'px ' + padH + 'px;' +
        'font-size:' + fontSize + 'px;' +
      '">' +
        escapeHtml(txt) +
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
    '<div class="radar-credit">© OpenStreetMap/CARTO · RainViewer</div>';

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
function buildConditionsPanelHtml(wx, apparent, daily, todayHiLo, alerts, aqi,
                                   sunTimes, panelWidth, stripH, scale, isFull) {
  // Derive font sizes and padding from scale.
  const hdrFont    = Math.round(17 * scale);
  const bigTempFont = Math.round(46 * scale);
  const unitFont   = Math.round(23 * scale);
  const feelFont   = Math.round(19 * scale);
  const condFont   = Math.round(21 * scale);
  const statFont   = Math.round(20 * scale);
  const statLblFont = Math.round(15 * scale);
  const sunFont    = Math.round(17 * scale);
  const sunLblFont = Math.round(17 * scale);
  const fcDayFont  = Math.round(17 * scale);
  const fcDescFont = Math.round(18 * scale);
  const fcTempFont = Math.round(18 * scale);
  const fcWindFont = Math.round(13 * scale);   // wind line below condition description
  const pad        = Math.round(8 * scale);
  const hdrPad     = Math.round(5  * scale);

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
      ';color:' + aqi.category.text + ';font-size:' + Math.round(15 * scale) + 'px;">' +
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

  const pressVal  = wx.pressure   !== null ? wx.pressure   + ' inHg' : '--';
  const visVal    = wx.visibility !== null ? wx.visibility + ' mi' : '--';

  // Format today's hi/lo from raw daily periods passed from the top level.
  // daily[] has today filtered out for the forecast rows, so it cannot be used here.
  const hiLoVal = (todayHiLo.high !== null && todayHiLo.low !== null)
    ? todayHiLo.high + '°F / ' + todayHiLo.low + '°F'
    : todayHiLo.high !== null ? 'Hi ' + todayHiLo.high + '°F'
    : todayHiLo.low  !== null ? 'Lo ' + todayHiLo.low  + '°F tonight'
    : '--';

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
        '<span class="sun-icon">' + WX_SVG_SUNRISE + '</span>' +
        '<div>' +
          '<div class="sun-lbl" style="font-size:' + sunLblFont + 'px;">SUNRISE</div>' +
          '<div class="sun-time" style="font-size:' + sunFont + 'px;">' +
            escapeHtml(srStr) +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sun-cell">' +
        '<span class="sun-icon">' + WX_SVG_SUNSET + '</span>' +
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

    // Build wind line from daytime NWS fields — omitted silently if unavailable.
    // NWS windDirection is a cardinal string (e.g. "NW") and windSpeed is a
    // pre-formatted string (e.g. "10 to 20 mph"). "Wind:" label added for clarity.
    const windLine = (day.windDir || day.windSpeed)
      ? 'Wind: ' + escapeHtml([day.windDir, day.windSpeed].filter(Boolean).join(' '))
      : '';

    forecastRowsHtml +=
      '<div class="fc-row">' +
        '<div class="fc-day" style="font-size:' + fcDayFont + 'px;">' +
          escapeHtml(day.dayName) +
        '</div>' +
        '<div class="fc-icon">' + icon + '</div>' +
        '<div class="fc-desc">' +
          '<div class="fc-desc-text" style="font-size:' + fcDescFont + 'px;">' +
            escapeHtml(day.shortForecast || '') +
          '</div>' +
          (windLine
            ? '<div class="fc-wind" style="font-size:' + fcWindFont + 'px;">' +
                windLine +
              '</div>'
            : ''
          ) +
        '</div>' +
        (precip
          ? '<div class="fc-precip" style="font-size:' + fcDescFont + 'px;">' + WX_SVG_DROP + ' ' +
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
    (isFull ? sectionHeader('Current Conditions') : '') +
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

  const timeFontSize  = Math.round(13 * scale);
  const tempFontSize  = Math.round(18 * scale);
  const precipFontSize = Math.round(12 * scale);

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
          ? '<div class="hour-precip" style="font-size:' + precipFontSize + 'px;">' + WX_SVG_DROP_SM + ' ' +
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
// RainViewer frame data is fetched server-side and embedded as a JSON array —
// no client-side fetch required. Each frame object:
//   tileBase — CDN URL prefix (e.g. "https://tilecache.rainviewer.com/v2/radar/1744300800")
//   time     — Unix timestamp in seconds (for the on-screen time label)
//
// Tile URL: {tileBase}/512/{z}/{x}/{y}/4/0_0.png
//   512    = tile size in pixels (required for zoom 7–8; 256px only supports 0–6)
//   4      = Meteored colour scheme (closest to standard NWS radar palette)
//   0_0    = smooth:off, snow:off
//
// Leaflet zoomOffset:-1 compensates for 512px tile size so that the visual
// zoom level (RADAR_ZOOM=8) requests zoom-7 tiles from the server. This is
// the standard Leaflet approach for 512px tiles and matches the tile size used.
//
// If radarFrames is null (server fetch failed), the "Radar data unavailable"
// fallback message is shown over the base map.
function buildRadarScript(radarFrames) {
  const frames     = radarFrames || [];
  const framesJson = JSON.stringify(frames);

  return (
    '<script>' +
    'var RADAR_LAT='      + LOCATION_LAT   + ';' +
    'var RADAR_LON='      + LOCATION_LON   + ';' +
    'var RADAR_ZOOM='     + RADAR_ZOOM     + ';' +
    'var RADAR_OPACITY='  + RADAR_OPACITY  + ';' +
    'var RADAR_FRAME_MS=' + RADAR_FRAME_MS + ';' +
    'var RADAR_HOLD_MS='  + RADAR_HOLD_MS  + ';' +
    'var RADAR_FRAMES='   + framesJson     + ';' +

    'document.addEventListener("DOMContentLoaded",function(){' +

      // Create the Leaflet map. All interaction disabled — passive display only.
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

      // CartoDB Dark Matter base tiles — near-black background with subtle grey
      // road and label detail. Improves radar colour legibility on dark station
      // displays compared to the default light OSM tiles. Free tier; no API key
      // required. Attribution covers both OSM data and CARTO styling.
      // {r} enables retina/HiDPI tiles automatically where supported.
      'L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{' +
        'attribution:"© <a href=\'https://www.openstreetmap.org/copyright\'>OpenStreetMap</a> contributors © <a href=\'https://carto.com/attributions\'>CARTO</a>",' +
        'maxZoom:19' +
      '}).addTo(map);' +

      // Show fallback message if server-side frame fetch failed.
      'if(!RADAR_FRAMES||!RADAR_FRAMES.length){' +
        'var el=document.getElementById("radar-unavailable");' +
        'if(el)el.style.display="flex";' +
        'return;' +
      '}' +

      // Pre-create one tile layer per frame, all hidden at opacity 0.
      // Adding them immediately triggers background tile pre-loading.
      // 512px tiles with zoomOffset:-1: visual zoom 8 → server zoom 7.
      // This is required because RainViewer 256px tiles cap at zoom 6.
      'var layers=RADAR_FRAMES.map(function(f){' +
        'return L.tileLayer(f.tileBase+"/512/{z}/{x}/{y}/4/0_0.png",{' +
          'opacity:0,' +
          'tileSize:512,' +
          'zoomOffset:-1' +
        '});' +
      '});' +
      'layers.forEach(function(l){l.addTo(map);});' +

      'var frameIdx=0;' +
      'var progressEl=document.getElementById("radar-progress");' +
      'var timeEl=document.getElementById("radar-time");' +

      'function showFrame(){' +
        'layers.forEach(function(l,i){' +
          'l.setOpacity(i===frameIdx?RADAR_OPACITY:0);' +
        '});' +
        // RainViewer times are Unix seconds — multiply by 1000 for JS Date.
        'if(timeEl){' +
          'var ts=new Date(RADAR_FRAMES[frameIdx].time*1000);' +
          'timeEl.textContent=ts.toLocaleTimeString("en-US",{' +
            'timeZone:"America/Chicago",' +
            'hour:"numeric",minute:"2-digit",hour12:true' +
          '});' +
        '}' +
        'if(progressEl){' +
          'progressEl.style.width=((frameIdx+1)/layers.length*100)+"%";' +
        '}' +
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
// useSolidBg: true when the full layout is active OR when ?bg=dark is set.
// In both cases a solid dark background is rendered; otherwise transparent
// so the display hardware's charcoal texture shows through.
function baseStyles(width, height, useSolidBg) {
  return (
    '*, *::before, *::after{box-sizing:border-box;margin:0;padding:0;}' +
    'html,body{' +
      'width:' + width + 'px;height:' + height + 'px;' +
      'overflow:hidden;' +
      'background:' + (useSolidBg ? DARK_BG_COLOR : 'transparent') + ';color:' + TEXT_PRIMARY + ';' +
      'font-family:' + FONT_STACK + ';' +
    '}' +

    // Alert banners — stacked above all content, colour-coded by severity.
    // Plain text layout (no flex sub-elements) matches the calendar-display banner.
    '.alerts{flex-shrink:0;}' +
    '.alert-banner{' +
      'border-radius:4px;' +
      'border:1px solid ' + BORDER_SUBTLE + ';' +
      'font-weight:700;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
    '}' +
    '.alert-warning {background:' + ALERT_WARNING_BG + ';border-left:4px solid ' + ALERT_WARNING_BORDER + ';color:' + ALERT_WARNING_TEXT + ';}' +
    '.alert-watch   {background:' + ALERT_WATCH_BG + ';border-left:4px solid ' + ALERT_WATCH_BORDER + ';color:' + ALERT_WATCH_TEXT + ';}' +
    '.alert-advisory{background:' + ALERT_ADVISORY_BG + ';border-left:4px solid ' + ALERT_ADVISORY_BORDER + ';color:' + ALERT_ADVISORY_TEXT + ';}' +

    // Radar panel — dark background is appropriate for map legibility.
    '#radar-map{width:100%;height:100%;}' +
    '.radar-legend{' +
      'position:absolute;top:10px;left:10px;z-index:1000;' +
      'background:rgba(0,0,0,0.55);border:1px solid ' + BORDER_SUBTLE + ';' +
      'border-radius:4px;padding:5px 8px;' +
    '}' +
    '.legend-title{color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:.05em;' +
      'margin-bottom:3px;}' +
    '.legend-bar{' +
      'height:8px;width:120px;border-radius:2px;' +
      'background:linear-gradient(90deg,' +
        '#04e9e7 0%,#019ff4 12%,#0300f4 22%,#02fd02 34%,#01c501 45%,' +
        '#008e00 54%,#fdf802 63%,#e5bc00 72%,#fd9500 81%,#fd0000 90%,#a10000 100%);}' +
    '.legend-labels{display:flex;justify-content:space-between;width:120px;' +
      'color:rgba(255,255,255,0.55);margin-top:2px;}' +
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
      'background:linear-gradient(90deg,' + ACCENT_COLOR + ',#e03030);' +
      'border-radius:0 2px 2px 0;transition:width .2s ease;}' +
    '.radar-unavailable{' +
      'position:absolute;inset:0;z-index:999;' +
      'display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.75);color:rgba(255,255,255,0.55);' +
      'font-size:14px;letter-spacing:.05em;' +
    '}' +

    // Conditions panel — white-tinted card surface on transparent background.
    '.cond-panel{' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'background:' + CARD_BASE + ';border-left:1px solid ' + BORDER_SUBTLE + ';' +
    '}' +
    // Section headers use FFD brand red — a functional label treatment, not decorative.
    '.sec-hdr{' +
      'background:' + ACCENT_COLOR + ';' +
      'font-weight:700;letter-spacing:.1em;text-transform:uppercase;' +
      'flex-shrink:0;' +
    '}' +
    '.current-block{' +
      'display:flex;align-items:flex-start;gap:10px;' +
      'background:' + CARD_ELEVATED + ';flex-shrink:0;border-bottom:1px solid ' + BORDER_SUBTLE + ';' +
    '}' +
    '.temp-side{flex:1;}' +
    '.temp-main{display:flex;align-items:flex-end;line-height:1;}' +
    '.temp-val{font-weight:600;color:#fff;}' +
    '.temp-unit{color:rgba(255,255,255,0.45);margin-bottom:4px;margin-left:2px;}' +
    '.feels{color:' + TEXT_SECONDARY + ';margin-top:4px;}' +
    '.aqi-badge{' +
      'display:inline-block;padding:2px 7px;border-radius:3px;' +
      'font-weight:700;letter-spacing:.05em;' +
    '}' +
    '.cond-side{' +
      'display:flex;flex-direction:column;align-items:center;gap:4px;' +
      'flex-shrink:0;' +
    '}' +
    '.cond-text{color:' + TEXT_SECONDARY + ';text-align:center;text-transform:uppercase;' +
      'letter-spacing:.04em;}' +

    // Stats grid — 2-column grid, last row spans both columns
    '.stats-grid{' +
      'display:grid;grid-template-columns:1fr 1fr;flex-shrink:0;' +
      'border-bottom:1px solid ' + BORDER_SUBTLE + ';' +
    '}' +
    '.stat-cell{' +
      'padding:6px 10px;border-bottom:1px solid ' + BORDER_SUBTLE + ';' +
    '}' +
    '.stat-cell:nth-child(odd){border-right:1px solid ' + BORDER_SUBTLE + ';}' +
    '.stat-span2{grid-column:span 2;border-right:none;}' +
    '.stat-lbl{color:' + TEXT_SECONDARY + ';text-transform:uppercase;letter-spacing:.05em;}' +
    '.stat-val{color:' + TEXT_PRIMARY + ';margin-top:1px;white-space:nowrap;' +
      'overflow:hidden;text-overflow:ellipsis;}' +

    // Sunrise / sunset row
    '.sun-row{' +
      'display:grid;grid-template-columns:1fr 1fr;flex-shrink:0;' +
      'border-bottom:1px solid ' + BORDER_SUBTLE + ';background:rgba(255,255,255,0.04);' +
    '}' +
    '.sun-cell{display:flex;align-items:center;gap:8px;padding:6px 10px;}' +
    '.sun-cell:first-child{border-right:1px solid ' + BORDER_SUBTLE + ';}' +
    '.sun-icon{font-size:18px;}' +
    '.sun-lbl{color:' + TEXT_SECONDARY + ';text-transform:uppercase;letter-spacing:.05em;}' +
    '.sun-time{color:#f0c040;font-weight:600;}' +

    // 3-day forecast
    '.forecast{flex:1;display:flex;flex-direction:column;min-height:0;}' +
    '.fc-row{' +
      'flex:1;display:grid;' +
      'grid-template-columns:50px auto 1fr auto auto auto;' +
      'align-items:center;gap:6px;' +
      'padding:0 10px;' +
      'border-bottom:1px solid ' + BORDER_SUBTLE + ';min-height:0;' +
    '}' +
    '.fc-row:last-child{border-bottom:none;}' +
    '.fc-row:nth-child(even){background:rgba(255,255,255,0.04);}' +
    // Day name in forecast rows — white, bold. The red section header above
    // already provides the brand accent; repeating red here would be redundant.
    '.fc-day{font-weight:700;color:' + TEXT_PRIMARY + ';text-transform:uppercase;' +
      'letter-spacing:.05em;}' +
    '.fc-icon{flex-shrink:0;}' +
    // fc-desc is a flex column: condition text on top, wind line below.
    '.fc-desc{display:flex;flex-direction:column;justify-content:center;' +
      'overflow:hidden;min-width:0;}' +
    '.fc-desc-text{color:' + TEXT_PRIMARY + ';white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;}' +
    '.fc-wind{color:rgba(255,255,255,0.55);white-space:nowrap;overflow:hidden;' +
      'text-overflow:ellipsis;margin-top:2px;}' +
    '.fc-precip{color:#4db8ff;font-weight:600;white-space:nowrap;}' +
    '.fc-temp{color:' + TEXT_PRIMARY + ';font-weight:600;white-space:nowrap;text-align:right;}' +
    '.fc-sep{color:' + TEXT_TERTIARY + ';margin:0 2px;}' +
    '.fc-badge{white-space:nowrap;}' +
    '.alert-badge{display:inline-block;padding:1px 5px;border-radius:3px;' +
      'font-weight:700;letter-spacing:.04em;}' +
    '.badge-warning {background:#cc2222;color:#fff;}' +
    '.badge-watch   {background:#cc6000;color:#fff;}' +
    '.badge-advisory{background:#888800;color:#fff;}' +

    // Hourly strip — white-tinted card, separated from main row by a slightly
    // brighter border to give visual weight without a red accent bar.
    '.hourly-strip{' +
      'display:flex;flex-direction:row;align-items:stretch;' +
      'border-top:1px solid ' + BORDER_STRONG + ';background:' + CARD_BASE + ';flex-shrink:0;' +
    '}' +
    '.hour-card{' +
      'flex:1;display:grid;' +
      'grid-template-columns:auto auto;' +
      'grid-template-rows:1fr 1fr;' +
      'justify-content:space-around;' +
      'align-items:center;' +
      'border-right:1px solid ' + BORDER_SUBTLE + ';' +
      'padding:4px 4px;' +
    '}' +
    '.hour-card:last-child{border-right:none;}' +
    '.hour-time{' +
      'grid-column:1;grid-row:1;' +
      'color:' + TEXT_SECONDARY + ';' +
      'text-transform:uppercase;letter-spacing:.04em;' +
      'align-self:center;justify-self:center;' +
    '}' +
    '.hour-icon{' +
      'grid-column:2;grid-row:1;' +
      'display:flex;align-items:center;justify-content:center;' +
    '}' +
    '.hour-temp{' +
      'grid-column:1;grid-row:2;' +
      'color:#fff;font-weight:600;' +
      'align-self:center;justify-self:center;' +
    '}' +
    '.hour-precip{' +
      'grid-column:2;grid-row:2;' +
      'color:#4db8ff;' +
      'display:flex;align-items:center;justify-content:center;' +
    '}' +
    '.hourly-empty{flex:1;display:flex;align-items:center;justify-content:center;' +
      'color:' + TEXT_TERTIARY + ';font-size:12px;}'
  );
}

// CSS for the wide / full layout (radar + conditions side by side + hourly strip).
function buildFullPageStyles(width, height, condWidth, stripH, scale, useSolidBg) {
  return (
    baseStyles(width, height, useSolidBg) +
    'body{display:flex;flex-direction:column;}' +
    '.main-row{flex:1;min-height:0;display:flex;flex-direction:row;}' +
    '.radar-panel{flex:1;min-width:0;position:relative;}' +
    '.cond-panel{width:' + condWidth + 'px;flex-shrink:0;}' +
    '.hourly-strip{height:' + stripH + 'px;}'
  );
}

// CSS for split/tri radar-only layout.
function buildRadarOnlyStyles(width, height, scale, darkBg) {
  return (
    baseStyles(width, height, darkBg) +
    'body{display:flex;flex-direction:column;}' +
    '.radar-wrap{flex:1;min-height:0;position:relative;}'
  );
}

// CSS for split/tri conditions-only layout.
function buildConditionsOnlyStyles(width, height, scale, darkBg) {
  return (
    baseStyles(width, height, darkBg) +
    'body{display:flex;flex-direction:column;}' +
    '.cond-panel{flex:1;min-height:0;border-left:none;}'
  );
}


// =============================================================================
// ERROR PAGE
// =============================================================================

function renderErrorPage(title, subtitle, layout, darkBg) {
  const { width, height } = layout;
  const titleFont = Math.floor(Math.min(width, height) * 0.030);
  const subFont   = Math.floor(Math.min(width, height) * 0.020);

  return new Response(
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head><meta charset="UTF-8">' +
    '<meta http-equiv="refresh" content="' + ERROR_RETRY_SECONDS + '">' +
    '<title>FFD Weather</title>' +
    '<style>' +
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}' +
    'html,body{width:' + width + 'px;height:' + height + 'px;overflow:hidden;' +
      'background:' + (darkBg ? DARK_BG_COLOR : 'transparent') + ';' +
      'font-family:' + FONT_STACK + ';' +
      'display:flex;align-items:center;justify-content:center;}' +
    '.err-wrap{display:flex;flex-direction:column;align-items:center;gap:' + Math.floor(subFont * 0.6) + 'px;text-align:center;}' +
    '.err-title{font-size:' + titleFont + 'px;font-weight:700;color:' + ACCENT_COLOR + ';letter-spacing:.06em;}' +
    '.err-sub{font-size:'   + subFont   + 'px;color:' + TEXT_PRIMARY + ';}' +
    '</style></head>' +
    '<body>' +
    '<div class="err-wrap">' +
    '<div class="err-title">' + escapeHtml(title)    + '</div>' +
    '<div class="err-sub">'   + escapeHtml(subtitle) + '</div>' +
    '</div>' +
    '</body></html>',
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

// Converts a NWS pressure value object (Pa) to inHg, rounded to 2 decimal places.
// 1 inHg = 3386.389 Pa
function nwsPaToInHg(valueObj) {
  if (!valueObj || valueObj.value === null || valueObj.value === undefined) return null;
  return Math.round(valueObj.value / 3386.389 * 100) / 100;
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
