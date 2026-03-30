# Inspector: rule-curve-intersections

## Setup

1. Start the full stack from project root:
   ```bash
   GOOGLE_MAPS_API_KEY=<key> bun run start
   ```
   Wait for both web server (`http://127.0.0.1:8080`) and backend (`http://127.0.0.1:8000`).

2. Run the inspector test:
   ```bash
   GOOGLE_MAPS_API_KEY=<key> RECORD_VIDEO=on bunx playwright test --config evals/playwright.config.js rule-curve-intersections/inspect.spec.js
   ```

## Approach

**No stubs.** Everything is real — Google Maps, Leaflet, Turf, Overpass, backend YOLO detection, OCR.

The test simulates actual user workflow:
1. Load page → real Street View renders at default Vassar St location (left panel shows Google imagery, NOT black)
2. Click Detect → real YOLO inference → sign detection → rule curves render
3. OCR auto-runs → curves colored by parking rule

**Do NOT click on a different street. Detection must run at the default panorama location.**

**Prerequisites:**
- `GOOGLE_MAPS_API_KEY` env var
- Backend running at `http://127.0.0.1:8000` with YOLO model loaded
- Web server at `http://127.0.0.1:8080`

## Steps

### Step 1: Load page
Navigate to `/?api_key=<key>`. Wait for `.leaflet-container` and status "Tap to detect".
Screenshot: `00-initial-vassar-pano.png` (left panel should show real Street View imagery)

### Step 2: Click Detect
Click `#detectionStatus` bar → `rerunDetection()` → `runDetectionOnPanorama()` hits real backend.
Wait for status "Found" or "OCR" (timeout 60s — real YOLO inference).
Wait for `.leaflet-overlay-pane svg path`.
Screenshots: `01-detection-*.png` (5 at 200ms intervals)
Screenshot: `02-final-rule-curves.png` (after zoom to fit)

### Step 3: Extract data
Read layer state via Leaflet public API in `page.evaluate()`:
- Intersections from `findIntersectionNodes()`
- Rule curves from `ruleCurvesLayer.getLayers()`
- Sign markers from `signMarkersLayer.getLayers()`
- Max distances computed with turf

### Step 4: Write report.json
Screenshots, extracted_data, console_logs, observations.
