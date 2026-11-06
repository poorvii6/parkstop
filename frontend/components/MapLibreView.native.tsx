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
 * Note the licensing constraint before adding any non-Google basemap back:
 * Google Maps Platform Terms 3.2.3(e) forbid showing Google Maps Content —
 * which includes Routes API results — over a non-Google basemap.
 */

import React, { useEffect, useRef, useState, useImperativeHandle, useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, Platform, Animated as RNAnimated } from 'react-native';
import { WebView } from 'react-native-webview';
import GoogleMapNative from './GoogleMapNative';

// Try to load native MapLibre
/** 40 -> "40", 40.5 -> "40.5", "40.00" -> "40" (no long decimals on the map). */
function formatPrice(p: any): string {
  const n = Number(p);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 100) / 100);
}

let MapLibreGL: any = null;
let NATIVE_AVAILABLE = false;
try {
  MapLibreGL = require('@maplibre/maplibre-react-native');
  if (MapLibreGL?.default) MapLibreGL = MapLibreGL.default;
  // MapLibre needs no access token, and v10+ removed setAccessToken entirely.
  if (typeof MapLibreGL.setAccessToken === 'function') {
    MapLibreGL.setAccessToken(null);
  }
  // Only enable native rendering if the component API this file was written
  // against is present. The installed v11 renamed components (MapView -> Map,
  // MarkerView -> Marker, ShapeSource -> GeoJSONSource, LineLayer -> Layer), so
  // this guard keeps us on the WebView fallback instead of crashing. Enabling
  // native rendering requires migrating this component to the v11 API.
  // v11 renamed MapView -> Map; accept either so native rendering turns on.
  NATIVE_AVAILABLE = !!(MapLibreGL && (MapLibreGL.Map || MapLibreGL.MapView));
} catch (e) {
  console.warn('[MapLibre] Native module not available — map features will be limited:', (e as any)?.message);
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
.spot-marker{position:relative;width:28px;height:28px;border-radius:50%;background:#1A73E8;border:3px solid #fff;box-sizing:border-box;box-shadow:0 2px 6px rgba(0,0,0,0.35);cursor:pointer;margin-bottom:9px}
.spot-marker::before{content:'';position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#fff}
.spot-marker::after{content:'';position:absolute;left:50%;bottom:-11px;margin-left:-6px;border-left:6px solid transparent;border-right:6px solid transparent;border-top:10px solid #1A73E8}
.spot-marker.unavailable{background:#EA4335}
.spot-marker.unavailable::after{border-top-color:#EA4335}
.spot-marker.active{border-color:#111827}
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

function fmtPrice(p){ var n=Number(p); if(!isFinite(n)) return ''; return (Math.round(n*100)/100).toString(); }
function setSpotMarkers(markers,activeDest){
  var seen={};
  markers.forEach(function(m){
    seen[m.id]=true;
    var isActive=activeDest && Math.abs(activeDest.lat-m.lat)<0.001 && Math.abs(activeDest.lng-m.lng)<0.001;
    if(spotMarkers[m.id]){
      spotMarkers[m.id].setLngLat([m.lng,m.lat]);
      var e=spotMarkers[m.id].getElement();
      e.className='spot-marker'+(m.available?'':' unavailable')+(isActive?' active':'');
      e.innerHTML='';
    } else {
      var el=document.createElement('div');
      el.className='spot-marker'+(m.available?'':' unavailable')+(isActive?' active':'');
      el.innerHTML='';
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
// NOTE: deliberately NOT annotated `React.FC<MapProps>`. React.FC has no `ref`
// in its props, so that annotation erased the forwardRef typing and made every
// `<MapLibreView ref={...}>` call site a type error — on a component whose ref
// (animateCamera) is how the whole map is driven. Let forwardRef infer it.
const MapLibreView = React.forwardRef((props: MapProps, ref: any) => {
  // If the native map module didn't load we show a plain message rather than
  // falling back to the Carto/Ola WebView map.
  //
  // LICENSING, not preference: Google Maps Platform Terms 3.2.3(e) ("No Use
  // With Non-Google Maps") prohibits displaying Google Maps Content — which
  // includes Routes/Directions results — on a non-Google basemap. The old
  // fallback rendered Carto tiles while still receiving routeCoords derived
  // from the Google Routes API, which is exactly that. It was unreachable in
  // practice (NATIVE_AVAILABLE is true in our builds), but it shipped in the
  // APK and was one broken native module away from running.
  if (!NATIVE_AVAILABLE) {
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
  container: { flex: 1 },
  map: { flex: 1, backgroundColor: '#0a0e17' },
  // Speed limit
  speedLimitBadge: {
    position: 'absolute', top: 80, right: 16,
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: '#fff', borderWidth: 3, borderColor: '#333',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 8, elevation: 10,
  },
  speedLimitValue: { fontSize: 18, fontWeight: '900', color: '#333' },
  speedLimitLabel: { fontSize: 6, fontWeight: '700', color: '#666', marginTop: -2 },
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
