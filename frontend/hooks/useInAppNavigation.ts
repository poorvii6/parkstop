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
 *   - snaps the driver's arrow onto the route (no drifting into buildings)
 *   - trims the route line behind the driver, as Google does
 *   - picks the next turn, the turn after it, and the distance to each
 *   - keeps remaining distance, time and arrival clock up to date
 *   - gives the camera a steady heading: the direction of the road
 *   - keeps the screen awake
 *   - flips to "arrived" when the driver reaches the spot
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { fetchRoute, NavRoute, NavStep, LatLng } from '../utils/directions';

// Optional native module: loaded defensively so a build made before the
// package was added still runs (the screen just may dim while driving).
let KeepAwake: { activateKeepAwakeAsync: (tag?: string) => Promise<void>; deactivateKeepAwake: (tag?: string) => void } | null = null;
try { KeepAwake = require('expo-keep-awake'); } catch { KeepAwake = null; }

export type NavPhase = 'idle' | 'loading' | 'navigating' | 'arrived';

export type NavDestination = { lat: number; lng: number; title?: string };

export type NavProgress = {
  /** The turn coming up next (null when the next thing is the destination). */
  nextStep: NavStep | null;
  /** Index of nextStep in route.steps, or -1 when only the destination is left. */
  nextIndex: number;
  /** Metres to the next turn, or to the destination if no turns are left. */
  distanceToNextM: number;
  /** The turn straight after the next one, when it follows closely. */
  thenStep: NavStep | null;
  remainingM: number;
  remainingS: number;
};

export type TrafficSegment = { coords: Array<[number, number]>; congestion: 'heavy' | 'severe' };

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
/** Snap the arrow onto the route when GPS is within this distance of it. */
const SNAP_M = 25;
/** Show "Then …" when the following turn is this close after the next one. */
const THEN_M = 150;
/**
 * Below this, treat the car as stopped and report 0.
 *
 * A parked phone still reports 3-8 km/h: GPS wanders a few metres between
 * fixes and the receiver reads that wander as movement, which made the speed
 * bubble claim 6 km/h while standing still. Walking pace is about 5 km/h, so
 * anything under this is not driving.
 */
const STOPPED_KMH = 8;
/**
 * Fixes combined to smooth the reading. The MIDDLE value is taken, not the
 * average: GPS throws the odd wild figure, and an average carries that spike
 * for several seconds (one bad fix turned a steady 40 into 57 in testing),
 * while the middle value ignores it outright.
 */
const SPEED_WINDOW = 3;
/**
 * Uncertainty above which a fix is treated as poor, in metres.
 *
 * Deliberately the same 35m as the finder's own watcher, which has gated on
 * accuracy for a while — see the handling in app/finder/index.tsx. Navigation
 * had no gate at all, so it trusted every reading, and that is what let the
 * arrow jump ~700m while the car stood still.
 */
const ACC_REJECT_M = 35;
/** How recent a clearly better fix must be to justify rejecting a poor one. */
const ACC_RECENT_MS = 10000;
/**
 * How long we go without proof of movement before reporting a standstill.
 *
 * This gates SPEED ONLY, and it is deliberately a time window rather than a
 * per-fix test. Proof of movement arrives sparsely — at 20 km/h with 25m
 * accuracy the position only clears its own uncertainty radius every ~5s — so
 * judging each fix on its own and zeroing the rest put a 0 into the speed
 * window about four times out of five. Simulated over 60 fixes that read 0 for
 * 97% of a steady 20 km/h, which is far worse than the wander it was meant to
 * suppress: a driver in traffic needs that number to be right.
 */
const STILL_MS = 10000;

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

/** Compass bearing (0 = north) from p to q, in degrees. */
function bearing(p: LatLng, q: LatLng) {
  const toRad = Math.PI / 180;
  const y = Math.sin((q.longitude - p.longitude) * toRad) * Math.cos(q.latitude * toRad);
  const x =
    Math.cos(p.latitude * toRad) * Math.sin(q.latitude * toRad) -
    Math.sin(p.latitude * toRad) * Math.cos(q.latitude * toRad) * Math.cos((q.longitude - p.longitude) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cumulative distance (m) at each route vertex. */
function cumulative(coords: LatLng[]) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segLen(coords[i - 1], coords[i]));
  return cum;
}

type Projection = { along: number; seg: number; point: LatLng; offBy: number };

/** Project the driver onto the nearest route segment. */
function project(coords: LatLng[], cum: number[], u: { lat: number; lng: number }): Projection {
  const cosLat = Math.cos((u.lat * Math.PI) / 180);
  let best = Infinity;
  let res: Projection = { along: 0, seg: 0, point: coords[0], offBy: Infinity };
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
      res = {
        along: cum[i] + t * (cum[i + 1] - cum[i]),
        seg: i,
        point: {
          latitude: coords[i].latitude + t * (coords[i + 1].latitude - coords[i].latitude),
          longitude: coords[i].longitude + t * (coords[i + 1].longitude - coords[i].longitude),
        },
        offBy: Math.sqrt(d2),
      };
    }
  }
  return res;
}

