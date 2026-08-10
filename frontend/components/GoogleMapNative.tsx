/**
 * GoogleMapNative.tsx — react-native-maps (Google) map.
 *
 * Staged, drop-in replacement for MapLibreNative. It mirrors MapLibreNative's
 * props and its imperative ref (animateCamera) EXACTLY, so MapLibreView.native
 * can switch to it behind a flag without any change to app/finder.
 *
 * Stage 1 scope (this file): Google basemap, spot price-pill markers,
 * destination pin, route lines (main casing+line + alternatives), user puck
 * (blue dot idle / heading arrow while navigating), camera (open on first fix,
 * follow with pitch+heading during navigation, fit-route preview, recenter),
 * map press + marker press + gesture-releases-follow, and off-route detection.
 *
 * Deliberately deferred to Stage 2: sub-second puck interpolation between fixes,
 * live traffic-coloured segments, and the alt-route tap selector. These are
 * additive and do not block the basemap swap.
 */
import React, { forwardRef, useImperativeHandle, useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Dimensions, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, USER_MAP_ZOOM, HINT_MAP_ZOOM } from '../constants/mapDefaults';

const FOLLOW_EASE_MS = 1000;

/**
 * Camera ease WHILE NAVIGATING. Much shorter than the idle follow.
 *
 * GPS ticks arrive about once a second. Easing over a full second meant the
 * camera was always finishing the *previous* fix as the next one landed — the
 * view permanently trailed the rider, which is the latency that made
 * navigation feel sluggish. A short ease lets the camera settle well before
 * the next fix, so the map reads as being where you are.
 */
const NAV_FOLLOW_MS = 400;

/**
 * Navigation zoom. Google sits noticeably closer than a browsing view — you
 * need to read the next junction, not the neighbourhood. 17.5 was wide enough
 * that turns arrived with no time to react.
 */
const NAV_ZOOM = 18.5;
const NAV_PITCH = 60;

/**
 * Top padding while navigating, as a share of screen height. Pushes the camera
 * centre down so the rider sits low and the road ahead fills the view.
 */
const NAV_TOP_PADDING = Math.round(Dimensions.get('window').height * 0.38);

/**
 * Recenter animation length. Deliberately short — a recenter is a direct
 * response to a tap, so it should feel immediate. The follow camera's longer
 * ease is for continuous tracking, where smoothness matters more than speed.
 */
const RECENTER_MS = 350;

/**
 * Idle time after the last gesture before the camera resumes following.
 *
 * Without this, a single touch — including one misread from a bump while
 * riding — turned following off permanently, so the blue dot kept moving while
 * the map sat still. Google resumes after a few seconds; so do we.
 */
const AUTO_RESUME_FOLLOW_MS = 6000;
const GESTURE_PRESS_GUARD_MS = 350;
const OFF_ROUTE_BASE_M = 50;
const OFF_ROUTE_CONFIRMATIONS = 2;

/** Night runs 7pm–6am, matching the old MapLibre day/night switch. */
const isNightHour = () => {
  const h = new Date().getHours();
  return h >= 19 || h < 6;
};

// Theme: we drive Google's OWN modern color schemes (the exact renderer the
// Google Maps app uses) via the userInterfaceStyle prop — light by day, Google's
// real dark mode at night. No hand-rolled style JSON, no legacy cream palette.

type LatLng = { latitude: number; longitude: number };

/** Congestion colors — identical to the MapLibre map (Google's palette). */
const TRAFFIC_COLORS: Record<string, string> = {
  low: '#34a853', moderate: '#fbbc04', heavy: '#ea8600', severe: '#ea4335',
};

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
  onOffRoute?: (lat: number, lng: number) => void;
  locationAccuracy?: number;
  hideControls?: boolean;
  controlsBottomOffset?: number;
  style?: any;
  [key: string]: any; // tolerate the extra nav props finder passes through
};

/**
 * One parking marker. react-native-maps rasterises a custom marker to a bitmap;
 * if it snapshots before the text lays out, the pill clips (the "half ₹" bug).
 * So this keeps tracksViewChanges ON until the pill has measured (onLayout),
 * then a beat longer for font paint — and re-arms whenever the price changes.
 */
function SpotMarker({ m, onPress }: { m: { id: string; lat: number; lng: number; price: number; available: boolean; available_slots?: number }; onPress: () => void }) {
  // Google-style balloon marker (per design reference): colored balloon with a
  // white rounded-square "P" badge, "₹price/hr" + "N available", a pointer tail,
  // and an anchor dot sitting on the exact coordinate.
  // Fabric-safe: collapsable={false} + explicit sizes everywhere (RN 0.81
  // flattens plain views and the map rasterises them clipped otherwise).
  const color = m.available ? '#2962FF' : '#9aa0a6';
  const slots = typeof m.available_slots === 'number' ? m.available_slots : undefined;
  const priceStr = `${m.price}`;
  const balloonW = Math.max(128, 92 + priceStr.length * 13);
  const rootW = balloonW + 8;
  const rootH = 96;
  return (
    <Marker
      identifier={String(m.id)}
      coordinate={{ latitude: m.lat, longitude: m.lng }}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges
      onPress={onPress}
      // Fabric (RN 0.81): the native marker view must be given its size
      // EXPLICITLY on the Marker itself — otherwise it keeps a stale small
      // bitmap and crops the children to the top-left corner (the clipping
      // that survived every child-level fix). Documented react-native-maps
      // new-architecture workaround.
      style={{ width: rootW, height: rootH }}
    >
      <View collapsable={false} style={{ width: rootW, height: rootH, alignItems: 'center' }}>
        {/* Balloon */}
        <View collapsable={false} style={[styles.balloon, { backgroundColor: color, width: balloonW }]}>
          <View style={styles.balloonBadge}>
            <Text allowFontScaling={false} style={[styles.balloonBadgeP, { color }]}>P</Text>
          </View>
          <View style={{ marginLeft: 8 }}>
            <Text allowFontScaling={false} style={styles.balloonPrice}>
              ₹{priceStr}<Text style={styles.balloonPerHr}>/hr</Text>
            </Text>
            {slots !== undefined ? (
              <Text allowFontScaling={false} style={styles.balloonSlots}>
                {m.available ? `${slots} available` : 'Full'}
              </Text>
            ) : null}
          </View>
        </View>
        {/* Tail */}
        <View style={[styles.balloonTail, { borderTopColor: color }]} />
        {/* Anchor dot on the exact coordinate */}
        <View style={[styles.balloonDot, { backgroundColor: color }]} />
      </View>
    </Marker>
  );
}

