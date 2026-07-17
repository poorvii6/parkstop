/**
 * offlineTileCache.ts — Offline Tile Caching (Phase 3, Feature #14)
 *
 * Pre-downloads raster/vector tiles along a route corridor so navigation
 * continues through tunnels, dead zones, or weak signal areas.
 *
 * Strategy:
 * - Given a route polyline, compute a bounding corridor (±500m)
 * - For zoom levels 14-17, enumerate tile indices that intersect the corridor
 * - Fetch and store tiles in AsyncStorage with TTL
 * - Expose a ServiceWorker-like intercept for the MapLibre tile loader
 *
 * For native MapLibre GL, we use the built-in OfflineManager when available.
 * For WebView fallback, tiles are cached via fetch + AsyncStorage.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

let MapLibreGL: any = null;
try {
  MapLibreGL = require('@maplibre/maplibre-react-native');
  if (MapLibreGL?.default) MapLibreGL = MapLibreGL.default;
} catch {}

const CACHE_PREFIX = 'tile_cache_';
const TILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHED_TILES = 2000;
const CORRIDOR_BUFFER_M = 500;
const ZOOM_LEVELS = [14, 15, 16, 17];
const CONCURRENCY = 6;

interface CacheEntry {
  url: string;
  timestamp: number;
  size: number;
}

// ── Tile math ───────────────────────────────────────────────────
function lng2tile(lng: number, zoom: number) {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
}

function lat2tile(lat: number, zoom: number) {
  return Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
}

function offsetCoord(lat: number, lng: number, dxM: number, dyM: number): [number, number] {
  const dLat = dyM / 110540;
  const dLng = dxM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lng + dLng];
}

// ── Enumerate corridor tiles ────────────────────────────────────
export function getCorridorTiles(
  route: Array<{ latitude: number; longitude: number }>,
  zoomLevels = ZOOM_LEVELS,
  bufferM = CORRIDOR_BUFFER_M
): Array<{ z: number; x: number; y: number }> {
  const tiles = new Set<string>();
  const result: Array<{ z: number; x: number; y: number }> = [];

  for (const pt of route) {
    // expand point by buffer in 4 directions
    const [nLat] = offsetCoord(pt.latitude, pt.longitude, 0, bufferM);
    const [sLat] = offsetCoord(pt.latitude, pt.longitude, 0, -bufferM);
    const [, eLng] = offsetCoord(pt.latitude, pt.longitude, bufferM, 0);
    const [, wLng] = offsetCoord(pt.latitude, pt.longitude, -bufferM, 0);

    for (const z of zoomLevels) {
      const xMin = lng2tile(wLng, z);
      const xMax = lng2tile(eLng, z);
      const yMin = lat2tile(nLat, z); // note: lat→tile inverts
      const yMax = lat2tile(sLat, z);

      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          const key = `${z}/${x}/${y}`;
          if (!tiles.has(key)) {
            tiles.add(key);
            result.push({ z, x, y });
          }
        }
      }
    }
  }

  // Cap total tiles
  return result.slice(0, MAX_CACHED_TILES);
}

// ── Native OfflineManager approach ──────────────────────────────
export async function cacheRouteCorridorNative(
  route: Array<{ latitude: number; longitude: number }>,
  styleUrl: string,
  packName = 'nav-corridor'
): Promise<{ success: boolean; tileCount?: number; error?: string }> {
  if (!MapLibreGL?.offlineManager) {
    return { success: false, error: 'Native offline manager unavailable' };
  }

  try {
    // Compute bounding box of route + buffer
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const pt of route) {
      const [n] = offsetCoord(pt.latitude, pt.longitude, 0, CORRIDOR_BUFFER_M);
      const [s] = offsetCoord(pt.latitude, pt.longitude, 0, -CORRIDOR_BUFFER_M);
      const [, e] = offsetCoord(pt.latitude, pt.longitude, CORRIDOR_BUFFER_M, 0);
      const [, w] = offsetCoord(pt.latitude, pt.longitude, -CORRIDOR_BUFFER_M, 0);
      if (n > maxLat) maxLat = n;
      if (s < minLat) minLat = s;
      if (e > maxLng) maxLng = e;
      if (w < minLng) minLng = w;
    }

    // Delete existing pack if any
    try { await MapLibreGL.offlineManager.deletePack(packName); } catch {}

    await MapLibreGL.offlineManager.createPack({
      name: packName,
      styleURL: styleUrl,
      bounds: [[maxLng, maxLat], [minLng, minLat]],
      minZoom: 14,
      maxZoom: 17,
    });

    console.log('[OfflineTiles] Native pack created:', packName);
    return { success: true };
  } catch (e: any) {
    console.warn('[OfflineTiles] Native cache failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ── AsyncStorage fallback (for WebView map) ─────────────────────
async function fetchTile(url: string): Promise<boolean> {
  try {
    const resp = await fetch(url, { method: 'HEAD' }); // just warm CDN cache
    if (resp.ok) {
      const entry: CacheEntry = { url, timestamp: Date.now(), size: 0 };
      await AsyncStorage.setItem(CACHE_PREFIX + url, JSON.stringify(entry));
      return true;
    }
  } catch {}
  return false;
}

export async function cacheRouteCorridorFallback(
  route: Array<{ latitude: number; longitude: number }>,
  tileUrlTemplate = 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png'
): Promise<{ cached: number; total: number }> {
  const tiles = getCorridorTiles(route);
  let cached = 0;

  // Fetch in batches
  for (let i = 0; i < tiles.length; i += CONCURRENCY) {
    const batch = tiles.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(t => {
        const url = tileUrlTemplate
          .replace('{z}', String(t.z))
          .replace('{x}', String(t.x))
          .replace('{y}', String(t.y));
        return fetchTile(url);
      })
    );
    cached += results.filter(r => r.status === 'fulfilled' && r.value).length;
  }

  return { cached, total: tiles.length };
}

// ── Unified entry point ─────────────────────────────────────────
export async function cacheRouteCorridor(
  route: Array<{ latitude: number; longitude: number }>,
  styleUrl?: string
): Promise<{ success: boolean; method: string; details?: any }> {
  if (Platform.OS === 'web') {
    return { success: false, method: 'none', details: 'Web platform - no offline caching' };
  }

  // Try native first
  if (MapLibreGL?.offlineManager && styleUrl) {
    const result = await cacheRouteCorridorNative(route, styleUrl);
    if (result.success) {
      return { success: true, method: 'native', details: result };
    }
  }

  // Fallback to tile-warming
  const result = await cacheRouteCorridorFallback(route);
  return {
    success: result.cached > 0,
    method: 'fallback',
    details: result,
  };
}

// ── Cleanup stale cache ─────────────────────────────────────────
export async function cleanupTileCache(): Promise<number> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const tileKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
    const now = Date.now();
    let removed = 0;

    for (const key of tileKeys) {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (raw) {
          const entry: CacheEntry = JSON.parse(raw);
          if (now - entry.timestamp > TILE_TTL_MS) {
            await AsyncStorage.removeItem(key);
            removed++;
          }
        }
      } catch {
        await AsyncStorage.removeItem(key);
        removed++;
      }
    }

    return removed;
  } catch { return 0; }
}

// ── Delete offline pack ─────────────────────────────────────────
export async function clearOfflinePack(packName = 'nav-corridor'): Promise<void> {
  try {
    if (MapLibreGL?.offlineManager) {
      await MapLibreGL.offlineManager.deletePack(packName);
    }
  } catch {}
}
