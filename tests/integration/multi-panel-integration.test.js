/**
 * Integration test for multi-panel parking sign detection.
 * Simulates panorama detection with 2-stacked sign clusters.
 */

// Constants from detection.js
const SIGN_PANEL_ASPECT_RATIO = 182 / 111;
const ASPECT_RATIO_TOLERANCE = 0.15;
const ASPECT_RATIO_2_STACKED_THRESHOLD = 2.5;

function inferSignClusterHeight(angularHeight, angularWidth, sourceDetectionsCount = 1) {
  if (angularWidth <= 0) {
    return { referenceHeightCm: 45, panelLayout: "unknown" };
  }
  const observedAspectRatio = angularHeight / angularWidth;
  
  if (Math.abs(observedAspectRatio - SIGN_PANEL_ASPECT_RATIO) < ASPECT_RATIO_TOLERANCE) {
    if (sourceDetectionsCount >= 3) {
      return { referenceHeightCm: 90, panelLayout: "2x2_grid" };
    }
    return { referenceHeightCm: 45, panelLayout: "single" };
  }

  if (observedAspectRatio > SIGN_PANEL_ASPECT_RATIO) {
    const stackFactor = observedAspectRatio / SIGN_PANEL_ASPECT_RATIO;
    if (stackFactor < ASPECT_RATIO_2_STACKED_THRESHOLD) {
      return { referenceHeightCm: 90, panelLayout: "2_stacked" };
    } else if (stackFactor < 3.5) {
      return { referenceHeightCm: 135, panelLayout: "3_stacked" };
    } else {
      return { referenceHeightCm: 135, panelLayout: "3_stacked+" };
    }
  }

  if (observedAspectRatio < SIGN_PANEL_ASPECT_RATIO / 1.5) {
    return { referenceHeightCm: 45, panelLayout: "2_horizontal" };
  }

  return { referenceHeightCm: 45, panelLayout: "unknown" };
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Simulate depth calibration: apply per-detection scale factor
function calibrateDetectionDepth(depth_raw, angular_height, reference_height_cm) {
  if (!depth_raw || !angular_height) return null;
  
  const reference_height_m = reference_height_cm / 100.0;
  const ang_h_rad = (angular_height * Math.PI) / 180;
  const estimated_height_m = 2 * depth_raw * Math.tan(ang_h_rad / 2);
  
  if (estimated_height_m <= 0) return null;
  
  const scale_factor = reference_height_m / estimated_height_m;
  return depth_raw * scale_factor;
}

// Test scenario: 2-stacked parking sign cluster
console.log("Integration Test: 2-Stacked Parking Sign Detection\n");

// Simulated detections from overlapping slices
// Real signs at 20m distance with 2 stacked panels (0.90m tall)
const sliceDetections = [
  {
    heading: 45.0,
    pitch: 0.0,
    angularWidth: 1.0,   // 1 degree wide
    angularHeight: 2.5,  // 2.5 degrees tall (2-stacked, 3.28 would be exact)
    confidence: 0.92,
    class_name: "parking_sign",
    depth_anything_meters_raw: 18.5,  // Underestimate (raw Depth Anything)
  },
  {
    heading: 44.8,
    pitch: 0.1,
    angularWidth: 1.1,   // Slightly wider due to perspective
    angularHeight: 2.6,  // Slightly taller
    confidence: 0.88,
    class_name: "parking_sign",
    depth_anything_meters_raw: 19.2,  // Similar underestimate
  },
];

// Step 1: Infer panel height for each detection
console.log("Step 1: Panel height inference per detection");
const detWithCalibration = sliceDetections.map((det) => {
  const { referenceHeightCm, panelLayout } = inferSignClusterHeight(
    det.angularHeight,
    det.angularWidth,
    1  // Single source detection
  );
  
  const depthCalibrated = calibrateDetectionDepth(
    det.depth_anything_meters_raw,
    det.angularHeight,
    referenceHeightCm
  );

  console.log(`  Detection: heading=${det.heading}°, height=${det.angularHeight}°`);
  console.log(`    -> Layout: ${panelLayout}, ReferenceHeight: ${referenceHeightCm}cm`);
  console.log(`    -> Raw depth: ${det.depth_anything_meters_raw.toFixed(2)}m, Calibrated: ${depthCalibrated.toFixed(2)}m`);

  return {
    ...det,
    panelLayout,
    referenceHeightCm,
    depthCalibrated,
  };
});

// Step 2: Aggregate calibrated depths
console.log("\nStep 2: Depth aggregation");
const calibratedDepths = detWithCalibration
  .filter(d => d.depthCalibrated && d.depthCalibrated > 0)
  .map(d => d.depthCalibrated);

const aggregatedDepthCalibrated = median(calibratedDepths);
console.log(`  Calibrated depths: [${calibratedDepths.map(d => d.toFixed(2)).join(", ")}]`);
console.log(`  Aggregated (median): ${aggregatedDepthCalibrated.toFixed(2)}m`);

// Step 3: Verify accuracy
console.log("\nStep 3: Accuracy verification");
const groundTruthDepth = 20.0;  // Known distance to sign
const accuracyCalibrated = Math.abs(aggregatedDepthCalibrated - groundTruthDepth) / groundTruthDepth * 100;

// For comparison, show old method (fixed 0.45m assumption)
const rawDepths = sliceDetections.map(d => d.depth_anything_meters_raw);
const aggregatedDepthRaw = median(rawDepths);
const accuracyRaw = Math.abs(aggregatedDepthRaw - groundTruthDepth) / groundTruthDepth * 100;

console.log(`  Ground truth distance: ${groundTruthDepth.toFixed(2)}m`);
console.log(`  Old method (raw depth): ${aggregatedDepthRaw.toFixed(2)}m (error: ${accuracyRaw.toFixed(1)}%)`);
console.log(`  New method (calibrated): ${aggregatedDepthCalibrated.toFixed(2)}m (error: ${accuracyCalibrated.toFixed(1)}%)`);

// Step 4: Verify panel layout detection
console.log("\nStep 4: Panel layout verification");
const allLayoutsSame = detWithCalibration.every(d => d.panelLayout === detWithCalibration[0].panelLayout);
const expectedLayout = "2_stacked";
const layoutCorrect = allLayoutsSame && detWithCalibration[0].panelLayout === expectedLayout;

console.log(`  Expected layout: ${expectedLayout}`);
console.log(`  Detected layouts: ${detWithCalibration.map(d => d.panelLayout).join(", ")}`);
console.log(`  Layout detection: ${layoutCorrect ? "✓ PASS" : "✗ FAIL"}`);

// Final result
const allPassed = layoutCorrect && accuracyCalibrated < 15;  // Allow 15% error for integration test
console.log(`\n${allPassed ? "✓ INTEGRATION TEST PASSED" : "✗ INTEGRATION TEST FAILED"}`);
process.exit(allPassed ? 0 : 1);
