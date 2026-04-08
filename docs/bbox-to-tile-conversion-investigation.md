# BBox-to-Tile Crop Conversion Investigation Report

**Date:** 2026-04-08
**Status:** Unresolved — needs further investigation
**Symptom:** Parking sign crop previews are misaligned vertically — signs appear shifted up or down from crop center. Worse for far signs and signs with negative pitch (below SV camera).

---

## 1. The Pipeline

Detection produces angular coordinates (heading, pitch, angularWidth, angularHeight). These must be converted to pixel positions in Google's equirectangular tile grid to fetch and crop the correct region.

### Flow

```
YOLO bbox (px) in 640x640 gnomonic image
    ↓ pixel_to_angular(cx, cy)          ← backend/main.py:976
    ↓ pixel_to_angular(corner pixels)   ← backend/main.py:980-983
Angular coords (heading, pitch, angW, angH)
    ↓ returned to frontend
    ↓ headingPitchToPixelCorrected()    ← js/detection.js:907-955
    ↓ converts heading/pitch → tile grid px with tilt correction
Tile pixel coords (x, y, width, height)
    ↓ fetch tiles, stitch, crop         ← backend/main.py crop_sign_tiles
Crop preview image
```

### Key Functions

| Function | File | Lines | Purpose |
|---|---|---|---|
| `pixel_to_angular()` | `backend/main.py` | 294-376 | Gnomonic px → world heading/pitch |
| `headingPitchToPixelCorrected()` | `js/detection.js` | 907-955 | World heading/pitch → equirect tile px (with tilt) |
| `headingPitchToPixel()` | `js/detection.js` | 93-128 | Same, without tilt correction |
| `buildDetectionCropPlan()` | `js/detection.js` | ~1940-2000 | Orchestrates conversion, computes crop bounds |
| `crop_sign_tiles()` | `backend/main.py` | ~500-590 | Stitches tiles, crops region |

---

## 2. What Has Been Tried

### Attempt 1: Pitch Bias Shifting
**Commit:** `65bac76` — `feat(detection): shift crop center down by pitch bias for visual centering`

Added `CROP_PITCH_BIAS_DOWN` constant to shift crop center down, compensating for gnomonic center bias. Later set to `0` (disabled). Still present in code at `js/detection.js:61`.

### Attempt 2: Angular Midpoint for Detection Pitch (APPLIED THEN REVERTED)
**Commit:** `0a10c36` — `fix: use angular midpoint for detection pitch to fix sign crop misalignment`

Changed backend to compute `center_pitch = (tl_p + tr_p + bl_p + br_p) / 4` using angular values of all 4 bbox corners, instead of `pixel_to_angular(cx, cy)` which returns the gnomonic pixel center (biased toward horizon for off-center signs).

**Reverted by commit `6b58013`** (Apr 6, 12:49). The `center_pitch = (tl_p + tr_p + bl_p + br_p) / 4` line was removed. Current code at `backend/main.py:976` uses `pixel_to_angular(cx, cy)` for center_pitch.

**Diff of the revert:**
```python
# Before (angular midpoint):
center_heading, _ = pixel_to_angular(cx, cy, ...)
center_pitch = (tl_p + tr_p + bl_p + br_p) / 4

# After (reverted to gnomonic center):
center_heading, center_pitch = pixel_to_angular(cx, cy, ...)
```

### Attempt 3: Click-to-Annotate Crop Offset Tool
**Commit:** `6b58013` — `debug: add click-to-annotate crop offset tool`

Interactive tool in the UI: click on sign top in crop preview → logs pixel offset from expected position. Adds `cropPlanMeta` and `cropDiagnostics` to sign objects. Includes `_dumpAnnotations()` for CSV export.

### Attempt 4: Crop Re-centering on Image Edges
**Commit:** `aaa5be4` — `fix: re-center sign crop when hitting image edges`

Backend clamps crop bounds when they extend past tile grid boundaries, shifts crop inward. Returns `crop_diagnostics` with `recenter_shift` values.

### Attempt 5: Replace cos(relH) Tilt Hack with Proper 3D Rotation
**Commit:** `ab0d001` — `fix: replace cos(relH) tilt hack with proper 3D rotation`

Original tilt correction:
```javascript
const tiltOffset = tilt - 90;
const yCorrection = tiltOffset * Math.cos(relH * Math.PI / 180) * (imageHeight / 180);
```

Replaced with proper 3D rotation (current code at `js/detection.js:907-955`):
1. World (heading, pitch) → 3D direction vector (x=east, y=north, z=up)
2. Rotate by -panoHeading around Z → camera-local frame
3. Inverse tilt rotation around X axis (alpha = tilt - 90)
4. Stabilized direction → equirectangular pixels via atan2/asin

### Attempt 6: Panorama Calibration Walker
**Commit:** `2388417` — `feat: add panorama calibration walker and fix live reload watcher`

`scripts/walk-panos.js` — headless Node.js script that:
- Walks all panos in a geographic region
- Detects signs via YOLO backend
- Outputs JSONL with detection data + predicted equirect positions
- `--min-tilt-offset N` flag filters extreme-tilt panos
- Ports `headingPitchToPixelCorrected()` inline to compute predicted positions
- Added `bbox_x1/y1/x2/y2` to `AngularDetection` API response

### Attempt 7: Manual Calibration with annotate-tilt.html
**File:** `tools/annotate-tilt.html`

HTML app where user manually marks sign top/bottom in tile images to compute ground truth vs predicted offset. Outputs CSV annotations.

---

## 3. Calibration Data & Findings

### Data Files
- `calibration-all-panos.jsonl` — 166 panos walked (83KB)
- `calibration-extreme-tilt.jsonl` — extreme tilt panos only (17KB)
- `calibration-walk.jsonl` — original walk (70KB)
- `tilt-annotations-2026-04-07.csv` — 54 manual annotations (9KB)

