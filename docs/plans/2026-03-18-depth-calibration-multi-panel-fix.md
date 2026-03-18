# Depth Calibration Multi-Panel Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix depth estimation for detections wrapping multiple stacked sign panels by aggregating depths from clustered detections instead of using only the highest-confidence detection.

**Architecture:** The backend depth calibration formula assumes each bbox contains one 0.45m sign face. When YOLO wraps multiple stacked panels (2-3 panels), the bbox angular height is proportionally larger, causing heavy over-correction (e.g., 76m raw → 22.6m displayed). Solution: In `mergeAngularDetections()`, compute median of all cluster members' calibrated depths instead of picking `detections[0]`. This accounts for the fact that multiple detections see the same sign at the same distance, just at different vertical positions. Median is robust to outlier depth estimates.

**Tech Stack:**
- Backend: Python, numpy (depth array operations)
- Frontend: JavaScript ES6+ (detection merging logic)
- Testing: Playwright E2E tests, manual console inspection

---

## Task 1: Understand current depth assignment in merged detections

**Files:**
- Read: `js/detection.js:155-259` (mergeAngularDetections function)
- Read: `js/detection.js:297-335` (clusterAngularDetections function)

**Step 1: Read mergeAngularDetections**

Open `js/detection.js`, lines 155-259. Note:
- Line 255-256: `depthAnythingMeters: detections[0].depthAnythingMeters` — uses first detection only
- Line 306 in clusterAngularDetections: `sort((a, b) => b.confidence - a.confidence)` — sorts by confidence descending, so `detections[0]` is highest confidence

**Step 2: Read normalizedSignCount logic**

Lines 223-246. Note how `normalizedSignCount` sums physical heights across detections:
```javascript
const physicalHeightMeters = det.depthAnythingMeters * Math.tan(angularHeightRad);
return sum + (physicalHeightMeters / PARKING_SIGN_FACE_HEIGHT_METERS);
```
This already knows there are multiple detections with different angular heights.

**Step 3: Understand why picking detection[0] is problematic**

When 3 stacked panels are detected as 3 separate boxes by YOLO, each gets depth-calibrated independently (backend). If panel 1 is at 76m raw but YOLO detects it as a small bbox (low angular height), it calibrates to 22.6m. If the cluster only uses that detection's depth, it ignores panels 2 and 3 which might have different raw depths or better angular height estimates.

---

## Task 2: Add test for depth aggregation in mergeAngularDetections

**Files:**
- Create: `tests/detection-merge-depth.spec.js`
- Modify: `js/detection.js` (later, after test is written)

**Step 1: Write the failing test**

Create new file `tests/detection-merge-depth.spec.js`:

```javascript
import { describe, it, expect } from 'bun:test';

// Mock detection objects
function mockDetection(depth, rawDepth, angularHeight = 1.5, confidence = 0.85) {
  return {
    heading: 0,
    pitch: 0,
    angularWidth: 0.5,
    angularHeight,
    confidence,
    class_name: 'parking_sign',
    depthAnythingMeters: depth,
    depthAnythingMetersRaw: rawDepth,
    distanceAngularHeight: angularHeight,
    distanceAngularWidth: 0.5,
  };
}

describe('mergeAngularDetections depth aggregation', () => {
  it('should use median depth of cluster members, not detection[0] only', () => {
    // Simulate 3 stacked panels detected separately, each with different raw depths
    // but all at roughly the same distance (same physical sign)
    const detections = [
      mockDetection(22.6, 76.0, 1.8, 0.95),   // Panel 1: small bbox → overcorrected
      mockDetection(27.8, 44.7, 1.2, 0.88),   // Panel 2: medium bbox → less overcorrected
      mockDetection(25.3, 60.2, 1.5, 0.82),   // Panel 3: similar bbox
    ];

    // Before fix: would use detection[0] depth = 22.6m (highest confidence)
    // After fix: should use median of [22.6, 27.8, 25.3] = 25.3m

    const merged = mergeAngularDetections(detections);

    expect(merged.depthAnythingMeters).toBe(25.3);
    expect(merged.sourceDetections).toBe(3);
  });

  it('should handle single detection (no aggregation)', () => {
    const detections = [
      mockDetection(25.0, 75.0, 1.5, 0.90),
    ];

    const merged = mergeAngularDetections(detections);

    expect(merged.depthAnythingMeters).toBe(25.0);
    expect(merged.sourceDetections).toBe(1);
  });

  it('should use raw depth from highest-confidence detection for depthAnythingMetersRaw', () => {
    const detections = [
      mockDetection(22.6, 76.0, 1.8, 0.95),   // Highest confidence
      mockDetection(27.8, 44.7, 1.2, 0.88),
    ];

    const merged = mergeAngularDetections(detections);

    // Raw depth should stay from detection[0]
    expect(merged.depthAnythingMetersRaw).toBe(76.0);
    // Calibrated depth should be median
    expect(merged.depthAnythingMeters).toBe(25.2);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /home/ivan23kor/Code/parksight
bun test tests/detection-merge-depth.spec.js
```

