/**
 * Parking sign detection module.
 * Handles API calls and bounding box overlay on interactive panorama.
 */

// Detection state
let detectionPanorama = null;
let currentDetections = []; // Store detections as {heading, pitch, angularWidth, angularHeight, distanceAngularHeight, confidence, class_name}
let detectionPov = { heading: 0, pitch: 0, zoom: 1 }; // POV when detection was run
let povChangeListener = null;
let panoChangeListener = null;
let positionChangeListener = null;
let detectionOverlayResizeObserver = null;
let detectionOverlayResizeCleanup = null;
let detectionOverlayUpdateFrame = null;
// Track document-level event listeners for proper cleanup
const documentEventListeners = [];
const panoramaLinkSpotPositionCache = new Map();
const panoramaLinkSpotRequestsInFlight = new Set();

// Debug overlay state (toggle with Shift+D)
let debugOverlaysEnabled = false;
let debugMapLayer = null; // Leaflet layer group for debug overlays on 2D map

// Initialize global sign registry
window.signRegistry = new SignRegistry();

// OCR modal state
let ocrModalEl = null;
let ocrResults = new Map(); // Cache OCR results by detection index

// Rule curve constants
const RULE_CATEGORY_COLORS = {
  no_parking: "#ef4444",
  parking_allowed: "#22c55e",
  loading_zone: "#8b5cf6",
  permit_required: "#f59e0b",
};

const TOW_ZONE_COLOR = "#dc2626";
const RULE_CURVE_SAMPLE_STEP_METERS = 3;
const RULE_CURVE_DEFAULT_LENGTH_METERS = 50;
const RULE_CURVE_INTERSECTION_SKIP_METERS = 2;
const RULE_CURVE_STACK_OFFSET_METERS = 0.8;
const SAME_STREET_PROJECTION_THRESHOLD_METERS = 20;


/**
 * Calculate FOV from Street View zoom level.
 * Google's Street View uses: fov = 2 * atan(2^(1-zoom))
 * @param {number} zoom - Zoom level (typically 0-4)
 * @returns {number} Field of view in degrees
 */
function zoomToFov(zoom) {
  return (Math.atan(Math.pow(2, 1 - zoom)) * 360) / Math.PI;
}

// Tile constants
const TILE_SIZE = 512; // Street View tile size in pixels
const MAX_ZOOM = 5; // Maximum zoom level for Street View tiles
const TILE_GRID_WIDTH = 32 * TILE_SIZE; // 16384
const TILE_GRID_HEIGHT = 16 * TILE_SIZE; // 8192
const CROP_PADDING_X = 1.2; // 20% wider total around the detected sign
const CROP_PADDING_Y = 1.5; // Preserve 25% extra sign height above and below the detection
const CROP_PITCH_BIAS_DOWN = 0;
const DETECTION_CLUSTER_WIDTH_RATIO = 1.25;
const DETECTION_CLUSTER_HEIGHT_RATIO = 2.4;
const DETECTION_CLUSTER_WIDTH_FLOOR = 0.35;
const DETECTION_CLUSTER_HEIGHT_FLOOR = 1.0;
const PANORAMA_LINK_SPOT_HEIGHT_METERS = 0;
const PANORAMA_LINK_SPOT_RADIUS_PX = 12;
const PANORAMA_LINK_SPOT_MAX_VISIBLE = 8;

// Sign panel aspect ratio and height calibration constants
// Reference sign from screenshot: 182px height / 111px width = 1.64
const SIGN_PANEL_ASPECT_RATIO = 182 / 111;  // ≈ 1.64
const SIGN_PANEL_HEIGHT_CM = 45;            // Single panel height in cm
const ASPECT_RATIO_TOLERANCE = 0.15;        // Tolerance band for aspect ratio classification
// Thresholds for stacking factor (observedAspectRatio / SIGN_PANEL_ASPECT_RATIO)
const ASPECT_RATIO_2_STACKED_THRESHOLD = 2.5;   // 2 panels vertically stacked
const ASPECT_RATIO_3_STACKED_THRESHOLD = 3.5;   // 3 panels vertically stacked
const ASPECT_RATIO_HORIZONTAL_THRESHOLD = 1.5;  // 2 panels side-by-side vs single

/**
 * Convert heading/pitch to pixel coordinates in the full panorama tile image.
 *
 * Google Street View tiles are in a stabilized equirectangular frame where
 * roll has already been applied and tilt describes where the horizon sits.
 * Only the camera heading rotation needs to be undone.
 *
 * @param {number} heading - World heading in degrees (compass bearing)
 * @param {number} pitch - World pitch in degrees (positive=up, negative=down)
 * @param {number} imageWidth - Panorama tile grid width in pixels
 * @param {number} imageHeight - Panorama tile grid height in pixels
 * @param {number} panoHeading - Camera heading from metadata (degrees)
 */
function headingPitchToPixel(
  heading,
  pitch,
  imageWidth,
  imageHeight,
  panoHeading = 0,
) {
  let h = (heading - panoHeading + 180 + 360) % 360;
  const x = (h / 360) * imageWidth;
  const y = ((90 - pitch) / 180) * imageHeight;
  return { x, y };
}

/**
 * Convert angular dimensions to pixel dimensions.
 */
function angularToPixelSize(
  angularWidth,
  angularHeight,
  imageWidth,
  imageHeight,
) {
  const width = (angularWidth / 360) * imageWidth;
  const height = (angularHeight / 180) * imageHeight;
  return { width, height };
}

/**
 * Convert equirectangular pixel coordinates back to heading/pitch.
 * Inverse of headingPitchToPixel.
 */
function pixelToHeadingPitch(x, y, imageWidth, imageHeight, panoHeading = 0) {
  // Inverse of equirectangular projection
  const h = (x / imageWidth) * 360;
  const pitch = 90 - (y / imageHeight) * 180;

  // Convert back to compass heading (reverse the +180 offset)
  const heading = (h - 180 + panoHeading + 360) % 360;

  return { heading, pitch };
}

/**
 * Get tile coordinates that cover a pixel region.
 */
function getTilesForRegion(
  x,
  y,
  width,
  height,
  paddingX = CROP_PADDING_X,
  paddingY = CROP_PADDING_Y,
) {
  const pw = width * paddingX;
  const ph = height * paddingY;

  // Calculate bounds - (x, y) is the center of the detection
  const x1 = x - pw / 2;
  const y1 = y - ph / 2;
  const x2 = x + pw / 2;
  const y2 = y + ph / 2;

  // Calculate tile coordinates
  const tileX1 = Math.floor(x1 / TILE_SIZE);
  const tileY1 = Math.max(0, Math.floor(y1 / TILE_SIZE));
  const tileX2 = Math.floor(x2 / TILE_SIZE);
  const tileY2 = Math.min(15, Math.floor(y2 / TILE_SIZE));

  // Collect all tiles needed
  const tiles = [];
  for (let ty = tileY1; ty <= tileY2; ty++) {
    for (let tx = tileX1; tx <= tileX2; tx++) {
      tiles.push({ x: tx, y: ty });
    }
  }

  // Calculate crop bounds within the stitched tile image
  const stitchOriginX = tileX1 * TILE_SIZE;
  const stitchOriginY = tileY1 * TILE_SIZE;

  const cropBounds = {
    x: Math.round(x1 - stitchOriginX),
    y: Math.round(y1 - stitchOriginY),
    width: Math.round(pw),
    height: Math.round(ph),
  };

  return { tiles, tileX1, tileY1, cropBounds };
}

function normalizePanoPixelX(x, imageWidth = TILE_GRID_WIDTH) {
  return ((x % imageWidth) + imageWidth) % imageWidth;
}

function wrapPixelDelta(delta, imageWidth = TILE_GRID_WIDTH) {
  let wrapped = delta % imageWidth;
  if (wrapped > imageWidth / 2) wrapped -= imageWidth;
  if (wrapped < -imageWidth / 2) wrapped += imageWidth;
  return wrapped;
}

function getDetectionHorizonHalfBandDegrees() {
  return window.DETECTION_CONFIG?.HORIZON_HALF_BAND_DEGREES ?? 10;
}

function getDetectionViewportRect() {
  if (typeof detectionPanorama?.getViewportRect === "function") {
    return detectionPanorama.getViewportRect();
  }

  const container = document.getElementById("detectionPanorama");
  const width = container?.clientWidth || 1;
  const height = container?.clientHeight || 1;
  const pov = detectionPanorama?.getPov?.() || { heading: 0, pitch: 0, zoom: 1 };
  const fov = zoomToFov(pov.zoom || 1);
  const halfBandDegrees = getDetectionHorizonHalfBandDegrees();
  const center = headingPitchToPixel(
    pov.heading,
    0,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    detectionPanorama?._panoHeading || 0,
  );
  const topBandPoint = headingPitchToPixel(
    pov.heading,
    halfBandDegrees,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    detectionPanorama?._panoHeading || 0,
  );
  const bottomBandPoint = headingPitchToPixel(
    pov.heading,
    -halfBandDegrees,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    detectionPanorama?._panoHeading || 0,
  );
  const bandHeight = Math.max(1, Math.abs(bottomBandPoint.y - topBandPoint.y));
  const sourceAspect = ((fov / 360) * TILE_GRID_WIDTH) / bandHeight;
  let drawWidth = width;
  let drawHeight = drawWidth / sourceAspect;
  if (drawHeight > height) {
    drawHeight = height;
    drawWidth = drawHeight * sourceAspect;
  }
  const drawLeft = (width - drawWidth) / 2;
  const drawTop = (height - drawHeight) / 2;
  return {
    centerX: center.x,
    centerY: (topBandPoint.y + bottomBandPoint.y) / 2,
    width: (fov / 360) * TILE_GRID_WIDTH,
    height: bandHeight,
    canvasWidth: width,
    canvasHeight: height,
    hFov: fov,
    vFov: halfBandDegrees * 2,
    drawLeft,
    drawTop,
    drawWidth,
    drawHeight,
    panoWidth: TILE_GRID_WIDTH,
    panoHeight: TILE_GRID_HEIGHT,
  };
}

function panoPixelToScreenPoint(x, y) {
  if (typeof detectionPanorama?.panoPixelToScreen === "function") {
    return detectionPanorama.panoPixelToScreen(x, y);
  }

  const rect = getDetectionViewportRect();
  const dx = wrapPixelDelta(x - rect.centerX, rect.panoWidth);
  const dy = y - rect.centerY;
  return {
    x: rect.drawLeft + rect.drawWidth / 2 + (dx / rect.width) * rect.drawWidth,
    y: rect.drawTop + rect.drawHeight / 2 + (dy / rect.height) * rect.drawHeight,
  };
}

function screenToPanoPixelPoint(screenX, screenY) {
  if (typeof detectionPanorama?.screenToPanoPixel === "function") {
    return detectionPanorama.screenToPanoPixel(screenX, screenY);
  }

  const rect = getDetectionViewportRect();
  return {
    x:
      rect.centerX +
      ((screenX - (rect.drawLeft + rect.drawWidth / 2)) / rect.drawWidth) * rect.width,
    y:
      rect.centerY +
      ((screenY - (rect.drawTop + rect.drawHeight / 2)) / rect.drawHeight) * rect.height,
  };
}

function scheduleDetectionOverlayUpdate() {
  if (detectionOverlayUpdateFrame != null) {
    return;
  }

  detectionOverlayUpdateFrame = window.requestAnimationFrame(() => {
    detectionOverlayUpdateFrame = null;
    updateDetectionOverlay();
  });
}

function tileDetectionToScreen(det, screenWidth, screenHeight) {
  if (
    !Number.isFinite(det?.tileX1) ||
    !Number.isFinite(det?.tileY1) ||
    !Number.isFinite(det?.tileX2) ||
    !Number.isFinite(det?.tileY2)
  ) {
    return null;
  }

  const topLeft = panoPixelToScreenPoint(det.tileX1, det.tileY1);
  const bottomRight = panoPixelToScreenPoint(det.tileX2, det.tileY2);
  const x = Math.min(topLeft.x, bottomRight.x);
  const y = Math.min(topLeft.y, bottomRight.y);
  const width = Math.abs(bottomRight.x - topLeft.x);
  const height = Math.abs(bottomRight.y - topLeft.y);

  if (x + width < 0 || x > screenWidth) return null;
  if (y + height < 0 || y > screenHeight) return null;

  return { x, y, width, height };
}

/**
 * Infer parking sign cluster configuration from bounding box aspect ratio.
 * Uses aspect ratio signature to distinguish single panel, stacked, or side-by-side arrangements.
 *
 * Returns { referenceHeightCm, panelLayout }
 * where referenceHeightCm is the inferred physical height of the sign cluster (used for depth calibration)
 * and panelLayout describes the configuration (single, 2_stacked, 3_stacked, 2_horizontal, etc)
 */
function inferSignClusterHeight(angularHeight, angularWidth, sourceDetectionsCount = 1) {
  // Guard against zero or negative width
  if (angularWidth <= 0) {
    return { referenceHeightCm: 45, panelLayout: "unknown" };
  }

  const observedAspectRatio = angularHeight / angularWidth;

  // Check if aspect ratio matches single panel (or 2×2 grid)
  if (Math.abs(observedAspectRatio - SIGN_PANEL_ASPECT_RATIO) < ASPECT_RATIO_TOLERANCE) {
    // Both single panel and 2×2 grid have similar H:W ≈ 1.64
    // Use source detections count to disambiguate
    if (sourceDetectionsCount >= 3) {
      return { referenceHeightCm: 90, panelLayout: "2x2_grid" };
    }
    return { referenceHeightCm: 45, panelLayout: "single" };
  }

  // Check for vertically stacked (H:W >> 1.64)
  if (observedAspectRatio > SIGN_PANEL_ASPECT_RATIO) {
    const stackFactor = observedAspectRatio / SIGN_PANEL_ASPECT_RATIO;

    if (stackFactor < ASPECT_RATIO_2_STACKED_THRESHOLD) {
      return { referenceHeightCm: 90, panelLayout: "2_stacked" };
    } else if (stackFactor < ASPECT_RATIO_3_STACKED_THRESHOLD) {
      return { referenceHeightCm: 135, panelLayout: "3_stacked" };
    } else {
      // Clamp to max reasonable stack
      return { referenceHeightCm: 135, panelLayout: "3_stacked+" };
    }
  }

  // Check for horizontally side-by-side (H:W << 1.64)
  if (observedAspectRatio < SIGN_PANEL_ASPECT_RATIO / ASPECT_RATIO_HORIZONTAL_THRESHOLD) {
    // When 2 panels are side-by-side, aspect ratio approaches 0.82 (half)
    // Use heading spread vs pitch spread to confirm horizontal arrangement
    return { referenceHeightCm: 45, panelLayout: "2_horizontal" };
  }

  // Ambiguous or unknown configuration
  return { referenceHeightCm: 45, panelLayout: "unknown" };
}

