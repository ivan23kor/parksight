# Frontend Agent Guide

## Purpose

`js/` supports the static map app in `index.html`. It handles streets, Street View lookup, area scans, detection rendering, sign merging, crop planning, logging, and sign registry behavior.

## Key Files

- `streets.js` - street fetching, street sampling, OSM way handling, and intersection detection.
- `streetview.js` - Google Map Tiles session tokens, pano ID lookup, and metadata calls.
- `panorama.js` - shared panorama defaults.
- `detection.js` - detection requests, angular merge logic, crop planning, OCR orchestration, depth/location estimates, and debug overlays.
- `area-scan.js` - rectangle scan workflow across streets and panoramas.
- `signRegistry.js` - sign identity/merge behavior.
- `logger.js` - browser log capture and relay to `serve.js`.
- `tile-viewer.js` - tile/debug viewing helpers.

## Runtime Flow

The primary workflow is:

1. User selects or scans an area on the Leaflet map.
2. Streets are fetched and sampled.
3. Street View pano IDs/metadata are resolved through Google APIs.
4. Images are sent to backend detection endpoints through `/api`.
5. Detections are merged, depth/location is estimated, crops are generated, OCR is run, and signs are rendered on the map.

Session tokens for Google Map Tiles are cached in `localStorage`.

## Detection Details

- Driver-perspective scans use heading offsets around the roadway direction and account for OSM `oneway` tags.
- `mergeAngularDetections()` clusters detections and uses median depth across valid cluster members for multi-panel signs.
- Debug overlays are toggled with `Shift+D` where wired.

Issue #3 tracks the remaining major frontend/backend geometry risk: converting angular detections into Google Street View tile pixels for consistently centered crops, especially on tilted panoramas.

## Pano Network Discovery

`index.html` includes pano network discovery for nearby Street View capture points. It uses linked pano metadata rather than requiring every pano to be rendered. Keep BFS depth/concurrency conservative because these calls hit Google Street View services.

## Error Handling

Area scan should surface backend/street-data failures rather than silently continuing. Historical `/streets` failures were tied to backend availability or missing streets data; issue #1 tracks making readiness clearer.
