/**
 * MapLibreNative.tsx — native MapLibre GL v11 map (Track 1 migration).
 *
 * Step 1 scope: base map, camera, live-location dot, professional spot markers,
 * and the destination pin — replacing the limited WebView fallback. Route
 * drawing and turn-by-turn navigation camera come in later steps.
 *
 * v11 API notes (differs from the old v9 code):
 *   - <Map mapStyle={url}>  (was <MapView styleURL>)
 *   - <Camera> ref.flyTo({ center: [lng, lat], zoom, duration })
 *   - <Marker lngLat={[lng, lat]} anchor="bottom">  (was <MarkerView coordinate>)
 */
import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, USER_MAP_ZOOM, HINT_MAP_ZOOM } from '../constants/mapDefaults';

// The native module is present in the dev build; access its v11 named exports.
const MLGL: any = require('@maplibre/maplibre-react-native');
const MLMap = MLGL.Map;
const MLCamera = MLGL.Camera;
const MLMarker = MLGL.Marker;
const MLGeoJSONSource = MLGL.GeoJSONSource;
const MLLayer = MLGL.Layer;
const MLImages = MLGL.Images;

/**
 * Duration of each follow-camera ease. Deliberately equal to the position
 * watcher's `timeInterval` (1000ms in app/finder/index.tsx) so consecutive
 * eases butt up against each other and the camera never sits still between
 * fixes. Changing one without the other reintroduces follow stutter.
 */
const FOLLOW_EASE_MS = 1000;

/**
 * A map press arriving within this long of the last pan/pinch/rotate is treated
 * as a gesture artifact, not a deliberate tap. Long enough to cover the finger
 * lift at the end of a pinch; short enough that a real tap still registers.
 */
const GESTURE_PRESS_GUARD_MS = 350;

const CARTO_DAY = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const CARTO_NIGHT = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

type Props = {
  userLocation?: { lat: number; lng: number };
  /**
   * Remembered position from a previous session, used ONLY to choose the
   * opening viewport so a cold start doesn't render the whole country.
   * Deliberately separate from `userLocation`: this never draws the blue dot
   * and never feeds distance, booking, or arrival logic, because it may be days
   * out of date.
   */
  viewportHint?: { lat: number; lng: number } | null;
  markers?: Array<{ id: string; lat: number; lng: number; price: number; available: boolean; title?: string }>;
  routeCoords?: Array<{ latitude: number; longitude: number }>;
  altRoutes?: Array<{ coords: Array<{ latitude: number; longitude: number }>; duration: number; distance: number }>;
  searchedPlace?: { lat: number; lng: number; title: string } | null;
  destination?: { lat: number; lng: number } | null;
  isActiveNavigation?: boolean;
  isFollowing?: boolean;
  heading?: number;
  mapStyleUrl?: string;
  mapApiKey?: string;
  onMapPress?: (coords: [number, number]) => void;
  onMapInteraction?: () => void;
  onMarkerPress?: (id: string) => void;
  onRecenter?: () => void;
  onOffRoute?: (lat: number, lng: number) => void;
  hideControls?: boolean;
  /** Bottom offset for recenter/compass so they ride above visible panels. */
  controlsBottomOffset?: number;
  style?: any;
};

const lineFeature = (coords: Array<{ latitude: number; longitude: number }>) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'LineString' as const,
    coordinates: coords.map((c) => [c.longitude, c.latitude]),
  },
});

