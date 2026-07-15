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

// Step 7: Location Search (Nominatim Proxy / Ola Maps Search)
router.get('/search', async (req, res) => {
    try {
        const { q, lat, lon } = req.query;
        if (!q) return res.status(400).json({ success: false, message: 'Query required' });

        const apiKey = process.env.OLA_MAPS_API_KEY;

        if (apiKey) {
            try {
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
                            class: 'place',
                            type: 'city',
                            address: {
                                name: item.structured_formatting?.main_text || '',
                                city: item.structured_formatting?.secondary_text || ''
                            }
                        };
                    });

                    // If coordinates are present, calculate distance and sort
                    if (lat && lon) {
                        const userLat = parseFloat(lat);
                        const userLon = parseFloat(lon);
                        if (!isNaN(userLat) && !isNaN(userLon) && userLat !== 0 && userLon !== 0) {
                            mappedData.forEach(item => {
                                const itemLat = parseFloat(item.lat);
                                const itemLon = parseFloat(item.lon);
                                if (!isNaN(itemLat) && !isNaN(itemLon) && itemLat !== 0 && itemLon !== 0) {
                                    item.distance = getDistance(userLat, userLon, itemLat, itemLon);
                                } else {
                                    item.distance = Infinity;
                                }
                            });

                            mappedData.sort((a, b) => a.distance - b.distance);
                        }
                    }

                    return res.json({ success: true, data: mappedData.slice(0, 10) });
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

        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
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
    try {
        const { start, end, waypoints, overview, alternatives } = req.query; // Format for start/end: "lng,lat"
        if (!start || !end) return res.status(400).json({ success: false, message: 'Start and end required' });

        const startCoords = parseCoords(start);
        const endCoords = parseCoords(end);
        if (!startCoords || !endCoords) {
            return res.status(400).json({ success: false, message: 'Invalid start or end coordinates format. Expected "lng,lat"' });
        }

        const apiKey = process.env.OLA_MAPS_API_KEY;

        // Tune route detail (overview) and alternatives
        const overviewVal = ['full', 'simplified', 'false'].includes(overview) ? overview : 'full';
        const alternativesVal = alternatives === 'true';

        if (!apiKey) {
            // Fallback to OSRM if OLA_MAPS_API_KEY is not set
            const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=${overviewVal}&alternatives=${alternativesVal}&geometries=geojson&steps=true`);
            const data = await response.json();
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

                return {
                    maneuver: {
                        location: s.start_location ? [s.start_location.lng, s.start_location.lat] : [0, 0],
                        type,
                        modifier
                    },
                    name: instr
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
            res.json({ success: true, data });
        } catch (fallbackError) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

// Get Ola Maps configuration for the frontend
router.get('/config', (req, res) => {
    try {
        const apiKey = process.env.OLA_MAPS_API_KEY || '';
        res.json({ success: true, apiKey });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;