function mergeAngularDetections(detections) {
  if (!Array.isArray(detections) || detections.length === 0) {
    return [];
  }

  const normalizedDetections = detections.map(normalizeAngularDetection);
  const tileXs1 = normalizedDetections
    .map((det) => det.tileX1)
    .filter((value) => Number.isFinite(value));
  const tileYs1 = normalizedDetections
    .map((det) => det.tileY1)
    .filter((value) => Number.isFinite(value));
  const tileXs2 = normalizedDetections
    .map((det) => det.tileX2)
    .filter((value) => Number.isFinite(value));
  const tileYs2 = normalizedDetections
    .map((det) => det.tileY2)
    .filter((value) => Number.isFinite(value));
  let heading = detections[0].heading;
  let pitch = detections[0].pitch;
  let minPitch = detections[0].pitch - detections[0].angularHeight / 2;
  let maxPitch = detections[0].pitch + detections[0].angularHeight / 2;
  let confidence = detections[0].confidence;
  let className = detections[0].class_name;

  let minHeadingOffset = 0 - detections[0].angularWidth / 2;
  let maxHeadingOffset = 0 + detections[0].angularWidth / 2;
  const detectionDepths = [];

  for (let i = 1; i < detections.length; i += 1) {
    const det = detections[i];
    const headingDelta = signedAngleDeltaDegrees(det.heading, heading);
    minHeadingOffset = Math.min(
      minHeadingOffset,
      headingDelta - det.angularWidth / 2,
    );
    maxHeadingOffset = Math.max(
      maxHeadingOffset,
      headingDelta + det.angularWidth / 2,
    );
    minPitch = Math.min(minPitch, det.pitch - det.angularHeight / 2);
    maxPitch = Math.max(maxPitch, det.pitch + det.angularHeight / 2);

    const spanCenterOffset = (minHeadingOffset + maxHeadingOffset) / 2;
    heading = normalizeBearingDegrees(heading + spanCenterOffset);
    minHeadingOffset -= spanCenterOffset;
    maxHeadingOffset -= spanCenterOffset;
    pitch = (minPitch + maxPitch) / 2;
    if (det.confidence >= confidence) {
      confidence = det.confidence;
      className = det.class_name;
    }
    // Collect valid depths for aggregation (prefer calibrated, fallback to raw)
    const depthToUse = (Number.isFinite(det.depthCalibrated) && det.depthCalibrated > 0)
      ? det.depthCalibrated
      : det.depthAnythingMeters;
    if (Number.isFinite(depthToUse) && depthToUse > 0) {
      detectionDepths.push(depthToUse);
    }
  }

  // Also collect depth from the first detection (loop starts at i=1)
  const firstDepthToUse = (Number.isFinite(detections[0].depthCalibrated) && detections[0].depthCalibrated > 0)
    ? detections[0].depthCalibrated
    : detections[0].depthAnythingMeters;
  if (Number.isFinite(firstDepthToUse) && firstDepthToUse > 0) {
    detectionDepths.push(firstDepthToUse);
  }

  // Aggregate depth: use median of cluster members instead of detection[0] only
  // Median is robust to outlier depth estimates from different angular heights
  const mergedDepth = detectionDepths.length > 0
    ? median(detectionDepths)
    : null;

  const mergedAngularWidth = maxHeadingOffset - minHeadingOffset;
  const mergedAngularHeight = maxPitch - minPitch;
  const representativeHeights = normalizedDetections
    .map((det) => det.distanceAngularHeight)
    .filter((value) => Number.isFinite(value) && value > 0);
  const representativeWidths = normalizedDetections
    .map((det) => det.distanceAngularWidth)
    .filter((value) => Number.isFinite(value) && value > 0);
  const { outlierIndices: heightOutlierIndices, consensusMedian } =
    partitionConsensusOutliers(representativeHeights);
  const representativeHeight = consensusMedian ?? mergedAngularHeight;
  const representativeWidth =
    median(representativeWidths) ?? mergedAngularWidth;
  const heightExpansion = mergedAngularHeight / Math.max(representativeHeight, 0.05);
  const widthExpansion = mergedAngularWidth / Math.max(representativeWidth, 0.05);
  const mergeStackFactor = clamp(
    (heightExpansion - widthExpansion - MERGED_DISTANCE_HEIGHT_BIAS_FLOOR) /
      MERGED_DISTANCE_HEIGHT_BIAS_RANGE,
    0,
    1,
  );
  const distanceAngularHeight =
    mergedAngularHeight * (1 - mergeStackFactor) +
    representativeHeight * mergeStackFactor;

  // Map representativeHeights indices back to normalizedDetections indices
  const heightSourceIndex = [];
  normalizedDetections.forEach((det, i) => {
    if (Number.isFinite(det.distanceAngularHeight) && det.distanceAngularHeight > 0) {
      heightSourceIndex.push(i);
    }
  });
  const outlierDetectionIndices = new Set(heightOutlierIndices.map((k) => heightSourceIndex[k]));

  // Normalize sign count by height ratio: physical_height / standard_height (0.45m)
  // When depth is available, compute physical height from angular height + distance.
  // When depth is unavailable, count each detection as 1 (no normalization possible).
  const normalizedSignCount = normalizedDetections.reduce((sum, det, idx) => {
    if (outlierDetectionIndices.has(idx)) return sum;
    if (det.depthAnythingMeters > 0 && det.angularHeight > 0) {
      const angularHeightRad = (det.angularHeight * Math.PI) / 180;
      const physicalHeightMeters = det.depthAnythingMeters * Math.tan(angularHeightRad);
      const heightNormalizationFactor = physicalHeightMeters / PARKING_SIGN_FACE_HEIGHT_METERS;
      // Discard sub-11cm detections (< 0.25 normalized) as likely false positives
      if (heightNormalizationFactor < 0.25) {
        return sum;
      }
      return sum + heightNormalizationFactor;
    }
    return sum + (det.sourceDetections || 1);
  }, 0);

  // Re-infer referenceHeightCm from merged angular dimensions
  const { referenceHeightCm } = inferSignClusterHeight(
    mergedAngularHeight,
    mergedAngularWidth,
    normalizedDetections.length,
  );

  return normalizeAngularDetection({
    heading,
    pitch,
    angularWidth: mergedAngularWidth,
    angularHeight: mergedAngularHeight,
    confidence,
    class_name: className,
    depthAnythingMeters: mergedDepth ?? detections[0].depthAnythingMeters,
    depthAnythingMetersRaw: detections[0].depthAnythingMetersRaw,
    sourceDetections: normalizedSignCount,
    sourceMedianAngularHeight: representativeHeight,
    sourceMedianAngularWidth: representativeWidth,
    distanceAngularHeight,
    distanceAngularWidth: representativeWidth,
    mergeStackFactor,
    referenceHeightCm,
    tileX1: tileXs1.length ? Math.min(...tileXs1) : undefined,
    tileY1: tileYs1.length ? Math.min(...tileYs1) : undefined,
    tileX2: tileXs2.length ? Math.max(...tileXs2) : undefined,
    tileY2: tileYs2.length ? Math.max(...tileYs2) : undefined,
  });
}

function shouldClusterAngularDetections(a, b) {
  const headingDelta = Math.abs(signedAngleDeltaDegrees(a.heading, b.heading));
  const pitchDelta = Math.abs(a.pitch - b.pitch);

  const combinedHalfWidth = (a.angularWidth + b.angularWidth) / 2;
  const combinedHalfHeight = (a.angularHeight + b.angularHeight) / 2;

  const headingGap = Math.max(0, headingDelta - combinedHalfWidth);
  const pitchGap = Math.max(0, pitchDelta - combinedHalfHeight);

  const allowedHeadingGap =
    Math.max(a.angularWidth, b.angularWidth) * DETECTION_CLUSTER_WIDTH_RATIO +
    DETECTION_CLUSTER_WIDTH_FLOOR;
  const allowedPitchGap =
    Math.max(a.angularHeight, b.angularHeight) * DETECTION_CLUSTER_HEIGHT_RATIO +
    DETECTION_CLUSTER_HEIGHT_FLOOR;

  const verticallyCompatible =
    headingGap <= allowedHeadingGap && pitchGap <= allowedPitchGap;
  const horizontallyCompatible =
    pitchGap <= Math.max(a.angularHeight, b.angularHeight) * 0.8 + 0.35 &&
    headingGap <=
      Math.max(a.angularWidth, b.angularWidth) * 1.8 +
        DETECTION_CLUSTER_WIDTH_FLOOR;

  const directOverlap =
    headingDelta <= combinedHalfWidth && pitchDelta <= combinedHalfHeight;

  return directOverlap || verticallyCompatible || horizontallyCompatible;
}

function clusterAngularDetections(detections) {
  if (!Array.isArray(detections) || detections.length === 0) {
    return [];
  }

  if (detections.length === 1) {
    return detections.map(normalizeAngularDetection);
  }

  const remaining = [...detections].sort((a, b) => b.confidence - a.confidence);
  const clusters = [];

  while (remaining.length > 0) {
    const seed = remaining.shift();
    const cluster = [seed];
    let changed = true;

    while (changed) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (
          cluster.some((existing) =>
            shouldClusterAngularDetections(existing, remaining[i]),
          )
        ) {
          cluster.push(remaining[i]);
          remaining.splice(i, 1);
          changed = true;
        }
      }
    }

    clusters.push(mergeAngularDetections(cluster));
  }

  return clusters
    .sort((a, b) => b.confidence - a.confidence)
    .map(normalizeAngularDetection);
}

/**
 * Build Street View Static API URL.
 */
function getStreetViewImageUrl(
  panoId,
  heading,
  pitch = 0,
  fov = 90,
  width = 640,
  height = 640,
) {
  const apiKey = window.GOOGLE_CONFIG?.API_KEY;
  if (!apiKey) {
    throw new Error("Google API key not configured");
  }

  return (
    `https://maps.googleapis.com/maps/api/streetview?` +
    `size=${width}x${height}` +
    `&pano=${panoId}` +
    `&heading=${heading}` +
    `&pitch=${pitch}` +
    `&fov=${fov}` +
    `&key=${apiKey}`
  );
}

/**
 * Run detection on a Street View image.
 */
