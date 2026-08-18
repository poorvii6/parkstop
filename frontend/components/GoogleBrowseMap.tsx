/**
 * The browsing map — Google Navigation SDK's MapView.
 *
 * WHY A REWRITE
 * -------------
 * Google forbids the Maps SDK and the Navigation SDK in the same app: "You
 * cannot use the Navigation SDK and the Maps SDK in the same app, as the
 * Navigation SDK replaces the Maps SDK's functionalities." So adopting Google's
 * real navigation means react-native-maps has to go, and this map moves onto
 * the Navigation SDK's own MapView.
 *
 * WHAT SHRANK
 * -----------
 * The component this replaces also owned the navigation experience: follow
 * camera with pitch and heading, the direction arrow, off-route detection,
 * traffic segments, alternative-route tapping, an in-nav compass. All of that
 * now belongs to Google inside GoogleNavigation.tsx, so this file is only
 * responsible for BROWSING: show where you are, show nearby spots, preview a
 * route to a spot you tapped.
 *
 * TWO API DIFFERENCES THAT SHAPE EVERYTHING BELOW
 * -----------------------------------------------
 * 1. Markers and polylines are not children. They are added imperatively
 *    through a controller and updated by id, so this component diffs its own
 *    props against what it has already drawn.
 *
 * 2. `moveCamera` is an instant jump — the native `animateCamera` is not
 *    bridged to JS. Smooth movement comes from utils/cameraEasing, which
 *    interpolates and pushes a camera per frame.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View, Text, TouchableOpacity, AppState, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import {
  MapView,
  MapColorScheme,
  useNavigation,
  NavigationSessionStatus,
  type MapViewController,
  type LatLng as NavLatLng,
} from '@googlemaps/react-native-navigation-sdk';
import { ensureNavSession } from '../utils/navSession';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, USER_MAP_ZOOM, HINT_MAP_ZOOM } from '../constants/mapDefaults';
import { createCameraEaser, type EaseTarget } from '../utils/cameraEasing';
import { fitBounds } from '../utils/fitBounds';
import { useSpotPinImages, pinKey } from './useSpotPinImages';

type LatLng = { latitude: number; longitude: number };

type Props = {
  userLocation?: { lat: number; lng: number };
  viewportHint?: { lat: number; lng: number } | null;
  markers?: Array<{ id: string; lat: number; lng: number; price: number; available: boolean; available_slots?: number; title?: string }>;
  routeCoords?: Array<LatLng>;
  altRoutes?: Array<{ coords: Array<LatLng>; duration: number; distance: number }>;
  searchedPlace?: { lat: number; lng: number; title: string } | null;
  destination?: { lat: number; lng: number } | null;
  isActiveNavigation?: boolean;
  isFollowing?: boolean;
  heading?: number;
  onMapPress?: (coords: [number, number]) => void;
  onMapInteraction?: () => void;
  onMarkerPress?: (id: string) => void;
  onRecenter?: () => void;
  locationAccuracy?: number;
  hideControls?: boolean;
  controlsBottomOffset?: number;
  style?: any;
  [key: string]: any;
};

/** Recenter is a direct response to a tap, so it should feel immediate. */
const RECENTER_MS = 350;
/** Following is continuous, so smoothness matters more than speed. */
const FOLLOW_MS = 600;

const ROUTE_ID = 'parkstop-route';
const ROUTE_CASING_ID = 'parkstop-route-casing';
const SPOT_PREFIX = 'spot-';
const SEARCH_PIN_ID = 'searched-place';

