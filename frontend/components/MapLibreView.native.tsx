/**
 * MapLibreView.native.tsx — Google Maps-Quality Navigation Engine
 * 
 * FIXED: Arrow now moves with user by using TWO separate markers
 * (dot for idle, arrow for nav) and toggling visibility instead of
 * replacing innerHTML every frame. Arrow rotates via setRotation().
 * ETA/distance shown on map overlay.
 */

import React, { useEffect, useRef, useMemo, useState, useImperativeHandle } from 'react';
import { View, StyleSheet, TouchableOpacity, Text } from 'react-native';
import { WebView } from 'react-native-webview';

export interface MapProps {
  userLocation?: { lat: number; lng: number };
  markers?: Array<{ id: string; lat: number; lng: number; price: number; available: boolean; title?: string }>;
  routeCoords?: Array<{ latitude: number; longitude: number }>;
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
  distanceInfo?: any;
  nextInstruction?: string;
  isMuted?: boolean;
  onMuteToggle?: () => void;
  style?: any;
  hideControls?: boolean;
  onExit?: () => void;
}

const MapLibreView = React.forwardRef<any, MapProps>((props, ref) => {
  const {
    userLocation,
    markers = [],
    routeCoords = [],
    destination,
    isActiveNavigation = false,
    heading = 0,
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

  const webViewRef = useRef<WebView>(null);
  const [isSatellite, setIsSatellite] = useState(false);

  useImperativeHandle(ref, () => ({
    animateCamera: (config: any) => {
      const { center, zoom, bearing, pitch } = config;
      const script = `
        if (window.map) {
          window.map.easeTo({
            center: [${center.longitude}, ${center.latitude}],
            zoom: ${zoom || 16},
            bearing: ${bearing || 0},
            pitch: ${pitch || 0},
            duration: 1000
          });
        }
        true;
      `;
      webViewRef.current?.injectJavaScript(script);
    }
  }));

  const mapHtml = useMemo(() => `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.1.0/dist/maplibre-gl.js"></script>
      <link href="https://cdn.jsdelivr.net/npm/maplibre-gl@5.1.0/dist/maplibre-gl.css" rel="stylesheet" />
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { overflow: hidden; }
        #map { position: absolute; top: 0; bottom: 0; width: 100%; background: #0a0e17; }
        .maplibregl-ctrl-logo, .maplibregl-ctrl-attrib, .maplibregl-ctrl,
        .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib { display: none !important; }

        /* Blue dot (non-nav) */
        .user-dot-wrap {
          width: 22px; height: 22px; position: relative;
        }
        .user-dot-core {
          width: 22px; height: 22px;
          background: radial-gradient(circle at 40% 35%, #6ea6ff, #4285F4);
          border: 3px solid #fff;
          border-radius: 50%;
          box-shadow: 0 0 0 8px rgba(66,133,244,0.18), 0 2px 8px rgba(0,0,0,0.3);
        }
        .user-dot-ring {
          position: absolute; top: 50%; left: 50%;
          width: 50px; height: 50px;
          transform: translate(-50%, -50%);
          border-radius: 50%;
          background: radial-gradient(circle, rgba(66,133,244,0.15) 0%, rgba(66,133,244,0) 70%);
          animation: pulse 2.5s ease-in-out infinite;
          pointer-events: none;
        }
        @keyframes pulse {
          0%, 100% { transform: translate(-50%,-50%) scale(1); opacity: 0.8; }
          50% { transform: translate(-50%,-50%) scale(1.4); opacity: 0.3; }
        }

        /* Spot markers */
        .spot-marker {
          cursor: pointer; transition: transform 0.15s;
          box-shadow: 0 3px 10px rgba(0,0,0,0.5);
          user-select: none; -webkit-user-select: none;
        }
        .spot-marker:active { transform: scale(1.15); }
        .active-marker {
          animation: markerPulse 1.5s infinite;
          border-color: #4285F4 !important;
        }
        @keyframes markerPulse {
          0% { box-shadow: 0 0 0 0 rgba(66,133,244,0.7); }
          70% { box-shadow: 0 0 0 14px rgba(66,133,244,0); }
          100% { box-shadow: 0 0 0 0 rgba(66,133,244,0); }
        }

        /* Destination pin */
        .dest-pin {
          width: 36px; height: 50px;
          transform-origin: bottom center;
          display: none;
        }

        /* ETA overlay on map */
        #eta-overlay {
          position: fixed; bottom: 120px; left: 50%;
          transform: translateX(-50%);
          background: #0f172a;
          border: 1px solid rgba(255,255,255,0.08);
          color: #fff; padding: 10px 24px;
          border-radius: 20px; font-family: -apple-system, sans-serif;
          box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5);
          display: none; z-index: 999;
          white-space: nowrap;
          align-items: center;
          justify-content: center;
          text-align: center;
          flex-direction: column;
          gap: 2px;
        }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <div id="eta-overlay"></div>
      <script>
        window.onerror = function(message, source, lineno, colno, error) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'error',
            message: message + ' (line ' + lineno + ':' + colno + ')'
          }));
          return true;
        };

        let map = null;
        let mapLoaded = false;
        let lastData = null;
        let dotMarker = null;
        let arrowMarker = null;
        let destMarker = null;
        let spotMarkers = {};
        let prevIds = new Set();
        let arrowVisible = false;
        let destVis = false;

        // ── Bearing interpolation ──
        let _bear = 0;
        function lerpAngle(a, b, t) {
          let d = ((b - a + 540) % 360) - 180;
          return a + d * t;
        }

        // ── Snap-to-route ──
        function snapToRoute(pos, route) {
          if (!route || route.length < 2) return { point: pos, index: 0 };
          let best = null, bestD = Infinity, bestI = 0;
          for (let i = 0; i < route.length - 1; i++) {
            const p = proj(pos, route[i], route[i+1]);
            const d = dsq(pos, p);
            if (d < bestD) { bestD = d; best = p; bestI = i; }
          }
          return { point: best || pos, index: bestI };
        }
        function proj(p, a, b) {
          const dx = b[0]-a[0], dy = b[1]-a[1], len = dx*dx+dy*dy;
          if (!len) return a;
          let t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/len));
          return [a[0]+t*dx, a[1]+t*dy];
        }
        function dsq(a,b) { return (a[0]-b[0])**2+(a[1]-b[1])**2; }

        // Create marker elements
        const dotEl = document.createElement('div');
        dotEl.className = 'user-dot-wrap';
        dotEl.innerHTML = '<div class="user-dot-ring"></div><div class="user-dot-core"></div>';

        const arrowEl = document.createElement('div');
        arrowEl.style.cssText = 'width:44px;height:44px;';
        arrowEl.innerHTML = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">'
          + '<defs><filter id="as" x="-20%" y="-20%" width="140%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.4"/></filter></defs>'
          + '<polygon points="50,5 18,85 50,68 82,85" fill="#4285F4" stroke="#fff" stroke-width="4" stroke-linejoin="round" filter="url(#as)"/>'
          + '</svg>';

        const destEl = document.createElement('div');
        destEl.className = 'dest-pin';
        destEl.style.cssText = 'width: 40px; height: 56px; display: none;';
        destEl.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56" xmlns="http://www.w3.org/2000/svg">' +
                           '<defs><filter id="dshadow" x="-20%" y="-10%" width="140%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.35"/></filter></defs>' +
                           '<path d="M20 0C8.95 0 0 8.95 0 20c0 14 20 36 20 36s20-22 20-36C40 8.95 31.05 0 20 0z" fill="#EA4335" filter="url(#dshadow)"/>' +
                           '<circle cx="20" cy="19" r="12" fill="#fff"/>' +
                           '<text x="20" y="24" text-anchor="middle" font-size="16" font-weight="900" fill="#EA4335" font-family="Arial, sans-serif">P</text>' +
                           '</svg>';

        const etaEl = document.getElementById('eta-overlay');

        function initMap(data) {
          map = window.map = new maplibregl.Map({
            container: 'map',
            style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
            center: data.userLocation,
            zoom: data.isActiveNavigation ? 18.5 : 16,
            pitch: data.isActiveNavigation ? 55 : 0,
            bearing: data.isActiveNavigation ? (data.heading || 0) : 0,
            antialias: true,
            attributionControl: false,
            fadeDuration: 0
          });

          map.on('load', () => {
            // Instantiate markers on map load
            dotMarker = new maplibregl.Marker({ element: dotEl, anchor: 'center' })
              .setLngLat(data.userLocation).addTo(map);

            arrowMarker = new maplibregl.Marker({ element: arrowEl, anchor: 'center', rotationAlignment: 'map' })
              .setLngLat(data.userLocation);

            destMarker = new maplibregl.Marker({ element: destEl, anchor: 'bottom' });

            // Satellite
            map.addSource('satellite', { type:'raster', tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize:256, maxzoom:19 });
            map.addLayer({ id:'satellite-layer', type:'raster', source:'satellite', layout:{visibility:'none'} });

            // Traveled route (gray)
            map.addSource('route-traveled', { type:'geojson', data:{type:'Feature',geometry:{type:'LineString',coordinates:[]}} });
            map.addLayer({ id:'route-traveled', type:'line', source:'route-traveled',
              layout:{'line-join':'round','line-cap':'round'},
              paint:{'line-color':'#9aa0a6','line-width':8,'line-opacity':0.6}
            });

            // Remaining route (blue)
            map.addSource('route', { type:'geojson', data:{type:'Feature',geometry:{type:'LineString',coordinates:[]}} });
            map.addLayer({ id:'route-line', type:'line', source:'route',
              layout:{'line-join':'round','line-cap':'round'},
              paint:{'line-color':'#1a73e8','line-width':8,'line-opacity':1}
            });

            // Bind Touch events
            map.on('touchstart', function(){ window.ReactNativeWebView.postMessage(JSON.stringify({type:'interaction'})); });
            map.on('click', function(e){ window.ReactNativeWebView.postMessage(JSON.stringify({type:'press',coords:[e.lngLat.lng,e.lngLat.lat]})); });
            map.on('error', function(e){
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'error',
                message: e.error ? e.error.message : 'MapLibre GL error'
              }));
            });

            mapLoaded = true;
            if (lastData) {
              window.updateMap(lastData);
            }
          });
        }

        // ══════════════════════
        // MAIN UPDATE FUNCTION
        // ══════════════════════
        window.updateMap = function(data) {
          if (!data || !data.userLocation) return;
          lastData = data;

          if (!map) {
            initMap(data);
            return;
          }

          if (!mapLoaded) return;

          // Satellite
          if (data.isSatellite !== undefined && map.getLayer('satellite-layer')) {
            const v = data.isSatellite ? 'visible' : 'none';
            if (map.getLayoutProperty('satellite-layer','visibility') !== v)
              map.setLayoutProperty('satellite-layer','visibility', v);
          }

          const isNav = data.isActiveNavigation;
          const routeArr = data.routeCoords || [];
          const userPos = data.userLocation; // [lng, lat]

          console.warn("[WEBVIEW DATA] isNav: " + isNav + ", routeCoords count: " + routeArr.length + ", userPos: " + JSON.stringify(userPos));

          // Snap to route during nav
          let displayPos = userPos;
          let snapIdx = 0;
          if (isNav && routeArr.length >= 2) {
            const s = snapToRoute(userPos, routeArr);
            displayPos = s.point;
            snapIdx = s.index;

            // Off-route check: calculate distance deviation in meters
            const dx = (userPos[0] - displayPos[0]) * 111320 * Math.cos(displayPos[1] * Math.PI / 180);
            const dy = (userPos[1] - displayPos[1]) * 110540;
            const distMeters = Math.sqrt(dx * dx + dy * dy);

            if (distMeters > 60) {
              const now = Date.now();
              if (!window.lastRerouteTime || now - window.lastRerouteTime > 10000) {
                window.lastRerouteTime = now;
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'off_route',
                  lat: userPos[1],
                  lng: userPos[0]
                }));
              }
            }
          }

          // ── Toggle markers: show arrow during nav, dot otherwise ──
          if (isNav) {
            // Hide dot, show arrow
            dotEl.style.display = 'none';
            if (!arrowVisible && arrowMarker) { arrowMarker.addTo(map); arrowVisible = true; }
            if (arrowMarker) {
              arrowMarker.setLngLat(displayPos);
              arrowMarker.setRotation(data.heading || 0);
            }
          } else {
            // Hide arrow, show dot
            dotEl.style.display = '';
            if (dotMarker) dotMarker.setLngLat(displayPos);
            if (arrowVisible && arrowMarker) { arrowMarker.remove(); arrowVisible = false; }
          }

          // ── ETA overlay ──
          if (isNav && data.distanceInfo) {
            etaEl.style.display = 'flex';
            const minsVal = parseInt(data.distanceInfo.mins) || 0;
            const dist = data.distanceInfo.miles || data.distanceInfo.km || '0';
            
            // Format Duration: e.g. 1 hr 43 min
            let durationText = '';
            if (minsVal >= 60) {
              const hrs = Math.floor(minsVal / 60);
              const remainingMins = minsVal % 60;
              durationText = hrs + ' hr' + (hrs > 1 ? 's' : '') + (remainingMins > 0 ? ' ' + remainingMins + ' min' : '');
            } else {
              durationText = minsVal + ' min';
            }
            
            // Calculate Arrival Time
            const arrivalDate = new Date(Date.now() + minsVal * 60000);
            let hours = arrivalDate.getHours();
            const minutes = arrivalDate.getMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            hours = hours % 12;
            hours = hours ? hours : 12;
            const minutesStr = minutes < 10 ? '0' + minutes : minutes;
            const arrivalTimeText = hours + ':' + minutesStr + ' ' + ampm;
            
            etaEl.innerHTML = '<div style="color:#10b981; font-weight:850; font-size:17px; letter-spacing:-0.3px;">' + durationText + '</div>' +
                              '<div style="color:#94a3b8; font-size:12px; font-weight:700; margin-top:2px;">' + arrivalTimeText + '  •  ' + dist + ' km</div>';
          } else {
            etaEl.style.display = 'none';
          }

          // ── Camera follow ──
          if (data.isFollowing) {
            const tb = data.heading || 0;
            _bear = lerpAngle(_bear, tb, 0.18);
            map.easeTo({
              center: displayPos,
              bearing: isNav ? _bear : 0,
              pitch: isNav ? 55 : 0,
              zoom: isNav ? 18.5 : 16,
              duration: 700,
              easing: function(t){ return t*(2-t); }
            });
          } else if (!isNav && routeArr.length >= 2 && (data.searchedPlace || data.destination)) {
            // Fit bounds to show the entire route from user location to searched place
            let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
            routeArr.forEach(function(p) {
              if (p[0] < minLng) minLng = p[0];
              if (p[0] > maxLng) maxLng = p[0];
              if (p[1] < minLat) minLat = p[1];
              if (p[1] > maxLat) maxLat = p[1];
            });
            if (minLng !== Infinity) {
              map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
                padding: { top: 80, bottom: 220, left: 50, right: 50 },
                duration: 1000
              });
            }
          } else if (!isNav && routeArr.length < 2 && (data.searchedPlace || data.destination)) {
            // Center directly on searched place or destination (like Google Maps search)
            const targetCenter = data.searchedPlace || data.destination;
            if (targetCenter && targetCenter[0] !== 0 && targetCenter[1] !== 0) {
              map.easeTo({
                center: targetCenter,
                zoom: 15,
                pitch: 0,
                bearing: 0,
                duration: 1000
              });
            }
          }

          // ── Route lines ──
          const rSrc = map.getSource('route');
          const tSrc = map.getSource('route-traveled');
          if (rSrc && tSrc) {
            if (routeArr && routeArr.length >= 2) {
              // Ensure layers are visible
              if (map.getLayer('route-line')) map.setLayoutProperty('route-line', 'visibility', 'visible');
              if (map.getLayer('route-traveled')) map.setLayoutProperty('route-traveled', 'visibility', 'visible');

              if (isNav) {
                rSrc.setData({type:'Feature',geometry:{type:'LineString',coordinates:[displayPos].concat(routeArr.slice(snapIdx+1))}});
                tSrc.setData({type:'Feature',geometry:{type:'LineString',coordinates:routeArr.slice(0,snapIdx+1).concat([displayPos])}});
              } else {
                rSrc.setData({type:'Feature',geometry:{type:'LineString',coordinates:routeArr}});
                tSrc.setData({type:'Feature',geometry:{type:'LineString',coordinates:[]}});
              }
            } else {
              // Hide layers to clear the line safely
              if (map.getLayer('route-line')) map.setLayoutProperty('route-line', 'visibility', 'none');
              if (map.getLayer('route-traveled')) map.setLayoutProperty('route-traveled', 'visibility', 'none');
            }
          }

          // ── Destination Pin ──
          var showDest = false;
          var finalDest = null;
          
          if (isNav && routeArr.length > 0) {
            finalDest = routeArr[routeArr.length - 1];
            showDest = true;
          } else if (data.searchedPlace) {
            finalDest = data.searchedPlace;
            showDest = true;
          } else if (data.destination && isNav) {
            finalDest = data.destination;
            // Only show red pin if it's NOT a parking spot marker
            var overlapsSpot = (data.markers || []).some(function(m) {
              return Math.abs(m.lat - finalDest[1]) < 0.0001 && Math.abs(m.lng - finalDest[0]) < 0.0001;
            });
            if (!overlapsSpot) showDest = true;
          }

          if (showDest && finalDest && 
              typeof finalDest[0] === 'number' && 
              typeof finalDest[1] === 'number' && 
              !isNaN(finalDest[0]) && 
              !isNaN(finalDest[1]) && 
              (finalDest[0] !== 0 || finalDest[1] !== 0)) {
            if (destMarker) {
              var currentLngLat = destMarker.getLngLat();
              var isNewPos = !destVis || !currentLngLat || 
                             Math.abs(currentLngLat.lng - finalDest[0]) > 0.00001 || 
                             Math.abs(currentLngLat.lat - finalDest[1]) > 0.00001;

              if (isNewPos) {
                destEl.style.display = 'none';
                destMarker.setLngLat(finalDest);
                if (!destVis) {
                  destMarker.addTo(map);
                  destVis = true;
                }
                
                // Double-rAF: wait for MapLibre to apply the transform in the DOM before showing
                requestAnimationFrame(function() {
                  requestAnimationFrame(function() {
                    if (destVis) {
                      destEl.style.display = 'block';
                    }
                  });
                });
              } else {
                destEl.style.display = 'block';
              }
            }
          } else {
            destEl.style.display = 'none';
            if (destVis && destMarker) { destMarker.remove(); destVis = false; }
          }

          // ── Spot markers ──
          var newIds = new Set((data.markers||[]).map(function(m){return m.id;}));
          prevIds.forEach(function(id) {
            if (!newIds.has(id) && spotMarkers[id]) { spotMarkers[id].remove(); delete spotMarkers[id]; }
          });
          (data.markers||[]).forEach(function(m) {
            var isDest = data.destination && Array.isArray(data.destination)
              && Math.abs(data.destination[1]-m.lat)<0.001 && Math.abs(data.destination[0]-m.lng)<0.001;
            if (!spotMarkers[m.id]) {
              var el = document.createElement('div');
              el.className = 'spot-marker';
              el.style.cssText = 'background:'+(m.available?'#4285F4':'#ea4335')+';color:#fff;padding:5px 10px;border-radius:16px;font-size:12px;font-weight:800;border:2px solid rgba(255,255,255,0.85);white-space:nowrap;';
              el.textContent = '🅿️ ₹' + m.price;
              el.onclick = function(){ window.ReactNativeWebView.postMessage(JSON.stringify({type:'markerPress',id:m.id})); };
              spotMarkers[m.id] = new maplibregl.Marker({element:el, anchor:'bottom'}).setLngLat([m.lng,m.lat]).addTo(map);
            }
            var el2 = spotMarkers[m.id].getElement();
            if (isDest) el2.classList.add('active-marker'); else el2.classList.remove('active-marker');
          });
          prevIds = newIds;
        };
      </script>
    </body>
    </html>
  `, []);

  const lastInjectedDataRef = useRef<string>('');

  // Push state to WebView on every prop change
  useEffect(() => {
    if (!userLocation) return;
    const data = {
      userLocation: [userLocation.lng, userLocation.lat],
      routeCoords: routeCoords.map(c => [c.longitude, c.latitude]),
      destination: destination ? [destination.lng, destination.lat] : null,
      markers,
      heading,
      isActiveNavigation,
      isFollowing,
      isSatellite,
      searchedPlace: searchedPlace ? [searchedPlace.lng, searchedPlace.lat] : null,
      distanceInfo: distanceInfo || null,
    };
    const stringified = JSON.stringify(data);
    if (stringified !== lastInjectedDataRef.current) {
      lastInjectedDataRef.current = stringified;
      webViewRef.current?.injectJavaScript(`if(window.updateMap) window.updateMap(${stringified});true;`);
    }
  }, [userLocation, routeCoords, heading, isActiveNavigation, isFollowing, markers, destination, searchedPlace, isSatellite, distanceInfo]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html: mapHtml }}
        style={styles.map}
        scrollEnabled={false}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'press') onMapPress?.(data.coords);
            if (data.type === 'interaction') onMapInteraction?.();
            if (data.type === 'markerPress') onMarkerPress?.(data.id);
            if (data.type === 'off_route') onOffRoute?.(data.lat, data.lng);
            if (data.type === 'error') console.warn("[WEBVIEW MAP ERROR]", data.message);
          } catch (e) {}
        }}
      />

      {/* Floating Controls */}
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
  controls: {
    position: 'absolute',
    bottom: 40,
    right: 16,
    gap: 12,
    zIndex: 9999,
  },
  fab: {
    width: 52, height: 52,
    backgroundColor: 'rgba(30,41,59,0.95)',
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  recenterFab: {
    backgroundColor: '#4285F4',
  },
  exitFab: {
    backgroundColor: '#ea4335',
    borderColor: 'rgba(255,255,255,0.3)',
  },
  fabIcon: { fontSize: 22 },
  exitIcon: { fontSize: 20, color: '#fff', fontWeight: 'bold' as const },
});

export default MapLibreView;