async function runDetection(imageUrl, confidence = null) {
  const apiUrl = window.DETECTION_CONFIG?.API_URL;
  if (!apiUrl) {
    throw new Error("Detection API URL not configured");
  }

  const conf =
    confidence ?? window.DETECTION_CONFIG?.CONFIDENCE_THRESHOLD ?? 0.15;

  let resp;
  try {
    resp = await fetch(`${apiUrl}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrl,
        confidence: conf,
      }),
    });
  } catch (err) {
    console.error("Detection request failed:", err);
    throw new Error(`Can't reach detection API. Make sure backend is running.`);
  }

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Detection failed: ${resp.status} - ${errorText}`);
  }

  return resp.json();
}

/**
 * Convert pixel coordinates in an image to angular coordinates.
 * Uses proper 3D vector-based gnomonic projection.
 * This is essentially the same as screenToAngular but for detection images.
 */
function pixelToAngular(x, y, povHeading, povPitch, hFov, imgWidth, imgHeight) {
  // Delegate to screenToAngular since it's the same math
  return screenToAngular(x, y, povHeading, povPitch, hFov, imgWidth, imgHeight);
}

/**
 * Convert detection box to angular coordinates.
 * Uses proper 3D vector-based gnomonic projection for accurate coordinate conversion.
 */
function detectionToAngular(
  det,
  povHeading,
  povPitch,
  hFov,
  imgWidth,
  imgHeight,
) {
  const centerX = (det.x1 + det.x2) / 2;
  const centerY = (det.y1 + det.y2) / 2;

  // Get angular position of detection center using proper 3D projection
  const centerAngular = screenToAngular(
    centerX,
    centerY,
    povHeading,
    povPitch,
    hFov,
    imgWidth,
    imgHeight,
  );

  // Get angular positions of the four corners for accurate angular dimensions
  const topLeft = screenToAngular(
    det.x1,
    det.y1,
    povHeading,
    povPitch,
    hFov,
    imgWidth,
    imgHeight,
  );
  const topRight = screenToAngular(
    det.x2,
    det.y1,
    povHeading,
    povPitch,
    hFov,
    imgWidth,
    imgHeight,
  );
  const bottomLeft = screenToAngular(
    det.x1,
    det.y2,
    povHeading,
    povPitch,
    hFov,
    imgWidth,
    imgHeight,
  );
  const bottomRight = screenToAngular(
    det.x2,
    det.y2,
    povHeading,
    povPitch,
    hFov,
    imgWidth,
    imgHeight,
  );

  // Compute angular width from left and right edges
  // Use the average of top and bottom edge widths for robustness
  let topWidth = topRight.heading - topLeft.heading;
  let bottomWidth = bottomRight.heading - bottomLeft.heading;

  // Handle heading wrap-around
  if (topWidth > 180) topWidth -= 360;
  if (topWidth < -180) topWidth += 360;
  if (bottomWidth > 180) bottomWidth -= 360;
  if (bottomWidth < -180) bottomWidth += 360;

  const angularWidth = Math.abs((topWidth + bottomWidth) / 2);

  // Compute angular height from top and bottom edges
  // Use the average of left and right edge heights for robustness
  const leftHeight = topLeft.pitch - bottomLeft.pitch;
  const rightHeight = topRight.pitch - bottomRight.pitch;
  const angularHeight = Math.abs((leftHeight + rightHeight) / 2);

  return {
    heading: centerAngular.heading,
    pitch: centerAngular.pitch,
    angularWidth: angularWidth,
    angularHeight: angularHeight,
    confidence: det.confidence,
    class_name: det.class_name,
  };
}

/**
 * Convert heading/pitch to 3D unit direction vector.
 * Uses PanoMarker's coordinate system: +X = East, +Y = North, +Z = Up
 * This matches Google Street View's internal representation.
 */
function headingPitchToDirection(heading, pitch) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const headingRad = toRad(heading);
  const pitchRad = toRad(pitch);

  // Spherical to Cartesian conversion (PanoMarker convention)
  // At heading=0, pitch=0: direction is (0, 1, 0) = North
  // At heading=90, pitch=0: direction is (1, 0, 0) = East
  // At heading=0, pitch=90: direction is (0, 0, 1) = Up
  const cosPitch = Math.cos(pitchRad);
  return {
    x: cosPitch * Math.sin(headingRad),
    y: cosPitch * Math.cos(headingRad),
    z: Math.sin(pitchRad),
  };
}

/**
 * Project a world direction to screen coordinates.
 * Based on PanoMarker's povToPixel3d which is known to work with Google Street View.
 * Returns null if the point is behind the camera.
 */
function directionToScreen(
  worldDir,
  povHeading,
  povPitch,
  fov,
  screenWidth,
  screenHeight,
) {
  const toRad = (deg) => (deg * Math.PI) / 180;

  const h0 = toRad(povHeading);
  const p0 = toRad(povPitch);
  const cos_p0 = Math.cos(p0);
  const sin_p0 = Math.sin(p0);
  const cos_h0 = Math.cos(h0);
  const sin_h0 = Math.sin(h0);

  // Focal length (distance from camera to image plane)
  const f = screenWidth / 2 / Math.tan(toRad(fov / 2));

  // Current POV center in 3D (this defines the image plane normal)
  const x0 = f * cos_p0 * sin_h0;
  const y0 = f * cos_p0 * cos_h0;
  const z0 = f * sin_p0;

  // Target direction scaled by focal length
  // worldDir is now in PanoMarker's coordinate system (x=east, y=north, z=up)
  const x = f * worldDir.x;
  const y = f * worldDir.y;
  const z = f * worldDir.z;

  // Check if target is in front of camera using dot product
  const nDotD = x0 * x + y0 * y + z0 * z;
  const nDotC = x0 * x0 + y0 * y0 + z0 * z0; // = f^2

  // Point is behind camera if dot product is <= 0
  if (nDotD <= 0) return null;

  // Scale factor to intersect with image plane
  const t = nDotC / nDotD;

  // Intersection point on image plane
  const tx = t * x;
  const ty = t * y;
  const tz = t * z;

  // Image plane basis vectors (from PanoMarker)
  // u = horizontal (heading direction), v = vertical (pitch direction)
  const ux = cos_h0;
  const uy = -sin_h0;
  const uz = 0;

  const vx = -sin_p0 * sin_h0;
  const vy = -sin_p0 * cos_h0;
  const vz = cos_p0;

  // Project intersection point onto image plane basis
  const du = (tx - x0) * ux + (ty - y0) * uy + (tz - z0) * uz;
  const dv = (tx - x0) * vx + (ty - y0) * vy + (tz - z0) * vz;

  // Convert to screen coordinates
  const screenX = screenWidth / 2 + du;
  const screenY = screenHeight / 2 - dv;

  return { x: screenX, y: screenY };
}

/**
 * Convert angular detection back to screen coordinates using proper 3D gnomonic projection.
 */
function angularToScreen(
  angularDet,
  currentHeading,
  currentPitch,
  currentFov,
  screenWidth,
  screenHeight,
) {
  // Convert detection center to 3D direction
  const centerDir = headingPitchToDirection(
    angularDet.heading,
    angularDet.pitch,
  );

  // Project to screen
  const centerScreen = directionToScreen(
    centerDir,
    currentHeading,
    currentPitch,
    currentFov,
    screenWidth,
    screenHeight,
  );
  if (!centerScreen) return null;

  // For the bounding box, we need to project the corners
  const halfAngW = angularDet.angularWidth / 2;
  const halfAngH = angularDet.angularHeight / 2;

  // Project the four corners of the angular bounding box
  const topLeftDir = headingPitchToDirection(
    angularDet.heading - halfAngW,
    angularDet.pitch + halfAngH,
  );
  const topRightDir = headingPitchToDirection(
    angularDet.heading + halfAngW,
    angularDet.pitch + halfAngH,
  );
  const bottomLeftDir = headingPitchToDirection(
    angularDet.heading - halfAngW,
    angularDet.pitch - halfAngH,
  );
  const bottomRightDir = headingPitchToDirection(
    angularDet.heading + halfAngW,
    angularDet.pitch - halfAngH,
  );

  const topLeft = directionToScreen(
    topLeftDir,
    currentHeading,
    currentPitch,
    currentFov,
    screenWidth,
    screenHeight,
  );
  const topRight = directionToScreen(
    topRightDir,
    currentHeading,
    currentPitch,
    currentFov,
    screenWidth,
    screenHeight,
  );
  const bottomLeft = directionToScreen(
    bottomLeftDir,
    currentHeading,
    currentPitch,
    currentFov,
    screenWidth,
    screenHeight,
  );
  const bottomRight = directionToScreen(
    bottomRightDir,
    currentHeading,
    currentPitch,
    currentFov,
    screenWidth,
    screenHeight,
  );

  // If any corner is behind the camera, skip this detection
  if (!topLeft || !topRight || !bottomLeft || !bottomRight) return null;

  // Compute bounding box from projected corners
  const minX = Math.min(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
  const maxX = Math.max(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
  const minY = Math.min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);
  const maxY = Math.max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);

  const width = maxX - minX;
  const height = maxY - minY;

  // Check if box is visible on screen
  if (maxX < 0 || minX > screenWidth) return null;
  if (maxY < 0 || minY > screenHeight) return null;

  return {
    x: minX,
    y: minY,
    width,
    height,
    confidence: angularDet.confidence,
    class_name: angularDet.class_name,
  };
}

// Track mouse position for sign marking (document-level to work over bounding boxes)
let lastMouseX = 0;
let lastMouseY = 0;
let lastMouseClientX = 0;
let lastMouseClientY = 0;

function trackMousePosition(event) {
  // Store client coordinates - we'll convert to container-relative when needed
  lastMouseClientX = event.clientX;
  lastMouseClientY = event.clientY;

  const container = document.getElementById("detectionPanorama");
  if (!container) return;
  const rect = container.getBoundingClientRect();
  lastMouseX = event.clientX - rect.left;
  lastMouseY = event.clientY - rect.top;
}

/**
 * Convert screen pixel position to angular coordinates (heading/pitch).
 * This is the inverse of PanoMarker's povToPixel3d function.
 * Uses proper 3D vector-based gnomonic projection matching Google Street View.
 */
function screenToAngular(
  screenX,
  screenY,
  povHeading,
  povPitch,
  fov,
  screenWidth,
  screenHeight,
) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const toDeg = (rad) => (rad * 180) / Math.PI;

  const h0 = toRad(povHeading);
  const p0 = toRad(povPitch);
  const cos_p0 = Math.cos(p0);
  const sin_p0 = Math.sin(p0);
  const cos_h0 = Math.cos(h0);
  const sin_h0 = Math.sin(h0);

  // Focal length (must match directionToScreen)
  const f = screenWidth / 2 / Math.tan(toRad(fov / 2));

  // Convert screen to pixel offsets from center
  const du = screenX - screenWidth / 2;
  const dv = screenHeight / 2 - screenY; // Flip Y

  // Current POV center in PanoMarker's 3D coordinate system
  // (x = east, y = north/forward, z = up)
  const x0 = f * cos_p0 * sin_h0;
  const y0 = f * cos_p0 * cos_h0;
  const z0 = f * sin_p0;

  // Image plane basis vectors (from PanoMarker)
  const ux = cos_h0;
  const uy = -sin_h0;
  const uz = 0;

  const vx = -sin_p0 * sin_h0;
  const vy = -sin_p0 * cos_h0;
  const vz = cos_p0;

  // Calculate the 3D point on the image plane
  const x = x0 + du * ux + dv * vx;
  const y = y0 + du * uy + dv * vy;
  const z = z0 + du * uz + dv * vz;

  // Convert to heading/pitch (PanoMarker's coordinate system)
  // In PanoMarker: heading = atan2(x, y), pitch = asin(z / R)
  const R = Math.sqrt(x * x + y * y + z * z);
  const heading = toDeg(Math.atan2(x, y));
  const pitch = toDeg(Math.asin(Math.max(-1, Math.min(1, z / R))));

  // Normalize heading to [0, 360)
  const normalizedHeading = ((heading % 360) + 360) % 360;

  return {
    heading: normalizedHeading,
    pitch: pitch,
  };
}

// Calibration marking state: alternates between marking post base and bbox bottom
/**
 * Convert heading/pitch to tile pixel coordinates with tilt correction.
 *
 * Uses a proper 3D rotation to account for camera tilt in the equirectangular
 * tile grid. The camera's physical tilt is compensated by rotating the world
 * direction vector into the camera's local frame and then applying the inverse
 * tilt rotation.
 */
function headingPitchToPixelCorrected(
  heading,
  pitch,
  imageWidth,
  imageHeight,
  panoHeading = 0,
  tilt = 90,
) {
  const deg2rad = Math.PI / 180;
  const rad2deg = 180 / Math.PI;

  // 1. World (heading, pitch) → 3D direction vector (x=east, y=north, z=up)
  const hRad = heading * deg2rad;
  const pRad = pitch * deg2rad;
  const cosP = Math.cos(pRad);
  const dx = cosP * Math.sin(hRad);
  const dy = cosP * Math.cos(hRad);
  const dz = Math.sin(pRad);

  // 2. Camera-local frame (rotate by -panoHeading around Z)
  const phRad = panoHeading * deg2rad;
  const cosPh = Math.cos(phRad);
  const sinPh = Math.sin(phRad);
  const localX = dx * cosPh - dy * sinPh; // right
  const localY = dx * sinPh + dy * cosPh; // forward
  const localZ = dz; // up

  // 3. Inverse tilt rotation (rotate by alpha around X/right axis)
  //    alpha = tilt - 90: positive = camera looks down
  const alpha = (tilt - 90) * deg2rad;
  const cosA = Math.cos(alpha);
  const sinA = Math.sin(alpha);
  const stabX = localX;
  const stabY = cosA * localY + sinA * localZ;
  const stabZ = -sinA * localY + cosA * localZ;

  // 4. Stabilized direction → equirectangular pixels
  const stabRelHDeg = Math.atan2(stabX, stabY) * rad2deg;
  const stabPitchDeg = Math.asin(Math.max(-1, Math.min(1, stabZ))) * rad2deg;

  const x = ((stabRelHDeg + 180) / 360) * imageWidth;
  const y = ((90 - stabPitchDeg) / 180) * imageHeight;

  // yCorrection = difference from uncorrected position (for diagnostics)
  const yBase = ((90 - pitch) / 180) * imageHeight;
  const yCorrection = y - yBase;

  return { x, y, yCorrection };
}




/**
 * Render depth measurement overlay on the panorama SVG.
 * Shows calibration guide lines when in calibration mode.
 */
function renderDepthOverlay(overlay, pov, fov, screenWidth, screenHeight) {
  const SVG_NS = "http://www.w3.org/2000/svg";

  const mkLine = (x1, y1, x2, y2, color, width, dash) => {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", width);
    if (dash) line.setAttribute("stroke-dasharray", dash);
    line.classList.add("depth-overlay");
    return line;
  };

  const toScreen = (heading, pitch) => {
    const dir = headingPitchToDirection(heading, pitch);
    return directionToScreen(dir, pov.heading, pov.pitch, fov, screenWidth, screenHeight);
  };

  // Debug distance rings
  renderDebugDistanceRings(overlay, pov, fov, screenWidth, screenHeight);
}
/**
 * Draw OCR text label on panorama overlay for a detection.
 * Shows rule categories and key info (time, limit) on multiple lines.
 */
function drawOcrTextOnOverlay(overlay, x, y, width, height, ocrResult, overlayHeight) {
  const SVG_NS = "http://www.w3.org/2000/svg";

  if (!ocrResult?.is_parking_sign || !ocrResult.rules || ocrResult.rules.length === 0) {
    return;
  }

  // Draw up to 3 rule lines
  const lines = [];
  for (let i = 0; i < Math.min(3, ocrResult.rules.length); i++) {
    const rule = ocrResult.rules[i];
    if (!rule.category) continue;
    let text = rule.category.replace(/_/g, " ").toUpperCase();
    if (rule.time_limit_minutes) text += ` ${rule.time_limit_minutes}m`;
    lines.push(text);
  }

  if (ocrResult.tow_zones?.length > 0) {
    lines[0] = "⚠️ TOW ZONE";
  }

  const LINE_HEIGHT = 14;
  const totalTextHeight = lines.length * LINE_HEIGHT;
  const textX = x + width / 2;

  // Position below box; if off-screen, try above box
  let textY = y + height + LINE_HEIGHT;
  if (textY + totalTextHeight > overlayHeight) {
    textY = y - totalTextHeight;
  }
  // Skip if no room above either
  if (textY < 0) return;

  lines.forEach((line, idx) => {
    // Background rect for readability
    const bgRect = document.createElementNS(SVG_NS, "rect");
    bgRect.setAttribute("x", textX - 55);
    bgRect.setAttribute("y", textY + idx * LINE_HEIGHT - LINE_HEIGHT + 2);
    bgRect.setAttribute("width", "110");
    bgRect.setAttribute("height", String(LINE_HEIGHT));
    bgRect.setAttribute("fill", "rgba(0,0,0,0.7)");
    bgRect.setAttribute("rx", "2");
    overlay.appendChild(bgRect);

    const textEl = document.createElementNS(SVG_NS, "text");
    textEl.setAttribute("x", textX);
    textEl.setAttribute("y", textY + idx * LINE_HEIGHT);
    textEl.setAttribute("fill", "#fff");
    textEl.setAttribute("font-size", "11");
    textEl.setAttribute("font-family", "Arial");
    textEl.setAttribute("text-anchor", "middle");
    textEl.setAttribute("font-weight", "bold");
    textEl.textContent = line;
    overlay.appendChild(textEl);
  });
}

/**
 * Update SVG overlay with detection boxes.
 */
function updateDetectionOverlay() {
  const overlay = document.getElementById("detectionOverlay");
  if (!overlay || !detectionPanorama) return;

  const pov = detectionPanorama.getPov();
  const container = document.getElementById("detectionPanorama");
  const width = container.clientWidth;
  const height = container.clientHeight;
  const fov = zoomToFov(pov.zoom || 1);
  overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
  overlay.setAttribute("preserveAspectRatio", "none");

  // Clear existing boxes (but keep markers)
  overlay.querySelectorAll(":not(.sign-marker)").forEach((el) => el.remove());

  renderDepthOverlay(overlay, pov, fov, width, height);
  renderPanoramaLinkSpotsOverlay(overlay, pov, fov, width, height);

  // Draw each detection if visible
  for (const det of currentDetections) {
    const screen =
      tileDetectionToScreen(det, width, height) ||
      angularToScreen(
        det,
        pov.heading,
        pov.pitch,
        fov,
        width,
        height,
      );
    if (!screen) continue;

    // Color based on confidence
    const hue = det.confidence * 120;
    const color = `hsl(${hue}, 100%, 50%)`;

    // Create clickable rect
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", screen.x);
    rect.setAttribute("y", screen.y);
    rect.setAttribute("width", screen.width);
    rect.setAttribute("height", screen.height);
    rect.setAttribute("fill", "rgba(255, 255, 255, 0.1)");
    rect.setAttribute("stroke", color);
    rect.setAttribute("stroke-width", "3");
    rect.style.cursor = "pointer";
    rect.style.transition = "all 0.15s ease";
    rect.style.pointerEvents = "auto";

    // Hover effects
    rect.addEventListener("mouseenter", () => {
      rect.setAttribute("stroke-width", "5");
      rect.setAttribute("fill", "rgba(255, 255, 255, 0.3)");
      rect.style.filter = "drop-shadow(0 0 8px rgba(255, 255, 255, 0.8))";
    });
    rect.addEventListener("mouseleave", () => {
      rect.setAttribute("stroke-width", "3");
      rect.setAttribute("fill", "rgba(255, 255, 255, 0.1)");
      rect.style.filter = "none";
    });

    // Click to show OCR modal or save sign
    rect.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();

      const containerRect = container.getBoundingClientRect();
      const clickX = e.clientX - containerRect.left;
      const clickY = e.clientY - containerRect.top;

      // Show OCR modal if available
      if (det.ocrResult) {
        showOcrModal(det.ocrResult, e.clientX, e.clientY);
        return;
      }

      // Otherwise, save sign
      const clickPixel = screenToPanoPixelPoint(clickX, clickY);
      const clickAngular = pixelToHeadingPitch(
        normalizePanoPixelX(clickPixel.x),
        clickPixel.y,
        TILE_GRID_WIDTH,
        TILE_GRID_HEIGHT,
        detectionPanorama?._panoHeading || 0,
      );

      cropAndSaveSign(det, {
        heading: clickAngular.heading,
        pitch: clickAngular.pitch,
        screenX: clickX,
        screenY: clickY,
      });
    });
    rect.addEventListener("mousedown", (e) => e.stopPropagation());
    rect.addEventListener("mouseup", (e) => e.stopPropagation());
    overlay.appendChild(rect);

    // Draw OCR text if available
    if (det.ocrResult?.is_parking_sign) {
      try {
        drawOcrTextOnOverlay(
          overlay,
          screen.x,
          screen.y,
          screen.width,
          screen.height,
          det.ocrResult,
          height
        );
      } catch (e) {
        console.warn("drawOcrTextOnOverlay failed:", e);
      }
    }

    // Create label — show depth, physical size, aspect ratio
    const depthLabel = det.depthAnythingMeters
      ? ` | ${det.depthAnythingMeters.toFixed(1)}m`
      : "";
    let sizeLabel = "";
    if (det.referenceHeightCm && det.angularHeight && det.angularWidth) {
      const aspectRatio = det.angularHeight / det.angularWidth;
      const physicalWidthCm = Math.round(det.referenceHeightCm / aspectRatio);
      const physicalHeightCm = Math.round(det.referenceHeightCm);
      sizeLabel = ` | ${physicalHeightCm}×${physicalWidthCm}cm (${aspectRatio.toFixed(2)})`;
    }
    const label = `${det.class_name} ${Math.round(det.confidence * 100)}%${depthLabel}${sizeLabel}`;

    // Position label above box if there's room, otherwise flip below
    const labelAbove = screen.y >= 22;
    const bgY = labelAbove ? screen.y - 20 : screen.y + screen.height + 2;
    const textY = labelAbove ? screen.y - 6 : screen.y + screen.height + 14;

    const labelBg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    labelBg.setAttribute("x", screen.x);
    labelBg.setAttribute("y", bgY);
    labelBg.setAttribute("width", label.length * 7.5 + 10);
    labelBg.setAttribute("height", "18");
    labelBg.setAttribute("fill", "white");
    overlay.appendChild(labelBg);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", screen.x + 4);
    text.setAttribute("y", textY);
    text.setAttribute("fill", "black");
    text.setAttribute("font-size", "12");
    text.setAttribute("font-weight", "bold");
    text.textContent = label;
    overlay.appendChild(text);
  }
}

function renderPanoramaLinkSpotsOverlay(overlay, pov, fov, width, height) {
  if (!overlay || !detectionPanorama) return;

  const currentPanoId = detectionPanorama.getPano?.();
  const cameraPosition = detectionPanorama.getPosition?.();
  const cameraLat = cameraPosition?.lat?.();
  const cameraLng = cameraPosition?.lng?.();
  if (!currentPanoId || !Number.isFinite(cameraLat) || !Number.isFinite(cameraLng)) {
    return;
  }

  const links = detectionPanorama.getLinks?.() || [];
  let rendered = 0;

  for (const link of links) {
    if (!link?.pano) {
      continue;
    }
    if (rendered >= PANORAMA_LINK_SPOT_MAX_VISIBLE) {
      break;
    }

    const linkSpot = getCachedPanoramaLinkSpotPosition(currentPanoId, link.pano);
    if (!linkSpot) {
      requestPanoramaLinkSpotPosition(currentPanoId, link);
      continue;
    }

    const linkHeading = bearingBetweenPoints(
      cameraLat,
      cameraLng,
      linkSpot.lat,
      linkSpot.lng,
    );
    const linkPx = headingPitchToPixel(
      linkHeading,
      0,
      TILE_GRID_WIDTH,
      TILE_GRID_HEIGHT,
      detectionPanorama?._panoHeading || 0,
    );
    const screen = panoPixelToScreenPoint(linkPx.x, linkPx.y);
    if (!screen) {
      continue;
    }

    const withinViewport =
      screen.x >= -PANORAMA_LINK_SPOT_RADIUS_PX &&
      screen.x <= width + PANORAMA_LINK_SPOT_RADIUS_PX &&
      screen.y >= -PANORAMA_LINK_SPOT_RADIUS_PX &&
      screen.y <= height + PANORAMA_LINK_SPOT_RADIUS_PX;
    if (!withinViewport) {
      continue;
    }

    const spot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    spot.setAttribute("cx", screen.x.toFixed(2));
    spot.setAttribute("cy", screen.y.toFixed(2));
    spot.setAttribute("r", PANORAMA_LINK_SPOT_RADIUS_PX.toFixed(2));
    spot.setAttribute("fill", "rgba(156, 163, 175, 0.7)");
    spot.setAttribute("stroke", "rgba(55, 65, 81, 0.95)");
    spot.setAttribute("stroke-width", "2");
    spot.style.pointerEvents = "auto";
    spot.style.cursor = "pointer";
    spot.setAttribute("role", "button");
    spot.setAttribute(
      "aria-label",
      `Jump to linked panorama ${link.description || link.pano}`,
    );
    spot.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const currentPov = detectionPanorama.getPov?.() || {};
      const nextHeading = Number.isFinite(link.heading)
        ? normalizeBearingDegrees(link.heading)
        : Number.isFinite(currentPov.heading)
          ? normalizeBearingDegrees(currentPov.heading)
          : 0;
      detectionPanorama.setPano(link.pano);
      detectionPanorama.setPov({
        heading: nextHeading,
        pitch: Number.isFinite(currentPov.pitch) ? currentPov.pitch : 0,
        zoom: Number.isFinite(currentPov.zoom) ? currentPov.zoom : PANORAMA_DEFAULTS.zoom,
      });

      if (typeof currentDetectionContext === "object" && currentDetectionContext) {
        currentDetectionContext =
          typeof buildPanoramaNavigationContext === "function"
            ? buildPanoramaNavigationContext(
                link.pano,
                nextHeading,
                link.description || currentDetectionContext.streetName,
              )
            : {
                ...currentDetectionContext,
                panoId: link.pano,
                heading: nextHeading,
                pointIndex: null,
                streetName:
                  link.description ||
                  currentDetectionContext.streetName ||
                  "Unknown street",
              };
      }
      if (typeof updateDetectionInfoText === "function") {
        updateDetectionInfoText();
      }
    });
    overlay.appendChild(spot);
    rendered += 1;
  }
}

function getPanoramaLinkSpotCacheKey(currentPanoId, linkPanoId) {
  return `${currentPanoId}::${linkPanoId}`;
}

function getCachedPanoramaLinkSpotPosition(currentPanoId, linkPanoId) {
  const key = getPanoramaLinkSpotCacheKey(currentPanoId, linkPanoId);
  return panoramaLinkSpotPositionCache.get(key) || null;
}

function cachePanoramaLinkSpotPosition(currentPanoId, linkPanoId, position) {
  const key = getPanoramaLinkSpotCacheKey(currentPanoId, linkPanoId);
  panoramaLinkSpotPositionCache.set(key, position);
}

function requestPanoramaLinkSpotPosition(currentPanoId, link) {
  const key = getPanoramaLinkSpotCacheKey(currentPanoId, link.pano);
  if (panoramaLinkSpotRequestsInFlight.has(key)) {
    return;
  }
  panoramaLinkSpotRequestsInFlight.add(key);
  const panoramaRequest =
    typeof resolveStreetViewPanorama === "function"
      ? resolveStreetViewPanorama({ pano: link.pano }, 5000)
      : typeof google?.maps?.StreetViewService === "function"
        ? Promise.resolve(new google.maps.StreetViewService().getPanorama({ pano: link.pano }))
            .then((response) => response?.data || response || null)
            .catch(() => null)
        : Promise.resolve(null);

  panoramaRequest
    .then((response) => {
      const latLng = response?.location?.latLng;
      const lat = latLng?.lat?.();
      const lng = latLng?.lng?.();
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }
      cachePanoramaLinkSpotPosition(currentPanoId, link.pano, { lat, lng });
    })
    .catch((err) => {
      console.warn("Failed to resolve linked panorama position:", err);
    })
    .finally(() => {
      panoramaLinkSpotRequestsInFlight.delete(key);
      if (detectionPanorama?.getPano?.() === currentPanoId) {
        updateDetectionOverlay();
      }
    });
}

/**
 * Initialize or update the detection panorama.
 */
function initDetectionPanorama(panoId, heading, container) {
  const pov = getDefaultPov(heading);

  if (detectionPanorama) {
    Promise.resolve(detectionPanorama.setPano(panoId)).catch((err) => {
      console.error("Failed to update tile panorama:", err);
    });
    detectionPanorama.setPov(pov);
  } else {
    detectionPanorama = new TileViewer(container, { pov });

    if (!detectionOverlayResizeObserver) {
      detectionOverlayResizeObserver =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => {
              scheduleDetectionOverlayUpdate();
            })
          : null;
      detectionOverlayResizeObserver?.observe(container);

      const handleWindowResize = () => {
        scheduleDetectionOverlayUpdate();
      };
      window.addEventListener("resize", handleWindowResize);
      detectionOverlayResizeCleanup = () => {
        window.removeEventListener("resize", handleWindowResize);
      };
    }

    povChangeListener = detectionPanorama.addListener(
      "pov_changed",
      () => {
        updateDetectionOverlay();
        if (typeof updateDetectionInfoText === "function") {
          updateDetectionInfoText();
        }
        if (typeof updateHeadingArrowOnMap === "function") {
          updateHeadingArrowOnMap();
        }
      },
    );
    panoChangeListener = detectionPanorama.addListener(
      "pano_changed",
      () => {
        clearDetections();
        if (typeof syncPanoramaCaptureSpotsOnMap === "function") {
          Promise.resolve(syncPanoramaCaptureSpotsOnMap()).catch((err) => {
            console.warn("Failed to sync panorama spots after pano change:", err);
          });
        }
        if (typeof updateHeadingArrowOnMap === "function") {
          updateHeadingArrowOnMap();
        }
      },
    );
    positionChangeListener = detectionPanorama.addListener(
      "position_changed",
      () => {
        updateDetectionOverlay();
        if (typeof syncPanoramaCaptureSpotsOnMap === "function") {
          Promise.resolve(syncPanoramaCaptureSpotsOnMap()).catch((err) => {
            console.warn("Failed to sync panorama spots after position change:", err);
          });
        }
        if (typeof updateHeadingArrowOnMap === "function") {
          updateHeadingArrowOnMap();
        }
      },
    );

    // Remove old document-level listeners before adding new ones
    for (const { event, handler } of documentEventListeners) {
      document.removeEventListener(event, handler);
    }
    documentEventListeners.length = 0;

    // Track mouse position at document level (works over bounding boxes too)
    document.addEventListener("mousemove", trackMousePosition);
    documentEventListeners.push({ event: "mousemove", handler: trackMousePosition });
    document.addEventListener("keydown", handleMarkerKeyboard);
    documentEventListeners.push({ event: "keydown", handler: handleMarkerKeyboard });
  }

  Promise.resolve(detectionPanorama.setPano?.(panoId)).catch((err) => {
    console.error("Failed to set tile panorama:", err);
  });
  detectionPanorama.setPov(pov);
  currentDetections = [];
  updateDetectionOverlay();
}

/**
 * Handle keyboard shortcuts for marker management.
 */
function handleMarkerKeyboard(event) {
  if (event.key === "Escape") {
    clearMarkedPoints();
    const statusEl = document.getElementById("detectionStatus");
    if (statusEl) statusEl.textContent = "Calibration markers cleared.";
  }
}

/**
 * Clear current detections.
 */
function clearDetections() {
  currentDetections = [];
  ocrResults.clear();
  updateDetectionOverlay();

  const statusEl = document.getElementById("detectionStatus");
  if (statusEl) {
    statusEl.textContent =
      'Panorama changed. Click "Detect" to scan for parking signs';
  }
}

/**
 * Run detection on a single panorama view.
 */
function isTileDetectionInViewport(det, viewportRect) {
  if (!viewportRect) return true;
  const centerX = (det.tileX1 + det.tileX2) / 2;
  const centerY = (det.tileY1 + det.tileY2) / 2;
  const dx = wrapPixelDelta(centerX - viewportRect.centerX, TILE_GRID_WIDTH);
  const dy = centerY - viewportRect.centerY;
  return Math.abs(dx) <= viewportRect.width / 2 && Math.abs(dy) <= viewportRect.height / 2;
}

function mapTileDetection(det) {
  return {
    heading: det.heading,
    pitch: det.pitch,
    angularWidth: det.angular_width,
    angularHeight: det.angular_height,
    confidence: det.confidence,
    class_name: det.class_name,
    depthAnythingMeters: det.depth_anything_meters,
    depthAnythingMetersRaw: det.depth_anything_meters_raw,
    depthCalibrated: det.depth_calibrated,
    inferredPanelLayout: det.inferred_panel_layout,
    referenceHeightCm: det.reference_height_cm,
    pixelSize: det.pixel_size,
    sizeCorrection: det.size_correction,
    tileX1: det.full_pano_x1,
    tileY1: det.full_pano_y1,
    tileX2: det.full_pano_x2,
    tileY2: det.full_pano_y2,
  };
}

async function runSinglePanoApiDetection(panoId, heading, pitch, fov, statusEl) {
  const apiUrl = window.DETECTION_CONFIG?.API_URL;
  const apiKey = window.GOOGLE_CONFIG?.API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("Detection API or Google API key not configured");
  }

  const conf = window.DETECTION_CONFIG?.CONFIDENCE_THRESHOLD ?? 0.15;

  if (statusEl) {
    statusEl.textContent = "Detecting parking signs...";
  }

  const session = await getSessionToken();
  const metadata = await fetchStreetViewMetadata(panoId, session);
  const panoHeading = metadata?.heading || 0;
  const container = document.getElementById("detectionPanorama");
  const canvasWidth = container?.clientWidth || 640;
  const canvasHeight = container?.clientHeight || 640;
  const center = headingPitchToPixel(
    heading,
    pitch,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    panoHeading,
  );
  const viewportRect = {
    centerX: center.x,
    centerY: center.y,
    width: (fov / 360) * TILE_GRID_WIDTH,
  };
  const horizonHalfBandDegrees = getDetectionHorizonHalfBandDegrees();
  const detectionBandCenterPitch = 0;
  const detectionBandTopPitch =
    detectionBandCenterPitch + horizonHalfBandDegrees;
  const detectionBandBottomPitch =
    detectionBandCenterPitch - horizonHalfBandDegrees;
  const topBandPoint = headingPitchToPixel(
    heading,
    detectionBandTopPitch,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    panoHeading,
  );
  const bottomBandPoint = headingPitchToPixel(
    heading,
    detectionBandBottomPitch,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    panoHeading,
  );
  const detectionBandY1 = Math.max(
    0,
    Math.min(topBandPoint.y, bottomBandPoint.y),
  );
  const detectionBandY2 = Math.min(
    TILE_GRID_HEIGHT - 1,
    Math.max(topBandPoint.y, bottomBandPoint.y),
  );
  const minTileX = Math.floor((viewportRect.centerX - viewportRect.width / 2) / TILE_SIZE);
  const maxTileX = Math.floor((viewportRect.centerX + viewportRect.width / 2) / TILE_SIZE);
  const minTileY = Math.max(0, Math.floor(detectionBandY1 / TILE_SIZE));
  const maxTileY = Math.min(15, Math.floor(detectionBandY2 / TILE_SIZE));
  const tiles = [];
  for (let ty = minTileY; ty <= maxTileY; ty += 1) {
    for (let tx = minTileX; tx <= maxTileX; tx += 1) {
      tiles.push({ x: tx, y: ty });
    }
  }

  let resp;
  try {
    resp = await fetch(`${apiUrl}/detect-tiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pano_id: panoId,
        tiles,
        tile_x1: minTileX,
        tile_y1: minTileY,
        session_token: session,
        api_key: apiKey,
        confidence: conf,
        request_heading: heading,
        request_pitch: pitch,
        request_fov: fov,
        viewport_width: canvasWidth,
        viewport_height: canvasHeight,
        detection_band_center_pitch: detectionBandCenterPitch,
        detection_band_half_height_degrees: horizonHalfBandDegrees,
        detection_band_top_pitch: detectionBandTopPitch,
        detection_band_bottom_pitch: detectionBandBottomPitch,
      }),
    });
  } catch (err) {
    console.error("Tile detection request failed:", err);
    throw new Error("Can't reach detection API. Make sure backend is running.");
  }

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Tile detection failed: ${resp.status} - ${errorText}`);
  }

  const result = await resp.json();
  const usageSummary = {
    panoId,
    heading,
    pitch,
    fov,
    requestedTiles: tiles.length,
    stitchedWidth: result?.stitched_width,
    stitchedHeight: result?.stitched_height,
    tileApiRequests: result?.tile_api_requests,
    detectionBand: {
      centerPitch: detectionBandCenterPitch,
      halfHeightDegrees: horizonHalfBandDegrees,
      topPitch: detectionBandTopPitch,
      bottomPitch: detectionBandBottomPitch,
    },
    viewport: { width: canvasWidth, height: canvasHeight },
  };
  console.info("[detect-tiles] usage", usageSummary);
  if (result?.debug_artifact) {
    console.info("[detect-tiles] debug artifact", {
      ...usageSummary,
      stitchedImageUrl: result.debug_artifact.image_url,
      metadataUrl: result.debug_artifact.metadata_url,
      tileImageUrls: result.debug_artifact.tile_image_urls,
    });
  }
  return {
    ...result,
    detections: (result.detections || []).map(mapTileDetection),
  };
}


/**
 * Run detection and display results on panorama.
 */
async function runDetectionOnPanorama(
  panoId,
  heading,
  statusEl,
  useCurrentPov = false,
) {
  let fov = 90;
  let pitch = PANORAMA_DEFAULTS.pitch;
  let detectHeading = heading;
  let detectPanoId = panoId;

  if (useCurrentPov && detectionPanorama) {
    const pov = detectionPanorama.getPov();
    detectHeading = pov.heading;
    pitch = pov.pitch;
    fov = zoomToFov(pov.zoom || 1);
    fov = Math.min(120, Math.max(20, fov));

    if (typeof detectionPanorama.getPano === "function") {
      const currentPano = detectionPanorama.getPano();
      if (currentPano) detectPanoId = currentPano;
    }
  }

  try {
    const result = await runSinglePanoApiDetection(
      detectPanoId, detectHeading, pitch, fov, statusEl,
    );

    currentDetections = clusterAngularDetections(
      result.detections,
    );

    detectionPov =
      useCurrentPov && detectionPanorama
        ? detectionPanorama.getPov()
        : { heading: detectHeading, pitch, zoom: PANORAMA_DEFAULTS.zoom };
    updateDetectionOverlay();

    const count = currentDetections.length;
    const timeMs = result.total_inference_time_ms;
    const requestedTiles = Number.isFinite(result?.tiles_count)
      ? result.tiles_count
      : null;
    const tileApiRequests = Number.isFinite(result?.tile_api_requests)
      ? result.tile_api_requests
      : null;
    const usageSuffix =
      requestedTiles != null || tileApiRequests != null
        ? ` | tiles requested: ${requestedTiles ?? "?"}, fetched: ${tileApiRequests ?? "?"}`
        : "";

    // Run OCR on all detections (async, non-blocking)
    if (count > 0) {
      if (statusEl) {
        statusEl.textContent =
          `Found ${count} sign(s) (${timeMs.toFixed(0)}ms)${usageSuffix}`;
      }
      runOcrOnAllDetections();
    } else if (statusEl) {
      statusEl.textContent =
        `No parking signs detected (${timeMs.toFixed(0)}ms)${usageSuffix}`;
    }

    return result;
  } catch (err) {
    console.error("Detection error:", err);
    if (statusEl) statusEl.textContent = `Detection failed: ${err.message}`;
    throw err;
  }
}


// ============================================================================
// OCR Modal Functions
// ============================================================================

/**
 * Create OCR modal element if it doesn't exist.
 */
function ensureOcrModal() {
  if (ocrModalEl) return;

  ocrModalEl = document.createElement("div");
  ocrModalEl.id = "ocrModal";
  ocrModalEl.style.cssText = `
    position: fixed;
    z-index: 10000;
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    max-width: 320px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    display: none;
    line-height: 1.4;
  `;
  document.body.appendChild(ocrModalEl);

  // Close on click outside
  document.addEventListener("click", (e) => {
    if (ocrModalEl && !ocrModalEl.contains(e.target)) {
      hideOcrModal();
    }
  });
}

/**
 * Hide OCR modal.
 */
function hideOcrModal() {
  if (ocrModalEl) {
    ocrModalEl.style.display = "none";
  }
}

/**
 * Show OCR modal at position with results.
 */
function showOcrModal(ocrResult, x, y) {
  ensureOcrModal();

  if (!ocrResult || !ocrResult.is_parking_sign) {
    ocrModalEl.innerHTML = `<div style="color: #f87171;">Not a parking sign</div>
      <div style="color: #9ca3af; font-size: 11px; margin-top: 4px;">${ocrResult?.rejection_reason || "Unknown"}</div>`;
  } else {
    const interp = computeInterpretation(ocrResult);

    const rulesHtml = (ocrResult.rules || []).map((rule, i) => {
      const categoryColor = RULE_CATEGORY_COLORS[rule.category] || "#9ca3af";

      const daysStr = rule.days ? rule.days.map(d => d.toUpperCase()).join(", ") : "Any day";
      const timeStr = rule.time_start && rule.time_end
        ? `${rule.time_start}–${rule.time_end}`
        : "Any time";
      const limitStr = rule.time_limit_minutes ? `${rule.time_limit_minutes}min` : "";
      const payStr = rule.payment_required === true ? "💰" : rule.payment_required === false ? "🆓" : "";
      const arrowStr = rule.arrow_direction && rule.arrow_direction !== "none"
        ? ` ${rule.arrow_direction === "left" ? "←" : rule.arrow_direction === "right" ? "→" : "↔"}`
        : "";

      const ann = interp.ruleAnnotations.get(i);
      let statusLine = "";
      if (ann) {
        if (ann.winsFor.length > 0) {
          const dirs = ann.winsFor.map(d => `${formatArrow(d)} ${d.toUpperCase()}`).join(", ");
          statusLine = `<div style="margin-top: 4px; font-size: 10px; color: #a78bfa;">winner for ${dirs} (prec=${ann.precedence})</div>`;
        } else if (ann.skippedReason) {
          statusLine = `<div style="margin-top: 4px; font-size: 10px; color: #6b7280;">SKIPPED — ${ann.skippedReason}</div>`;
        }
      }

      return `
        <div style="margin-bottom: 8px; padding: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; border-left: 3px solid ${categoryColor};">
          <div style="font-weight: 600; color: ${categoryColor}; text-transform: uppercase; font-size: 11px;">
            ${(rule.category || "unknown").replace(/_/g, " ")}${arrowStr}
          </div>
          <div style="margin-top: 4px; font-size: 12px;">
            ${daysStr}<br/>
            ${timeStr} ${limitStr} ${payStr}
          </div>
          ${rule.additional_text ? `<div style="color: #9ca3af; font-size: 11px; margin-top: 2px;">${rule.additional_text}</div>` : ""}
          ${statusLine}
        </div>
      `;
    }).join("");

    const towZonesHtml = (ocrResult.tow_zones || []).map((tz, i) => {
      const daysStr = tz.days ? tz.days.map(d => d.toUpperCase()).join(", ") : "Any day";
      const timeStr = tz.time_start && tz.time_end
        ? `${tz.time_start}–${tz.time_end}`
        : "Any time";
      const arrowStr = tz.arrow_direction && tz.arrow_direction !== "none"
        ? ` ${tz.arrow_direction === "left" ? "←" : tz.arrow_direction === "right" ? "→" : "↔"}`
        : "";

      const towAnn = interp.towAnnotations.get(i);
      const appliesLine = towAnn
        ? `<div style="margin-top: 4px; font-size: 10px; color: #f87171;">applies to ${towAnn.appliesTo}</div>`
        : "";

      return `
        <div style="margin-bottom: 8px; padding: 8px; background: rgba(220, 38, 38, 0.2); border-radius: 4px; border-left: 3px solid #dc2626;">
          <div style="font-weight: 600; color: #dc2626; text-transform: uppercase; font-size: 11px;">
            🚨 TOW ZONE${arrowStr}
          </div>
          <div style="margin-top: 4px; font-size: 12px;">
            ${daysStr}<br/>
            ${timeStr}
          </div>
          ${tz.additional_text ? `<div style="color: #9ca3af; font-size: 11px; margin-top: 2px;">${tz.additional_text}</div>` : ""}
          ${appliesLine}
        </div>
      `;
    }).join("");

    ocrModalEl.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
        <span>Parking Rules</span>
        <span style="font-size: 10px; color: #9ca3af;">${ocrResult.confidence_readable || "medium"} confidence</span>
      </div>
      ${rulesHtml || "<div style='color: #9ca3af;'>No rules extracted</div>"}
      ${towZonesHtml ? `<div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.2);">${towZonesHtml}</div>` : ""}
      ${ocrResult.notes ? `<div style="margin-top: 8px; color: #fbbf24; font-size: 11px;">⚠️ ${ocrResult.notes}</div>` : ""}
      <details style="margin-top: 8px;"><summary style="cursor: pointer; color: #9ca3af; font-size: 11px;">Raw LLM output</summary><pre style="margin: 4px 0 0; font-size: 10px; white-space: pre-wrap; color: #d1d5db; word-break: break-word;">${JSON.stringify(ocrResult, null, 2)}</pre></details>
    `;
  }

  // Position modal near click, but keep in viewport
  const modalWidth = 320;
  const modalHeight = ocrModalEl.offsetHeight || 200;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = x + 10;
  let top = y - 10;

  if (left + modalWidth > viewportWidth) {
    left = x - modalWidth - 10;
  }
  if (top + modalHeight > viewportHeight) {
    top = viewportHeight - modalHeight - 10;
  }
  if (top < 10) top = 10;
  if (left < 10) left = 10;

  ocrModalEl.style.left = `${left}px`;
  ocrModalEl.style.top = `${top}px`;
  ocrModalEl.style.display = "block";
}

function formatArrow(dir) {
  if (dir === "left") return "\u2190";
  if (dir === "right") return "\u2192";
  if (dir === "both") return "\u2194";
  return "";
}

/**
 * Compute per-rule and per-tow-zone interpretation annotations.
 * Returns { ruleAnnotations: Map<idx, {winsFor, skippedReason, precedence}>, towAnnotations: Map<idx, {appliesTo}> }
 */
function computeInterpretation(ocrResult) {
  const PRECEDENCE = { loading_zone: 4, permit_required: 3, no_parking: 2, parking_allowed: 1 };
  const rules = ocrResult.rules || [];
  const towZones = ocrResult.tow_zones || [];

  // Init annotations
  const ruleAnnotations = new Map();
  rules.forEach((_, i) => ruleAnnotations.set(i, { winsFor: [], skippedReason: null, precedence: PRECEDENCE[rules[i].category] || 0 }));

  for (const dir of ["left", "right"]) {
    const candidates = [];
    rules.forEach((rule, idx) => {
      const ad = rule.arrow_direction;
      if (ad === dir || ad === "both") {
        candidates.push({ idx, prec: PRECEDENCE[rule.category] || 0 });
      } else {
        const ann = ruleAnnotations.get(idx);
        if (!ann.skippedReason) {
          ann.skippedReason = (!ad || ad === "none")
            ? "no arrow direction"
            : `arrow points ${ad} only`;
        }
      }
    });

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.prec - a.prec);
      ruleAnnotations.get(candidates[0].idx).winsFor.push(dir);
    }
  }

  const towAnnotations = new Map();
  towZones.forEach((tz, i) => {
    const ad = tz.arrow_direction;
    const appliesTo = (!ad || ad === "none" || ad === "both") ? "LEFT, RIGHT" : ad.toUpperCase();
    towAnnotations.set(i, { appliesTo });
  });

  return { ruleAnnotations, towAnnotations };
}

/** @deprecated kept as no-op for any stale call sites */
function buildInterpretationHtml() { return ""; }

/**
 * Run OCR once on the entire sign cluster after YOLO finishes.
 * All detections in a panorama belong to one physical sign post,
 * so we merge them into one bounding box, crop once, and OCR once.
 */
/**
 * Reusable OCR pipeline — no global deps on detectionPanorama.
 * @param {string} panoId
 * @param {number} camLat
 * @param {number} camLng
 * @param {Array} detections - clustered detection objects
 * @returns {Promise<Array>} detections with ocrResult attached
 */
async function runOcrOnDetections(panoId, camLat, camLng, detections) {
  const apiUrl = window.DETECTION_CONFIG?.API_URL;
  if (!apiUrl || !panoId || !detections?.length) return detections;

  await Promise.allSettled(detections.map(async (det, i) => {
    try {
      const cropPlan = await buildDetectionCropPlan(det, panoId, null);

      const cropResp = await fetch(`${apiUrl}/crop-sign-tiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...cropPlan.requestBody, include_image: true, save: false }),
      });

      if (!cropResp.ok) {
        console.warn(`OCR [${i}]: failed to crop sign cluster`);
        throw new Error("Failed to crop sign cluster");
      }

      const cropData = await cropResp.json();
      if (!cropData.image_base64) {
        console.warn(`OCR [${i}]: no image for sign cluster`);
        throw new Error("No image returned for sign cluster");
      }

      const ocrResp = await fetch(`${apiUrl}/ocr-sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: cropData.image_base64 }),
      });

      if (!ocrResp.ok) {
        const errBody = await ocrResp.text();
        console.warn(`OCR [${i}]: ${ocrResp.status} ${errBody}`);
        throw new Error(`OCR request failed: ${ocrResp.status} ${errBody}`);
      }

      const ocrResult = await ocrResp.json();
      det.ocrResult = ocrResult;

      if (camLat && camLng && window.signRegistry) {
        det.uuid = window.signRegistry.registerSign(det, ocrResult, camLat, camLng);
      } else {
        det.uuid = crypto.randomUUID();
      }
    } catch (err) {
      console.warn(`OCR error [${i}]:`, err);
      det.ocrResult = { is_parking_sign: false, rejection_reason: `OCR failed: ${err.message}` };
      det.ocrError = `OCR failed: ${err.message}`;
    }
  }));

  return detections;
}

async function runOcrOnAllDetections() {
  const apiUrl = window.DETECTION_CONFIG?.API_URL;
  if (!apiUrl || !detectionPanorama || currentDetections.length === 0) return;

  ocrResults.clear();

  const panoId = detectionPanorama.getPano();
  if (!panoId) return;

  const statusEl = document.getElementById("status") || document.getElementById("detectionStatus");
  if (statusEl) statusEl.textContent = `Running OCR on ${currentDetections.length} sign cluster(s)...`;

  const camLat = detectionPanorama?.getPosition?.()?.lat?.();
  const camLng = detectionPanorama?.getPosition?.()?.lng?.();
  await runOcrOnDetections(panoId, camLat, camLng, currentDetections);

  for (let i = 0; i < currentDetections.length; i++) {
    if (currentDetections[i].ocrResult) ocrResults.set(i, currentDetections[i].ocrResult);
  }

  updateDetectionOverlay();
  window.dispatchEvent(new Event("ocr-complete"));

  if (statusEl) {
    const positiveCount = [...ocrResults.values()].filter(r => r.is_parking_sign).length;
    statusEl.textContent = `Found ${currentDetections.length} sign(s). OCR: ${positiveCount > 0 ? `${positiveCount} parking sign(s) identified` : "done"}.`;
  }
}

/**
 * Crop and save sign using high-resolution tiles.
 */
async function cropAndSaveSign(det, cropCenterOverride = null) {
  const statusEl =
    document.getElementById("status") ||
    document.getElementById("detectionStatus");
  const apiUrl = window.DETECTION_CONFIG?.API_URL;

  if (!apiUrl || !detectionPanorama) {
    if (statusEl) statusEl.textContent = "Cannot save: API not configured";
    return;
  }

  const panoId = detectionPanorama.getPano();
  if (!panoId) {
    if (statusEl) statusEl.textContent = "Cannot save: no panorama loaded";
    return;
  }

  if (statusEl) statusEl.textContent = "Fetching tile crop...";

  try {
    const cropPlan = await buildDetectionCropPlan(
      det,
      panoId,
      cropCenterOverride,
    );
    const resp = await fetch(`${apiUrl}/crop-sign-tiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...cropPlan.requestBody,
        debug: true,
        save: true,
        include_image: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Tile crop failed: ${resp.status} - ${errText}`);
    }

    const result = await resp.json();
    if (statusEl) {
      statusEl.textContent = result.width && result.height
        ? `Saved tile crop ${result.width}x${result.height}`
        : "Saved tile crop";
    }
  } catch (err) {
    console.error("Save error:", err);
    if (statusEl) statusEl.textContent = `Save failed: ${err.message}`;
  }
}

async function buildDetectionCropPlan(det, panoId, cropCenterOverride = null) {
  const session = await getSessionToken();
  const metadata = await fetchStreetViewMetadata(panoId, session);

  const imageWidth = TILE_GRID_WIDTH;
  const imageHeight = TILE_GRID_HEIGHT;
  const panoHeading = metadata.heading || 0;
  const tilt = metadata.tilt ?? 90;
  const hasTileBox =
    Number.isFinite(det.tileX1) &&
    Number.isFinite(det.tileY1) &&
    Number.isFinite(det.tileX2) &&
    Number.isFinite(det.tileY2);

  const tileCenterX = hasTileBox ? (det.tileX1 + det.tileX2) / 2 : null;
  const tileCenterY = hasTileBox ? (det.tileY1 + det.tileY2) / 2 : null;
  const tileWidth = hasTileBox ? Math.abs(det.tileX2 - det.tileX1) : null;
  const tileHeight = hasTileBox ? Math.abs(det.tileY2 - det.tileY1) : null;

  const cropHeading = cropCenterOverride?.heading ?? det.heading;
  const pitchBias =
    cropCenterOverride == null && Number.isFinite(det.angularHeight)
      ? CROP_PITCH_BIAS_DOWN * det.angularHeight
      : 0;
  const cropPitch = (cropCenterOverride?.pitch ?? det.pitch) - pitchBias;

  const cropCenter = cropCenterOverride
    ? headingPitchToPixel(
        cropHeading,
        cropPitch,
        imageWidth,
        imageHeight,
        panoHeading,
      )
    : hasTileBox
      ? { x: tileCenterX, y: tileCenterY }
      : headingPitchToPixel(
          cropHeading,
          cropPitch,
          imageWidth,
          imageHeight,
          panoHeading,
        );

  const signSize =
    hasTileBox && Number.isFinite(tileWidth) && Number.isFinite(tileHeight)
      ? { width: tileWidth, height: tileHeight }
      : angularToPixelSize(
          det.angularWidth,
          det.angularHeight,
          imageWidth,
          imageHeight,
        );

  const { tiles, tileX1, tileY1, cropBounds } = getTilesForRegion(
    cropCenter.x,
    cropCenter.y,
    signSize.width,
    signSize.height,
    CROP_PADDING_X,
    CROP_PADDING_Y,
  );

  console.log('[CROP-DIAG]', JSON.stringify({
    det: { heading: det.heading, pitch: det.pitch, angW: det.angularWidth, angH: det.angularHeight },
    meta: { panoHeading, tilt, metaImgW: metadata.imageWidth, metaImgH: metadata.imageHeight },
    gridSize: { w: imageWidth, h: imageHeight },
    cropCenter: { heading: cropHeading, pitch: cropPitch },
    tileBox: hasTileBox ? { x1: det.tileX1, y1: det.tileY1, x2: det.tileX2, y2: det.tileY2 } : null,
    cropCenterPx: { x: cropCenter.x?.toFixed(1), y: cropCenter.y?.toFixed(1) },
    signPx: { w: signSize.width?.toFixed(1), h: signSize.height?.toFixed(1) },
    tiles: { x1: tileX1, y1: tileY1, count: tiles.length },
    cropBounds,
  }));

  return {
    session,
    metadata,
    imageWidth,
    imageHeight,
    panoHeading,
    tilt,
    cropHeading,
    cropPitch,
    uncorrected: cropCenter,
    corrected: cropCenter,
    signSize,
    detectionRelH: null,
    cropRelH: null,
    tiles,
    tileX1,
    tileY1,
    cropBounds,
    requestBody: {
      pano_id: panoId,
      tiles,
      tile_x1: tileX1,
      tile_y1: tileY1,
      crop_x: cropBounds.x,
      crop_y: cropBounds.y,
      crop_width: cropBounds.width,
      crop_height: cropBounds.height,
      confidence: det.confidence,
      api_key: window.GOOGLE_CONFIG?.API_KEY,
      session_token: session,
    },
  };
}

async function fetchDetectionCropPreview(det, panoId) {
  const apiUrl = window.DETECTION_CONFIG?.API_URL;
  if (!apiUrl) {
    throw new Error("Detection API not configured");
  }
  const cropPlan = await buildDetectionCropPlan(det, panoId);
  const resp = await fetch(`${apiUrl}/crop-sign-tiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...cropPlan.requestBody,
      save: false,
      include_image: true,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Preview failed: ${resp.status} - ${errText}`);
  }

  const result = await resp.json();
  const diag = result.crop_diagnostics || null;
  const meta = {
    signSize: cropPlan.signSize,
    cropBounds: cropPlan.cropBounds,
    tilt: cropPlan.tilt,
    panoHeading: cropPlan.panoHeading,
    cropHeading: cropPlan.cropHeading,
    cropPitch: cropPlan.cropPitch,
    corrected: cropPlan.corrected,
    detection: { heading: det.heading, pitch: det.pitch, angularWidth: det.angularWidth, angularHeight: det.angularHeight },
  };
  if (result.image_base64) {
    return {
      src: `data:image/jpeg;base64,${result.image_base64}`,
      width: result.width,
      height: result.height,
      tilesFetched: result.tiles_fetched,
      cropDiagnostics: diag,
      cropPlanMeta: meta,
    };
  }

  if (result.image_url) {
    return {
      src: `${apiUrl}${result.image_url}`,
      width: result.width,
      height: result.height,
      tilesFetched: result.tiles_fetched,
      cropDiagnostics: diag,
      cropPlanMeta: meta,
    };
  }

  if (result.filename) {
    return {
      src: `${apiUrl}/detected-signs/${encodeURIComponent(result.filename)}`,
      width: result.width,
      height: result.height,
      tilesFetched: result.tiles_fetched,
      cropDiagnostics: diag,
      cropPlanMeta: meta,
    };
  }

  throw new Error("Preview response missing image data");
}

// Google Street View camera height in meters (roof-mounted camera)
const SV_CAMERA_HEIGHT = 2.5;
const EARTH_RADIUS_METERS = 6371000;
const PARKING_SIGN_FACE_HEIGHT_METERS = 0.45;
// Approximate lane width and edge inset used to snap detections onto the
// visible road edge when OSM does not provide explicit width data.
const DEFAULT_LANE_WIDTH_METERS = 3.2;
const ROAD_EDGE_INSET_METERS = 0.35;
const MIN_ROAD_EDGE_OFFSET_METERS = 2.4;
const MAX_ROAD_EDGE_OFFSET_METERS = 6.2;
const FIXED_SIGN_CENTERLINE_OFFSET_METERS = 3.1;
const SIDE_INFERENCE_MIN_LATERAL_DEGREES = 28;
// Keep the guide on the road plane so it coincides with the painted centerline.
// Elevating it above ground introduces visible parallax and drifts it across the road.
const ROAD_GUIDE_HEIGHT_METERS = 0.0;
const ROAD_GUIDE_RANGE_METERS = 85;
const ROAD_GUIDE_SAMPLE_STEP_METERS = 2;
const ROAD_GUIDE_SCREEN_MARGIN_PX = 160;
const ROAD_GUIDE_MAX_SCREEN_JUMP_PX = 240;
const ROAD_GUIDE_MIN_CAMERA_CENTERLINE_OFFSET_METERS = 0.75;
const MERGED_DISTANCE_HEIGHT_BIAS_FLOOR = 0.1;
const MERGED_DISTANCE_HEIGHT_BIAS_RANGE = 1.15;

function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function partitionConsensusOutliers(heights) {
  if (heights.length <= 1) {
    return { consensusIndices: heights.map((_, i) => i), outlierIndices: [], consensusMedian: median(heights) };
  }

  const indexed = heights.map((h, i) => ({ h, i }));
  indexed.sort((a, b) => a.h - b.h);

  // Sliding window: longest run where max/min <= 1.2
  let bestStart = 0, bestLen = 1, left = 0;
  for (let right = 1; right < indexed.length; right++) {
    while (indexed[right].h > indexed[left].h * 1.2) left++;
    if (right - left + 1 > bestLen) {
      bestStart = left;
      bestLen = right - left + 1;
    }
  }

  // No consensus formed (all singletons) — keep everything
  if (bestLen <= 1 && indexed.length > 1) {
    return { consensusIndices: heights.map((_, i) => i), outlierIndices: [], consensusMedian: median(heights) };
  }

  const consensusSet = new Set(indexed.slice(bestStart, bestStart + bestLen).map((e) => e.i));
  const consMed = median(indexed.slice(bestStart, bestStart + bestLen).map((e) => e.h));

  const consensusIndices = [], outlierIndices = [];
  for (let i = 0; i < heights.length; i++) {
    if (consensusSet.has(i)) {
      consensusIndices.push(i);
    } else if (heights[i] > consMed * 2 || heights[i] < consMed * 0.2) {
      outlierIndices.push(i);
    } else {
      consensusIndices.push(i);
    }
  }

  return { consensusIndices, outlierIndices, consensusMedian: consMed };
}

function normalizeAngularDetection(detection) {
  if (!detection) {
    return detection;
  }

  return {
    ...detection,
    sourceDetections:
      Number.isFinite(detection.sourceDetections) && detection.sourceDetections > 0
        ? detection.sourceDetections
        : 1,
    distanceAngularHeight:
      Number.isFinite(detection.distanceAngularHeight) &&
      detection.distanceAngularHeight > 0
        ? detection.distanceAngularHeight
        : detection.angularHeight,
    distanceAngularWidth:
      Number.isFinite(detection.distanceAngularWidth) &&
      detection.distanceAngularWidth > 0
        ? detection.distanceAngularWidth
        : detection.angularWidth,
    mergeStackFactor:
      Number.isFinite(detection.mergeStackFactor) && detection.mergeStackFactor >= 0
        ? detection.mergeStackFactor
        : 0,
  };
}

function resolveDetectionDistanceAngularHeight(detection) {
  return normalizeAngularDetection(detection)?.distanceAngularHeight;
}

function createStreetFrameFromBearing(originLat, originLng, bearingDegrees) {
  const bearingRad = (normalizeBearingDegrees(bearingDegrees) * Math.PI) / 180;
  const alongUnit = {
    x: Math.sin(bearingRad),
    y: Math.cos(bearingRad),
  };

  return {
    originLat,
    originLng,
    alongUnit,
    rightUnit: {
      x: alongUnit.y,
      y: -alongUnit.x,
    },
  };
}

/**
 * Project a point from a start lat/lng by distance and bearing.
 * Uses a spherical-earth forward geodesic so detection projection works
 * even on pages that do not load Turf.js.
 *
 * @param {number} lat - Start latitude in degrees
 * @param {number} lng - Start longitude in degrees
 * @param {number} distanceMeters - Distance in meters
 * @param {number} bearingDegrees - Bearing in degrees
 * @returns {{lat: number, lng: number}}
 */
function projectLatLng(lat, lng, distanceMeters, bearingDegrees) {
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const bearingRad = (bearingDegrees * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAd = Math.sin(angularDistance);
  const cosAd = Math.cos(angularDistance);

  const lat2 = Math.asin(
    sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(bearingRad),
  );

  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearingRad) * sinAd * cosLat1,
      cosAd - sinLat1 * Math.sin(lat2),
    );

  const normalizedLng = (((lng2 * 180) / Math.PI + 540) % 360) - 180;

  return {
    lat: (lat2 * 180) / Math.PI,
    lng: normalizedLng,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBearingDegrees(bearing) {
  return ((bearing % 360) + 360) % 360;
}

function signedAngleDeltaDegrees(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function projectSignedDistance(lat, lng, distanceMeters, bearingDegrees) {
  const normalizedBearing = normalizeBearingDegrees(bearingDegrees);
  if (distanceMeters >= 0) {
    return projectLatLng(lat, lng, distanceMeters, normalizedBearing);
  }
  return projectLatLng(
    lat,
    lng,
    Math.abs(distanceMeters),
    normalizedBearing + 180,
  );
}

function latLngToLocalMeters(lat, lng, originLat, originLng) {
  const latScale = 111320;
  const lngScale =
    111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    x: (lng - originLng) * lngScale,
    y: (lat - originLat) * latScale,
  };
}

function localMetersToLatLng(x, y, originLat, originLng) {
  const latScale = 111320;
  const lngScale =
    111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    lat: originLat + y / latScale,
    lng: originLng + x / lngScale,
  };
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return (
    2 *
    EARTH_RADIUS_METERS *
    Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  );
}

function bearingBetweenPoints(lat1, lng1, lat2, lng2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const lambda = toRadians(lng2 - lng1);
  const y = Math.sin(lambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda);
  return normalizeBearingDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

function getWayNodeLng(node) {
  return node?.lon ?? node?.lng ?? null;
}

function hasWayGeometry(wayGeometry) {
  return Array.isArray(wayGeometry) && wayGeometry.length >= 2;
}

function getWaySegment(wayGeometry, segmentIndex) {
  if (!hasWayGeometry(wayGeometry)) {
    return null;
  }

  if (
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 ||
    segmentIndex >= wayGeometry.length - 1
  ) {
    return null;
  }

  const start = wayGeometry[segmentIndex];
  const end = wayGeometry[segmentIndex + 1];
  const startLng = getWayNodeLng(start);
  const endLng = getWayNodeLng(end);
  if (
    !Number.isFinite(start?.lat) ||
    !Number.isFinite(startLng) ||
    !Number.isFinite(end?.lat) ||
    !Number.isFinite(endLng)
  ) {
    return null;
  }

  return {
    start: { lat: start.lat, lng: startLng },
    end: { lat: end.lat, lng: endLng },
  };
}

function getWaySegmentBearing(wayGeometry, segmentIndex, fallbackBearing = null) {
  const segmentCandidates = [segmentIndex, segmentIndex - 1, segmentIndex + 1];
  for (const candidate of segmentCandidates) {
    const segment = getWaySegment(wayGeometry, candidate);
    if (!segment) {
      continue;
    }

    const segmentLength = haversineDistanceMeters(
      segment.start.lat,
      segment.start.lng,
      segment.end.lat,
      segment.end.lng,
    );
    if (segmentLength <= 0.05) {
      continue;
    }

    return bearingBetweenPoints(
      segment.start.lat,
      segment.start.lng,
      segment.end.lat,
      segment.end.lng,
    );
  }

  return fallbackBearing;
}

function orientBearingToMatch(referenceBearing, candidateBearing) {
  if (!Number.isFinite(candidateBearing)) {
    return referenceBearing;
  }

  if (!Number.isFinite(referenceBearing)) {
    return normalizeBearingDegrees(candidateBearing);
  }

  return Math.abs(signedAngleDeltaDegrees(candidateBearing, referenceBearing)) <= 90
    ? normalizeBearingDegrees(candidateBearing)
    : normalizeBearingDegrees(candidateBearing + 180);
}

function projectPointOntoWayGeometry(
  lat,
  lng,
  wayGeometry,
  preferredSegmentIndex = null,
) {
  if (!hasWayGeometry(wayGeometry) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const segmentOrder = [];
  if (
    Number.isInteger(preferredSegmentIndex) &&
    preferredSegmentIndex >= 0 &&
    preferredSegmentIndex < wayGeometry.length - 1
  ) {
    segmentOrder.push(preferredSegmentIndex);
  }

  for (let i = 0; i < wayGeometry.length - 1; i += 1) {
    if (i !== preferredSegmentIndex) {
      segmentOrder.push(i);
    }
  }

  let best = null;
  for (const segmentIndex of segmentOrder) {
    const segment = getWaySegment(wayGeometry, segmentIndex);
    if (!segment) {
      continue;
    }

    const start = latLngToLocalMeters(
      segment.start.lat,
      segment.start.lng,
      lat,
      lng,
    );
    const end = latLngToLocalMeters(
      segment.end.lat,
      segment.end.lng,
      lat,
      lng,
    );
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-6) {
      continue;
    }

    const t = clamp((-(start.x * dx + start.y * dy)) / lenSq, 0, 1);
    const projectedX = start.x + dx * t;
    const projectedY = start.y + dy * t;
    const distanceMeters = Math.hypot(projectedX, projectedY);

    if (best && distanceMeters >= best.distanceMeters) {
      continue;
    }

    const projected = localMetersToLatLng(projectedX, projectedY, lat, lng);
    best = {
      lat: projected.lat,
      lng: projected.lng,
      segmentIndex,
      t,
      distanceMeters,
    };
  }

  return best;
}

function walkWayGeometryByDistance(wayGeometry, anchor, signedDistanceMeters) {
  if (!anchor || !hasWayGeometry(wayGeometry) || !Number.isFinite(signedDistanceMeters)) {
    return null;
  }

  let remaining = Math.abs(signedDistanceMeters);
  let segmentIndex = clamp(anchor.segmentIndex ?? 0, 0, wayGeometry.length - 2);
  let currentLat = anchor.lat;
  let currentLng = anchor.lng;

  if (remaining <= 1e-6) {
    return {
      lat: currentLat,
      lng: currentLng,
      segmentIndex,
    };
  }

  if (signedDistanceMeters >= 0) {
    while (segmentIndex < wayGeometry.length - 1) {
      const nextNode = wayGeometry[segmentIndex + 1];
      const nextLng = getWayNodeLng(nextNode);
      if (!Number.isFinite(nextNode?.lat) || !Number.isFinite(nextLng)) {
        if (segmentIndex >= wayGeometry.length - 2) {
          break;
        }
        segmentIndex += 1;
        continue;
      }

      const segmentDistance = haversineDistanceMeters(
        currentLat,
        currentLng,
        nextNode.lat,
        nextLng,
      );
      if (segmentDistance >= remaining) {
        const fraction = remaining / Math.max(segmentDistance, 1e-6);
        return {
          lat: currentLat + (nextNode.lat - currentLat) * fraction,
          lng: currentLng + (nextLng - currentLng) * fraction,
          segmentIndex,
        };
      }

      remaining -= segmentDistance;
      currentLat = nextNode.lat;
      currentLng = nextLng;
      if (segmentIndex >= wayGeometry.length - 2) {
        break;
      }
      segmentIndex += 1;
    }
  } else {
    while (segmentIndex >= 0) {
      const prevNode = wayGeometry[segmentIndex];
      const prevLng = getWayNodeLng(prevNode);
      if (!Number.isFinite(prevNode?.lat) || !Number.isFinite(prevLng)) {
        if (segmentIndex <= 0) {
          break;
        }
        segmentIndex -= 1;
        continue;
      }

      const segmentDistance = haversineDistanceMeters(
        currentLat,
        currentLng,
        prevNode.lat,
        prevLng,
      );
      if (segmentDistance >= remaining) {
        const fraction = remaining / Math.max(segmentDistance, 1e-6);
        return {
          lat: currentLat + (prevNode.lat - currentLat) * fraction,
          lng: currentLng + (prevLng - currentLng) * fraction,
          segmentIndex,
        };
      }

      remaining -= segmentDistance;
      currentLat = prevNode.lat;
      currentLng = prevLng;
      if (segmentIndex <= 0) {
        break;
      }
      segmentIndex -= 1;
    }
  }

  return {
    lat: currentLat,
    lng: currentLng,
    segmentIndex: clamp(segmentIndex, 0, wayGeometry.length - 2),
  };
}

function getWaySegmentDistanceMeters(wayGeometry, segmentIndex) {
  const segment = getWaySegment(wayGeometry, segmentIndex);
  if (!segment) {
    return null;
  }

  return haversineDistanceMeters(
    segment.start.lat,
    segment.start.lng,
    segment.end.lat,
    segment.end.lng,
  );
}

function getWayNodeOffsetMeters(wayGeometry, nodeIndex) {
  if (
    !hasWayGeometry(wayGeometry) ||
    !Number.isInteger(nodeIndex) ||
    nodeIndex < 0 ||
    nodeIndex >= wayGeometry.length
  ) {
    return null;
  }

  let total = 0;
  for (let i = 0; i < nodeIndex; i += 1) {
    const segmentDistance = getWaySegmentDistanceMeters(wayGeometry, i);
    if (!Number.isFinite(segmentDistance)) {
      return null;
    }
    total += segmentDistance;
  }

  return total;
}

function getWayAnchorOffsetMeters(wayGeometry, anchor) {
  if (!anchor || !hasWayGeometry(wayGeometry)) {
    return null;
  }

  const segmentIndex = clamp(anchor.segmentIndex ?? 0, 0, wayGeometry.length - 2);
  const segmentStartOffset = getWayNodeOffsetMeters(wayGeometry, segmentIndex);
  const segment = getWaySegment(wayGeometry, segmentIndex);
  if (!Number.isFinite(segmentStartOffset) || !segment) {
    return null;
  }

  return (
    segmentStartOffset +
    haversineDistanceMeters(
      segment.start.lat,
      segment.start.lng,
      anchor.lat,
      anchor.lng,
    )
  );
}

function getWayTravelDirectionSign(sign, wayGeometry, anchor) {
  if (!anchor || !hasWayGeometry(wayGeometry)) {
    return 1;
  }

  const trafficBearing = Number.isFinite(sign?.trafficBearing)
    ? sign.trafficBearing
    : (Number.isFinite(sign?.streetBearing) ? sign.streetBearing : null);
  const anchorBearing = getWaySegmentBearing(
    wayGeometry,
    anchor.segmentIndex,
    trafficBearing,
  );
  if (!Number.isFinite(anchorBearing) || !Number.isFinite(trafficBearing)) {
    return 1;
  }

  return Math.abs(signedAngleDeltaDegrees(anchorBearing, trafficBearing)) <= 90
    ? 1
    : -1;
}

function getStreetCenterlineAnchor(cameraLat, cameraLng, options = {}) {
  const { segmentStart, segmentEnd } = options;
  if (!segmentStart || !segmentEnd) {
    return { lat: cameraLat, lng: cameraLng };
  }

  const originLat = (segmentStart.lat + segmentEnd.lat) / 2;
  const originLng = (segmentStart.lon + segmentEnd.lon) / 2;
  const a = latLngToLocalMeters(
    segmentStart.lat,
    segmentStart.lon,
    originLat,
    originLng,
  );
  const b = latLngToLocalMeters(
    segmentEnd.lat,
    segmentEnd.lon,
    originLat,
    originLng,
  );
  const p = latLngToLocalMeters(cameraLat, cameraLng, originLat, originLng);

  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq <= 1e-6) {
    return { lat: cameraLat, lng: cameraLng };
  }

  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const t = clamp((apx * abx + apy * aby) / abLenSq, 0, 1);
  const projected = {
    x: a.x + abx * t,
    y: a.y + aby * t,
  };

  return localMetersToLatLng(projected.x, projected.y, originLat, originLng);
}

function getTrafficBearing(streetBearing, oneway = null) {
  let bearing = normalizeBearingDegrees(streetBearing);
  if (oneway === "-1") {
    bearing = (bearing + 180) % 360;
  }
  return bearing;
}

function getStreetFrame(options = {}) {
  const { segmentStart, segmentEnd } = options;
  if (!segmentStart || !segmentEnd) {
    return null;
  }

  const originLat = (segmentStart.lat + segmentEnd.lat) / 2;
  const originLng = (segmentStart.lon + segmentEnd.lon) / 2;
  const start = latLngToLocalMeters(
    segmentStart.lat,
    segmentStart.lon,
    originLat,
    originLng,
  );
  const end = latLngToLocalMeters(
    segmentEnd.lat,
    segmentEnd.lon,
    originLat,
    originLng,
  );
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length <= 1e-6) {
    return null;
  }

  return {
    originLat,
    originLng,
    alongUnit: {
      x: dx / length,
      y: dy / length,
    },
    rightUnit: {
      x: dy / length,
      y: -dx / length,
    },
  };
}

function toStreetFrame(lat, lng, frame) {
  const point = latLngToLocalMeters(lat, lng, frame.originLat, frame.originLng);
  return {
    along: point.x * frame.alongUnit.x + point.y * frame.alongUnit.y,
    right: point.x * frame.rightUnit.x + point.y * frame.rightUnit.y,
  };
}

function fromStreetFrame(along, right, frame) {
  return localMetersToLatLng(
    along * frame.alongUnit.x + right * frame.rightUnit.x,
    along * frame.alongUnit.y + right * frame.rightUnit.y,
    frame.originLat,
    frame.originLng,
  );
}

function inferDetectionSide(signHeading, trafficBearing, fallbackSide = "right") {
  const delta = signedAngleDeltaDegrees(signHeading, trafficBearing);
  if (Math.abs(delta) < SIDE_INFERENCE_MIN_LATERAL_DEGREES) {
    return fallbackSide;
  }
  return Math.sin((delta * Math.PI) / 180) >= 0 ? "right" : "left";
}

/**
 * Map arrow_direction from sign perspective to along-street directions.
 * Returns array of +1 (with traffic) and/or -1 (against traffic).
 *
 * Sign faces oncoming traffic. Observer facing sign:
 *   Right-side sign: observer's left = with traffic (+1)
 *   Left-side sign:  observer's left = against traffic (-1)
 */
function arrowToAlongStreetDirections(arrowDirection, side) {
  // Default to with-traffic (+1) for ambiguous arrow directions to avoid duplicate lines
  if (!arrowDirection || arrowDirection === "none" || arrowDirection === "both") return [+1];
  if (side === "right") {
    return arrowDirection === "left" ? [+1] : [-1];
  }
  return arrowDirection === "left" ? [-1] : [+1];
}

function parseLaneCount(lanes) {
  if (typeof lanes === "string") {
    return parseFloat(lanes.split(";")[0]);
  }
  if (Number.isFinite(lanes)) {
    return lanes;
  }
  return null;
}

function getDefaultLaneCount(highway = null) {
  return (
    {
      primary: 4,
      secondary: 3,
      tertiary: 2,
      residential: 2,
      unclassified: 2,
    }[highway] || 2
  );
}

function resolveLaneCount(options = {}) {
  const parsedLaneCount = parseLaneCount(options.lanes);
  if (parsedLaneCount > 0) {
    return parsedLaneCount;
  }
  return getDefaultLaneCount(options.highway);
}

function isOnewayRoad(oneway = null) {
  return oneway === "yes" || oneway === "1" || oneway === "-1" || oneway === true;
}


function estimateRoadEdgeOffsetMeters(options = {}) {
  const laneCount = resolveLaneCount(options);

  return clamp(
    (laneCount * DEFAULT_LANE_WIDTH_METERS) / 2 - ROAD_EDGE_INSET_METERS,
    MIN_ROAD_EDGE_OFFSET_METERS,
    MAX_ROAD_EDGE_OFFSET_METERS,
  );
}

function estimateSyntheticRoadCenterlineOffsetMeters(options = {}) {
  if (isOnewayRoad(options.oneway)) {
    return 0;
  }

  const laneCount = resolveLaneCount(options);
  if (!(laneCount > 1)) {
    return 0;
  }

  const laneCenterOffset =
    estimateRoadEdgeOffsetMeters(options) - DEFAULT_LANE_WIDTH_METERS / 2;

  return clamp(
    laneCenterOffset,
    DEFAULT_LANE_WIDTH_METERS * 0.35,
    Math.max(DEFAULT_LANE_WIDTH_METERS * 1.25, MAX_ROAD_EDGE_OFFSET_METERS / 2),
  );
}

function projectSignToCurbLine(
  cameraLat,
  cameraLng,
  distanceMeters,
  signHeading,
  options = {},
) {
  const {
    streetBearing,
    side = "right",
    oneway = null,
    curbOffsetMeters = null,
    wayGeometry = null,
    segmentIndex = null,
    segmentStart = null,
    segmentEnd = null,
    lanes = null,
    highway = null,
    cameraHeading = null,
  } = options;
  if (streetBearing == null) {
    return null;
  }

  // Get raw traffic bearing (OSM direction or oneway-corrected)
  const rawTrafficBearing = getTrafficBearing(streetBearing, oneway);
  // For two-way streets, orient traffic bearing to match camera direction
  // so "right" side is relative to where the camera was looking
  const trafficBearing = oneway
    ? rawTrafficBearing
    : orientBearingToMatch(cameraHeading ?? streetBearing, rawTrafficBearing);

  // Infer sign side from heading relative to traffic direction
  // Falls back to passed side option when sign is nearly parallel to road
  const resolvedSide = inferDetectionSide(signHeading, trafficBearing, side);
  const edgeOffsetMeters =
    curbOffsetMeters ?? FIXED_SIGN_CENTERLINE_OFFSET_METERS;
  const centerlineAnchor = getStreetCenterlineAnchor(cameraLat, cameraLng, {
    segmentStart,
    segmentEnd,
  });
  const headingDelta = signedAngleDeltaDegrees(signHeading, trafficBearing);
  const headingDeltaRad = (headingDelta * Math.PI) / 180;
  const rawAlongStreetDistance = distanceMeters * Math.cos(headingDeltaRad);
  const crossStreetDistance = distanceMeters * Math.sin(headingDeltaRad);
  const alongStreetDistance = clamp(
    rawAlongStreetDistance,
    -distanceMeters,
    distanceMeters,
  );

  if (hasWayGeometry(wayGeometry)) {
    const anchor =
      projectPointOntoWayGeometry(cameraLat, cameraLng, wayGeometry, segmentIndex) ||
      projectPointOntoWayGeometry(
        centerlineAnchor.lat,
        centerlineAnchor.lng,
        wayGeometry,
        segmentIndex,
      );
    if (anchor) {
      const anchorBearing = getWaySegmentBearing(
        wayGeometry,
        anchor.segmentIndex,
        trafficBearing,
      );
      const walkDirectionSign =
        Math.abs(signedAngleDeltaDegrees(anchorBearing, trafficBearing)) <= 90
          ? 1
          : -1;
      const roadPoint = walkWayGeometryByDistance(
        wayGeometry,
        anchor,
        alongStreetDistance * walkDirectionSign,
      );
      if (roadPoint) {
        const localTrafficBearing = orientBearingToMatch(
          trafficBearing,
          getWaySegmentBearing(wayGeometry, roadPoint.segmentIndex, anchorBearing),
        );
        const lateralBearing =
          resolvedSide === "left"
            ? localTrafficBearing - 90
            : localTrafficBearing + 90;
        const snapped = projectLatLng(
          roadPoint.lat,
          roadPoint.lng,
          edgeOffsetMeters,
          lateralBearing,
        );


        return {
          lat: snapped.lat,
          lng: snapped.lng,
          alongStreetDistance,
          rawAlongStreetDistance,
          curbOffsetMeters: edgeOffsetMeters,
          trafficBearing: localTrafficBearing,
          side: resolvedSide,
          _debug: debugOverlaysEnabled ? {
            anchorLat: anchor.lat, anchorLng: anchor.lng,
            roadPointLat: roadPoint.lat, roadPointLng: roadPoint.lng,
          } : undefined,
        };
      }
    }
  }

  const frame = getStreetFrame({ segmentStart, segmentEnd });

  if (!frame) {
    const lateralBearing =
      resolvedSide === "left" ? trafficBearing - 90 : trafficBearing + 90;
    const curbOrigin = projectLatLng(
      centerlineAnchor.lat,
      centerlineAnchor.lng,
      edgeOffsetMeters,
      lateralBearing,
    );

    return {
      ...projectSignedDistance(
        curbOrigin.lat,
        curbOrigin.lng,
        alongStreetDistance,
        trafficBearing,
      ),
      alongStreetDistance,
      rawAlongStreetDistance,
      curbOffsetMeters: edgeOffsetMeters,
      trafficBearing,
      side: resolvedSide,
    };
  }

  const cameraFrame = toStreetFrame(cameraLat, cameraLng, frame);
  const cameraAlong = cameraFrame.along;
  const targetRight = resolvedSide === "left" ? -edgeOffsetMeters : edgeOffsetMeters;
  const snappedAlong = cameraAlong + alongStreetDistance;
  const snapped = fromStreetFrame(snappedAlong, targetRight, frame);

  return {
    lat: snapped.lat,
    lng: snapped.lng,
    alongStreetDistance,
    rawAlongStreetDistance,
    curbOffsetMeters: edgeOffsetMeters,
    trafficBearing,
    side: resolvedSide,
  };
}

function getCurrentPanoramaCameraPosition() {
  const panoramaPosition = detectionPanorama?.getPosition?.();
  const lat = panoramaPosition?.lat?.();
  const lng = panoramaPosition?.lng?.();
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }

  const pointIndex = currentDetectionContext?.pointIndex;
  const sampledPoint =
    pointIndex != null && Array.isArray(currentPoints)
      ? currentPoints[pointIndex]
      : null;
  const sampledLng = sampledPoint?.lon ?? sampledPoint?.lng;
  if (Number.isFinite(sampledPoint?.lat) && Number.isFinite(sampledLng)) {
    return { lat: sampledPoint.lat, lng: sampledLng };
  }

  if (
    typeof INITIAL_LOCATION !== "undefined" &&
    Number.isFinite(INITIAL_LOCATION?.lat) &&
    Number.isFinite(INITIAL_LOCATION?.lon)
  ) {
    return { lat: INITIAL_LOCATION.lat, lng: INITIAL_LOCATION.lon };
  }

  return null;
}

function resolveRoadGuideGeometry(cameraLat, cameraLng) {
  if (!currentDetectionContext) {
    return null;
  }

  const roadBearing = currentDetectionContext.streetBearing;
  if (!Number.isFinite(roadBearing)) {
    return null;
  }

  const segmentStart = currentDetectionContext.segmentStart || null;
  const segmentEnd = currentDetectionContext.segmentEnd || null;
  let frame = null;
  let anchor = null;

  if (segmentStart && segmentEnd) {
    frame = getStreetFrame({ segmentStart, segmentEnd });
    if (frame) {
      anchor = getStreetCenterlineAnchor(cameraLat, cameraLng, {
        segmentStart,
        segmentEnd,
      });
    }
  }

  if (!frame || !anchor) {
    const pointIndex = currentDetectionContext.pointIndex;
    const sampledPoint =
      pointIndex != null && Array.isArray(currentPoints)
        ? currentPoints[pointIndex]
        : null;
    const anchorLat = sampledPoint?.lat ?? cameraLat;
    const anchorLng = sampledPoint?.lon ?? sampledPoint?.lng ?? cameraLng;
    if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLng)) {
      return null;
    }

    frame = createStreetFrameFromBearing(anchorLat, anchorLng, roadBearing);
    anchor = { lat: anchorLat, lng: anchorLng };
  }

  const anchorFrame = toStreetFrame(anchor.lat, anchor.lng, frame);
  const cameraFrame = toStreetFrame(cameraLat, cameraLng, frame);

  return {
    frame,
    roadBearing: normalizeBearingDegrees(roadBearing),
    anchorFrame,
    cameraFrame,
    lateralOffsetMeters: cameraFrame.right - anchorFrame.right,
  };
}

function projectWorldPointToScreen(
  pointLat,
  pointLng,
  pointHeightMeters,
  cameraLat,
  cameraLng,
  povHeading,
  povPitch,
  fov,
  screenWidth,
  screenHeight,
) {
  const local = latLngToLocalMeters(pointLat, pointLng, cameraLat, cameraLng);
  const z = pointHeightMeters - SV_CAMERA_HEIGHT;
  const magnitude = Math.sqrt(local.x * local.x + local.y * local.y + z * z);
  if (magnitude <= 1e-6) {
    return null;
  }

  return directionToScreen(
    {
      x: local.x / magnitude,
      y: local.y / magnitude,
      z: z / magnitude,
    },
    povHeading,
    povPitch,
    fov,
    screenWidth,
    screenHeight,
  );
}

function isReasonableRoadGuideScreenPoint(point, width, height) {
  if (!point) {
    return false;
  }

  return (
    point.x >= -ROAD_GUIDE_SCREEN_MARGIN_PX &&
    point.x <= width + ROAD_GUIDE_SCREEN_MARGIN_PX &&
    point.y >= -ROAD_GUIDE_SCREEN_MARGIN_PX &&
    point.y <= height + ROAD_GUIDE_SCREEN_MARGIN_PX
  );
}

function resolveRoadGuideFrameRight(geometry, pov) {
  if (!geometry) {
    return null;
  }

  const actualCenterlineOffsetMeters =
    geometry.anchorFrame.right - geometry.cameraFrame.right;
  if (
    Math.abs(actualCenterlineOffsetMeters) >=
    ROAD_GUIDE_MIN_CAMERA_CENTERLINE_OFFSET_METERS
  ) {
    return geometry.anchorFrame.right;
  }

  const syntheticCenterlineOffsetMeters =
    estimateSyntheticRoadCenterlineOffsetMeters({
      lanes: currentDetectionContext?.lanes || null,
      highway: currentDetectionContext?.highway || null,
      oneway: currentDetectionContext?.oneway || null,
    });
  if (!(syntheticCenterlineOffsetMeters > 0)) {
    return geometry.anchorFrame.right;
  }

  const viewDelta = signedAngleDeltaDegrees(
    normalizeBearingDegrees(pov.heading),
    geometry.roadBearing,
  );
  const signedCenterlineOffsetMeters =
    Math.abs(viewDelta) <= 90
      ? -syntheticCenterlineOffsetMeters
      : syntheticCenterlineOffsetMeters;

  return geometry.cameraFrame.right + signedCenterlineOffsetMeters;
}

function buildRoadGuideScreenSegments(geometry, cameraLat, cameraLng, pov, fov, width, height) {
  if (!geometry) {
    return [];
  }

  const guideRight = resolveRoadGuideFrameRight(geometry, pov);
  if (!Number.isFinite(guideRight)) {
    return [];
  }

  const segments = [];
  let currentSegment = [];
  let previousPoint = null;

  for (
    let offset = -ROAD_GUIDE_RANGE_METERS;
    offset <= ROAD_GUIDE_RANGE_METERS;
    offset += ROAD_GUIDE_SAMPLE_STEP_METERS
  ) {
    const worldPoint = fromStreetFrame(
      geometry.anchorFrame.along + offset,
      guideRight,
      geometry.frame,
    );
    const screenPoint = projectWorldPointToScreen(
      worldPoint.lat,
      worldPoint.lng,
      ROAD_GUIDE_HEIGHT_METERS,
      cameraLat,
      cameraLng,
      pov.heading,
      pov.pitch,
      fov,
      width,
      height,
    );
    const isVisible = isReasonableRoadGuideScreenPoint(screenPoint, width, height);
    const screenJump =
      previousPoint && screenPoint
        ? Math.hypot(screenPoint.x - previousPoint.x, screenPoint.y - previousPoint.y)
        : 0;

    if (!isVisible || screenJump > ROAD_GUIDE_MAX_SCREEN_JUMP_PX) {
      if (currentSegment.length >= 2) {
        segments.push(currentSegment);
      }
      currentSegment = [];
      previousPoint = null;
      continue;
    }

    currentSegment.push(screenPoint);
    previousPoint = screenPoint;
  }

  if (currentSegment.length >= 2) {
    segments.push(currentSegment);
  }

  return segments;
}

function renderRoadGuideOverlay(overlay, pov, fov, width, height) {
  if (!overlay || !currentDetectionContext) {
    return;
  }

  const cameraPosition = getCurrentPanoramaCameraPosition();
  if (!cameraPosition) {
    return;
  }

  const geometry = resolveRoadGuideGeometry(
    cameraPosition.lat,
    cameraPosition.lng,
  );
  const segments = buildRoadGuideScreenSegments(
    geometry,
    cameraPosition.lat,
    cameraPosition.lng,
    pov,
    fov,
    width,
    height,
  );
  if (segments.length === 0) {
    return;
  }

  const buildPathData = (points) =>
    points
      .map((point, index) =>
        `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
      )
      .join(" ");
  const pathData = segments.map(buildPathData).join(" ");

  const shadowPath = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  shadowPath.classList.add("road-guide-path-shadow");
  shadowPath.setAttribute("d", pathData);
  shadowPath.setAttribute("fill", "none");
  shadowPath.setAttribute("stroke", "rgba(0, 0, 0, 0.55)");
  shadowPath.setAttribute("stroke-width", "8");
  shadowPath.setAttribute("stroke-linecap", "round");
  shadowPath.setAttribute("stroke-linejoin", "round");
  overlay.appendChild(shadowPath);

  const roadGuidePath = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  roadGuidePath.classList.add("road-guide-path");
  roadGuidePath.setAttribute("d", pathData);
  roadGuidePath.setAttribute("fill", "none");
  roadGuidePath.setAttribute("stroke", "#f59e0b");
  roadGuidePath.setAttribute("stroke-width", "4");
  roadGuidePath.setAttribute("stroke-linecap", "round");
  roadGuidePath.setAttribute("stroke-linejoin", "round");
  roadGuidePath.setAttribute("stroke-dasharray", "14 10");
  overlay.appendChild(roadGuidePath);

  const longestSegment = segments.reduce(
    (best, segment) => (segment.length > (best?.length || 0) ? segment : best),
    null,
  );
  if (!longestSegment) {
    return;
  }

  const labelPoint = longestSegment[Math.floor(longestSegment.length / 2)];
  const roadGuideLabel = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "text",
  );
  roadGuideLabel.classList.add("road-guide-label");
  roadGuideLabel.setAttribute("x", (labelPoint.x + 10).toFixed(2));
  roadGuideLabel.setAttribute("y", Math.max(20, labelPoint.y - 10).toFixed(2));
  roadGuideLabel.setAttribute("fill", "#fef3c7");
  roadGuideLabel.setAttribute("font-size", "12");
  roadGuideLabel.setAttribute("font-weight", "700");
  roadGuideLabel.setAttribute("stroke", "rgba(0, 0, 0, 0.45)");
  roadGuideLabel.setAttribute("stroke-width", "3");
  roadGuideLabel.setAttribute("paint-order", "stroke");
  roadGuideLabel.textContent = `Road centerline ${Math.round(geometry.roadBearing)}°`;
  overlay.appendChild(roadGuideLabel);
}

