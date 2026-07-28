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
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, USER_MAP_ZOOM, HINT_MAP_ZOOM } from '../constants/mapDefaults';

const FOLLOW_EASE_MS = 1000;
const GESTURE_PRESS_GUARD_MS = 350;
const OFF_ROUTE_BASE_M = 50;
const OFF_ROUTE_CONFIRMATIONS = 2;

type LatLng = { latitude: number; longitude: number };

type Props = {
  userLocation?: { lat: number; lng: number };
  viewportHint?: { lat: number; lng: number } | null;
  markers?: Array<{ id: string; lat: number; lng: number; price: number; available: boolean; title?: string }>;
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
  const markProgrammatic = (durationMs: number) => {
    programmaticUntil.current = Date.now() + durationMs + 400;
  };

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
  useEffect(() => {
    if (didInitialPosition.current) return;
    if (!props.userLocation || !mapRef.current) return;
    if (props.destination || props.searchedPlace) {
      didInitialPosition.current = true;
      return;
    }
    didInitialPosition.current = true;
    markProgrammatic(500);
    mapRef.current.animateCamera(
      { center: { latitude: props.userLocation.lat, longitude: props.userLocation.lng }, zoom: USER_MAP_ZOOM, pitch: 0, heading: 0 },
      { duration: 0 }
    );
  }, [props.userLocation, props.destination, props.searchedPlace]);

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
      // Partial camera update: only recenter, leaving the user's zoom/pitch.
      mapRef.current.animateCamera({ center }, { duration: FOLLOW_EASE_MS });
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
  const markerSig = (props.markers || []).map((m) => `${m.id}:${m.price}:${m.available ? 1 : 0}`).join('|');
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
        return (
          <Marker
            key={m.id}
            identifier={String(m.id)}
            coordinate={{ latitude: m.lat, longitude: m.lng }}
            anchor={{ x: 0.5, y: 1 }}
            tracksViewChanges={track}
            onPress={() => propsRef.current.onMarkerPress?.(m.id)}
          >
            <View style={[styles.spotPill, !m.available && styles.spotPillUnavailable]}>
              <Text style={styles.spotPillText}>🅿️ ₹{m.price}</Text>
            </View>
          </Marker>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markerSig, destKey, track]
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
        onPress={handlePress}
        onPanDrag={handlePanDrag}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass
        toolbarEnabled={false}
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

        {/* Live location — blue dot idle; heading arrow while navigating.
            `flat` markers rotate in the map frame, so rotation=heading always
            points along the road, exactly like Google/Uber navigation. */}
        {props.userLocation ? (
          props.isActiveNavigation ? (
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
          ) : (
            <Marker
              key="user-idle"
              coordinate={{ latitude: props.userLocation.lat, longitude: props.userLocation.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={track}
              zIndex={10}
            >
              <View style={styles.userDotOuter}><View style={styles.userDot} /></View>
            </Marker>
          )
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

      {/* Recenter — blue while following, grey once panned away */}
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

GoogleMapNative.displayName = 'GoogleMapNative';

const styles = StyleSheet.create({
  userDotOuter: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(26,115,232,0.25)', alignItems: 'center', justifyContent: 'center' },
  userDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#1a73e8', borderWidth: 2.5, borderColor: '#fff' },
  spotPill: { backgroundColor: '#4285F4', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)' },
  spotPillUnavailable: { backgroundColor: '#9aa0a6' },
  spotPillText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  navArrowWrap: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#1a73e8', borderWidth: 3, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 6 },
  navArrow: { width: 0, height: 0, borderLeftWidth: 9, borderRightWidth: 9, borderBottomWidth: 18, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#fff', marginTop: -3 },
  recenterBtn: { position: 'absolute', right: 16, width: 48, height: 48, borderRadius: 24, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 6 },
  destPinWrap: { alignItems: 'center' },
  destPinHead: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#EA4335', borderWidth: 2.5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 5, zIndex: 2 },
  destPinInner: { width: 9, height: 9, borderRadius: 4.5, backgroundColor: '#fff' },
  destPinTail: { width: 0, height: 0, borderLeftWidth: 7, borderRightWidth: 7, borderTopWidth: 13, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#EA4335', marginTop: -4, zIndex: 1 },
});

export default GoogleMapNative;
