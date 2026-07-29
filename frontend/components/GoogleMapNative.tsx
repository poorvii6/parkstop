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
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import * as Location from 'expo-location';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, USER_MAP_ZOOM, HINT_MAP_ZOOM } from '../constants/mapDefaults';

const FOLLOW_EASE_MS = 1000;
const GESTURE_PRESS_GUARD_MS = 350;
const OFF_ROUTE_BASE_M = 50;
const OFF_ROUTE_CONFIRMATIONS = 2;

/** Night runs 7pm–6am, matching the old MapLibre day/night switch. */
const isNightHour = () => {
  const h = new Date().getHours();
  return h >= 19 || h < 6;
};

/** Google's official night-mode map style (maps platform styling reference). */
const GOOGLE_NIGHT_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#242f3e' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#242f3e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#746855' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#263c3f' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#6b9a76' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#38414e' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212a37' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#746855' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f2835' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#f3d19c' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2f3948' }] },
  { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17263c' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#515c6d' }] },
  { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: '#17263c' }] },
];

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

  // Current map rotation (deg), so the custom compass button can reflect it.
  const [mapHeading, setMapHeading] = useState(0);

  // Day/night theme like Google: light by day, night palette 7pm–6am.
  // Re-checked every 5 minutes so a session crossing 7pm flips live.
  const [night, setNight] = useState(isNightHour);
  useEffect(() => {
    const iv = setInterval(() => setNight(isNightHour()), 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // ── Imperative ref: the finder drives the whole map through animateCamera ──
  useImperativeHandle(ref, () => ({
    animateCamera: (cfg: any, opts?: any) => {
      const c = cfg?.center;
      if (!c || !mapRef.current) return;
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
  const didInitialPosition = useRef(false);
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
    if (lastInteraction.current > 0) { didInitialPosition.current = true; return; }
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
    const stop = setTimeout(() => clearInterval(iv), 15000);
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [trySnapToUser]);

  // ── Camera follow ─────────────────────────────────────────────
  useEffect(() => {
    if (!props.isFollowing || !props.userLocation || !mapRef.current) return;
    if (Date.now() - lastInteraction.current < 2000) return; // don't fight a fresh gesture
    markProgrammatic(FOLLOW_EASE_MS + 200);
    const center = { latitude: props.userLocation.lat, longitude: props.userLocation.lng };
    if (props.isActiveNavigation) {
      mapRef.current.animateCamera(
        { center, zoom: 17.5, pitch: 55, heading: props.heading || 0 },
        { duration: FOLLOW_EASE_MS }
      );
    } else {
      // Recenter but keep zoom EXPLICIT — a partial camera resets zoom to a
      // default on Android, which read as the map "slowly zooming out".
      mapRef.current.animateCamera({ center, zoom: currentZoom.current || USER_MAP_ZOOM }, { duration: FOLLOW_EASE_MS });
    }
  }, [props.userLocation, props.isFollowing, props.isActiveNavigation, props.heading]);

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
    if (u && mapRef.current) {
      markProgrammatic(800);
      mapRef.current.animateCamera(
        {
          center: { latitude: u.lat, longitude: u.lng },
          zoom: props.isActiveNavigation ? 17.5 : 15,
          pitch: props.isActiveNavigation ? 55 : 0,
          heading: props.isActiveNavigation ? props.heading || 0 : 0,
        },
        { duration: 800 }
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
  const altPolylines = useMemo(
    () =>
      (props.altRoutes || [])
        .filter((a) => (a.coords?.length || 0) >= 2)
        .map((a, i) => (
          <Polyline
            key={`alt-${i}`}
            coordinates={a.coords}
            strokeColor="#78909c"
            strokeWidth={6}
            zIndex={1}
            lineCap="round"
            lineJoin="round"
          />
        )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [(props.altRoutes || []).map((a) => `${a.coords?.length || 0}:${Math.round(a.duration || 0)}`).join('|')]
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
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        initialCamera={{
          center: { latitude: loc.lat, longitude: loc.lng },
          pitch: 0,
          heading: 0,
          zoom: initialZoom,
          altitude: 0,
        }}
        onMapReady={() => setMapReady(true)}
        customMapStyle={night ? GOOGLE_NIGHT_STYLE : []}
        onPress={handlePress}
        onPanDrag={handlePanDrag}
        onRegionChangeComplete={handleRegionChangeComplete}
        onRegionChange={readHeading}
        onUserLocationChange={handleUserLocationChange}
        // Push Google's native controls (My Location button, compass) below the
        // search bar and above the bottom sheet, and lift the Google logo clear.
        mapPadding={{ top: 100, right: 6, bottom: props.controlsBottomOffset ?? 210, left: 6 }}
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

        {/* Main route: dark casing under a bright line (Google style) */}
        {rc.length >= 2 ? (
          <>
            <Polyline coordinates={rc} strokeColor="#0d47a1" strokeWidth={12} zIndex={2} lineCap="round" lineJoin="round" />
            <Polyline coordinates={rc} strokeColor="#4285F4" strokeWidth={7} zIndex={3} lineCap="round" lineJoin="round" />
          </>
        ) : null}

        {/* During navigation, a directional arrow puck (flat markers rotate in
            the map frame, so rotation=heading points along the road like
            Google/Uber). Idle location is Google's own native blue dot. */}
        {props.userLocation && props.isActiveNavigation ? (
          <Marker
            key="user-nav"
            coordinate={{ latitude: props.userLocation.lat, longitude: props.userLocation.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={props.heading || 0}
            tracksViewChanges={track}
            zIndex={10}
          >
            <View style={styles.navArrowWrap}>
              <View style={styles.navArrow} />
            </View>
          </Marker>
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
          {/* Compass — rotates with the map; tap to snap back to north */}
          <TouchableOpacity
            style={[styles.mapCtrlBtn, { bottom: (props.controlsBottomOffset ?? 210) + 168 }]}
            onPress={() => { markProgrammatic(500); mapRef.current?.animateCamera({ heading: 0 }, { duration: 350 }); setMapHeading(0); }}
            activeOpacity={0.85}
          >
            <View style={[styles.compassNeedle, { transform: [{ rotate: `${-mapHeading}deg` }] }]}>
              <View style={styles.compassN} />
              <View style={styles.compassS} />
              {Math.abs(mapHeading) > 1 ? <Text style={styles.compassNLabel}>N</Text> : null}
            </View>
          </TouchableOpacity>

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
  navArrowWrap: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1a73e8', borderWidth: 3, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  navArrow: { width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderBottomWidth: 18, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#fff', marginTop: -3 },
  recenterBtn: { position: 'absolute', right: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 6 },
  mapCtrlBtn: { position: 'absolute', right: 16, width: 46, height: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
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