/**
 * Estimate sign distance from its apparent angular height.
 * Smaller boxes should expand non-linearly so far-away signs do not collapse
 * onto the same few meters as nearby curbside signs.
 */

/**
 * Estimate the real-world location of a detected sign.
 * Requires Depth Anything distance to be available.
 *
 * @param {number} cameraLat - Panorama camera latitude
 * @param {number} cameraLng - Panorama camera longitude
 * @param {Object} detection - Detection with {heading, depthAnythingMeters, confidence, class_name}
 * @returns {Object|null} {lat, lng, distance, heading, confidence, class_name} or null if depth unavailable
 */
function estimateSignLocation(
  cameraLat,
  cameraLng,
  detection,
) {
  const distance =
    Number.isFinite(detection.depthAnythingMeters) && detection.depthAnythingMeters > 0
      ? detection.depthAnythingMeters
      : null;

  if (distance == null) {
    console.error(
      `[estimateSignLocation] heading=${detection.heading.toFixed(1)}° - depth-anything not available, skipping detection`,
    );
    return null;
  }

  const dest = projectLatLng(cameraLat, cameraLng, distance, detection.heading);

  return {
    lat: dest.lat,
    lng: dest.lng,
    distance,
    heading: detection.heading,
    confidence: detection.confidence,
    class_name: detection.class_name,
  };
}

