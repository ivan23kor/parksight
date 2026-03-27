---
description: Parksight project guidance for AI agents
alwaysApply: true
---

# PARKSIGHT AGENT GUIDE

## Repo Structure
1. **Static app** (`index.html`) — Leaflet + Turf + Google Maps JS API
2. **Upload UI** (`ui-upload/`) — shadcn/ui component library
3. **Backend** (`backend/`) — FastAPI YOLO11 detection service

## Commands

### Run Stack
```bash
GOOGLE_MAPS_API_KEY=... bun run start    # Backend + web server
GOOGLE_MAPS_API_KEY=... bun run start:web # Full stack, detection works
GOOGLE_MAPS_API_KEY=... bun run serve:static # Backend-free mode
GOOGLE_MAPS_API_KEY=... bun run start:backend # Backend only
python3 serve.py  # Python-based static serve
```

### Build UI
```bash
cd ui-upload && bun install && bun run build
```

### Tests
```bash
bun install && bunx playwright install chromium && bun run test:e2e
```
**Debug:** `npx playwright test --debug` | `PWDEBUG=1 npx playwright test` | `HEADLESS=false npx playwright test`

### ML Training
```bash
python3 datasets/build_unified_dataset.py  # Build dataset
# Upload datasets/parking-sign-detection-coco-dataset/ to Kaggle
# Import notebook from notebooks/
```

## Test Rules
- Always run tests: `bun run test:e2e`
- **Mandatory analysis after each run:**
  - Locate `test-results/<test>/trace.zip`
  - Check console logs for errors, warnings, failed requests
  - Check screenshots/videos if present
  - Report: confirmed issues, warnings, performance insights, hypotheses, recommendations

## Eval Rules
- Evals simulate real user behavior. No stubs, no mocks, no synthetic data injection.
- `page.evaluate()` for reading state only — never for injecting data or bypassing UI flow.
- Real API keys from env. Real backend. Real external APIs. Fail fast if missing.
- Black/empty panels where real content should appear = eval is broken.
- See `.claude/skills/write-eval-spec.md` for full eval philosophy.

## Architecture

### Static App (`index.html`)
```
config.js           # Google API key + detection config
js/
├── utils.js        # Progress bar, error display
├── streets.js      # Overpass API, street sampling, intersection detection
├── panorama.js     # Shared panorama config (pitch, zoom, heading)
├── streetview.js   # Session tokens, panoIds bulk fetch
└── detection.js    # YOLO detection API calls
index.html          # Split panorama/2D map view
```

**Key pieces:**
- Map rendering: Leaflet + OSM tiles
- Selection workflow: draw rectangle → fetch streets → check Street View
- External APIs: Overpass API, Google Map Tiles API, Google Maps JS API
- Layers: `streetsLayer`, `streetViewDotsLayer`, `selectionLayer`
- Driver perspective: Heading ± 45°, handles OSM `oneway` tag

**Config coupling:** `config.js` exports `GOOGLE_CONFIG.API_KEY` + `DETECTION_CONFIG`. Session tokens cached in `localStorage` (~13 days)

### Upload UI (`ui-upload/`)
shadcn/ui component library. Build: `bun install && bun run build`

### Backend (`backend/`)
FastAPI YOLO11 inference service.

**Endpoints:**
- `GET /health` — Health check
- `POST /detect` — Single image detection
- `POST /detect-panorama` — Multi-slice panorama detection
- `POST /crop-sign-tiles` — Fetch/stitch/crop Street View tiles
- `POST /preview-sign` — Sign-centered Street View
- `GET /detect-debug` — Image with bounding boxes

**Model:** YOLO11m, 1 class (`parking_sign`). Download from Kaggle → `backend/models/best.pt`

**Detected signs:** Saved to `detected_signs/`, served at `/detected-signs/`

### ML Training (`datasets/`, `notebooks/`)
Raw datasets → `build_unified_dataset.py` → single-class YOLO dataset (512x512). Training notebooks in `notebooks/` (numbered). See `notebooks/EXPERIMENT_7_README.md`

## Sharp Edges
- `package.json` references `src/index.html` but actual source is `index.html` (no `src/`)
- `run-sign-detector.sh` + `start-sign-detector.sh` → `scripts/start-stack.sh`
- Detection requires backend on `http://127.0.0.1:8000` — `bun run start` + `bun run start:web` start full stack; `serve:static` backend-free on purpose
- Training on Kaggle, not locally — no Docker setup
