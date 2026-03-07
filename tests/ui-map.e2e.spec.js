const { test, expect } = require("@playwright/test");

const PREVIEW_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";

const LEAFLET_STUB = `
(() => {
  class LayerGroup {
    constructor() {
      this._layers = [];
    }
    addTo() { return this; }
    clearLayers() { this._layers = []; return this; }
    addLayer(layer) { this._layers.push(layer); return this; }
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
    _center: { lat: 42.3615, lng: -71.0921 },
    setView(center, zoom) { this._center = { lat: center[0], lng: center[1] }; this._zoom = zoom; return this; },
    getBounds() {
      return {
        getNorth: () => this._center.lat + 0.001,
        getSouth: () => this._center.lat - 0.001,
        getEast: () => this._center.lng + 0.001,
        getWest: () => this._center.lng - 0.001,
      };
    },
    getZoom() { return this._zoom; },
    getCenter() { return this._center; },
    invalidateSize() {},
    fitBounds(bounds) { this._fitBounds = bounds; },
    on(event, handler) { mapHandlers[event] = handler; return this; },
    getContainer() { return document.getElementById("map"); },
    dragging: { enable() {}, disable() {} },
    doubleClickZoom: { enable() {}, disable() {} },
  };

  window.L = {
    map() { return map; },
    tileLayer() { return { addTo() { return this; } }; },
    layerGroup() { return new LayerGroup(); },
    circle(latlng, options) { return makeLayer(latlng, options); },
    circleMarker(latlng, options) { return makeLayer(latlng, options); },
    rectangle(bounds, options) {
      const layer = makeLayer(bounds[0], options);
      layer.setBounds = function setBounds(next) { this._bounds = next; return this; };
      return layer;
    },
    latLngBounds(points) { return points; },
  };
})();
`;

const TURF_STUB = `
window.turf = {
  point(coords) { return { coords }; },
  bearing(start, end) {
    const avgLat = (start.coords[1] + end.coords[1]) / 2;
    const dx =
      (end.coords[0] - start.coords[0]) *
      111320 *
      Math.cos((avgLat * Math.PI) / 180);
    const dy = (end.coords[1] - start.coords[1]) * 111320;
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  },
  distance(start, end) {
    const avgLat = (start.coords[1] + end.coords[1]) / 2;
    const dx =
      (end.coords[0] - start.coords[0]) *
      111320 *
      Math.cos((avgLat * Math.PI) / 180);
    const dy = (end.coords[1] - start.coords[1]) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
  },
  lineString(coordinates) { return { geometry: { type: "LineString", coordinates } }; },
  bboxClip(line) { return line; },
};
`;

const GOOGLE_MAPS_STUB = `
(() => {
  class StreetViewPanorama {
    constructor(container, options = {}) {
      this._container = container;
      this._pano = options.pano || "mock-pano";
      this._pov = options.pov || { heading: 270, pitch: 0, zoom: 1 };
      const pos = window.__TEST_PANORAMA_POSITION || { lat: 42.3615, lng: -71.0921 };
      this._position = pos;
    }
    set(name, value) {
      if (name === "zoom") {
        this._pov = { ...this._pov, zoom: value };
      }
    }
    setPano(pano) { this._pano = pano; }
    getPano() { return this._pano; }
    setPov(pov) { this._pov = { ...this._pov, ...pov }; }
    getPov() { return this._pov; }
    getPosition() {
      return {
        lat: () => this._position.lat,
        lng: () => this._position.lng,
      };
    }
    getContainer() { return this._container; }
    addListener() { return { remove() {} }; }
  }

  window.google = {
    maps: {
      StreetViewPanorama,
    },
  };

  setTimeout(() => {
    if (typeof window.initApp === "function") {
      window.initApp();
    }
  }, 0);
})();
`;

async function mockExternalDependencies(page, options = {}) {
  const detectSahiResponse =
    options.detectSahiResponse ??
    (() => ({
      status: 404,
      body: JSON.stringify({ detail: "Not Found" }),
    }));

  const detectResponse =
    options.detectResponse ??
    (() => ({
      detections: [
        { x1: 60, y1: 150, x2: 100, y2: 320, confidence: 0.91, class_name: "parking_sign" },
        { x1: 420, y1: 140, x2: 458, y2: 300, confidence: 0.84, class_name: "parking_sign" },
      ],
      inference_time_ms: 42,
      image_width: 640,
      image_height: 360,
    }));

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

  await page.route("https://tile.googleapis.com/v1/createSession?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ session: "mock-session" }),
    });
  });
  await page.route("https://tile.googleapis.com/v1/streetview/panoIds?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ panoIds: ["mock-pano"] }),
    });
  });
  await page.route("https://tile.googleapis.com/v1/streetview/metadata?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        heading: 45,
        tilt: 90,
        roll: 0,
        imageWidth: 16384,
        imageHeight: 8192,
      }),
    });
  });

  await page.route("http://127.0.0.1:8000/detect-sahi", async (route) => {
    const response =
      typeof detectSahiResponse === "function"
        ? detectSahiResponse(route.request())
        : detectSahiResponse;
    await route.fulfill({
      status: response.status,
      contentType: response.contentType || "application/json",
      body: response.body,
    });
  });
  await page.route("http://127.0.0.1:8000/detect", async (route) => {
    const response =
      typeof detectResponse === "function"
        ? detectResponse(route.request())
        : detectResponse;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  await page.route("http://127.0.0.1:8000/crop-sign-tiles", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.save).toBe(false);
    expect(body.include_image).toBe(true);
    expect(Array.isArray(body.tiles)).toBe(true);
    expect(body.tiles.length).toBeGreaterThan(0);
    expect(typeof body.session_token).toBe("string");
    expect(body.session_token.length).toBeGreaterThan(0);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        width: 200,
        height: 300,
        image_base64: PREVIEW_IMAGE_BASE64,
      }),
    });
  });
}

