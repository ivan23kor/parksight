const { test, expect } = require("@playwright/test");
const { forwardBrowserConsole } = require("./helpers/mock-infrastructure");

/**
 * Live area-scan E2E — real APIs, no mocks.
 * Diagnoses: OCR 502s, missing detections, wrong crops.
 *
 * Run:
 *   GOOGLE_MAPS_API_KEY=... GEMINI_API_KEY=... RUN_LIVE_TESTS=1 \
 *     bunx playwright test tests/area-scan-live.e2e.spec.js
 */

// Mass Ave near Central Sq — known parking signs
const SCAN_CENTER = { lat: 42.3650, lng: -71.1032 };
const SCAN_POLYGON_RING = [
  [-71.1036, 42.3653],
  [-71.1028, 42.3653],
  [-71.1028, 42.3647],
  [-71.1036, 42.3647],
  [-71.1036, 42.3653],
];

test.describe(
  !process.env.RUN_LIVE_TESTS ? "live area scan (skipped)" : "live area scan",
  () => {
    if (!process.env.RUN_LIVE_TESTS) test.skip();
    test.setTimeout(180_000);

    test("area scan pipeline: detections, crop consistency, no 502s", async ({
      page,
    }) => {
      // -- collectors --
      const traceLogs = [];
      const networkErrors = [];
      const TRACE_TAGS = [
        "[SCAN-TRACE]",
        "[DETECT-TILES-REQ]",
        "[CROP-DIAG]",
        "[OCR-RESULT]",
        "[OCR-ERROR]",
      ];

      forwardBrowserConsole(page);

      page.on("console", (msg) => {
        const text = msg.text();
        for (const tag of TRACE_TAGS) {
          if (text.startsWith(tag)) {
            const jsonStr = text.slice(text.indexOf("{"));
            try {
              traceLogs.push({ tag, data: JSON.parse(jsonStr) });
            } catch {
              traceLogs.push({ tag, raw: text });
            }
            break;
          }
        }
      });

      page.on("response", (resp) => {
        if (resp.status() >= 400) {
          networkErrors.push({
            url: resp.url(),
            status: resp.status(),
            statusText: resp.statusText(),
          });
        }
      });

      // -- step 1: check backend --
      const healthResp = await page.request.get("http://127.0.0.1:8000/health");
      expect(healthResp.ok()).toBe(true);

      // -- step 2: load app --
      await page.goto("http://127.0.0.1:8080");
      await page.waitForFunction(
        () =>
          typeof map !== "undefined" && typeof startAreaScan === "function",
        { timeout: 30_000 },
      );

      // -- step 3: navigate to scan area --
      await page.evaluate(
        ({ lat, lng }) => map.setView([lat, lng], 18),
        SCAN_CENTER,
      );
      await page.waitForTimeout(2000);

      // -- step 4: run area scan programmatically --
      await page.evaluate(async (ring) => {
        const polygon = turf.polygon([ring]);
        areaScanState.MAX_PANOS = 10;
        await startAreaScan(polygon);
      }, SCAN_POLYGON_RING);

      // -- step 5: wait for all processing --
      await page.waitForFunction(
        () => {
          const s = areaScanState;
          const total = s.discoveredPanos.size;
          return (
            total > 0 &&
            s.processed >= total &&
            !s.workerBusy &&
            s.detectionQueue.length === 0
          );
        },
        { timeout: 120_000 },
      );

      // Wait for OCR to complete too
      await page.waitForFunction(
        () => {
          const s = areaScanState;
          return s.ocrDone >= s.processed;
        },
        { timeout: 60_000 },
      );

      // -- step 6: collect results --
      const scanResult = await page.evaluate(() => ({
        discoveredPanos: areaScanState.discoveredPanos.size,
        processed: areaScanState.processed,
        ocrDone: areaScanState.ocrDone,
        cancelled: areaScanState.cancelled,
        panoStatuses: Array.from(
          areaScanState.discoveredPanos.entries(),
        ).map(([id, e]) => ({
          panoId: id,
          status: e.status,
        })),
      }));

      // -- step 7: diagnostics dump --
      const ocr502s = networkErrors.filter(
        (e) => e.url.includes("/ocr-sign") && e.status === 502,
      );
      const tileWrapping = traceLogs.filter(
        (l) =>
          l.tag === "[DETECT-TILES-REQ]" &&
          (l.data?.hasNegativeX || l.data?.hasOverflowX),
      );
      const ocrErrors = traceLogs.filter((l) => l.tag === "[OCR-ERROR]");
      const detectionTraces = traceLogs.filter(
        (l) => l.tag === "[SCAN-TRACE]" && l.data?.rawDetections !== undefined,
      );
      const totalDetections = detectionTraces.reduce(
        (sum, l) => sum + (l.data?.rawDetections ?? 0),
        0,
      );

      console.log("\n=== AREA SCAN LIVE DIAGNOSTICS ===");
      console.log(`Panos discovered: ${scanResult.discoveredPanos}`);
      console.log(`Panos processed: ${scanResult.processed}`);
      console.log(`OCR done: ${scanResult.ocrDone}`);
      console.log(`Total raw detections: ${totalDetections}`);
      console.log(`OCR 502 errors: ${ocr502s.length}`);
      console.log(`OCR errors (any): ${ocrErrors.length}`);
      console.log(`Tile wrapping events: ${tileWrapping.length}`);
      console.log(`Network errors (all): ${networkErrors.length}`);

      if (ocr502s.length > 0) {
        console.log("\nOCR 502 details:", JSON.stringify(ocr502s, null, 2));
      }
      if (ocrErrors.length > 0) {
        console.log("\nOCR error details:", JSON.stringify(ocrErrors, null, 2));
      }
      if (tileWrapping.length > 0) {
        console.log(
          "\nTile wrapping details:",
          JSON.stringify(tileWrapping, null, 2),
        );
      }
      if (networkErrors.length > 0) {
        console.log(
          "\nAll network errors:",
          JSON.stringify(networkErrors, null, 2),
        );
      }

      // Dump all trace logs for full pipeline analysis
      console.log(
        "\nFull trace log count by tag:",
        TRACE_TAGS.map(
          (t) => `${t}: ${traceLogs.filter((l) => l.tag === t).length}`,
        ).join(", "),
      );

      // Per-pano summary
      const scanTraces = traceLogs.filter(
        (l) => l.tag === "[SCAN-TRACE]",
      );
      const panoIds = [
        ...new Set(scanTraces.map((l) => l.data?.panoId).filter(Boolean)),
      ];
      for (const pid of panoIds) {
        const panoTraces = scanTraces.filter((l) => l.data?.panoId === pid);
        const meta = panoTraces.find((l) => l.data?.metaHeading !== undefined);
        const det = panoTraces.find(
          (l) => l.data?.rawDetections !== undefined,
        );
        const ocr = panoTraces.find((l) => l.data?.results !== undefined);
        console.log(
          `\n  pano=${pid.substring(0, 12)}... drift=${meta?.data?.coordDriftMeters ?? "?"}m ` +
            `dets=${det?.data?.rawDetections ?? "?"} ` +
            `ocr=[${(ocr?.data?.results ?? []).map((r) => (r.isParkingSign ? "SIGN" : r.ocrError ? "ERR" : "skip")).join(",")}]`,
        );
      }

      await page.screenshot({
        path: "test-results/area-scan-live-final.png",
        fullPage: true,
      });

      // -- step 8: assertions --
      expect(
        scanResult.discoveredPanos,
        "should discover at least 1 pano",
      ).toBeGreaterThan(0);
      expect(
        scanResult.processed,
        "all discovered panos should be processed",
      ).toBe(scanResult.discoveredPanos);
      expect(ocr502s, "no 502 errors from /ocr-sign").toHaveLength(0);
    });
  },
);
