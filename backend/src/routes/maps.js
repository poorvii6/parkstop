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

// Step 7: Location Search (Nominatim Proxy)
router.get('/search', async (req, res) => {
    try {
        const { q, lat, lon } = req.query;
        if (!q) return res.status(400).json({ success: false, message: 'Query required' });

        // Search globally — no bounded viewbox so users can find any city
        let searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=15&addressdetails=1`;
        
        // Use viewbox as a bias (NOT bounded) so nearby results rank higher
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

        // If lat/lon are provided, calculate distance and sort local results (< 100km) to the top
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

                // Sort:
                // 1. Group by "local" (< 100km) vs "global" (>= 100km)
                // 2. Local results are sorted by distance ascending (closest first)
                // 3. Global results retain their original Nominatim relevance ranking
                data.sort((a, b) => {
                    const aLocal = a.distance < 100;
                    const bLocal = b.distance < 100;
                    if (aLocal && !bLocal) return -1;
                    if (!aLocal && bLocal) return 1;
                    if (aLocal && bLocal) {
                        return a.distance - b.distance;
                    }
                    return 0; // retain original order
                });
            }
        }

        // Limit to top 10 results after sorting
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

// Step 6 & 10: Routing (OSRM Proxy / Ola Maps Adapter)
router.get('/route', async (req, res) => {
    try {
        const { start, end } = req.query; // Format: "lng,lat"
        if (!start || !end) return res.status(400).json({ success: false, message: 'Start and end required' });

        const apiKey = process.env.OLA_MAPS_API_KEY;

        if (!apiKey) {
            // Fallback to OSRM if OLA_MAPS_API_KEY is not set
            const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&steps=true`);
            const data = await response.json();
            return res.json({ success: true, data });
        }

        // Convert start and end from "lng,lat" to "lat,lng" for Ola Maps
        const [startLng, startLat] = start.split(',');
        const [endLng, endLat] = end.split(',');
        const origin = `${startLat.trim()},${startLng.trim()}`;
        const destination = `${endLat.trim()},${endLng.trim()}`;

        const url = `https://api.olamaps.io/routing/v1/directions?origin=${origin}&destination=${destination}&api_key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'X-Request-Id': `req-${Date.now()}`
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ola Maps API error: ${response.status} - ${errText}`);
        }

        const olaData = await response.json();
        
        if (!olaData.routes || olaData.routes.length === 0) {
            return res.status(404).json({ success: false, message: 'No routes found from Ola Maps' });
        }

        const route = olaData.routes[0];
        const leg = route.legs?.[0] || {};
        
        // Decode encoded polyline to GeoJSON format
        const points = route.overview_polyline?.points || '';
        const coordinates = points ? decodePolyline(points) : [];

        // Map Ola steps to OSRM-compatible steps
        const steps = (leg.steps || []).map(s => {
            const instr = s.instruction || '';
            const lowerInstr = instr.toLowerCase();
            
            let type = 'continue';
            let modifier = 'straight';
            
            if (lowerInstr.includes('turn') || lowerInstr.includes('take')) {
                type = 'turn';
                if (lowerInstr.includes('left')) modifier = 'left';
                else if (lowerInstr.includes('right')) modifier = 'right';
            } else if (lowerInstr.includes('merge')) {
                type = 'merge';
            } else if (lowerInstr.includes('roundabout') || lowerInstr.includes('circle')) {
                type = 'roundabout';
            }
            
            if (lowerInstr.includes('sharp left')) modifier = 'sharp left';
            else if (lowerInstr.includes('sharp right')) modifier = 'sharp right';
            else if (lowerInstr.includes('slight left')) modifier = 'slight left';
            else if (lowerInstr.includes('slight right')) modifier = 'slight right';
            else if (lowerInstr.includes('u-turn') || lowerInstr.includes('uturn')) modifier = 'uturn';

            return {
                maneuver: {
                    location: s.start_location ? [s.start_location.lng, s.start_location.lat] : [0, 0],
                    type,
                    modifier
                },
                name: instr
            };
        });

        // Construct standard OSRM response structure for the frontend
        const osrmCompatibleData = {
            code: 'Ok',
            routes: [
                {
                    geometry: {
                        coordinates: coordinates,
                        type: 'LineString'
                    },
                    legs: [
                        {
                            steps: steps,
                            summary: route.summary || '',
                            weight: leg.duration?.value || 0,
                            duration: leg.duration?.value || 0,
                            distance: leg.distance?.value || 0
                        }
                    ],
                    weight_name: 'routability',
                    weight: leg.duration?.value || 0,
                    duration: leg.duration?.value || 0,
                    distance: leg.distance?.value || 0
                }
            ],
            waypoints: [
                {
                    hint: '',
                    distance: 0,
                    name: leg.start_address || '',
                    location: [parseFloat(startLng), parseFloat(startLat)]
                },
                {
                    hint: '',
                    distance: 0,
                    name: leg.end_address || '',
                    location: [parseFloat(endLng), parseFloat(endLat)]
                }
            ]
        };

        res.json({ success: true, data: osrmCompatibleData });

    } catch (error) {
        console.error('[API ERROR] Ola Maps Directions failed, falling back to OSRM:', error.message);
        // Fallback to OSRM if Ola Maps fails during runtime
        try {
            const { start, end } = req.query;
            const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&steps=true`);
            const data = await response.json();
            res.json({ success: true, data });
        } catch (fallbackError) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
});

router.get('/test-ola-raw', async (req, res) => {
    try {
        const apiKey = process.env.OLA_MAPS_API_KEY;
        const origin = "12.9784,77.6408";
        const destination = "12.9715,77.5945";
        const url = `https://api.olamaps.io/routing/v1/directions?origin=${origin}&destination=${destination}&api_key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'X-Request-Id': `req-${Date.now()}` }
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