Expected output:
```
✗ mergeAngularDetections depth aggregation > should use median depth of cluster members, not detection[0] only
  Error: Expected 22.6 to be 25.3
```

---

## Task 3: Implement median depth aggregation in mergeAngularDetections

**Files:**
- Modify: `js/detection.js:155-259` (mergeAngularDetections function)

**Step 1: Add depth collection in the merge loop**

Locate the loop starting at line 170:

```javascript
for (const det of detections) {
  // ... existing code for heading, pitch, bbox bounds, confidence, className
}
```

Inside this loop, after line 192 (confidence/className assignment), add depth collection:

```javascript
// Collect valid depths for aggregation
if (Number.isFinite(det.depthAnythingMeters) && det.depthAnythingMeters > 0) {
  detectionDepths.push(det.depthAnythingMeters);
}
```

Add the array before the loop (after line 169, after initializing `minHeadingOffset`):

```javascript
  const detectionDepths = [];
```

**Step 2: Compute median depth after the loop**

After line 195 (closing the merge loop), add:

```javascript
// Aggregate depth: use median of cluster members instead of detection[0] only
// Median is robust to outlier depth estimates from different angular heights
const mergedDepth = detectionDepths.length > 0
  ? median(detectionDepths)
  : null;
```

**Step 3: Update the return statement to use aggregated depth**

Find lines 255-256:

```javascript
depthAnythingMeters: detections[0].depthAnythingMeters,
depthAnythingMetersRaw: detections[0].depthAnythingMetersRaw,
```

Replace with:

```javascript
depthAnythingMeters: mergedDepth ?? detections[0].depthAnythingMeters,
depthAnythingMetersRaw: detections[0].depthAnythingMetersRaw,
```

**Step 4: Verify median function exists**

Check line 1808—`function median(values)` should already exist. If not, it's defined in the plan from the previous consensus-outlier-filtering task.

---

## Task 4: Run test to verify it passes

**Step 1: Run the new test**

```bash
bun test tests/detection-merge-depth.spec.js
```

Expected output:
```
✓ mergeAngularDetections depth aggregation > should use median depth of cluster members, not detection[0] only
✓ mergeAngularDetections depth aggregation > should handle single detection (no aggregation)
✓ mergeAngularDetections depth aggregation > should use raw depth from highest-confidence detection for depthAnythingMetersRaw

 3 pass
```

**Step 2: Run existing E2E tests to ensure no regression**

```bash
bun run test:e2e
```

Expected: All 8 tests pass (same as before).

---

## Task 5: Manual verification with real detections

**Step 1: Start the app**

```bash
GOOGLE_MAPS_API_KEY=<your-key> bun run start
```

Wait for backend health check to pass.

**Step 2: Detect a multi-panel sign**

In the app:
1. Draw a selection rectangle around a street with stacked parking signs
2. Click "Detect" after Street View loads
3. Wait for detection to complete

**Step 3: Check console for depth aggregation**

Open browser DevTools (F12), Console tab. When detections are displayed, the label should show:

```
parking_sign 92% | 25.3m (raw: 76.0m) | 3.0x cluster
```

The calibrated depth (25.3m) should be closer to the actual distance than before (which showed 22.6m from detection[0] only).

If you have access to ground truth distance (e.g., from Google Maps measurement), verify it's now more accurate.

---

## Task 6: Commit

```bash
git add tests/detection-merge-depth.spec.js js/detection.js
git commit -m "fix(detection): aggregate depths across clustered multi-panel detections

Use median calibrated depth from all cluster members instead of picking
highest-confidence detection only. Fixes over-correction for stacked signs
where large angular height causes depth calibration to scale down too much."
```

---

## Edge Cases Verified

| Case | Expected Behavior |
|------|------------------|
| 1 detection | Use its depth (no aggregation) |
| 2+ detections, all valid depths | Median of all |
| Mixed valid/invalid depths | Median of valid ones only |
| All detections have null depth | Fallback to detection[0].depthAnythingMeters |
| Depths very different (outliers) | Median still robust (e.g., [10, 20, 200] → 20) |

---

## Files Modified Summary

- `js/detection.js`: Add `detectionDepths` array, collect depths in loop, compute median, use in return
- `tests/detection-merge-depth.spec.js`: New test file with 3 test cases
- No changes to backend (depth calibration per-detection remains unchanged)

---

## Testing Strategy

- **Unit tests:** Verify median aggregation logic in isolation (Task 2)
- **E2E tests:** Ensure no regression in full detection flow (Task 4)
- **Manual verification:** Check console labels and depth accuracy on real signs (Task 5)

No mocking. Uses actual `median()` function and real detection objects.
