/**
 * Shared mock infrastructure for Playwright tests.
 * Extracted from detection.e2e.spec.js for reuse.
 *
 * Stubs external dependencies:
 *  - Leaflet (inspects _layers internals)
 *  - Google Maps JS API (needs API key)
 *  - Google Map Tiles API (session, panoIds, metadata, tiles)
 *  - Turf.js
 *  - Overpass API
 *  - Backend endpoints (/detect-tiles, /detect, /crop-sign-tiles, /ocr-sign)
 */

const PREVIEW_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";

const LEAFLET_STUB = `
(() => {
  class LayerGroup {
    constructor() { this._layers = []; }
    addTo() { return this; }
    clearLayers() { this._layers = []; return this; }
    addLayer(layer) { this._layers.push(layer); return this; }
    eachLayer(fn) { this._layers.forEach(fn); return this; }
  }
  function makeLayer(latlng, options = {}) {
    return {
      _latlng: latlng, options,
      addTo(group) { if (group && typeof group.addLayer === "function") group.addLayer(this); return this; },
      bindPopup() { return this; }, bindTooltip() { return this; }, on() { return this; }, openPopup() { return this; }, getPopup() { return null; },
      setLatLng(next) { this._latlng = next; return this; },
      setBounds(bounds) { this._bounds = bounds; return this; },
    };
  }
  const mapHandlers = {};
  const map = {
    _zoom: 16, _center: { lat: 42.3615, lng: -71.0921 },
    setView(center, zoom) { this._center = { lat: center[0], lng: center[1] }; this._zoom = zoom; return this; },
    getBounds() {
      const n = this._center.lat + 0.01, s = this._center.lat - 0.01;
      const e = this._center.lng + 0.01, w = this._center.lng - 0.01;
      return {
        getNorth: () => n, getSouth: () => s,
        getEast: () => e, getWest: () => w,
        contains(latlng) {
          const lat = Array.isArray(latlng) ? latlng[0] : latlng.lat;
          const lng = Array.isArray(latlng) ? latlng[1] : latlng.lng;
          return lat >= s && lat <= n && lng >= w && lng <= e;
        },
      };
    },
    getZoom() { return this._zoom; }, getCenter() { return this._center; },
    invalidateSize() {}, fitBounds(b) { this._fitBounds = b; },
    on(event, handler) { mapHandlers[event] = handler; return this; },
    getContainer() { return document.getElementById("map"); },
    closePopup() { return this; },
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
  const pos = window.__TEST_PANORAMA_POSITION || { lat: 42.3615, lng: -71.0921 };
  class StreetViewService {
    async getPanorama(request) {
      return {
        data: {
          location: {
            pano: request?.pano || "mock-pano",
            latLng: { lat: () => pos.lat, lng: () => pos.lng },
            description: "Mock panorama",
          },
          links: [
            { pano: "linked-pano", heading: 90, description: "Linked panorama" },
          ],
        },
      };
    }
  }
  window.google = {
    maps: {
      StreetViewService,
      StreetViewPreference: { NEAREST: "NEAREST" },
      StreetViewSource: { OUTDOOR: "OUTDOOR" },
    },
  };
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
    const dy = (end.coords[1] - end.coords[1]) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
  },
  lineString(coordinates) { return { geometry: { type: "LineString", coordinates } }; },
  bboxClip(line) { return line; },
  lineIntersect(line1, line2) {
    const coords1 = line1.geometry.coordinates;
    const coords2 = line2.geometry.coordinates;
    const features = [];
    for (let i = 0; i < coords1.length - 1; i++) {
      for (let j = 0; j < coords2.length - 1; j++) {
        const [px, py] = coords1[i], [qx, qy] = coords1[i + 1];
        const [rx, ry] = coords2[j], [sx, sy] = coords2[j + 1];
        const dx1 = qx - px, dy1 = qy - py;
        const dx2 = sx - rx, dy2 = sy - ry;
        const denom = dx1 * dy2 - dy1 * dx2;
        if (Math.abs(denom) < 1e-12) continue;
        const t = ((rx - px) * dy2 - (ry - py) * dx2) / denom;
        const u = ((rx - px) * dy1 - (ry - py) * dx1) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          features.push({ type: "Feature", geometry: { type: "Point", coordinates: [px + t * dx1, py + t * dy1] } });
        }
      }
    }
    return { type: "FeatureCollection", features };
  },
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

/**
 * Set up all route mocks for external dependencies.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {object} [options.detectTilesResponse] - Response for POST /detect-tiles (angular detections)
 * @param {object|Function} [options.detectPanoramaResponse] - Response for POST /detect-tiles (legacy, kept for compat)
 * @param {object|Function} [options.detectResponse] - Response for POST /detect
 * @param {object} [options.ocrResponse] - Response for POST /ocr-sign
 * @param {object} [options.cropResponse] - Response for POST /crop-sign-tiles
 * @param {Array} [options.fixtureWays] - OSM way data for Overpass stub
 */
async function mockInfrastructure(page, options = {}) {
  forwardBrowserConsole(page);
  const fixtureWays = options.fixtureWays ?? [];

  // Backend response overrides
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
  const ocrResponse = options.ocrResponse ?? {
    is_parking_sign: true, confidence_readable: "high",
    rules: [{ category: "no_parking", arrow_direction: "left", days: ["mon","tue","wed","thu","fri"], time_start: "08:00", time_end: "18:00" }],
    tow_zones: [], raw_text: "NO PARKING 8AM-6PM MON-FRI",
  };
  const cropResponse = options.cropResponse ?? { width: 200, height: 300, image_base64: PREVIEW_IMAGE_BASE64 };
  const detectTilesResponse = options.detectTilesResponse ?? null;

  // CDN stubs
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: LEAFLET_STUB }));
  await page.route("https://unpkg.com/@turf/turf@6.5.0/turf.min.js", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: TURF_STUB }));
  await page.route("https://maps.googleapis.com/maps/api/js?**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: GOOGLE_MAPS_STUB }));

  // Google Map Tiles API stubs
  await page.route("https://tile.googleapis.com/v1/createSession?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ session: "mock-session" }) }));
  await page.route("https://tile.googleapis.com/v1/streetview/panoIds?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ panoIds: ["mock-pano"] }) }));
  await page.route("https://tile.googleapis.com/v1/streetview/metadata?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ heading: 45, tilt: 90, roll: 0, imageWidth: 16384, imageHeight: 8192 }) }));
  await page.route("https://tile.googleapis.com/v1/streetview/tiles/5/**", async (r) => {
    await r.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(PREVIEW_IMAGE_BASE64, "base64"),
    });
  });

  // Overpass API stub (uses fixture data or empty)
  await page.route("https://overpass-api.de/api/interpreter", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ elements: fixtureWays }) }));
  // Also stub the local backend /streets endpoint
  await page.route("http://127.0.0.1:8000/streets?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixtureWays) }));

  // Backend detection endpoints
  await page.route("http://127.0.0.1:8000/detect-tiles", async (r) => {
    if (detectTilesResponse) {
      const resp = typeof detectTilesResponse === "function" ? detectTilesResponse(r.request()) : detectTilesResponse;
      await r.fulfill({ status: resp.status ?? 200, contentType: "application/json", body: resp.body ?? JSON.stringify(resp) });
      return;
    }
    const resp = typeof detectPanoramaResponse === "function" ? detectPanoramaResponse(r.request()) : detectPanoramaResponse;
    await r.fulfill({ status: resp.status, contentType: resp.contentType || "application/json", body: resp.body });
  });
  await page.route("http://127.0.0.1:8000/detect", async (r) => {
    const resp = typeof detectResponse === "function" ? detectResponse(r.request()) : detectResponse;
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resp) });
  });
  await page.route("http://127.0.0.1:8000/crop-sign-tiles", async (r) => {
    const resp = typeof cropResponse === "function" ? cropResponse(r.request()) : cropResponse;
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resp) });
  });
  await page.route("http://127.0.0.1:8000/ocr-sign", async (r) => {
    const resp = typeof ocrResponse === "function" ? ocrResponse(r.request()) : ocrResponse;
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(resp) });
  });

  // Backend health
  await page.route("http://127.0.0.1:8000/health", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) }));
}

module.exports = {
  PREVIEW_IMAGE_BASE64,
  LEAFLET_STUB,
  GOOGLE_MAPS_STUB,
  TURF_STUB,
  forwardBrowserConsole,
  mockInfrastructure,
};
