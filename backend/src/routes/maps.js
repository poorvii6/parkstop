const router = require('express').Router();

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

// City-level lookup (Nominatim, India): Ola's location-biased autocomplete
// sometimes omits the real city entirely (typing "Hubli" near Bangalore only
// returned a Bangalore bus stop named "Hubli"). Genuine city/town matches are
// blended to the top of suggestions with authoritative coordinates.
async function fetchIndianCityMatches(q) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=0&countrycodes=in`;
        const r = await fetch(url, { headers: { 'User-Agent': 'ParkStop-App' } });
        if (!r.ok) return [];
        const data = await r.json();
        return (Array.isArray(data) ? data : [])
            .filter(it =>
                (it.class === 'place' && ['city', 'town', 'village', 'municipality', 'suburb'].includes(it.type)) ||
                (it.class === 'boundary' && it.type === 'administrative')
            )
            .slice(0, 3)
            .map(it => ({
                display_name: it.display_name,
                lat: it.lat,
                lon: it.lon,
                place_id: null,
                verified: true, // coords are authoritative — no re-resolution needed
                class: 'place',
                type: it.type === 'administrative' ? 'city' : it.type,
                address: { name: (it.display_name || '').split(',')[0], city: '' }
            }));
    } catch {
        return [];
    }
}

const searchCache = new LRUCache(500, CACHE_TTL_MS);
const routeCache = new LRUCache(200, 10 * 60 * 1000); // 10 min TTL for routes

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

        const apiKey = process.env.OLA_MAPS_API_KEY;

        if (apiKey) {
            try {
                // City lookup runs in PARALLEL with Ola — no added latency.
                const cityPromise = q.length >= 3 ? fetchIndianCityMatches(q) : Promise.resolve([]);
                let url = `https://api.olamaps.io/places/v1/autocomplete?input=${encodeURIComponent(q)}&api_key=${apiKey}`;
                if (lat && lon) {
                    const l = parseFloat(lat);
                    const n = parseFloat(lon);
                    if (!isNaN(l) && !isNaN(n) && l !== 0 && n !== 0) {
                        url += `&location=${l},${n}`;
                    }
                }

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

                    // Blend authoritative city/town matches on TOP of Ola's
                    // results (Google-style): real cities always appear even
                    // when Ola's biased autocomplete omits them. Ola entries
                    // whose name exactly matches a blended city are dropped as
                    // lookalike noise (e.g. a Bangalore bus stop named "Hubli").
                    const cityMatches = await cityPromise;
                    const cityNames = new Set(cityMatches.map(c => (c.display_name || '').split(',')[0].trim().toLowerCase()));
                    const filteredOla = mappedData.filter(m => {
                        const first = (m.display_name || '').split(',')[0].trim().toLowerCase();
                        return !cityNames.has(first);
                    });
                    const merged = [...cityMatches, ...filteredOla].slice(0, 10);

                    // Annotate distance for display only — NEVER re-sort by it
                    // (distance-sorting is what buried real cities under nearby
                    // lookalikes in the first place).
                    if (lat && lon) {
                        const userLat = parseFloat(lat);
                        const userLon = parseFloat(lon);
                        if (!isNaN(userLat) && !isNaN(userLon) && userLat !== 0 && userLon !== 0) {
                            merged.forEach(item => {
                                const itemLat = parseFloat(item.lat);
                                const itemLon = parseFloat(item.lon);
                                if (!isNaN(itemLat) && !isNaN(itemLon) && itemLat !== 0 && itemLon !== 0) {
                                    item.distance = getDistance(userLat, userLon, itemLat, itemLon);
                                }
                            });
                        }
                    }

                    setCached(cacheKey, merged);
                    return res.json({ success: true, data: merged });
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
                console.error('[API ERROR] Ola geocode failed, falling back to Nominatim:', olaError.message);
            }
        }

        // Nominatim fallback — always returns coordinates for a resolvable place.
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`;
        const response = await fetch(url, { headers: { 'User-Agent': 'ParkStop-App' } });
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0 && data[0].lat && data[0].lon) {
            const result = { lat: data[0].lat, lon: data[0].lon };
            setCached(cacheKey, result);
            return res.json({ success: true, data: result });
        }

        return res.json({ success: false, message: 'Location not found' });
    } catch (error) {
        console.error('[Geocode error]', error.message);
        res.status(500).json({ success: false, message: 'Geocoding failed' });
    }
});

// Polyline decoder to convert Google/Ola encoded polyline to GeoJSON coordinates [lng, lat]
function decodePolyline(str, precision = 5) {
    let index = 0,
        lat = 0,
        lng = 0,
        coordinates = [],
        shift = 0,
        result = 0,
        byte = null,
        latitude_change,
        longitude_change,
        factor = Math.pow(10, precision);

    while (index < str.length) {
        byte = null;
        shift = 0;
        result = 0;

        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

        shift = 0;
        result = 0;

        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

        lat += latitude_change;
        lng += longitude_change;

        coordinates.push([lng / factor, lat / factor]);
    }

    return coordinates;
}

// Helper to parse "lng,lat" string into { lat, lng }
function parseCoords(coordStr) {
    if (!coordStr) return null;
    const parts = coordStr.split(',');
    if (parts.length !== 2) return null;
    const lng = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (isNaN(lng) || isNaN(lat)) return null;
    return { lat, lng };
}

// Helper to parse pipe-separated waypoints "lng1,lat1|lng2,lat2" into array of { lat, lng }
function parseWaypoints(waypointsStr) {
    if (!waypointsStr) return null;
    const pts = waypointsStr.split('|');
    const result = [];
    for (const pt of pts) {
        const coords = parseCoords(pt);
        if (coords) {
            result.push(coords);
        }
    }
    return result;
}

// Step 6 & 10: Routing (OSRM Proxy / Ola Maps Adapter)
router.get('/route', async (req, res) => {
    const { start, end, waypoints, overview, alternatives } = req.query; // Format for start/end: "lng,lat"

    // Build cache key early so it's accessible in the fallback catch block
    let routeCacheKey = '';
    if (start && end) {
        const parts = [start, end].map(s => {
            const p = s.split(',');
            return `${parseFloat(p[0]).toFixed(3)},${parseFloat(p[1]).toFixed(3)}`;
        });
        routeCacheKey = `${parts[0]}|${parts[1]}|${waypoints || ''}`;
    }

    try {
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp, 'route')) {
            return res.status(429).json({ success: false, message: 'Too many route requests. Please slow down.' });
        }

        if (!start || !end) return res.status(400).json({ success: false, message: 'Start and end required' });

        const startCoords = parseCoords(start);
        const endCoords = parseCoords(end);
        if (!startCoords || !endCoords) {
            return res.status(400).json({ success: false, message: 'Invalid start or end coordinates format. Expected "lng,lat"' });
        }

        // Check route cache
        const cachedRoute = routeCache.get(routeCacheKey);
        if (cachedRoute) {
            return res.json({ success: true, data: cachedRoute, cached: true });
        }

        const apiKey = process.env.OLA_MAPS_API_KEY;

        // Tune route detail (overview) and alternatives
        const overviewVal = ['full', 'simplified', 'false'].includes(overview) ? overview : 'full';
        const alternativesVal = alternatives === 'true';

        if (!apiKey) {
            // Fallback to OSRM if OLA_MAPS_API_KEY is not set
            const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=${overviewVal}&alternatives=${alternativesVal}&geometries=geojson&steps=true`);
            const data = await response.json();
            routeCache.set(routeCacheKey, data);
            return res.json({ success: true, data });
        }

        // Convert start and end from "lng,lat" to "lat,lng" for Ola Maps
        const origin = `${startCoords.lat},${startCoords.lng}`;
        const destination = `${endCoords.lat},${endCoords.lng}`;

        // Format waypoints for Ola Maps: pipe-separated "lat,lng"
        let waypointsQuery = '';
        if (waypoints) {
            const parsedWpts = parseWaypoints(waypoints);
            if (parsedWpts && parsedWpts.length > 0) {
                const wptsFormatted = parsedWpts.map(w => `${w.lat},${w.lng}`).join('|');
                waypointsQuery = `&waypoints=${encodeURIComponent(wptsFormatted)}`;
            }
        }

        const url = `https://api.olamaps.io/routing/v1/directions?origin=${origin}&destination=${destination}&overview=${overviewVal}&alternatives=${alternativesVal}&api_key=${apiKey}${waypointsQuery}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-Request-Id': `req-${Date.now()}`
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            if (response.status === 429) {
                console.warn(`[OLA MAPS RATE LIMIT] Directions rate limited (429). Falling back to OSRM. Details: ${errText}`);
            } else if (response.status === 500) {
                console.error(`[OLA MAPS SERVER ERROR] Directions server error (500). Verify API key, subscription status, and project linkage on Krutrim Cloud. Falling back to OSRM. Details: ${errText}`);
            } else {
                console.error(`[OLA MAPS API ERROR] Directions status ${response.status}. Details: ${errText}`);
            }
            throw new Error(`Ola Maps API error: ${response.status} - ${errText}`);
        }

        const olaData = await response.json();
        
        if (!olaData.routes || olaData.routes.length === 0) {
            throw new Error('No routes found from Ola Maps');
        }

        // Map all routes to OSRM-compatible format
        const osrmRoutes = olaData.routes.map(route => {
            const leg = route.legs?.[0] || {};
            const points = typeof route.overview_polyline === 'string' 
                ? route.overview_polyline 
                : (route.overview_polyline?.points || '');
            const coordinates = points ? decodePolyline(points) : [];

            // Map Ola steps to OSRM-compatible steps
            const steps = (leg.steps || []).map(s => {
                const instr = s.instructions || s.instruction || '';
                const lowerInstr = instr.toLowerCase();
                const lowerManeuver = (s.maneuver || '').toLowerCase();
                
                let type = 'continue';
                let modifier = 'straight';
                
                if (lowerManeuver.includes('left') || lowerInstr.includes('left')) {
                    type = 'turn';
                    modifier = 'left';
                } else if (lowerManeuver.includes('right') || lowerInstr.includes('right')) {
                    type = 'turn';
                    modifier = 'right';
                } else if (lowerManeuver.includes('u-turn') || lowerManeuver.includes('uturn') || lowerInstr.includes('u-turn')) {
                    type = 'turn';
                    modifier = 'uturn';
                } else if (lowerManeuver.includes('arrive') || lowerInstr.includes('arrive')) {
                    type = 'arrive';
                } else if (lowerManeuver.includes('roundabout') || lowerInstr.includes('roundabout')) {
                    type = 'roundabout';
                }
                
                if (lowerManeuver.includes('sharp-left') || lowerManeuver.includes('sharp_left') || lowerInstr.includes('sharp left')) modifier = 'sharp left';
                else if (lowerManeuver.includes('sharp-right') || lowerManeuver.includes('sharp_right') || lowerInstr.includes('sharp right')) modifier = 'sharp right';
                else if (lowerManeuver.includes('slight-left') || lowerManeuver.includes('slight_left') || lowerInstr.includes('slight left')) modifier = 'slight left';
                else if (lowerManeuver.includes('slight-right') || lowerManeuver.includes('slight_right') || lowerInstr.includes('slight right')) modifier = 'slight right';

            const streetName = instr
                .replace(/^(turn|take|continue( onto)?|merge|head|proceed)\s+(sharp |slight )?(left|right|straight)?\s*(onto|on|towards|toward)?\s*/i, '')
                .replace(/^(onto|on|towards|toward)\s+/i, '')
                .trim();

            // Decode step polyline for per-segment geometry
            const stepPoints = typeof s.polyline === 'string'
                ? s.polyline
                : (s.polyline?.points || '');
            const stepCoords = stepPoints ? decodePolyline(stepPoints) : [];

            // Step-level duration/distance for traffic coloring
            const stepDuration = typeof s.duration === 'number' ? s.duration : (s.duration?.value || 0);
            const stepDistance = typeof s.distance === 'number' ? s.distance : (s.distance?.value || 0);

            // Lane guidance data (Google Directions-compatible format)
            const lanes = (s.lanes || []).map(lane => ({
                indications: lane.indications || [],
                valid: lane.valid !== undefined ? lane.valid : true
            }));

            return {
                maneuver: {
                    location: s.start_location ? [s.start_location.lng, s.start_location.lat] : [0, 0],
                    type,
                    modifier
                },
                name: streetName || instr,
                duration: stepDuration,
                distance: stepDistance,
                geometry: stepCoords.length > 0 ? { coordinates: stepCoords, type: 'LineString' } : null,
                lanes: lanes.length > 0 ? lanes : undefined
            };
            });

            const durationVal = typeof leg.duration === 'number' ? leg.duration : (leg.duration?.value || 0);
            const distanceVal = typeof leg.distance === 'number' ? leg.distance : (leg.distance?.value || 0);

            return {
                geometry: {
                    coordinates: coordinates,
                    type: 'LineString'
                },
                legs: [
                    {
                        steps: steps,
                        summary: route.summary || '',
                        weight: durationVal,
                        duration: durationVal,
                        distance: distanceVal
                    }
                ],
                weight_name: 'routability',
                weight: durationVal,
                duration: durationVal,
                distance: distanceVal
            };
        });

        const primaryLeg = olaData.routes[0].legs?.[0] || {};

        // Construct standard OSRM response structure for the frontend
        const osrmCompatibleData = {
            code: 'Ok',
            routes: osrmRoutes,
            waypoints: [
                {
                    hint: '',
                    distance: 0,
                    name: primaryLeg.start_address || '',
                    location: [startCoords.lng, startCoords.lat]
                },
                {
                    hint: '',
                    distance: 0,
                    name: primaryLeg.end_address || '',
                    location: [endCoords.lng, endCoords.lat]
                }
            ]
        };

        routeCache.set(routeCacheKey, osrmCompatibleData);
        res.json({ success: true, data: osrmCompatibleData });

    } catch (error) {
        console.error('[API ERROR] Ola Maps Directions failed, falling back to OSRM:', error.message);
        // Fallback to OSRM if Ola Maps fails during runtime
        try {
            const { start, end, overview, alternatives } = req.query;
            const overviewVal = ['full', 'simplified', 'false'].includes(overview) ? overview : 'full';
            const alternativesVal = alternatives === 'true';

            const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=${overviewVal}&alternatives=${alternativesVal}&geometries=geojson&steps=true`);
            const data = await response.json();
            if (routeCacheKey) routeCache.set(routeCacheKey, data);
            res.json({ success: true, data });
        } catch (fallbackError) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

