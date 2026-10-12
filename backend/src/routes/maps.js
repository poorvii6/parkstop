const router = require('express').Router();
const { authenticate } = require('../middleware/auth');

/**
 * SECURITY: every /maps/* endpoint requires a signed-in user.
 *
 * These endpoints proxy Ola Maps, which is a PAID service billed to us, and
 * /style additionally hands out OLA_MAPS_API_KEY so the client can sign its own
 * tile/sprite/glyph requests. With the router unauthenticated, anyone on the
 * internet could:
 *   - curl /maps/style and walk off with the API key, then bill Ola directly
 *     against our account until the quota (and therefore our maps) died, and
 *   - use /search, /route, /geocode, /snap-to-road, /nearby-pois as a free
 *     proxy to the same paid API.
 *
 * The per-IP limits further down are volume control, not access control — they
 * do nothing against a distributed caller. Authentication is the actual gate.
 *
 * NOTE: the key is still handed to authenticated mobile clients because
 * MapLibre must sign its own tile requests; it cannot be kept secret in an app.
 * This raises the bar from "anyone" to "someone with a valid account". Pair it
 * with a package/referrer restriction on the key in the Ola console.
 */
router.use(authenticate);

// Haversine formula to calculate distance in km
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// ── LRU Cache with TTL ──────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;

class LRUCache {
    constructor(max = CACHE_MAX, ttl = CACHE_TTL_MS) {
        this.max = max;
        this.ttl = ttl;
        this.map = new Map();
    }
    get(key) {
        const hit = this.map.get(key);
        if (!hit) return null;
        if (Date.now() - hit.time > this.ttl) {
            this.map.delete(key);
            return null;
        }
        // Move to end (most recently used)
        this.map.delete(key);
        this.map.set(key, hit);
        return hit.data;
    }
    set(key, data) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, { data, time: Date.now() });
        if (this.map.size > this.max) {
            // Evict least recently used (first entry)
            const lruKey = this.map.keys().next().value;
            this.map.delete(lruKey);
        }
    }
}

const searchCache = new LRUCache(500, CACHE_TTL_MS);

function getCached(key) { return searchCache.get(key); }
function setCached(key, data) { searchCache.set(key, data); }

// ── Simple per-IP rate limiter ──────────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_MAX_SEARCH = 60;       // 60 searches/min
const RATE_MAX_ROUTE = 30;        // 30 routes/min

function checkRateLimit(ip, type) {
    const key = `${ip}:${type}`;
    const now = Date.now();
    let entry = rateLimits.get(key);
    if (!entry || now - entry.start > RATE_WINDOW_MS) {
        entry = { count: 1, start: now };
        rateLimits.set(key, entry);
        return true;
    }
    entry.count++;
    const max = type === 'search' ? RATE_MAX_SEARCH : RATE_MAX_ROUTE;
    return entry.count <= max;
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimits) {
        if (now - entry.start > RATE_WINDOW_MS * 2) rateLimits.delete(key);
    }
}, 5 * 60 * 1000).unref();

