/**
 * MapLibreView.web.tsx
 *
 * Open-source map using MapLibre GL JS + OpenStreetMap/OpenFreeMap tiles.
 * Feature-identical to the native version (MapLibreView.native.tsx).
 *
 * Features:
 *  - Auto day/night theme (light 6am-6pm, dark 6pm-6am)
 *  - Google Maps-style navigation: 60° pitch, heading lock, smooth follow
 *  - Map type toggle (Standard / Satellite). Tap same type = cancel → Standard
 *  - No hardcoded coordinates — only renders when parent provides userLocation
 *  - Camera only moves when isFollowing=true; user pan stops following
 *  - Voice instructions via browser SpeechSynthesis
 *  - Scalable: add more tile providers by extending MAP_STYLES
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Text, TouchableOpacity } from 'react-native';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapProps } from './MapLibreView.native';

// ─── Open-Source Tile Sources ──────────────────────────────────────────────
// openfreemap.org: completely free, no API key, OSM data
const TILE_STYLES = {
  DAY:   'https://tiles.openfreemap.org/styles/bright',
  NIGHT: 'https://tiles.openfreemap.org/styles/dark',
  SATELLITE: {
    version: 8 as const,
    sources: {
      satellite: {
        type: 'raster' as const,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: '© Esri, © OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'satellite-layer', type: 'raster' as const, source: 'satellite', paint: {} }],
  },
};

type MapTypeKey = 'STANDARD' | 'SATELLITE';

const speak = (text: string) => {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.9;
  window.speechSynthesis.speak(utter);
};

// ─── Component ────────────────────────────────────────────────────────────
const MapLibreView = React.forwardRef<any, MapProps>((props, ref) => {
  const {
    userLocation,
    markers = [],
    routeCoords = [],
    destination,
    searchedPlace,
    distanceInfo,
    nextInstruction = '',
    speed = 0,
    heading = 0,
    isActiveNavigation = false,
    isFollowing = true,
    isMuted = false,
    style,
    onMapPress,
    onMapInteraction,
    onMuteToggle,
    onMarkerPress,
    onRecenter,
    hideControls,
    onExit,
  } = props;

  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destMarkerRef = useRef<maplibregl.Marker | null>(null);
  const spotMarkersRef = useRef<Record<string, maplibregl.Marker>>({});
  const lastInstruction = useRef('');
  const lastCameraUpdate = useRef(0);
  const isGesturing = useRef(false);

  // Auto day/night
  const hour = new Date().getHours();
  const isNight = hour >= 18 || hour < 6;
  const defaultStyle = isNight ? TILE_STYLES.NIGHT : TILE_STYLES.DAY;

  const [mapType, setMapType] = useState<MapTypeKey>('STANDARD');
  const [showTools, setShowTools] = useState(false);
  const [styleLoaded, setStyleLoaded] = useState(false);

  const currentStyle = mapType === 'SATELLITE' ? TILE_STYLES.SATELLITE : defaultStyle;

  // ─── Expose animateCamera API (same interface as native) ───
  React.useImperativeHandle(ref, () => ({
    animateCamera: (config: {
      center?: { latitude: number; longitude: number };
      heading?: number;
      pitch?: number;
      zoom?: number;
    }, options?: { duration?: number }) => {
      if (!map.current || !userLocation) return;
      const now = Date.now();
      if (now - lastCameraUpdate.current < 500) return; // debounce
      lastCameraUpdate.current = now;

      map.current.flyTo({
        center: config.center
          ? [config.center.longitude, config.center.latitude]
          : [userLocation.lng, userLocation.lat],
        bearing: config.heading ?? 0,
        pitch: config.pitch ?? 0,
        zoom: config.zoom ?? map.current.getZoom(),
        duration: options?.duration ?? 800,
        essential: true,
      });
    },
  }));

  // ─── Initialize Map ───────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || !userLocation || map.current) return;

    const m = new maplibregl.Map({
      container: mapContainer.current,
      style: currentStyle as any,
      center: [userLocation.lng, userLocation.lat],
      zoom: 15,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      fadeDuration: 0,
    });

    map.current = m;

    m.on('load', () => setStyleLoaded(true));

    // Detect user-initiated panning → stop following
    m.on('dragstart', () => {
      isGesturing.current = true;
      onMapInteraction?.();
    });
    m.on('dragend', () => { isGesturing.current = false; });

    m.on('click', (e) => {
      onMapPress?.([e.lngLat.lng, e.lngLat.lat]);
    });

    const resizeObserver = new ResizeObserver(() => {
      m.resize();
    });
    resizeObserver.observe(mapContainer.current);

    return () => {
      resizeObserver.disconnect();
      setStyleLoaded(false);
      m.remove();
      map.current = null;
      userMarkerRef.current = null;
      destMarkerRef.current = null;
      spotMarkersRef.current = {};
    };
  }, [!!userLocation]); // Initialize as soon as location is available

  // ─── Update Map Style on Toggle ───────────────────────────────────────
  useEffect(() => {
    if (!map.current || !styleLoaded) return;
    map.current.setStyle(currentStyle as any);
  }, [mapType, isNight]);

  // ─── Navigation Camera Follow ─────────────────────────────────────────
  // Only fires when isFollowing=true, debounced to prevent jitter
  useEffect(() => {
    if (!map.current || !userLocation || !isFollowing || isGesturing.current) return;

    const now = Date.now();
    if (now - lastCameraUpdate.current < 800) return;
    lastCameraUpdate.current = now;

    const isTravelling = speed > 1.5;

    map.current.flyTo({
      center: [userLocation.lng, userLocation.lat],
      zoom: isActiveNavigation ? 17 : 15,
      pitch: isActiveNavigation && isTravelling ? 60 : 0,
      bearing: isActiveNavigation && isTravelling ? heading : 0,
      duration: 900,
      essential: true,
    });
  }, [userLocation, isFollowing, isActiveNavigation, speed, heading]);

  // ─── Voice Instructions ────────────────────────────────────────────────
  useEffect(() => {
    if (!isMuted && isActiveNavigation && nextInstruction && nextInstruction !== lastInstruction.current) {
      lastInstruction.current = nextInstruction;
      speak(nextInstruction);
    }
  }, [nextInstruction, isMuted, isActiveNavigation]);

  // ─── User Location Marker (Google Maps Style) ──────────────────────────
  const userElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!map.current || !userLocation) return;
    if (!userMarkerRef.current) {
      const el = document.createElement('div');
      userElRef.current = el;
      el.innerHTML = `
        <div style="position:relative;width:28px;height:28px;">
          <div style="position:absolute;inset:0;background:rgba(99,102,241,0.2);border-radius:50%;animation:pulse 2s infinite;"></div>
          <div style="position:absolute;top:4px;left:4px;width:20px;height:20px;background:#4285F4;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>
        </div>
        <style>@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.8);opacity:0}}</style>
      `;
      userMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([userLocation.lng, userLocation.lat])
        .addTo(map.current);
    } else {
      userMarkerRef.current.setLngLat([userLocation.lng, userLocation.lat]);
    }
    // Switch style based on navigation state
    if (userElRef.current) {
      if (isActiveNavigation && speed > 1.5) {
        userElRef.current.innerHTML = `
          <div style="width:0;height:0;border-left:12px solid transparent;border-right:12px solid transparent;border-bottom:28px solid #4285F4;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));transform:rotate(${heading}deg);transform-origin:50% 70%;transition:transform 0.5s ease;"></div>
        `;
      } else {
        userElRef.current.innerHTML = `
          <div style="position:relative;width:28px;height:28px;">
            <div style="position:absolute;inset:0;background:rgba(66,133,244,0.2);border-radius:50%;animation:pulse 2s infinite;"></div>
            <div style="position:absolute;top:4px;left:4px;width:20px;height:20px;background:#4285F4;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>
          </div>
          <style>@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.8);opacity:0}}</style>
        `;
      }
    }
  }, [userLocation, isActiveNavigation, speed, heading]);

  // ─── Destination Marker (only during active navigation) ────────────────
  useEffect(() => {
    if (!map.current) return;
    destMarkerRef.current?.remove();
    destMarkerRef.current = null;

    // Only show destination pin when actively navigating to a spot with valid coordinates
    if (!isActiveNavigation || !destination || 
        typeof destination.lat !== 'number' || 
        typeof destination.lng !== 'number' || 
        isNaN(destination.lat) || 
        isNaN(destination.lng) || 
        (destination.lat === 0 && destination.lng === 0)) {
      return;
    }

    const el = document.createElement('div');
    el.innerHTML = `
      <div style="position:relative;animation:dropIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);">
        <svg width="40" height="56" viewBox="0 0 40 56" xmlns="http://www.w3.org/2000/svg">
          <defs><filter id="dshadow" x="-20%" y="-10%" width="140%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.35"/></filter></defs>
          <path d="M20 0C8.95 0 0 8.95 0 20c0 14 20 36 20 36s20-22 20-36C40 8.95 31.05 0 20 0z" fill="#EA4335" filter="url(#dshadow)"/>
          <circle cx="20" cy="19" r="12" fill="#fff"/>
          <text x="20" y="24" text-anchor="middle" font-size="16" font-weight="900" fill="#EA4335" font-family="Arial, sans-serif">P</text>
        </svg>
        <div style="position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);width:16px;height:6px;background:rgba(0,0,0,0.2);border-radius:50%;filter:blur(2px);"></div>
      </div>
      <style>@keyframes dropIn{0%{transform:translateY(-60px) scale(0);opacity:0}100%{transform:translateY(0) scale(1);opacity:1}}</style>
    `;
    destMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([destination.lng, destination.lat])
      .addTo(map.current);
  }, [isActiveNavigation, destination]);

  // ─── Parking Spot Markers ──────────────────────────────────────────────
  useEffect(() => {
    if (!map.current) return;
    Object.values(spotMarkersRef.current).forEach(m => m.remove());
    spotMarkersRef.current = {};

    markers.forEach(marker => {
      const el = document.createElement('div');
      const bg = marker.available ? '#4f46e5' : '#ef4444';
      el.innerHTML = `<div style="background:${bg};color:#fff;font-weight:800;font-size:12px;padding:5px 10px;border-radius:14px;border:2px solid #fff;cursor:pointer;box-shadow:0 3px 8px rgba(0,0,0,0.3);">₹${marker.price}</div>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onMarkerPress?.(marker.id);
      });

      const m = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([marker.lng, marker.lat])
        .addTo(map.current!);

      spotMarkersRef.current[marker.id] = m;
    });
  }, [markers]);

  // ─── Route Polyline ────────────────────────────────────────────────────
  useEffect(() => {
    if (!map.current || !styleLoaded) return;

    const routeData: GeoJSON.Feature = {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: routeCoords.map(c => [c.longitude, c.latitude]),
      },
      properties: {},
    };

    const src = map.current.getSource('route') as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(routeData);
    } else if (routeCoords.length > 1) {
      map.current.addSource('route', { type: 'geojson', data: routeData });
      // Shadow for depth
      map.current.addLayer({
        id: 'route-shadow',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#000', 'line-width': 10, 'line-opacity': 0.15 },
      });
      // Main route
      map.current.addLayer({
        id: 'route-layer',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#4f46e5', 'line-width': 6 },
      });
    }
  }, [routeCoords, styleLoaded]);

  // ─── Map Type Toggle (tap same = cancel) ──────────────────────────────
  const handleMapType = useCallback((type: MapTypeKey) => {
    setMapType(prev => prev === type ? 'STANDARD' : type);
    setShowTools(false);
  }, []);

  const speedMph = speed * 2.23694;
  const showSpeed = speedMph > 3.3 && isActiveNavigation;

  if (!userLocation) return null;

  return (
    <View style={[styles.container, style]}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />

      {!hideControls && (
        <View style={styles.controlStack}>
          {/* Satellite Toggle */}
          <TouchableOpacity style={styles.mapBtn} onPress={() => handleMapType('SATELLITE')}>
            <Text style={{ fontSize: 20 }}>{mapType === 'SATELLITE' ? '🗺️' : '🛰️'}</Text>
          </TouchableOpacity>

          {/* Recenter */}
          <TouchableOpacity style={[styles.mapBtn, styles.recenterBtn]} onPress={onRecenter}>
            <Text style={{ fontSize: 20 }}>🎯</Text>
          </TouchableOpacity>

          {/* Mute Toggle */}
          {isActiveNavigation && (
            <>
              <TouchableOpacity style={styles.mapBtn} onPress={onMuteToggle}>
                <Text style={{ fontSize: 20 }}>{isMuted ? '🔊' : '🔇'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.mapBtn, { backgroundColor: '#ef4444', borderColor: 'rgba(255,255,255,0.3)' }]} onPress={onExit}>
                <Text style={{ fontSize: 20, color: '#fff', fontWeight: 'bold' }}>✕</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* Speedometer — Top Right during navigation */}
      {showSpeed && !hideControls && (
        <View style={styles.speedometer}>
          <Text style={styles.speedValue}>{Math.round(speedMph)}</Text>
          <Text style={styles.speedUnit}>mph</Text>
        </View>
      )}
    </View>
  );
});

export default MapLibreView;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },

  controlStack: {
    position: 'absolute',
    bottom: 24,
    right: 16,
    gap: 10,
    zIndex: 999,
  },
  mapBtn: {
    width: 48, height: 48,
    backgroundColor: '#1e293b',
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  recenterBtn: {
    backgroundColor: '#4285F4',
    borderColor: 'rgba(255,255,255,0.3)',
  },

  speedometer: {
    position: 'absolute', top: 80, right: 16,
    width: 56, height: 56,
    backgroundColor: '#1e293b',
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#6366f1',
    zIndex: 1000,
  },
  speedValue: { color: '#fff', fontSize: 16, fontWeight: '900', lineHeight: 18 },
  speedUnit: { color: 'rgba(255,255,255,0.55)', fontSize: 9, fontWeight: '700' },
});