// ── Speed Limits API (proxied from Ola Maps) ──────────────────────────
router.get('/speed-limit', async (req, res) => {
    try {
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp, 'route')) {
            return res.status(429).json({ success: false, message: 'Rate limited' });
        }

        const { lat, lng, path } = req.query;
        const apiKey = process.env.OLA_MAPS_API_KEY;

        if (!apiKey) {
            return res.json({ success: true, data: { speedLimit: null } });
        }

        // Ola Maps SpeedLimits API accepts a path of lat,lng pairs
        let pathParam = '';
        if (path) {
            pathParam = path; // pre-formatted "lat,lng|lat,lng|..."
        } else if (lat && lng) {
            pathParam = `${lat},${lng}`;
        } else {
            return res.status(400).json({ success: false, message: 'lat/lng or path required' });
        }

        const url = `https://api.olamaps.io/routing/v1/speedLimits?path=${encodeURIComponent(pathParam)}&api_key=${apiKey}`;
        const response = await fetch(url, {
            headers: { 'X-Request-Id': `req-${Date.now()}` }
        });

        if (!response.ok) {
            // Speed limit not available — return null gracefully
            return res.json({ success: true, data: { speedLimit: null } });
        }

        const data = await response.json();
        // Response typically: { snappedSpeedLimits: [{ speedLimit, placeId }] }
        const limits = data.snappedSpeedLimits || data.speedLimits || [];
        const speedLimit = limits.length > 0 ? (limits[0].speedLimit || null) : null;

        res.json({ success: true, data: { speedLimit, limits } });
    } catch (error) {
        // Fail silently — speed limit is non-critical
        res.json({ success: true, data: { speedLimit: null } });
    }
});

