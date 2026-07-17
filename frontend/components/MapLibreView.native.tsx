/**
 * MapLibreView.native.tsx — Native MapLibre GL (Phase 3)
 *
 * Replaces the WebView-based map with @maplibre/maplibre-react-native
 * for native rendering, 60fps animations, and offline tile support.
 *
 * Falls back to WebView version if native module fails to load.
 */

import React, { useEffect, useRef, useState, useImperativeHandle, useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, Platform, Animated as RNAnimated } from 'react-native';
import { WebView } from 'react-native-webview';

// Try to load native MapLibre
let MapLibreGL: any = null;
let NATIVE_AVAILABLE = false;
try {
  MapLibreGL = require('@maplibre/maplibre-react-native');
  if (MapLibreGL?.default) MapLibreGL = MapLibreGL.default;
  MapLibreGL.setAccessToken(null);
  NATIVE_AVAILABLE = true;
} catch (e) {
  console.warn('[MapLibre] Native module not available — map features will be limited');
}

export interface MapProps {
  userLocation?: { lat: number; lng: number };
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
}

// ── Helpers ──────────────────────────────────────────────────────
function isNightTime() {
  const h = new Date().getHours();
  return h >= 19 || h < 6;
}

function lerpAngle(a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

function snapToRoute(pos: [number, number], route: [number, number][]) {
  if (!route || route.length < 2) return { point: pos, index: 0 };
  let best: [number, number] | null = null, bestD = Infinity, bestI = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const p = projPoint(pos, route[i], route[i + 1]);
    const d = dsq(pos, p);
    if (d < bestD) { bestD = d; best = p; bestI = i; }
  }
  return { point: best || pos, index: bestI };
}

function projPoint(p: [number, number], a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  if (!len) return a;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return [a[0] + t * dx, a[1] + t * dy];
}

function dsq(a: [number, number], b: [number, number]) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

const TRAFFIC_COLORS: Record<string, string> = {
  low: '#34a853', moderate: '#fbbc04', heavy: '#ea8600', severe: '#ea4335'
};

