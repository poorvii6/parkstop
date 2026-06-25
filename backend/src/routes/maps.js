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

// Step 6 & 10: Routing (OSRM Proxy with Caching potential)
router.get('/route', async (req, res) => {
    try {
        const { start, end } = req.query; // Format: "lng,lat"
        if (!start || !end) return res.status(400).json({ success: false, message: 'Start and end required' });

        const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson&steps=true`);
        const data = await response.json();

        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;

