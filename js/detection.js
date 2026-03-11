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
// Shift crop center down by this fraction of angular height. The detection bbox
// geometric center sits above the sign's visual center (e.g. red band at bottom),
// and Static API vs Tiles coordinate frames can add a small vertical offset.
const CROP_PITCH_BIAS_DOWN = 0.25;
const DETECTION_CLUSTER_WIDTH_RATIO = 1.25;
const DETECTION_CLUSTER_HEIGHT_RATIO = 2.4;
const DETECTION_CLUSTER_WIDTH_FLOOR = 0.35;
const DETECTION_CLUSTER_HEIGHT_FLOOR = 1.0;

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
  const tileY1 = Math.floor(y1 / TILE_SIZE);
  const tileX2 = Math.floor(x2 / TILE_SIZE);
  const tileY2 = Math.floor(y2 / TILE_SIZE);

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

function mergeAngularDetections(detections) {
  if (!Array.isArray(detections) || detections.length === 0) {
    return [];
  }

  const normalizedDetections = detections.map(normalizeAngularDetection);
  let heading = detections[0].heading;
  let pitch = detections[0].pitch;
  let minPitch = detections[0].pitch - detections[0].angularHeight / 2;
  let maxPitch = detections[0].pitch + detections[0].angularHeight / 2;
  let confidence = detections[0].confidence;
  let className = detections[0].class_name;

  let minHeadingOffset = 0 - detections[0].angularWidth / 2;
  let maxHeadingOffset = 0 + detections[0].angularWidth / 2;

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
  }

  const mergedAngularWidth = maxHeadingOffset - minHeadingOffset;
  const mergedAngularHeight = maxPitch - minPitch;
  const representativeHeights = normalizedDetections
    .map((det) => det.distanceAngularHeight)
    .filter((value) => Number.isFinite(value) && value > 0);
  const representativeWidths = normalizedDetections
    .map((det) => det.distanceAngularWidth)
    .filter((value) => Number.isFinite(value) && value > 0);
  const representativeHeight =
    median(representativeHeights) ?? mergedAngularHeight;
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

  return normalizeAngularDetection({
    heading,
    pitch,
    angularWidth: mergedAngularWidth,
    angularHeight: mergedAngularHeight,
    confidence,
    class_name: className,
    sourceDetections: normalizedDetections.reduce(
      (sum, det) => sum + (det.sourceDetections || 1),
      0,
    ),
    sourceMedianAngularHeight: representativeHeight,
    sourceMedianAngularWidth: representativeWidth,
    distanceAngularHeight,
    distanceAngularWidth: representativeWidth,
    mergeStackFactor,
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

// Paired marking state: alternates between marking sign (ground truth) and detection box
let markedPairs = []; // Completed pairs: [{sign: {...}, box: {...}, errors: {...}}]
let pendingSignMark = null; // Waiting for box mark to complete the pair
let cachedPanoMetadata = null;
// Legacy alias for cleanup code
let markedPoints = [];

/**
 * Convert heading/pitch to tile pixel coordinates with tilt correction.
 *
 * Google's stabilized tiles are equirectangular in the camera's local frame.
 * Heading maps directly (world heading - panoHeading), but pitch is offset
 * by the camera's tilt. The offset depends on relative heading:
 *
 *   - Looking forward  (relH=0°):   tilt shifts pitch by +tiltOffset
 *   - Looking sideways  (relH=90°):  no pitch shift (tilt becomes heading shift)
 *   - Looking backward (relH=180°): tilt shifts pitch by -tiltOffset
 *
 * Formula: tilePitch = worldPitch + (tilt - 90) * cos(relativeHeading)
 */
function headingPitchToPixelCorrected(
  heading,
  pitch,
  imageWidth,
  imageHeight,
  panoHeading = 0,
  tilt = 90,
) {
  let h = (heading - panoHeading + 180 + 360) % 360;
  const x = (h / 360) * imageWidth;

  // Tilt correction: only affects Y, scales with cos(relativeHeading)
  const tiltOffset = tilt - 90; // degrees, positive = camera looks down
  let relH = heading - panoHeading;
  if (relH < -180) relH += 360;
  if (relH > 180) relH -= 360;

  const yCorrection =
    tiltOffset * Math.cos((relH * Math.PI) / 180) * (imageHeight / 180);
  const yBase = ((90 - pitch) / 180) * imageHeight;
  const y = yBase + yCorrection;

  return { x, y, yCorrection };
}

/**
 * Collect angular + tile data for a screen position.
 * Shared helper for both sign and box marking.
 */
async function collectMarkData(screenX, screenY) {
  const container = document.getElementById("detectionPanorama");
  const screenWidth = container.clientWidth;
  const screenHeight = container.clientHeight;

  const pov = detectionPanorama.getPov();
  const currentFov = zoomToFov(pov.zoom || 1);
  const panoId = detectionPanorama.getPano();

  const angular = screenToAngular(
    screenX,
    screenY,
    pov.heading,
    pov.pitch,
    currentFov,
    screenWidth,
    screenHeight,
  );

  // Get panorama metadata (cache it)
  if (!cachedPanoMetadata || cachedPanoMetadata.panoId !== panoId) {
    try {
      const session = await getSessionToken();
      const metadata = await fetchStreetViewMetadata(panoId, session);
      cachedPanoMetadata = { ...metadata, panoId };
    } catch (err) {
      console.warn("Could not fetch metadata:", err);
      cachedPanoMetadata = { heading: 0, tilt: 90, roll: 0, panoId };
    }
  }

  const panoHeading = cachedPanoMetadata.heading || 0;
  const tilt = cachedPanoMetadata.tilt ?? 90;

  const uncorrected = headingPitchToPixel(
    angular.heading,
    angular.pitch,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    panoHeading,
  );
  const corrected = headingPitchToPixelCorrected(
    angular.heading,
    angular.pitch,
    TILE_GRID_WIDTH,
    TILE_GRID_HEIGHT,
    panoHeading,
    tilt,
  );

  let relH = angular.heading - panoHeading;
  if (relH < -180) relH += 360;
  if (relH > 180) relH -= 360;

  return {
    panoId,
    panoHeading,
    tilt,
    heading: angular.heading,
    pitch: angular.pitch,
    relH,
    screenX,
    screenY,
    tileUncorrected: { x: uncorrected.x, y: uncorrected.y },
    tileCorrected: { x: corrected.x, y: corrected.y },
    yCorrection: corrected.yCorrection,
  };
}

/**
 * Handle Ctrl key press for paired marking.
 *
 * Workflow:
 *   1st Ctrl — mark the ACTUAL sign center (green crosshair)
 *   2nd Ctrl — mark the BOUNDING BOX center (red crosshair)
 *   → logs the pair with errors, then resets for next pair
 *
 * Escape clears everything.
 */
async function handleSignMarking(event) {
  if (event.key !== "Control" || event.repeat || !detectionPanorama) return;

  const container = document.getElementById("detectionPanorama");
  const screenX = lastMouseX;
  const screenY = lastMouseY;

  if (
    screenX < 0 ||
    screenX > container.clientWidth ||
    screenY < 0 ||
    screenY > container.clientHeight
  ) {
    console.log("Mouse is outside panorama area");
    return;
  }

  const data = await collectMarkData(screenX, screenY);
  const statusEl =
    document.getElementById("status") ||
    document.getElementById("detectionStatus");
  const pairNum = markedPairs.length + 1;

  if (!pendingSignMark) {
    // --- First Ctrl: mark the actual sign location (ground truth) ---
    pendingSignMark = data;
    addMarkerToOverlay(screenX, screenY, `${pairNum}S`, "#00ff00");

    console.log(
      `SIGN #${pairNum}: h=${data.heading.toFixed(2)}° p=${data.pitch.toFixed(2)}° relH=${data.relH.toFixed(2)}°\n` +
        `  tile uncorr=(${data.tileUncorrected.x.toFixed(0)}, ${data.tileUncorrected.y.toFixed(0)}) ` +
        `corr=(${data.tileCorrected.x.toFixed(0)}, ${data.tileCorrected.y.toFixed(0)}) yCorr=${data.yCorrection.toFixed(1)}px`,
    );

    if (statusEl) {
      statusEl.textContent = `Pair #${pairNum}: sign marked at h=${data.heading.toFixed(1)}° p=${data.pitch.toFixed(1)}° — now Ctrl+hover on the bounding box`;
    }
  } else {
    // --- Second Ctrl: mark the bounding box location ---
    addMarkerToOverlay(screenX, screenY, `${pairNum}B`, "#ff4444");

    const sign = pendingSignMark;
    const box = data;

    // Compute errors
    let hErr = box.heading - sign.heading;
    if (hErr > 180) hErr -= 360;
    if (hErr < -180) hErr += 360;
    const pErr = box.pitch - sign.pitch;

    const pair = {
      num: pairNum,
      sign,
      box,
      errors: {
        heading: hErr,
        pitch: pErr,
        tileX: box.tileCorrected.x - sign.tileCorrected.x,
        tileY: box.tileCorrected.y - sign.tileCorrected.y,
      },
    };
    markedPairs.push(pair);

    console.log(
      `BOX  #${pairNum}: h=${box.heading.toFixed(2)}° p=${box.pitch.toFixed(2)}°\n` +
        `  tile uncorr=(${box.tileUncorrected.x.toFixed(0)}, ${box.tileUncorrected.y.toFixed(0)}) ` +
        `corr=(${box.tileCorrected.x.toFixed(0)}, ${box.tileCorrected.y.toFixed(0)}) yCorr=${box.yCorrection.toFixed(1)}px\n` +
        `PAIR #${pairNum} ERROR: Δheading=${hErr.toFixed(2)}° Δpitch=${pErr.toFixed(2)}° Δtile=(${pair.errors.tileX.toFixed(0)}, ${pair.errors.tileY.toFixed(0)})px`,
    );

    // Summary table if we have multiple pairs
    if (markedPairs.length > 1) {
      const avgH =
        markedPairs.reduce((s, p) => s + p.errors.heading, 0) /
        markedPairs.length;
      const avgP =
        markedPairs.reduce((s, p) => s + p.errors.pitch, 0) /
        markedPairs.length;
      console.log(
        `SUMMARY (${markedPairs.length} pairs): avg Δheading=${avgH.toFixed(2)}° avg Δpitch=${avgP.toFixed(2)}°`,
      );
    }

    if (statusEl) {
      statusEl.textContent = `Pair #${pairNum}: Δh=${hErr.toFixed(2)}° Δp=${pErr.toFixed(2)}° — Ctrl to start next pair, Esc to clear`;
    }

    // Reset for next pair
    pendingSignMark = null;
  }
}

/**
 * Add visual marker to the detection overlay.
 */
function addMarkerToOverlay(screenX, screenY, label, color = "#00ff00") {
  const overlay = document.getElementById("detectionOverlay");
  if (!overlay) return;

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.classList.add("sign-marker");

  const size = 12;
  const line1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line1.setAttribute("x1", screenX - size);
  line1.setAttribute("y1", screenY);
  line1.setAttribute("x2", screenX + size);
  line1.setAttribute("y2", screenY);
  line1.setAttribute("stroke", color);
  line1.setAttribute("stroke-width", "2");

  const line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line2.setAttribute("x1", screenX);
  line2.setAttribute("y1", screenY - size);
  line2.setAttribute("x2", screenX);
  line2.setAttribute("y2", screenY + size);
  line2.setAttribute("stroke", color);
  line2.setAttribute("stroke-width", "2");

  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", screenX + size + 4);
  text.setAttribute("y", screenY - size);
  text.setAttribute("fill", color);
  text.setAttribute("font-size", "14");
  text.setAttribute("font-weight", "bold");
  text.textContent = label;

  g.appendChild(line1);
  g.appendChild(line2);
  g.appendChild(text);
  overlay.appendChild(g);
}

/**
 * Clear all marked points and visual markers.
 */
function clearMarkedPoints() {
  markedPairs = [];
  pendingSignMark = null;
  markedPoints = [];
  cachedPanoMetadata = null;
  const overlay = document.getElementById("detectionOverlay");
  if (overlay) {
    overlay.querySelectorAll(".sign-marker").forEach((el) => el.remove());
  }
  console.log("Cleared all marked pairs");
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

  // Clear existing boxes (but keep markers)
  overlay.querySelectorAll(":not(.sign-marker)").forEach((el) => el.remove());

  // Draw each detection if visible
  for (const det of currentDetections) {
    const screen = angularToScreen(
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

    // Click to save sign
    rect.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();

      const containerRect = container.getBoundingClientRect();
      const clickX = e.clientX - containerRect.left;
      const clickY = e.clientY - containerRect.top;
      const clickAngular = screenToAngular(
        clickX,
        clickY,
        pov.heading,
        pov.pitch,
        fov,
        width,
        height,
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

    // Create label
    const label = `${det.class_name} ${Math.round(det.confidence * 100)}%`;
    const labelBg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect",
    );
    labelBg.setAttribute("x", screen.x);
    labelBg.setAttribute("y", screen.y - 20);
    labelBg.setAttribute("width", label.length * 8 + 8);
    labelBg.setAttribute("height", "18");
    labelBg.setAttribute("fill", color);
    overlay.appendChild(labelBg);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", screen.x + 4);
    text.setAttribute("y", screen.y - 6);
    text.setAttribute("fill", "white");
    text.setAttribute("font-size", "12");
    text.setAttribute("font-weight", "bold");
    text.textContent = label;
    overlay.appendChild(text);
  }
}

/**
 * Initialize or update the detection panorama.
 */
function initDetectionPanorama(panoId, heading, container) {
  const pov = getDefaultPov(heading);

  if (detectionPanorama) {
    detectionPanorama.setPano(panoId);
    detectionPanorama.setPov(pov);
  } else {
    detectionPanorama = new google.maps.StreetViewPanorama(container, {
      pano: panoId,
      pov,
      zoom: PANORAMA_DEFAULTS.zoom,
      addressControl: false,
      showRoadLabels: false,
      motionTracking: false,
      motionTrackingControl: false,
      linksControl: false,
      panControl: true,
      zoomControl: true,
      fullscreenControl: false,
    });

    povChangeListener = detectionPanorama.addListener(
      "pov_changed",
      () => {
        updateDetectionOverlay();
        if (typeof updateDetectionInfoText === "function") {
          updateDetectionInfoText();
        }
      },
    );
    panoChangeListener = detectionPanorama.addListener(
      "pano_changed",
      clearDetections,
    );
    positionChangeListener = detectionPanorama.addListener(
      "position_changed",
      updateDetectionOverlay,
    );

    // Track mouse position at document level (works over bounding boxes too)
    document.addEventListener("mousemove", trackMousePosition);
    document.addEventListener("keydown", handleSignMarking);
    document.addEventListener("keydown", handleMarkerKeyboard);
  }

  currentDetections = [];
  markedPoints = [];
  cachedPanoMetadata = null;
  updateDetectionOverlay();
}

/**
 * Handle keyboard shortcuts for marker management.
 */
function handleMarkerKeyboard(event) {
  if (event.key === "Escape" && markedPoints.length > 0) {
    clearMarkedPoints();
    const statusEl =
      document.getElementById("status") ||
      document.getElementById("detectionStatus");
    if (statusEl)
      statusEl.textContent =
        "Markers cleared. Ctrl+click to mark sign centers.";
  }
}

/**
 * Clear current detections.
 */
function clearDetections() {
  currentDetections = [];
  updateDetectionOverlay();

  const statusEl = document.getElementById("detectionStatus");
  if (statusEl) {
    statusEl.textContent =
      'Panorama changed. Click "Detect" to scan for parking signs';
  }
}

/**
 * Run the backend's panorama detection pipeline.
 * The backend may use multi-slice inference internally.
 */
async function runPanoramaDetection(panoId, heading, pitch, fov, statusEl) {
  const apiUrl = window.DETECTION_CONFIG?.API_URL;
  const apiKey = window.GOOGLE_CONFIG?.API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("Detection API or Google API key not configured");
  }

  const conf = window.DETECTION_CONFIG?.CONFIDENCE_THRESHOLD ?? 0.15;

  // Use half the current FOV as slice size for ~2x resolution boost
  const sliceFov = Math.min(45, fov / 2);

  if (statusEl)
    statusEl.textContent = `Detecting parking signs across ${sliceFov.toFixed(0)}° slices...`;

  let resp;
  try {
    resp = await fetch(`${apiUrl}/detect-panorama`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pano_id: panoId,
        heading: heading,
        pitch: pitch,
        fov: fov,
        slice_fov: sliceFov,
        overlap: 0.3,
        confidence: conf,
        nms_iou_threshold: 0.5,
        api_key: apiKey,
        img_width: 640,
        img_height: 640,
      }),
    });
  } catch (err) {
    console.error("Panorama detection request failed:", err);
    throw new Error(`Can't reach detection API. Make sure backend is running.`);
  }

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Panorama detection failed: ${resp.status} - ${errorText}`);
  }

  return resp.json();
}

async function runSingleViewPanoramaDetection(
  panoId,
  heading,
  pitch,
  fov,
  imgWidth,
  imgHeight,
) {
  const imageUrl = getStreetViewImageUrl(
    panoId,
    heading,
    pitch,
    fov,
    imgWidth,
    imgHeight,
  );
  const result = await runDetection(imageUrl);

  return {
    detections: clusterAngularDetections(
      result.detections.map((det) =>
        detectionToAngular(det, heading, pitch, fov, imgWidth, imgHeight),
      ),
    ),
    total_inference_time_ms: result.inference_time_ms,
    slices_count: 1,
  };
}

/**
 * Run detection and display results on panorama.
 * @param {boolean} preferPanoramaDetection - Prefer the backend's multi-slice panorama detector
 */
async function runDetectionOnPanorama(
  panoId,
  heading,
  statusEl,
  useCurrentPov = false,
  preferPanoramaDetection = true,
) {
  let fov = 90;
  let pitch = PANORAMA_DEFAULTS.pitch;
  let detectHeading = heading;
  let detectPanoId = panoId;

  const container = document.getElementById("detectionPanorama");
  const screenWidth = container?.clientWidth || 1920;
  const screenHeight = container?.clientHeight || 1080;
  const aspectRatio = screenWidth / screenHeight;

  let imgWidth, imgHeight;
  if (aspectRatio >= 1) {
    imgWidth = 640;
    imgHeight = Math.round(640 / aspectRatio);
  } else {
    imgHeight = 640;
    imgWidth = Math.round(640 * aspectRatio);
  }

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

  if (statusEl) statusEl.textContent = "Detecting parking signs...";

  try {
    let result = null;
    let detectionMode = "single-view";

    if (preferPanoramaDetection) {
      try {
        result = await runPanoramaDetection(
          detectPanoId,
          detectHeading,
          pitch,
          fov,
          statusEl,
        );
        detectionMode = "multi-slice";
      } catch (err) {
        console.warn(
          "Panorama detection unavailable, falling back to single-view detection:",
          err,
        );
        if (statusEl) {
          statusEl.textContent =
            "Panorama detector unavailable. Falling back to single-view detection...";
        }
      }
    }

    if (!result) {
      result = await runSingleViewPanoramaDetection(
        detectPanoId,
        detectHeading,
        pitch,
        fov,
        imgWidth,
        imgHeight,
      );
      detectionMode = "single-view";
    }

    currentDetections =
      detectionMode === "multi-slice"
        ? clusterAngularDetections(
            result.detections.map((det) => ({
              heading: det.heading,
              pitch: det.pitch,
              angularWidth: det.angular_width,
              angularHeight: det.angular_height,
              confidence: det.confidence,
              class_name: det.class_name,
            })),
          )
        : result.detections;

    detectionPov = { heading: detectHeading, pitch, fov };
    updateDetectionOverlay();

    const count = currentDetections.length;
    const timeMs = result.total_inference_time_ms;
    const modeSummary =
      detectionMode === "multi-slice"
        ? `${result.slices_count} slices`
        : "single view";
    if (statusEl) {
      statusEl.textContent =
        count > 0
          ? `Found ${count} parking sign${count > 1 ? "s" : ""} (${modeSummary}, ${timeMs.toFixed(0)}ms). Click a box to save.`
          : `No parking signs detected (${modeSummary}, ${timeMs.toFixed(0)}ms)`;
    }

    return result;
  } catch (err) {
    console.error("Detection error:", err);
    if (statusEl) statusEl.textContent = `Detection failed: ${err.message}`;
    throw err;
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

  if (statusEl) statusEl.textContent = "Fetching crops (tiles + static)...";

  try {
    const cropPlan = await buildDetectionCropPlan(
      det,
      panoId,
      cropCenterOverride,
    );
    const {
      session,
      metadata,
      imageWidth,
      imageHeight,
      panoHeading,
      tilt,
      cropHeading,
      cropPitch,
      uncorrected,
      corrected,
      signSize,
      detectionRelH,
      cropRelH,
      tiles,
      tileX1,
      tileY1,
      cropBounds,
      requestBody,
    } = cropPlan;

    // Current panorama viewer state
    const pov = detectionPanorama.getPov();
    const viewerFov = zoomToFov(pov.zoom || 1);

    console.log(
      `=== CROP PIPELINE ===\n` +
        `PANO: id=${panoId} heading=${panoHeading.toFixed(2)}° tilt=${tilt.toFixed(4)}°\n` +
        `VIEWER: heading=${pov.heading.toFixed(2)}° pitch=${pov.pitch.toFixed(2)}° zoom=${(pov.zoom || 1).toFixed(2)} fov=${viewerFov.toFixed(1)}°\n` +
        `DETECTION angular: heading=${det.heading.toFixed(2)}° pitch=${det.pitch.toFixed(2)}° relH=${detectionRelH.toFixed(2)}° size=${det.angularWidth.toFixed(3)}°×${det.angularHeight.toFixed(3)}° conf=${det.confidence.toFixed(2)}\n` +
        `CROP center source: ${cropCenterOverride ? `click @ (${cropCenterOverride.screenX.toFixed(1)}, ${cropCenterOverride.screenY.toFixed(1)})` : "detection center"}\n` +
        `CROP angular: heading=${cropHeading.toFixed(2)}° pitch=${cropPitch.toFixed(2)}° relH=${cropRelH.toFixed(2)}°\n` +
        `TILE GRID: ${imageWidth}×${imageHeight} (zoom 5, ${TILE_SIZE}px tiles)\n` +
        `PIXEL uncorrected: (${uncorrected.x.toFixed(1)}, ${uncorrected.y.toFixed(1)})\n` +
        `PIXEL corrected:   (${corrected.x.toFixed(1)}, ${corrected.y.toFixed(1)}) yCorrection=${corrected.yCorrection.toFixed(1)}px\n` +
        `PIXEL sign size:   ${signSize.width.toFixed(0)}×${signSize.height.toFixed(0)} (with ${CROP_PADDING_X.toFixed(2)}x/${CROP_PADDING_Y.toFixed(2)}x padding: ${Math.round(signSize.width * CROP_PADDING_X)}×${Math.round(signSize.height * CROP_PADDING_Y)})\n` +
        `TILES: origin=(${tileX1},${tileY1}) fetching=${JSON.stringify(tiles)}\n` +
        `CROP in stitched: x=${cropBounds.x} y=${cropBounds.y} w=${cropBounds.width} h=${cropBounds.height}\n` +
        `CROP center in tile grid: (${(tileX1 * TILE_SIZE + cropBounds.x + cropBounds.width / 2).toFixed(0)}, ${(tileY1 * TILE_SIZE + cropBounds.y + cropBounds.height / 2).toFixed(0)})\n` +
        `===================`,
    );

    // A/B test: fetch both tiles and static crops in parallel
    const [tilesResp, staticResult] = await Promise.allSettled([
      fetch(`${apiUrl}/crop-sign-tiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...requestBody,
          debug: true,
          save: true,
          include_image: true,
        }),
      }),
      fetchCropStatic(det, panoId, { save: true }),
    ]);

    let tilesResult = null;
    let tilesErr = null;
    if (tilesResp.status === "fulfilled" && tilesResp.value.ok) {
      const tilesJson = await tilesResp.value.json();
      if (tilesJson.image_base64) {
        tilesResult = {
          src: `data:image/jpeg;base64,${tilesJson.image_base64}`,
          width: tilesJson.width,
          height: tilesJson.height,
        };
      } else if (tilesJson.filename) {
        tilesResult = {
          src: `${apiUrl}/detected-signs/${encodeURIComponent(tilesJson.filename)}`,
          width: tilesJson.width,
          height: tilesJson.height,
        };
      }
    }
    if (!tilesResult) {
      tilesErr =
        tilesResp.status === "rejected"
          ? tilesResp.reason
          : tilesResp.status === "fulfilled" && !tilesResp.value.ok
            ? new Error(`Tiles: ${tilesResp.value.status}`)
            : new Error("Tiles: no image data");
    }

    const staticErr =
      staticResult.status === "rejected" ? staticResult.reason : null;
    const staticData =
      staticResult.status === "fulfilled" ? staticResult.value : null;

    showCropAbModal(
      tilesErr || tilesResult,
      staticErr || staticData,
      statusEl,
    );

    if (statusEl) {
      const tilesStr = tilesResult
        ? `${tilesResult.width}×${tilesResult.height}`
        : "failed";
      const staticStr = staticData
        ? `${staticData.width}×${staticData.height}`
        : "failed";
      statusEl.textContent = `A/B: Tiles ${tilesStr} | Static ${staticStr}`;
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

  const cropHeading = cropCenterOverride?.heading ?? det.heading;
  const pitchBias =
    cropCenterOverride == null && Number.isFinite(det.angularHeight)
      ? CROP_PITCH_BIAS_DOWN * det.angularHeight
      : 0;
  const cropPitch = (cropCenterOverride?.pitch ?? det.pitch) - pitchBias;
  const uncorrected = headingPitchToPixel(
    cropHeading,
    cropPitch,
    imageWidth,
    imageHeight,
    panoHeading,
  );
  const corrected = headingPitchToPixelCorrected(
    cropHeading,
    cropPitch,
    imageWidth,
    imageHeight,
    panoHeading,
    tilt,
  );
  const signSize = angularToPixelSize(
    det.angularWidth,
    det.angularHeight,
    imageWidth,
    imageHeight,
  );

  let detectionRelH = det.heading - panoHeading;
  if (detectionRelH < -180) detectionRelH += 360;
  if (detectionRelH > 180) detectionRelH -= 360;

  let cropRelH = cropHeading - panoHeading;
  if (cropRelH < -180) cropRelH += 360;
  if (cropRelH > 180) cropRelH -= 360;

  const { tiles, tileX1, tileY1, cropBounds } = getTilesForRegion(
    corrected.x,
    corrected.y,
    signSize.width,
    signSize.height,
    CROP_PADDING_X,
    CROP_PADDING_Y,
  );

  return {
    session,
    metadata,
    imageWidth,
    imageHeight,
    panoHeading,
    tilt,
    cropHeading,
    cropPitch,
    uncorrected,
    corrected,
    signSize,
    detectionRelH,
    cropRelH,
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
  if (result.image_base64) {
    return {
      src: `data:image/jpeg;base64,${result.image_base64}`,
      width: result.width,
      height: result.height,
      tilesFetched: result.tiles_fetched,
    };
  }

  if (result.image_url) {
    return {
      src: `${apiUrl}${result.image_url}`,
      width: result.width,
      height: result.height,
      tilesFetched: result.tiles_fetched,
    };
  }

  if (result.filename) {
    return {
      src: `${apiUrl}/detected-signs/${encodeURIComponent(result.filename)}`,
      width: result.width,
      height: result.height,
      tilesFetched: result.tiles_fetched,
    };
  }

  throw new Error("Preview response missing image data");
}

/**
 * Fetch sign crop using Static API at max resolution (640x640).
 * No coordinate conversion - image is centered on sign, alignment matches bbox.
 * @param {Object} options - { save: boolean } to also save to detected_signs/
 */
async function fetchCropStatic(det, panoId, options = {}) {
  const apiUrl = window.DETECTION_CONFIG?.API_URL;
  const apiKey = window.GOOGLE_CONFIG?.API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("Detection API or Google API key not configured");
  }
  const resp = await fetch(`${apiUrl}/crop-sign-static`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pano_id: panoId,
      heading: det.heading,
      pitch: det.pitch,
      angular_width: det.angularWidth ?? 0.5,
      angular_height: det.angularHeight ?? 1,
      confidence: det.confidence ?? 0,
      api_key: apiKey,
      padding: 1.5,
      save: options.save ?? true,
      include_image: true,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Static crop failed: ${errText}`);
  }
  const result = await resp.json();
  if (result.image_base64) {
    return {
      src: `data:image/jpeg;base64,${result.image_base64}`,
      width: result.width,
      height: result.height,
    };
  }
  throw new Error("Static crop response missing image data");
}

/**
 * Show A/B comparison modal with tiles vs static crop.
 */
function showCropAbModal(tilesResult, staticResult, statusEl) {
  const modal = document.getElementById("cropAbModal");
  const tilesImg = document.getElementById("cropAbTilesImg");
  const tilesMeta = document.getElementById("cropAbTilesMeta");
  const staticImg = document.getElementById("cropAbStaticImg");
  const staticMeta = document.getElementById("cropAbStaticMeta");
  const closeBtn = document.getElementById("cropAbClose");
  if (!modal || !tilesImg || !staticImg) return;

  const renderCell = (container, metaEl, result, isError) => {
    container.innerHTML = "";
    if (isError) {
      container.innerHTML = `<div class="crop-ab-error">${result}</div>`;
      if (metaEl) metaEl.textContent = "";
    } else {
      const img = document.createElement("img");
      img.src = result.src;
      img.alt = "Crop";
      container.appendChild(img);
      if (metaEl) metaEl.textContent = `${result.width}×${result.height}px`;
    }
  };

  renderCell(tilesImg, tilesMeta, tilesResult, tilesResult instanceof Error);
  renderCell(staticImg, staticMeta, staticResult, staticResult instanceof Error);

  modal.classList.add("visible");

  const close = () => {
    modal.classList.remove("visible");
    if (statusEl) statusEl.textContent = "Tap to detect";
  };

  closeBtn.onclick = close;
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
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
  } = options;
  if (streetBearing == null) {
    return null;
  }

  const trafficBearing = getTrafficBearing(streetBearing, oneway);
  // North America: parking signs are always on the driver's right-hand side.
  const resolvedSide = "right";
  const edgeOffsetMeters =
    curbOffsetMeters ?? FIXED_SIGN_CENTERLINE_OFFSET_METERS;
  const centerlineAnchor = getStreetCenterlineAnchor(cameraLat, cameraLng, {
    segmentStart,
    segmentEnd,
  });
  const headingDelta = signedAngleDeltaDegrees(signHeading, trafficBearing);
  const headingDeltaRad = (headingDelta * Math.PI) / 180;
  const rawAlongStreetDistance = distanceMeters * Math.cos(headingDeltaRad);
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
function estimateDistanceFromAngularSize(angularHeight) {
  const safeAngularHeight = clamp(angularHeight || 0, 0.6, 25);
  const angularHeightRad = (safeAngularHeight * Math.PI) / 180;
  const geometricDistance =
    PARKING_SIGN_FACE_HEIGHT_METERS / (2 * Math.tan(angularHeightRad / 2));

  return clamp(geometricDistance, 3, 80);
}

/**
 * Estimate sign distance from downward pitch.
 */
function estimateDistanceFromPitch(pitch, cameraHeight = SV_CAMERA_HEIGHT) {
  if (pitch >= -0.35) {
    return null;
  }

  const absPitchRad = (Math.abs(pitch) * Math.PI) / 180;
  const pitchDistance = cameraHeight / Math.tan(absPitchRad);
  return clamp(pitchDistance, 3, 80);
}

/**
 * Estimate the real-world location of a detected sign.
 * Uses pitch for nearby curbside signs, then increasingly trusts angular size
 * as boxes get smaller so down-the-street signs project farther out on the map.
 *
 * @param {number} cameraLat - Panorama camera latitude
 * @param {number} cameraLng - Panorama camera longitude
 * @param {Object} detection - Detection with {heading, pitch, angularHeight, confidence, class_name}
 * @param {number} [cameraHeight=2.5] - Camera height in meters
 * @returns {Object|null} {lat, lng, distance, heading, confidence, class_name} or null if unusable
 */
function estimateSignLocation(
  cameraLat,
  cameraLng,
  detection,
  cameraHeight = SV_CAMERA_HEIGHT,
) {
  const distanceAngularHeight = resolveDetectionDistanceAngularHeight(detection);
  const pitchDistance = estimateDistanceFromPitch(
    detection.pitch,
    cameraHeight,
  );
  const sizeDistance = estimateDistanceFromAngularSize(distanceAngularHeight);

  let distance;
  let method;

  if (pitchDistance != null) {
    distance = pitchDistance;
    method = "pitch";
  } else {
    distance = sizeDistance;
    method = "size";
  }

  const dest = projectLatLng(cameraLat, cameraLng, distance, detection.heading);

  return {
    lat: dest.lat,
    lng: dest.lng,
    distance,
    heading: detection.heading,
    confidence: detection.confidence,
    class_name: detection.class_name,
    distanceAngularHeight,
    method,
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
      };
    })
    .filter((loc) => loc !== null);

  return results;
}

/**
 * Clean up detection panorama when closing modal.
 */
function cleanupDetectionPanorama() {
  currentDetections = [];
  if (document.getElementById("detectionOverlay")) {
    document.getElementById("detectionOverlay").innerHTML = "";
  }
}
