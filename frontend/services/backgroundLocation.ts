/**
 * backgroundLocation.ts — Background Location Service (Phase 3, Feature #13)
 *
 * Uses expo-task-manager + expo-location to keep receiving GPS updates
 * when the app is backgrounded during active navigation.
 *
 * The task stores the latest position in a shared EventEmitter so the
 * finder screen can pick it up on foreground or via listeners.
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

const BG_LOCATION_TASK = 'parkstop-bg-location';

// ── Lightweight event bus ───────────────────────────────────────
type LocationCallback = (coords: {
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  timestamp: number;
}) => void;

const listeners = new Set<LocationCallback>();
let lastKnownLocation: ReturnType<LocationCallback extends (c: infer T) => void ? () => T : never> | null = null;

export function onBackgroundLocation(cb: LocationCallback) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getLastBackgroundLocation() {
  return lastKnownLocation;
}

// ── Define the background task ──────────────────────────────────
TaskManager.defineTask(BG_LOCATION_TASK, ({ data, error }: any) => {
  if (error) {
    console.warn('[BG Location] Error:', error.message);
    return;
  }
  if (data?.locations?.length) {
    const loc = data.locations[data.locations.length - 1]; // most recent
    const payload = {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      heading: loc.coords.heading ?? null,
      speed: loc.coords.speed ?? null,
      accuracy: loc.coords.accuracy ?? null,
      timestamp: loc.timestamp,
    };
    lastKnownLocation = payload as any;
    listeners.forEach(cb => {
      try { cb(payload); } catch {}
    });
  }
});

// ── Start / Stop helpers ────────────────────────────────────────
export async function startBackgroundLocation(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  try {
    const { status: fg } = await Location.requestForegroundPermissionsAsync();
    if (fg !== 'granted') return false;

    const { status: bg } = await Location.requestBackgroundPermissionsAsync();
    if (bg !== 'granted') {
      console.warn('[BG Location] Background permission denied');
      return false;
    }

    const isRunning = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
    if (isRunning) return true; // already running

    await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: 1000,        // ~1 update/sec
      distanceInterval: 3,       // minimum 3m movement
      foregroundService: {
        notificationTitle: 'ParkStop Navigation',
        notificationBody: 'Navigating to your parking spot',
        notificationColor: '#4285F4',
      },
      // Android: show as foreground service notification
      showsBackgroundLocationIndicator: true, // iOS: blue bar
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
    });

    console.log('[BG Location] Started');
    return true;
  } catch (e: any) {
    console.error('[BG Location] Start failed:', e.message);
    return false;
  }
}

export async function stopBackgroundLocation(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const isRunning = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
    if (isRunning) {
      await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
      console.log('[BG Location] Stopped');
    }
  } catch (e: any) {
    console.error('[BG Location] Stop failed:', e.message);
  }
  lastKnownLocation = null;
}

export async function isBackgroundLocationRunning(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
  } catch { return false; }
}
