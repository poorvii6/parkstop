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
import { StyleSheet, View, Text } from 'react-native';

// The native module is present in the dev build; access its v11 named exports.
const MLGL: any = require('@maplibre/maplibre-react-native');
const MLMap = MLGL.Map;
const MLCamera = MLGL.Camera;
const MLMarker = MLGL.Marker;

const CARTO_DAY = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const CARTO_NIGHT = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

type Props = {
  userLocation?: { lat: number; lng: number };
  markers?: Array<{ id: string; lat: number; lng: number; price: number; available: boolean; title?: string }>;
  searchedPlace?: { lat: number; lng: number; title: string } | null;
  destination?: { lat: number; lng: number } | null;
  mapStyleUrl?: string;
  mapApiKey?: string;
  onMapPress?: (coords: [number, number]) => void;
  onMarkerPress?: (id: string) => void;
  style?: any;
};

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

  const handleMapPress = (e: any) => {
    const coords = e?.geometry?.coordinates || e?.nativeEvent?.geometry?.coordinates;
    if (coords && props.onMapPress) props.onMapPress([coords[0], coords[1]]);
  };

  return (
    <View style={[StyleSheet.absoluteFill, props.style]}>
      <MLMap
        style={StyleSheet.absoluteFill}
        mapStyle={styleUrl}
        onPress={handleMapPress}
        onDidFailLoadingMap={() => setStyleFailed(true)}
        logo={false}
        attribution={false}
      >
        <MLCamera ref={cameraRef} initialViewState={{ center: [loc.lng, loc.lat], zoom: 14 }} />

        {/* Live location — blue dot */}
        {props.userLocation ? (
          <MLMarker id="user" lngLat={[props.userLocation.lng, props.userLocation.lat]} anchor="center">
            <View style={styles.userDotOuter}>
              <View style={styles.userDot} />
            </View>
          </MLMarker>
        ) : null}

        {/* Parking spots — compact professional pills */}
        {(props.markers || []).map((m) => (
          <MLMarker
            key={m.id}
            id={String(m.id)}
            lngLat={[m.lng, m.lat]}
            anchor="bottom"
            onPress={() => props.onMarkerPress?.(m.id)}
          >
            <View style={[styles.spotPill, !m.available && styles.spotPillUnavailable]}>
              <Text style={styles.spotPillText}>₹{m.price}</Text>
            </View>
          </MLMarker>
        ))}

        {/* Destination pin */}
        {dest ? (
          <MLMarker id="destination" lngLat={[dest.lng, dest.lat]} anchor="bottom">
            <View style={styles.destPin}>
              <View style={styles.destPinInner} />
            </View>
          </MLMarker>
        ) : null}
      </MLMap>
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
