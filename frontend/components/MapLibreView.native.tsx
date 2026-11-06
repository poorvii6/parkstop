/**
 * MapLibreView.native.tsx — thin wrapper over the Google basemap
 *
 * Despite the name, this renders GoogleMapNative (react-native-maps,
 * PROVIDER_GOOGLE). It is kept as the import site so the ~30 call sites that
 * say `<MapLibreView>` don't all have to change.
 *
 * The MapLibre GL implementation that used to live here was deleted on
 * 6 Nov 2026. It had been unreachable since e066029 put an unconditional
 * `return <GoogleMapNative .../>` above it, and it could not be switched back
 * on as written: MapLibre v11 renamed every component it called
 * (MapView -> Map, MarkerView -> Marker, ShapeSource -> GeoJSONSource,
 * LineLayer -> Layer). Reviving native MapLibre means writing against the v11
 * API, not restoring that code. It is in git history if you want to read it.
 *
 * As of 6 Nov 2026 this file does not import @maplibre/maplibre-react-native
 * at all. Nothing in the app does. (That is the native package — `maplibre-gl`
 * is a different dependency and MapLibreView.web.tsx still needs it.)
 *
 * Note the licensing constraint before adding any non-Google basemap back:
 * Google Maps Platform Terms 3.2.3(e) forbid showing Google Maps Content —
 * which includes Routes API results — over a non-Google basemap.
 */

import React from 'react';
import { View, StyleSheet, Text } from 'react-native';
import GoogleMapNative from './GoogleMapNative';

// Sanity-probe react-native-maps, the library that actually draws every map in
// this app (through GoogleMapNative). Until 6 Nov 2026 this probed
// @maplibre/maplibre-react-native, which had not rendered anything for months.
//
// WHAT THIS GATE CANNOT DO, so nobody mistakes it for a safety net: this file
// imports GoogleMapNative statically, and GoogleMapNative imports
// react-native-maps statically. Both are evaluated when this module is first
// required — before the probe below runs, and long before anything renders. If
// react-native-maps were missing, or its native module failed to link, that
// import would already have thrown and taken the screen (or the app) with it.
// We would never reach the branch that shows our message. A gate placed after a
// static import cannot rescue a broken library.
//
// WHAT IT ACTUALLY CATCHES is narrower: the module loads, but does not export
// what GoogleMapNative destructures from it — a major-version rename, a dropped
// PROVIDER_GOOGLE, a half-written install. Unguarded, that surfaces as
// "type is invalid" from deep inside render. Guarded, the user gets a sentence
// they can act on. That is the whole of the benefit. It costs one cached
// require, so it stays.
//
// The four checks mirror GoogleMapNative.tsx:21 exactly. Verified against
// react-native-maps 1.20.1: MapView is the DEFAULT export (there is no named
// MapView), Marker and Polyline are named, PROVIDER_GOOGLE is the string
// 'google'. Do not probe PROVIDER_DEFAULT — it is exported as `undefined`.
// If you change what GoogleMapNative imports, change this list to match.
let MAPS_AVAILABLE = false;
try {
  const Maps: any = require('react-native-maps');
  // Accept a default or named MapView: which one Metro hands back depends on
  // interop, and wrongly blacking out a working map is a worse failure than
  // letting a broken one reach render.
  const MapViewExport = Maps?.default ?? Maps?.MapView;
  MAPS_AVAILABLE = !!MapViewExport && !!Maps?.Marker && !!Maps?.Polyline && !!Maps?.PROVIDER_GOOGLE;
} catch (e) {
  // Practically unreachable: the static import above resolves the same module
  // first, so a throw here would have happened there. Belt and braces.
  MAPS_AVAILABLE = false;
  console.warn('[map] react-native-maps did not load:', (e as any)?.message);
}

export interface MapProps {
  userLocation?: { lat: number; lng: number };
  /**
   * Remembered position from a previous session, used ONLY to pick the opening
   * viewport so a cold start doesn't render the whole country. Never drives the
   * blue dot or any distance/booking logic — see services/lastLocation.ts.
   */
  viewportHint?: { lat: number; lng: number } | null;
  markers?: Array<{ id: string; lat: number; lng: number; price: number; available: boolean; title?: string }>;
  routeCoords?: Array<{ latitude: number; longitude: number }>;
  altRoutes?: Array<{ coords: Array<{ latitude: number; longitude: number }>; duration: number; distance: number }>;
  searchedPlace?: { lat: number; lng: number; title: string } | null;
  destination?: { lat: number; lng: number } | null;
  isActiveNavigation?: boolean;
  heading?: number;
  speed?: number;
  isFollowing?: boolean;
  onMapPress?: (coords: [number, number]) => void;
  onMapInteraction?: () => void;
  onRecenter?: () => void;
  onMarkerPress?: (id: string) => void;
  onOffRoute?: (lat: number, lng: number) => void;
  /** Reported GPS uncertainty in metres — widens the off-route threshold. */
  locationAccuracy?: number;
  onSelectAltRoute?: (index: number) => void;
  distanceInfo?: any;
  nextInstruction?: string;
  isMuted?: boolean;
  onMuteToggle?: () => void;
  style?: any;
  hideControls?: boolean;
  onExit?: () => void;
  trafficSegments?: Array<{ coords: Array<[number, number]>; congestion: 'low' | 'moderate' | 'heavy' | 'severe' }>;
  speedLimit?: number | null;
  mapStyleUrl?: string;
  mapApiKey?: string;
  /** Bottom offset for recenter/compass so they ride above visible panels. */
  controlsBottomOffset?: number;
  /** Floating mini-map (picture-in-picture) while navigating: tiny window, no controls. */
  compact?: boolean;
}

// ── Main Component ───────────────────────────────────────────────
// NOTE: deliberately NOT annotated `React.FC<MapProps>`. React.FC has no `ref`
// in its props, so that annotation erased the forwardRef typing and made every
// `<MapLibreView ref={...}>` call site a type error — on a component whose ref
// (animateCamera) is how the whole map is driven. Let forwardRef infer it.
const MapLibreView = React.forwardRef((props: MapProps, ref: any) => {
  // react-native-maps loaded but isn't the shape GoogleMapNative needs, so show
  // a plain message. See the probe above for what this can and cannot catch.
  // There is deliberately no Carto/Ola WebView fallback: the WebViewFallback
  // component that provided one was deleted on 6 Nov 2026.
  //
  // LICENSING, not preference: Google Maps Platform Terms 3.2.3(e) ("No Use
  // With Non-Google Maps") prohibits displaying Google Maps Content — which
  // includes Routes/Directions results — on a non-Google basemap. That
  // fallback rendered Carto tiles while still receiving routeCoords derived
  // from the Google Routes API, which is exactly that. Nothing referenced it
  // by the end, but it shipped in the APK. Do not reintroduce one.
  if (!MAPS_AVAILABLE) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.mapUnavailable, props.style]}>
        <Text style={styles.mapUnavailableTitle}>Map unavailable</Text>
        <Text style={styles.mapUnavailableBody}>
          The map couldn&apos;t start on this device. Please restart the app, or
          reinstall if it keeps happening.
        </Text>
      </View>
    );
  }

  // Map surface — Google (react-native-maps) basemap.
  return <GoogleMapNative {...props} ref={ref} />;
});

const styles = StyleSheet.create({
  mapUnavailable: {
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  mapUnavailableTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 8,
  },
  mapUnavailableBody: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
});

export default MapLibreView;
