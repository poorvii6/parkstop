/**
 * Distances, in one place.
 *
 * There were two copies of this arithmetic: a flat-earth `metresBetween`
 * private to ParkingSpot.js (added with the pin freeze) and a Haversine
 * `getDistance` in kilometres inside routes/maps.js, which also decides
 * whether a navigation request is too far to serve. Two formulas, two units,
 * and the per-spot address check needed a third caller — so they live here.
 *
 * Both are used: metres for anything local (how far a pin moved, how far a
 * document's address is from a driveway), kilometres with the proper spherical
 * formula for anything that might span a city or more.
 */

/** Metres per degree of latitude. Varies by under 1% over India. */
const M_PER_DEG_LAT = 110540;
/** Metres per degree of longitude at the equator; scaled by cos(lat). */
const M_PER_DEG_LON = 111320;
const EARTH_RADIUS_KM = 6371;

/**
 * Metres between two coordinates. Flat-earth, which is ample at this scale:
 * over a kilometre in Bengaluru it differs from the spherical answer by
 * centimetres, and every caller is comparing against a tolerance of metres.
 */
function metresBetween(aLat, aLng, bLat, bLng) {
  const dx = (bLng - aLng) * M_PER_DEG_LON * Math.cos((aLat * Math.PI) / 180);
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Kilometres between two coordinates, Haversine. For city-scale and up. */
function kmBetween(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
      * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * How big the thing a geocoder found actually is, as a radius in metres.
 *
 * This is the number that decides whether a measured distance means anything.
 * A geocoded house has a bounding box a few metres across; "Indiranagar,
 * Bengaluru" comes back as a box 4.4 km on a side. Being 800 m from the centre
 * of the first is a different fact from being 800 m from the centre of the
 * second, and without this they are the same number.
 *
 * @param {Array<string|number>} bbox  Nominatim order: [south, north, west, east]
 * @returns {number|null} half the longer side, or null if there is no box
 */
function bboxRadiusMetres(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [south, north, west, east] = bbox.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return null;

  const midLat = (south + north) / 2;
  const heightM = Math.abs(north - south) * M_PER_DEG_LAT;
  const widthM = Math.abs(east - west) * M_PER_DEG_LON * Math.cos((midLat * Math.PI) / 180);

  return Math.max(heightM, widthM) / 2;
}

/** Whether a point falls inside a Nominatim bounding box. */
function isInsideBbox(lat, lng, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [south, north, west, east] = bbox.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return false;
  return lat >= south && lat <= north && lng >= west && lng <= east;
}

module.exports = { metresBetween, kmBetween, bboxRadiusMetres, isInsideBbox };