function perpendicularDistanceMeters(point, segment) {
  const originLat = (segment.start.lat + segment.end.lat) / 2;
  const originLng = (segment.start.lng + segment.end.lng) / 2;
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((originLat * Math.PI) / 180);
  const toLocal = (lat, lng) => ({
    x: (lng - originLng) * lngScale,
    y: (lat - originLat) * latScale,
  });

  const a = toLocal(segment.start.lat, segment.start.lng);
  const b = toLocal(segment.end.lat, segment.end.lng);
  const p = toLocal(point.lat, point.lng);
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const area2 = Math.abs(abx * apy - aby * apx);
  const len = Math.sqrt(abx * abx + aby * aby);
  return area2 / len;
}

test.describe("ui-map detection flow", () => {
  test("builds preview crops with 25% extra vertical margin above and below the sign", async ({
    page,
  }) => {
    await mockExternalDependencies(page);
    await page.goto("/ui-map/?api_key=test-key");

    const cropPlan = await page.evaluate(async () => {
      return await buildDetectionCropPlan(
        {
          heading: 45,
          pitch: -2,
          angularWidth: 0.5,
          angularHeight: 1,
          confidence: 0.91,
          class_name: "parking_sign",
        },
        "mock-pano",
      );
    });

    const expectedCropHeight = Math.round((8192 / 180) * 1 * 1.5);
    expect(cropPlan.requestBody.crop_height).toBe(expectedCropHeight);
  });

  test("fails hard when SAHI detection is unavailable", async ({
    page,
  }) => {
    await mockExternalDependencies(page);
    await page.goto("/ui-map/?api_key=test-key");

    await expect(page.locator("#detectionStatus")).toContainText("Click \"Detect\"");
    await page.locator("#redetectBtn").click();

    await expect(page.locator("#detectionStatus")).toContainText("Detection failed.");

    const stored = await page.evaluate(() =>
      localStorage.getItem("parksight_latest_sign_map_data"),
    );
    expect(stored).toBeNull();
  });

  test("projects signs along a curb line parallel to the selected street segment", async ({
    page,
  }) => {
    await mockExternalDependencies(page, {
      detectSahiResponse: {
        status: 200,
        body: JSON.stringify({
          detections: [
            {
              heading: 47,
              pitch: -0.8,
              angular_width: 0.8,
              angular_height: 0.8,
              confidence: 0.87,
              class_name: "parking_sign",
            },
            {
              heading: 50,
              pitch: -0.6,
              angular_width: 0.7,
              angular_height: 0.7,
              confidence: 0.81,
              class_name: "parking_sign",
            },
          ],
          total_inference_time_ms: 55,
          slices_count: 3,
        }),
      },
    });

    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3615, lng: -71.0921 };
    });

    await page.goto("/ui-map/?api_key=test-key");
    await expect(page.locator("#detectionStatus")).toContainText("Click \"Detect\"");

    await page.evaluate(async () => {
      currentPoints = [
        {
          lat: 42.3615,
          lon: -71.0921,
          bearing: 36.5,
          oneway: null,
          streetName: "Test Street",
          segmentStart: { lat: 42.3610, lon: -71.0926 },
          segmentEnd: { lat: 42.3620, lon: -71.0916 },
        },
      ];
      currentPanoIds = ["mock-pano"];
      await showDetectionForIndex(0);
    });

    await page.locator("#redetectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 parking signs");

    const projection = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")),
    );
    const signs = projection.detections[0].signs;
    expect(signs).toHaveLength(2);

    const segment = {
      start: { lat: 42.3610, lng: -71.0926 },
      end: { lat: 42.3620, lng: -71.0916 },
    };
    const distances = signs.map((sign) => perpendicularDistanceMeters(sign, segment));
    expect(Math.abs(distances[0] - distances[1])).toBeLessThan(0.75);
    expect(distances[0]).toBeGreaterThan(2.4);
    expect(distances[0]).toBeLessThan(4.25);
  });
});