const MapLibreNative = forwardRef((props: Props, ref: any) => {
  const cameraRef = useRef<any>(null);
  const [styleFailed, setStyleFailed] = React.useState(false);

  // Opening viewport, best available first: a live fix, else where the user was
  // last time, else the country-wide fallback. The country view is a last
  // resort — it should only ever be seen on a genuine first run.
  const loc = props.userLocation || props.viewportHint || DEFAULT_MAP_CENTER;
  const initialZoom = props.userLocation
    ? USER_MAP_ZOOM
    : props.viewportHint
      ? HINT_MAP_ZOOM
      : DEFAULT_MAP_ZOOM;
  const hour = new Date().getHours();
  const fallbackStyle = hour >= 19 || hour < 6 ? CARTO_NIGHT : CARTO_DAY;

  // Ola Maps requires its API key on EVERY resource request — not just the
  // style JSON, but also the tile sources, sprites, and glyphs referenced
  // inside it (each 401s without the key). TransformRequestManager appends the
  // key to all olamaps.io requests. Stable id => updates in place on re-render.
  // useMemo (not useEffect) so the transform is registered BEFORE the style is
  // handed to the Map in this same render — otherwise the first fetch races it.
  React.useMemo(() => {
    if (props.mapApiKey && MLGL.TransformRequestManager) {
      MLGL.TransformRequestManager.addUrlSearchParam({
        id: 'ola-api-key',
        match: 'api\\.olamaps\\.io',
        name: 'api_key',
        value: props.mapApiKey,
      });
    }
  }, [props.mapApiKey]);

  // If the provided style failed to load (bad key, outage), fall back to Carto.
  const styleUrl = !styleFailed && props.mapStyleUrl ? props.mapStyleUrl : fallbackStyle;

  // Bridge the finder's react-native-maps-style call into the v11 Camera ref.
  useImperativeHandle(ref, () => ({
    animateCamera: (cfg: any) => {
      const c = cfg?.center;
      if (!c || !cameraRef.current) return;
      markProgrammatic(1000);
      cameraRef.current.flyTo({
        center: [c.longitude, c.latitude],
        zoom: cfg.zoom || 15,
        duration: 1000,
      });
    },
  }));

  // ── Initial positioning on the first real fix ─────────────────
  //
  // <Camera initialViewState> is applied ONCE at mount and is NOT reactive. So
  // when the app starts without location permission, the camera locks onto the
  // country-wide fallback and never moves — even after the user grants access
  // and `userLocation` populates. That was the "map won't find me" bug.
  //
  // The parent used to paper over this with a setTimeout(800) -> animateCamera,
  // which races both the style load and the camera mount and silently no-ops
  // when it loses (the ref guard returns early). Owning it here removes the
  // race: whichever of {map ready, first fix} happens last triggers the move.
  const didInitialPosition = useRef(false);
  const mapReady = useRef(false);

  const positionOnFirstFix = React.useCallback(() => {
    if (didInitialPosition.current) return;
    if (!mapReady.current || !cameraRef.current || !props.userLocation) return;
    // Don't hijack the camera if the screen already has somewhere to be.
    if (props.destination || props.searchedPlace) {
      didInitialPosition.current = true;
      return;
    }

    didInitialPosition.current = true;
    markProgrammatic(900);

    // Crucially: do NOT animate here. Flying from zoom 4 over the centre of
    // India to zoom 15 on a street is a ~1.5s swoop across the subcontinent —
    // that swoop is what reads as unprofessional. Snap instead, so the map
    // simply *opens* at the user's location.
    cameraRef.current.easeTo({
      center: [props.userLocation.lng, props.userLocation.lat],
      zoom: USER_MAP_ZOOM,
      pitch: 0,
      bearing: 0,
      duration: 0,
    });
  }, [props.userLocation, props.destination, props.searchedPlace]);

  React.useEffect(() => {
    positionOnFirstFix();
  }, [positionOnFirstFix]);

  const dest = props.searchedPlace
    ? { lat: props.searchedPlace.lat, lng: props.searchedPlace.lng }
    : props.destination
      ? { lat: props.destination.lat, lng: props.destination.lng }
      : null;

  // ── Camera follow ─────────────────────────────────────────────
  // While following, glide the camera to the user's position. During active
  // navigation: zoom in, tilt, and rotate to the direction of travel.
  React.useEffect(() => {
    if (!props.isFollowing || !props.userLocation || !cameraRef.current) return;
    // Grace period: never fight a gesture the user made in the last 2s,
    // even if the isFollowing prop hasn't flipped yet.
    if (Date.now() - lastInteraction.current < 2000) return;
    markProgrammatic(FOLLOW_EASE_MS + 200);
    if (props.isActiveNavigation) {
      bearingRef.current = props.heading || 0; // we set the bearing — track it
      // Ease over the SAME interval the position watcher ticks at (1s). A
      // shorter ease (this was 700ms) finishes early, leaves the camera parked
      // for the remaining 300ms, then lurches on the next fix — read as
      // stutter. Matching the tick keeps the camera continuously in motion so
      // one ease hands off to the next.
      cameraRef.current.easeTo({
        center: [props.userLocation.lng, props.userLocation.lat],
        zoom: 17.5,
        pitch: 55,
        bearing: props.heading || 0,
        duration: FOLLOW_EASE_MS,
      });
    } else {
      // Outside navigation: re-center, turning toward the direction of travel
      // ONLY when it changed meaningfully (>20° deadband). Compass jitter of
      // ±10-20° between ticks must not shake the map. Zoom/pitch remain
      // whatever the user pinched to.
      const h = props.heading || 0;
      const delta = Math.abs(((h - bearingRef.current + 540) % 360) - 180);
      if (delta > 20) {
        bearingRef.current = h;
        cameraRef.current.easeTo({
          center: [props.userLocation.lng, props.userLocation.lat],
          bearing: h,
          duration: FOLLOW_EASE_MS,
        });
      } else {
        cameraRef.current.easeTo({
          center: [props.userLocation.lng, props.userLocation.lat],
          duration: FOLLOW_EASE_MS,
        });
      }
    }
  }, [props.userLocation, props.isFollowing, props.isActiveNavigation, props.heading]);

  // ── Fit route into view ───────────────────────────────────────
  // When a route first appears outside navigation (spot preview), frame it.
  const hadRouteRef = useRef(false);
  React.useEffect(() => {
    const route = props.routeCoords || [];
    if (route.length >= 2 && !props.isActiveNavigation && !hadRouteRef.current && cameraRef.current) {
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const c of route) {
        if (c.longitude < w) w = c.longitude;
        if (c.longitude > e) e = c.longitude;
        if (c.latitude < s) s = c.latitude;
        if (c.latitude > n) n = c.latitude;
      }
      cameraRef.current.fitBounds([w, s, e, n], {
        padding: { top: 120, bottom: 220, left: 60, right: 60 },
        duration: 1000,
      });
    }
    hadRouteRef.current = route.length >= 2;
  }, [props.routeCoords, props.isActiveNavigation]);

  // ── Signature-based memoization ───────────────────────────────
  // The finder re-renders every few seconds (spot polling, route refetch) and
  // passes NEW array identities each time even when the content is identical.
  // Recomputing on identity would re-upload sources / rebuild native markers
  // mid-gesture and make the map feel stiff. Instead we key everything on cheap
  // content signatures: same content ⇒ zero native updates.
  const propsRef = useRef(props);
  propsRef.current = props; // callbacks inside memoized trees stay fresh

  const rc = props.routeCoords || [];
  const routeSig = rc.length >= 2
    ? `${rc.length}:${rc[0].latitude.toFixed(5)},${rc[0].longitude.toFixed(5)}:${rc[rc.length - 1].latitude.toFixed(5)},${rc[rc.length - 1].longitude.toFixed(5)}`
    : '';
  const altSig = (props.altRoutes || [])
    .map((a) => `${a.coords?.length || 0}:${Math.round(a.duration || 0)}`)
    .join('|');
  const markerSig = (props.markers || [])
    .map((m) => `${m.id}:${m.price}:${m.available ? 1 : 0}`)
    .join('|');
  const destKey = dest ? `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}` : '';

  /* eslint-disable react-hooks/exhaustive-deps -- intentionally keyed on content signatures */
  const routeGeo = React.useMemo(
    () => (rc.length >= 2 ? lineFeature(rc) : null),
    [routeSig]
  );

  // Diagnostics: catches "navigation active but no route line" definitively —
  // tells us whether the data is missing (finder side) or present-but-invisible
  // (native layer side).
  React.useEffect(() => {
    if (props.isActiveNavigation) {
      console.log(`[Map] nav=true routePoints=${rc.length} rendered=${!!routeGeo}`);
    }
  }, [props.isActiveNavigation, routeSig]);

  // ── Off-route detection ───────────────────────────────────────
  // If the user strays >50m from the route during navigation, notify the
  // finder (which reroutes with voice + haptics, on its own 10s cooldown).
  React.useEffect(() => {
    if (!props.isActiveNavigation || !props.userLocation || rc.length < 2) return;
    const u = props.userLocation;
    const cosLat = Math.cos((u.lat * Math.PI) / 180);
    let minSq = Infinity;
    // Point-to-segment distance in meters (equirectangular approximation),
    // sampled across the polyline — plenty accurate at street scale.
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
      if (minSq < 400) return; // already within 20m — on route, stop early
    }
    if (Math.sqrt(minSq) > 50) {
      console.log(`[Map] Off-route by ~${Math.round(Math.sqrt(minSq))}m — requesting reroute`);
      propsRef.current.onOffRoute?.(u.lat, u.lng);
    }
  }, [props.userLocation, props.isActiveNavigation, routeSig]);
  const altGeos = React.useMemo(
    () => (propsRef.current.altRoutes || []).filter((a) => a.coords?.length >= 2).map((a) => lineFeature(a.coords)),
    [altSig]
  );

  const spotMarkerElements = React.useMemo(() => {
    const d = propsRef.current.searchedPlace || propsRef.current.destination;
    return (propsRef.current.markers || []).map((m) => {
      const isActive = !!d && Math.abs(d.lat - m.lat) < 0.001 && Math.abs(d.lng - m.lng) < 0.001;
      // The selected spot is represented by the destination pin alone (its
      // price is shown in the booking panel) — rendering the ₹ pill too would
      // stack two markers on the same point. Google does the same: selected
      // place = one pin.
      if (isActive) return null;
      return (
        <MLMarker
          key={m.id}
          id={String(m.id)}
          lngLat={[m.lng, m.lat]}
          anchor="bottom"
          onPress={() => propsRef.current.onMarkerPress?.(m.id)}
        >
          <View
            style={[
              styles.spotPill,
              !m.available && styles.spotPillUnavailable,
              isActive && styles.spotPillActive,
            ]}
          >
            <Text style={styles.spotPillText}>🅿️ ₹{m.price}</Text>
          </View>
        </MLMarker>
      );
    });
  }, [markerSig, destKey]);

  const destMarkerElement = React.useMemo(
    () =>
      dest ? (
        <MLMarker id="destination" lngLat={[dest.lng, dest.lat]} anchor="bottom">
          {/* Classic teardrop map pin: round head + pointed tail whose tip
              sits exactly on the destination coordinate. */}
          <View style={styles.destPinWrap}>
            <View style={styles.destPinHead}>
              <View style={styles.destPinInner} />
            </View>
            <View style={styles.destPinTail} />
          </View>
        </MLMarker>
      ) : null,
    [destKey]
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  const handleMapPress = (e: any) => {
    // Ignore presses that land inside a gesture window. Pinch-zoom and pan on
    // Android routinely emit a press when the fingers lift unevenly, and the
    // finder treats a map press as "search for spots here" — so zooming out
    // was re-searching around wherever the fingers happened to be, often
    // kilometres from anything, and the list emptied to "No spots found".
    // A deliberate tap arrives well after the last gesture ends.
    if (Date.now() - lastInteraction.current < GESTURE_PRESS_GUARD_MS) return;

    const coords = e?.geometry?.coordinates || e?.nativeEvent?.geometry?.coordinates;
    if (coords && props.onMapPress) props.onMapPress([coords[0], coords[1]]);
  };

  // Any user gesture (pan/pinch/rotate) must release the follow-camera,
  // otherwise the easeTo loop re-centers every GPS tick and the map feels
  // stuck. Handle both possible event shapes defensively.
  const lastInteraction = useRef(0);
  const bearingRef = useRef(0);
  const viewStateRef = useRef<any>(null);
  // Window during which camera movement is OURS (easeTo/flyTo). Any region
  // change outside this window is, by definition, a user gesture — this makes
  // gesture detection reliable even if the event's userInteraction flag is
  // broken on some devices.
  const programmaticUntil = useRef(0);
  const markProgrammatic = (durationMs: number) => {
    programmaticUntil.current = Date.now() + durationMs + 400;
  };

  const handleRegionChange = (e: any) => {
    const ev = e?.nativeEvent ?? e;
    if (typeof ev?.bearing === 'number') bearingRef.current = ev.bearing;
    const isGesture = ev?.userInteraction || Date.now() > programmaticUntil.current;
    if (isGesture) {
      lastInteraction.current = Date.now();
      props.onMapInteraction?.();
    }
  };

  // Fires once per gesture end — keep the latest view state for the nav arrow.
  const handleRegionDidChange = (e: any) => {
    const ev = e?.nativeEvent ?? e;
    if (ev) viewStateRef.current = ev;
    if (typeof ev?.bearing === 'number') bearingRef.current = ev.bearing;
  };

  // Hardware-level interaction: the instant ANY finger touches the map, stop
  // the follow-camera. Passive observation — does not steal the gesture.
  const handleTouchStart = () => {
    lastInteraction.current = Date.now();
    if (props.isFollowing) props.onMapInteraction?.();
  };

  // Recenter must move the camera IMMEDIATELY — the follow effect alone can be
  // blocked by the interaction grace period (the tap itself counts as a touch).
  const handleRecenter = () => {
    lastInteraction.current = 0;
    if (props.userLocation && cameraRef.current) {
      markProgrammatic(800);
      cameraRef.current.easeTo({
        center: [props.userLocation.lng, props.userLocation.lat],
        zoom: props.isActiveNavigation ? 17.5 : 15,
        pitch: props.isActiveNavigation ? 55 : 0,
        bearing: props.isActiveNavigation ? props.heading || 0 : 0,
        duration: 800,
      });
    }
    props.onRecenter?.();
  };

  return (
    <View style={[StyleSheet.absoluteFill, props.style]} onTouchStart={handleTouchStart}>
      <MLMap
        style={StyleSheet.absoluteFill}
        mapStyle={styleUrl}
        onPress={handleMapPress}
        onDidFailLoadingMap={() => setStyleFailed(true)}
        // The camera cannot be driven until the style is up. This is the other
        // half of the first-fix race: if the location arrived before the map
        // finished loading, this is what finally applies it.
        onDidFinishLoadingMap={() => {
          mapReady.current = true;
          positionOnFirstFix();
        }}
        onRegionWillChange={handleRegionChange}
        onRegionIsChanging={handleRegionChange}
        onRegionDidChange={handleRegionDidChange}
        logo={false}
        attribution={false}
        compass={true}
        compassPosition={{ bottom: (props.controlsBottomOffset ?? 210) + 65, right: 22 }}
        androidView="texture"
      >
        <MLCamera ref={cameraRef} initialViewState={{ center: [loc.lng, loc.lat], zoom: initialZoom }} />

        {/* Alternative routes — muted gray beneath the main route.
            Keyed by style URL: swapping the map style (Carto -> Ola) rebuilds
            the style's layer stack, so custom sources must re-mount with it. */}
        {altGeos.map((geo, i) => (
          <MLGeoJSONSource key={`alt-${i}-${styleUrl}`} id={`alt-route-${i}`} data={geo}>
            <MLLayer
              id={`alt-route-line-${i}`}
              type="line"
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{ 'line-color': '#78909c', 'line-width': 6, 'line-opacity': 0.55 }}
            />
          </MLGeoJSONSource>
        ))}

        {/* Main route — casing + line (Google-style) */}
        {routeGeo ? (
          <MLGeoJSONSource key={`main-route-${styleUrl}`} id="main-route" data={routeGeo}>
            <MLLayer
              id="main-route-casing"
              type="line"
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{ 'line-color': '#0d47a1', 'line-width': 12, 'line-opacity': 0.5 }}
            />
            <MLLayer
              id="main-route-line"
              type="line"
              layout={{ 'line-join': 'round', 'line-cap': 'round' }}
              paint={{ 'line-color': '#4285F4', 'line-width': 7 }}
            />
          </MLGeoJSONSource>
        ) : null}

        {/* Live location — blue dot normally; while navigating, a map-aligned
            vehicle puck rendered as a symbol layer. icon-rotation-alignment:
            "map" means the GPU rotates it WITH the map — always correct
            relative to the road, exactly like Google/Uber, with no dependence
            on JS bearing events. */}
        {props.userLocation && !props.isActiveNavigation ? (
          <MLMarker id="user" lngLat={[props.userLocation.lng, props.userLocation.lat]} anchor="center">
            <View style={styles.userDotOuter}>
              <View style={styles.userDot} />
            </View>
          </MLMarker>
        ) : null}
        {props.userLocation && props.isActiveNavigation ? (
          <MLMarker id="user-nav" lngLat={[props.userLocation.lng, props.userLocation.lat]} anchor="center">
            {/* Arrow rotation = travel heading minus the camera bearing WE set
                (tracked in bearingRef by our own easeTo calls). While the
                camera follows the heading this is ~0 → arrow points up, exactly
                like Google navigation. */}
            <View
              style={[
                styles.navArrowWrap,
                { transform: [{ rotate: `${(props.heading || 0) - bearingRef.current}deg` }] },
              ]}
            >
              <View style={styles.navArrow} />
            </View>
          </MLMarker>
        ) : null}

        {/* Parking spots — memoized; only rebuild when content actually changes */}
        {spotMarkerElements}

        {/* Destination pin — memoized on coordinates */}
        {destMarkerElement}
      </MLMap>

      {/* Compass is the map's built-in native one (compass prop above):
          appears when rotated, hides facing north, tap resets — Google-style. */}

      {/* Recenter — Google-style: always visible; blue while following the
          user, grey once panned away. Tap to snap back to your location. */}
      {!props.hideControls ? (
        <TouchableOpacity
          style={[styles.recenterBtn, { bottom: props.controlsBottomOffset ?? 210 }]}
          onPress={handleRecenter}
          activeOpacity={0.8}
        >
          <Ionicons
            name={props.isFollowing ? 'locate' : 'locate-outline'}
            size={22}
            color={props.isFollowing ? '#1a73e8' : '#5f6368'}
          />
        </TouchableOpacity>
      ) : null}
    </View>
  );
});

MapLibreNative.displayName = 'MapLibreNative';

const styles = StyleSheet.create({
  userDotOuter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(26,115,232,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#1a73e8',
    borderWidth: 2.5,
    borderColor: '#fff',
  },
  spotPill: {
    backgroundColor: '#4285F4',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  spotPillUnavailable: {
    backgroundColor: '#9aa0a6',
  },
  spotPillActive: {
    backgroundColor: '#0d47a1',
    borderColor: '#FFD54F',
    transform: [{ scale: 1.15 }],
  },
  navArrowWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1a73e8',
    borderWidth: 3,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  navArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 18,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#fff',
    marginTop: -3,
  },
  compassBtn: {
    position: 'absolute',
    top: 130,
    right: 16,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  recenterBtn: {
    position: 'absolute',
    bottom: 210,
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  spotPillText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 12,
  },
  destPinWrap: {
    alignItems: 'center',
  },
  destPinHead: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#EA4335',
    borderWidth: 2.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 2,
  },
  destPinInner: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#fff',
  },
  destPinTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 13,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#EA4335',
    marginTop: -4,
    zIndex: 1,
  },
});

export default MapLibreNative;
