/**
 * directions.ts — driving routes for ParkStop's in-app navigation.
 *
 * Uses the Google Routes API (computeRoutes) with the app's Google Maps key.
 * Returns the route line plus turn-by-turn steps. Nothing here opens Google
 * Maps or any other app — the route is drawn and followed inside ParkStop.
 *
 * This file never shows alerts itself; it returns a clear result and the
 * screen decides what to tell the driver.
 */

const GOOGLE_MAPS_KEY = process.env.EXPO_PUBLIC_ANDROID_MAPS_KEY || '';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.startLocation',
  'routes.legs.steps.endLocation',
  'routes.legs.steps.navigationInstruction',
].join(',');

export type LatLng = { latitude: number; longitude: number };

/** One turn-by-turn step. The maneuver happens at the START of the step. */
export interface NavStep {
  /** Google maneuver code, e.g. TURN_LEFT, ROUNDABOUT_RIGHT, DEPART. */
  maneuver: string;
  /** Text to show, e.g. "Turn left onto MG Road". */
  instruction: string;
  /** Length of this step in metres. */
  distanceM: number;
  start: LatLng;
  end: LatLng;
}

export interface NavRoute {
  coords: LatLng[];
  /** Total distance in metres. */
  distanceM: number;
  /** Estimated duration in seconds (with live traffic). */
  durationS: number;
  steps: NavStep[];
}

export type RouteResult =
  | { ok: true; route: NavRoute }
  | { ok: false; message: string };

/** Decode a Google-encoded polyline (precision 5). */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return points;
}

const toLatLng = (loc: any): LatLng | null => {
  const p = loc?.latLng;
  if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return null;
  return { latitude: p.latitude, longitude: p.longitude };
};

/** "600s" -> 600 */
const seconds = (d: any): number => {
  const n = parseFloat(String(d ?? '0').replace('s', ''));
  return Number.isFinite(n) ? n : 0;
};

/** Plain-English fallback when Google gives a maneuver without text. */
function defaultInstruction(maneuver: string): string {
  switch (maneuver) {
    case 'TURN_LEFT': return 'Turn left';
    case 'TURN_RIGHT': return 'Turn right';
    case 'TURN_SLIGHT_LEFT': return 'Keep slightly left';
    case 'TURN_SLIGHT_RIGHT': return 'Keep slightly right';
    case 'TURN_SHARP_LEFT': return 'Turn sharp left';
    case 'TURN_SHARP_RIGHT': return 'Turn sharp right';
    case 'UTURN_LEFT':
    case 'UTURN_RIGHT': return 'Make a U-turn';
    case 'RAMP_LEFT': return 'Take the ramp on the left';
    case 'RAMP_RIGHT': return 'Take the ramp on the right';
    case 'FORK_LEFT': return 'Keep left at the fork';
    case 'FORK_RIGHT': return 'Keep right at the fork';
    case 'MERGE': return 'Merge';
    case 'ROUNDABOUT_LEFT':
    case 'ROUNDABOUT_RIGHT': return 'Take the roundabout';
    case 'DEPART': return 'Start driving';
    default: return 'Continue straight';
  }
}

/** Turn Google's error into a sentence the developer can act on. */
function explainError(status: number, json: any): string {
  const msg: string = json?.error?.message || '';
  const reason: string = json?.error?.status || '';
  if (status === 403 || reason === 'PERMISSION_DENIED') {
    if (/not been used|disabled|not enabled/i.test(msg)) {
      return 'Routes API is not enabled for this Google Cloud project.';
    }
    if (/API_KEY_ANDROID_APP_BLOCKED|android/i.test(msg)) {
      return 'The Google Maps key only allows Android apps. Set "Application restrictions" to None for this key.';
    }
    if (/blocked|restrict/i.test(msg)) {
      return 'The Google Maps key is not allowed to use the Routes API. Add "Routes API" to this key\'s API restrictions.';
    }
    return `Google refused the route request (${msg || 'permission denied'}).`;
  }
  if (status === 400 && /api key/i.test(msg)) return 'The Google Maps key in .env is not valid.';
  if (status === 429) return 'Too many route requests. Please try again in a minute.';
  return msg || `Google returned an error (${status}).`;
}

export async function fetchRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): Promise<RouteResult> {
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) {
    return { ok: false, message: 'We could not find your location or the spot location.' };
  }
  if (!GOOGLE_MAPS_KEY) {
    return { ok: false, message: 'Google Maps key is missing. Add EXPO_PUBLIC_ANDROID_MAPS_KEY to frontend/.env and restart Metro with --clear.' };
  }

  const body = {
    origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
    destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
    languageCode: 'en-IN',
    units: 'METRIC',
  };

  let res: Response;
  try {
    res = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[ParkStop nav] network error:', err);
    return { ok: false, message: 'No internet connection. Please check your network and try again.' };
  }

  let json: any = null;
  try { json = await res.json(); } catch { /* handled below */ }

  if (!res.ok || json?.error) {
    console.warn('[ParkStop nav] Routes API error:', res.status, JSON.stringify(json?.error || json));
    return { ok: false, message: explainError(res.status, json) };
  }

  const r = json?.routes?.[0];
  const encoded: string | undefined = r?.polyline?.encodedPolyline;
  if (!r || !encoded) {
    return { ok: false, message: 'No driving route was found to this spot.' };
  }

  const coords = decodePolyline(encoded);
  if (coords.length < 2) {
    return { ok: false, message: 'No driving route was found to this spot.' };
  }

  const steps: NavStep[] = [];
  for (const leg of r.legs || []) {
    for (const st of leg.steps || []) {
      const start = toLatLng(st.startLocation);
      const end = toLatLng(st.endLocation);
      if (!start || !end) continue;
      const maneuver: string = st.navigationInstruction?.maneuver || 'STRAIGHT';
      const text: string = (st.navigationInstruction?.instructions || '').replace(/\s+/g, ' ').trim();
      steps.push({
        maneuver,
        instruction: text || defaultInstruction(maneuver),
        distanceM: Number(st.distanceMeters) || 0,
        start,
        end,
      });
    }
  }

  return {
    ok: true,
    route: {
      coords,
      distanceM: Number(r.distanceMeters) || 0,
      durationS: seconds(r.duration),
      steps,
    },
  };
}