/**
 * Estimate locations for all current detections.
 * @param {number} cameraLat - Panorama camera latitude
 * @param {number} cameraLng - Panorama camera longitude
 * @returns {Array} Array of estimated sign locations
 */
function estimateAllSignLocations(cameraLat, cameraLng, options = null) {
  const results = currentDetections
    .map((det) => {
      // Invalidate if OCR determined it's not a parking sign
      if (det.ocrResult && det.ocrResult.is_parking_sign === false) {
        return null;
      }

      const estimate = estimateSignLocation(cameraLat, cameraLng, det);
      if (!estimate) return null;

      const curbAligned = options
        ? projectSignToCurbLine(
            cameraLat,
            cameraLng,
            estimate.distance,
            det.heading,
            options,
          )
        : null;

      const enrichedEstimate = {
        ...estimate,
        panoId: currentDetectionContext?.panoId || null,
        angularWidth: det.angularWidth,
        angularHeight: det.angularHeight,
        distanceAngularHeight: resolveDetectionDistanceAngularHeight(det),
        pitch: det.pitch,
        depthAnythingMeters: det.depthAnythingMeters,
        depthAnythingMetersRaw: det.depthAnythingMetersRaw,
        sourceDetections: det.sourceDetections || 1,
        mergeStackFactor: det.mergeStackFactor || 0,
      };

      if (!curbAligned) {
        return enrichedEstimate;
      }

      return {
        ...enrichedEstimate,
        lat: curbAligned.lat,
        lng: curbAligned.lng,
        alongStreetDistance: curbAligned.alongStreetDistance,
        curbOffsetMeters: curbAligned.curbOffsetMeters,
        trafficBearing: curbAligned.trafficBearing,
        side: curbAligned.side,
        method: `${estimate.method}+curb`,
        _debug: curbAligned._debug,
      };
    })
    .filter((loc) => loc !== null);

  return results;
}