export function useInAppNavigation({
  userLocation,
  onFix,
}: {
  userLocation: { lat: number; lng: number } | null;
  /** Receives each navigation-grade GPS fix so the screen's position keeps up. */
  onFix?: (fix: Fix) => void;
}) {
  const [phase, setPhase] = useState<NavPhase>('idle');
  const [route, setRoute] = useState<NavRoute | null>(null);
  /** Bumped on every new route (start or re-route) — voice uses it. */
  const [routeVersion, setRouteVersion] = useState(0);
  const [destination, setDestination] = useState<NavDestination | null>(null);
  const [rerouting, setRerouting] = useState(false);
  const [gpsHeading, setGpsHeading] = useState<number | null>(null);
  const [speedKmh, setSpeedKmh] = useState<number | null>(null);
  const speedWindow = useRef<number[]>([]);
  /** Accuracy and timestamp of the last fix we accepted. */
  const lastFixQuality = useRef<{ acc: number; t: number } | null>(null);
  /**
   * The last position we actually committed to — NOT simply the previous fix.
   *
   * Movement is measured from here, and the anchor does not move unless a fix
   * is believed. That is what bounds the error: a stationary phone's wander
   * circles this point forever instead of accumulating, which is how a parked
   * car drifted hundreds of metres down the road. Real movement outruns the
   * accuracy radius within a second or two and the anchor follows it.
   */
  const anchor = useRef<{ lat: number; lng: number } | null>(null);
  /**
   * When the anchor last MOVED — i.e. when we last had proof of motion.
   *
   * Starts at -Infinity so a car that has not moved since navigation began
   * reads a standstill rather than passing the receiver's wander through for
   * the first few seconds. Establishing the very first anchor does not count:
   * that fixes a starting point, it does not demonstrate movement.
   */
  const anchorMovedAt = useRef(-Infinity);

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
    setSpeedKmh(null);
    speedWindow.current = [];
    // A new trip must not inherit the last one's anchor, or its first fixes
    // would be measured against a position possibly miles away and believed
    // for that reason alone.
    lastFixQuality.current = null;
    anchor.current = null;
    anchorMovedAt.current = -Infinity;
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
    setRouteVersion((v) => v + 1);
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
    if (res.ok) {
      setRoute(res.route);
      setRouteVersion((v) => v + 1);
    } else {
      console.warn('[ParkStop nav] reroute failed:', res.message); // keep the old route
    }
  }, []);

  const tracking = phase === 'navigating' || phase === 'arrived';

  // ── Navigation-grade GPS while a route is active ──────────────────────
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

            // ── 1. Fix quality ────────────────────────────────────────────
            // `|| 99`, not `|| 0`. A platform that declines to report accuracy
            // is saying it does not know, which is the opposite of perfect —
            // and this value is passed on as the off-route threshold, where
            // claiming 0 made rerouting maximally twitchy on exactly the fixes
            // least worth trusting.
            const acc = accuracy || 99;
            const q = lastFixQuality.current;
            // Drop a poor reading when a clearly better one landed recently.
            // Fails OPEN by design: with no recent better fix this accepts
            // whatever arrives, so navigation never freezes on a stale
            // position just because the sky is bad.
            if (acc > ACC_REJECT_M && q && q.acc < acc / 2 && Date.now() - q.t < ACC_RECENT_MS) return;
            lastFixQuality.current = { acc, t: Date.now() };

            // ── 2. Is this evidence of movement? ──────────────────────────
            // A fix whose uncertainty radius exceeds the distance travelled
            // since the last committed position proves nothing: at 30m
            // accuracy, a 5m step is indistinguishable from the receiver
            // wandering. The median+floor filter could not catch this, because
            // the bad readings were a sustained bias well above STOPPED_KMH
            // rather than the lone outliers the median removes.
            const here = { lat: latitude, lng: longitude };
            const anchorPos = anchor.current;
            const moved = anchorPos ? metres(anchorPos, here) : Infinity;
            if (moved >= acc) {
              // The first anchor only establishes a starting point; it is not
              // evidence that anything moved.
              const establishing = !anchorPos;
              anchor.current = here;
              if (!establishing) anchorMovedAt.current = Date.now();
            }

            // Have we had proof of movement recently? This governs the speed
            // readout and the GPS course, while the anchor above governs the
            // arrow. Keeping them separate matters: proof arrives sparsely, so
            // a per-fix test is right for position and wrong for speed.
            const standingStill = Date.now() - anchorMovedAt.current > STILL_MS;

            // GPS course is far steadier than the compass once the car moves —
            // but only once it actually does. The old `speed > 1.5` guard is
            // exactly what the bad readings sailed through.
            if (!standingStill && speed != null && speed > 1.5 && heading != null && heading >= 0) setGpsHeading(heading);

            // Take the middle of the last few fixes, then floor anything
            // slower than a walk to zero, so a parked car reads 0 rather
            // than reporting GPS wander as 6 km/h.
            if (speed == null || speed < 0) {
              setSpeedKmh(null);
            } else {
              const w = speedWindow.current;
              // Feed 0 while there is no recent proof of movement, rather than
              // the reported figure — that is what a parked phone reporting
              // 17 km/h deserves. Once the position has genuinely cleared its
              // own uncertainty radius, the reading is passed through
              // untouched, so traffic speeds stay accurate.
              w.push(standingStill ? 0 : speed * 3.6);
              if (w.length > SPEED_WINDOW) w.shift();
              const sorted = [...w].sort((a, b) => a - b);
              const mid = sorted.length >> 1;
              const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
              setSpeedKmh(median < STOPPED_KMH ? 0 : median);
            }

            // Report the ANCHOR, not the raw fix, so the arrow holds still
            // while the readings wander. The accuracy is still the live one —
            // position is what we are withholding, not the uncertainty.
            const pos = anchor.current || here;
            onFixRef.current?.({ lat: pos.lat, lng: pos.lng, accuracy: acc, heading, speed });
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

  // ── Keep the screen on while navigating ───────────────────────────────
  useEffect(() => {
    if (!tracking || !KeepAwake) return;
    KeepAwake.activateKeepAwakeAsync('parkstop-nav').catch(() => {});
    return () => { try { KeepAwake?.deactivateKeepAwake('parkstop-nav'); } catch {} };
  }, [tracking]);

  // ── Route geometry (computed once per route) ──────────────────────────
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

  // ── Where the driver is on the route ──────────────────────────────────
  const proj = useMemo(() => {
    if (!route || !geometry || !userLocation) return null;
    return project(route.coords, geometry.cum, userLocation);
  }, [route, geometry, userLocation]);

  const progress: NavProgress | null = useMemo(() => {
    if (!route || !geometry || !proj) return null;
    const { lineLen, stepStart } = geometry;
    const along = proj.along;
    const remainingM = Math.max(0, lineLen - along);
    const remainingS = route.durationS * Math.min(1, remainingM / lineLen);

    // Current step = the last one whose start we have passed.
    let cur = 0;
    for (let i = 0; i < stepStart.length; i++) {
      if (stepStart[i] <= along + 5) cur = i;
    }
    const nextIndex = cur + 1 < route.steps.length ? cur + 1 : -1;
    const next = nextIndex >= 0 ? route.steps[nextIndex] : null;
    const distanceToNextM = next ? Math.max(0, stepStart[nextIndex] - along) : remainingM;
    const then =
      nextIndex >= 0 && nextIndex + 1 < route.steps.length && route.steps[nextIndex].distanceM <= THEN_M
        ? route.steps[nextIndex + 1]
        : null;
    return { nextStep: next, nextIndex, distanceToNextM, thenStep: then, remainingM, remainingS };
  }, [route, geometry, proj]);

  /** Arrow position: on the road when close to it, raw GPS otherwise. */
  const puckLocation = useMemo(() => {
    if (!userLocation) return null;
    if (!proj || proj.offBy > SNAP_M) return userLocation;
    return { lat: proj.point.latitude, lng: proj.point.longitude };
  }, [userLocation, proj]);

  /** Route still ahead of the driver — the part already driven is dropped. */
  const remainingCoords = useMemo(() => {
    if (!route) return [] as LatLng[];
    if (!proj || proj.offBy > SNAP_M) return route.coords;
    return [proj.point, ...route.coords.slice(proj.seg + 1)];
  }, [route, proj]);

  /** Direction of the road under the driver, for a steady camera. */
  const roadHeading = useMemo(() => {
    if (!route || !proj || proj.offBy > SNAP_M) return null;
    const a = route.coords[proj.seg];
    const b = route.coords[proj.seg + 1];
    if (!a || !b || segLen(a, b) < 1) return null;
    return bearing(a, b);
  }, [route, proj]);

  /** Slow / jammed stretches still ahead, in the map's [lng, lat] format. */
  const trafficSegments: TrafficSegment[] = useMemo(() => {
    if (!route || route.traffic.length === 0) return [];
    const from = proj ? proj.seg : 0;
    return route.traffic
      .filter((t) => t.end > from)
      .map((t) => ({
        congestion: t.speed === 'TRAFFIC_JAM' ? ('severe' as const) : ('heavy' as const),
        coords: route.coords
          .slice(Math.max(t.start, from), t.end + 1)
          .map((c) => [c.longitude, c.latitude] as [number, number]),
      }))
      .filter((s) => s.coords.length >= 2);
  }, [route, proj]);

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
    active: tracking,
    loading: phase === 'loading',
    route,
    routeVersion,
    destination,
    progress,
    rerouting,
    puckLocation,
    remainingCoords,
    trafficSegments,
    /** Best heading for the camera/arrow: road direction, else GPS course. */
    heading: roadHeading ?? gpsHeading,
    speedKmh,
    start,
    stop,
    reroute,
  };
}
