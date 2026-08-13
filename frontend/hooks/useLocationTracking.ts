import { useState, useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import apiClient from '../api/client';
import { DEFAULT_MAP_CENTER } from '../constants/mapDefaults';

export function useLocationTracking(
  onLocationInit?: (coords: { lat: number, lng: number }) => void,
  shouldSyncToBackend: boolean = false
) {
  const [userLocation, setUserLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [deviceHeading, setDeviceHeading] = useState<number>(0);
  const lastUpdateCoords = useRef({ lat: 0, lng: 0 });
  const lastSyncTime = useRef(0);

  const syncLocation = async (coords: { lat: number, lng: number }) => {
    try {
      // Throttle syncs to once every 30 seconds to save battery
      const now = Date.now();
      if (now - lastSyncTime.current < 30000) return;

      await apiClient.post('/locations/update', {
        latitude: coords.lat,
        longitude: coords.lng
      });
      lastSyncTime.current = now;
      console.log("[Location] Sync successful");
    } catch (error) {
      // Silent error for location sync
      console.log("[Location] Sync failed:", (error as any).message);
    }
  };

  useEffect(() => {
    let watchSub: Location.LocationSubscription | null = null;
    let headingSub: any = null;
    
    (async () => {
      // Neutral fallback used only if no real fix can be obtained.
      let coords = { ...DEFAULT_MAP_CENTER };
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();

        if (status === 'granted') {
          // Try a fresh fix; if it's unavailable or times out, fall back to the
          // last known position before giving up on a real location entirely.
          let location: Location.LocationObject | null = null;
          try {
            location = await Promise.race([
              // HIGH, not Balanced. Balanced is roughly 100m, which in a
              // parking app is the difference between the right driveway and
              // the next street — and this fix seeds "spots near me".
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
              new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000)),
            ]) as Location.LocationObject;
          } catch {
            // Bounded rather than "anything ever cached": a fix from yesterday
            // in another city is worse than none, because everything
            // downstream treats it as where the rider is standing.
            location = await Location.getLastKnownPositionAsync({
              maxAge: 5 * 60 * 1000,
              requiredAccuracy: 500,
            }).catch(() => null);
          }

          if (location) {
            coords = { lat: location.coords.latitude, lng: location.coords.longitude };
            if (shouldSyncToBackend) syncLocation(coords);
          }

          // Start live tracking separately: if location services are disabled these
          // can throw, and that must NOT discard the fix we already obtained above.
          try {
            watchSub = await Location.watchPositionAsync({
              // Same reasoning as the initial fix: this drives the blue dot,
              // the distance-to-spot readout and the arrival geofence, none of
              // which survive a 100m error.
              accuracy: Location.Accuracy.High,
              timeInterval: 3000,
              // Was 20m, with a further 15m filter below — so the dot advanced
              // in 20m hops and stood still for the length of a driveway. 6m
              // is roughly a car length: smooth enough to look live, coarse
              // enough not to chase GPS jitter while parked.
              distanceInterval: 6,
            }, (loc) => {
              const newCoords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
              const dy = newCoords.lat - lastUpdateCoords.current.lat;
              const dx = newCoords.lng - lastUpdateCoords.current.lng;
              // Longitude degrees shrink with latitude; ignoring that made the
              // east-west component read ~2.5% long in southern India and more
              // further north. Cheap to do correctly.
              const dist =
                Math.sqrt(
                  dy * dy + dx * dx * Math.pow(Math.cos((newCoords.lat * Math.PI) / 180), 2)
                ) * 111000;

              if (dist > 5) {
                lastUpdateCoords.current = newCoords;
                setUserLocation(newCoords);
                if (shouldSyncToBackend) syncLocation(newCoords);
              }
            });

            headingSub = await Location.watchHeadingAsync((h) => {
              // trueHeading is -1 whenever the device cannot resolve magnetic
              // declination — common on Android until the compass is
              // calibrated. Feeding -1 through as a bearing points everything
              // the wrong way, so fall back to magnetic, which is close enough
              // for orienting a map and is almost always available.
              const heading =
                typeof h.trueHeading === 'number' && h.trueHeading >= 0
                  ? h.trueHeading
                  : h.magHeading;
              if (typeof heading === 'number' && heading >= 0) setDeviceHeading(heading);
            });
          } catch (watchErr) {
            console.log('[Location] Live tracking unavailable:', (watchErr as any).message);
          }
        }
      } catch (error) {
        console.log('[Location] Error during initialization:', error);
      }

      // Do NOT clobber a newer fix.
      //
      // The watcher above is already running by the time this line is reached,
      // and on a warm GPS it can deliver a better position first. Writing
      // `coords` unconditionally then threw that away and moved the rider back
      // to the older fix — a visible jump of the blue dot on launch.
      setUserLocation(prev => prev ?? coords);
      if (lastUpdateCoords.current.lat === 0 && lastUpdateCoords.current.lng === 0) {
        lastUpdateCoords.current = coords;
      }

      if (onLocationInit) {
        onLocationInit(coords);
      }
    })();

    return () => {
      if (watchSub) watchSub.remove();
      if (headingSub) headingSub.remove();
    };
  }, []);

  return { userLocation, setUserLocation, deviceHeading, lastUpdateCoords };
}