// ── Debug overlay rendering ──

const DEBUG_RING_DISTANCES = [10, 20, 30, 40, 50];
const DEBUG_RING_COLORS = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#74c0fc"];
const DEBUG_RING_AZIMUTH_STEP = 5;

function toggleDebugOverlays() {
  debugOverlaysEnabled = !debugOverlaysEnabled;
  console.log(`[Debug] Overlays ${debugOverlaysEnabled ? "ENABLED" : "DISABLED"}`);
  updateDetectionOverlay();
  if (typeof updateDebugMapOverlays === "function") {
    updateDebugMapOverlays();
  }
}

function renderDebugDistanceRings(overlay, pov, fov, screenWidth, screenHeight) {
  if (!debugOverlaysEnabled || !detectionPanorama) return;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const cameraPosition = detectionPanorama.getPosition?.();
  const cameraLat = cameraPosition?.lat?.();
  const cameraLng = cameraPosition?.lng?.();
  if (!Number.isFinite(cameraLat) || !Number.isFinite(cameraLng)) return;

  for (let ri = 0; ri < DEBUG_RING_DISTANCES.length; ri++) {
    const dist = DEBUG_RING_DISTANCES[ri];
    const color = DEBUG_RING_COLORS[ri];
    let prevScreen = null;
    let labelPlaced = false;

    for (let az = 0; az <= 360; az += DEBUG_RING_AZIMUTH_STEP) {
      const worldPt = projectLatLng(cameraLat, cameraLng, dist, az);
      const screen = projectWorldPointToScreen(
        worldPt.lat, worldPt.lng, 0,
        cameraLat, cameraLng,
        pov.heading, pov.pitch, fov,
        screenWidth, screenHeight,
      );

      if (screen && prevScreen) {
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", prevScreen.x);
        line.setAttribute("y1", prevScreen.y);
        line.setAttribute("x2", screen.x);
        line.setAttribute("y2", screen.y);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "1.5");
        line.setAttribute("stroke-opacity", "0.7");
        line.setAttribute("stroke-dasharray", "4,3");
        line.classList.add("debug-overlay");
        overlay.appendChild(line);
      }

      if (screen && !labelPlaced &&
          screen.x > 20 && screen.x < screenWidth - 40 &&
          screen.y > 10 && screen.y < screenHeight - 10) {
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("x", screen.x);
        text.setAttribute("y", screen.y - 4);
        text.setAttribute("fill", color);
        text.setAttribute("font-size", "11");
        text.setAttribute("font-weight", "bold");
        text.setAttribute("text-shadow", "0 0 3px black");
        text.classList.add("debug-overlay");
        text.textContent = `${dist}m`;
        overlay.appendChild(text);
        labelPlaced = true;
      }

      prevScreen = screen;
    }
  }
}

