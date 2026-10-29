/**
 * useInAppNavigation — ParkStop's own turn-by-turn navigation.
 *
 *   start(dest)   fetch a Google route from the driver's position and begin
 *   stop()        end navigation and clear the route
 *   reroute()     fetch a fresh route from where the driver is now
 *                 (the map calls this when the driver leaves the route)
 *
 * While navigating it:
 *   - streams navigation-grade GPS (1 s fixes) back to the screen
 *   - works out how far along the route the driver is
 *   - picks the next turn and the distance to it
 *   - keeps remaining distance, time and arrival clock up to date
 *   - flips to "arrived" when the driver reaches the spot
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { fetchRoute, NavRoute, NavStep, LatLng } from '../utils/directions';

export type NavPhase = 'idle' | 'loading' | 'navigating' | 'arrived';

export type NavDestination = { lat: number; lng: number; title?: string };

export type NavProgress = {
  /** The turn coming up next (null when the next thing is the destination). */
  nextStep: NavStep | null;
  /** Metres to the next turn, or to the destination if no turns are left. */
  distanceToNextM: number;
  remainingM: number;
  remainingS: number;
};

export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'no-location' | 'already-here' | 'error'; message: string };

type Fix = { lat: number; lng: number; accuracy: number; heading: number | null; speed: number | null };

/** Arrival radius in metres. */
const ARRIVE_M = 30;
/** Closer than this when tapping Navigate means "you're already here". */
const ALREADY_HERE_M = 40;
/** Never re-route more often than this. */
const REROUTE_MIN_GAP_MS = 12000;

/* Flat-earth metres — accurate to well under 1% at city scale. */
function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lng - a.lng) * 111320 * cosLat;
  const dy = (b.lat - a.lat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

function segLen(p: LatLng, q: LatLng) {
  return metres({ lat: p.latitude, lng: p.longitude }, { lat: q.latitude, lng: q.longitude });
}

/** Cumulative distance (m) at each route vertex. */
function cumulative(coords: LatLng[]) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segLen(coords[i - 1], coords[i]));
  return cum;
}

/** How far along the route (m) the point sits, by projecting onto the nearest segment. */
function distanceAlong(coords: LatLng[], cum: number[], u: { lat: number; lng: number }) {
  const cosLat = Math.cos((u.lat * Math.PI) / 180);
  let best = Infinity;
  let along = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i].longitude - u.lng) * 111320 * cosLat;
    const ay = (coords[i].latitude - u.lat) * 110540;
    const bx = (coords[i + 1].longitude - u.lng) * 111320 * cosLat;
    const by = (coords[i + 1].latitude - u.lat) * 110540;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d2 = px * px + py * py;
    if (d2 < best) {
      best = d2;
      along = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return along;
}

