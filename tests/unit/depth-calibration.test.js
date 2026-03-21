/**
 * Unit tests for depth calibration functions.
 * Tests inferSignClusterHeight() with known aspect ratios.
 */

// Constants (duplicated from js/detection.js for testing)
const SIGN_PANEL_ASPECT_RATIO = 182 / 111;  // ≈ 1.64
const SIGN_PANEL_HEIGHT_CM = 45;
const ASPECT_RATIO_TOLERANCE = 0.15;
const ASPECT_RATIO_2_STACKED_THRESHOLD = 2.5;
const ASPECT_RATIO_3_STACKED_THRESHOLD = 3.5;
const ASPECT_RATIO_HORIZONTAL_THRESHOLD = 1.5;

function inferSignClusterHeight(angularHeight, angularWidth, sourceDetectionsCount = 1) {
  // Guard against zero or negative width
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
    } else if (stackFactor < ASPECT_RATIO_3_STACKED_THRESHOLD) {
      return { referenceHeightCm: 135, panelLayout: "3_stacked" };
    } else {
      return { referenceHeightCm: 135, panelLayout: "3_stacked+" };
    }
  }

  if (observedAspectRatio < SIGN_PANEL_ASPECT_RATIO / ASPECT_RATIO_HORIZONTAL_THRESHOLD) {
    return { referenceHeightCm: 45, panelLayout: "2_horizontal" };
  }

  return { referenceHeightCm: 45, panelLayout: "unknown" };
}

// Test suite
const tests = [
  // Single panel tests (H:W ≈ 1.64)
  {
    name: "Single panel (aspect ratio 1.64)",
    angularHeight: 1.64,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 45,
    expectedLayout: "single",
  },
  {
    name: "Single panel with tolerance (aspect ratio 1.70)",
    angularHeight: 1.70,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 45,
    expectedLayout: "single",
  },
  {
    name: "Single panel with tolerance (aspect ratio 1.58)",
    angularHeight: 1.58,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 45,
    expectedLayout: "single",
  },

  // 2×2 grid tests (same aspect ratio as single, but multiple source detections)
  {
    name: "2×2 grid (3+ source detections)",
    angularHeight: 1.64,
    angularWidth: 1.0,
    sourceDetectionsCount: 3,
    expectedHeight: 90,
    expectedLayout: "2x2_grid",
  },

  // 2-stacked tests (H:W ≈ 3.28)
  {
    name: "2-stacked (aspect ratio 3.28, stackFactor 2.0)",
    angularHeight: 3.28,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 90,
    expectedLayout: "2_stacked",
  },
  {
    name: "2-stacked at threshold edge (stackFactor 2.49)",
    angularHeight: 2.49 * SIGN_PANEL_ASPECT_RATIO,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 90,
    expectedLayout: "2_stacked",
  },

  // 3-stacked tests (H:W ≈ 4.92)
  {
    name: "3-stacked (aspect ratio 4.92, stackFactor 3.0)",
    angularHeight: 4.92,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 135,
    expectedLayout: "3_stacked",
  },
  {
    name: "3-stacked+ (stackFactor 4.0)",
    angularHeight: 4.0 * SIGN_PANEL_ASPECT_RATIO,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 135,
    expectedLayout: "3_stacked+",
  },

  // 2-horizontal tests (H:W << 1.64, typically 0.82)
  {
    name: "2-horizontal (aspect ratio 0.82)",
    angularHeight: 0.82,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 45,
    expectedLayout: "2_horizontal",
  },

  // Edge cases
  {
    name: "Zero width (unknown)",
    angularHeight: 1.64,
    angularWidth: 0,
    sourceDetectionsCount: 1,
    expectedHeight: 45,
    expectedLayout: "unknown",
  },
  {
    name: "Aspect ratio in 2-horizontal range (0.9)",
    angularHeight: 0.9,
    angularWidth: 1.0,
    sourceDetectionsCount: 1,
    expectedHeight: 45,
    expectedLayout: "2_horizontal",
  },
];

// Run tests
console.log("Running inferSignClusterHeight() unit tests...\n");
let passed = 0;
let failed = 0;

for (const test of tests) {
  const { referenceHeightCm, panelLayout } = inferSignClusterHeight(
    test.angularHeight,
    test.angularWidth,
    test.sourceDetectionsCount
  );

  const heightMatch = referenceHeightCm === test.expectedHeight;
  const layoutMatch = panelLayout === test.expectedLayout;
  const success = heightMatch && layoutMatch;

  if (success) {
    console.log(`✓ ${test.name}`);
    passed++;
  } else {
    console.log(`✗ ${test.name}`);
    if (!heightMatch) console.log(`  Expected height ${test.expectedHeight}, got ${referenceHeightCm}`);
    if (!layoutMatch) console.log(`  Expected layout "${test.expectedLayout}", got "${panelLayout}"`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
