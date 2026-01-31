# AGENTS.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Repo at a glance
This repo mixes two related pieces:
- **Map + street imagery viewer (static web app):** `index.html` (Leaflet + Turf + Google Maps JS API) with modular JS in `js/` and config in `config.js`.
- **Parking-sign ML training artifacts:** dataset build script (`datasets/build_unified_dataset.py`), augmentation config (`configs/augmentation.yaml`), and a Kaggle-style training notebook setup under `notebooks/`.

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

### Run the training notebook headlessly (Docker)
`notebooks/` is set up to mimic Kaggle paths (`/kaggle/input`, `/kaggle/working`) using the Ultralytics CPU image.

- From repo root, run the quick “does training boot?” check:
  ```bash
  docker compose -f notebooks/docker-compose.yml run --rm test
  ```

- Execute the full training notebook via `nbconvert`:
  ```bash
  docker compose -f notebooks/docker-compose.yml run --rm train
  ```

## Architecture (big picture)
### 1) Web app (`index.html` + `js/`)
Single-page app using modular JavaScript.

**File structure:**
```
index.html          # UI shell, map init, orchestration
config.js           # Google API key (window.GOOGLE_CONFIG)
js/
├── utils.js        # Progress bar, error display
├── streets.js      # Overpass API, street sampling with turf.bearing()
└── streetview.js   # Session tokens, panoIds bulk fetch, panorama display
```

**Key pieces:**
- **Map rendering:** Leaflet map + OpenStreetMap tiles.
- **Selection workflow:** user draws a rectangle (button or Ctrl/⌘ drag) → bounds trigger street fetch + Street View coverage check.
- **External APIs:**
  - **Overpass API** (`https://overpass-api.de/api/interpreter`) fetches OSM streets in bbox.
  - **Google Map Tiles API** (`https://tile.googleapis.com/v1/streetview/panoIds`) bulk-fetches panorama IDs (up to 100 per request).
  - **Google Maps JS API** (`StreetViewPanorama`) displays panoramas.
- **Layers:** `streetsLayer`, `streetViewDotsLayer`, `selectionLayer` are Leaflet `LayerGroup`s; dots open a Street View panorama modal.
- **Driver perspective:** Heading = street bearing ± 45° (right/left toggle), handles one-way streets via OSM `oneway` tag.

**Config coupling:**
- `config.js` exports `window.GOOGLE_CONFIG.API_KEY`.
- Session tokens cached in `localStorage` (~13 days).

### 2) ML / training workflow (`datasets/`, `configs/`, `notebooks/`)
Data flow:
- Raw datasets under `datasets/` → `datasets/build_unified_dataset.py` converts/resizes into a **single-class** YOLO dataset (512x512) and writes `data.yaml`.
- Training is documented in `notebooks/README.md` and implemented in `notebooks/parking_sign_training.ipynb`.
- `configs/augmentation.yaml` records the augmentation “experiments” (Ultralytics runtime augmentation params + notes about pre-applied Roboflow aug).

Docker flow:
- `notebooks/Dockerfile` uses `ultralytics/ultralytics:latest-cpu` + installs Jupyter tooling.
- `notebooks/docker-compose.yml` mounts:
  - `datasets/parking-sign-detection-coco-dataset` → `/kaggle/input/parking-sign-detection-coco-dataset` (read-only)
  - `notebooks/output` → `/kaggle/working/output`

## Sharp edges / mismatches to be aware of
- `package.json` references `src/index.html`, but this repo’s source HTML is currently `index.html` at the repo root (no `src/` directory). The `npm run build` script may need updating.
- `run-sign-detector.sh` / `start-sign-detector.sh` expect a `sign-detector/` directory with `backend/` + `frontend/` (FastAPI + bun/npm). That directory is not part of the tracked files in this repo.
- The docs in `README.md` / `docs/api-reference.md` describe a broader “overlay app” UI than what’s currently present in `index.html` (use `index.html` as the source of truth).