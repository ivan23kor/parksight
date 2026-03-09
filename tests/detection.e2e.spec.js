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
    polyline(latlngs, options) {
      const layer = makeLayer(latlngs[0], options);
      layer._latlngs = latlngs;
      return layer;
    },
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
  const detectPanoramaResponse =
    options.detectPanoramaResponse ??
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

  await page.route("http://127.0.0.1:8000/detect-panorama", async (route) => {
    const response =
      typeof detectPanoramaResponse === "function"
        ? detectPanoramaResponse(route.request())
        : detectPanoramaResponse;
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

function distanceToPolylineMeters(point, wayGeometry) {
  let best = Infinity;

  for (let i = 0; i < wayGeometry.length - 1; i += 1) {
    const start = {
      lat: wayGeometry[i].lat,
      lng: wayGeometry[i].lng ?? wayGeometry[i].lon,
    };
    const end = {
      lat: wayGeometry[i + 1].lat,
      lng: wayGeometry[i + 1].lng ?? wayGeometry[i + 1].lon,
    };
    best = Math.min(best, perpendicularDistanceMeters(point, { start, end }));
  }

  return best;
}

async function getSvgPathMetrics(locator) {
  return locator.evaluate((node) => {
    const d = node.getAttribute("d") || "";
    const matches = Array.from(
      d.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)\s*(-?\d+(?:\.\d+)?)/g),
    );
    const points = matches.map(([, x, y]) => ({
      x: Number(x),
      y: Number(y),
    }));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);

    return {
      d,
      pointCount: points.length,
      xSpan: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
      ySpan: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
    };
  });
}

