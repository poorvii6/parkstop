/**
 * Work out the camera that frames a set of coordinates.
 *
 * WHY THIS IS HAND-ROLLED
 * -----------------------
 * react-native-maps had `fitToCoordinates`, which did this natively. The
 * Navigation SDK's MapView has no equivalent — the controller offers
 * `moveCamera` and `setZoomLevel` and nothing that takes bounds. So framing a
 * route means deriving the centre and zoom ourselves.
 *
 * THE PROJECTION MATTERS
 * ----------------------
 * Google Maps uses Web Mercator, where longitude is linear but latitude is not:
 * a degree of latitude covers less screen at the equator than near the poles.
 * Fitting latitude with the same arithmetic as longitude therefore overshoots,
 * and the route ends up cropped at top and bottom. Latitude is converted to its
 * Mercator y before measuring, which is what makes the fit correct at Indian
 * latitudes as well as anywhere else.
 */

export type FitPoint = { latitude: number; longitude: number };

export type FitResult = {
  lat: number;
  lng: number;
  zoom: number;
};

/** Web Mercator y for a latitude, normalised to 0..1. */
function mercatorY(latDeg: number): number {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** Google's tile size, the unit its zoom levels are defined against. */
const TILE_SIZE = 256;

/**
 * @param points     the shape to frame (a route, a pair of pins, anything)
 * @param widthPx    usable viewport width in density-independent pixels
 * @param heightPx   usable viewport height, already reduced by any chrome
 * @param maxZoom    never zoom in past this, so two nearby points do not
 *                   slam the camera to street level
 */
export function fitBounds(
  points: FitPoint[],
  widthPx: number,
  heightPx: number,
  maxZoom = 17
): FitResult | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (widthPx <= 0 || heightPx <= 0) return null;

  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p?.latitude) || !Number.isFinite(p?.longitude)) continue;
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) return null;

  const lat = (minLat + maxLat) / 2;
  const lng = (minLng + maxLng) / 2;

  // Longitude fraction of the world. The wrap case matters: a span wider than
  // 180 degrees is shorter going the other way round the globe.
  let lngSpan = (maxLng - minLng) / 360;
  if (lngSpan < 0) lngSpan += 1;

  // Latitude fraction, measured in Mercator space rather than degrees.
  const latSpan = Math.abs(mercatorY(maxLat) - mercatorY(minLat));

  const zoomFor = (fraction: number, sizePx: number): number => {
    // A single point, or a span too small to measure, gives no constraint.
    if (fraction <= 0) return maxZoom;
    return Math.log2(sizePx / TILE_SIZE / fraction);
  };

  // The tighter of the two constraints wins, otherwise one axis overflows.
  const zoom = Math.min(zoomFor(lngSpan, widthPx), zoomFor(latSpan, heightPx), maxZoom);

  return { lat, lng, zoom: Math.max(2, zoom) };
}