function updateDebugMapOverlays() {
  if (!debugMapLayer) return;
  debugMapLayer.clearLayers();
  if (!debugOverlaysEnabled) return;

  const cameraPosition = detectionPanorama?.getPosition?.();
  const cameraLat = cameraPosition?.lat?.();
  const cameraLng = cameraPosition?.lng?.();
  if (!Number.isFinite(cameraLat) || !Number.isFinite(cameraLng)) return;

  // Distance rings on map
  for (let ri = 0; ri < DEBUG_RING_DISTANCES.length; ri++) {
    const dist = DEBUG_RING_DISTANCES[ri];
    const color = DEBUG_RING_COLORS[ri];
    L.circle([cameraLat, cameraLng], {
      radius: dist,
      color,
      weight: 1.5,
      opacity: 0.6,
      fill: false,
      dashArray: "4,3",
      interactive: false,
    }).addTo(debugMapLayer);

    // Label at east side of ring
    const labelPt = projectLatLng(cameraLat, cameraLng, dist, 90);
    L.marker([labelPt.lat, labelPt.lng], {
      icon: L.divIcon({
        className: "debug-ring-label",
        html: `<span style="color:${color};font-size:11px;font-weight:bold;text-shadow:0 0 3px #000">${dist}m</span>`,
        iconSize: [30, 14],
        iconAnchor: [0, 7],
      }),
      interactive: false,
    }).addTo(debugMapLayer);
  }
}