/**
 * AnimatedNavPuck — glides the navigation chevron between GPS fixes.
 *
 * GPS arrives ~1/sec; binding the marker straight to the fix teleports it once
 * a second (the "not smooth" complaint — same reason the MapLibre map had
 * AnimatedUserMarker). This interpolates position AND heading (shortest arc)
 * at display frame rate toward each new fix, over the actual gap between fixes,
 * so the arrow slides along the road like Google/Uber. Only this component
 * re-renders per frame; coordinate/rotation are native marker props, so the
 * bitmap (captured once) is never re-rasterised.
 */
function AnimatedNavPuck({ lat, lng, heading }: { lat: number; lng: number; heading?: number }) {
  const cur = useRef({ lat, lng, h: heading || 0 });
  const from = useRef({ ...cur.current });
  const to = useRef({ lat, lng, h: heading || 0 });
  const startTs = useRef(0);
  const dur = useRef(1000);
  const lastFix = useRef(0);
  const raf = useRef(0);
  const [pos, setPos] = useState({ lat, lng, h: heading || 0 });
  // Rasterise the chevron once, then animate natively.
  const [track, setTrack] = useState(true);
  useEffect(() => { const t = setTimeout(() => setTrack(false), 800); return () => clearTimeout(t); }, []);

  useEffect(() => {
    const now = Date.now();
    // Ease over the real gap between fixes (clamped) so one glide hands off
    // to the next with no stall and no lag buildup.
    dur.current = Math.min(2000, Math.max(300, lastFix.current ? now - lastFix.current : 1000));
    lastFix.current = now;
    from.current = { ...cur.current };
    const dh = (((heading || 0) - cur.current.h + 540) % 360) - 180; // shortest arc
    to.current = { lat, lng, h: cur.current.h + dh };
    startTs.current = now;
    cancelAnimationFrame(raf.current);
    const step = () => {
      const t = Math.min(1, (Date.now() - startTs.current) / dur.current);
      cur.current = {
        lat: from.current.lat + (to.current.lat - from.current.lat) * t,
        lng: from.current.lng + (to.current.lng - from.current.lng) * t,
        h: from.current.h + (to.current.h - from.current.h) * t,
      };
      setPos({ lat: cur.current.lat, lng: cur.current.lng, h: ((cur.current.h % 360) + 360) % 360 });
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [lat, lng, heading]);

  return (
    <Marker
      coordinate={{ latitude: pos.lat, longitude: pos.lng }}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={pos.h}
      tracksViewChanges={track}
      zIndex={10}
      style={{ width: 56, height: 56 }}
    >
      {/* Google's navigation arrow: a solid blue arrowhead with a white casing
          and a soft shadow, drawn flat on the map and rotated to heading.

          This was previously the Ionicons "navigate" glyph — a paper plane —
          drawn twice and rotated -45deg to fake an arrow. Two problems: it
          reads as a paper plane rather than Google's arrow, and the glyph is
          not symmetric about its own centre, so once rotated its tip sat off
          centre inside the marker box. The marker anchors at that box centre,
          so the arrow was drawn slightly away from the real GPS position and
          span about the wrong point when turning.

          Built from border triangles, the shape is exactly symmetric about the
          vertical axis and points straight up at rotation 0, so heading maps
          directly onto it with no correction. */}
      <View collapsable={false} style={styles.navArrowWrap}>
        <View style={styles.navArrowCasing} />
        <View style={styles.navArrowCore} />
      </View>
    </Marker>
  );
}

const GoogleMapNative = forwardRef((props: Props, ref: any) => {
  const mapRef = useRef<MapView>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Opening viewport: live fix, else remembered hint, else country fallback.
  const loc = props.userLocation || props.viewportHint || DEFAULT_MAP_CENTER;
  const initialZoom = props.userLocation
    ? USER_MAP_ZOOM
    : props.viewportHint
      ? HINT_MAP_ZOOM
      : DEFAULT_MAP_ZOOM;

  // ── Gesture vs programmatic camera bookkeeping ─────────────────
  const lastInteraction = useRef(0);
  const programmaticUntil = useRef(0);
  const currentZoom = useRef(USER_MAP_ZOOM); // tracked so follow never resets zoom
  const markProgrammatic = (durationMs: number) => {
    programmaticUntil.current = Date.now() + durationMs + 400;
  };

  // Current map rotation and tilt (deg), so the compass button can reflect the
  // camera and know whether it should be visible at all.
  const [mapHeading, setMapHeading] = useState(0);
  const [mapPitch, setMapPitch] = useState(0);

  // Compass ("heading-up") browsing mode — the third state of Google's My
  // Location button. Only meaningful outside navigation.
  const [headingMode, setHeadingMode] = useState(false);
  const deviceHeading = useRef(0);

  // The device compass is only watched while heading-up mode is actually on.
  // Subscribing all the time would spin the magnetometer for a view nobody is
  // looking at, which costs battery on a phone already running GPS.
  useEffect(() => {
    if (!headingMode || props.isActiveNavigation) return;
    let sub: any;
    let alive = true;
    (async () => {
      try {
        sub = await Location.watchHeadingAsync((h) => {
          if (!alive) return;
          // trueHeading is -1 until the magnetometer calibrates; fall back to
          // magnetic so the map still turns instead of sitting frozen at north.
          const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
          if (deg >= 0) deviceHeading.current = deg;
        });
      } catch {}
    })();
    return () => { alive = false; try { sub?.remove?.(); } catch {} };
  }, [headingMode, props.isActiveNavigation]);

  // Google shows the compass ONLY when the camera is actually turned or tilted,
  // and fades it away once you are back to plain north-up. Ours sat on screen
  // permanently, which is both visual noise and a control that does nothing
  // most of the time. Treat sub-degree rotation as north to avoid it flickering
  // in on rounding error.
  const compassVisible =
    !props.isActiveNavigation && (Math.abs(mapHeading) > 0.5 || mapPitch > 0.5);
  const compassOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(compassOpacity, {
      toValue: compassVisible ? 1 : 0,
      duration: compassVisible ? 120 : 300, // in fast, out gently — as Google does
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [compassVisible, compassOpacity]);

  // Panning away drops follow, and Google drops compass mode with it — the
  // rotated view is a *following* view, so it must not survive the user
  // wandering off somewhere else on the map.
  useEffect(() => {
    if (!props.isFollowing && headingMode) setHeadingMode(false);
  }, [props.isFollowing, headingMode]);

  // Day/night theme like Google: light by day, night palette 7pm–6am.
  // Re-checked every 5 minutes so a session crossing 7pm flips live.
  const [night, setNight] = useState(isNightHour);
  useEffect(() => {
    const iv = setInterval(() => setNight(isNightHour()), 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // Latched once the camera has been positioned deliberately — either by the
  // open-on-first-fix snap or by an explicit app-driven move. Declared here so
  // the imperative handle below can set it.
  const didInitialPosition = useRef(false);

  // Holds the follow camera off while a deliberate move (recenter) animates,
  // so the two never run at once.
  const suppressFollowUntil = useRef(0);

  // ── Imperative ref: the finder drives the whole map through animateCamera ──
  useImperativeHandle(ref, () => ({
    animateCamera: (cfg: any, opts?: any) => {
      const c = cfg?.center;
      if (!c || !mapRef.current) return;

      // An explicit camera move from the app (search result, spot selection)
      // supersedes the open-on-first-fix snap. Without this latch, the retry
      // loop behind trySnapToUser would fire a moment later and yank the camera
      // back to the user — which is why the FIRST search never appeared to move
      // the map while every search after it worked (by then the latch was
      // already set for other reasons).
      didInitialPosition.current = true;

      markProgrammatic(opts?.duration ?? 1000);
      mapRef.current.animateCamera(
        {
          center: { latitude: c.latitude, longitude: c.longitude },
          ...(cfg.zoom != null ? { zoom: cfg.zoom } : {}),
          ...(cfg.pitch != null ? { pitch: cfg.pitch } : {}),
          ...(cfg.heading != null ? { heading: cfg.heading } : {}),
        },
        { duration: opts?.duration ?? 1000 }
      );
    },
  }));

  // ── Open on first fix ─────────────────────────────────────────
  // initialCamera handles a cold start with a known location. But when the fix
  // arrives AFTER mount, snap once to it — unless the screen already has a
  // destination/searched place to frame.
  // mapReady is STATE (not a ref) so the positioning effect below actually
  // re-runs when the map becomes ready — a ref change never re-triggers it,
  // which is why the camera kept getting stuck on the country-wide view.
  const [mapReady, setMapReady] = useState(false);
  // A guaranteed device fix for the opening camera, independent of the app's
  // userLocation prop (which can lag) and of native-event ordering. This is the
  // safety net that ensures we never open on the whole-India fallback.
  const [selfLoc, setSelfLoc] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const last = await Location.getLastKnownPositionAsync();
        if (alive && last?.coords) setSelfLoc({ lat: last.coords.latitude, lng: last.coords.longitude });
        const cur = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (alive && cur?.coords) setSelfLoc({ lat: cur.coords.latitude, lng: cur.coords.longitude });
      } catch {}
    })();
    return () => { alive = false; };
  }, []);
  // Open on the user with VERIFIED retries. The old one-shot latch could fire
  // into a not-yet-ready native map (silent no-op) and never try again — that
  // was the "whole India until you recenter manually" bug. Now we only latch
  // AFTER getCamera confirms the snap landed; until then every new fix / ready
  // signal retries. User gestures also latch (never fight the user).
  const trySnapToUser = useCallback(() => {
    if (didInitialPosition.current || !mapRef.current) return;
    if (propsRef.current.destination || propsRef.current.searchedPlace) { didInitialPosition.current = true; return; }
    // Only defer to the user while they are ACTIVELY interacting (last gesture
    // within 3s). A single stray early touch on the country-view fallback must
    // not permanently cancel the open-on-user snap — that was the "stuck on
    // whole-India until I recenter" bug. Once they stop, we still center them.
    if (lastInteraction.current > 0 && Date.now() - lastInteraction.current < 3000) return;
    const u = propsRef.current.userLocation || selfLoc;
    if (!u) return;
    markProgrammatic(900);
    currentZoom.current = USER_MAP_ZOOM;
    mapRef.current.setCamera({ center: { latitude: u.lat, longitude: u.lng }, zoom: USER_MAP_ZOOM, pitch: 0, heading: 0 });
    // Latch ONLY once the camera verifiably moved off the country-wide view.
    setTimeout(() => {
      mapRef.current?.getCamera?.().then((cam: any) => {
        if (cam && typeof cam.zoom === 'number' && cam.zoom >= USER_MAP_ZOOM - 2) {
          didInitialPosition.current = true;
        }
      }).catch(() => {});
    }, 300);
  }, [selfLoc]);
  useEffect(() => { trySnapToUser(); }, [mapReady, props.userLocation, selfLoc, trySnapToUser]);
  // Steady retry heartbeat for the first seconds after mount — covers every
  // ready/fix ordering without depending on any single event.
  useEffect(() => {
    const iv = setInterval(() => {
      if (didInitialPosition.current) { clearInterval(iv); return; }
      trySnapToUser();
    }, 700);
    const stop = setTimeout(() => clearInterval(iv), 45000); // cover slow/cold GPS fixes
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [trySnapToUser]);

  // ── Auto-resume following after the user stops interacting ────
  //
  // A gesture releases follow so the camera doesn't fight the user's fingers.
  // But nothing ever restored it, so the map stayed frozen while the dot moved
  // on — the "I'm riding and the map won't track me" problem. Once they've
  // stopped touching the screen, resume.
  //
  // Skipped while a destination is being previewed but not yet driven: there
  // the user is deliberately looking at the whole route, and yanking the camera
  // back to them after six seconds would be worse than leaving it.
  useEffect(() => {
    if (props.isFollowing) return;
    const previewingRoute = !props.isActiveNavigation && (props.destination || props.searchedPlace);
    if (previewingRoute) return;

    const iv = setInterval(() => {
      if (propsRef.current.isFollowing) return;
      if (Date.now() - lastInteraction.current < AUTO_RESUME_FOLLOW_MS) return;
      // onRecenter just flips isFollowing back on in the finder; the follow
      // effect below then takes over smoothly from wherever the camera is.
      propsRef.current.onRecenter?.();
    }, 1000);
    return () => clearInterval(iv);
  }, [props.isFollowing, props.isActiveNavigation, props.destination, props.searchedPlace]);

  // ── Camera follow ─────────────────────────────────────────────
  useEffect(() => {
    if (!props.isFollowing || !props.userLocation || !mapRef.current) return;
    if (Date.now() - lastInteraction.current < 2000) return; // don't fight a fresh gesture
    // Nor fight a recenter that is still animating. handleRecenter flips
    // isFollowing back on, which re-runs this effect immediately — without the
    // hold that started a second animation on top of the first, which is the
    // stutter the recenter button had.
    if (Date.now() < suppressFollowUntil.current) return;
    const center = { latitude: props.userLocation.lat, longitude: props.userLocation.lng };
    if (props.isActiveNavigation) {
      markProgrammatic(NAV_FOLLOW_MS + 200);
      mapRef.current.animateCamera(
        { center, zoom: NAV_ZOOM, pitch: NAV_PITCH, heading: props.heading || 0 },
        { duration: NAV_FOLLOW_MS }
      );
    } else {
      markProgrammatic(FOLLOW_EASE_MS + 200);
      // Recenter but keep zoom EXPLICIT — a partial camera resets zoom to a
      // default on Android, which read as the map "slowly zooming out".
      mapRef.current.animateCamera(
        {
          center,
          zoom: currentZoom.current || USER_MAP_ZOOM,
          ...(headingMode ? { heading: deviceHeading.current } : {}),
        },
        { duration: FOLLOW_EASE_MS }
      );
    }
  }, [props.userLocation, props.isFollowing, props.isActiveNavigation, props.heading, headingMode]);

  // In heading-up mode the map must turn as the phone turns, not only when a
  // new GPS fix lands — standing still and rotating on the spot is exactly when
  // you use this mode, and that produces no position updates at all.
  useEffect(() => {
    if (!headingMode || props.isActiveNavigation || !props.isFollowing) return;
    const iv = setInterval(() => {
      if (!mapRef.current) return;
      if (Date.now() - lastInteraction.current < 2000) return;
      if (Date.now() < suppressFollowUntil.current) return;
      // Only move for a turn big enough to see; below that it is compass noise
      // and animating it just makes the map shimmer.
      const delta = Math.abs((((deviceHeading.current - mapHeading + 540) % 360) - 180));
      if (delta < 3) return;
      markProgrammatic(400);
      mapRef.current.animateCamera({ heading: deviceHeading.current }, { duration: 300 });
    }, 250);
    return () => clearInterval(iv);
  }, [headingMode, props.isActiveNavigation, props.isFollowing, mapHeading]);

  // ── Entering navigation: snap to the driving camera ──────────
  // The follow effect only moves the camera when one of its inputs changes, so
  // a rider who starts navigation while stationary would sit on the browsing
  // camera until the next GPS fix happened to differ. Starting navigation is an
  // explicit app transition, so it gets its own decisive move — and it
  // deliberately ignores the recent-gesture guard, which exists to stop the
  // follow camera fighting the user's fingers, not to block a deliberate start.
  const wasNavigating = useRef(false);
  useEffect(() => {
    const nav = !!props.isActiveNavigation;
    const entering = nav && !wasNavigating.current;
    wasNavigating.current = nav;
    if (!entering || !mapRef.current) return;
    const u = props.userLocation;
    if (!u) return;
    currentZoom.current = NAV_ZOOM;
    markProgrammatic(700);
    suppressFollowUntil.current = Date.now() + 700;
    mapRef.current.animateCamera(
      {
        center: { latitude: u.lat, longitude: u.lng },
        zoom: NAV_ZOOM,
        pitch: NAV_PITCH,
        heading: props.heading || 0,
      },
      { duration: 600 }
    );
  }, [props.isActiveNavigation, props.userLocation, props.heading]);

  // ── Fit route into view when it first appears (spot preview) ───
  const hadRouteRef = useRef(false);
  const rc = props.routeCoords || [];
  const routeSig = rc.length >= 2
    ? `${rc.length}:${rc[0].latitude.toFixed(5)},${rc[0].longitude.toFixed(5)}:${rc[rc.length - 1].latitude.toFixed(5)},${rc[rc.length - 1].longitude.toFixed(5)}`
    : '';
  useEffect(() => {
    if (rc.length >= 2 && !props.isActiveNavigation && !hadRouteRef.current && mapRef.current) {
      markProgrammatic(1000);
      mapRef.current.fitToCoordinates(rc, {
        edgePadding: { top: 120, right: 60, bottom: 220, left: 60 },
        animated: true,
      });
    }
    hadRouteRef.current = rc.length >= 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSig, props.isActiveNavigation]);

  // ── Off-route detection (identical geometry to the MapLibre version) ──
  const offRouteHits = useRef(0);
  useEffect(() => {
    if (!props.isActiveNavigation || !props.userLocation || rc.length < 2) return;
    const u = props.userLocation;
    const cosLat = Math.cos((u.lat * Math.PI) / 180);
    let minSq = Infinity;
    for (let i = 0; i < rc.length - 1; i++) {
      const ax = (rc[i].longitude - u.lng) * 111320 * cosLat;
      const ay = (rc[i].latitude - u.lat) * 110540;
      const bx = (rc[i + 1].longitude - u.lng) * 111320 * cosLat;
      const by = (rc[i + 1].latitude - u.lat) * 110540;
      const dx = bx - ax;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = px * px + py * py;
      if (d < minSq) minSq = d;
      if (minSq < 400) { offRouteHits.current = 0; return; }
    }
    const offBy = Math.sqrt(minSq);
    const acc = props.locationAccuracy ?? 0;
    const threshold = Math.max(OFF_ROUTE_BASE_M, acc * 2);
    if (offBy > threshold) {
      offRouteHits.current += 1;
      if (offRouteHits.current >= OFF_ROUTE_CONFIRMATIONS) {
        offRouteHits.current = 0;
        propsRef.current.onOffRoute?.(u.lat, u.lng);
      }
    } else {
      offRouteHits.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.userLocation, props.isActiveNavigation, props.locationAccuracy, routeSig]);

  // ── Custom-marker bitmap capture ──────────────────────────────
  // react-native-maps must render a custom marker's React view to a bitmap.
  // Keeping tracksViewChanges permanently on re-rasterises every frame (jank);
  // permanently off can leave a marker blank. Flip it on briefly whenever the
  // marker set changes, then off once captured.
  const dest = props.searchedPlace
    ? { lat: props.searchedPlace.lat, lng: props.searchedPlace.lng }
    : props.destination
      ? { lat: props.destination.lat, lng: props.destination.lng }
      : null;
  const markerSig = (props.markers || []).map((m) => `${m.id}:${m.price}:${m.available ? 1 : 0}:${m.available_slots ?? ''}`).join('|');
  const destKey = dest ? `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}` : '';
  const [track, setTrack] = useState(true);
  useEffect(() => {
    setTrack(true);
    const t = setTimeout(() => setTrack(false), 1200);
    return () => clearTimeout(t);
  }, [markerSig, destKey, props.isActiveNavigation]);

  // ── Handlers ──────────────────────────────────────────────────
  const handlePress = (e: any) => {
    if (Date.now() - lastInteraction.current < GESTURE_PRESS_GUARD_MS) return;
    const c = e?.nativeEvent?.coordinate;
    if (c && props.onMapPress) props.onMapPress([c.longitude, c.latitude]);
  };
  const handlePanDrag = () => {
    lastInteraction.current = Date.now();
    if (propsRef.current.isFollowing) propsRef.current.onMapInteraction?.();
  };
  const handleRecenter = () => {
    lastInteraction.current = 0;
    const u = props.userLocation;

    // Google's My Location button is a THREE-state cycle, not a toggle:
    //   off  -> tap: follow me, map stays north-up
    //   follow -> tap: compass mode, map rotates to face the way I'm facing
    //   compass -> tap: back to north-up follow
    // Ours was binary, so there was no way to get the heading-up browsing view
    // Google gives you. During navigation none of this applies — the camera is
    // always heading-up and the button is purely "re-centre".
    let nextHeadingMode = false;
    if (!props.isActiveNavigation) {
      if (!props.isFollowing) nextHeadingMode = false;      // off -> follow
      else nextHeadingMode = !headingMode;                  // follow <-> compass
      setHeadingMode(nextHeadingMode);
    }
    if (u && mapRef.current) {
      // Recenter restores the SAME framing the map opens with — the identical
      // center/zoom/pitch/heading that trySnapToUser applies on the first fix.
      // So however far the user has panned or pinched, one tap puts them back
      // to the familiar "here I am" view rather than their location at some
      // arbitrary zoom they'd wandered to.
      //
      // While navigating this MUST be the exact camera the follow effect uses.
      // It used to be zoom 17.5 / pitch 55 while follow used NAV_ZOOM 18.5 /
      // NAV_PITCH 60, so recentring flew to one camera and the next GPS fix
      // immediately dragged it to a different one — you saw a wide view snap
      // in, then creep closer. That double move is why recenter "showed far".
      const targetZoom = props.isActiveNavigation ? NAV_ZOOM : USER_MAP_ZOOM;

      // Keep currentZoom in step, otherwise the follow effect (which animates
      // to currentZoom) would immediately pull the camera back to the old zoom
      // and undo the reset — the same two-animations-fighting bug as before.
      currentZoom.current = targetZoom;

      markProgrammatic(RECENTER_MS + 200);
      suppressFollowUntil.current = Date.now() + RECENTER_MS + 100;
      mapRef.current.animateCamera(
        {
          center: { latitude: u.lat, longitude: u.lng },
          zoom: targetZoom,
          pitch: props.isActiveNavigation ? NAV_PITCH : 0,
          heading: props.isActiveNavigation
            ? props.heading || 0
            : nextHeadingMode
              ? deviceHeading.current
              : 0,
        },
        { duration: RECENTER_MS }
      );
    }
    props.onRecenter?.();
  };

  // A user gesture (pan / pinch-zoom / rotate) releases the follow-camera so it
  // stops re-centering under the user's fingers. Google reports isGesture here.
  // Live-read the map's rotation for the compass, throttled so gestures stay smooth.
  const lastHeadingRead = useRef(0);
  const readHeading = () => {
    const now = Date.now();
    if (now - lastHeadingRead.current < 90) return;
    lastHeadingRead.current = now;
    mapRef.current?.getCamera?.().then((cam: any) => {
      if (cam && typeof cam.heading === 'number') setMapHeading(cam.heading);
      if (cam && typeof cam.pitch === 'number') setMapPitch(cam.pitch);
      if (cam && typeof cam.zoom === 'number') currentZoom.current = cam.zoom;
    }).catch(() => {});
  };
  const handleRegionChangeComplete = (_region: any, details?: any) => {
    if (details?.isGesture) {
      lastInteraction.current = Date.now();
      if (propsRef.current.isFollowing) propsRef.current.onMapInteraction?.();
    }
    readHeading();
  };

  // Stepwise zoom for the +/- buttons (Google-style controls).
  const zoomBy = async (delta: number) => {
    try {
      const cam = await mapRef.current?.getCamera?.();
      if (!cam) return;
      markProgrammatic(400);
      mapRef.current?.animateCamera({ zoom: Math.max(3, Math.min(20, (cam.zoom || 15) + delta)) }, { duration: 220 });
    } catch {}
  };

  // The map's OWN location fix (the one drawing the native blue dot) — the
  // freshest possible source. Feed it into the verified snap pipeline; the
  // retry heartbeat does the rest.
  const handleUserLocationChange = (e: any) => {
    const c = e?.nativeEvent?.coordinate;
    if (!c || typeof c.latitude !== 'number') return;
    if (!didInitialPosition.current) setSelfLoc({ lat: c.latitude, lng: c.longitude });
  };

  // ── Route polylines ───────────────────────────────────────────
  // Alternatives are TAPPABLE — tapping a grey route selects it (the finder
  // swaps it in as the main route). Index is the ORIGINAL altRoutes index so
  // the finder's lookup matches even if some alternates are invalid.
  const altPolylines = useMemo(
    () =>
      (props.altRoutes || []).map((a, i) =>
        (a.coords?.length || 0) >= 2 ? (
          <Polyline
            key={`alt-${i}`}
            coordinates={a.coords}
            strokeColor="#78909c"
            strokeWidth={7}
            zIndex={1}
            lineCap="round"
            lineJoin="round"
            tappable
            onPress={() => propsRef.current.onSelectAltRoute?.(i)}
          />
        ) : null
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [(props.altRoutes || []).map((a) => `${a.coords?.length || 0}:${Math.round(a.duration || 0)}`).join('|')]
  );

  // ── Traffic-colored segments (navigation) ─────────────────────
  // Same behaviour as the MapLibre map: while navigating with traffic data,
  // the plain route dims and per-step congestion segments draw on top
  // (green/amber/orange/red by measured speed).
  // Only genuinely slow stretches get tinted. Previously EVERY segment was
  // recoloured, and since city traffic classifies as moderate/heavy the whole
  // route rendered orange instead of the blue drivers expect. Google keeps the
  // route blue and highlights only the parts that are actually bad — which is
  // what makes the highlight meaningful.
  const allSegs = props.trafficSegments || [];
  const trafficSegs = allSegs.filter(
    (s: any) => s.congestion === 'heavy' || s.congestion === 'severe'
  );
  const hasTraffic = !!props.isActiveNavigation && trafficSegs.length > 0;
  const trafficPolylines = useMemo(
    () =>
      !hasTraffic
        ? null
        : trafficSegs.map((seg: any, i: number) =>
            (seg.coords?.length || 0) >= 2 ? (
              <Polyline
                key={`traffic-${i}`}
                coordinates={seg.coords.map((c: [number, number]) => ({ latitude: c[1], longitude: c[0] }))}
                strokeColor={TRAFFIC_COLORS[seg.congestion] || '#4285F4'}
                strokeWidth={7}
                zIndex={4}
                lineCap="round"
                lineJoin="round"
              />
            ) : null
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasTraffic, trafficSegs.map((s: any) => `${s.coords?.length || 0}:${s.congestion}`).join('|')]
  );

  const spotMarkers = useMemo(
    () =>
      (propsRef.current.markers || []).map((m) => {
        // The selected spot is shown as the destination pin alone — skip its
        // pill so two markers don't stack on the same point (Google does this).
        const isActive = !!dest && Math.abs(dest.lat - m.lat) < 0.001 && Math.abs(dest.lng - m.lng) < 0.001;
        if (isActive) return null;
        // Key includes price/availability so the marker fully re-creates instead
        // of reusing a stale (too-narrow) bitmap.
        return <SpotMarker key={`${m.id}:${m.price}:${m.available ? 1 : 0}:${m.available_slots ?? ''}`} m={m} onPress={() => propsRef.current.onMarkerPress?.(m.id)} />;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markerSig, destKey]
  );

  return (
    <View style={[StyleSheet.absoluteFill, props.style]}>
      <MapView
        // Key on the theme: userInterfaceStyle is applied at map creation, so a
        // day/night flip mid-session remounts the map in the new scheme (the
        // first-fix logic re-centers it automatically).
        key={night ? 'map-dark' : 'map-light'}
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        userInterfaceStyle={night ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
        initialCamera={{
          center: { latitude: loc.lat, longitude: loc.lng },
          pitch: 0,
          heading: 0,
          zoom: initialZoom,
          altitude: 0,
        }}
        onMapReady={() => setMapReady(true)}
        onPress={handlePress}
        onPanDrag={handlePanDrag}
        onRegionChangeComplete={handleRegionChangeComplete}
        onRegionChange={readHeading}
        onUserLocationChange={handleUserLocationChange}
        // Push Google's native controls (My Location button, compass) below the
        // search bar and above the bottom sheet, and lift the Google logo clear.
        /* While navigating, weight the padding to the TOP so the camera centre
           sits low on screen — that is how Google frames it: you appear near
           the bottom with the road ahead filling the view, rather than centred
           with half the screen showing where you have already been. Outside
           navigation the bottom sheet is what needs clearing, so the padding
           flips back. */
        mapPadding={
          props.isActiveNavigation
            ? { top: NAV_TOP_PADDING, right: 6, bottom: 80, left: 6 }
            : { top: 100, right: 6, bottom: props.controlsBottomOffset ?? 210, left: 6 }
        }
        // Authentic Google location dot + controls when idle; during navigation
        // we hide them and draw the directional arrow puck instead.
        showsUserLocation={!props.isActiveNavigation}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        zoomEnabled
        scrollEnabled
        rotateEnabled
        pitchEnabled
      >
        {/* Alternative routes — muted grey beneath the main route */}
        {altPolylines}

        {/* Main route: dark casing under a bright line (Google style). While
            traffic segments are showing, the plain route dims so the colored
            congestion overlay reads clearly — same as the MapLibre map. */}
        {rc.length >= 2 ? (
          <>
            {/* The route is ALWAYS solid blue. It used to fade to 15-20%
                opacity whenever any traffic data existed, which left the
                congestion overlay as the only visible line — that is why the
                whole route looked orange rather than blue with a few slow
                stretches marked. */}
            <Polyline coordinates={rc} strokeColor="#0d47a1" strokeWidth={12} zIndex={2} lineCap="round" lineJoin="round" />
            <Polyline coordinates={rc} strokeColor="#4285F4" strokeWidth={7} zIndex={3} lineCap="round" lineJoin="round" />
          </>
        ) : null}

        {/* Traffic congestion overlay (navigation only) */}
        {trafficPolylines}

        {/* During navigation, a directional arrow puck (flat markers rotate in
            the map frame, so rotation=heading points along the road like
            Google/Uber). Idle location is Google's own native blue dot. */}
        {props.userLocation && props.isActiveNavigation ? (
          <AnimatedNavPuck
            key="user-nav"
            lat={props.userLocation.lat}
            lng={props.userLocation.lng}
            heading={props.heading}
          />
        ) : null}

        {/* Parking spots */}
        {spotMarkers}

        {/* Destination pin — teardrop whose tail tip sits on the coordinate */}
        {dest ? (
          <Marker
            key="destination"
            coordinate={{ latitude: dest.lat, longitude: dest.lng }}
            anchor={{ x: 0.5, y: 1 }}
            tracksViewChanges={track}
            zIndex={9}
          >
            <View style={styles.destPinWrap}>
              <View style={styles.destPinHead}><View style={styles.destPinInner} /></View>
              <View style={styles.destPinTail} />
            </View>
          </Marker>
        ) : null}
      </MapView>

      {/* Google-style control cluster, bottom-right: compass, zoom, my-location */}
      {!props.hideControls ? (
        <>
          {/* Compass — appears only when the map is turned or tilted, rotates
              with the camera, and resets BOTH rotation and tilt on tap. */}
          <Animated.View
            style={[
              styles.mapCtrlBtn,
              { bottom: (props.controlsBottomOffset ?? 210) + 168, opacity: compassOpacity },
            ]}
            pointerEvents={compassVisible ? 'auto' : 'none'}
          >
            <TouchableOpacity
              style={styles.mapCtrlHit}
              activeOpacity={0.85}
              onPress={() => {
                markProgrammatic(500);
                // Google's compass returns you to north-up AND flat. Resetting
                // heading alone left the map tilted with a compass claiming it
                // was already north, so there was no way back to a flat view
                // except pinching with two fingers.
                mapRef.current?.animateCamera({ heading: 0, pitch: 0 }, { duration: 350 });
                setMapHeading(0);
                setMapPitch(0);
                // Rotating by hand is an explicit choice to look a certain way;
                // holding heading-up mode on afterwards would immediately spin
                // the map back and undo the tap.
                setHeadingMode(false);
              }}
            >
              <View style={[styles.compassNeedle, { transform: [{ rotate: `${-mapHeading}deg` }] }]}>
                <View style={styles.compassN} />
                <View style={styles.compassS} />
                <Text style={styles.compassNLabel}>N</Text>
              </View>
            </TouchableOpacity>
          </Animated.View>

          {/* Zoom + / - pill */}
          <View style={[styles.zoomPill, { bottom: (props.controlsBottomOffset ?? 210) + 60 }]}>
            <TouchableOpacity style={styles.zoomBtn} onPress={() => zoomBy(1)} activeOpacity={0.7}>
              <Ionicons name="add" size={24} color="#3c4043" />
            </TouchableOpacity>
            <View style={styles.zoomDivider} />
            <TouchableOpacity style={styles.zoomBtn} onPress={() => zoomBy(-1)} activeOpacity={0.7}>
              <Ionicons name="remove" size={24} color="#3c4043" />
            </TouchableOpacity>
          </View>

          {/* My Location / recenter */}
          <TouchableOpacity
            style={[styles.recenterBtn, { bottom: props.controlsBottomOffset ?? 210 }]}
            onPress={handleRecenter}
            activeOpacity={0.8}
          >
            {/* Three states, matching Google: hollow grey = not following,
                solid blue = following north-up, arrow = heading-up. */}
            <Ionicons
              name={
                headingMode && props.isFollowing
                  ? 'navigate'
                  : props.isFollowing
                    ? 'locate'
                    : 'locate-outline'
              }
              size={22}
              color={props.isFollowing ? '#1a73e8' : '#5f6368'}
            />
          </TouchableOpacity>
        </>
      ) : null}
    </View>
  );
});

GoogleMapNative.displayName = 'GoogleMapNative';

const styles = StyleSheet.create({
  // Google-style location indicator: translucent accuracy halo -> white ring
  // with a soft shadow -> solid blue core. Crisp and professional.
  userAccuracy: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(66,133,244,0.18)', alignItems: 'center', justifyContent: 'center' },
  userDotRing: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 4 },
  userDotCore: { width: 15, height: 15, borderRadius: 7.5, backgroundColor: '#1a73e8' },
  // Fixed-size pieces so Android measures the marker correctly (no clipping):
  // a white "P" badge + price on a rounded blue pill with a soft shadow.
  // Single-node pill: background + padding live on the Text itself, so Android
  // measures exactly one box and cannot clip it.
  spotPillFlat: { backgroundColor: '#4285F4', color: '#fff', fontSize: 13, fontWeight: '800', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 15, overflow: 'hidden', textAlign: 'center' },
  spotPillFlatUnavailable: { backgroundColor: '#9aa0a6' },
  // Balloon marker (design reference): balloon + white P badge + tail + dot.
  balloon: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, height: 56 },
  balloonBadge: { width: 36, height: 36, borderRadius: 9, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  balloonBadgeP: { fontSize: 22, fontWeight: '900', lineHeight: 26 },
  balloonPrice: { color: '#fff', fontSize: 17, fontWeight: '900', lineHeight: 20 },
  balloonPerHr: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700' },
  balloonSlots: { color: 'rgba(255,255,255,0.92)', fontSize: 11, fontWeight: '600', marginTop: 1 },
  balloonTail: { width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderTopWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  balloonDot: { width: 13, height: 13, borderRadius: 6.5, borderWidth: 2.5, borderColor: '#fff', marginTop: 5 },
  spotPill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#4285F4', paddingVertical: 4, borderRadius: 16, borderWidth: 2, borderColor: '#fff' },
  spotPillUnavailable: { backgroundColor: '#9aa0a6' },
  spotPBadge: { width: 17, height: 17, borderRadius: 8.5, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginRight: 5 },
  spotPLetter: { color: '#4285F4', fontWeight: '900', fontSize: 11, lineHeight: 13 },
  spotPillText: { color: '#fff', fontWeight: '800', fontSize: 12, lineHeight: 14, flexShrink: 0 },
  spotPillPerHr: { color: 'rgba(255,255,255,0.85)', fontWeight: '600', fontSize: 10, marginLeft: 1, flexShrink: 0 },
  // Navigation arrow. The wrapper is square and the triangles are centred in
  // it, so the marker's 0.5/0.5 anchor lands on the arrow's own centre of
  // rotation — the arrow turns on the spot instead of orbiting a point.
  navArrowWrap: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  // White casing, drawn first and slightly larger so it reads as an outline.
  navArrowCasing: {
    position: 'absolute',
    width: 0, height: 0,
    borderLeftWidth: 15, borderRightWidth: 15, borderBottomWidth: 34,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  // Google's puck blue, inset evenly inside the casing.
  //
  // The geometry is deliberate, not eyeballed. Simply centring a smaller
  // triangle inside a larger one gives an uneven outline — thin at the tip,
  // thick at the base — because the two triangles' edges are not parallel
  // unless the inner one is both scaled AND pushed down. Half-width/height
  // held at 15/34 keeps the edges parallel; the 6px offset then sets the
  // stroke to a uniform ~2.5px, which is Google's weight.
  navArrowCore: {
    position: 'absolute',
    marginTop: 6,
    width: 0, height: 0,
    borderLeftWidth: 10.5, borderRightWidth: 10.5, borderBottomWidth: 24,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#4285F4',
  },
  recenterBtn: { position: 'absolute', right: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 6 },
  mapCtrlBtn: { position: 'absolute', right: 16, width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  // The touchable now lives INSIDE the animated wrapper, so it has to fill it
  // for the whole circle to stay tappable.
  mapCtrlHit: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', borderRadius: 23 },
  zoomPill: { position: 'absolute', right: 16, width: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', paddingVertical: 2, shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  zoomBtn: { width: 46, height: 42, alignItems: 'center', justifyContent: 'center' },
  zoomDivider: { width: 24, height: 1, backgroundColor: 'rgba(0,0,0,0.08)' },
  compassNeedle: { width: 20, height: 24, alignItems: 'center', justifyContent: 'center' },
  compassN: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#EA4335' },
  compassS: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 11, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#c1c7cd' },
  compassNLabel: { position: 'absolute', top: -8, color: '#EA4335', fontSize: 8, fontWeight: '900' },
  destPinWrap: { alignItems: 'center' },
  destPinHead: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#EA4335', borderWidth: 2.5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 5, zIndex: 2 },
  destPinInner: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#fff' },
  destPinTail: { width: 0, height: 0, borderLeftWidth: 7, borderRightWidth: 7, borderTopWidth: 13, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#EA4335', marginTop: -4, zIndex: 1 },
});

export default GoogleMapNative;