// ── Map Style (Ola Maps vector tiles style JSON proxy) ─────────────────
const styleCache = { data: null, time: 0 };
const STYLE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

// ── Snap to Road (Ola Maps) ─────────────────────────────────────────────
router.post('/snap-to-road', async (req, res) => {
    try {
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp, 'route')) {
            return res.status(429).json({ success: false, message: 'Rate limited' });
        }

        const apiKey = process.env.OLA_MAPS_API_KEY;
        if (!apiKey) {
            return res.json({ success: true, data: { snapped: null } });
        }

        const { points } = req.body;
        // points: array of { lat, lng, heading?, speed?, timestamp? }
        if (!points || !Array.isArray(points) || points.length === 0) {
            return res.status(400).json({ success: false, message: 'points array required' });
        }

        // Format path for Ola Maps: "lat,lng|lat,lng|..."
        const pathParam = points.map(p => `${p.lat},${p.lng}`).join('|');
        const url = `https://api.olamaps.io/routing/v1/snapToRoad?points=${encodeURIComponent(pathParam)}&api_key=${apiKey}`;

        const response = await fetch(url, {
            method: 'GET',
            headers: { 'X-Request-Id': `snap-${Date.now()}` }
        });

        if (!response.ok) {
            return res.json({ success: true, data: { snapped: null } });
        }

        const data = await response.json();
        // Response: { snappedPoints: [{ location: { lat, lng }, originalIndex, placeId }] }
        const snappedPoints = data.snappedPoints || [];

        res.json({
            success: true,
            data: {
                snapped: snappedPoints.map(sp => ({
                    lat: sp.location?.lat || sp.latitude,
                    lng: sp.location?.lng || sp.longitude,
                    placeId: sp.placeId || null,
                    originalIndex: sp.originalIndex ?? null,
                }))
            }
        });
    } catch (error) {
        res.json({ success: true, data: { snapped: null } });
    }
});

