const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

/**
 * Detection E2E tests using REAL OSM data from the Vassar Street / MIT area.
 * All street geometries, bearings, and way data come from the fixture.
 *
 * Infrastructure stubs kept:
 *  - Leaflet (tests inspect _layers internals not in real Leaflet)
 *  - Google Maps (needs API key)
 *  - Detection backend (needs running YOLO server)
 *
 * Each test ends with page.pause() so you can inspect in headed mode.
 * Run with: HEADLESS=false bunx playwright test tests/detection.e2e.spec.js -g "test name"
 */

const fixtureWays = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "fixtures/vassar-street-mit-ways.json"),
    "utf-8",
  ),
);

// Real Vassar Street way/28631895 data
const VASSAR_WAY = fixtureWays.find((w) => w.id === 28631895);
const VASSAR_CAMERA = { lat: 42.3614859, lng: -71.0921589 };
const VASSAR_BEARING = 56.25;
const VASSAR_SEG_START = VASSAR_WAY.geometry[5];
const VASSAR_SEG_END = VASSAR_WAY.geometry[6];

// Real Albany Street way/442971020 — has 2 cross-street intersections
const ALBANY_WAY = fixtureWays.find((w) => w.id === 442971020);

const PREVIEW_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";

// ─── Infrastructure stubs (not data) ───────────────────────────────────

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
  const mapHandlers = {};
  const map = {
    _zoom: 16, _center: { lat: 42.3615, lng: -71.0921 },
    setView(center, zoom) { this._center = { lat: center[0], lng: center[1] }; this._zoom = zoom; return this; },
    getBounds() {
      return {
        getNorth: () => this._center.lat + 0.001, getSouth: () => this._center.lat - 0.001,
        getEast: () => this._center.lng + 0.001, getWest: () => this._center.lng - 0.001,
      };
    },
    getZoom() { return this._zoom; }, getCenter() { return this._center; },
    invalidateSize() {}, fitBounds(b) { this._fitBounds = b; },
    on(event, handler) { mapHandlers[event] = handler; return this; },
    getContainer() { return document.getElementById("map"); },
    dragging: { enable() {}, disable() {} }, doubleClickZoom: { enable() {}, disable() {} },
  };
  window.L = {
    map() { return map; },
    tileLayer() { return { addTo() { return this; } }; },
    layerGroup() { return new LayerGroup(); },
    circle(latlng, options) { return makeLayer(latlng, options); },
    circleMarker(latlng, options) { return makeLayer(latlng, options); },
    polyline(latlngs, options) { const l = makeLayer(latlngs[0], options); l._latlngs = latlngs; return l; },
    rectangle(bounds, options) { const l = makeLayer(bounds[0], options); l.setBounds = function(n) { this._bounds = n; return this; }; return l; },
    latLngBounds(points) { return points; },
  };
})();
`;

const GOOGLE_MAPS_STUB = `
(() => {
  class StreetViewPanorama {
    constructor(container, options = {}) {
      this._pano = options.pano || "mock-pano";
      this._pov = options.pov || { heading: 270, pitch: 0, zoom: 1 };
      const pos = window.__TEST_PANORAMA_POSITION || { lat: 42.3615, lng: -71.0921 };
      this._position = pos;
    }
    set(name, value) { if (name === "zoom") this._pov = { ...this._pov, zoom: value }; }
    setPano(pano) { this._pano = pano; }
    getPano() { return this._pano; }
    setPov(pov) { this._pov = { ...this._pov, ...pov }; }
    getPov() { return this._pov; }
    getPosition() { return { lat: () => this._position.lat, lng: () => this._position.lng }; }
    getContainer() { return document.createElement("div"); }
    addListener() { return { remove() {} }; }
  }
  window.google = { maps: { StreetViewPanorama } };
  setTimeout(() => { if (typeof window.initApp === "function") window.initApp(); }, 0);
})();
`;

const TURF_STUB = `
window.turf = {
  point(coords) { return { coords }; },
  bearing(start, end) {
    const avgLat = (start.coords[1] + end.coords[1]) / 2;
    const dx = (end.coords[0] - start.coords[0]) * 111320 * Math.cos((avgLat * Math.PI) / 180);
    const dy = (end.coords[1] - start.coords[1]) * 111320;
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  },
  distance(start, end) {
    const avgLat = (start.coords[1] + end.coords[1]) / 2;
    const dx = (end.coords[0] - start.coords[0]) * 111320 * Math.cos((avgLat * Math.PI) / 180);
    const dy = (end.coords[1] - start.coords[1]) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
  },
  lineString(coordinates) { return { geometry: { type: "LineString", coordinates } }; },
  bboxClip(line) { return line; },
};
`;

function forwardBrowserConsole(page) {
  page.on("console", (msg) => {
    const type = msg.type();
    const prefix = `[browser:${type}]`;
    const text = msg.text();
    if (type === "error") {
      process.stderr.write(`${prefix} ${text}\n`);
    } else {
      process.stdout.write(`${prefix} ${text}\n`);
    }
  });
  page.on("pageerror", (err) => {
    process.stderr.write(`[browser:CRASH] ${err.message}\n${err.stack || ""}\n`);
  });
  page.on("requestfailed", (req) => {
    process.stderr.write(`[browser:NET_FAIL] ${req.method()} ${req.url()} — ${req.failure()?.errorText || "unknown"}\n`);
  });
}

async function mockInfrastructure(page, options = {}) {
  forwardBrowserConsole(page);
  const detectPanoramaResponse = options.detectPanoramaResponse ?? (() => ({
    status: 404, body: JSON.stringify({ detail: "Not Found" }),
  }));
  const detectResponse = options.detectResponse ?? (() => ({
    detections: [
      { x1: 60, y1: 150, x2: 100, y2: 320, confidence: 0.91, class_name: "parking_sign" },
      { x1: 420, y1: 140, x2: 458, y2: 300, confidence: 0.84, class_name: "parking_sign" },
    ],
    inference_time_ms: 42, image_width: 640, image_height: 360,
  }));

  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: LEAFLET_STUB }));
  await page.route("https://unpkg.com/@turf/turf@6.5.0/turf.min.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: TURF_STUB }));
  await page.route("https://maps.googleapis.com/maps/api/js?**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: GOOGLE_MAPS_STUB }));
  await page.route("https://tile.googleapis.com/v1/createSession?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: "mock-session" }) }));
  await page.route("https://tile.googleapis.com/v1/streetview/panoIds?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ panoIds: ["mock-pano"] }) }));
  await page.route("https://tile.googleapis.com/v1/streetview/metadata?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ heading: 45, tilt: 90, roll: 0, imageWidth: 16384, imageHeight: 8192 }) }));
  await page.route("https://overpass-api.de/api/interpreter", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ elements: fixtureWays }) }));

  await page.route("http://127.0.0.1:8000/detect-panorama", async (r) => {
    const resp = typeof detectPanoramaResponse === "function" ? detectPanoramaResponse(r.request()) : detectPanoramaResponse;
    await r.fulfill({ status: resp.status, contentType: resp.contentType || "application/json", body: resp.body });
  });
  await page.route("http://127.0.0.1:8000/detect", async (r) => {
    const resp = typeof detectResponse === "function" ? detectResponse(r.request()) : detectResponse;
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resp) });
  });
  await page.route("http://127.0.0.1:8000/crop-sign-tiles", async (r) => {
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ width: 200, height: 300, image_base64: PREVIEW_IMAGE_BASE64 }) });
  });
  await page.route("http://127.0.0.1:8000/ocr-sign", async (r) => {
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      is_parking_sign: true, confidence_readable: "high",
      rules: [{ category: "no_parking", arrow_direction: "left", days: ["mon","tue","wed","thu","fri"], time_start: "08:00", time_end: "18:00" }],
      tow_zones: [], raw_text: "NO PARKING 8AM-6PM MON-FRI",
    }) });
  });
}

function perpendicularDistanceMeters(point, segment) {
  const originLat = (segment.start.lat + segment.end.lat) / 2;
  const originLng = (segment.start.lng + segment.end.lng) / 2;
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((originLat * Math.PI) / 180);
  const toLocal = (lat, lng) => ({ x: (lng - originLng) * lngScale, y: (lat - originLat) * latScale });
  const a = toLocal(segment.start.lat, segment.start.lng);
  const b = toLocal(segment.end.lat, segment.end.lng);
  const p = toLocal(point.lat, point.lng);
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  return Math.abs(abx * apy - aby * apx) / Math.sqrt(abx * abx + aby * aby);
}

function distanceToPolylineMeters(point, wayGeometry) {
  let best = Infinity;
  for (let i = 0; i < wayGeometry.length - 1; i++) {
    const start = { lat: wayGeometry[i].lat, lng: wayGeometry[i].lng ?? wayGeometry[i].lon };
    const end = { lat: wayGeometry[i + 1].lat, lng: wayGeometry[i + 1].lng ?? wayGeometry[i + 1].lon };
    best = Math.min(best, perpendicularDistanceMeters(point, { start, end }));
  }
  return best;
}

// ─── Tests ─────────────────────────────────────────────────────────────

test.describe("detection flow (real OSM data)", () => {
  test("merged detections use representative primitive box height for stacked clusters", async ({ page }) => {
    await mockInfrastructure(page);
    await page.goto("/?api_key=test-key");

    const metrics = await page.evaluate(() => {
      const merged = mergeAngularDetections([
        { heading: 45, pitch: -2.1, angularWidth: 0.55, angularHeight: 1.05, confidence: 0.91, class_name: "parking_sign" },
        { heading: 45.08, pitch: -3.95, angularWidth: 0.6, angularHeight: 1.0, confidence: 0.84, class_name: "parking_sign" },
      ]);
      return {
        sourceDetections: merged.sourceDetections,
        mergedHeight: merged.angularHeight,
        distanceHeight: resolveDetectionDistanceAngularHeight(merged),
        mergeStackFactor: merged.mergeStackFactor,
      };
    });

    expect(metrics.sourceDetections).toBe(2);
    expect(metrics.distanceHeight).toBeLessThan(metrics.mergedHeight);
    expect(metrics.mergeStackFactor).toBeGreaterThan(0.35);
  });

  test("snaps sign projections to fixed offset from real Vassar Street polyline", async ({ page }) => {
    await mockInfrastructure(page);
    await page.goto("/?api_key=test-key");

    const vassar = VASSAR_WAY;
    const options = {
      streetBearing: VASSAR_BEARING, side: "left", oneway: null,
      wayGeometry: vassar.geometry, segmentIndex: 5,
      segmentStart: VASSAR_SEG_START, segmentEnd: VASSAR_SEG_END,
    };

    const projected = await page.evaluate(({ wayGeometry, options }) => {
      return {
        first: projectSignToCurbLine(42.3615, -71.0921, 24, 47, { ...options, wayGeometry }),
        second: projectSignToCurbLine(42.3615, -71.0921, 40, 58, { ...options, wayGeometry }),
      };
    }, { wayGeometry: vassar.geometry, options });

    const firstDist = distanceToPolylineMeters(projected.first, vassar.geometry);
    const secondDist = distanceToPolylineMeters(projected.second, vassar.geometry);
    expect(Math.abs(firstDist - secondDist)).toBeLessThan(0.8);
    expect(firstDist).toBeGreaterThan(0.5);
    expect(firstDist).toBeLessThan(5.0);
    expect(projected.first.curbOffsetMeters).toBeCloseTo(3.1, 5);
    expect(projected.second.curbOffsetMeters).toBeCloseTo(3.1, 5);
  });

  test("builds preview crops with 25% extra vertical margin", async ({ page }) => {
    await mockInfrastructure(page);
    await page.goto("/?api_key=test-key");

    const cropPlan = await page.evaluate(async () => {
      return await buildDetectionCropPlan(
        { heading: 45, pitch: -2, angularWidth: 0.5, angularHeight: 1, confidence: 0.91, class_name: "parking_sign" },
        "mock-pano",
      );
    });

    const expectedCropHeight = Math.round((8192 / 180) * 1 * 1.5);
    expect(cropPlan.requestBody.crop_height).toBe(expectedCropHeight);
  });

  test("popup preview stays stable across reopen after refinement", async ({ page }) => {
    await mockInfrastructure(page);
    await page.goto("/?api_key=test-key");

    const primarySrc = "data:image/jpeg;base64,PRIMARY_PREVIEW";
    const refinedSrc = "data:image/jpeg;base64,REFINED_PREVIEW";

    const state = await page.evaluate(async ({ primarySrc, refinedSrc }) => {
      let previewCalls = 0;
      fetchDetectionCropPreview = async () => { previewCalls++; return { src: previewCalls === 1 ? primarySrc : refinedSrc }; };
      refinePreviewViewWithPanoramaDetection = async (sign) => { sign.previewRefineAttempted = true; sign.previewRefined = true; return { panoId: "mock-pano", detection: {} }; };

      const sign = { previewContainerId: "preview-fixture", panoId: "mock-pano", heading: 45, pitch: -2, angularWidth: 0.5, angularHeight: 1, confidence: 0.91, class_name: "parking_sign" };
      const firstHost = document.createElement("div");
      firstHost.innerHTML = '<div class="sign-preview-popup" id="preview-fixture"></div>';
      await loadSignPreview(sign, { getElement() { return firstHost; } });

      const secondHost = document.createElement("div");
      secondHost.innerHTML = '<div class="sign-preview-popup" id="preview-fixture"></div>';
      await loadSignPreview(sign, { getElement() { return secondHost; } });

      return {
        previewCalls, previewSrc: sign.previewSrc,
        refinedPreviewSrc: sign.previewRefinedSrc || null,
        firstImageSrc: firstHost.querySelector("img")?.getAttribute("src") || null,
        secondImageSrc: secondHost.querySelector("img")?.getAttribute("src") || null,
      };
    }, { primarySrc, refinedSrc });

    expect(state.previewCalls).toBe(2);
    expect(state.previewSrc).toBe(primarySrc);
    expect(state.refinedPreviewSrc).toBe(refinedSrc);
    expect(state.firstImageSrc).toBe(primarySrc);
    expect(state.secondImageSrc).toBe(primarySrc);
  });

  test("falls back to single-view detection on real Vassar Street", async ({ page }) => {
    await mockInfrastructure(page);
    await page.addInitScript(() => { window.__TEST_PANORAMA_POSITION = { lat: 42.3614859, lng: -71.0921589 }; });
    await page.goto("/?api_key=test-key");

    await page.evaluate(({ segStart, segEnd }) => {
      currentPoints = [{
        lat: 42.3614859, lon: -71.0921589,
        bearing: 56.25, oneway: null, highway: "secondary",
        streetName: "Vassar Street",
        segmentStart: segStart, segmentEnd: segEnd,
      }];
      currentPanoIds = ["mock-pano"];
      showDetectionForIndex(0);
    }, { segStart: VASSAR_SEG_START, segEnd: VASSAR_SEG_END });

    await page.locator("#detectionStatus").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 10000 });

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")));
    expect(stored).not.toBeNull();
    expect(stored.detections).toHaveLength(1);
  });

  test("renders dashed road marker on real Vassar Street geometry", async ({ page }) => {
    await mockInfrastructure(page);
    await page.addInitScript(() => { window.__TEST_PANORAMA_POSITION = { lat: 42.3614859, lng: -71.0921589 }; });
    await page.goto("/?api_key=test-key");

    await page.evaluate(({ segStart, segEnd }) => {
      currentPoints = [{
        lat: 42.3614859, lon: -71.0921589,
        bearing: 56.25, oneway: null, highway: "secondary",
        streetName: "Vassar Street",
        segmentStart: segStart, segmentEnd: segEnd,
      }];
      currentPanoIds = ["mock-pano"];
      showDetectionForIndex(0);
    }, { segStart: VASSAR_SEG_START, segEnd: VASSAR_SEG_END });

    await page.locator("#detectionStatus").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 10000 });

    const roadMarkers = await page.evaluate(() =>
      signMarkersLayer._layers
        .filter((l) => l.options?.dashArray === "10 8")
        .map((l) => ({ color: l.options.color, latlngs: l._latlngs })),
    );

    expect(roadMarkers).toHaveLength(1);
    expect(roadMarkers[0].color).toBe("#f59e0b");
    expect(roadMarkers[0].latlngs.length).toBeGreaterThanOrEqual(2);
    expect(roadMarkers[0].latlngs[0]).not.toEqual(roadMarkers[0].latlngs[roadMarkers[0].latlngs.length - 1]);
  });

  test("resolves real Vassar Street geometry for 2D road marker", async ({ page }) => {
    await mockInfrastructure(page);
    await page.addInitScript(() => { window.__TEST_PANORAMA_POSITION = { lat: 42.3614859, lng: -71.0921589 }; });
    await page.goto("/?api_key=test-key");

    await page.evaluate(({ vassarGeo, segStart, segEnd, allWays }) => {
      fetchNearestStreetContext = async () => ({
        bearing: 56.25, oneway: null, highway: "secondary", lanes: "2",
        streetName: "Vassar Street",
        segmentStart: segStart, segmentEnd: segEnd,
        wayGeometry: vassarGeo, segmentIndex: 5, allWays,
      });
    }, { vassarGeo: VASSAR_WAY.geometry, segStart: VASSAR_SEG_START, segEnd: VASSAR_SEG_END, allWays: fixtureWays });

    await page.locator("#detectionStatus").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 10000 });

    const roadMarkers = await page.evaluate(() =>
      signMarkersLayer._layers.filter((l) => l.options?.dashArray === "10 8").map((l) => l._latlngs),
    );
    expect(roadMarkers).toHaveLength(1);
    expect(roadMarkers[0].length).toBeGreaterThan(2);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")));
    expect(stored?.detections?.[0]?.streetName).toBe("Vassar Street");
    expect(stored?.detections?.[0]?.wayGeometry?.length).toBe(16);
    expect(stored?.detections?.[0]?.allWays?.length).toBe(fixtureWays.length);
  });

  test("limits rule curves to real Albany Street intersections (Portland St, Main St)", async ({ page }) => {
    await mockInfrastructure(page);
    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(({ albanyGeo, allWays }) => {
      const signBase = projectSignToCurbLine(42.3620144, -71.093427, 6, 56.09, {
        streetBearing: 56.09, side: "right", oneway: null,
        wayGeometry: albanyGeo, segmentIndex: 8,
        segmentStart: albanyGeo[8], segmentEnd: albanyGeo[9],
        cameraHeading: 56.09,
      });
      const sign = {
        ...signBase, heading: 56.09, pitch: -2, confidence: 0.91,
        class_name: "parking_sign", segmentIndex: 8,
        ocrResult: {
          is_parking_sign: true,
          rules: [{ category: "no_parking", arrow_direction: "left", days: ["mon"], time_start: "00:00", time_end: "23:59" }],
          tow_zones: [],
        },
      };

      const intersections = findIntersectionNodes(albanyGeo, allWays);
      const maxDist = findDistanceToNextSign(sign, 1, [sign], albanyGeo, intersections);

      renderSignMapData({
        savedAt: Date.now(), source: "test", projectionVersion: 6,
        detections: [{
          camera: { lat: 42.3620144, lng: -71.093427 },
          panoId: "mock-pano", streetBearing: 56.09,
          segmentStart: albanyGeo[8], segmentEnd: albanyGeo[9],
          wayGeometry: albanyGeo, segmentIndex: 8, allWays,
          signs: [sign],
        }],
      });

      const renderedCurve = ruleCurvesLayer._layers[0]?._latlngs || [];
      let renderedCurveLength = 0;
      for (let i = 0; i < renderedCurve.length - 1; i++) {
        renderedCurveLength += haversineDistanceMeters(
          renderedCurve[i][0], renderedCurve[i][1],
          renderedCurve[i + 1][0], renderedCurve[i + 1][1],
        );
      }

      return {
        intersectionCount: intersections.length,
        intersectionNodeIndices: intersections.map((n) => n.nodeIndex),
        maxDist, renderedCurvePointCount: renderedCurve.length, renderedCurveLength,
      };
    }, { albanyGeo: ALBANY_WAY.geometry, allWays: fixtureWays });

    expect(result.intersectionCount).toBeGreaterThanOrEqual(2);
    expect(result.intersectionNodeIndices).toContain(0);
    expect(result.intersectionNodeIndices).toContain(17);
    expect(result.maxDist).toBeGreaterThan(10);
    expect(result.maxDist).toBeLessThan(250);
    expect(result.renderedCurvePointCount).toBeGreaterThanOrEqual(3);
    expect(result.renderedCurveLength).toBeGreaterThan(8);
  });

  test("projects signs at fixed offset from real Vassar Street polyline", async ({ page }) => {
    await mockInfrastructure(page, {
      detectPanoramaResponse: {
        status: 200,
        body: JSON.stringify({
          detections: [
            { heading: 47, pitch: -4.2, angular_width: 0.8, angular_height: 4.0, confidence: 0.87, class_name: "parking_sign", depth_anything_meters: 15.2, depth_anything_meters_raw: 15.0 },
            { heading: 61, pitch: -3.1, angular_width: 0.7, angular_height: 3.0, confidence: 0.81, class_name: "parking_sign", depth_anything_meters: 12.8, depth_anything_meters_raw: 12.5 },
          ],
          total_inference_time_ms: 55, slices_count: 3,
        }),
      },
    });

    await page.addInitScript(() => { window.__TEST_PANORAMA_POSITION = { lat: 42.3614859, lng: -71.0921589 }; });
    await page.goto("/?api_key=test-key");

    await page.evaluate(({ vassarGeo, segStart, segEnd, allWays }) => {
      fetchNearestStreetContext = async () => ({
        bearing: 56.25, oneway: null, highway: "secondary", lanes: "2",
        streetName: "Vassar Street",
        segmentStart: segStart, segmentEnd: segEnd,
        wayGeometry: vassarGeo, segmentIndex: 5, allWays,
      });
      currentPoints = [{
        lat: 42.3614859, lon: -71.0921589, bearing: 56.25,
        oneway: null, streetName: "Vassar Street",
        segmentStart: segStart, segmentEnd: segEnd,
        wayGeometry: vassarGeo, segmentIndex: 5,
      }];
      currentPanoIds = ["mock-pano"];
      showDetectionForIndex(0);
    }, { vassarGeo: VASSAR_WAY.geometry, segStart: VASSAR_SEG_START, segEnd: VASSAR_SEG_END, allWays: fixtureWays });

    await page.locator("#detectionStatus").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 10000 });

    const projection = await page.evaluate(() => JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")));
    const signs = projection.detections[0].signs;
    expect(signs).toHaveLength(2);

    const wayGeometry = projection.detections[0].wayGeometry;
    expect(Array.isArray(wayGeometry)).toBe(true);
    expect(wayGeometry.length).toBe(16);
    expect(signs[0].curbOffsetMeters).toBeCloseTo(3.1, 5);
    expect(signs[1].curbOffsetMeters).toBeCloseTo(3.1, 5);
    expect(signs.every((s) => Number.isFinite(s.alongStreetDistance))).toBe(true);
    expect(signs.every((s) => s.side === "left" || s.side === "right")).toBe(true);
  });
});
