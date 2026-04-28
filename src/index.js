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
// Milliseconds to wait after DOMContentLoaded before initializing the
// Leaflet radar map. On Raspberry Pi hardware without GPU acceleration,
// layout may not be complete when DOMContentLoaded fires, causing Leaflet
// to measure a zero or incorrect map container size and only load one tile.
// Increase if radar still partially loads on hardware; 250ms is a safe default.
const RADAR_INIT_DELAY_MS = 1000;
// Radar rendering mode.
// 'leaflet' — Leaflet.js double-buffer tile map (default).
//             Best geographic detail. May have memory issues on Pi hardware.
// 'image'   — Server-side fetched RainViewer frames on a static base map.
//             Lower Pi resource usage. No Leaflet dependency.
//             Switch to this mode if Leaflet has persistent issues on hardware.
const RADAR_MODE = 'leaflet';
const RADAR_OPACITY     =  0.3;  // radar overlay opacity (0–1)

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


// Base map image for RADAR_MODE = 'image'.
// CartoDB Dark Matter map centered on Fargo, ND at zoom 7.
// Pre-encoded as base64 PNG — no runtime fetch required.
// Captured from the Leaflet radar panel at full layout.
// To update: recapture from the staging URL, resize to 800x670,
// base64 encode, and replace this string.
const RADAR_BASEMAP_B64 = 'data:image/png;base64,' + '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';

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
        needsRadar ? (RADAR_MODE === 'image' ? fetchRainViewerFramesAsImages() : fetchRainViewerFrames()) : Promise.resolve(null),
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