// Step 7: Location Search (Nominatim Proxy / Ola Maps Search)
router.get('/search', async (req, res) => {
    try {
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp, 'search')) {
            return res.status(429).json({ success: false, message: 'Too many search requests. Please slow down.' });
        }

        const { q, lat, lon } = req.query;
        if (!q) return res.status(400).json({ success: false, message: 'Query required' });

        const roundedLat = lat ? parseFloat(lat).toFixed(2) : '';
        const roundedLon = lon ? parseFloat(lon).toFixed(2) : '';
        const cacheKey = `${q.toLowerCase().trim()}|${roundedLat}|${roundedLon}`;
        const cached = getCached(cacheKey);
        if (cached) {
            return res.json({ success: true, data: cached, cached: true });
        }

        // ── Google Places Autocomplete (New) — PRIMARY ──────────────────
        // Google-grade accuracy: each prediction carries a placeId, and the
        // selected one resolves to its EXACT coordinate via /place-details.
        // Autocomplete (New) is text-only (no coords) — resolution is by ID.
        const googleKey = process.env.GOOGLE_MAPS_API_KEY;
        if (googleKey) {
            try {
                const body = { input: q, includedRegionCodes: ['in'] };
                const sessiontoken = (req.query.sessiontoken || '').toString().trim();
                if (sessiontoken) body.sessionToken = sessiontoken;

                const gRes = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleKey },
                    body: JSON.stringify(body),
                });
                if (!gRes.ok) {
                    const errText = await gRes.text();
                    console.error(`[GOOGLE PLACES] Autocomplete status ${gRes.status}. ${errText}`);
                    throw new Error(`Google autocomplete ${gRes.status}`);
                }

                const gData = await gRes.json();
                const suggestions = gData.suggestions || [];
                const results = suggestions
                    .map(s => s.placePrediction)
                    .filter(p => p && p.placeId)
                    .map(p => {
                        const main = p.structuredFormat?.mainText?.text || '';
                        const secondary = p.structuredFormat?.secondaryText?.text || '';
                        return {
                            display_name: p.text?.text || [main, secondary].filter(Boolean).join(', '),
                            lat: '0',
                            lon: '0',
                            place_id: p.placeId,
                            class: 'place',
                            type: 'city',
                            address: { name: main, city: secondary },
                        };
                    })
                    .slice(0, 10);

                setCached(cacheKey, results);
                return res.json({ success: true, data: results });
            } catch (gErr) {
                console.error('[API ERROR] Google autocomplete failed, falling back to Ola:', gErr.message);
            }
        }

        const apiKey = process.env.OLA_MAPS_API_KEY;

        if (apiKey) {
            try {
                // No location bias: this is a DESTINATION search, so suggestions
                // must rank by how well they match the typed text — not by how
                // close they are to the user, which was dragging locality searches
                // (e.g. "Nagarbhavi") toward wherever the user happened to be.
                const url = `https://api.olamaps.io/places/v1/autocomplete?input=${encodeURIComponent(q)}&api_key=${apiKey}`;

                const response = await fetch(url, {
                    headers: { 'X-Request-Id': `req-${Date.now()}` }
                });
                
                if (!response.ok) {
                    const errText = await response.text();
                    if (response.status === 429) {
                        console.warn(`[OLA MAPS RATE LIMIT] Autocomplete rate limited (429). Falling back to Nominatim. Details: ${errText}`);
                    } else if (response.status === 500) {
                        console.error(`[OLA MAPS SERVER ERROR] Autocomplete server error (500). Verify API key, subscription status, and project linkage on Krutrim Cloud. Falling back to Nominatim. Details: ${errText}`);
                    } else {
                        console.error(`[OLA MAPS API ERROR] Autocomplete status ${response.status}. Details: ${errText}`);
                    }
                    throw new Error(`Ola Maps Autocomplete error: ${response.status}`);
                }

                const olaData = await response.json();
                const predictions = olaData.predictions || [];
                
                // Map Ola Maps autocomplete results to Nominatim format expected by the frontend
                const mappedData = predictions.map(item => {
                        const latVal = item.geometry?.location?.lat;
                        const lngVal = item.geometry?.location?.lng;
                        
                        return {
                            display_name: item.description || item.structured_formatting?.main_text || '',
                            lat: latVal ? latVal.toString() : '0',
                            lon: lngVal ? lngVal.toString() : '0',
                            // Google-style flow: resolve the EXACT selected place
                            // via place-details instead of re-geocoding its text.
                            place_id: item.place_id || null,
                            class: 'place',
                            type: 'city',
                            address: {
                                name: item.structured_formatting?.main_text || '',
                                city: item.structured_formatting?.secondary_text || ''
                            }
                        };
                    });

                    // Pure Ola: return the autocomplete predictions directly. Each
                    // carries a place_id, and the app resolves the SELECTED one via
                    // place-details for an exact coordinate — no OSM blend and no
                    // free-text geocode (both were the source of wrong pins).
                    // Results whose primary name starts with the query float up.
                    const ql = q.toLowerCase();
                    const prefixRank = (m) => ((m.display_name || '').split(',')[0].trim().toLowerCase().startsWith(ql) ? 0 : 1);
                    const results = mappedData
                        .filter(m => m.place_id)
                        .sort((a, b) => prefixRank(a) - prefixRank(b))
                        .slice(0, 10);

                    // Annotate distance for display only — never re-sort by it.
                    if (lat && lon) {
                        const userLat = parseFloat(lat);
                        const userLon = parseFloat(lon);
                        if (!isNaN(userLat) && !isNaN(userLon) && userLat !== 0 && userLon !== 0) {
                            results.forEach(item => {
                                const itemLat = parseFloat(item.lat);
                                const itemLon = parseFloat(item.lon);
                                if (!isNaN(itemLat) && !isNaN(itemLon) && itemLat !== 0 && itemLon !== 0) {
                                    item.distance = getDistance(userLat, userLon, itemLat, itemLon);
                                }
                            });
                        }
                    }

                    setCached(cacheKey, results);
                    return res.json({ success: true, data: results });
            } catch (olaError) {
                console.error('[API ERROR] Ola Maps search failed, falling back to Nominatim:', olaError.message);
            }
        }

        // Fallback to Nominatim
        let searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=15&addressdetails=1`;
        
        if (lat && lon) {
            const l = parseFloat(lat);
            const n = parseFloat(lon);
            if (!isNaN(l) && !isNaN(n) && l !== 0 && n !== 0) {
                const offset = 1.0; // ~100km bias box
                const viewbox = `${n-offset},${l+offset},${n+offset},${l-offset}`;
                searchUrl += `&viewbox=${viewbox}&lat=${l}&lon=${n}`;
            }
        }

        const response = await fetch(searchUrl, {
            headers: { 'User-Agent': 'ParkStop-App' }
        });
        let data = await response.json();

        if (lat && lon && Array.isArray(data)) {
            const userLat = parseFloat(lat);
            const userLon = parseFloat(lon);
            if (!isNaN(userLat) && !isNaN(userLon) && userLat !== 0 && userLon !== 0) {
                data.forEach(item => {
                    const itemLat = parseFloat(item.lat);
                    const itemLon = parseFloat(item.lon);
                    if (!isNaN(itemLat) && !isNaN(itemLon)) {
                        item.distance = getDistance(userLat, userLon, itemLat, itemLon);
                    } else {
                        item.distance = Infinity;
                    }
                });

                data.sort((a, b) => {
                    const aLocal = a.distance < 100;
                    const bLocal = b.distance < 100;
                    if (aLocal && !bLocal) return -1;
                    if (!aLocal && bLocal) return 1;
                    if (aLocal && bLocal) {
                        return a.distance - b.distance;
                    }
                    return 0;
                });
            }
        }

        if (Array.isArray(data)) {
            data = data.slice(0, 10);
        }

        setCached(cacheKey, data);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── Place details: exact coordinates for a selected autocomplete result ───
// This is how Google Maps works: autocomplete returns a place_id, selection
// resolves THAT exact place — no ambiguity, no re-geocoding of display text
// (which was landing "Tumkur" searches on "Tumkur Road, Bangalore").
router.get('/place-details', async (req, res) => {
    try {
        const placeId = (req.query.place_id || '').toString().trim();
        if (!placeId) {
            return res.status(400).json({ success: false, message: 'place_id is required' });
        }

        const cacheKey = `placedetails:${placeId}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached, cached: true });

        // ── Google Place Details (New) — PRIMARY ────────────────────
        // Essentials field mask ONLY (id, location, formattedAddress) — the
        // cheapest SKU. The place NAME comes from the tapped suggestion, so we
        // deliberately skip the pricier displayName (Pro) field.
        const googleKey = process.env.GOOGLE_MAPS_API_KEY;
        if (googleKey) {
            try {
                let dUrl = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
                const sessiontoken = (req.query.sessiontoken || '').toString().trim();
                if (sessiontoken) dUrl += `?sessionToken=${encodeURIComponent(sessiontoken)}`;
                const gRes = await fetch(dUrl, {
                    headers: {
                        'X-Goog-Api-Key': googleKey,
                        'X-Goog-FieldMask': 'id,location,formattedAddress',
                    },
                });
                if (gRes.ok) {
                    const gData = await gRes.json();
                    const loc = gData.location;
                    if (loc && loc.latitude != null && loc.longitude != null) {
                        const addr = gData.formattedAddress || '';
                        const result = {
                            lat: loc.latitude.toString(),
                            lon: loc.longitude.toString(),
                            name: (addr.split(',')[0] || '').trim(),
                            address: addr,
                        };
                        setCached(cacheKey, result);
                        return res.json({ success: true, data: result });
                    }
                } else {
                    const errText = await gRes.text();
                    console.error(`[GOOGLE PLACES] Place details status ${gRes.status}. ${errText}`);
                }
            } catch (gErr) {
                console.error('[API ERROR] Google place details failed, falling back to Ola:', gErr.message);
            }
        }

        const apiKey = process.env.OLA_MAPS_API_KEY;
        if (!apiKey) {
            return res.json({ success: false, message: 'Place details unavailable (no maps key)' });
        }

        const url = `https://api.olamaps.io/places/v1/details?place_id=${encodeURIComponent(placeId)}&api_key=${apiKey}`;
        const response = await fetch(url, { headers: { 'X-Request-Id': `req-${Date.now()}` } });
        if (response.ok) {
            const data = await response.json();
            const loc = data.result?.geometry?.location;
            if (loc && loc.lat != null && loc.lng != null) {
                const result = {
                    lat: loc.lat.toString(),
                    lon: loc.lng.toString(),
                    name: data.result?.name || '',
                    address: data.result?.formatted_address || ''
                };
                setCached(cacheKey, result);
                return res.json({ success: true, data: result });
            }
        }
        return res.json({ success: false, message: 'Place not found' });
    } catch (error) {
        console.error('[Place details error]', error.message);
        res.status(500).json({ success: false, message: 'Place details failed' });
    }
});

