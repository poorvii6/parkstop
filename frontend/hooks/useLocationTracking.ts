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
              Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
              new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000)),
            ]) as Location.LocationObject;
          } catch {
            location = await Location.getLastKnownPositionAsync({}).catch(() => null);
          }

          if (location) {
            coords = { lat: location.coords.latitude, lng: location.coords.longitude };
            if (shouldSyncToBackend) syncLocation(coords);
          }

          // Start live tracking separately: if location services are disabled these
          // can throw, and that must NOT discard the fix we already obtained above.
          try {
            watchSub = await Location.watchPositionAsync({
              accuracy: Location.Accuracy.Balanced,
              timeInterval: 5000,
              distanceInterval: 20,
            }, (loc) => {
              const newCoords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
              const dy = newCoords.lat - lastUpdateCoords.current.lat;
              const dx = newCoords.lng - lastUpdateCoords.current.lng;
              const dist = Math.sqrt(dx * dx + dy * dy) * 111000;

              if (dist > 15) {
                lastUpdateCoords.current = newCoords;
                setUserLocation(newCoords);
                if (shouldSyncToBackend) syncLocation(newCoords);
              }
            });

            headingSub = await Location.watchHeadingAsync((h) => {
              setDeviceHeading(h.trueHeading);
            });
          } catch (watchErr) {
            console.log('[Location] Live tracking unavailable:', (watchErr as any).message);
          }
        }
      } catch (error) {
        console.log('[Location] Error during initialization:', error);
      }

      setUserLocation(coords);
      lastUpdateCoords.current = coords;

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
