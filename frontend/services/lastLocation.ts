/**
 * Remembers the user's last known map position across app launches.
 *
 * Why this exists: without it, every cold start renders the country-wide
 * fallback viewport (centre of India, zoom 4) until the first GPS fix lands,
 * then flies ~1500km to the user. That flight is the single most amateurish
 * thing the map does — real map apps open roughly where you last were and
 * refine from there.
 *
 * This is a VIEWPORT HINT only. It is never sent to the backend, never used
 * for booking, distance, or arrival logic, and is discarded once stale.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'parkstop_last_map_location';

/** Older than this and the hint is worse than useless — the user may have flown. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type Coords = { lat: number; lng: number };

/**
 * Persist the latest fix. Fire-and-forget: a storage failure must never
 * interfere with showing the user their location.
 */
export async function saveLastLocation(coords: Coords): Promise<void> {
  try {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ lat: coords.lat, lng: coords.lng, t: Date.now() })
    );
  } catch {
    // ignore — this is only an optimisation
  }
}

/**
 * Read the remembered position, or null if absent, stale, or malformed.
 */
export async function loadLastLocation(): Promise<Coords | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const { lat, lng, t } = parsed || {};

    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    // Guard against a corrupted entry pointing somewhere impossible.
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (typeof t !== 'number' || Date.now() - t > MAX_AGE_MS) return null;

    return { lat, lng };
  } catch {
    return null;
  }
}