// ── Geocode: resolve a place name/description to coordinates ──────────────
// Ola Maps AUTOCOMPLETE returns text predictions without coordinates, so the
// frontend calls this when a suggestion is selected to get the real lat/lon
// (otherwise the map would drop the destination pin at 0,0). Falls back to
// Nominatim, which always returns coordinates.
router.get('/geocode', async (req, res) => {
    try {
        const q = (req.query.q || '').toString().trim();
        if (!q) {
            return res.status(400).json({ success: false, message: 'Query (q) is required' });
        }

        const cacheKey = `geocode:${q.toLowerCase()}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json({ success: true, data: cached, cached: true });

        // Resolve a place NAME via OpenStreetMap (Nominatim) FIRST. Ola's
        // free-text geocode is unreliable for administrative names — it has
        // dropped city/state searches tens or hundreds of km away (e.g. "Mysuru"
        // ~30km off, "Jammu and Kashmir" onto Ludhiana). Nominatim is
        // importance-ranked and returns the correct city / state / locality.
        try {
            const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&limit=1&q=${encodeURIComponent(q)}`;
            const nomRes = await fetch(nomUrl, { headers: { 'User-Agent': 'ParkStop-App' } });
            const nomData = await nomRes.json();
            if (Array.isArray(nomData) && nomData.length > 0 && nomData[0].lat && nomData[0].lon) {
                const result = { lat: nomData[0].lat, lon: nomData[0].lon };
                setCached(cacheKey, result);
                return res.json({ success: true, data: result });
            }
        } catch (nomErr) {
            console.error('[API ERROR] Nominatim geocode failed, trying Ola:', nomErr.message);
        }

        // Last resort: Ola's free-text geocode.
        const apiKey = process.env.OLA_MAPS_API_KEY;
        if (apiKey) {
            try {
                const url = `https://api.olamaps.io/places/v1/geocode?address=${encodeURIComponent(q)}&api_key=${apiKey}`;
                const response = await fetch(url, { headers: { 'X-Request-Id': `req-${Date.now()}` } });
                if (response.ok) {
                    const olaData = await response.json();
                    const loc = olaData.geocodingResults?.[0]?.geometry?.location;
                    if (loc && loc.lat != null && loc.lng != null) {
                        const result = { lat: loc.lat.toString(), lon: loc.lng.toString() };
                        setCached(cacheKey, result);
                        return res.json({ success: true, data: result });
                    }
                }
            } catch (olaError) {
                console.error('[API ERROR] Ola geocode failed:', olaError.message);
            }
        }

        return res.json({ success: false, message: 'Location not found' });
    } catch (error) {
        console.error('[Geocode error]', error.message);
        res.status(500).json({ success: false, message: 'Geocoding failed' });
    }
});

router.get('/style', async (req, res) => {
    try {
        const apiKey = process.env.OLA_MAPS_API_KEY;
        const { theme } = req.query; // 'light' or 'dark'
        const isDark = theme === 'dark';

        if (!apiKey) {
            // No API key — return Carto fallback URLs
            return res.json({
                success: true,
                data: {
                    provider: 'carto',
                    styleUrl: isDark
                        ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
                        : 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
                }
            });
        }

        // Return Ola Maps style config for the frontend to use with transformRequest
        const styleName = isDark ? 'default-dark-standard' : 'default-light-standard';
        const styleUrl = `https://api.olamaps.io/tiles/vector/v1/styles/${styleName}/style.json`;

        res.json({
            success: true,
            data: {
                provider: 'ola',
                styleUrl,
                apiKey // Frontend needs this for transformRequest on tile/sprite/glyph requests
            }
        });
    } catch (error) {
        res.json({
            success: true,
            data: {
                provider: 'carto',
                styleUrl: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
            }
        });
    }
});

module.exports = router;