const GoogleBrowseMap = forwardRef((props: Props, ref: any) => {
  const controller = useRef<MapViewController | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // The SDK's MapView cannot be created before a navigation session exists —
  // it crashes inside SupportMapFragment.onCreateView with a null internal.
  // So the view is not rendered at all until the session reports OK.
  const { navigationController } = useNavigation();
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Never CREATE the map fragment while the activity is paused.
  //
  // Any dialog that takes foreground — a permission grant, a system prompt —
  // pauses the activity, and the FragmentManager then flushes pending fragment
  // work. A Navigation SDK map created at that moment crashes in
  // SupportMapFragment.onCreateView. Waiting for 'active' closes that window
  // for every such dialog, not only the location one we hit.
  //
  // This gates the FIRST mount only (see `everActive` below). Once the fragment
  // exists it is left alone, because tearing the map down and rebuilding it on
  // every backgrounding would be its own source of churn and lost camera state.

  // Camera rotation and tilt, read back from the map, so the compass reflects
  // reality rather than what we last asked for.
  const [mapBearing, setMapBearing] = useState(0);
  const [mapTilt, setMapTilt] = useState(0);

  // Measured, not assumed. Framing a route needs the real viewport: guessing
  // from Dimensions would ignore the sheet, notch and status bar and frame the
  // route into space the rider cannot see.
  const viewport = useRef({
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
  });

  // Night runs 7pm–6am, matching what the map did before the SDK change.
  // Re-checked every five minutes so a session crossing 7pm flips live.
  const [night, setNight] = useState(() => {
    const h = new Date().getHours();
    return h >= 19 || h < 6;
  });
  useEffect(() => {
    const iv = setInterval(() => {
      const h = new Date().getHours();
      setNight(h >= 19 || h < 6);
    }, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  const [everActive, setEverActive] = useState(AppState.currentState === 'active');
  // Separate from `everActive`, which latches on at the first foreground and
  // never goes back. This tracks the CURRENT state so the camera poll below can
  // stop while the app is backgrounded — it was otherwise running every 700ms
  // indefinitely, waking the JS thread and the native map for a screen nobody
  // is looking at.
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (everActive) return;
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') setEverActive(true);
    });
    return () => sub.remove();
  }, [everActive]);

  useEffect(() => {
    let alive = true;
    ensureNavSession(navigationController).then(status => {
      if (!alive) return;
      if (status === NavigationSessionStatus.OK) {
        setSessionReady(true);
        setSessionError(null);
      } else {
        setSessionError(
          status === NavigationSessionStatus.NOT_AUTHORIZED
            ? 'This app key is not authorised for Google Maps yet.'
            : status === NavigationSessionStatus.LOCATION_PERMISSION_MISSING
              ? 'Location permission is needed to show the map.'
              : status === NavigationSessionStatus.NETWORK_ERROR
                ? 'Could not reach Google. Check your connection.'
                : 'The map could not start.'
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [navigationController]);

  // Camera state we own. The SDK will not tell us the camera unless asked
  // (getCameraPosition is async), and every moveCamera must be COMPLETE or
  // omitted fields silently become 0 — including zoom, which means the whole
  // planet. So the current camera is tracked here and always sent in full.
  const cam = useRef<EaseTarget>({
    lat: DEFAULT_MAP_CENTER.lat,
    lng: DEFAULT_MAP_CENTER.lng,
    zoom: DEFAULT_MAP_ZOOM,
    tilt: 0,
    bearing: 0,
  });

  const easer = useRef(
    createCameraEaser(() => (pos: any) => {
      controller.current?.moveCamera(pos);
    })
  ).current;
  useEffect(() => () => easer.cancel(), [easer]);

  const applyCamera = useCallback(
    (next: Partial<EaseTarget>, durationMs: number) => {
      const target: EaseTarget = { ...cam.current, ...next };
      cam.current = target;
      if (durationMs > 0) easer.easeCamera(target, durationMs);
      else easer.setCamera(target);
    },
    [easer]
  );

  // ── Gesture bookkeeping ──────────────────────────────────────
  const lastInteraction = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  // ── Imperative ref, unchanged contract ───────────────────────
  // The finder drives the map through animateCamera({ center, zoom, pitch,
  // heading }). Keeping the exact signature means no call site changes.
  const didInitialPosition = useRef(false);
  useImperativeHandle(ref, () => ({
    animateCamera: (cfg: any, opts?: any) => {
      const c = cfg?.center;
      if (!c) return;
      didInitialPosition.current = true;
      applyCamera(
        {
          lat: c.latitude,
          lng: c.longitude,
          ...(cfg.zoom != null ? { zoom: cfg.zoom } : {}),
          ...(cfg.pitch != null ? { tilt: cfg.pitch } : {}),
          ...(cfg.heading != null ? { bearing: cfg.heading } : {}),
        },
        opts?.duration ?? 800
      );
    },
  }));

  // ── Open on the rider's own position ─────────────────────────
  // Independent of the userLocation prop, which can lag behind the first fix.
  // Without this the map opens on the country-wide fallback and stays there.
  const [selfLoc, setSelfLoc] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // Bounded, not "whatever was cached". Unqualified, this happily returns
        // a fix from yesterday in another city and the map opens there —
        // confidently, in the wrong place. Five minutes and 500m is recent and
        // close enough to be a useful first frame; worse than that is better
        // replaced by the real fix below.
        const last = await Location.getLastKnownPositionAsync({
          maxAge: 5 * 60 * 1000,
          requiredAccuracy: 500,
        });
        if (alive && last?.coords) setSelfLoc({ lat: last.coords.latitude, lng: last.coords.longitude });
        // HIGH, not Balanced. Balanced is roughly 100m, and in a parking app
        // that is the difference between the right driveway and the next
        // street. This fix decides where the map opens and which spots count
        // as nearby, so it is worth the extra second and battery.
        const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        if (alive && cur?.coords) setSelfLoc({ lat: cur.coords.latitude, lng: cur.coords.longitude });
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  /**
   * Has the camera been put somewhere real yet?
   *
   * This gates a cover over the map, and it exists because of what the SDK
   * does before we say otherwise: a freshly created MapView starts at lat 0,
   * lng 0, zoom 0 — the entire planet, centred in the Atlantic off West
   * Africa. `cam` above is initialised to the India fallback, but that is only
   * OUR record; nothing is pushed to the native camera until applyCamera runs,
   * and that cannot run until the map is ready AND a position is known.
   *
   * On the browse screen that gap is short. Coming back from navigation it is
   * not: GoogleNavigation unmounts and this map mounts FRESH, so the rider
   * arriving at their spot was shown the whole world while the camera caught
   * up — with the "You have arrived / Check In" card floating over it.
   */
  const [positioned, setPositioned] = useState(false);

  useEffect(() => {
    if (!mapReady || didInitialPosition.current) return;
    const u = props.userLocation || selfLoc;
    if (u) {
      didInitialPosition.current = true;
      applyCamera({ lat: u.lat, lng: u.lng, zoom: USER_MAP_ZOOM, tilt: 0, bearing: 0 }, 0);
      setPositioned(true);
      return;
    }
    if (props.viewportHint) {
      // Also mark this as the initial position — without it the effect re-ran
      // and re-applied the hint on every render until a fix arrived, fighting
      // any camera move made in between.
      didInitialPosition.current = true;
      applyCamera(
        { lat: props.viewportHint.lat, lng: props.viewportHint.lng, zoom: HINT_MAP_ZOOM, tilt: 0, bearing: 0 },
        0
      );
      setPositioned(true);
      return;
    }

    // Nothing known yet. Rather than leave the planet on screen, fall back to
    // the country-wide view after a short grace period. `didInitialPosition`
    // is deliberately NOT set here: this is a placeholder, and a real fix
    // arriving later must still move the camera to the rider.
    const t = setTimeout(() => {
      if (didInitialPosition.current) return;
      applyCamera(
        {
          lat: DEFAULT_MAP_CENTER.lat,
          lng: DEFAULT_MAP_CENTER.lng,
          zoom: DEFAULT_MAP_ZOOM,
          tilt: 0,
          bearing: 0,
        },
        0
      );
      setPositioned(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [mapReady, props.userLocation, props.viewportHint, selfLoc, applyCamera]);

  // ── Follow the rider while browsing ──────────────────────────
  useEffect(() => {
    if (!mapReady || !props.isFollowing || !props.userLocation) return;
    if (Date.now() - lastInteraction.current < 2000) return; // don't fight a fresh gesture
    applyCamera({ lat: props.userLocation.lat, lng: props.userLocation.lng }, FOLLOW_MS);
  }, [mapReady, props.isFollowing, props.userLocation, applyCamera]);

  // ── Detect that the RIDER moved the camera ───────────────────
  //
  // The Navigation SDK's MapView exposes no gesture or camera-change callback —
  // there is no onPanDrag, no onRegionChangeComplete, nothing. Without this the
  // map has no idea the user has panned, so following is never released and
  // every location update drags the view straight back to the blue dot.
  //
  // So we watch the camera instead of the fingers: compare where the map
  // actually is against where we last put it. Anything beyond a small tolerance
  // was not us, so it was them.
  // The compass is fed from this same read, so the poll rate is also the
  // compass's frame rate. At a flat 700ms the needle updated barely twice a
  // second: it visibly stepped and lagged behind a two-finger rotate, settling
  // correct only once the fingers stopped. So while the map is actually turned
  // or tilted — the only time the compass is on screen — poll fast enough to
  // look live, and drop back to the slow rate when it is north-up and there is
  // nothing to animate.
  const compassVisible = Math.abs(mapBearing) > 0.5 || mapTilt > 0.5;
  useEffect(() => {
    if (!mapReady || !sessionReady || !appActive) return;
    const iv = setInterval(async () => {
      const c = controller.current;
      if (!c) return;
      try {
        const pos: any = await c.getCameraPosition();
        const t = pos?.target;
        if (!t) return;

        // Feed the compass from the same read. Google's own compass is a native
        // overlay we cannot position, so it ends up underneath ParkStop's
        // search bar; drawing our own is the only way to guarantee it is
        // reachable.
        //
        // Deliberately updated BEFORE the easing check below: during a
        // programmatic rotate (including the compass's own tap-to-reset) the
        // camera is easing, and skipping the read froze the needle for the
        // whole animation — the one moment it most needs to move.
        setMapBearing(pos.bearing ?? 0);
        setMapTilt(pos.tilt ?? 0);

        // Gesture detection only from here. Mid-ease the camera legitimately
        // differs from the target, which would read as a gesture every frame.
        if (easer.isEasing()) return;

        // Tolerance scaled to the ZOOM, not a fixed distance.
        //
        // A flat 30m was two different bugs at once. Zoomed out it is a few
        // pixels, so rounding could register as a pan; at street zoom the whole
        // screen is only 50-150m across, so a deliberate short drag fell under
        // the threshold, was dismissed as noise, and follow-mode yanked the map
        // straight back — the map fighting the rider precisely when they were
        // looking at a specific driveway.
        //
        // Metres-per-pixel in Web Mercator, so the threshold is a constant
        // ~24px of movement at every zoom level. Bounded at both ends so a
        // wild zoom value cannot make the map either hair-trigger or deaf.
        const zoomNow = pos.zoom ?? cam.current.zoom;
        const metresPerPx =
          (156543.03392 * Math.cos((t.lat * Math.PI) / 180)) / Math.pow(2, zoomNow);
        const tolM = Math.min(120, Math.max(6, metresPerPx * 24));

        // ~11m per 0.0001 degree of latitude.
        const dLat = (t.lat - cam.current.lat) * 110540;
        const dLng = (t.lng - cam.current.lng) * 111320 * Math.cos((t.lat * Math.PI) / 180);
        const movedM = Math.sqrt(dLat * dLat + dLng * dLng);
        const zoomed = Math.abs(zoomNow - cam.current.zoom) > 0.3;

        if (movedM > tolM || zoomed) {
          // Adopt what the user chose as our new baseline, otherwise the next
          // tick sees the same difference and re-reports it forever.
          cam.current = {
            lat: t.lat,
            lng: t.lng,
            zoom: pos.zoom ?? cam.current.zoom,
            tilt: pos.tilt ?? cam.current.tilt,
            bearing: pos.bearing ?? cam.current.bearing,
          };
          lastInteraction.current = Date.now();
          if (propsRef.current.isFollowing) propsRef.current.onMapInteraction?.();
        }
      } catch {}
      // 140ms only while the compass is on screen — fast enough that the needle
      // tracks a rotate instead of stepping after it. Note this depends on
      // `compassVisible`, so the interval is rebuilt when the map returns to
      // north-up and the cost goes away.
    }, compassVisible ? 140 : 700);
    return () => clearInterval(iv);
  }, [mapReady, sessionReady, easer, compassVisible, appActive]);

  // NO auto-resume of following.
  //
  // An earlier version resumed after a few seconds of stillness, added back
  // when a stray touch could freeze the map permanently. With real gesture
  // detection in place that guard is unnecessary, and it was actively wrong:
  // panning somewhere to look at it, then being dragged back to your own
  // position a moment later, is precisely the complaint. Google Maps does not
  // do this — pan away and it stays there until you tap the locate button.

  // ── Spot markers ─────────────────────────────────────────────
  // Diffed by id against what is already on the map. The controller updates a
  // marker in place when the id matches, so unchanged spots are not removed and
  // re-added — which would make every marker flicker on each poll.
  // Price pills, captured to images and cached by appearance.
  const pinSpecs = useMemo(
    () =>
      (props.markers || []).map(m => ({
        price: m.price,
        available: m.available,
        // No `?? 1` fallback here any more. A missing count means the server
        // did not send one — inventing a number put "1 free" on the map for
        // spots whose real availability was unknown, rendered identically to a
        // measured figure and impossible for a rider to tell apart.
        freeSlots: typeof m.available_slots === 'number' ? m.available_slots : null,
      })),
    [props.markers]
  );
  const { images: pinImages, hiddenPills } = useSpotPinImages(pinSpecs);

  /**
   * What is currently drawn: marker id -> a signature of everything visible
   * about it. A marker is only touched when its signature changes.
   */
  const drawnSpots = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!mapReady || !controller.current) return;
    const c = controller.current;

    // Once a spot is chosen, show ONLY that spot.
    //
    // Every other pin belongs to a place the rider has decided against, and
    // leaving them up is what made the map look like it had duplicate
    // destinations: a route running to Hoskote while a second identical red pin
    // sat at Doddaballapura, with nothing to say which one you were going to.
    // Google does the same — pick a destination and the other results clear.
    const all = props.markers || [];
    const d = props.destination;
    const list = d
      ? all.filter(
          m => Math.abs(m.lat - d.lat) < 1e-6 && Math.abs(m.lng - d.lng) < 1e-6
        )
      : all;
    const next = new Map<string, string>();

    for (const m of list) {
      const id = SPOT_PREFIX + m.id;
      const freeSlots = typeof m.available_slots === 'number' ? m.available_slots : null;
      const img = pinImages[pinKey({ price: m.price, available: m.available, freeSlots })];

      // Everything that affects how this marker looks or where it sits. If the
      // signature is unchanged there is nothing to do.
      const signature = [m.lat, m.lng, m.price, m.available, freeSlots, m.title, img || '']
        .join('|');
      next.set(id, signature);

      // THE BLINK.
      //
      // This used to call addMarker for every marker on every run, and the
      // effect re-runs whenever props.markers changes — which is on every poll,
      // with a fresh array each time even when nothing about the spots
      // differed. Re-adding a marker over itself makes the native side drop and
      // recreate it, which is the pill flickering several times a minute.
      //
      // Now a marker is written once and left alone until something about it
      // actually changes.
      if (drawnSpots.current.get(id) === signature) continue;

      c.addMarker({
        id,
        position: { lat: m.lat, lng: m.lng },
        // Title only. Price and availability now live on the pill itself —
        // carrying them in the snippet too is what put a white info box on top
        // of the blue pill, two labels for one spot.
        title: m.title || 'Parking',
        // The price pill, rendered offscreen and captured to a PNG — the only
        // way to get a labelled marker now that custom marker views are gone.
        // Until the capture lands the marker still appears as a default pin,
        // so spots are never missing from the map while images are produced.
        ...(img ? { imgPath: img } : {}),
        // Anchor at the tail of the pill, so the point of the marker sits on
        // the spot rather than the middle of the label floating over it.
        ...(img ? { anchor: { u: 0.5, v: 1.0 } } : {}),
        visible: true,
      }).catch(() => {});
    }

    const drawnIds: string[] = Array.from(drawnSpots.current.keys());
    for (const id of drawnIds) {
      if (!next.has(id)) c.removeMarker(id);
    }
    drawnSpots.current = next;
    // props.destination is a dependency: choosing or clearing a spot must
    // immediately add or remove the other pins, not wait for the next poll.
  }, [mapReady, props.markers, pinImages, props.destination]);

  // ── Searched place pin ───────────────────────────────────────
  const drawnSearch = useRef(false);
  useEffect(() => {
    if (!mapReady || !controller.current) return;
    const c = controller.current;
    // Once a route is on the map the destination is settled, so the search pin
    // is stale — leaving it up puts a second identical red pin somewhere else
    // entirely and makes it ambiguous which one you are being routed to.
    // The searched place keeps its red pin while browsing, ALONGSIDE the blue
    // price pills for spots near it — that pairing is the whole point of a
    // search: "here is the place you asked for, and here is the parking around
    // it at these rates".
    //
    // It is NOT hidden merely because spots exist. An earlier version did that,
    // on the mistaken reading that a red search pin plus red spot pins was the
    // duplicate-pin complaint. The real cause was that spots fall back to a red
    // default pin until their price image finishes rendering; once the pills
    // draw, spots are blue and the one red pin is unmistakably the place.
    //
    // It retires only when a spot has actually been CHOSEN, because then the
    // destination is settled and a second pin elsewhere is genuinely confusing.
    const showSearchPin =
      !!props.searchedPlace &&
      (props.routeCoords?.length ?? 0) < 2 &&
      !props.destination;
    if (showSearchPin && props.searchedPlace) {
      c.addMarker({
        id: SEARCH_PIN_ID,
        position: { lat: props.searchedPlace.lat, lng: props.searchedPlace.lng },
        title: props.searchedPlace.title,
        visible: true,
      }).catch(() => {});
      drawnSearch.current = true;
    } else if (drawnSearch.current) {
      c.removeMarker(SEARCH_PIN_ID);
      drawnSearch.current = false;
    }
    // routeCoords.length is a dependency because the pin must disappear the
    // moment a route arrives, not only when the search itself is cleared.
  }, [mapReady, props.searchedPlace, props.routeCoords?.length, props.destination]);

  // ── Route preview ────────────────────────────────────────────
  // Two polylines: a dark casing under a blue line, which is how Google draws
  // a route. Ids are fixed so each redraw replaces rather than stacks — without
  // that, every route refresh would leave the previous line underneath and the
  // map would slowly fur up with dead routes.
  const drawnRoute = useRef(false);
  const framedRoute = useRef(false);
  const rc = props.routeCoords || [];
  const routeSig =
    rc.length >= 2
      ? `${rc.length}:${rc[0].latitude.toFixed(5)},${rc[0].longitude.toFixed(5)}:${rc[rc.length - 1].latitude.toFixed(5)},${rc[rc.length - 1].longitude.toFixed(5)}`
      : '';

  useEffect(() => {
    if (!mapReady || !controller.current) return;
    const c = controller.current;

    if (rc.length < 2) {
      if (drawnRoute.current) {
        c.removePolyline(ROUTE_ID);
        c.removePolyline(ROUTE_CASING_ID);
        drawnRoute.current = false;
      }
      return;
    }

    const points: NavLatLng[] = rc.map((p) => ({ lat: p.latitude, lng: p.longitude }));
    c.addPolyline({ id: ROUTE_CASING_ID, points, color: '#0d47a1', width: 12 }).catch(() => {});
    c.addPolyline({ id: ROUTE_ID, points, color: '#4285F4', width: 7 }).catch(() => {});
    drawnRoute.current = true;

    // Frame the WHOLE route the first time it appears — Google's route preview.
    // Before committing to a spot the rider needs to see where they are being
    // sent, not a close-up of the first 200 metres.
    //
    // Only on first appearance. The route refetches as they move, and refitting
    // each time would haul the camera back out while they are reading the
    // booking sheet.
    if (!framedRoute.current) {
      framedRoute.current = true;
      const fit = fitBounds(
        rc,
        viewport.current.width,
        // Leave room for the booking sheet, otherwise the lower half of the
        // route is framed behind it and appears cropped.
        Math.max(120, viewport.current.height - (props.controlsBottomOffset ?? 210) - 140)
      );
      if (fit) applyCamera({ lat: fit.lat, lng: fit.lng, zoom: fit.zoom, tilt: 0, bearing: 0 }, 700);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, routeSig]);

  // Reset when the route goes away, so the next spot gets framed too.
  useEffect(() => {
    if (rc.length < 2) framedRoute.current = false;
  }, [rc.length]);

  // ── Recenter ─────────────────────────────────────────────────
  const handleRecenter = () => {
    lastInteraction.current = 0;
    const u = props.userLocation || selfLoc;
    if (u) {
      // Restores the same framing the map opens with, so one tap always returns
      // to a familiar view rather than to wherever the rider had zoomed to.
      applyCamera({ lat: u.lat, lng: u.lng, zoom: USER_MAP_ZOOM, tilt: 0, bearing: 0 }, RECENTER_MS);
    }
    props.onRecenter?.();
  };

  const zoomBy = async (delta: number) => {
    lastInteraction.current = Date.now();

    // Step from where the map ACTUALLY is, not from our cached copy.
    //
    // `cam.current` only catches up with a pinch when the poll above notices
    // it, so pinching and then immediately tapping +/- stepped from a stale
    // level and the map jumped. The same staleness applied to the centre: pan,
    // then zoom, and it snapped back to the pre-pan position.
    //
    // One read costs a few milliseconds and makes the buttons exact whatever
    // the rider did with their fingers a moment earlier.
    try {
      const pos: any = await controller.current?.getCameraPosition();
      if (pos && Number.isFinite(pos.zoom)) {
        cam.current = {
          lat: pos.target?.lat ?? cam.current.lat,
          lng: pos.target?.lng ?? cam.current.lng,
          zoom: pos.zoom,
          tilt: pos.tilt ?? cam.current.tilt,
          bearing: pos.bearing ?? cam.current.bearing,
        };
      }
    } catch {
      // Fall back to the cached camera — a slightly stale step is better than
      // a button that does nothing.
    }

    const next = Math.min(21, Math.max(3, cam.current.zoom + delta));
    applyCamera({ zoom: next }, 220);
  };

  const bottom = props.controlsBottomOffset ?? 210;

  // Hold the SDK view back until the session is up. Rendering a dark panel for
  // the moment it takes is far better than the alternative: mounting the view
  // early crashes the whole app inside Google's fragment code.
  if (!sessionReady || !everActive) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.placeholder, props.style]}>
        <Text style={styles.placeholderText}>
          {sessionError || 'Starting map…'}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[StyleSheet.absoluteFill, props.style]}
      onLayout={e => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0) viewport.current = { width, height };
      }}
    >
      {/* Rendered BEFORE the map so the map draws over it — the pills must
          be genuinely on screen to be capturable on Android, but must never
          be visible to the rider. */}
      {hiddenPills}

      <MapView
        style={StyleSheet.absoluteFill}
        // Day/night by the CLOCK, not by the phone's theme.
        //
        // The default is FOLLOW_SYSTEM, so a rider whose phone is permanently
        // in dark mode got a night map at 9:47 in the morning — hard to read
        // in sunlight, which is exactly when it matters. The old map keyed off
        // the hour (night 7pm–6am) and that behaviour is restored here.
        mapColorScheme={night ? MapColorScheme.DARK : MapColorScheme.LIGHT}
        // Google's own location dot and accuracy ring — the same indicator the
        // Google Maps app shows while browsing.
        myLocationEnabled
        myLocationButtonEnabled={false}
        // Google's OWN compass, off.
        //
        // The SDK draws it unstyled at the top-left and fades it out on its
        // own a couple of seconds after the map settles back to north-up. That
        // is the badge that kept flashing in the corner on launch and again on
        // the way back from navigation (the map remounts there, coming from a
        // rotated, tilted navigation camera).
        //
        // ParkStop already renders its own compass, bottom-right, in the app's
        // styling and with a tap target that resets tilt as well as bearing —
        // see mapCtrlBtn below. Two compasses, one of them Google's default
        // chrome, is exactly the "system UI bolted on" look we removed
        // everywhere else.
        compassEnabled={false}
        mapToolbarEnabled={false}
        zoomControlsEnabled={false}
        buildingsEnabled
        onMapReady={() => setMapReady(true)}
        onMapViewControllerCreated={(c: MapViewController) => {
          controller.current = c;
        }}
        onMapClick={(latLng: NavLatLng) => {
          lastInteraction.current = Date.now();
          props.onMapPress?.([latLng.lng, latLng.lat]);
        }}
        onMarkerClick={(marker: any) => {
          const id: string = marker?.id || '';
          if (id.startsWith(SPOT_PREFIX)) {
            props.onMarkerPress?.(id.slice(SPOT_PREFIX.length));
          }
        }}
      />

      {/* Cover the map until its camera is somewhere real.
        *
        * Drawn AFTER the MapView, so it sits on top. Two things hide behind
        * it: the SDK's initial whole-planet camera, and the offscreen price
        * pills above, which have to be genuinely on screen at (0,0) to be
        * capturable on Android and are otherwise only hidden by the map once
        * the map has painted its first frame.
        *
        * pointerEvents none is wrong here — while this is up the map beneath
        * is showing the wrong place, so taps on it should not reach it. */}
      {!positioned ? (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
          <Text style={styles.placeholderText}>Starting map…</Text>
        </View>
      ) : null}

      {!props.hideControls ? (
        <>
          {/* Compass — only while the map is turned or tilted, as Google does.
              Tapping returns to north-up AND flat: resetting rotation alone
              leaves a tilted map with a compass claiming it is already north,
              and no way back except a two-finger pinch. */}
          {Math.abs(mapBearing) > 0.5 || mapTilt > 0.5 ? (
            <TouchableOpacity
              style={[styles.mapCtrlBtn, { bottom: bottom + 168 }]}
              activeOpacity={0.85}
              onPress={() => applyCamera({ bearing: 0, tilt: 0 }, 350)}
            >
              <View style={[styles.compassNeedle, { transform: [{ rotate: `${-mapBearing}deg` }] }]}>
                <View style={styles.compassN} />
                <View style={styles.compassS} />
                <Text style={styles.compassNLabel}>N</Text>
              </View>
            </TouchableOpacity>
          ) : null}

          <View style={[styles.zoomPill, { bottom: bottom + 60 }]}>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => zoomBy(1)} activeOpacity={0.7}>
              <Ionicons name="add" size={24} color="#3c4043" />
            </TouchableOpacity>
            <View style={styles.zoomDivider} />
            <TouchableOpacity style={styles.zoomBtn} onPress={() => zoomBy(-1)} activeOpacity={0.7}>
              <Ionicons name="remove" size={24} color="#3c4043" />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.recenterBtn, { bottom }]}
            onPress={handleRecenter}
            activeOpacity={0.8}
          >
            <Ionicons
              name={props.isFollowing ? 'locate' : 'locate-outline'}
              size={22}
              color={props.isFollowing ? '#1a73e8' : '#5f6368'}
            />
          </TouchableOpacity>
        </>
      ) : null}
    </View>
  );
});

GoogleBrowseMap.displayName = 'GoogleBrowseMap';

const styles = StyleSheet.create({
  mapCtrlBtn: {
    position: 'absolute', right: 16, width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 6,
  },
  compassNeedle: { width: 20, height: 24, alignItems: 'center', justifyContent: 'center' },
  compassN: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#EA4335' },
  compassS: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#c1c7cd' },
  compassNLabel: { position: 'absolute', top: -8, color: '#EA4335', fontSize: 8, fontWeight: '900' },
  placeholder: { backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 28 },
  placeholderText: { color: '#94a3b8', fontSize: 13, textAlign: 'center', lineHeight: 19 },
  zoomPill: {
    position: 'absolute', right: 16, width: 46, borderRadius: 23, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 6, overflow: 'hidden',
  },
  zoomBtn: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  zoomDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#dadce0', marginHorizontal: 8 },
  recenterBtn: {
    position: 'absolute', right: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
});

export default GoogleBrowseMap;
