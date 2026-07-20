/**
 * Map fallback constants.
 *
 * A map has to render *some* viewport before the first GPS fix arrives. This is
 * that fallback and nothing more — it is never used once a real location is
 * available, and it is never persisted or sent to the backend.
 *
 * Override at build time with EXPO_PUBLIC_DEFAULT_LAT / EXPO_PUBLIC_DEFAULT_LNG
 * so the value isn't baked into source.
 */
export const DEFAULT_MAP_CENTER = {
  lat: Number(process.env.EXPO_PUBLIC_DEFAULT_LAT ?? 20.5937), // geographic centre of India
  lng: Number(process.env.EXPO_PUBLIC_DEFAULT_LNG ?? 78.9629),
};

/** Zoom used for the fallback view — wide, so it never implies a precise place. */
export const DEFAULT_MAP_ZOOM = Number(process.env.EXPO_PUBLIC_DEFAULT_ZOOM ?? 4);

/** Zoom used once a real user location is known. */
export const USER_MAP_ZOOM = 15;
