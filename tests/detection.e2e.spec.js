const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { mockInfrastructure, PREVIEW_IMAGE_BASE64 } = require("./helpers/mock-infrastructure");

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

// ─── Test-specific data and helpers ─────────────────────────────────────
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

const ANGULAR_DETECTIONS_RESPONSE = {
  status: 200,
  body: JSON.stringify({
    detections: [
      {
        x1: 0, y1: 0, x2: 40, y2: 180,
        full_pano_x1: 2508, full_pano_y1: 4200, full_pano_x2: 2548, full_pano_y2: 4380,
        heading: 281, pitch: -4.2, angular_width: 0.8, angular_height: 4.0,
        confidence: 0.87, class_name: "parking_sign",
        depth_anything_meters: 15.2, depth_anything_meters_raw: 15.0,
      },
      {
        x1: 60, y1: 10, x2: 98, y2: 160,
        full_pano_x1: 3148, full_pano_y1: 4180, full_pano_x2: 3186, full_pano_y2: 4340,
        heading: 295, pitch: -3.1, angular_width: 0.7, angular_height: 3.0,
        confidence: 0.81, class_name: "parking_sign",
        depth_anything_meters: 12.8, depth_anything_meters_raw: 12.5,
      },
    ],
    total_inference_time_ms: 55, stitched_width: 1024, stitched_height: 512, pano_heading: 45,
  }),
};

// ─── Tests ─────────────────────────────────────────────────────────────

test.describe("detection flow (real OSM data)", () => {
  test("merged detections use representative primitive box height for stacked clusters", async ({ page }) => {
    await mockInfrastructure(page, { fixtureWays });
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
    await mockInfrastructure(page, { fixtureWays });
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
    await mockInfrastructure(page, { fixtureWays });
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
    await mockInfrastructure(page, { fixtureWays });
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
    await mockInfrastructure(page, { fixtureWays, detectPanoramaResponse: ANGULAR_DETECTIONS_RESPONSE });
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

    await page.locator("#detectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 10000 });

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")));
    expect(stored).not.toBeNull();
    expect(stored.detections).toHaveLength(1);
  });

  test("renders dashed road marker on real Vassar Street geometry", async ({ page }) => {
    await mockInfrastructure(page, { fixtureWays, detectPanoramaResponse: ANGULAR_DETECTIONS_RESPONSE });
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

    await page.locator("#detectBtn").click();
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
    await mockInfrastructure(page, { fixtureWays, detectPanoramaResponse: ANGULAR_DETECTIONS_RESPONSE });
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

    await page.locator("#detectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 10000 });

    const roadMarkers = await page.evaluate(() =>
      signMarkersLayer._layers.filter((l) => l.options?.dashArray === "10 8").map((l) => l._latlngs),
    );
    expect(roadMarkers).toHaveLength(1);
    expect(roadMarkers[0].length).toBeGreaterThan(2);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")));
    expect(stored?.detections?.[0]?.streetName).toBe("Vassar Street");
    expect(stored?.detections?.[0]?.wayGeometry?.length).toBe(16);
  });

  test("limits rule curves to real Albany Street intersections (Portland St, Main St)", async ({ page }) => {
    await mockInfrastructure(page, { fixtureWays });
    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(async ({ albanyGeo, allWays }) => {
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

      await renderSignMapData({
        savedAt: Date.now(), source: "test", projectionVersion: 6,
        detections: [{
          camera: { lat: 42.3620144, lng: -71.093427 },
          panoId: "mock-pano", streetBearing: 56.09,
          segmentStart: albanyGeo[8], segmentEnd: albanyGeo[9],
          wayGeometry: albanyGeo, segmentIndex: 8,
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
      fixtureWays,
      detectPanoramaResponse: {
        status: 200,
        body: ANGULAR_DETECTIONS_RESPONSE.body,
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

    await page.locator("#detectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 10000 });

    const projection = await page.evaluate(() => JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")));
    const signs = projection.detections[0].signs.filter((sign, index, all) => {
      const key = `${sign.heading?.toFixed?.(2) ?? sign.heading}:${sign.lat?.toFixed?.(6) ?? sign.lat}:${sign.lng?.toFixed?.(6) ?? sign.lng}`;
      return index === all.findIndex((candidate) => {
        const candidateKey = `${candidate.heading?.toFixed?.(2) ?? candidate.heading}:${candidate.lat?.toFixed?.(6) ?? candidate.lat}:${candidate.lng?.toFixed?.(6) ?? candidate.lng}`;
        return candidateKey === key;
      });
    });
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
