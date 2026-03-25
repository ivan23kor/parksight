const { test, expect } = require("@playwright/test");

/**
 * E2E tests for street intersection detection using LIVE OSM API.
 * Tests exercise the production findIntersectionNodes() from js/streets.js.
 * Requires GOOGLE_MAPS_API_KEY env var for real Street View panoramas.
 */

function forwardBrowserConsole(page) {
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === "error") {
      process.stderr.write(`[browser:${type}] ${text}\n`);
    } else {
      process.stdout.write(`[browser:${type}] ${text}\n`);
    }
  });
  page.on("pageerror", (err) => {
    process.stderr.write(`[browser:CRASH] ${err.message}\n${err.stack || ""}\n`);
  });
  page.on("requestfailed", (req) => {
    process.stderr.write(`[browser:NET_FAIL] ${req.method()} ${req.url()} — ${req.failure()?.errorText || "unknown"}\n`);
  });
}

async function setupPage(page) {
  forwardBrowserConsole(page);
  // No stubs — use real Google Maps API (requires GOOGLE_MAPS_API_KEY env var)
  // No Overpass mock — use real API
}

test.describe("Street Intersection Detection E2E (real OSM data)", () => {
  test("Albany Street (way/442971020): detects Portland St and Main St intersections", async ({ page }) => {
    await setupPage(page);
    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(async () => {
      // Fetch the real fixture data through the production fetchStreets path
      const bounds = {
        getSouth: () => 42.3600, getWest: () => -71.0945,
        getNorth: () => 42.3635, getEast: () => -71.0890,
      };
      const ways = await fetchStreets(bounds);

      // Find Albany Street way/442971020
      const albany = ways.find((w) => w.id === 442971020);
      if (!albany) throw new Error("Albany Street way/442971020 not found in fetched data");

      const intersections = findIntersectionNodes(albany.geometry, ways);

      // Draw Albany Street polyline on the 2D map
      const albanyCoords = albany.geometry.map((n) => [n.lat, n.lng ?? n.lon]);
      L.polyline(albanyCoords, { color: "#3b82f6", weight: 4, opacity: 0.8 }).addTo(map);

      // Draw intersection dots on the 2D map
      intersections.forEach((n) => {
        const hasPrimary = n.crossStreetTags.some((t) => t.highway === "primary");
        const color = hasPrimary ? "#ef4444" : "#22c55e"; // red for primary, green for secondary
        L.circleMarker([n.lat, n.lng], {
          radius: 10,
          fillColor: color,
          color: "#fff",
          weight: 2,
          opacity: 1,
          fillOpacity: 0.9,
        })
          .bindTooltip(`Intersection @ node[${n.nodeIndex}]<br/>highway: ${n.crossStreetTags.map((t) => t.highway).join(", ")}`, { permanent: false })
          .addTo(map);
      });

      // Fit map to show all markers
      const allPoints = [...albanyCoords, ...intersections.map((n) => [n.lat, n.lng])];
      map.fitBounds(allPoints, { padding: [50, 50] });

      return {
        wayNodeCount: albany.geometry.length,
        intersectionCount: intersections.length,
        intersections: intersections.map((n) => ({
          nodeIndex: n.nodeIndex,
          lat: n.lat,
          lng: n.lng,
          crossStreetTags: n.crossStreetTags,
        })),
      };
    });

    expect(result.wayNodeCount).toBe(18);
    expect(result.intersectionCount).toBeGreaterThanOrEqual(2);

    const nodeIndices = result.intersections.map((n) => n.nodeIndex);
    expect(nodeIndices).toContain(0);   // Portland St
    expect(nodeIndices).toContain(17);  // Main St

    // Verify real coordinate positions
    const portlandNode = result.intersections.find((n) => n.nodeIndex === 0);
    expect(portlandNode.lat).toBeCloseTo(42.3619059, 4);
    expect(portlandNode.lng).toBeCloseTo(-71.0938619, 4);

    const mainNode = result.intersections.find((n) => n.nodeIndex === 17);
    expect(mainNode.lat).toBeCloseTo(42.3628543, 4);
    expect(mainNode.lng).toBeCloseTo(-71.0920014, 4);

    // Verify cross-street tags contain real highway classifications
    expect(portlandNode.crossStreetTags.some((t) => t.highway === "secondary")).toBe(true);
    expect(mainNode.crossStreetTags.some((t) => t.highway === "primary")).toBe(true);

    // Pause so user can inspect the browser
    await page.pause();
  });
});