### Analysis Results (from conversation `23b4296a`, Apr 7)

**54 annotated signs:**
- `yCorrection` (tilt correction) has **zero correlation** (r=0.088) with actual error
- **Tilt VALUE** is the strongest predictor: **-15 px per degree of (tilt - 90)**
- Panos with tilt > 91 → crops predicted too high; tilt < 89 → too low
- **72% of variance unexplained** by relH + tilt + pitch combined

**26 extreme-tilt annotations:**
- Mean error -4.9 px (near zero overall), stdev 52.5 px
- Evenly split 13/13 too-high vs too-low
- Two signs had **wrong tiles selected entirely** (separate bug)
- 20% of signs needed trapezoid bbox (not rectangle) due to extreme tilt — annotation noise

### Key Finding
The 3D tilt rotation math produces `yCorrection` values that don't correlate with actual error. But tilt *value* correlates. This suggests either:
- The rotation has a **scaling or sign convention mismatch** with Google's tilt metadata
- Google's "tilt" means something different than what the rotation assumes
- There's a **second uncorrected tilt effect** the current rotation doesn't capture

---

## 4. Unresolved Issues (Priority Order)

### P1: Gnomonic Pixel Center Bias (reverted fix)
**File:** `backend/main.py:976-979`

The angular midpoint fix was committed then reverted. Currently `center_pitch` comes from `pixel_to_angular(cx, cy)` — the gnomonic pixel center. For signs below the optical axis, the bottom half of a bbox covers more angular range than the top half, so the true angular center is **lower** than pixel center computes. This shifts crops upward.

**Action:** Re-apply the angular midpoint fix or find why it was reverted.

### P2: Tilt Rotation May Not Match Google's Convention
**File:** `js/detection.js:934-941`

The 3D rotation assumes `tilt - 90` degrees of downward camera rotation around the X (right) axis. But calibration data shows tilt value predicts error while `yCorrection` doesn't. Possible causes:
- Google's tilt is not a simple rotation around the camera's right axis
- Google's tilt may be measured differently (e.g., from vertical vs from horizontal)
- The stabilized tile grid may use a different correction than assumed
- There could be a second tilt component (roll?) not captured

**Action:** Verify Google Street View tilt convention against documentation or empirical testing. Check if tilt affects horizontal position too (not just vertical).

### P3: Wrong Tile Selection (separate bug)
2 of 26 extreme-tilt annotations had completely wrong tiles selected for the detected bbox. This is a separate issue from the offset/misalignment problem.

**Action:** Investigate tile coordinate math in `buildDetectionCropPlan()` — the computed tile indices may be wrong for some heading/tilt combinations.

### P4: Per-Sign Variance (72% unexplained)
Even after accounting for tilt, relH, and pitch, 72% of error variance is unexplained. Individual signs vary widely.

**Action:** More data collection needed. Could be gnomonic distortion in bbox dimensions, Depth Anything errors, or annotation noise.

---

## 5. Critical Code Locations

### Backend: Detection → Angular Coords
```
backend/main.py:976-983  — pixel_to_angular for center and corners
backend/main.py:985-992  — angular width/height from corners
backend/main.py:1011-1019 — AngularDetection response (heading, pitch, etc.)
```

### Frontend: Angular Coords → Tile Pixels
```
js/detection.js:907-955  — headingPitchToPixelCorrected() (3D rotation)
js/detection.js:1961     — call site in buildDetectionCropPlan()
js/detection.js:1940-2010 — buildDetectionCropPlan() full function
```

### Backend: Tile Fetch + Crop
```
backend/main.py:~500-590  — crop_sign_tiles endpoint
backend/main.py:533-540   — boundary clamping + recenter
```

### Walker & Calibration
```
scripts/walk-panos.js     — headless walker (has inline headingPitchToPixelCorrected)
tools/annotate-tilt.html  — manual annotation tool
calibration-*.jsonl       — collected data
tilt-annotations-*.csv    — manual annotations
```

---

## 6. Conversations with Relevant Work

| Conversation ID | Date | Topic |
|---|---|---|
| `23b4296a` | Apr 7 | Main investigation: tilt calibration, walker, data analysis |
| `31e17b6c` | Apr 6 | Investigated sign positions in crop previews |
| `cb44ab4c` | Apr 6 | Continued investigation of sign top positions |
| `b3bf4a06` | Apr 6 | Continued investigation of crop distortion |
| `a12b790a` | Apr 6 | Bad crop investigation, added annotation tool |
| `b2df1320` | Apr 6 | Crop preview auto-open after detection |
| `e5deb6fd` | Apr 6 | Crop preview showing wrong sign |
| `c1774670` | Apr 8 | Received investigation from another agent |
| `0c099b78` | Mar 14 | Ground plane intersection, depth estimation design |

---

## 7. Suggested Next Steps

1. **Re-apply angular midpoint fix** in `backend/main.py:976-979`. Understand why it was reverted — was it causing regressions elsewhere?
2. **Validate tilt convention** — fetch pano metadata for known locations, compare Google's tilt values against visual horizon position. The 3D rotation assumes tilt-90 around X-axis; verify this matches reality.
3. **Test with tilt=90 panos only** — if tilt correction is wrong, panos with tilt=90 (no tilt) should crop correctly. If they don't, the bug is elsewhere (gnomonic center, tile selection, etc.)
4. **Check tile X coordinate accuracy** — most investigation focused on Y (vertical). Verify horizontal positioning is correct too.
5. **More calibration data** — collect annotations specifically for tilt=90 panos to isolate gnomonic center bias from tilt issues.
