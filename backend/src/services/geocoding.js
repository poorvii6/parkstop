/**
 * Turning an address into a point, and saying how much to trust it.
 *
 * /maps/geocode used to return `{lat, lon}` and throw everything else away. For
 * the map search that was enough: the user typed a place name and the map flew
 * there. For the per-spot address check it is not, because the distance between
 * a document's address and a driveway only means something if you know what the
 * address actually resolved TO.
 *
 * WHAT NOMINATIM DOES WITH INDIAN ADDRESSES — measured, not assumed, against
 * the live API on 14 Nov 2026:
 *
 *   "No 42, 3rd Cross Road, Indiranagar, Bengaluru 560038"
 *       -> the STREET (place_rank 26), and a different stretch of it from the
 *          one the full address names. The house number is silently dropped.
 *   "Prestige Shantiniketan, Whitefield, Bengaluru"
 *       -> a BUS STOP named after the complex (rank 30, 11 m box). Fine-grained
 *          and not the building, which is why rank alone cannot be trusted.
 *   "Flat 3B, Sai Residency, Koramangala 5th Block, Bengaluru 560095"
 *       -> nothing at all.
 *   "12 1st main road jayanagar 4th block bangalore 560011"   (bill style)
 *       -> nothing at all.
 *   "Indiranagar, Bengaluru"    -> the suburb, in a box 4.4 km on a side.
 *   "560038"                    -> the postcode area, 2.4 km across.
 *   "Bengaluru"                 -> the city, 34 km across.
 *
 * So: it resolves STREETS and NAMED PLACES in Indian cities tolerably, it does
 * NOT resolve house or flat numbers at all, and it fails outright on the
 * comma-less format most Indian utility bills are printed in. Everything here
 * is built around that rather than against it.
 *
 * ONE RETRY, and only one: dropping a leading house or flat token rescued two
 * of the three failures above ("#9/1 2nd cross hosur road madiwala bangalore
 * 560068" -> Hosur Road, rank 26; the jayanagar one -> Jayanagar 4th Block,
 * rank 20). A "last few words only" fallback was tested and REJECTED: for
 * "Flat 3B, Sai Residency, Koramangala 5th Block, Bengaluru 560095" it
 * returned "5th Block, Ullalu, Bengaluru West" — about 20 km from Koramangala,
 * with every appearance of a clean hit. A confidently wrong coordinate is
 * worse than none, because a human reviewing a distance has no way to tell.
 */
const logger = require('../utils/logger');
const { bboxRadiusMetres, isInsideBbox } = require('../utils/geo');

/**
 * How precisely an address resolved. This, not the distance, is the first
 * thing a reviewer needs to know.
 */
const PRECISION = {
  /** An actual building or house. */
  BUILDING: 'building',
  /** A fine-grained named point: a shop, a bus stop, a gate. Small, but not
   *  necessarily the address on the document. */
  POINT: 'point',
  /** A road, or a segment of one. Tens to hundreds of metres long. */
  STREET: 'street',
  /** A suburb, neighbourhood, village or postcode: kilometres across. */
  LOCALITY: 'locality',
  /** A city, district or state. Tens of kilometres. */
  REGION: 'region',
  /** Resolved, but the provider told us nothing about granularity. */
  UNKNOWN: 'unknown',
};

/** Precision levels at which a measured distance is worth acting on. */
const FINE_PRECISIONS = [PRECISION.BUILDING, PRECISION.POINT, PRECISION.STREET];

/** A sensible floor for the uncertainty of each precision, in metres. */
const PRECISION_FLOOR_M = {
  [PRECISION.BUILDING]: 25,
  [PRECISION.POINT]: 50,
  [PRECISION.STREET]: 150,
  [PRECISION.LOCALITY]: 1000,
  [PRECISION.REGION]: 10000,
  [PRECISION.UNKNOWN]: 1000,
};

/** An optional word introducing a house number: "No", "Flat", "H.No.". */
const HOUSE_PREFIX_WORD = /^\s*(?:no|h\.?\s?no|house|flat|plot|door)\.?\s*/i;

/**
 * The number itself: "12", "42,", "3B,", "#9/1", "21-A".
 *
 * The second half of a divided number may be a letter ("21-A") as well as
 * another number ("9/1"), and the trailing punctuation class deliberately
 * excludes a hyphen so that a "-A" the group did not match cannot be eaten on
 * its own, leaving "A Brigade Road".
 */
const HOUSE_NUMBER = /^#?\s*\d+[a-z]?(?:\s*[/-]\s*(?:\d+[a-z]?|[a-z])\b)?\s*[,.]?\s*/i;

/**
 * An ordinal is part of a STREET name, not a house number.
 *
 * Indian addresses are full of them — "3rd Cross Road", "1st Main Road",
 * "Jayanagar 4th Block" — and stripping one is worse than not stripping
 * anything: an earlier version of this turned "3rd Cross Road, Indiranagar"
 * into "d Cross Road, Indiranagar", which geocodes to somewhere else entirely.
 */
const LEADING_ORDINAL = /^\d+(?:st|nd|rd|th)\b/i;

/**
 * Drop a leading house, flat, plot or door number — the part Nominatim cannot
 * use and that makes it return nothing at all.
 *
 * Returns the address unchanged when there is nothing safe to drop.
 */
function dropLeadingHouseNumber(address) {
  const original = String(address || '').trim();
  if (!original) return original;

  const hadPrefixWord = HOUSE_PREFIX_WORD.test(original);
  const afterWord = hadPrefixWord ? original.replace(HOUSE_PREFIX_WORD, '') : original;

  // "3rd Cross Road" with no "No"/"Flat" in front of it is a street, so leave
  // it alone. "No 42, 3rd Cross Road" is a house number followed by a street,
  // and the 42 goes.
  if (!hadPrefixWord && LEADING_ORDINAL.test(afterWord)) return original;

  const match = afterWord.match(HOUSE_NUMBER);
  if (!match) return original;

  const rest = afterWord.slice(match[0].length).trim();
  // If almost nothing survives, the number was the whole address. Searching
  // for the remnant would be worse than searching for what we were given.
  return rest.length >= 4 ? rest : original;
}

