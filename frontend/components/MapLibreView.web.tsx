/**
 * MapLibreView.web.tsx
 *
 * Open-source map using MapLibre GL JS + OpenFreeMap tiles.
 * Feature-identical to MapLibreView.native.tsx:
 *  - Snap-to-route with off-route detection (60m threshold, 10s cooldown)
 *  - Traveled route visualization (gray) + remaining route (blue)
 *  - ETA overlay on map with arrival time
 *  - Destination pin for searched places AND active navigation
 *  - Auto day/night theme, satellite toggle, mute toggle
 *  - Efficient spot marker diffing (no full recreation)
 *  - Speed in km/h (India market)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Text, TouchableOpacity } from 'react-native';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapProps } from './MapLibreView.native';

const TILE_STYLES = {
  DAY: 'https://tiles.openfreemap.org/styles/bright',
  NIGHT: 'https://tiles.openfreemap.org/styles/dark',
  SATELLITE: {
    version: 8 as const,
    sources: {
      satellite: {
        type: 'raster' as const,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Esri',
      },
    },
    layers: [{ id: 'satellite-layer', type: 'raster' as const, source: 'satellite', paint: {} }],
  },
};

type MapTypeKey = 'STANDARD' | 'SATELLITE';

function speakText(text: string) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

function snapToRoute(pos: number[], route: number[][]): { point: number[]; index: number } {
  if (!route || route.length < 2) return { point: pos, index: 0 };
  let best = pos, bestD = Infinity, bestI = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((pos[0] - a[0]) * dx + (pos[1] - a[1]) * dy) / len)) : 0;
    const p = [a[0] + t * dx, a[1] + t * dy];
    const d = (pos[0] - p[0]) ** 2 + (pos[1] - p[1]) ** 2;
    if (d < bestD) { bestD = d; best = p; bestI = i; }
  }
  return { point: best, index: bestI };
}

function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

const MapLibreView = React.forwardRef<any, MapProps>((props, ref) => {
  const {
    userLocation, markers = [], routeCoords = [], destination,
    searchedPlace, distanceInfo, nextInstruction = '',
    speed = 0, heading = 0, isActiveNavigation = false,
    isFollowing = true, isMuted = false, style,
    onMapPress, onMapInteraction, onMuteToggle,
    onMarkerPress, onRecenter, onOffRoute, onSelectAltRoute,
    hideControls, onExit, altRoutes = [],
  } = props;

  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const arrowMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destMarkerRef = useRef<maplibregl.Marker | null>(null);
  const spotMarkersRef = useRef<Record<string, maplibregl.Marker>>({});
  const lastInstructionRef = useRef('');
  const isGesturing = useRef(false);
  const bearRef = useRef(0);
  const lastRerouteRef = useRef(0);
  const arrowVisRef = useRef(false);
  const [mapBearing, setMapBearing] = useState(0);
  const userElRef = useRef<HTMLDivElement | null>(null);
  const etaElRef = useRef<HTMLDivElement | null>(null);

  const hour = new Date().getHours();
  const isNight = hour >= 18 || hour < 6;
  const defaultStyle = isNight ? TILE_STYLES.NIGHT : TILE_STYLES.DAY;
  const [mapType, setMapType] = useState<MapTypeKey>('STANDARD');
  const [styleLoaded, setStyleLoaded] = useState(false);
  const currentStyle = mapType === 'SATELLITE' ? TILE_STYLES.SATELLITE : defaultStyle;

  React.useImperativeHandle(ref, () => ({
    animateCamera: (config: any, options?: any) => {
      if (!mapRef.current || !userLocation) return;
      mapRef.current.flyTo({
        center: config.center ? [config.center.longitude, config.center.latitude] : [userLocation.lng, userLocation.lat],
        bearing: config.heading ?? 0, pitch: config.pitch ?? 0,
        zoom: config.zoom ?? mapRef.current.getZoom(),
        duration: options?.duration ?? 800, essential: true,
      });
    },
  }));

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || !userLocation || mapRef.current) return;
    const m = new maplibregl.Map({
      container: mapContainer.current, style: currentStyle as any,
      center: [userLocation.lng, userLocation.lat], zoom: 16,
      pitch: 0, bearing: 0, attributionControl: false, fadeDuration: 0,
    });
    mapRef.current = m;

    m.on('load', () => {
      // Alt routes
      for (let ai = 0; ai < 3; ai++) {
        m.addSource(`alt-route-${ai}`, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} } });
        m.addLayer({ id: `alt-route-${ai}`, type: 'line', source: `alt-route-${ai}`, layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': '#78909c', 'line-width': 6, 'line-opacity': 0.5 } });
      }

      m.addSource('route-traveled', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} } });
      m.addLayer({ id: 'route-traveled', type: 'line', source: 'route-traveled', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#9aa0a6', 'line-width': 8, 'line-opacity': 0.6 } });
      m.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} } });
      m.addLayer({ id: 'route-shadow', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0d47a1', 'line-width': 12, 'line-opacity': 0.35 } });
      m.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#4285F4', 'line-width': 7 } });
      m.addLayer({ id: 'route-dash', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'butt', visibility: 'none' }, paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 0.25, 'line-dasharray': [0, 4, 3] } });

      // 3D buildings
      const bldgSrc = m.getSource('openmaptiles') ? 'openmaptiles' : null;
      if (bldgSrc) {
        m.addLayer({
          id: '3d-buildings', source: bldgSrc, 'source-layer': 'building',
          type: 'fill-extrusion', minzoom: 15,
          layout: { visibility: 'none' },
          paint: {
            'fill-extrusion-color': '#c0cfe0',
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'render_height']],
            'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'render_min_height']],
            'fill-extrusion-opacity': 0.55,
          },
        });
      }

      // Dash animation
      let webDashStep = 0;
      setInterval(() => {
        if (!mapRef.current?.getLayer('route-dash')) return;
        if (mapRef.current.getLayoutProperty('route-dash', 'visibility') !== 'visible') return;
        webDashStep = (webDashStep + 1) % 7;
        mapRef.current.setPaintProperty('route-dash', 'line-dasharray', [webDashStep, 4, 3]);
      }, 80);

      setStyleLoaded(true);
    });

    m.on('dragstart', () => { isGesturing.current = true; onMapInteraction?.(); });
    m.on('dragend', () => { isGesturing.current = false; });
    m.on('rotate', () => { setMapBearing(m.getBearing()); });
    m.on('click', (e) => {
      for (let ci = 0; ci < 3; ci++) {
        const features = m.queryRenderedFeatures(e.point, { layers: [`alt-route-${ci}`] });
        if (features && features.length > 0) { onSelectAltRoute?.(ci); return; }
      }
      onMapPress?.([e.lngLat.lng, e.lngLat.lat]);
    });

    const ro = new ResizeObserver(() => m.resize());
    ro.observe(mapContainer.current);

    return () => {
      ro.disconnect(); setStyleLoaded(false); m.remove();
      mapRef.current = null; userMarkerRef.current = null;
      arrowMarkerRef.current = null; arrowVisRef.current = false;
      destMarkerRef.current = null; spotMarkersRef.current = {};
    };
  }, [!!userLocation]);

  useEffect(() => {
    if (!mapRef.current || !styleLoaded) return;
    mapRef.current.setStyle(currentStyle as any);
  }, [mapType, isNight]);

  // Create user markers once
  useEffect(() => {
    if (!mapRef.current || !userLocation || userMarkerRef.current) return;
    const dotEl = document.createElement('div');
    dotEl.innerHTML = '<div style="position:relative;width:22px;height:22px;"><div style="position:absolute;top:50%;left:50%;width:50px;height:50px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,rgba(66,133,244,0.15) 0%,rgba(66,133,244,0) 70%);animation:webpulse 2.5s ease-in-out infinite;pointer-events:none;"></div><div style="width:22px;height:22px;background:radial-gradient(circle at 40% 35%,#6ea6ff,#4285F4);border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 8px rgba(66,133,244,0.18),0 2px 8px rgba(0,0,0,0.3);"></div></div><style>@keyframes webpulse{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:0.8}50%{transform:translate(-50%,-50%) scale(1.4);opacity:0.3}}</style>';
    userElRef.current = dotEl;
    userMarkerRef.current = new maplibregl.Marker({ element: dotEl, anchor: 'center' }).setLngLat([userLocation.lng, userLocation.lat]).addTo(mapRef.current);

    const arrowEl = document.createElement('div');
    arrowEl.style.cssText = 'width:44px;height:44px;';
    arrowEl.innerHTML = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><filter id="was" x="-20%" y="-20%" width="140%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.4"/></filter></defs><polygon points="50,5 18,85 50,68 82,85" fill="#4285F4" stroke="#fff" stroke-width="4" stroke-linejoin="round" filter="url(#was)"/></svg>';
    arrowMarkerRef.current = new maplibregl.Marker({ element: arrowEl, anchor: 'center', rotationAlignment: 'map' }).setLngLat([userLocation.lng, userLocation.lat]);
  }, [!!userLocation]);


  // Main update: position, snap, route lines, camera
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !userLocation || !styleLoaded) return;
    const routeArr = routeCoords.map(c => [c.longitude, c.latitude]);
    const userPos = [userLocation.lng, userLocation.lat];
    const isNav = isActiveNavigation;

    let displayPos = userPos;
    let snapIdx = 0;
    if (isNav && routeArr.length >= 2) {
      const s = snapToRoute(userPos, routeArr);
      displayPos = s.point;
      snapIdx = s.index;
      const dx = (userPos[0] - displayPos[0]) * 111320 * Math.cos(displayPos[1] * Math.PI / 180);
      const dy = (userPos[1] - displayPos[1]) * 110540;
      const distM = Math.sqrt(dx * dx + dy * dy);
      if (distM > 60) {
        const now = Date.now();
        if (now - lastRerouteRef.current > 10000) {
          lastRerouteRef.current = now;
          onOffRoute?.(userPos[1], userPos[0]);
        }
      }
    }

    // Alt routes
    for (let ai = 0; ai < 3; ai++) {
      const altSrc = m.getSource(`alt-route-${ai}`) as maplibregl.GeoJSONSource | undefined;
      if (altSrc) {
        if (!isNav && ai < altRoutes.length) {
          const altCoords = altRoutes[ai].coords.map(c => [c.longitude, c.latitude]);
          altSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: altCoords }, properties: {} });
          if (m.getLayer(`alt-route-${ai}`)) m.setLayoutProperty(`alt-route-${ai}`, 'visibility', 'visible');
        } else {
          altSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} });
          if (m.getLayer(`alt-route-${ai}`)) m.setLayoutProperty(`alt-route-${ai}`, 'visibility', 'none');
        }
      }
    }

    // Toggle dot vs arrow
    if (isNav) {
      if (userElRef.current) userElRef.current.style.display = 'none';
      if (!arrowVisRef.current && arrowMarkerRef.current) { arrowMarkerRef.current.addTo(m); arrowVisRef.current = true; }
      if (arrowMarkerRef.current) { arrowMarkerRef.current.setLngLat(displayPos as [number, number]); arrowMarkerRef.current.setRotation(heading || 0); }
    } else {
      if (userElRef.current) userElRef.current.style.display = '';
      if (userMarkerRef.current) userMarkerRef.current.setLngLat(displayPos as [number, number]);
      if (arrowVisRef.current && arrowMarkerRef.current) { arrowMarkerRef.current.remove(); arrowVisRef.current = false; }
    }

    // Route lines
    const rSrc = m.getSource('route') as maplibregl.GeoJSONSource | undefined;
    const tSrc = m.getSource('route-traveled') as maplibregl.GeoJSONSource | undefined;
    if (rSrc && tSrc) {
      if (routeArr.length >= 2) {
        if (m.getLayer('route-line')) m.setLayoutProperty('route-line', 'visibility', 'visible');
        if (m.getLayer('route-shadow')) m.setLayoutProperty('route-shadow', 'visibility', 'visible');
        if (m.getLayer('route-dash')) m.setLayoutProperty('route-dash', 'visibility', isNav ? 'visible' : 'none');
        if (m.getLayer('route-traveled')) m.setLayoutProperty('route-traveled', 'visibility', 'visible');
        if (m.getLayer('3d-buildings')) m.setLayoutProperty('3d-buildings', 'visibility', isNav ? 'visible' : 'none');
        if (isNav) {
          rSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [displayPos, ...routeArr.slice(snapIdx + 1)] }, properties: {} });
          tSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...routeArr.slice(0, snapIdx + 1), displayPos] }, properties: {} });
        } else {
          rSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeArr }, properties: {} });
          tSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} });
        }
      } else {
        if (m.getLayer('route-line')) m.setLayoutProperty('route-line', 'visibility', 'none');
        if (m.getLayer('route-shadow')) m.setLayoutProperty('route-shadow', 'visibility', 'none');
        if (m.getLayer('route-dash')) m.setLayoutProperty('route-dash', 'visibility', 'none');
        if (m.getLayer('route-traveled')) m.setLayoutProperty('route-traveled', 'visibility', 'none');
        if (m.getLayer('3d-buildings')) m.setLayoutProperty('3d-buildings', 'visibility', 'none');
      }
    }

    // Camera
    if (isFollowing && !isGesturing.current) {
      bearRef.current = lerpAngle(bearRef.current, heading || 0, 0.18);
      m.easeTo({ center: displayPos as [number, number], bearing: isNav ? bearRef.current : 0, pitch: isNav ? 55 : 0, zoom: isNav ? 18.5 : 16, duration: 700, easing: (t: number) => t * (2 - t) });
    } else if (!isNav && routeArr.length >= 2 && (searchedPlace || destination)) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      routeArr.forEach(p => { if (p[0] < minLng) minLng = p[0]; if (p[0] > maxLng) maxLng = p[0]; if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1]; });
      if (minLng !== Infinity) m.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: { top: 80, bottom: 220, left: 50, right: 50 }, duration: 1000 });
    } else if (!isNav && routeArr.length < 2 && (searchedPlace || destination)) {
      const tgt = searchedPlace || destination;
      if (tgt && tgt.lat !== 0 && tgt.lng !== 0) m.easeTo({ center: [tgt.lng, tgt.lat], zoom: 15, pitch: 0, bearing: 0, duration: 1000 });
    }
  }, [userLocation, routeCoords, heading, isActiveNavigation, isFollowing, destination, searchedPlace, styleLoaded, altRoutes]);

  // ETA overlay
  useEffect(() => {
    if (!etaElRef.current) return;
    if (isActiveNavigation && distanceInfo) {
      etaElRef.current.style.display = 'flex';
      const mins = parseInt(distanceInfo.mins) || 0;
      const dist = distanceInfo.km || '0';
      const dur = mins >= 60 ? Math.floor(mins / 60) + ' hr' + (mins % 60 > 0 ? ' ' + (mins % 60) + ' min' : '') : mins + ' min';
      const arr = new Date(Date.now() + mins * 60000);
      let h = arr.getHours(); const mm = arr.getMinutes(); const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      etaElRef.current.innerHTML = '<div style="color:#10b981;font-weight:850;font-size:17px;letter-spacing:-0.3px;">' + dur + '</div><div style="color:#94a3b8;font-size:12px;font-weight:700;margin-top:2px;">' + h + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ap + '  •  ' + dist + ' km</div>';
    } else {
      etaElRef.current.style.display = 'none';
    }
  }, [isActiveNavigation, distanceInfo]);

  // Voice instructions
  useEffect(() => {
    if (!isMuted && isActiveNavigation && nextInstruction && nextInstruction !== lastInstructionRef.current) {
      lastInstructionRef.current = nextInstruction;
      speakText(nextInstruction);
    }
  }, [nextInstruction, isMuted, isActiveNavigation]);

  // Destination marker (searched place OR active nav)
  useEffect(() => {
    if (!mapRef.current) return;
    let showDest = false;
    let finalDest: [number, number] | null = null;
    const routeArr = routeCoords.map(c => [c.longitude, c.latitude]);

    if (isActiveNavigation && routeArr.length > 0) {
      finalDest = routeArr[routeArr.length - 1] as [number, number];
      showDest = true;
    } else if (searchedPlace) {
      finalDest = [searchedPlace.lng, searchedPlace.lat];
      showDest = true;
    } else if (destination && isActiveNavigation) {
      finalDest = [destination.lng, destination.lat];
      const overlaps = markers.some(m => Math.abs(m.lat - finalDest![1]) < 0.0001 && Math.abs(m.lng - finalDest![0]) < 0.0001);
      if (!overlaps) showDest = true;
    }

    destMarkerRef.current?.remove();
    destMarkerRef.current = null;

    if (showDest && finalDest && !isNaN(finalDest[0]) && !isNaN(finalDest[1]) && (finalDest[0] !== 0 || finalDest[1] !== 0)) {
      const el = document.createElement('div');
      el.style.display = 'none';
      el.innerHTML = '<div style="position:relative;animation:dropIn 0.4s cubic-bezier(0.175,0.885,0.32,1.275);"><svg width="40" height="56" viewBox="0 0 40 56" xmlns="http://www.w3.org/2000/svg"><defs><filter id="wdshadow" x="-20%" y="-10%" width="140%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.35"/></filter></defs><path d="M20 0C8.95 0 0 8.95 0 20c0 14 20 36 20 36s20-22 20-36C40 8.95 31.05 0 20 0z" fill="#EA4335" filter="url(#wdshadow)"/><circle cx="20" cy="19" r="4" fill="#fff"/></svg></div><style>@keyframes dropIn{0%{transform:translateY(-60px) scale(0);opacity:0}100%{transform:translateY(0) scale(1);opacity:1}}</style>';
      destMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(finalDest).addTo(mapRef.current);
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.display = 'block'; }));
    }

    return () => { destMarkerRef.current?.remove(); destMarkerRef.current = null; };
  }, [isActiveNavigation, destination, searchedPlace, routeCoords, markers]);

  // Spot markers (efficient diff)
  useEffect(() => {
    if (!mapRef.current) return;
    const existing = spotMarkersRef.current;
    const newIds = new Set(markers.map(m => m.id));
    for (const id of Object.keys(existing)) {
      if (!newIds.has(id)) { existing[id].remove(); delete existing[id]; }
    }
    markers.forEach(marker => {
      if (existing[marker.id]) { existing[marker.id].setLngLat([marker.lng, marker.lat]); return; }
      const el = document.createElement('div');
      const bg = marker.available ? '#4285F4' : '#ea4335';
      el.innerHTML = '<div style="background:' + bg + ';color:#fff;font-weight:800;font-size:12px;padding:5px 10px;border-radius:16px;border:2px solid rgba(255,255,255,0.85);cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,0.5);white-space:nowrap;user-select:none;">\u{1F17F}️ ₹' + marker.price + '</div>';
      el.addEventListener('click', (e) => { e.stopPropagation(); onMarkerPress?.(marker.id); });
      existing[marker.id] = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([marker.lng, marker.lat]).addTo(mapRef.current!);
    });
  }, [markers, destination]);

  const handleMapType = useCallback((type: MapTypeKey) => { setMapType(prev => prev === type ? 'STANDARD' : type); }, []);

  const speedKmh = speed * 3.6;
  const showSpeed = speedKmh > 5 && isActiveNavigation;

  if (!userLocation) return null;

  return (
    <View style={[styles.container, style]}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }} />
      <div ref={etaElRef} style={{ position: 'absolute', bottom: 120, left: '50%', transform: 'translateX(-50%)', background: '#0f172a', border: '1px solid rgba(255,255,255,0.08)', color: '#fff', padding: '10px 24px', borderRadius: 20, fontFamily: '-apple-system, sans-serif', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)', display: 'none', zIndex: 999, whiteSpace: 'nowrap', textAlign: 'center' }} />

      {!hideControls && (
        <View style={styles.controlStack}>
          <TouchableOpacity style={styles.mapBtn} onPress={() => handleMapType('SATELLITE')}>
            <Text style={{ fontSize: 20 }}>{mapType === 'SATELLITE' ? '\u{1F5FA}️' : '\u{1F6F0}️'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.mapBtn, styles.recenterBtn]} onPress={onRecenter}>
            <Text style={{ fontSize: 20 }}>{'\u{1F3AF}'}</Text>
          </TouchableOpacity>
          {isActiveNavigation && (
            <>
              <TouchableOpacity style={styles.mapBtn} onPress={onMuteToggle}>
                <Text style={{ fontSize: 20 }}>{isMuted ? '\u{1F50A}' : '\u{1F507}'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.mapBtn, { backgroundColor: '#ef4444', borderColor: 'rgba(255,255,255,0.3)' }]} onPress={onExit}>
                <Text style={{ fontSize: 20, color: '#fff', fontWeight: 'bold' }}>{'✕'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {showSpeed && !hideControls && (
        <View style={styles.speedometer}>
          <Text style={styles.speedValue}>{Math.round(speedKmh)}</Text>
          <Text style={styles.speedUnit}>km/h</Text>
        </View>
      )}

      {!hideControls && (isActiveNavigation || Math.abs(mapBearing) > 1) && (
        <TouchableOpacity
          style={styles.compassBtn}
          onPress={() => { mapRef.current?.easeTo({ bearing: 0, pitch: 0, duration: 400 }); }}
        >
          <div style={{ width: 32, height: 32, transform: `rotate(${-mapBearing}deg)`, transition: 'transform 0.15s ease-out' }}
            dangerouslySetInnerHTML={{ __html: '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><polygon points="16,3 19,15 16,13 13,15" fill="#EA4335"/><polygon points="16,29 13,17 16,19 19,17" fill="#aaa"/><text x="16" y="8" text-anchor="middle" font-size="6" font-weight="900" fill="#EA4335" font-family="-apple-system,sans-serif">N</text></svg>' }}
          />
        </TouchableOpacity>
      )}
    </View>
  );
});

export default MapLibreView;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  controlStack: { position: 'absolute', bottom: 24, right: 16, gap: 10, zIndex: 999 },
  mapBtn: {
    width: 48, height: 48, backgroundColor: '#1e293b', borderRadius: 24,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4, shadowRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  recenterBtn: { backgroundColor: '#4285F4', borderColor: 'rgba(255,255,255,0.3)' },
  speedometer: {
    position: 'absolute', top: 80, right: 16, width: 56, height: 56,
    backgroundColor: '#1e293b', borderRadius: 28, justifyContent: 'center',
    alignItems: 'center', borderWidth: 2, borderColor: '#4285F4', zIndex: 1000,
  },
  speedValue: { color: '#fff', fontSize: 16, fontWeight: '900', lineHeight: 18 },
  speedUnit: { color: 'rgba(255,255,255,0.55)', fontSize: 9, fontWeight: '700' },
  compassBtn: {
    position: 'absolute', top: 80, left: 16, width: 40, height: 40,
    backgroundColor: 'rgba(30,41,59,0.95)', borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', zIndex: 999,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5, shadowRadius: 8,
  },
});
