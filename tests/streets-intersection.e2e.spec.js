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
  test("Vassar Street: detects Main St and Massachusetts Ave intersections", async ({ page }) => {
    await setupPage(page);
    await page.goto("/?api_key=test-key");

    const result = await page.evaluate(async () => {
      // Smaller bounds to avoid Overpass timeout
      const bounds = {
        getSouth: () => 42.3595, getWest: () => -71.0945,
        getNorth: () => 42.3635, getEast: () => -71.0890,
      };
      const ways = await fetchStreets(bounds);

      // Find all Vassar Street ways
      const vassarWays = ways.filter((w) => w.tags?.name === "Vassar Street");

      // Collect ALL intersections across all Vassar Street ways
      const allIntersections = [];
      for (const vassar of vassarWays) {
        const intersections = findIntersectionNodes(vassar.geometry, ways);
        for (const inter of intersections) {
          inter.wayId = vassar.id;
          allIntersections.push(inter);
        }

        // Draw each Vassar Street segment
        const coords = vassar.geometry.map((n) => [n.lat, n.lng ?? n.lon]);
        L.polyline(coords, { color: "#3b82f6", weight: 4, opacity: 0.8 }).addTo(map);
      }

      // Draw ALL intersection dots on the 2D map
      allIntersections.forEach((n) => {
        const hasPrimary = n.crossStreetTags.some((t) => t.highway === "primary");
        const hasSecondary = n.crossStreetTags.some((t) => t.highway === "secondary");
        const color = hasPrimary ? "#ef4444" : hasSecondary ? "#22c55e" : "#f59e0b";
        L.circleMarker([n.lat, n.lng], {
          radius: 10,
          fillColor: color,
          color: "#fff",
          weight: 2,
          opacity: 1,
          fillOpacity: 0.9,
        })
          .bindTooltip(`Intersection @ node[${n.nodeIndex}]<br/>${n.crossStreetTags.map((t) => t.name).filter(Boolean).join(" / ")}<br/>highway: ${n.crossStreetTags.map((t) => t.highway).join(", ")}`, { permanent: false })
          .addTo(map);
      });

      // Fit map to show all markers
      const allPoints = allIntersections.map((n) => [n.lat, n.lng]);
      if (allPoints.length > 0) {
        map.fitBounds(allPoints, { padding: [50, 50] });
      }

      return {
        totalVassarWays: vassarWays.length,
        intersectionCount: allIntersections.length,
        intersections: allIntersections.map((n) => ({
          wayId: n.wayId,
          nodeIndex: n.nodeIndex,
          lat: n.lat,
          lng: n.lng,
          crossStreetNames: n.crossStreetTags.map((t) => t.name).filter(Boolean),
          crossStreetHighways: n.crossStreetTags.map((t) => t.highway).filter(Boolean),
        })),
      };
    });

    // Log for debugging
    console.log("Vassar Street ways found:", result.totalVassarWays);
    console.log("Intersections found:", JSON.stringify(result.intersections, null, 2));

    // Pause BEFORE assertions so user can see the map
    await page.pause();

    expect(result.totalVassarWays).toBeGreaterThan(0);
    expect(result.intersectionCount).toBeGreaterThanOrEqual(2);

    // Verify intersections with Main St and Massachusetts Ave
    const hasMainSt = result.intersections.some((n) =>
      n.crossStreetNames.some((name) => name?.includes("Main"))
    );
    const hasMassAve = result.intersections.some((n) =>
      n.crossStreetNames.some((name) => name?.includes("Massachusetts") || name?.includes("Mass Ave"))
    );

    expect(hasMainSt).toBe(true);
    expect(hasMassAve).toBe(true);
  });
});
