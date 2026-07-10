---
description: Parksight project guidance for AI agents
alwaysApply: true
---

# PARKSIGHT AGENT GUIDE

## Repo Structure

1. **Static app** (`index.html`, `js/`) - Leaflet, Turf, Google Maps JS API, Google Street View, and area scanning.
2. **Backend** (`backend/`) - FastAPI service for streets, YOLO11 detection, Street View tile crops, preview images, and OCR parsing.
3. **Upload UI** (`ui-upload/`) - shadcn/ui image upload workflow.
4. **Training** (`datasets/`, `notebooks/`) - dataset build scripts and Kaggle notebooks.

Read the nearest module `CLAUDE.md` before changing code in that area:

- `backend/CLAUDE.md`
- `js/CLAUDE.md`
- `notebooks/CLAUDE.md`
- `tests/CLAUDE.md`
- `ui-upload/CLAUDE.md`

## Tracking

Major unfinished work is tracked in GitHub issues, not local TODO docs.

- #1 - Make startup fail clearly when required runtime assets are missing
- #2 - Validate production YOLO/OCR quality with real Street View failure cases
- #3 - Fix Street View tile crop alignment and tilt calibration

Do not recreate historical experiment reports, completed implementation plans, or minor TODO lists as repo docs. Add durable architecture and operating guidance to the closest `CLAUDE.md`; put actionable project work in GitHub issues.

## Commands

### Run Stack

```bash
GOOGLE_MAPS_API_KEY=... bun run start
GOOGLE_MAPS_API_KEY=... bun run serve:static
GOOGLE_MAPS_API_KEY=... bun run start:backend
python3 serve.py
```

### Build UI

```bash
cd ui-upload && bun install && bun run build
```

### Tests

```bash
bun install && bunx playwright install chromium && bun run test:e2e
```

Debug:

```bash
npx playwright test --debug
PWDEBUG=1 npx playwright test
HEADLESS=false npx playwright test
```

### ML Training

```bash
python3 datasets/build_unified_dataset.py
# Upload datasets/parking-sign-detection-coco-dataset/ to Kaggle.
# Import notebooks from notebooks/.
```

## Test Rules

- Always run tests: `bun run test:e2e`
- After each run, inspect `test-results/<test>/trace.zip` when present.
- Check console logs, failed requests, screenshots, and videos before reporting results.
- Report confirmed issues, warnings, performance observations, hypotheses, and recommendations separately.

## Eval Rules

- Evals simulate real user behavior. No stubs, mocks, or synthetic data injection.
- `page.evaluate()` may read state only; do not use it to inject data or bypass UI flow.
- Use real API keys from env, the real backend, and real external APIs.
- Fail fast if required env or backend state is missing.
- Black/empty panels where map or panorama content should appear mean the eval is broken.
- See `.claude/skills/write-eval-spec.md` for full eval philosophy.

## Architecture

The static app is rooted at `index.html` with supporting modules in `js/`.

```text
config.js           # Google API key + detection config
js/
├── utils.js        # Progress bar, error display
├── streets.js      # Street fetching, sampling, intersections
├── panorama.js     # Shared panorama config
├── streetview.js   # Session tokens, pano IDs, metadata
└── detection.js    # Detection, crops, OCR, sign location
index.html          # Split panorama/2D map view
```

Detection calls go through `/api` in the web app and are proxied to the backend by `serve.js`.

## Sharp Edges

- `package.json` references `src/index.html` in some historical context, but the actual source is `index.html`.
- Detection requires the backend; `serve:static` is backend-free on purpose.
- Large runtime assets are not all committed. See `backend/CLAUDE.md`.
- Training is designed for Kaggle, not local long-running GPU training. There is no Docker setup.
