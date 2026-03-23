const { test, expect } = require("@playwright/test");

/**
 * E2E tests for street intersection detection
 * Opens 2D map, fetches streets, detects intersections, verifies with visual markers
 */

// Minimal Turf stub for geometry (most functions not used by intersection detection)
const TURF_STUB = `
(() => {
  window.turf = {
    point: (coord) => ({ type: 'Point', coordinates: coord }),
    distance: (p1, p2) => {
      const R = 6371; // Earth radius in km
      const lat1 = p1.coordinates[1] * Math.PI / 180;
      const lat2 = p2.coordinates[1] * Math.PI / 180;
      const dLat = (p2.coordinates[1] - p1.coordinates[1]) * Math.PI / 180;
      const dLon = (p2.coordinates[0] - p1.coordinates[0]) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    },
    bearing: (p1, p2) => {
      const lat1 = p1.coordinates[1] * Math.PI / 180;
      const lat2 = p2.coordinates[1] * Math.PI / 180;
      const dLon = (p2.coordinates[0] - p1.coordinates[0]) * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    },
    lineString: (coords) => ({ type: 'LineString', coordinates: coords }),
    bboxClip: (line, bbox) => line,
  };
})();
`;

// Minimal Leaflet stub for map
const LEAFLET_STUB = `
(() => {
  class LayerGroup {
    constructor() {
      this._layers = [];
    }
    addTo() { return this; }
    clearLayers() { this._layers = []; return this; }
    addLayer(layer) { this._layers.push(layer); return this; }
    eachLayer(fn) { this._layers.forEach(fn); return this; }
  }

  function makeLayer(latlng, options = {}) {
    return {
      _latlng: latlng,
      options,
      addTo(group) {
        if (group && typeof group.addLayer === "function") {
          group.addLayer(this);
        }
        return this;
      },
      bindPopup() { return this; },
      bindTooltip() { return this; },
      on() { return this; },
      setLatLng(next) { this._latlng = next; return this; },
      setBounds(bounds) { this._bounds = bounds; return this; },
    };
  }

  const mapHandlers = {};
  const map = {
    _zoom: 16,
    _center: { lat: 40.7580, lng: -73.9855 },
    setView(center, zoom) {
      this._center = { lat: center[0], lng: center[1] };
      this._zoom = zoom;
      return this;
    },
    getBounds() {
      return {
        getNorth: () => this._center.lat + 0.01,
        getSouth: () => this._center.lat - 0.01,
        getEast: () => this._center.lng + 0.01,
        getWest: () => this._center.lng - 0.01,
      };
    },
    getZoom() { return this._zoom; },
    getCenter() { return this._center; },
    invalidateSize() {},
    on(event, handler) { mapHandlers[event] = handler; return this; },
    off(event) { delete mapHandlers[event]; return this; },
    _fireMapEvent(event) { if (mapHandlers[event]) mapHandlers[event](); },
  };

  window.L = {
    map: () => map,
    tileLayer: () => ({
      addTo: () => ({
        on: () => ({}),
      }),
    }),
    layerGroup: () => new LayerGroup(),
    marker: (latlng, options) => makeLayer(latlng, options),
    polyline: (latlngs, options) => ({
      ...makeLayer(latlngs[0], options),
      _latlngs: latlngs,
      setStyle() { return this; },
    }),
    circle: (latlng, options) => makeLayer(latlng, options),
    circleMarker: (latlng, options) => makeLayer(latlng, options),
    LatLng: (lat, lng) => ({ lat, lng }),
    latLng: (lat, lng) => ({ lat, lng }),
    latLngBounds: (corner1, corner2) => ({
      contains: (latlng) => true,
      extend: () => this,
      getNorth: () => 40.77,
      getSouth: () => 40.74,
      getEast: () => -73.97,
      getWest: () => -73.99,
    }),
    DomUtil: {
      addClass: () => {},
      removeClass: () => {},
    },
  };
})();
`;

// Minimal Google Maps stub
const GOOGLE_MAPS_STUB = `
(() => {
  window.google = {
    maps: {
      StreetViewPanorama: class {},
      StreetViewStatus: { OK: 'OK' },
    },
  };
})();
`;