export function useInAppNavigation({
  userLocation,
  onFix,
}: {
  userLocation: { lat: number; lng: number } | null;
  /** Receives each navigation-grade GPS fix so the screen's blue dot keeps up. */
  onFix?: (fix: Fix) => void;
}) {
  const [phase, setPhase] = useState<NavPhase>('idle');
  const [route, setRoute] = useState<NavRoute | null>(null);
  const [destination, setDestination] = useState<NavDestination | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const [gpsHeading, setGpsHeading] = useState<number | null>(null);

  // Refs so callbacks stay stable and never read stale state.
  const requestId = useRef(0);
  const lastReroute = useRef(0);
  const destRef = useRef<NavDestination | null>(null);
  const phaseRef = useRef<NavPhase>('idle');
  const userRef = useRef(userLocation);
  const onFixRef = useRef(onFix);
  useEffect(() => { userRef.current = userLocation; }, [userLocation]);
  useEffect(() => { onFixRef.current = onFix; }, [onFix]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const stop = useCallback(() => {
    requestId.current += 1; // ignore any route still in flight
    destRef.current = null;
    setPhase('idle');
    setRoute(null);
    setDestination(null);
    setRerouting(false);
    setGpsHeading(null);
  }, []);

  const start = useCallback(async (dest: NavDestination): Promise<StartResult> => {
    const u = userRef.current;
    if (!u) {
      return { ok: false, reason: 'no-location', message: 'Turn on location so ParkStop can guide you to the spot.' };
    }
    if (metres(u, dest) < ALREADY_HERE_M) {
      return { ok: false, reason: 'already-here', message: 'You are already at this spot.' };
    }
    const id = ++requestId.current;
    destRef.current = dest;
    setDestination(dest);
    setPhase('loading');
    const res = await fetchRoute(u.lat, u.lng, dest.lat, dest.lng);
    if (id !== requestId.current) return { ok: true }; // cancelled meanwhile
    if (!res.ok) {
      destRef.current = null;
      setDestination(null);
      setPhase('idle');
      return { ok: false, reason: 'error', message: res.message };
    }
    lastReroute.current = Date.now();
    setRoute(res.route);
    setPhase('navigating');
    return { ok: true };
  }, []);

  const reroute = useCallback(async () => {
    const dest = destRef.current;
    const u = userRef.current;
    if (!dest || !u || phaseRef.current !== 'navigating') return;
    if (Date.now() - lastReroute.current < REROUTE_MIN_GAP_MS) return;
    lastReroute.current = Date.now();
    const id = requestId.current;
    setRerouting(true);
    const res = await fetchRoute(u.lat, u.lng, dest.lat, dest.lng);
    if (id !== requestId.current) return;
    setRerouting(false);
    if (res.ok) setRoute(res.route);
    else console.warn('[ParkStop nav] reroute failed:', res.message); // keep the old route
  }, []);

  // ── Navigation-grade GPS while a route is active ──────────────────────
  const tracking = phase === 'navigating' || phase === 'arrived';
  useEffect(() => {
    if (!tracking) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      try {
        const s = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 2 },
          (l) => {
            const { latitude, longitude, accuracy, heading, speed } = l.coords;
            // GPS course is far steadier than the compass once the car moves.
            if (speed != null && speed > 1.5 && heading != null && heading >= 0) setGpsHeading(heading);
            onFixRef.current?.({ lat: latitude, lng: longitude, accuracy: accuracy || 0, heading, speed });
          },
        );
        if (cancelled) s.remove(); // navigation ended while subscribing
        else sub = s;
      } catch (e) {
        console.warn('[ParkStop nav] GPS watch failed:', e);
      }
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [tracking]);

  // ── Progress along the route ──────────────────────────────────────────
  const geometry = useMemo(() => {
    if (!route) return null;
    const cum = cumulative(route.coords);
    const lineLen = cum[cum.length - 1] || 1;
    // Step lengths come from Google; scale them onto our measured line so
    // step boundaries land in the right place along it.
    const stepSum = route.steps.reduce((s, st) => s + st.distanceM, 0) || lineLen;
    const scale = lineLen / stepSum;
    const stepStart: number[] = [];
    let acc = 0;
    for (const st of route.steps) {
      stepStart.push(acc * scale);
      acc += st.distanceM;
    }
    return { cum, lineLen, stepStart };
  }, [route]);

  const progress: NavProgress | null = useMemo(() => {
    if (!route || !geometry || !userLocation) return null;
    const { cum, lineLen, stepStart } = geometry;
    const along = distanceAlong(route.coords, cum, userLocation);
    const remainingM = Math.max(0, lineLen - along);
    const remainingS = route.distanceM > 0
      ? route.durationS * Math.min(1, remainingM / lineLen)
      : 0;

    // Current step = the last one whose start we have passed.
    let cur = 0;
    for (let i = 0; i < stepStart.length; i++) {
      if (stepStart[i] <= along + 5) cur = i;
    }
    const next = cur + 1 < route.steps.length ? route.steps[cur + 1] : null;
    const distanceToNextM = next ? Math.max(0, stepStart[cur + 1] - along) : remainingM;
    return { nextStep: next, distanceToNextM, remainingM, remainingS };
  }, [route, geometry, userLocation]);

  // ── Arrival ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'navigating' || !userLocation || !destination) return;
    const straight = metres(userLocation, destination);
    if (straight <= ARRIVE_M || (progress && progress.remainingM <= ARRIVE_M && straight <= ARRIVE_M * 3)) {
      setPhase('arrived');
    }
  }, [phase, userLocation, destination, progress]);

  return {
    phase,
    /** true from the moment a route is on screen until stop() */
    active: phase === 'navigating' || phase === 'arrived',
    loading: phase === 'loading',
    route,
    destination,
    progress,
    rerouting,
    gpsHeading,
    start,
    stop,
    reroute,
  };
}