// ── Nearby POIs for landmark-based instructions ─────────────────────────
router.get('/nearby-pois', async (req, res) => {
    try {
        const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!checkRateLimit(clientIp, 'search')) {
            return res.status(429).json({ success: false, message: 'Rate limited' });
        }

        const apiKey = process.env.OLA_MAPS_API_KEY;
        const { lat, lng, radius = 100, types } = req.query;

        if (!lat || !lng) {
            return res.status(400).json({ success: false, message: 'lat/lng required' });
        }

        if (!apiKey) {
            return res.json({ success: true, data: { pois: [] } });
        }

        // Use Ola Maps Places Nearby Search
        let url = `https://api.olamaps.io/places/v1/nearbysearch/json?location=${lat},${lng}&radius=${radius}&api_key=${apiKey}`;
        if (types) url += `&types=${encodeURIComponent(types)}`;

        const response = await fetch(url, {
            headers: { 'X-Request-Id': `poi-${Date.now()}` }
        });

        if (!response.ok) {
            return res.json({ success: true, data: { pois: [] } });
        }

        const data = await response.json();
        const predictions = data.predictions || data.results || [];

        // Filter to useful landmarks: petrol pumps, temples, schools, hospitals, signals, etc.
        const LANDMARK_TYPES = [
            'gas_station', 'petrol_pump', 'fuel',
            'temple', 'mosque', 'church', 'place_of_worship',
            'school', 'hospital', 'pharmacy',
            'bank', 'atm',
            'police', 'fire_station', 'post_office',
            'bus_station', 'train_station', 'metro_station',
            'shopping_mall', 'supermarket', 'market',
            'restaurant', 'hotel', 'lodge',
            'traffic_signal', 'signal', 'flyover', 'bridge',
            'park', 'garden', 'stadium',
        ];

        const pois = predictions
            .filter(p => {
                const pTypes = p.types || [];
                return pTypes.some(t => LANDMARK_TYPES.some(lt => t.toLowerCase().includes(lt))) || true;
            })
            .slice(0, 5)
            .map(p => ({
                name: p.structured_formatting?.main_text || p.name || p.description || '',
                type: (p.types || [])[0] || 'landmark',
                lat: p.geometry?.location?.lat || null,
                lng: p.geometry?.location?.lng || null,
                distance: p.distance_meters || null,
            }));

        res.json({ success: true, data: { pois } });
    } catch (error) {
        res.json({ success: true, data: { pois: [] } });
    }
});

// NOTE: /config endpoint removed — API key must never be exposed to the frontend.
// All map operations (search, route) are proxied through the backend endpoints above.

module.exports = router;