function renderDebugDecompositionLines(signLocations, cameraLat, cameraLng) {
  if (!debugOverlaysEnabled || !debugMapLayer) return;

  for (const sign of signLocations) {
    if (!sign._debug) continue;
    const { anchorLat, anchorLng, roadPointLat, roadPointLng } = sign._debug;

    // Camera -> anchor (orange dashed)
    L.polyline(
      [[cameraLat, cameraLng], [anchorLat, anchorLng]],
      { color: "#ffa94d", weight: 2, dashArray: "3,3", opacity: 0.7, interactive: false },
    ).addTo(debugMapLayer);

    // Anchor -> road walk point (cyan)
    L.polyline(
      [[anchorLat, anchorLng], [roadPointLat, roadPointLng]],
      { color: "#22d3ee", weight: 2, opacity: 0.8, interactive: false },
    ).addTo(debugMapLayer);

    // Road walk point -> final sign position (magenta)
    L.polyline(
      [[roadPointLat, roadPointLng], [sign.lat, sign.lng]],
      { color: "#e879f9", weight: 2, opacity: 0.8, interactive: false },
    ).addTo(debugMapLayer);

    // Direct line from camera to sign (white dotted, for comparison)
    L.polyline(
      [[cameraLat, cameraLng], [sign.lat, sign.lng]],
      { color: "#ffffff", weight: 1, dashArray: "2,4", opacity: 0.4, interactive: false },
    ).addTo(debugMapLayer);
  }
}

/**
 * Find distance to the next detected sign on the same side and same street.
 * Returns distance in meters, or the next corner/endpoint distance if none found.
 *
 * @param {Object} sign - Current sign with lat, lng, side, wayGeometry
 * @param {number} direction - +1 (with traffic) or -1 (against traffic)
 * @param {Array} allSigns - All signs across all detections (each with wayGeometry attached)
 * @param {Array} wayGeometry - The wayGeometry for the current sign's street
 * @param {Array} intersectionNodes - Shared way nodes [{ lat, lng, nodeIndex }, ...]
 */
function findDistanceToNearestCorner(
  sign,
  direction,
  wayGeometry,
  intersectionNodes,
  signAnchor = null,
) {
  if (!hasWayGeometry(wayGeometry)) {
    return RULE_CURVE_DEFAULT_LENGTH_METERS;
  }

  const anchor =
    signAnchor ||
    projectPointOntoWayGeometry(
      sign.lat,
      sign.lng,
      wayGeometry,
      sign.segmentIndex ?? null,
    );
  if (!anchor) {
    return RULE_CURVE_DEFAULT_LENGTH_METERS;
  }

  const signOffset = getWayAnchorOffsetMeters(wayGeometry, anchor);
  if (!Number.isFinite(signOffset)) {
    console.warn(`[findDistanceToNearestCorner] signOffset not finite, using DEFAULT ${RULE_CURVE_DEFAULT_LENGTH_METERS}m`);
    return RULE_CURVE_DEFAULT_LENGTH_METERS;
  }

  const travelDirSign = getWayTravelDirectionSign(sign, wayGeometry, anchor);
  const directionSign = direction * travelDirSign;
  let nearestIntersection = Infinity;

  for (const node of intersectionNodes || []) {
    if (!Number.isInteger(node?.nodeIndex)) {
      console.warn(`[findDistanceToNearestCorner] Malformed node missing nodeIndex:`, node);
      continue;
    }

    const nodeOffset = getWayNodeOffsetMeters(wayGeometry, node.nodeIndex);
    if (!Number.isFinite(nodeOffset)) {
      continue;
    }

    const signedDistance = nodeOffset - signOffset;
    if (signedDistance * directionSign <= 0) {
      continue;
    }

    const distanceMeters = Math.abs(signedDistance);
    if (distanceMeters <= RULE_CURVE_INTERSECTION_SKIP_METERS) {
      continue;
    }

    // Extend past the centerline node to the actual curb corner
    // by adding the widest cross-street's road-edge half-width.
    let cornerExtension = 0;
    for (const tags of node.crossStreetTags || []) {
      const halfWidth = estimateRoadEdgeOffsetMeters(tags);
      if (halfWidth > cornerExtension) cornerExtension = halfWidth;
    }

    const adjustedDistance = distanceMeters + cornerExtension;
    if (adjustedDistance < nearestIntersection) {
      nearestIntersection = adjustedDistance;
    }
  }

  if (Number.isFinite(nearestIntersection)) {
    return nearestIntersection;
  }

  const endpointIndex = directionSign > 0 ? wayGeometry.length - 1 : 0;
  const endpointOffset = getWayNodeOffsetMeters(wayGeometry, endpointIndex);
  if (!Number.isFinite(endpointOffset)) {
    return RULE_CURVE_DEFAULT_LENGTH_METERS;
  }

  const endpointDist = Math.abs(endpointOffset - signOffset);
  return endpointDist;
}

function findDistanceToNextSign(
  sign,
  direction,
  allSigns,
  wayGeometry,
  intersectionNodes = null,
) {
  if (!hasWayGeometry(wayGeometry) || !sign.side) {
    return RULE_CURVE_DEFAULT_LENGTH_METERS;
  }

  const signAnchor = projectPointOntoWayGeometry(sign.lat, sign.lng, wayGeometry, sign.segmentIndex ?? null);
  if (!signAnchor) {
    return RULE_CURVE_DEFAULT_LENGTH_METERS;
  }

  const signOffset = getWayAnchorOffsetMeters(wayGeometry, signAnchor);
  if (!Number.isFinite(signOffset)) {
    return RULE_CURVE_DEFAULT_LENGTH_METERS;
  }

  const directionSign =
    direction * getWayTravelDirectionSign(sign, wayGeometry, signAnchor);

  let nearestSignDist = Infinity;

  for (const candidate of allSigns) {
    if (candidate === sign) continue;
    if (candidate.side !== sign.side) continue;

    const cWay = candidate.wayGeometry;
    if (!hasWayGeometry(cWay)) continue;

    const cAnchor = projectPointOntoWayGeometry(
      candidate.lat,
      candidate.lng,
      wayGeometry,
      candidate.segmentIndex ?? null,
    );
    if (!cAnchor) continue;
    if (cAnchor.distanceMeters > SAME_STREET_PROJECTION_THRESHOLD_METERS) continue;
    const candidateOffset = getWayAnchorOffsetMeters(wayGeometry, cAnchor);
    if (!Number.isFinite(candidateOffset)) continue;

    const signedDistance = candidateOffset - signOffset;
    const distanceMeters = Math.abs(signedDistance);
    if (distanceMeters < 1) continue;
    if (signedDistance * directionSign <= 0) continue;

    if (distanceMeters < nearestSignDist) {
      nearestSignDist = distanceMeters;
    }
  }

  const cornerDist = findDistanceToNearestCorner(
    sign,
    direction,
    wayGeometry,
    intersectionNodes,
    signAnchor,
  );

  return Math.min(
    Number.isFinite(nearestSignDist) ? nearestSignDist : Infinity,
    cornerDist,
  );
}

/**
 * Build an array of [lat, lng] points forming a curve parallel to the street,
 * offset to the sign's side (curb line), for rendering a parking rule on the 2D map.
 *
 * @param {Object} sign - Projected sign with lat, lng, side, curbOffsetMeters, trafficBearing, segmentIndex
 * @param {Array} wayGeometry - Street geometry [{lat, lon/lng}, ...]
 * @param {number} direction - +1 (with traffic) or -1 (against traffic)
 * @param {number} ruleIndex - Index for perpendicular stacking offset
 * @param {number} maxDistanceMeters - Max curve length from sign
 * @returns {Array|null} Array of [lat, lng] pairs for Leaflet polyline
 */
function buildRuleCurveLatLngs(sign, wayGeometry, direction, ruleIndex, maxDistanceMeters) {
  const curbOffset = (sign.curbOffsetMeters || FIXED_SIGN_CENTERLINE_OFFSET_METERS)
    + ruleIndex * RULE_CURVE_STACK_OFFSET_METERS;
  const side = sign.side || "right";

  // Fallback: straight line using trafficBearing
  if (!hasWayGeometry(wayGeometry)) {
    if (!Number.isFinite(sign.trafficBearing)) return null;

    const bearing = direction > 0 ? sign.trafficBearing : normalizeBearingDegrees(sign.trafficBearing + 180);
    const lateralBearing = side === "right"
      ? normalizeBearingDegrees(sign.trafficBearing + 90)
      : normalizeBearingDegrees(sign.trafficBearing - 90);

    const points = [];
    for (let d = 0; d <= maxDistanceMeters; d += RULE_CURVE_SAMPLE_STEP_METERS) {
      const centerPt = projectLatLng(sign.lat, sign.lng, d, bearing);
      const offsetPt = projectLatLng(centerPt.lat, centerPt.lng, curbOffset, lateralBearing);
      points.push([offsetPt.lat, offsetPt.lng]);
    }
    return points.length >= 2 ? points : null;
  }

  // Project sign onto wayGeometry centerline
  const anchor = projectPointOntoWayGeometry(sign.lat, sign.lng, wayGeometry, sign.segmentIndex ?? null);
  if (!anchor) return null;

  // Align walk direction with traffic bearing (way geometry array order may oppose traffic flow)
  const walkDirectionSign = getWayTravelDirectionSign(sign, wayGeometry, anchor);

  const points = [];
  for (let d = 0; d <= maxDistanceMeters; d += RULE_CURVE_SAMPLE_STEP_METERS) {
    const walked = walkWayGeometryByDistance(wayGeometry, anchor, direction * walkDirectionSign * d);
    if (!walked) continue;

    const rawSegBearing = getWaySegmentBearing(wayGeometry, walked.segmentIndex, sign.trafficBearing);
    if (!Number.isFinite(rawSegBearing)) continue;
    const segBearing = orientBearingToMatch(sign.trafficBearing, rawSegBearing);

    const lateralBearing = side === "right"
      ? normalizeBearingDegrees(segBearing + 90)
      : normalizeBearingDegrees(segBearing - 90);

    const offsetPt = projectLatLng(walked.lat, walked.lng, curbOffset, lateralBearing);
    points.push([offsetPt.lat, offsetPt.lng]);
  }

  return points.length >= 2 ? points : null;
}

/**
 * Clean up detection panorama when closing modal.
 */
function cleanupDetectionPanorama() {
  currentDetections = [];
  if (document.getElementById("detectionOverlay")) {
    document.getElementById("detectionOverlay").innerHTML = "";
  }
  detectionPanorama?.destroy?.();
  detectionPanorama = null;
}