const CARTO_DAY = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const CARTO_NIGHT = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// ── WebView Fallback (used in Expo Go / when native module unavailable) ──
const WebViewFallback = React.forwardRef((props: MapProps, ref: any) => {
  const webRef = useRef<any>(null);
  const [isSatellite, setIsSatellite] = useState(false);
  const initialLoc = props.userLocation || { lat: 12.97, lng: 77.59 };

  useImperativeHandle(ref, () => ({
    animateCamera: (cfg: any) => {
      const c = cfg?.center;
      if (!c || !webRef.current) return;
      const msg = JSON.stringify({ type: 'flyTo', lat: c.latitude, lng: c.longitude, zoom: cfg.zoom || 16, bearing: cfg.bearing || 0, pitch: cfg.pitch || 0 });
      webRef.current.injectJavaScript(`window.postMessage(${JSON.stringify(msg)}, '*'); true;`);
    }
  }));

  // Send data updates to the WebView
  useEffect(() => {
    if (!webRef.current) return;
    const routeArr = (props.routeCoords || []).map(c => [c.longitude, c.latitude]);
    const altsArr = (props.altRoutes || []).map(a => a.coords.map(c => [c.longitude, c.latitude]));
    const searchedPin = props.searchedPlace ? { lat: props.searchedPlace.lat, lng: props.searchedPlace.lng } : null;
    let destPin = null;
    if (props.isActiveNavigation && routeArr.length > 0) {
      const last = routeArr[routeArr.length - 1];
      destPin = { lng: last[0], lat: last[1] };
    } else if (props.destination) {
      destPin = { lat: props.destination.lat, lng: props.destination.lng };
    } else if (searchedPin) {
      destPin = searchedPin;
    }
    const payload = {
      type: 'update',
      user: props.userLocation ? { lat: props.userLocation.lat, lng: props.userLocation.lng } : null,
      heading: props.heading || 0,
      speed: props.speed || 0,
      isNav: !!props.isActiveNavigation,
      isFollowing: !!props.isFollowing,
      markers: (props.markers || []).map(m => ({ id: m.id, lat: m.lat, lng: m.lng, price: m.price, available: m.available })),
      route: routeArr,
      alts: altsArr,
      dest: destPin,
      searched: searchedPin,
      speedLimit: props.speedLimit || null,
    };
    const js = 'try{window.__updateMap(' + JSON.stringify(payload) + ');}catch(e){} true;';
    webRef.current.injectJavaScript(js);
  }, [props.userLocation, props.markers, props.routeCoords, props.altRoutes, props.destination, props.searchedPlace, props.isActiveNavigation, props.isFollowing, props.heading, props.speed, props.speedLimit]);

  const html = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css"/>
<script src="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js"></script>
<style>
body,html{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#0a0e17}
#map{position:absolute;top:0;bottom:0;left:0;right:0}
.spot-marker{background:#4285F4;color:#fff;padding:5px 10px;border-radius:16px;border:2px solid rgba(255,255,255,0.85);font-size:12px;font-weight:800;box-shadow:0 3px 8px rgba(0,0,0,0.5);white-space:nowrap;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,sans-serif}
.spot-marker.unavailable{background:#ea4335}
.spot-marker.active{border-color:#fff;transform:scale(1.15)}
.dest-pin{width:36px;height:50px;position:relative}
.dest-pin::before{content:'';width:30px;height:30px;background:#EA4335;border-radius:50%;position:absolute;top:0;left:3px;box-shadow:0 3px 8px rgba(0,0,0,0.4)}
.dest-pin::after{content:'';width:6px;height:6px;background:#fff;border-radius:50%;position:absolute;top:12px;left:15px}
.user-dot{width:22px;height:22px;background:#4285F4;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 8px rgba(66,133,244,0.2),0 3px 8px rgba(0,0,0,0.3)}
.user-arrow{width:0;height:0;border-left:14px solid transparent;border-right:14px solid transparent;border-bottom:34px solid #4285F4;filter:drop-shadow(0 3px 4px rgba(0,0,0,0.4))}
</style></head><body>
<div id="map"></div>
<script>
var map=new maplibregl.Map({
  container:'map',
  style:'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  center:[${initialLoc.lng},${initialLoc.lat}],
  zoom:15,
  attributionControl:false
});
var userMarker=null,destMarker=null,searchedMarker=null;
var spotMarkers={};
var routeAdded=false,altsAdded=0;
var lastState={};

function setUserLocation(lat,lng,isNav){
  if(!userMarker){
    var el=document.createElement('div');
    el.className=isNav?'user-arrow':'user-dot';
    userMarker=new maplibregl.Marker({element:el,rotationAlignment:'map'}).setLngLat([lng,lat]).addTo(map);
  } else {
    userMarker.setLngLat([lng,lat]);
    userMarker.getElement().className=isNav?'user-arrow':'user-dot';
  }
}

function setDestPin(lat,lng){
  if(!destMarker){
    var el=document.createElement('div');
    el.className='dest-pin';
    destMarker=new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([lng,lat]).addTo(map);
  } else {
    destMarker.setLngLat([lng,lat]);
  }
}

function removeDestPin(){
  if(destMarker){ destMarker.remove(); destMarker=null; }
}

function setSpotMarkers(markers,activeDest){
  var seen={};
  markers.forEach(function(m){
    seen[m.id]=true;
    var isActive=activeDest && Math.abs(activeDest.lat-m.lat)<0.001 && Math.abs(activeDest.lng-m.lng)<0.001;
    if(spotMarkers[m.id]){
      spotMarkers[m.id].setLngLat([m.lng,m.lat]);
      var e=spotMarkers[m.id].getElement();
      e.className='spot-marker'+(m.available?'':' unavailable')+(isActive?' active':'');
      e.innerHTML='🅿️ ₹'+m.price;
    } else {
      var el=document.createElement('div');
      el.className='spot-marker'+(m.available?'':' unavailable')+(isActive?' active':'');
      el.innerHTML='🅿️ ₹'+m.price;
      el.onclick=function(id){ return function(){ window.ReactNativeWebView.postMessage(JSON.stringify({type:'markerPress',id:id})); }; }(m.id);
      spotMarkers[m.id]=new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([m.lng,m.lat]).addTo(map);
    }
  });
  Object.keys(spotMarkers).forEach(function(k){ if(!seen[k]){ spotMarkers[k].remove(); delete spotMarkers[k]; } });
}

function setRoute(coords){
  if(!map.isStyleLoaded()){ setTimeout(function(){setRoute(coords);},200); return; }
  var geo={type:'Feature',geometry:{type:'LineString',coordinates:coords}};
  if(map.getSource('route')){
    map.getSource('route').setData(geo);
  } else {
    map.addSource('route',{type:'geojson',data:geo});
    map.addLayer({id:'route-casing',type:'line',source:'route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#0d47a1','line-width':12,'line-opacity':0.5}});
    map.addLayer({id:'route-line',type:'line',source:'route',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#4285F4','line-width':7,'line-opacity':1}});
  }
  // Fit bounds if not navigating and route just added
  if(coords.length>=2 && !lastState.isNav && !lastState.hadRoute){
    var bounds=coords.reduce(function(b,c){ return b.extend(c); },new maplibregl.LngLatBounds(coords[0],coords[0]));
    map.fitBounds(bounds,{padding:{top:120,bottom:220,left:60,right:60},duration:1000,maxZoom:16});
  }
  lastState.hadRoute=true;
}

function clearRoute(){
  if(map.getLayer('route-line')) map.removeLayer('route-line');
  if(map.getLayer('route-casing')) map.removeLayer('route-casing');
  if(map.getSource('route')) map.removeSource('route');
  lastState.hadRoute=false;
}

function setAlts(alts){
  // Remove old
  for(var i=0;i<altsAdded;i++){
    if(map.getLayer('alt-'+i)) map.removeLayer('alt-'+i);
    if(map.getSource('alt-'+i)) map.removeSource('alt-'+i);
  }
  altsAdded=alts.length;
  alts.forEach(function(coords,i){
    if(coords.length<2)return;
    map.addSource('alt-'+i,{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:coords}}});
    map.addLayer({id:'alt-'+i,type:'line',source:'alt-'+i,layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#78909c','line-width':6,'line-opacity':0.55}},'route-casing');
  });
}

window.__updateMap=function(data){
  try {
    if(data.user){
      setUserLocation(data.user.lat,data.user.lng,data.isNav);
      if(data.isNav && userMarker){
        userMarker.setRotation(data.heading||0);
      }
      if(data.isFollowing){
        map.easeTo({
          center:[data.user.lng,data.user.lat],
          zoom:data.isNav?17.5:15,
          pitch:data.isNav?55:0,
          bearing:data.isNav?(data.heading||0):0,
          duration:700
        });
      }
    }
    if(data.dest){ setDestPin(data.dest.lat,data.dest.lng); } else { removeDestPin(); }
    setSpotMarkers(data.markers||[],data.dest);
    if(data.route && data.route.length>=2){
      lastState.isNav=data.isNav;
      setRoute(data.route);
    } else {
      clearRoute();
    }
    setAlts(data.alts||[]);
    lastState.isNav=data.isNav;
  } catch(e){ console.error(e); }
};

// Also listen for postMessage
window.addEventListener('message',function(e){
  try {
    var msg=typeof e.data==='string'?JSON.parse(e.data):e.data;
    if(msg.type==='flyTo'){
      map.flyTo({center:[msg.lng,msg.lat],zoom:msg.zoom,bearing:msg.bearing,pitch:msg.pitch,duration:1200});
    }
  } catch(err){}
});

map.on('click',function(e){
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapPress',lng:e.lngLat.lng,lat:e.lngLat.lat}));
});
map.on('touchstart',function(){
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'interaction'}));
});
map.on('load',function(){
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
});
</script></body></html>`;

  const handleMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'markerPress') props.onMarkerPress?.(msg.id);
      else if (msg.type === 'mapPress') props.onMapPress?.([msg.lng, msg.lat]);
      else if (msg.type === 'interaction') props.onMapInteraction?.();
    } catch {}
  };

  return (
    <View style={[styles.container, props.style]}>
      <WebView
        ref={webRef}
        source={{ html }}
        style={styles.map}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        onMessage={handleMessage}
        scrollEnabled={false}
        bounces={false}
        androidLayerType="hardware"
        mixedContentMode="always"
      />
      {/* Overlays: compass, speed limit, ETA, controls */}
      {props.isActiveNavigation && props.speedLimit ? (
        <View style={styles.speedLimitBadge}>
          <Text style={styles.speedLimitValue}>{props.speedLimit}</Text>
          <Text style={styles.speedLimitLabel}>LIMIT</Text>
        </View>
      ) : null}
      {!props.hideControls && (
        <View style={styles.controls}>
          <TouchableOpacity style={[styles.fab, styles.recenterFab]} onPress={props.onRecenter}>
            <Text style={styles.fabIcon}>🎯</Text>
          </TouchableOpacity>
          {props.isActiveNavigation && (
            <TouchableOpacity style={[styles.fab, styles.exitFab]} onPress={props.onExit}>
              <Text style={styles.exitIcon}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
});

// ── Main Component ───────────────────────────────────────────────
const MapLibreView: React.FC<MapProps> = React.forwardRef((props: MapProps, ref: any) => {
  // If native module didn't load, use the full WebView-based fallback
  if (!NATIVE_AVAILABLE) {
    return <WebViewFallback {...props} ref={ref} />;
  }

  const {
    userLocation,
    markers = [],
    routeCoords = [],
    destination,
    isActiveNavigation = false,
    heading = 0,
    speed = 0,
    isFollowing = true,
    onMapPress,
    onMapInteraction,
    onRecenter,
    onMarkerPress,
    onOffRoute,
    hideControls = false,
    searchedPlace,
    onExit,
    distanceInfo,
  } = props;

  const cameraRef = useRef<any>(null);
  const mapRef = useRef<any>(null);
  const [isSatellite, setIsSatellite] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const bearRef = useRef(0);

  // Animated position for smooth 60fps marker movement (#15)
  const animLng = useRef(new RNAnimated.Value(userLocation?.lng || 0)).current;
  const animLat = useRef(new RNAnimated.Value(userLocation?.lat || 0)).current;
  const [displayPos, setDisplayPos] = useState<[number, number]>([userLocation?.lng || 0, userLocation?.lat || 0]);
  const lastGpsTime = useRef(Date.now());

  // Interpolate position between GPS ticks
  useEffect(() => {
    if (!userLocation) return;
    const now = Date.now();
    const dt = Math.min(now - lastGpsTime.current, 2000);
    lastGpsTime.current = now;

    const routeArr: [number, number][] = routeCoords.map(c => [c.longitude, c.latitude]);
    let targetPos: [number, number] = [userLocation.lng, userLocation.lat];

    // Snap to route during navigation
    if (isActiveNavigation && routeArr.length >= 2) {
      const snapped = snapToRoute(targetPos, routeArr);
      targetPos = snapped.point;

      // Off-route check
      const dx = (userLocation.lng - snapped.point[0]) * 111320 * Math.cos(snapped.point[1] * Math.PI / 180);
      const dy = (userLocation.lat - snapped.point[1]) * 110540;
      const distMeters = Math.sqrt(dx * dx + dy * dy);
      if (distMeters > 60) {
        onOffRoute?.(userLocation.lat, userLocation.lng);
      }
    }

    // Smooth animation to target (60fps interpolation)
    RNAnimated.parallel([
      RNAnimated.timing(animLng, { toValue: targetPos[0], duration: 700, useNativeDriver: false }),
      RNAnimated.timing(animLat, { toValue: targetPos[1], duration: 700, useNativeDriver: false }),
    ]).start();

    setDisplayPos(targetPos);
  }, [userLocation, isActiveNavigation, routeCoords]);

  // Camera follow
  useEffect(() => {
    if (!cameraRef.current || !isFollowing || !userLocation) return;

    bearRef.current = isActiveNavigation
      ? lerpAngle(bearRef.current, heading, 0.18)
      : 0;

    // Speed-adaptive zoom
    let zoom = 16;
    let pitch = 0;
    if (isActiveNavigation) {
      const speedKmh = (speed || 0) * 3.6;
      if (speedKmh > 80) { zoom = 15.5; pitch = 50; }
      else if (speedKmh > 60) { zoom = 16; pitch = 52; }
      else if (speedKmh > 40) { zoom = 16.8; pitch = 53; }
      else if (speedKmh > 20) { zoom = 17.5; pitch = 55; }
      else { zoom = 18.5; pitch = 55; }
    }

    cameraRef.current.setCamera({
      centerCoordinate: displayPos,
      zoomLevel: zoom,
      pitch,
      heading: bearRef.current,
      animationDuration: 700,
    });
  }, [displayPos, isFollowing, isActiveNavigation, heading, speed]);

  // Fit bounds when route shown but not navigating
  useEffect(() => {
    if (!cameraRef.current || isActiveNavigation || routeCoords.length < 2) return;
    if (!isFollowing && (searchedPlace || destination)) {
      const coords = routeCoords.map(c => [c.longitude, c.latitude] as [number, number]);
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      coords.forEach(p => {
        if (p[0] < minLng) minLng = p[0];
        if (p[0] > maxLng) maxLng = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      });
      if (minLng !== Infinity) {
        cameraRef.current.fitBounds(
          [maxLng, maxLat], [minLng, minLat],
          [80, 220, 50, 50], 1000
        );
      }
    }
  }, [routeCoords, isActiveNavigation, searchedPlace, destination]);

  // Style URL
  const styleUrl = useMemo(() => {
    if (isSatellite) return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    const night = isNightTime();
    if (props.mapStyleUrl) {
      return night
        ? props.mapStyleUrl.replace('default-light-standard', 'default-dark-standard')
        : props.mapStyleUrl;
    }
    return night ? CARTO_NIGHT : CARTO_DAY;
  }, [isSatellite, props.mapStyleUrl]);

  // Transform request for Ola Maps tiles
  const transformRequest = useCallback((url: string, resourceType: string) => {
    if (props.mapApiKey && (resourceType === 'Tile' || resourceType === 'Source' || resourceType === 'Sprite' || resourceType === 'Glyphs')) {
      const sep = url.includes('?') ? '&' : '?';
      return { url: url + sep + 'api_key=' + props.mapApiKey };
    }
    return { url };
  }, [props.mapApiKey]);

  // GeoJSON for route
  const routeGeoJSON = useMemo(() => {
    const coords = routeCoords.map(c => [c.longitude, c.latitude]);
    if (isActiveNavigation && coords.length >= 2) {
      const snapped = snapToRoute(displayPos, coords as [number, number][]);
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: [displayPos, ...coords.slice(snapped.index + 1)] }
      };
    }
    return {
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: coords }
    };
  }, [routeCoords, displayPos, isActiveNavigation]);

  const traveledGeoJSON = useMemo(() => {
    if (!isActiveNavigation || routeCoords.length < 2) {
      return { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: [] as number[][] } };
    }
    const coords = routeCoords.map(c => [c.longitude, c.latitude]);
    const snapped = snapToRoute(displayPos, coords as [number, number][]);
    return {
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates: [...coords.slice(0, snapped.index + 1), displayPos] }
    };
  }, [routeCoords, displayPos, isActiveNavigation]);

  // Imperative handle for animateCamera
  useImperativeHandle(ref, () => ({
    animateCamera: (config: any) => {
      if (!cameraRef.current) return;
      cameraRef.current.setCamera({
        centerCoordinate: [config.center.longitude, config.center.latitude],
        zoomLevel: config.zoom || 16,
        heading: config.bearing || 0,
        pitch: config.pitch || 0,
        animationDuration: 1000,
      });
    }
  }));

  // ETA display
  const etaDisplay = useMemo(() => {
    if (!isActiveNavigation || !distanceInfo) return null;
    const minsVal = parseInt(distanceInfo.mins) || 0;
    let durationText = '';
    if (minsVal >= 60) {
      const hrs = Math.floor(minsVal / 60);
      const rem = minsVal % 60;
      durationText = `${hrs} hr${hrs > 1 ? 's' : ''}${rem > 0 ? ` ${rem} min` : ''}`;
    } else {
      durationText = `${minsVal} min`;
    }
    const arrival = new Date(Date.now() + minsVal * 60000);
    let h = arrival.getHours();
    const m = arrival.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const arrivalText = `${h}:${m < 10 ? '0' : ''}${m} ${ampm}`;
    return { durationText, arrivalText, dist: distanceInfo.km };
  }, [isActiveNavigation, distanceInfo]);

  // Overspeed check
  const isOverspeed = props.speedLimit && props.speedLimit > 0 && (speed || 0) * 3.6 > props.speedLimit + 5;

  if (!userLocation) return <View style={styles.container}><View style={[styles.map, { backgroundColor: '#0a0e17' }]} /></View>;

  return (
    <View style={styles.container}>
      <MapLibreGL.MapView
        ref={mapRef}
        style={styles.map}
        styleURL={styleUrl}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled={false}
        onPress={(e: any) => {
          const coords = e.geometry?.coordinates;
          if (coords) onMapPress?.([coords[0], coords[1]]);
        }}
        onTouchStart={() => onMapInteraction?.()}
        requestDisallowInterceptTouchEvent={false}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: [userLocation.lng, userLocation.lat],
            zoomLevel: 16,
          }}
        />

        {/* ── Traveled route (gray) ── */}
        {traveledGeoJSON.geometry.coordinates.length >= 2 && (
          <MapLibreGL.ShapeSource id="route-traveled" shape={traveledGeoJSON}>
            <MapLibreGL.LineLayer
              id="route-traveled-line"
              style={{ lineColor: '#9aa0a6', lineWidth: 8, lineOpacity: 0.6, lineCap: 'round', lineJoin: 'round' }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* ── Remaining route (blue with casing) ── */}
        {routeGeoJSON.geometry.coordinates.length >= 2 && (
          <MapLibreGL.ShapeSource id="route" shape={routeGeoJSON}>
            <MapLibreGL.LineLayer
              id="route-casing"
              style={{ lineColor: '#0d47a1', lineWidth: 12, lineOpacity: 0.35, lineCap: 'round', lineJoin: 'round' }}
            />
            <MapLibreGL.LineLayer
              id="route-line"
              style={{
                lineColor: '#4285F4',
                lineWidth: 7,
                lineOpacity: (isActiveNavigation && (props.trafficSegments?.length || 0) > 0) ? 0.15 : 1,
                lineCap: 'round', lineJoin: 'round'
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* ── Traffic-colored segments ── */}
        {isActiveNavigation && (props.trafficSegments || []).map((seg, i) => (
          seg.coords.length >= 2 ? (
            <MapLibreGL.ShapeSource
              key={`traffic-${i}`}
              id={`traffic-seg-${i}`}
              shape={{ type: 'Feature', geometry: { type: 'LineString', coordinates: seg.coords } }}
            >
              <MapLibreGL.LineLayer
                id={`traffic-seg-line-${i}`}
                style={{ lineColor: TRAFFIC_COLORS[seg.congestion] || '#4285F4', lineWidth: 7, lineOpacity: 1, lineCap: 'round', lineJoin: 'round' }}
              />
            </MapLibreGL.ShapeSource>
          ) : null
        ))}

        {/* ── Alternative routes ── */}
        {!isActiveNavigation && (props.altRoutes || []).map((alt, i) => (
          <MapLibreGL.ShapeSource
            key={`alt-${i}`}
            id={`alt-route-${i}`}
            shape={{
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: alt.coords.map(c => [c.longitude, c.latitude]) }
            }}
            onPress={() => props.onSelectAltRoute?.(i)}
          >
            <MapLibreGL.LineLayer
              id={`alt-route-line-${i}`}
              style={{ lineColor: '#78909c', lineWidth: 6, lineOpacity: 0.5, lineCap: 'round', lineJoin: 'round' }}
            />
          </MapLibreGL.ShapeSource>
        ))}

        {/* ── Destination pin ── */}
        {(() => {
          let dest: [number, number] | null = null;
          if (isActiveNavigation && routeCoords.length > 0) {
            const last = routeCoords[routeCoords.length - 1];
            dest = [last.longitude, last.latitude];
          } else if (searchedPlace) {
            dest = [searchedPlace.lng, searchedPlace.lat];
          }
          if (!dest || (dest[0] === 0 && dest[1] === 0)) return null;
          return (
            <MapLibreGL.MarkerView coordinate={dest} anchor={{ x: 0.5, y: 1 }}>
              <View style={styles.destPin}>
                <View style={styles.destPinHead} />
                <View style={styles.destPinDot} />
              </View>
            </MapLibreGL.MarkerView>
          );
        })()}

        {/* ── Spot markers ── */}
        {markers.map(m => (
          <MapLibreGL.MarkerView key={m.id} coordinate={[m.lng, m.lat]} anchor={{ x: 0.5, y: 1 }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => onMarkerPress?.(m.id)}
              style={[
                styles.spotMarker,
                { backgroundColor: m.available ? '#4285F4' : '#ea4335' },
                destination && Math.abs((destination.lat || 0) - m.lat) < 0.001 && Math.abs((destination.lng || 0) - m.lng) < 0.001
                  ? styles.activeSpotMarker : null
              ]}
            >
              <Text style={styles.spotMarkerText}>🅿️ ₹{m.price}</Text>
            </TouchableOpacity>
          </MapLibreGL.MarkerView>
        ))}

        {/* ── User location marker ── */}
        <MapLibreGL.MarkerView coordinate={displayPos} anchor={{ x: 0.5, y: 0.5 }}>
          {isActiveNavigation ? (
            <View style={[styles.arrowWrap, { transform: [{ rotate: `${bearRef.current}deg` }] }]}>
              <View style={styles.arrowBody} />
            </View>
          ) : (
            <View style={styles.dotWrap}>
              <View style={styles.dotRing} />
              <View style={styles.dotCore} />
            </View>
          )}
        </MapLibreGL.MarkerView>
      </MapLibreGL.MapView>

      {/* ── Compass overlay ── */}
      {isActiveNavigation && (
        <TouchableOpacity
          style={styles.compass}
          onPress={() => {
            cameraRef.current?.setCamera({ heading: 0, pitch: 0, animationDuration: 400 });
          }}
        >
          <Text style={[styles.compassN, { transform: [{ rotate: `${-(bearRef.current)}deg` }] }]}>N</Text>
        </TouchableOpacity>
      )}

      {/* ── Speed limit badge ── */}
      {isActiveNavigation && props.speedLimit && props.speedLimit > 0 && (
        <View style={[styles.speedLimitBadge, isOverspeed ? styles.speedLimitOverspeed : null]}>
          <Text style={[styles.speedLimitValue, isOverspeed ? { color: '#ea4335' } : null]}>{props.speedLimit}</Text>
          <Text style={styles.speedLimitLabel}>LIMIT</Text>
        </View>
      )}

      {/* ── ETA overlay ── */}
      {etaDisplay && (
        <View style={styles.etaOverlay}>
          <Text style={styles.etaDuration}>{etaDisplay.durationText}</Text>
          <Text style={styles.etaDetail}>{etaDisplay.arrivalText}  •  {etaDisplay.dist} km</Text>
        </View>
      )}

      {/* ── Floating controls ── */}
      {!hideControls && (
        <View style={styles.controls}>
          <TouchableOpacity style={styles.fab} onPress={() => setIsSatellite(s => !s)}>
            <Text style={styles.fabIcon}>{isSatellite ? '🗺️' : '🛰️'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.fab, styles.recenterFab]} onPress={onRecenter}>
            <Text style={styles.fabIcon}>🎯</Text>
          </TouchableOpacity>
          {isActiveNavigation && (
            <TouchableOpacity style={[styles.fab, styles.exitFab]} onPress={onExit}>
              <Text style={styles.exitIcon}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1, backgroundColor: '#0a0e17' },
  // User dot
  dotWrap: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  dotCore: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#4285F4', borderWidth: 3, borderColor: '#fff',
    shadowColor: '#4285F4', shadowOpacity: 0.4, shadowRadius: 8, elevation: 6,
  },
  dotRing: {
    position: 'absolute', width: 50, height: 50, borderRadius: 25,
    backgroundColor: 'rgba(66,133,244,0.15)',
  },
  // Arrow
  arrowWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  arrowBody: {
    width: 0, height: 0,
    borderLeftWidth: 14, borderRightWidth: 14, borderBottomWidth: 34,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#4285F4',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 4, elevation: 8,
  },
  // Destination pin
  destPin: { width: 36, height: 50, alignItems: 'center' },
  destPinHead: {
    width: 30, height: 30, borderRadius: 15, backgroundColor: '#EA4335',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, elevation: 6,
  },
  destPinDot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff',
    position: 'absolute', top: 12,
  },
  // Spot markers
  spotMarker: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 6, elevation: 8,
  },
  activeSpotMarker: { borderColor: '#4285F4' },
  spotMarkerText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  // Compass
  compass: {
    position: 'absolute', top: 80, left: 16,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(30,41,59,0.95)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 8, elevation: 10,
  },
  compassN: { color: '#EA4335', fontSize: 16, fontWeight: '900' },
  // Speed limit
  speedLimitBadge: {
    position: 'absolute', top: 80, right: 16,
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: '#fff', borderWidth: 3, borderColor: '#333',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 8, elevation: 10,
  },
  speedLimitOverspeed: { borderColor: '#ea4335', backgroundColor: '#fef2f2' },
  speedLimitValue: { fontSize: 18, fontWeight: '900', color: '#333' },
  speedLimitLabel: { fontSize: 6, fontWeight: '700', color: '#666', marginTop: -2 },
  // ETA
  etaOverlay: {
    position: 'absolute', bottom: 120, alignSelf: 'center',
    backgroundColor: '#0f172a', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 10, paddingHorizontal: 24, borderRadius: 20,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 12, elevation: 15,
    alignItems: 'center',
  },
  etaDuration: { color: '#10b981', fontWeight: '850', fontSize: 17, letterSpacing: -0.3 },
  etaDetail: { color: '#94a3b8', fontSize: 12, fontWeight: '700', marginTop: 2 },
  // Controls
  controls: {
    position: 'absolute', bottom: 40, right: 16, gap: 12, zIndex: 9999,
  },
  fab: {
    width: 52, height: 52, backgroundColor: 'rgba(30,41,59,0.95)',
    borderRadius: 26, justifyContent: 'center', alignItems: 'center',
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  recenterFab: { backgroundColor: '#4285F4' },
  exitFab: { backgroundColor: '#ea4335', borderColor: 'rgba(255,255,255,0.3)' },
  fabIcon: { fontSize: 22 },
  exitIcon: { fontSize: 20, color: '#fff', fontWeight: 'bold' as const },
});

export default MapLibreView;
