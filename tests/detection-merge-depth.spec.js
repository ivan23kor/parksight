const { test, expect } = require("@playwright/test");

const LEAFLET_STUB = `
(() => {
  class LayerGroup {
    constructor() { this._layers = []; }
    addTo() { return this; }
    clearLayers() { this._layers = []; return this; }
    addLayer(layer) { this._layers.push(layer); return this; }
  }
  function makeLayer(latlng, options = {}) {
    return {
      _latlng: latlng, options,
      addTo(group) { if (group && typeof group.addLayer === "function") group.addLayer(this); return this; },
      bindPopup() { return this; }, bindTooltip() { return this; }, on() { return this; },
      setLatLng(next) { this._latlng = next; return this; },
      setBounds(bounds) { this._bounds = bounds; return this; },
    };
  }
  const map = {
    _zoom: 16, _center: { lat: 42.3615, lng: -71.0921 },
    setView(c, z) { this._center = { lat: c[0], lng: c[1] }; this._zoom = z; return this; },
    getBounds() { return { getNorth: () => this._center.lat + 0.001, getSouth: () => this._center.lat - 0.001, getEast: () => this._center.lng + 0.001, getWest: () => this._center.lng - 0.001 }; },
    getZoom() { return this._zoom; }, getCenter() { return this._center; },
    invalidateSize() {}, fitBounds(b) { this._fitBounds = b; },
    on() { return this; }, getContainer() { return document.getElementById("map"); },
    dragging: { enable() {}, disable() {} }, doubleClickZoom: { enable() {}, disable() {} },
  };
  window.L = {
    map() { return map; },
    tileLayer() { return { addTo() { return this; } }; },
    layerGroup() { return new LayerGroup(); },
    circle(ll, o) { return makeLayer(ll, o); },
    circleMarker(ll, o) { return makeLayer(ll, o); },
    polyline(lls, o) { const l = makeLayer(lls[0], o); l._latlngs = lls; return l; },
    rectangle(b, o) { const l = makeLayer(b[0], o); l.setBounds = function(n) { this._bounds = n; return this; }; return l; },
    latLngBounds(p) { return p; },
  };
})();
`;

const TURF_STUB = `
window.turf = {
  point(c) { return { coords: c }; },
  bearing() { return 0; },
  distance() { return 0; },
  lineString(c) { return { geometry: { type: "LineString", coordinates: c } }; },
  bboxClip(l) { return l; },
};
`;

const GOOGLE_MAPS_STUB = `
(() => {
  class StreetViewPanorama {
    constructor(c, o = {}) { this._pano = o.pano || "mock-pano"; this._pov = o.pov || { heading: 270, pitch: 0, zoom: 1 }; this._position = { lat: 42.3615, lng: -71.0921 }; }
    set() {} setPano(p) { this._pano = p; } getPano() { return this._pano; }
    setPov(p) { this._pov = { ...this._pov, ...p }; } getPov() { return this._pov; }
    getPosition() { return { lat: () => this._position.lat, lng: () => this._position.lng }; }
    getContainer() { return document.createElement("div"); }
    addListener() { return { remove() {} }; }
  }
  window.google = { maps: { StreetViewPanorama } };
  setTimeout(() => { if (typeof window.initApp === "function") window.initApp(); }, 0);
})();
`;

async function stubExternalDeps(page) {
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", (r) =>
    r.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: LEAFLET_STUB }),
  );
  await page.route("https://unpkg.com/@turf/turf@6.5.0/turf.min.js", (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: TURF_STUB }),
  );
  await page.route("https://maps.googleapis.com/maps/api/js?**", (r) =>
    r.fulfill({ status: 200, contentType: "application/javascript", body: GOOGLE_MAPS_STUB }),
  );
  await page.route("https://tile.googleapis.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
  );
}

function mockDetection(depth, rawDepth, angularHeight = 1.5, confidence = 0.85) {
  return {
    heading: 0,
    pitch: 0,
    angularWidth: 0.5,
    angularHeight,
    confidence,
    class_name: "parking_sign",
    depthAnythingMeters: depth,
    depthAnythingMetersRaw: rawDepth,
    distanceAngularHeight: angularHeight,
    distanceAngularWidth: 0.5,
  };
}

test.describe("mergeAngularDetections depth aggregation", () => {
  test("should use median depth of cluster members, not detection[0] only", async ({
    page,
  }) => {
    await stubExternalDeps(page);
    await page.goto("/?api_key=test-key");

    const detections = [
      mockDetection(22.6, 76.0, 1.8, 0.95),
      mockDetection(27.8, 44.7, 1.2, 0.88),
      mockDetection(25.3, 60.2, 1.5, 0.82),
    ];

    const result = await page.evaluate((dets) => {
      const merged = mergeAngularDetections(dets);
      return {
        depthAnythingMeters: merged.depthAnythingMeters,
        sourceDetections: merged.sourceDetections,
      };
    }, detections);

    // Before fix: uses detection[0] depth = 22.6 (highest confidence)
    // After fix: should use median of [22.6, 27.8, 25.3] = 25.3
    expect(result.depthAnythingMeters).toBe(25.3);
  });

  test("should handle single detection (no aggregation)", async ({ page }) => {
    await stubExternalDeps(page);
    await page.goto("/?api_key=test-key");

    const detections = [mockDetection(25.0, 75.0, 1.5, 0.90)];

    const result = await page.evaluate((dets) => {
      const merged = mergeAngularDetections(dets);
      return {
        depthAnythingMeters: merged.depthAnythingMeters,
        sourceDetections: merged.sourceDetections,
      };
    }, detections);

    expect(result.depthAnythingMeters).toBe(25.0);
  });

  test("should use raw depth from highest-confidence detection for depthAnythingMetersRaw", async ({
    page,
  }) => {
    await stubExternalDeps(page);
    await page.goto("/?api_key=test-key");

    const detections = [
      mockDetection(22.6, 76.0, 1.8, 0.95),
      mockDetection(27.8, 44.7, 1.2, 0.88),
    ];

    const result = await page.evaluate((dets) => {
      const merged = mergeAngularDetections(dets);
      return {
        depthAnythingMeters: merged.depthAnythingMeters,
        depthAnythingMetersRaw: merged.depthAnythingMetersRaw,
      };
    }, detections);

    // Raw depth should stay from detection[0]
    expect(result.depthAnythingMetersRaw).toBe(76.0);
    // Calibrated depth should be median
    expect(result.depthAnythingMeters).toBeCloseTo(25.2, 10);
  });
});
