# ParkSight

AI-powered street-level parking detection system that combines Street View imagery with ML to map city parking zones and estimate capacity.

![ParkSight Demo](https://maas-log-prod.cn-wlcb.ufileos.com/anthropic/0b5f67b4-c22e-453a-b122-3adf9f9cc3ec/Screenshot%20from%202026-03-01%2008-59-46.png?UCloudPublicKey=TOKEN_e15ba47a-d098-4fbd-9afc-a0dcf0e4e621&Expires=1772383307&Signature=KM63klZftk1M/KL7C4xHtS6xB5Y=)

## What It Does

- **Area Selection**: Draw a rectangle on the map to select any city area
- **Street Sampling**: Automatically fetches streets within your selection using OpenStreetMap
- **Street View Coverage**: Checks which locations have Google Street View panoramas
- **Sign Detection**: Uses YOLO11 ML model to detect parking signs in 360° panoramas
- **Capacity Estimation**: Shows how many cars fit in each parking zone

## Tech Stack

**Frontend**
- Leaflet (map rendering)
- Turf.js (geospatial calculations)
- Google Maps Street View API

**Backend**
- FastAPI (detection service)
- YOLO11n (parking sign detection)

## Quick Start

### Run the App

```bash
# Serve on http://localhost:8080
bun run serve
```

### Run the Detection Backend

```bash
# Install dependencies
uv venv
uv pip install -r backend/requirements.txt

# Start on http://localhost:8000
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

## How to Use

1. Open http://localhost:8080
2. Click "Map & Street View Detection"
3. Draw a rectangle on the map (or use Ctrl+drag)
4. The app will:
   - Fetch streets in the area
   - Check Street View coverage
   - Show purple dots for available panoramas
5. Click any dot to view Street View and detect parking signs

## Project Status

- ✅ Map-based area selection
- ✅ Street View integration
- ✅ YOLO11 parking sign detection
- ✅ Bounding box visualization
- ⏳ Capacity calculation (in progress)

## License

MIT