// Fetches RainViewer radar frames as base64-encoded PNG images for image mode.
// Each frame is fetched as a single coordinate-based image covering the
// Fargo area — no tile stitching required.
// Returns array of { time, b64 } objects, or null on failure.
async function fetchRainViewerFramesAsImages() {
  try {
    var apiRes = await fetchWithTimeout(
      'https://api.rainviewer.com/public/weather-maps.json', {}, 8000
    );
    if (!apiRes.ok) {
      console.error('RainViewer weather-maps.json fetch failed: ' + apiRes.status);
      return null;
    }
    var data = await apiRes.json();
    if (!data || !data.radar || !data.radar.past) return null;

    var host   = data.host;
    var frames = data.radar.past.slice(-RADAR_FRAME_COUNT);

    var results = await Promise.all(frames.map(async function(f) {
      var url = host + f.path + '/512/7/' +
        LOCATION_LAT + '/' + LOCATION_LON + '/2/1_0.png';
      try {
        var imgRes = await fetchWithTimeout(url, {}, 8000);
        if (!imgRes.ok) return null;
        var buf    = await imgRes.arrayBuffer();
        var bytes  = new Uint8Array(buf);
        var binary = '';
        for (var i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return { time: f.time, b64: 'data:image/png;base64,' + btoa(binary) };
      } catch (e) {
        console.error('RainViewer frame fetch error:', e && e.message ? e.message : e);
        return null;
      }
    }));

    var valid = results.filter(Boolean);
    return valid.length > 0 ? valid : null;
  } catch (e) {
    console.error('fetchRainViewerFramesAsImages error:', e && e.message ? e.message : e);
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
  const radarHtml    = RADAR_MODE === 'image'
    ? buildRadarImageHtml(radarFrames)
    : buildRadarPanelHtml(radarWidth, scale);
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

  const headExtra = RADAR_MODE === 'leaflet'
    ? '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" crossorigin="anonymous" referrerpolicy="no-referrer">' +
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>'
    : '';

  return buildHtmlDoc(width, height, styles,
    body + (RADAR_MODE === 'image' ? '' : buildRadarScript(radarFrames)),
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
  const radarHtml  = RADAR_MODE === 'image'
    ? buildRadarImageHtml(radarFrames)
    : buildRadarPanelHtml(width, scale);

  const styles = buildRadarOnlyStyles(width, height, scale, darkBg);

  const body =
    '<div class="alerts">' + alertsHtml + '</div>' +
    '<div class="radar-wrap">' + radarHtml + '</div>';

  const headExtra = RADAR_MODE === 'leaflet'
    ? '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" integrity="sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" crossorigin="anonymous" referrerpolicy="no-referrer">' +
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" integrity="sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>'
    : '';

  return buildHtmlDoc(width, height, styles,
    body + (RADAR_MODE === 'image' ? '' : buildRadarScript(radarFrames)),
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
      'RADAR · <span id="radar-stamp-time">--:-- --</span> CDT' +
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
    'var RADAR_LAT='            + LOCATION_LAT       + ';' +
    'var RADAR_LON='            + LOCATION_LON       + ';' +
    'var RADAR_ZOOM='           + RADAR_ZOOM         + ';' +
    'var RADAR_OPACITY='        + RADAR_OPACITY      + ';' +
    'var RADAR_FRAME_MS='       + RADAR_FRAME_MS     + ';' +
    'var RADAR_HOLD_MS='        + RADAR_HOLD_MS      + ';' +
    'var RADAR_INIT_DELAY_MS='  + RADAR_INIT_DELAY_MS + ';' +
    'var RADAR_FRAMES='         + framesJson         + ';' +

    'document.addEventListener("DOMContentLoaded",function(){' +
      'setTimeout(function(){' +

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

        'var baseLayer=L.tileLayer(' +
          '"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{' +
          'attribution:"© <a href=\'https://www.openstreetmap.org/copyright\'>' +
            'OpenStreetMap</a> contributors ' +
            '© <a href=\'https://carto.com/attributions\'>CARTO</a>",' +
          'maxZoom:19,' +
          'keepBuffer:2' +
        '});' +
        'baseLayer.addTo(map);' +

        'map.invalidateSize();' +

        'if(!RADAR_FRAMES||!RADAR_FRAMES.length){' +
          'var el=document.getElementById("radar-unavailable");' +
          'if(el)el.style.display="flex";' +
          'return;' +
        '}' +

        // Two alternating radar layers — double buffer.
        // layerA shows the current frame; layerB preloads the next frame.
        // They swap roles each frame so one is always visible while the
        // other loads invisibly in the background.
        'var layerA=L.tileLayer(RADAR_FRAMES[0].tileBase+"/512/{z}/{x}/{y}/4/0_0.png",{' +
          'opacity:RADAR_OPACITY,' +
          'tileSize:512,' +
          'zoomOffset:-1,' +
          'keepBuffer:0' +
        '});' +
        'var layerB=L.tileLayer(RADAR_FRAMES[Math.min(1,RADAR_FRAMES.length-1)].tileBase+"/512/{z}/{x}/{y}/4/0_0.png",{' +
          'opacity:0,' +
          'tileSize:512,' +
          'zoomOffset:-1,' +
          'keepBuffer:0' +
        '});' +
        'layerA.addTo(map);' +
        'layerB.addTo(map);' +

        'var frameIdx=0;' +
        'var activeLayer=layerA;' +
        'var bufferLayer=layerB;' +
        'var progressEl=document.getElementById("radar-progress");' +
        'var timeEl=document.getElementById("radar-stamp-time");' +

        'function updateTimestamp(){' +
          'if(timeEl){' +
            'var ts=new Date(RADAR_FRAMES[frameIdx].time*1000);' +
            'timeEl.textContent=ts.toLocaleTimeString("en-US",{' +
              'timeZone:"America/Chicago",' +
              'hour:"numeric",minute:"2-digit",hour12:true' +
            '});' +
          '}' +
          'if(progressEl){' +
            'progressEl.style.width=((frameIdx+1)/RADAR_FRAMES.length*100)+"%";' +
          '}' +
        '}' +

        'function showFrame(){' +
          'var isLast=(frameIdx===RADAR_FRAMES.length-1);' +

          // Swap: make buffer visible, hide active
          'activeLayer.setOpacity(0);' +
          'bufferLayer.setOpacity(RADAR_OPACITY);' +

          // Swap roles
          'var tmp=activeLayer;' +
          'activeLayer=bufferLayer;' +
          'bufferLayer=tmp;' +

          'updateTimestamp();' +

          // Advance frame index
          'frameIdx=(frameIdx+1)%RADAR_FRAMES.length;' +

          // Preload next frame on the buffer layer
          'var nextIdx=(frameIdx+1)%RADAR_FRAMES.length;' +
          'bufferLayer.setUrl(RADAR_FRAMES[nextIdx].tileBase+"/512/{z}/{x}/{y}/4/0_0.png");' +

          'if(isLast){' +
            'setTimeout(function(){' +
              'map.invalidateSize();' +
              'setTimeout(showFrame,RADAR_FRAME_MS);' +
            '},RADAR_HOLD_MS);' +
          '} else {' +
            'setTimeout(showFrame,RADAR_FRAME_MS);' +
          '}' +
        '}' +

        'updateTimestamp();' +
        'setTimeout(showFrame,RADAR_FRAME_MS);' +

      '},RADAR_INIT_DELAY_MS);' +
    '});' +
    '</script>'
  );
}


// Builds the radar panel HTML for image mode (RADAR_MODE = 'image').
// Returns self-contained HTML with embedded base64 images and a simple
// CSS opacity animation loop. No Leaflet, no tile loading, no external JS.
function buildRadarImageHtml(radarFrames) {
  var frames   = radarFrames || [];
  var frameCount = frames.length;

  if (frameCount === 0) {
    return '<div id="radar-image-wrap" style="position:relative;width:100%;height:100%;' +
      'background:#111111;display:flex;align-items:center;justify-content:center;">'
      + '<span style="color:rgba(255,255,255,0.45);font-size:14px;">Radar data unavailable</span>'
      + '</div>';
  }

  // Base map image — always visible underneath radar frames
  var html =
    '<div id="radar-image-wrap" style="position:relative;width:100%;height:100%;overflow:hidden;">'
    + '<img src="' + RADAR_BASEMAP_B64 + '" '
      + 'style="position:absolute;top:0;left:0;width:100%;height:100%;'
      + 'object-fit:cover;object-position:center;" alt=""/>';

  // Radar frame images stacked on top
  for (var i = 0; i < frameCount; i++) {
    html +=
      '<img id="rf-' + i + '" src="' + frames[i].b64 + '" '
        + 'data-time="' + frames[i].time + '" '
        + 'style="position:absolute;top:0;left:0;width:100%;height:100%;'
        + 'object-fit:cover;object-position:center;'
        + 'opacity:' + (i === 0 ? RADAR_OPACITY : 0) + ';'
        + 'transition:opacity 0.1s linear;" alt=""/>';
  }

  html += '</div>';

  // Animation script
  html +=
    '<script>'
    + 'var RF_COUNT='       + frameCount    + ';'
    + 'var RF_OPACITY='     + RADAR_OPACITY  + ';'
    + 'var RF_FRAME_MS='    + RADAR_FRAME_MS + ';'
    + 'var RF_HOLD_MS='     + RADAR_HOLD_MS  + ';'
    + '(function(){'
      + 'var idx=0;'
      + 'var progressEl=document.getElementById("radar-progress");'
      + 'var stampEl=document.getElementById("radar-stamp-time");'
      + 'var imgs=[];'
      + 'for(var i=0;i<RF_COUNT;i++){'
        + 'imgs.push(document.getElementById("rf-"+i));'
      + '}'
      + 'function showFrame(){'
        + 'var isLast=(idx===RF_COUNT-1);'
        + 'for(var i=0;i<RF_COUNT;i++){'
          + 'imgs[i].style.opacity=(i===idx?RF_OPACITY:0);'
        + '}'
        + 'if(progressEl){'
          + 'progressEl.style.width=((idx+1)/RF_COUNT*100)+"%";'
        + '}'
        + 'if(stampEl){'
          + 'var ts=new Date(parseInt(imgs[idx].dataset.time,10)*1000);'
          + 'stampEl.textContent=ts.toLocaleTimeString("en-US",{'
            + 'timeZone:"America/Chicago",'
            + 'hour:"numeric",minute:"2-digit",hour12:true'
          + '});'
        + '}'
        + 'idx=(idx+1)%RF_COUNT;'
        + 'setTimeout(showFrame,isLast?RF_HOLD_MS:RF_FRAME_MS);'
      + '}'
      + 'setTimeout(showFrame,RF_FRAME_MS);'
    + '}());'
    + '</script>';

  return html;
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
