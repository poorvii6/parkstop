const router = require('express').Router();

// Step 7: Location Search (Nominatim Proxy)
router.get('/search', async (req, res) => {
    try {
        const { q, lat, lon } = req.query;
        if (!q) return res.status(400).json({ success: false, message: 'Query required' });

        // Search globally — no bounded viewbox so users can find any city
        let searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=10&addressdetails=1`;
        
        // Use viewbox as a bias (NOT bounded) so nearby results rank higher
        if (lat && lon) {
            const l = parseFloat(lat);
            const n = parseFloat(lon);
            const offset = 1.0; // ~100km bias box
            const viewbox = `${n-offset},${l+offset},${n+offset},${l-offset}`;
            searchUrl += `&viewbox=${viewbox}`;
            // NOTE: No &bounded=1 — results outside the box are still returned, just ranked lower
        }

        const response = await fetch(searchUrl, {
            headers: { 'User-Agent': 'ParkStop-App' }
        });
        const data = await response.json();

        // No distance filtering — let the user search for any location
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