test.describe("detection flow", () => {
  test("uses representative primitive box height when merged detections span a stacked sign cluster", async ({
    page,
  }) => {
    await mockExternalDependencies(page);
    await page.goto("/?api_key=test-key");

    const metrics = await page.evaluate(() => {
      const merged = mergeAngularDetections([
        {
          heading: 45,
          pitch: -2.1,
          angularWidth: 0.55,
          angularHeight: 1.05,
          confidence: 0.91,
          class_name: "parking_sign",
        },
        {
          heading: 45.08,
          pitch: -3.95,
          angularWidth: 0.6,
          angularHeight: 1.0,
          confidence: 0.84,
          class_name: "parking_sign",
        },
      ]);

      return {
        sourceDetections: merged.sourceDetections,
        mergedHeight: merged.angularHeight,
        distanceHeight: resolveDetectionDistanceAngularHeight(merged),
        naiveDistance: estimateDistanceFromAngularSize(merged.angularHeight),
        adjustedDistance: estimateDistanceFromAngularSize(
          resolveDetectionDistanceAngularHeight(merged),
        ),
        mergeStackFactor: merged.mergeStackFactor,
      };
    });

    expect(metrics.sourceDetections).toBe(2);
    expect(metrics.distanceHeight).toBeLessThan(metrics.mergedHeight);
    expect(metrics.adjustedDistance).toBeGreaterThan(metrics.naiveDistance);
    expect(metrics.mergeStackFactor).toBeGreaterThan(0.35);
  });

  test("snaps direct sign projections to a consistent fixed offset from the road polyline", async ({
    page,
  }) => {
    await mockExternalDependencies(page);
    await page.goto("/?api_key=test-key");

    const wayGeometry = [
      { lat: 42.3610, lon: -71.0926 },
      { lat: 42.3614, lon: -71.0922 },
      { lat: 42.3618, lon: -71.0918 },
      { lat: 42.3622, lon: -71.0914 },
    ];
    const options = {
      streetBearing: 45,
      side: "left",
      oneway: null,
      wayGeometry,
      segmentIndex: 1,
      segmentStart: { lat: 42.3614, lon: -71.0922 },
      segmentEnd: { lat: 42.3618, lon: -71.0918 },
    };

    const projected = await page.evaluate(({ wayGeometry, options }) => {
      return {
        first: projectSignToCurbLine(42.3615, -71.0921, 24, 47, {
          ...options,
          wayGeometry,
        }),
        second: projectSignToCurbLine(42.3615, -71.0921, 40, 58, {
          ...options,
          wayGeometry,
        }),
      };
    }, { wayGeometry, options });

    const firstDistance = distanceToPolylineMeters(projected.first, wayGeometry);
    const secondDistance = distanceToPolylineMeters(projected.second, wayGeometry);
    expect(Math.abs(firstDistance - secondDistance)).toBeLessThan(0.8);
    expect(firstDistance).toBeGreaterThan(2.6);
    expect(firstDistance).toBeLessThan(3.7);
    expect(projected.first.curbOffsetMeters).toBeCloseTo(3.1, 5);
    expect(projected.second.curbOffsetMeters).toBeCloseTo(3.1, 5);
  });

  test("builds preview crops with 25% extra vertical margin above and below the sign", async ({
    page,
  }) => {
    await mockExternalDependencies(page);
    await page.goto("/?api_key=test-key");

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

  test("keeps the first popup preview stable across reopen after refinement completes", async ({
    page,
  }) => {
    await mockExternalDependencies(page);
    await page.goto("/?api_key=test-key");

    const primaryPreviewSrc = "data:image/jpeg;base64,PRIMARY_PREVIEW";
    const refinedPreviewSrc = "data:image/jpeg;base64,REFINED_PREVIEW";

    const previewState = await page.evaluate(
      async ({ primaryPreviewSrc, refinedPreviewSrc }) => {
        let previewCalls = 0;
        fetchDetectionCropPreview = async () => {
          previewCalls += 1;
          return {
            src: previewCalls === 1 ? primaryPreviewSrc : refinedPreviewSrc,
          };
        };
        refinePreviewViewWithPanoramaDetection = async (sign, previewView) => {
          sign.previewRefineAttempted = true;
          sign.previewRefined = true;
          return {
            panoId: previewView.panoId,
            detection: previewView.detection,
          };
        };

        const sign = {
          previewContainerId: "preview-fixture",
          panoId: "mock-pano",
          heading: 45,
          pitch: -2,
          angularWidth: 0.5,
          angularHeight: 1,
          confidence: 0.91,
          class_name: "parking_sign",
        };

        const firstHost = document.createElement("div");
        firstHost.innerHTML =
          '<div class="sign-preview-popup" id="preview-fixture"></div>';
        await loadSignPreview(sign, {
          getElement() {
            return firstHost;
          },
        });

        const secondHost = document.createElement("div");
        secondHost.innerHTML =
          '<div class="sign-preview-popup" id="preview-fixture"></div>';
        await loadSignPreview(sign, {
          getElement() {
            return secondHost;
          },
        });

        return {
          previewCalls,
          previewSrc: sign.previewSrc,
          refinedPreviewSrc: sign.previewRefinedSrc || null,
          firstImageSrc:
            firstHost.querySelector("img")?.getAttribute("src") || null,
          secondImageSrc:
            secondHost.querySelector("img")?.getAttribute("src") || null,
        };
      },
      { primaryPreviewSrc, refinedPreviewSrc },
    );

    expect(previewState.previewCalls).toBe(2);
    expect(previewState.previewSrc).toBe(primaryPreviewSrc);
    expect(previewState.refinedPreviewSrc).toBe(refinedPreviewSrc);
    expect(previewState.firstImageSrc).toBe(primaryPreviewSrc);
    expect(previewState.secondImageSrc).toBe(primaryPreviewSrc);
  });

  test("falls back to single-view detection when panorama detection is unavailable", async ({
    page,
  }) => {
    await mockExternalDependencies(page);

    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3615, lng: -71.0921 };
    });

    await page.goto("/?api_key=test-key");
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

    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")),
    );
    expect(stored).not.toBeNull();
    expect(stored.detections).toHaveLength(1);
  });

  test("renders a short dashed road marker at each saved panorama point on the 2D map", async ({
    page,
  }) => {
    await mockExternalDependencies(page);

    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3615, lng: -71.0921 };
    });

    await page.goto("/?api_key=test-key");
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

    const roadMarkers = await page.evaluate(() =>
      signMarkersLayer._layers
        .filter((layer) => layer.options?.dashArray === "10 8")
        .map((layer) => ({
          color: layer.options.color,
          latlngs: layer._latlngs,
        })),
    );

    expect(roadMarkers).toHaveLength(1);
    expect(roadMarkers[0].color).toBe("#f59e0b");
    expect(roadMarkers[0].latlngs).toHaveLength(2);
    expect(roadMarkers[0].latlngs[0]).not.toEqual(roadMarkers[0].latlngs[1]);
  });

  test("resolves road geometry for the default panorama before drawing the 2D road marker", async ({
    page,
  }) => {
    await mockExternalDependencies(page);

    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3615, lng: -71.0921 };
    });

    await page.goto("/?api_key=test-key");
    await expect(page.locator("#detectionStatus")).toContainText('Click "Detect"');

    await page.evaluate(() => {
      fetchNearestStreetContext = async () => ({
        bearing: 56.25,
        oneway: null,
        highway: "secondary",
        lanes: null,
        streetName: "Vassar Street",
        segmentStart: { lat: 42.361486, lon: -71.092159 },
        segmentEnd: { lat: 42.361545, lon: -71.092039 },
        wayGeometry: [
          { lat: 42.36128, lon: -71.092562 },
          { lat: 42.361486, lon: -71.092159 },
          { lat: 42.361545, lon: -71.092039 },
          { lat: 42.361586, lon: -71.09195 },
          { lat: 42.361809, lon: -71.091504 },
        ],
        segmentIndex: 1,
      });
    });

    await page.locator("#redetectBtn").click();
    await expect(page.locator("#detectionStatus")).toContainText("Found 2 parking signs");

    const roadMarkers = await page.evaluate(() =>
      signMarkersLayer._layers
        .filter((layer) => layer.options?.dashArray === "10 8")
        .map((layer) => layer._latlngs),
    );

    expect(roadMarkers).toHaveLength(1);
    expect(roadMarkers[0].length).toBeGreaterThan(2);

    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("parksight_latest_sign_map_data")),
    );
    expect(stored?.detections?.[0]?.streetName).toBe("Vassar Street");
    expect(stored?.detections?.[0]?.wayGeometry?.length).toBeGreaterThan(2);
  });

  test("renders a road-centerline guide on the panorama and reprojects it with POV changes", async ({
    page,
  }) => {
    await mockExternalDependencies(page);

    await page.addInitScript(() => {
      window.__TEST_PANORAMA_POSITION = { lat: 42.3615, lng: -71.0921 };
    });

    await page.goto("/?api_key=test-key");
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
      detectionPanorama.setPov({ heading: 36.5, pitch: -6, zoom: 1.5 });
      updateDetectionOverlay();
      updateDetectionInfoText();
    });

    const roadGuide = page.locator("#detectionOverlay .road-guide-path");
    await expect(roadGuide).toHaveCount(1);
    const initialGuide = await getSvgPathMetrics(roadGuide);
    expect(initialGuide.d).toBeTruthy();
    expect(initialGuide.pointCount).toBeGreaterThan(10);
    expect(initialGuide.xSpan).toBeGreaterThan(120);
    expect(initialGuide.ySpan).toBeGreaterThan(initialGuide.xSpan * 1.2);
    await expect(page.locator("#detectionInfo")).toContainText("Road: 37°");
    await expect(page.locator("#detectionInfo")).toContainText("View: 37°");

    await page.evaluate(() => {
      detectionPanorama.setPov({ heading: 56.5, pitch: -6, zoom: 1.5 });
      updateDetectionOverlay();
      updateDetectionInfoText();
    });

    const updatedGuide = await getSvgPathMetrics(roadGuide);
    expect(updatedGuide.d).toBeTruthy();
    expect(updatedGuide.d).not.toEqual(initialGuide.d);
    expect(updatedGuide.xSpan).toBeGreaterThan(100);
    expect(updatedGuide.ySpan).toBeGreaterThan(updatedGuide.xSpan * 1.15);
    await expect(page.locator("#detectionInfo")).toContainText("View: 57°");
  });

  test("projects signs at a fixed offset from the matched OSM road polyline", async ({
    page,
  }) => {
    await mockExternalDependencies(page, {
      detectPanoramaResponse: {
        status: 200,
        body: JSON.stringify({
          detections: [
            {
              heading: 47,
              pitch: -4.2,
              angular_width: 0.8,
              angular_height: 4.0,
              confidence: 0.87,
              class_name: "parking_sign",
            },
            {
              heading: 61,
              pitch: -3.1,
              angular_width: 0.7,
              angular_height: 3.0,
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

    await page.goto("/?api_key=test-key");
    await expect(page.locator("#detectionStatus")).toContainText("Click \"Detect\"");

    await page.evaluate(async () => {
      const wayGeometry = [
        { lat: 42.3610, lon: -71.0926 },
        { lat: 42.36134, lon: -71.09228 },
        { lat: 42.36162, lon: -71.0920 },
        { lat: 42.36193, lon: -71.0916 },
        { lat: 42.3622, lon: -71.09118 },
      ];
      currentPoints = [
        {
          lat: 42.3615,
          lon: -71.0921,
          bearing: 43,
          oneway: null,
          streetName: "Test Street",
          segmentStart: { lat: 42.36134, lon: -71.09228 },
          segmentEnd: { lat: 42.36162, lon: -71.0920 },
          wayGeometry,
          segmentIndex: 1,
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

    const wayGeometry = projection.detections[0].wayGeometry;
    expect(Array.isArray(wayGeometry)).toBe(true);
    expect(wayGeometry.length).toBeGreaterThan(2);
    expect(signs[0].curbOffsetMeters).toBeCloseTo(3.1, 5);
    expect(signs[1].curbOffsetMeters).toBeCloseTo(3.1, 5);
    expect(signs.every((sign) => Number.isFinite(sign.alongStreetDistance))).toBe(true);
    expect(signs.every((sign) => sign.side === "left" || sign.side === "right")).toBe(
      true,
    );
  });
});
