/**
 * Street data fetching and sampling utilities.
 * Uses Overpass API for OSM data and Turf.js for geometry calculations.
 */

/**
 * Fetch streets from Overpass API within given bounds.
 * @param {L.LatLngBounds} bounds - Leaflet bounds object
 * @returns {Promise<Array>} Array of way objects with geometry and tags
 */
async function fetchStreets(bounds) {
    const overpassQuery = `
        [out:json][timeout:30];
        (
            way["highway"~"^(primary|secondary|tertiary|residential|unclassified)$"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});
        );
        (._;>;);
        out geom;
    `;

    const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: overpassQuery
    });

    if (!response.ok) {
        throw new Error(`Overpass API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract ways with geometry
    const ways = [];
    if (data.elements) {
        for (const element of data.elements) {
            if (element.type === 'way' && element.geometry && element.geometry.length >= 2) {
                ways.push({
                    id: element.id,
                    geometry: element.geometry,
                    tags: element.tags || {}
                });
            }
        }
    }

    return ways;
}

/**
 * Sample points along a street at regular intervals.
 * Uses Turf.js bearing() for correct spherical geometry.
 * @param {Object} way - Way object with geometry and tags
 * @param {number} intervalMeters - Sampling interval in meters (default 50)
 * @returns {Array} Array of point objects with lat, lon, bearing, oneway
 */
function sampleStreetPoints(way, intervalMeters = 50) {
    const points = [];
    const nodes = way.geometry;

    for (let i = 0; i < nodes.length - 1; i++) {
        const startNode = nodes[i];
        const endNode = nodes[i + 1];

        const start = turf.point([startNode.lon, startNode.lat]);
        const end = turf.point([endNode.lon, endNode.lat]);

        // Distance in meters
        const segmentDist = turf.distance(start, end, { units: 'meters' });

        // Number of samples on this segment
        const samples = Math.max(1, Math.floor(segmentDist / intervalMeters));

        // Bearing from start to end (correct spherical calculation)
        const bearing = turf.bearing(start, end);

        for (let j = 0; j < samples; j++) {
            // Place point at center of each interval
            const t = (j + 0.5) / samples;
            const lat = startNode.lat + (endNode.lat - startNode.lat) * t;
            const lon = startNode.lon + (endNode.lon - startNode.lon) * t;

            points.push({
                lat,
                lon,
                bearing,
                oneway: way.tags.oneway || null,
                streetName: way.tags.name || 'Unknown street'
            });
        }
    }

    return points;
}

/**
 * Convert Overpass data to GeoJSON for map display.
 * @param {Array} ways - Array of way objects
 * @returns {Object} GeoJSON FeatureCollection
 */
function waysToGeoJSON(ways) {
    const features = ways.map(way => ({
        type: 'Feature',
        properties: {
            id: way.id,
            name: way.tags.name || 'Unnamed street',
            highway: way.tags.highway || 'road',
            oneway: way.tags.oneway || null
        },
        geometry: {
            type: 'LineString',
            coordinates: way.geometry.map(node => [node.lon, node.lat])
        }
    }));

    return {
        type: 'FeatureCollection',
        features
    };
}

/**
 * Clip streets to selection bounds.
 * @param {Array} ways - Array of way objects
 * @param {L.LatLngBounds} bounds - Leaflet bounds to clip to
 * @returns {Array} Clipped way objects
 */
function clipStreetsToBounds(ways, bounds) {
    const bbox = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth()
    ];

    const clippedWays = [];

    for (const way of ways) {
        const line = turf.lineString(
            way.geometry.map(node => [node.lon, node.lat])
        );

        try {
            const clipped = turf.bboxClip(line, bbox);

            // bboxClip can return MultiLineString if line crosses bbox multiple times
            if (clipped.geometry.type === 'LineString' && clipped.geometry.coordinates.length >= 2) {
                clippedWays.push({
                    ...way,
                    geometry: clipped.geometry.coordinates.map(coord => ({ lon: coord[0], lat: coord[1] }))
                });
            } else if (clipped.geometry.type === 'MultiLineString') {
                // Handle MultiLineString by creating separate ways
                for (const coords of clipped.geometry.coordinates) {
                    if (coords.length >= 2) {
                        clippedWays.push({
                            ...way,
                            id: `${way.id}_${clippedWays.length}`,
                            geometry: coords.map(coord => ({ lon: coord[0], lat: coord[1] }))
                        });
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to clip way:', way.id, e);
        }
    }

    return clippedWays;
}
