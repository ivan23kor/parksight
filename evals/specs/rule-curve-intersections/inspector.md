# Inspector: rule-curve-intersections

## Setup

1. Start web server from project root `/home/ivan23kor/Code/parksight`:
   ```bash
   bun run serve
   ```
   Wait for it to be available at `http://127.0.0.1:8080`.

2. Create a Playwright test file at `evals/runs/rule-curve-intersections/inspect.spec.js` with the infrastructure stubs and steps below, then run it:
   ```bash
   HEADLESS=false bunx playwright test evals/runs/rule-curve-intersections/inspect.spec.js
   ```

## Infrastructure Stubs

The test needs Leaflet, Google Maps, and Turf stubs since we test without a Google API key. Copy the stub setup from `tests/detection.e2e.spec.js` — specifically the `LEAFLET_STUB`, `GOOGLE_MAPS_STUB`, `TURF_STUB` constants and the route-mocking logic from `mockInfrastructure()`. Also copy the `forwardBrowserConsole()` function.

Load the fixture file `tests/fixtures/vassar-street-mit-ways.json` for OSM way data.

## Steps

### Step 1: Load page and render sign data on Albany Street

Navigate to `/?api_key=test-key` with stubs active.

Then execute in `page.evaluate()`:
```js
// Albany Street way ID 442971020
const albanyWay = fixtureWays.find(w => w.id === 442971020);
const albanyGeo = albanyWay.geometry;

// Project a sign on Albany Street near segment 8
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

await renderSignMapData({
  savedAt: Date.now(), source: "eval-test", projectionVersion: 6,
  detections: [{
    camera: { lat: 42.3620144, lng: -71.093427 },
    panoId: "eval-pano", streetBearing: 56.09,
    segmentStart: albanyGeo[8], segmentEnd: albanyGeo[9],
    wayGeometry: albanyGeo, segmentIndex: 8,
    signs: [sign],
  }],
}, fixtureWays);
```

Pass `fixtureWays` (the parsed JSON from the fixture file) and `albanyGeo` as parameters to page.evaluate.

Capture: screenshot `01-albany-rule-curves.png` (full page)

### Step 2: Extract intersection data

Execute in `page.evaluate()`:
```js
const albanyWay = fixtureWays.find(w => w.id === 442971020);
const albanyGeo = albanyWay.geometry;
const intersections = findIntersectionNodes(albanyGeo, fixtureWays);
return {
  intersectionCount: intersections.length,
  intersectionNodeIndices: intersections.map(n => n.nodeIndex),
  intersectionCoords: intersections.map(n => ({ lat: n.lat, lng: n.lng })),
  intersectionCrossStreets: intersections.map(n => ({
    nodeIndex: n.nodeIndex,
    crossStreetNames: n.crossStreetTags?.map(t => t.name).filter(Boolean) || [],
    crossStreetHighways: n.crossStreetTags?.map(t => t.highway).filter(Boolean) || [],
  })),
};
```

Store result as `extracted_data.intersections`.

### Step 3: Extract rule curve data

Execute in `page.evaluate()`:
```js
const curves = ruleCurvesLayer._layers.map(l => ({
  color: l.options?.color,
  weight: l.options?.weight,
  opacity: l.options?.opacity,
  dashArray: l.options?.dashArray || null,
  pointCount: l._latlngs?.length || 0,
  latlngs: l._latlngs,
}));

// Calculate curve lengths
for (const curve of curves) {
  let length = 0;
  for (let i = 0; i < curve.latlngs.length - 1; i++) {
    length += haversineDistanceMeters(
      curve.latlngs[i][0], curve.latlngs[i][1],
      curve.latlngs[i + 1][0], curve.latlngs[i + 1][1],
    );
  }
  curve.lengthMeters = length;
}

return curves;
```

Store result as `extracted_data.rule_curves`.

### Step 4: Extract sign marker data

Execute in `page.evaluate()`:
```js
return signMarkersLayer._layers.map(l => ({
  type: l._latlngs ? 'polyline' : 'circle',
  color: l.options?.color,
  fillColor: l.options?.fillColor,
  dashArray: l.options?.dashArray || null,
  latlng: l._latlng,
  latlngs: l._latlngs,
  radius: l.options?.radius,
}));
```

Store result as `extracted_data.sign_markers`.

### Step 5: Extract maxDist calculation result

Execute in `page.evaluate()`:
```js
const albanyWay = fixtureWays.find(w => w.id === 442971020);
const albanyGeo = albanyWay.geometry;

const signBase = projectSignToCurbLine(42.3620144, -71.093427, 6, 56.09, {
  streetBearing: 56.09, side: "right", oneway: null,
  wayGeometry: albanyGeo, segmentIndex: 8,
  segmentStart: albanyGeo[8], segmentEnd: albanyGeo[9],
  cameraHeading: 56.09,
});
const sign = {
  ...signBase, heading: 56.09, pitch: -2, confidence: 0.91,
  class_name: "parking_sign", segmentIndex: 8,
};

const intersections = findIntersectionNodes(albanyGeo, fixtureWays);
const maxDistForward = findDistanceToNextSign(sign, 1, [sign], albanyGeo, intersections);
const maxDistBackward = findDistanceToNextSign(sign, -1, [sign], albanyGeo, intersections);

return { maxDistForward, maxDistBackward };
```

Store result as `extracted_data.max_distances`.

### Step 6: Capture console output

Collect all console logs and errors captured throughout the test. Store as `console_logs` and `console_errors` in report.json.

### Step 7: Write report

Write `evals/runs/rule-curve-intersections/report.json` with all extracted data, screenshot filenames, step completion counts, and any errors encountered.