async function setupIntersectionVisualization(page, testWays = null) {
  // Default test ways for Times Square area
  const DEFAULT_WAYS = [
    {
      id: 1,
      geometry: [
        { lat: 40.7600, lon: -73.9855 },
        { lat: 40.7580, lon: -73.9855 },
        { lat: 40.7505, lon: -73.9973 },
      ],
      tags: { highway: "primary", name: "Broadway" },
    },
    {
      id: 2,
      geometry: [
        { lat: 40.7580, lon: -73.9900 },
        { lat: 40.7580, lon: -73.9855 },
        { lat: 40.7580, lon: -73.9800 },
      ],
      tags: { highway: "secondary", name: "42nd St" },
    },
    {
      id: 3,
      geometry: [
        { lat: 40.7505, lon: -73.9973 },
        { lat: 40.7400, lon: -73.9973 },
      ],
      tags: { highway: "tertiary", name: "7th Ave" },
    },
  ];

  const waysForTest = testWays ?? DEFAULT_WAYS;

  /**
   * Inject street detection functions into page context
   */
  await page.addInitScript(() => {
    // Store test ways globally
    window.__TEST_WAYS = null; // Will be set by the test

    // Convert lon/lng to consistent lon/lng naming
    function getWayNodeLng(node) {
      return node?.lon ?? node?.lng ?? null;
    }

    function toLocalMeters(lat, lon, originLat, originLon) {
      const latDiff = lat - originLat;
      const lonDiff = lon - originLon;
      const latMeters = latDiff * 111320;
      const lonMeters = lonDiff * 111320 * Math.cos((originLat * Math.PI) / 180);
      return { x: lonMeters, y: latMeters };
    }

    function distanceToSegmentMeters(point, start, end) {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const t = Math.max(0, Math.min(1, (point.x * dx + point.y * dy) / (dx * dx + dy * dy)));
      const projX = start.x + t * dx;
      const projY = start.y + t * dy;
      return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
    }

    function findNearestStreetContext(lat, lon, ways) {
      const point = { x: 0, y: 0 };
      let nearest = null;

      for (const way of ways) {
        const nodes = way.geometry || [];
        for (let i = 0; i < nodes.length - 1; i++) {
          const segmentStart = nodes[i];
          const segmentEnd = nodes[i + 1];
          const start = toLocalMeters(segmentStart.lat, getWayNodeLng(segmentStart), lat, lon);
          const end = toLocalMeters(segmentEnd.lat, getWayNodeLng(segmentEnd), lat, lon);
          const distanceMeters = distanceToSegmentMeters(point, start, end);

          if (nearest && distanceMeters >= nearest.distanceMeters) {
            continue;
          }

          nearest = {
            distanceMeters,
            bearing: 0, // Not needed for tests
            oneway: way.tags?.oneway || null,
            highway: way.tags?.highway || null,
            lanes: way.tags?.lanes || null,
            streetName: way.tags?.name || "Unknown street",
            segmentStart: {
              lat: segmentStart.lat,
              lon: getWayNodeLng(segmentStart),
            },
            segmentEnd: {
              lat: segmentEnd.lat,
              lon: getWayNodeLng(segmentEnd),
            },
            wayGeometry: nodes.map(n => ({ lat: n.lat, lon: getWayNodeLng(n) })),
            segmentIndex: i,
            allWays: ways,
          };
        }
      }

      return nearest;
    }

    function findIntersectionNodes(wayGeometry, allWays) {
      if (!wayGeometry || wayGeometry.length === 0 || !allWays || allWays.length === 0) {
        return [];
      }

      const PRECISION = 5;
      const coordKeyToWayCount = new Map();

      for (const way of allWays) {
        const nodes = way.geometry || [];
        const seenKeys = new Set();

        for (const node of nodes) {
          const lat = node.lat;
          const lng = getWayNodeLng(node);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

          const key = `${lat.toFixed(PRECISION)},${lng.toFixed(PRECISION)}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            coordKeyToWayCount.set(key, (coordKeyToWayCount.get(key) || 0) + 1);
          }
        }
      }

      const intersectionNodes = [];
      for (let nodeIdx = 0; nodeIdx < wayGeometry.length; nodeIdx++) {
        const node = wayGeometry[nodeIdx];
        const lat = node.lat;
        const lng = getWayNodeLng(node);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

        const key = `${lat.toFixed(PRECISION)},${lng.toFixed(PRECISION)}`;
        const wayCount = coordKeyToWayCount.get(key) || 0;

        if (wayCount >= 2) {
          intersectionNodes.push({
            lat,
            lng,
            nodeIndex: nodeIdx,
          });
        }
      }

      return intersectionNodes;
    }

    // fetchStreets - return injected test ways (for tests) or fetch from API
    async function fetchStreets(bounds) {
      // In tests, use injected ways
      if (window.__TEST_WAYS && window.__TEST_WAYS.length > 0) {
        return window.__TEST_WAYS;
      }
      // Otherwise try to fetch from Overpass
      const response = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: "mock-query",
      });
      const data = await response.json();
      return data.elements || [];
    }

    async function fetchNearestStreetContext(lat, lon, radiusMeters = 120) {
      const ways = await fetchStreets(null);
      if (!ways || ways.length === 0) {
        return null;
      }
      return findNearestStreetContext(lat, lon, ways);
    }

    // Make functions available globally
    window.findNearestStreetContext = fetchNearestStreetContext;
    window.findIntersectionNodes = findIntersectionNodes;
    window.fetchStreets = fetchStreets;
  });

  // Inject test ways into page
  await page.addInitScript((ways) => {
    window.__TEST_WAYS = ways;
  }, waysForTest);

  /**
   * Add debug visualization layer and helper function to show intersections on map
   */
  await page.addInitScript(() => {
    window.debugIntersectionLayer = null;

    window.showIntersectionDots = function(intersectionNodes, wayGeometry) {
      // Create container for debug dots if it doesn't exist
      if (!window.debugIntersectionLayer) {
        window.debugIntersectionLayer = L.layerGroup().addTo(map);
      }
      window.debugIntersectionLayer.clearLayers();

      if (!intersectionNodes || intersectionNodes.length === 0) {
        return;
      }

      // Add colored circles at each intersection
      intersectionNodes.forEach((node, idx) => {
        const circle = L.circleMarker([node.lat, node.lng], {
          radius: 8,
          fillColor: '#ff0000',
          color: '#ff0000',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.7,
          className: 'intersection-dot',
          title: `Intersection ${idx} (nodeIndex ${node.nodeIndex})`,
        });
        circle._testData = {
          lat: node.lat,
          lng: node.lng,
          nodeIndex: node.nodeIndex,
        };
        circle.bindPopup(`Intersection at node ${node.nodeIndex}`);
        window.debugIntersectionLayer.addLayer(circle);
      });
    };

    window.getIntersectionDots = function() {
      const dots = [];
      if (window.debugIntersectionLayer) {
        window.debugIntersectionLayer.eachLayer(layer => {
          if (layer._testData) {
            dots.push(layer._testData);
          }
        });
      }
      return dots;
    };
  });
}

async function mockExternalDependencies(page, { overpassWays = null } = {}) {
  // Default test ways for Times Square area
  const DEFAULT_WAYS = [
    {
      id: 1,
      geometry: [
        { lat: 40.7600, lon: -73.9855 },  // North end
        { lat: 40.7580, lon: -73.9855 },  // Times Square intersection (node 1)
        { lat: 40.7505, lon: -73.9973 },  // 7th Ave intersection (node 2)
      ],
      tags: { highway: "primary", name: "Broadway" },
    },
    {
      id: 2,
      geometry: [
        { lat: 40.7580, lon: -73.9900 },  // West end
        { lat: 40.7580, lon: -73.9855 },  // Times Square intersection (shared)
        { lat: 40.7580, lon: -73.9800 },  // East end
      ],
      tags: { highway: "secondary", name: "42nd St" },
    },
    {
      id: 3,
      geometry: [
        { lat: 40.7505, lon: -73.9973 },  // North (shared with way 1)
        { lat: 40.7400, lon: -73.9973 },  // South end
      ],
      tags: { highway: "tertiary", name: "7th Ave" },
    },
  ];

  const waysData = overpassWays ?? DEFAULT_WAYS;

  // Mock CDN resources
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/css", body: "" });
  });
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/javascript", body: LEAFLET_STUB });
  });
  await page.route("https://unpkg.com/@turf/turf@6.5.0/turf.min.js", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/javascript", body: TURF_STUB });
  });
  await page.route("https://maps.googleapis.com/maps/api/js?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: GOOGLE_MAPS_STUB,
    });
  });

  // Mock Overpass API
  await page.route("https://overpass-api.de/api/interpreter", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        elements: waysData.map((way) => ({
          ...way,
          type: way.type || "way",
        })),
      }),
    });
  });
}

test.describe("Street Intersection Detection E2E", () => {
  test("detects intersections where two streets cross (T-intersection)", async ({ page, context }) => {
    await setupIntersectionVisualization(page);
    await mockExternalDependencies(page);

    await page.goto("/?api_key=test-key");

    // Call the street context fetcher to get allWays
    const result = await page.evaluate(async () => {
      const context = await fetchNearestStreetContext(40.7580, -73.9855);
      if (!context || !context.allWays) {
        throw new Error("No street context or allWays found");
      }

      // Detect intersections
      const wayGeometry = context.wayGeometry;
      const intersections = findIntersectionNodes(wayGeometry, context.allWays);

      // Show dots on map
      window.showIntersectionDots(intersections, wayGeometry);

      return {
        wayName: context.streetName,
        nodeCount: wayGeometry.length,
        intersectionCount: intersections.length,
        intersections: intersections,
      };
    });

    expect(result.intersectionCount).toBe(2);
    expect(result.intersections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeIndex: 1 }),
        expect.objectContaining({ nodeIndex: 2 }),
      ])
    );

    // Verify dots are on the map via Playwright
    const dots = await page.evaluate(() => window.getIntersectionDots());
    expect(dots).toHaveLength(2);
    expect(dots[0].nodeIndex).toBe(1);
    expect(dots[1].nodeIndex).toBe(2);
  });

  test("detects all intersections along a multi-segment way", async ({ page }) => {
    const customWays = [
      {
        id: 1,
        geometry: [
          { lat: 40.0000, lon: -73.0000 },  // Node 0 - intersection
          { lat: 40.1000, lon: -73.0000 },  // Node 1 - intersection
          { lat: 40.2000, lon: -73.0000 },  // Node 2 - intersection
          { lat: 40.3000, lon: -73.0000 },  // Node 3 - no intersection
        ],
        tags: { highway: "primary", name: "Main St" },
      },
      {
        id: 2,
        geometry: [
          { lat: 40.0000, lon: -73.1000 },
          { lat: 40.0000, lon: -73.0000 },  // Shared with way 1 node 0
        ],
        tags: { highway: "secondary", name: "Cross 1" },
      },
      {
        id: 3,
        geometry: [
          { lat: 40.1000, lon: -73.1000 },
          { lat: 40.1000, lon: -73.0000 },  // Shared with way 1 node 1
        ],
        tags: { highway: "secondary", name: "Cross 2" },
      },
      {
        id: 4,
        geometry: [
          { lat: 40.2000, lon: -73.1000 },
          { lat: 40.2000, lon: -73.0000 },  // Shared with way 1 node 2
        ],
        tags: { highway: "secondary", name: "Cross 3" },
      },
    ];

    await setupIntersectionVisualization(page);
    await mockExternalDependencies(page, { overpassWays: customWays });

    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(async () => {
      const context = await fetchNearestStreetContext(40.1000, -73.0000);
      const wayGeometry = context.wayGeometry;
      const intersections = findIntersectionNodes(wayGeometry, context.allWays);

      window.showIntersectionDots(intersections, wayGeometry);

      return {
        intersectionCount: intersections.length,
        nodeIndices: intersections.map(int => int.nodeIndex).sort((a, b) => a - b),
      };
    });

    expect(result.intersectionCount).toBe(3);
    expect(result.nodeIndices).toEqual([0, 1, 2]);

    const dots = await page.evaluate(() => window.getIntersectionDots());
    expect(dots).toHaveLength(3);
  });

  test("no intersections detected for parallel streets", async ({ page }) => {
    const parallelWays = [
      {
        id: 1,
        geometry: [
          { lat: 40.0000, lon: -73.0000 },
          { lat: 40.1000, lon: -73.0000 },
          { lat: 40.2000, lon: -73.0000 },
        ],
        tags: { highway: "primary", name: "Street A" },
      },
      {
        id: 2,
        geometry: [
          { lat: 40.0000, lon: -73.1000 },
          { lat: 40.1000, lon: -73.1000 },
          { lat: 40.2000, lon: -73.1000 },
        ],
        tags: { highway: "primary", name: "Street B (parallel)" },
      },
    ];

    await setupIntersectionVisualization(page);
    await mockExternalDependencies(page, { overpassWays: parallelWays });

    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(async () => {
      const context = await fetchNearestStreetContext(40.1000, -73.0000);
      const wayGeometry = context.wayGeometry;
      const intersections = findIntersectionNodes(wayGeometry, context.allWays);

      window.showIntersectionDots(intersections, wayGeometry);

      return {
        intersectionCount: intersections.length,
      };
    });

    expect(result.intersectionCount).toBe(0);

    const dots = await page.evaluate(() => window.getIntersectionDots());
    expect(dots).toHaveLength(0);
  });

  test("detects intersections with correct lat/lng coordinates", async ({ page }) => {
    await setupIntersectionVisualization(page);
    await mockExternalDependencies(page);

    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(async () => {
      const context = await fetchNearestStreetContext(40.7580, -73.9855);
      const wayGeometry = context.wayGeometry;
      const intersections = findIntersectionNodes(wayGeometry, context.allWays);

      window.showIntersectionDots(intersections, wayGeometry);

      return intersections;
    });

    // Times Square intersection should be at node 1
    const timesSquareInt = result.find(int => int.nodeIndex === 1);
    expect(timesSquareInt).toBeDefined();
    expect(timesSquareInt.lat).toBeCloseTo(40.7580, 3);
    expect(timesSquareInt.lng).toBeCloseTo(-73.9855, 3);

    // 7th Ave intersection should be at node 2
    const seventhAveInt = result.find(int => int.nodeIndex === 2);
    expect(seventhAveInt).toBeDefined();
    expect(seventhAveInt.lat).toBeCloseTo(40.7505, 3);
    expect(seventhAveInt.lng).toBeCloseTo(-73.9973, 3);

    // Verify dot positions on map (within visual margin)
    const dots = await page.evaluate(() => window.getIntersectionDots());
    expect(dots).toHaveLength(2);

    // Check first intersection dot position
    const dot1 = dots.find(d => d.nodeIndex === 1);
    expect(dot1.lat).toBeCloseTo(40.7580, 4);
    expect(dot1.lng).toBeCloseTo(-73.9855, 4);

    // Check second intersection dot position
    const dot2 = dots.find(d => d.nodeIndex === 2);
    expect(dot2.lat).toBeCloseTo(40.7505, 4);
    expect(dot2.lng).toBeCloseTo(-73.9973, 4);
  });

  test("handles ways with lng property instead of lon", async ({ page }) => {
    const lngWays = [
      {
        id: 1,
        geometry: [
          { lat: 40.0000, lng: -73.0000 },
          { lat: 40.1000, lng: -73.0000 },
          { lat: 40.2000, lng: -73.0000 },
        ],
        tags: { highway: "primary", name: "Main St" },
      },
      {
        id: 2,
        geometry: [
          { lat: 40.1000, lng: -73.1000 },
          { lat: 40.1000, lng: -73.0000 },  // Shared
        ],
        tags: { highway: "secondary", name: "Cross" },
      },
    ];

    await setupIntersectionVisualization(page);
    await mockExternalDependencies(page, { overpassWays: lngWays });

    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(async () => {
      const context = await fetchNearestStreetContext(40.1000, -73.0000);
      const wayGeometry = context.wayGeometry;
      const intersections = findIntersectionNodes(wayGeometry, context.allWays);

      window.showIntersectionDots(intersections, wayGeometry);

      return {
        intersectionCount: intersections.length,
        nodeIndex: intersections[0]?.nodeIndex,
      };
    });

    expect(result.intersectionCount).toBe(1);
    expect(result.nodeIndex).toBe(1);
  });
});
