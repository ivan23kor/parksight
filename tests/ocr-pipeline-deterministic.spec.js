/**
 * Deterministic OCR pipeline test.
 *
 * Tests the full frontend pipeline (detection → clustering → OCR → projection → map rendering)
 * using mockInfrastructure to intercept all external API calls.
 * No Google API keys, no backend, no network. Fully deterministic.
 */

const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { mockInfrastructure, PREVIEW_IMAGE_BASE64 } = require("./helpers/mock-infrastructure");

const fixtureWays = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "fixtures/vassar-street-mit-ways.json"),
    "utf-8",
  ),
);

const VASSAR_WAY = fixtureWays.find((w) => w.id === 28631895);
const VASSAR_SEG_START = VASSAR_WAY.geometry[5];
const VASSAR_SEG_END = VASSAR_WAY.geometry[6];

// Realistic angular detection response (2 signs, one left one right of heading)
const DETECT_TILES_RESPONSE = {
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
};

// OCR response with realistic parking rules
const OCR_RESPONSE = {
  is_parking_sign: true,
  confidence_readable: "high",
  rules: [
    {
      category: "no_parking",
      arrow_direction: "left",
      days: ["mon", "tue", "wed", "thu", "fri"],
      time_start: "08:00",
      time_end: "18:00",
      time_limit_minutes: null,
      payment_required: null,
      permit_zone: null,
      additional_text: null,
    },
  ],
  tow_zones: [],
  raw_text: "NO PARKING\nMON THRU FRI\n8AM-6PM",
};

test.describe("OCR pipeline (deterministic)", () => {
  test("runs full detection → OCR → projection → map rendering pipeline", async ({ page }) => {
    await mockInfrastructure(page, {
      fixtureWays,
      detectTilesResponse: DETECT_TILES_RESPONSE,
      ocrResponse: OCR_RESPONSE,
    });
    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3614859, lng: -71.0921589 };
    });
    await page.goto("/?api_key=test-key");

    // Set up detection context
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

    // Run detection
    await page.locator("#detectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 15000 });

    // Wait for OCR to complete
    await expect(page.locator("#detectionStatus")).toContainText("OCR", { timeout: 15000 });

    // Verify currentDetections have OCR results
    const detections = await page.evaluate(() => currentDetections);
    expect(detections.length).toBeGreaterThanOrEqual(1);
    for (const det of detections) {
      expect(det.ocrResult).toBeDefined();
      expect(det.ocrResult.is_parking_sign).toBe(true);
      expect(det.ocrResult.rules).toBeDefined();
      expect(det.ocrResult.rules.length).toBeGreaterThan(0);
      expect(det.ocrResult.rules[0].category).toBe("no_parking");
      expect(det.ocrResult.rules[0].days).toContain("mon");
    }

    // Verify sign map data persisted to localStorage
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")),
    );
    expect(stored).not.toBeNull();
    expect(stored.detections).toHaveLength(1);
    expect(stored.detections[0].panoId).toBe("mock-pano");
    expect(stored.detections[0].camera.lat).toBeCloseTo(42.3615, 2);
    expect(stored.detections[0].signs.length).toBeGreaterThanOrEqual(1);

    // Verify signs have projected positions
    for (const sign of stored.detections[0].signs) {
      expect(Number.isFinite(sign.lat)).toBe(true);
      expect(Number.isFinite(sign.lng)).toBe(true);
      expect(Number.isFinite(sign.distance)).toBe(true);
      expect(sign.ocrResult).toBeDefined();
    }

    // Verify sign markers rendered on map
    const signMarkerCount = await page.evaluate(() => signMarkersLayer._layers.length);
    expect(signMarkerCount).toBeGreaterThan(0);

    // Verify rule curves rendered
    const ruleCurveCount = await page.evaluate(() => ruleCurvesLayer._layers.length);
    expect(ruleCurveCount).toBeGreaterThan(0);
  });

  test("deduplicates signs on repeated detection of same pano", async ({ page }) => {
    await mockInfrastructure(page, {
      fixtureWays,
      detectTilesResponse: DETECT_TILES_RESPONSE,
      ocrResponse: OCR_RESPONSE,
    });
    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3614859, lng: -71.0921589 };
    });
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

    // First detection
    await page.locator("#detectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 15000 });
    await expect(page.locator("#detectionStatus")).toContainText("OCR", { timeout: 15000 });

    const firstRunData = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")),
    );
    const firstSignCount = firstRunData.detections.reduce(
      (sum, d) => sum + d.signs.length, 0,
    );
    const firstUuids = firstRunData.detections.flatMap((d) => d.signs.map((s) => s.uuid));

    // Second detection on same pano
    await page.locator("#detectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 sign(s)", { timeout: 15000 });
    await expect(page.locator("#detectionStatus")).toContainText("OCR", { timeout: 15000 });

    const secondRunData = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")),
    );
    const secondSignCount = secondRunData.detections.reduce(
      (sum, d) => sum + d.signs.length, 0,
    );
    const secondUuids = secondRunData.detections.flatMap((d) => d.signs.map((s) => s.uuid));

    // Signs should be deduplicated — same UUIDs, no extra duplicates
    expect(secondSignCount).toBe(firstSignCount);
    for (const uuid of firstUuids) {
      expect(secondUuids).toContain(uuid);
    }

    // Only one detection entry for the same pano (merged, not duplicated)
    const panoIds = secondRunData.detections.map((d) => d.panoId);
    const mockPanoCount = panoIds.filter((id) => id === "mock-pano").length;
    expect(mockPanoCount).toBe(1);
  });

  test("preserves OCR results when sign popup reopens", async ({ page }) => {
    await mockInfrastructure(page, {
      fixtureWays,
      detectTilesResponse: DETECT_TILES_RESPONSE,
      ocrResponse: OCR_RESPONSE,
    });
    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3614859, lng: -71.0921589 };
    });
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
    await expect(page.locator("#detectionStatus")).toContainText("OCR", { timeout: 15000 });

    // Capture OCR state after first render
    const ocrAfterFirstRender = await page.evaluate(() =>
      currentDetections.map((d) => d.ocrResult?.raw_text ?? null),
    );

    // Force a re-render of sign data (simulates popup reopen / hydration)
    await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem("parksight_latest_sign_map_data"));
      renderSignMapData(data);
    });

    // Wait for render to settle
    await page.waitForTimeout(500);

    // Verify OCR results are still present on currentDetections
    const ocrAfterReRender = await page.evaluate(() =>
      currentDetections.map((d) => d.ocrResult?.raw_text ?? null),
    );

    expect(ocrAfterReRender).toEqual(ocrAfterFirstRender);
    for (const rawText of ocrAfterReRender) {
      expect(rawText).toBeTruthy();
    }
  });
});
