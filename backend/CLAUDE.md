# Backend Agent Guide

## Purpose

`backend/` is the FastAPI service for streets, YOLO11 detection, Google Street View tile crops, preview images, depth handling, and OCR parsing.

## Runtime Assets

- `backend/models/best.pt` is the YOLO11m parking sign detector, single class: `parking_sign`.
- `backend/data/streets.db` is the local OSM streets SQLite database. It is large and not committed. Rebuild it with:

```bash
python3 backend/ingest_osm.py path/to/region-latest.osm.pbf
```

Issue #1 tracks making startup/readiness fail clearly when required runtime assets are missing.

## Main Endpoints

- `GET /health` - process health.
- `GET /streets` - streets in a bounding box, backed by `backend/data/streets.db` when available.
- `POST /detect` - single image detection.
- `POST /detect-single-pano` - panorama detection.
- `POST /crop-sign-tiles` - fetch, stitch, and crop Street View tiles around a sign.
- `POST /preview-sign` - sign-centered Street View preview.
- `POST /ocr-sign` - parse a cropped sign image using `backend/prompts/parking_sign_parse.txt`.
- `GET /detect-debug` - rendered detections for debugging.

Detected sign images are written under `detected_signs/` and served by the backend.

## Detection And Crop Pipeline

YOLO detections begin in gnomonic image pixels. The backend converts bbox centers/corners into angular coordinates, then the frontend computes Street View tile coordinates and asks the backend to stitch/crop the relevant tiles.

The crop alignment problem is tracked in issue #3. Important paths:

- `backend/main.py` - bbox pixel to heading/pitch conversion and crop endpoints.
- `js/detection.js` - heading/pitch to tile pixels, crop planning, and frontend detection orchestration.
- `scripts/walk-panos.js` - calibration walker.
- `tools/annotate-tilt.html` - manual crop/tilt annotation.

## Performance Notes

Inference should explicitly use the model training resolution where possible. Earlier profiling found that matching YOLO inference size to the trained size reduced CPU inference time materially; batching two panorama slices did not improve CPU throughput because one image already saturated CPU parallelism.

If more CPU acceleration is needed, prefer evaluating OpenVINO export before adding request-level complexity.

## OCR Prompt

The canonical parser prompt is `backend/prompts/parking_sign_parse.txt`. Do not maintain duplicate prompt drafts in top-level Markdown files.
