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

// The native module is present in the dev build; access its v11 named exports.
const MLGL: any = require('@maplibre/maplibre-react-native');
const MLMap = MLGL.Map;
const MLCamera = MLGL.Camera;
const MLMarker = MLGL.Marker;
const MLGeoJSONSource = MLGL.GeoJSONSource;
const MLLayer = MLGL.Layer;
const MLImages = MLGL.Images;

const CARTO_DAY = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const CARTO_NIGHT = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

type Props = {
  userLocation?: { lat: number; lng: number };
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
  hideControls?: boolean;
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

  const loc = props.userLocation || { lat: 12.9716, lng: 77.5946 };
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
    markProgrammatic(700);
    if (props.isActiveNavigation) {
      cameraRef.current.easeTo({
        center: [props.userLocation.lng, props.userLocation.lat],
        zoom: 17.5,
        pitch: 55,
        bearing: props.heading || 0,
        duration: 700,
      });
    } else {
      // Outside navigation only re-center — never force zoom/pitch/bearing,
      // so the user's pinch-zoom level is respected while following.
      cameraRef.current.easeTo({
        center: [props.userLocation.lng, props.userLocation.lat],
        duration: 700,
      });
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
  const altGeos = React.useMemo(
    () => (propsRef.current.altRoutes || []).filter((a) => a.coords?.length >= 2).map((a) => lineFeature(a.coords)),
    [altSig]
  );

  const spotMarkerElements = React.useMemo(() => {
    const d = propsRef.current.searchedPlace || propsRef.current.destination;
    return (propsRef.current.markers || []).map((m) => {
      const isActive = !!d && Math.abs(d.lat - m.lat) < 0.001 && Math.abs(d.lng - m.lng) < 0.001;
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
          <View style={styles.destPin}>
            <View style={styles.destPinInner} />
          </View>
        </MLMarker>
      ) : null,
    [destKey]
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  const handleMapPress = (e: any) => {
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
        onRegionWillChange={handleRegionChange}
        onRegionIsChanging={handleRegionChange}
        onRegionDidChange={handleRegionDidChange}
        logo={false}
        attribution={false}
        compass={true}
        compassPosition={{ bottom: 275, right: 22 }}
        androidView="texture"
      >
        <MLCamera ref={cameraRef} initialViewState={{ center: [loc.lng, loc.lat], zoom: 14 }} />

        {/* Alternative routes — muted gray beneath the main route */}
        {altGeos.map((geo, i) => (
          <MLGeoJSONSource key={`alt-${i}`} id={`alt-route-${i}`} data={geo}>
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
          <MLGeoJSONSource id="main-route" data={routeGeo}>
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
          <>
            <MLImages images={{ navpuck: require('../assets/images/car_marker_small.png') }} />
            <MLGeoJSONSource
              id="user-nav"
              data={{
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: [props.userLocation.lng, props.userLocation.lat] },
              }}
            >
              <MLLayer
                id="user-nav-icon"
                type="symbol"
                layout={{
                  'icon-image': 'navpuck',
                  'icon-rotate': props.heading || 0,
                  'icon-rotation-alignment': 'map',
                  'icon-allow-overlap': true,
                  'icon-ignore-placement': true,
                  'icon-size': 0.7,
                }}
              />
            </MLGeoJSONSource>
          </>
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
        <TouchableOpacity style={styles.recenterBtn} onPress={handleRecenter} activeOpacity={0.8}>
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
  destPin: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#EA4335',
    borderWidth: 3,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  destPinInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
  },
});

export default MapLibreNative;