/**
 * What kind of thing Nominatim found.
 *
 * place_rank alone is not enough: the bus stop above is rank 30, the same rank
 * a house gets. The class and type say which it is.
 */
function precisionFor(hit) {
  const rank = Number(hit?.place_rank);
  const cls = String(hit?.class || '').toLowerCase();
  const type = String(hit?.type || '').toLowerCase();

  if (!Number.isFinite(rank)) return PRECISION.UNKNOWN;

  if (rank >= 30) {
    const isBuilding = cls === 'building'
      || (cls === 'place' && ['house', 'building', 'apartments', 'residential'].includes(type));
    return isBuilding ? PRECISION.BUILDING : PRECISION.POINT;
  }
  if (rank >= 26) return PRECISION.STREET;
  if (rank >= 16) return PRECISION.LOCALITY;
  return PRECISION.REGION;
}

/** The uncertainty to allow for a hit: its own size, floored by its kind. */
function uncertaintyFor(hit, precision) {
  const fromBox = bboxRadiusMetres(hit?.boundingbox);
  const floor = PRECISION_FLOOR_M[precision] ?? PRECISION_FLOOR_M[PRECISION.UNKNOWN];
  return Math.round(Math.max(fromBox ?? 0, floor));
}

function shapeNominatim(hit, source) {
  const precision = precisionFor(hit);
  return {
    lat: String(hit.lat),
    lon: String(hit.lon),
    precision,
    uncertainty_m: uncertaintyFor(hit, precision),
    source,
    display_name: hit.display_name || null,
    bbox: Array.isArray(hit.boundingbox) ? hit.boundingbox.map(Number) : null,
    place_rank: Number(hit.place_rank) || null,
    kind: `${hit.class || '?'}/${hit.type || '?'}`,
  };
}

async function askNominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search'
    + `?format=json&countrycodes=in&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ParkStop-App' } });
  if (!res.ok) return null;
  const body = await res.json();
  const hit = Array.isArray(body) && body.length > 0 ? body[0] : null;
  return hit && hit.lat && hit.lon ? hit : null;
}

/**
 * Ola's free-text geocode: the last resort.
 *
 * It returns a point and nothing about granularity, so the precision is
 * honestly UNKNOWN and the uncertainty is a kilometre. routes/maps.js records
 * it dropping administrative names tens of kilometres away ("Mysuru" ~30 km
 * off, "Jammu and Kashmir" onto Ludhiana), which is exactly why a hit from
 * here can never read as confirmation of an address.
 */
async function askOla(q) {
  const apiKey = process.env.OLA_MAPS_API_KEY;
  if (!apiKey) return null;

  const url = `https://api.olamaps.io/places/v1/geocode?address=${encodeURIComponent(q)}&api_key=${apiKey}`;
  const res = await fetch(url, { headers: { 'X-Request-Id': `req-${Date.now()}` } });
  if (!res.ok) return null;

  const body = await res.json();
  const loc = body.geocodingResults?.[0]?.geometry?.location;
  if (!loc || loc.lat == null || loc.lng == null) return null;

  return {
    lat: String(loc.lat),
    lon: String(loc.lng),
    precision: PRECISION.UNKNOWN,
    uncertainty_m: PRECISION_FLOOR_M[PRECISION.UNKNOWN],
    source: 'ola',
    display_name: body.geocodingResults?.[0]?.formatted_address || null,
    bbox: null,
    place_rank: null,
    kind: null,
  };
}

/**
 * Geocode an address.
 *
 * Nominatim first (it is importance-ranked and gets administrative names
 * right, where Ola has been tens of kilometres out), then the house-token
 * retry, then Ola. Returns null when nothing resolves — which is a usable
 * answer, not an error, and must never be read as a pass.
 *
 * @returns {Promise<null|{lat: string, lon: string, precision: string,
 *   uncertainty_m: number, source: string, display_name: string|null,
 *   bbox: number[]|null, place_rank: number|null, kind: string|null}>}
 */
async function geocodeAddress(query) {
  const q = String(query || '').trim();
  if (!q) return null;

  try {
    const direct = await askNominatim(q);
    if (direct) return shapeNominatim(direct, 'nominatim');
  } catch (e) {
    logger.warn(`Nominatim geocode failed for "${q.slice(0, 40)}": ${e.message}`);
  }

  // The one retry. A house or flat number is not something Nominatim can use,
  // and leaving it on is the difference between a street and nothing at all.
  const withoutHouseNumber = dropLeadingHouseNumber(q);
  if (withoutHouseNumber && withoutHouseNumber !== q) {
    try {
      const retried = await askNominatim(withoutHouseNumber);
      if (retried) return shapeNominatim(retried, 'nominatim:no-house');
    } catch (e) {
      logger.warn(`Nominatim retry failed for "${q.slice(0, 40)}": ${e.message}`);
    }
  }

  try {
    const ola = await askOla(q);
    if (ola) return ola;
  } catch (e) {
    logger.warn(`Ola geocode failed for "${q.slice(0, 40)}": ${e.message}`);
  }

  return null;
}

module.exports = {
  geocodeAddress,
  precisionFor,
  uncertaintyFor,
  isInsideBbox,
  PRECISION,
  FINE_PRECISIONS,
  PRECISION_FLOOR_M,
  dropLeadingHouseNumber,
};
