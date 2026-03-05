# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Repo at a glance
This repo mixes two related pieces:
- **Map + street imagery viewer (static web app):** `index.html` (Leaflet + Turf + Google Maps JS API) with modular JS in `js/` and config in `config.js`.
- **Parking-sign ML training:** dataset build script (`datasets/build_unified_dataset.py`), and Kaggle training notebooks under `notebooks/`.

## Common commands
### Run the map app locally
The app is just static files; `npm` is only used as a command wrapper.

- Serve the repo root on `http://localhost:8080`:
  ```bash
  npm run serve
  ```

- (Equivalent) Serve without npm:
  ```bash
  python3 -m http.server 8080
  ```

### Build / serve the `dist/` folder
- Build (currently copies HTML into `dist/`):
  ```bash
  npm run build
  ```

- Serve `dist/` on `http://localhost:8081`:
  ```bash
  npm run serve:dist
  ```

Note: `dist/` is gitignored (see `.gitignore`).

### Build the unified training dataset (YOLO format)
- Build the combined dataset (writes into `datasets/parking-sign-detection-coco-dataset/`):
  ```bash
  python3 datasets/build_unified_dataset.py
  ```

This script expects the source datasets to exist under `datasets/` (which is gitignored and typically local-only).

### Train on Kaggle
1. Upload dataset to kaggle.com/datasets
2. Import notebook from `notebooks/`
3. Enable GPU, run

See `notebooks/KAGGLE_RUN_CHECKLIST.md` for details.

## Architecture (big picture)
### 1) Web app (`index.html` + `js/`)
Single-page app using modular JavaScript.

**File structure:**
```
config.js           # Google API key + detection API config
js/
├── utils.js        # Progress bar, error display
├── streets.js      # Overpass API, street sampling with turf.bearing()
├── panorama.js     # Shared panorama config (pitch, zoom, heading offset)
├── streetview.js   # Session tokens, panoIds bulk fetch, panorama display
└── detection.js    # YOLO detection API calls, bounding box rendering
ui-map/
└── index.html      # Map-based UI with area selection
ui-panorama/
└── index.html      # Single panorama UI (Calgary Tower demo)
backend/
├── main.py         # FastAPI detection service
└── requirements.txt
```

**Key pieces:**
- **Map rendering:** Leaflet map + OpenStreetMap tiles.
- **Selection workflow:** user draws a rectangle (button or Ctrl/⌘ drag) → bounds trigger street fetch + Street View coverage check.
- **External APIs:**
  - **Overpass API** (`https://overpass-api.de/api/interpreter`) fetches OSM streets in bbox.
  - **Google Map Tiles API** (`https://tile.googleapis.com/v1/streetview/panoIds`) bulk-fetches panorama IDs (up to 100 per request).
  - **Google Maps JS API** (`StreetViewPanorama`) displays panoramas.
- **Layers:** `streetsLayer`, `streetViewDotsLayer`, `selectionLayer` are Leaflet `LayerGroup`s; dots open a Street View panorama modal.
- **Driver perspective:** Both UIs use `panorama.js` for consistent behavior. Heading = base direction ± 45° (right/left toggle via `calculateHeadingWithSide()`), handles one-way streets via OSM `oneway` tag. Default pitch = 0 (horizon).

**Config coupling:**
- `config.js` exports `window.GOOGLE_CONFIG.API_KEY` and `window.DETECTION_CONFIG`.
- Session tokens cached in `localStorage` (~13 days).

### 2) Detection backend (`backend/`)
FastAPI service that runs YOLO11 inference on Street View images.

**Start the detection server:**
```bash
# Install dependencies (first time)
uv venv && uv pip install --python .venv/bin/python -r backend/requirements.txt

# Run server on port 8000
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

**API endpoints:**
- `GET /health` — Health check
- `POST /detect` — Run detection on image URL
  - Request: `{"image_url": "...", "confidence": 0.15}`
  - Response: `{"detections": [{"x1", "y1", "x2", "y2", "confidence", "class_name"}], "inference_time_ms": ...}`

**Model:** Download from Kaggle after training → place in `backend/models/best.pt` (YOLO11m, 1 class: `parking_sign`)

### 3) ML / training workflow (`datasets/`, `notebooks/`)
Data flow:
- Raw datasets under `datasets/` → `datasets/build_unified_dataset.py` converts/resizes into a **single-class** YOLO dataset (512x512) and writes `data.yaml`.
- Training runs on Kaggle using notebooks in `notebooks/`. See `notebooks/EXPERIMENT_STATUS.md` for experiment results.

## Sharp edges / mismatches to be aware of
- `package.json` references `src/index.html`, but this repo's source HTML is currently `index.html` at the repo root (no `src/` directory). The `npm run build` script may need updating.
- The docs in `README.md` / `docs/api-reference.md` describe a broader "overlay app" UI than what's currently present in `index.html` (use `index.html` as the source of truth).
- Detection requires the backend to be running (`http://localhost:8000`). If unavailable, UI gracefully degrades to showing just the 360° panorama.
- Training is done on Kaggle, not locally. There is no local Docker setup.
