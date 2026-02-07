/**
 * Parking sign detection module.
 * Handles API calls and bounding box overlay on interactive panorama.
 */

// Detection state
let detectionPanorama = null;
let currentDetections = [];  // Store detections as {heading, pitch, angularWidth, angularHeight, confidence, class_name}
let detectionPov = { heading: 0, pitch: 0, zoom: 1 };  // POV when detection was run
let povChangeListener = null;
let panoChangeListener = null;

/**
 * Calculate FOV from Street View zoom level.
 * Google's Street View uses: fov = 2 * atan(2^(1-zoom))
 * @param {number} zoom - Zoom level (typically 0-4)
 * @returns {number} Field of view in degrees
 */
function zoomToFov(zoom) {
    return Math.atan(Math.pow(2, 1 - zoom)) * 360 / Math.PI;
}

// Tile constants
const TILE_SIZE = 512;  // Street View tile size in pixels
const MAX_ZOOM = 5;     // Maximum zoom level for Street View tiles
const TILE_GRID_WIDTH = 32 * TILE_SIZE;   // 16384
const TILE_GRID_HEIGHT = 16 * TILE_SIZE;  // 8192

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
function headingPitchToPixel(heading, pitch, imageWidth, imageHeight, panoHeading = 0) {
    let h = (heading - panoHeading + 180 + 360) % 360;
    const x = (h / 360) * imageWidth;
    const y = ((90 - pitch) / 180) * imageHeight;
    return { x, y };
}

/**
 * Convert angular dimensions to pixel dimensions.
 */
function angularToPixelSize(angularWidth, angularHeight, imageWidth, imageHeight) {
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
function getTilesForRegion(x, y, width, height, padding = 1.2) {
    const pw = width * padding;
    const ph = height * padding;
    
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
        height: Math.round(ph)
    };
    
    return { tiles, tileX1, tileY1, cropBounds };
}

/**
 * Build Street View Static API URL.
 */
function getStreetViewImageUrl(panoId, heading, pitch = 0, fov = 90, width = 640, height = 640) {
    const apiKey = window.GOOGLE_CONFIG?.API_KEY;
    if (!apiKey) {
        throw new Error('Google API key not configured');
    }
    
    return `https://maps.googleapis.com/maps/api/streetview?` +
        `size=${width}x${height}` +
        `&pano=${panoId}` +
        `&heading=${heading}` +
        `&pitch=${pitch}` +
        `&fov=${fov}` +
        `&key=${apiKey}`;
}

/**
 * Run detection on a Street View image.
 */
async function runDetection(imageUrl, confidence = null) {
    const apiUrl = window.DETECTION_CONFIG?.API_URL;
    if (!apiUrl) {
        throw new Error('Detection API URL not configured');
    }

    const conf = confidence ?? window.DETECTION_CONFIG?.CONFIDENCE_THRESHOLD ?? 0.15;

    let resp;
    try {
        resp = await fetch(`${apiUrl}/detect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image_url: imageUrl,
                confidence: conf
            })
        });
    } catch (err) {
        console.error('Detection request failed:', err);
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
function detectionToAngular(det, povHeading, povPitch, hFov, imgWidth, imgHeight) {
    const centerX = (det.x1 + det.x2) / 2;
    const centerY = (det.y1 + det.y2) / 2;
    
    // Get angular position of detection center using proper 3D projection
    const centerAngular = screenToAngular(centerX, centerY, povHeading, povPitch, hFov, imgWidth, imgHeight);
    
    // Get angular positions of the four corners for accurate angular dimensions
    const topLeft = screenToAngular(det.x1, det.y1, povHeading, povPitch, hFov, imgWidth, imgHeight);
    const topRight = screenToAngular(det.x2, det.y1, povHeading, povPitch, hFov, imgWidth, imgHeight);
    const bottomLeft = screenToAngular(det.x1, det.y2, povHeading, povPitch, hFov, imgWidth, imgHeight);
    const bottomRight = screenToAngular(det.x2, det.y2, povHeading, povPitch, hFov, imgWidth, imgHeight);
    
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
        class_name: det.class_name
    };
}

/**
 * Convert heading/pitch to 3D unit direction vector.
 * Uses PanoMarker's coordinate system: +X = East, +Y = North, +Z = Up
 * This matches Google Street View's internal representation.
 */
function headingPitchToDirection(heading, pitch) {
    const toRad = deg => deg * Math.PI / 180;
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
        z: Math.sin(pitchRad)
    };
}

/**
 * Project a world direction to screen coordinates.
 * Based on PanoMarker's povToPixel3d which is known to work with Google Street View.
 * Returns null if the point is behind the camera.
 */
function directionToScreen(worldDir, povHeading, povPitch, fov, screenWidth, screenHeight) {
    const toRad = deg => deg * Math.PI / 180;
    
    const h0 = toRad(povHeading);
    const p0 = toRad(povPitch);
    const cos_p0 = Math.cos(p0);
    const sin_p0 = Math.sin(p0);
    const cos_h0 = Math.cos(h0);
    const sin_h0 = Math.sin(h0);
    
    // Focal length (distance from camera to image plane)
    const f = (screenWidth / 2) / Math.tan(toRad(fov / 2));
    
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
    const nDotC = x0 * x0 + y0 * y0 + z0 * z0;  // = f^2
    
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
function angularToScreen(angularDet, currentHeading, currentPitch, currentFov, screenWidth, screenHeight) {
    // Convert detection center to 3D direction
    const centerDir = headingPitchToDirection(angularDet.heading, angularDet.pitch);
    
    // Project to screen
    const centerScreen = directionToScreen(centerDir, currentHeading, currentPitch, currentFov, screenWidth, screenHeight);
    if (!centerScreen) return null;
    
    // For the bounding box, we need to project the corners
    const halfAngW = angularDet.angularWidth / 2;
    const halfAngH = angularDet.angularHeight / 2;
    
    // Project the four corners of the angular bounding box
    const topLeftDir = headingPitchToDirection(angularDet.heading - halfAngW, angularDet.pitch + halfAngH);
    const topRightDir = headingPitchToDirection(angularDet.heading + halfAngW, angularDet.pitch + halfAngH);
    const bottomLeftDir = headingPitchToDirection(angularDet.heading - halfAngW, angularDet.pitch - halfAngH);
    const bottomRightDir = headingPitchToDirection(angularDet.heading + halfAngW, angularDet.pitch - halfAngH);
    
    const topLeft = directionToScreen(topLeftDir, currentHeading, currentPitch, currentFov, screenWidth, screenHeight);
    const topRight = directionToScreen(topRightDir, currentHeading, currentPitch, currentFov, screenWidth, screenHeight);
    const bottomLeft = directionToScreen(bottomLeftDir, currentHeading, currentPitch, currentFov, screenWidth, screenHeight);
    const bottomRight = directionToScreen(bottomRightDir, currentHeading, currentPitch, currentFov, screenWidth, screenHeight);
    
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
        class_name: angularDet.class_name
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
    
    const container = document.getElementById('detectionPanorama');
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
function screenToAngular(screenX, screenY, povHeading, povPitch, fov, screenWidth, screenHeight) {
    const toRad = deg => deg * Math.PI / 180;
    const toDeg = rad => rad * 180 / Math.PI;
    
    const h0 = toRad(povHeading);
    const p0 = toRad(povPitch);
    const cos_p0 = Math.cos(p0);
    const sin_p0 = Math.sin(p0);
    const cos_h0 = Math.cos(h0);
    const sin_h0 = Math.sin(h0);
    
    // Focal length (must match directionToScreen)
    const f = (screenWidth / 2) / Math.tan(toRad(fov / 2));
    
    // Convert screen to pixel offsets from center
    const du = screenX - screenWidth / 2;
    const dv = screenHeight / 2 - screenY;  // Flip Y
    
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
        pitch: pitch
    };
}

// Store marked ground truth points for offset analysis
let markedPoints = [];
let cachedPanoMetadata = null;

/**
 * Apply empirical correction to tile pixel coordinates.
 * Based on analysis of measured offsets, the correction depends on:
 * - Relative heading from camera forward (cos term)
 * - Pitch (linear term)
 * - Tilt deviation from level (scales the correction)
 * 
 * Model: y_offset = (A * cos(relH + 180) + B * pitch + C) * tiltFactor
 * From 5-point calibration at tilt=91.39°: A=86.23, B=-8.12, C=-49.82
 * 
 * IMPORTANT: Only calibrated for signs BEHIND the camera (|relH| > 90°).
 * For signs in front of camera, no correction is applied.
 */
function computeYCorrection(heading, pitch, panoHeading, tilt) {
    let relH = heading - panoHeading;
    if (relH < -180) relH += 360;
    if (relH > 180) relH -= 360;
    
    // Only apply correction for signs behind the camera (|relH| > 90°)
    if (Math.abs(relH) < 90) {
        return 0;
    }
    
    // Scale correction by how much tilt differs from 90° (level)
    // Calibration was at tilt=91.39° (offset of 1.39° from level)
    const CALIBRATION_TILT_OFFSET = 1.39;
    const tiltFactor = (tilt - 90) / CALIBRATION_TILT_OFFSET;
    
    // Skip if tilt is very close to level
    if (Math.abs(tiltFactor) < 0.1) {
        return 0;
    }
    
    // Empirical coefficients from calibration data (tilt=91.39°)
    const A = 86.23;
    const B = -8.12;
    const C = -49.82;
    
    const cosTerm = Math.cos((relH + 180) * Math.PI / 180);
    const baseOffset = A * cosTerm + B * pitch + C;
    
    return baseOffset * tiltFactor;
}

/**
 * Convert heading/pitch to CORRECTED pixel coordinates for tile cropping.
 * Applies empirical correction for Google's tile stabilization.
 */
function headingPitchToPixelCorrected(heading, pitch, imageWidth, imageHeight, panoHeading = 0, tilt = 90) {
    // Base equirectangular mapping
    let h = (heading - panoHeading + 180 + 360) % 360;
    const x = (h / 360) * imageWidth;
    const yBase = ((90 - pitch) / 180) * imageHeight;
    
    // Apply empirical Y correction (only for behind-camera signs with tilted panos)
    const yCorrection = computeYCorrection(heading, pitch, panoHeading, tilt);
    const y = yBase - yCorrection;  // Subtract because offset was "crop below actual"
    
    return { x, y, yCorrection };
}

/**
 * Handle Ctrl key press to mark mouse position for coordinate data collection.
 * Hover mouse over a sign center, then press Ctrl to mark it.
 * Shows visual marker and logs data for offset analysis.
 */
async function handleSignMarking(event) {
    // Only trigger on Ctrl key press (not release, not with other keys)
    if (event.key !== 'Control' || event.repeat || !detectionPanorama) return;
    
    const container = document.getElementById('detectionPanorama');
    const screenWidth = container.clientWidth;
    const screenHeight = container.clientHeight;
    
    const screenX = lastMouseX;
    const screenY = lastMouseY;
    
    if (screenX < 0 || screenX > screenWidth || screenY < 0 || screenY > screenHeight) {
        console.log('Mouse is outside panorama area');
        return;
    }
    
    const pov = detectionPanorama.getPov();
    const currentFov = zoomToFov(pov.zoom || 1);
    const panoId = detectionPanorama.getPano();
    
    // Convert screen position to angular coordinates
    const angular = screenToAngular(screenX, screenY, pov.heading, pov.pitch, currentFov, screenWidth, screenHeight);
    
    // Get panorama metadata (cache it)
    if (!cachedPanoMetadata || cachedPanoMetadata.panoId !== panoId) {
        try {
            const session = await getSessionToken();
            const metadata = await fetchStreetViewMetadata(panoId, session);
            cachedPanoMetadata = { ...metadata, panoId };
        } catch (err) {
            console.warn('Could not fetch metadata:', err);
            cachedPanoMetadata = { heading: 0, tilt: 90, roll: 0, panoId };
        }
    }
    
    const panoHeading = cachedPanoMetadata.heading || 0;
    const tilt = cachedPanoMetadata.tilt ?? 90;
    const roll = cachedPanoMetadata.roll ?? 0;
    
    // Compute both uncorrected and corrected pixel positions
    const uncorrected = headingPitchToPixel(angular.heading, angular.pitch, TILE_GRID_WIDTH, TILE_GRID_HEIGHT, panoHeading);
    const corrected = headingPitchToPixelCorrected(angular.heading, angular.pitch, TILE_GRID_WIDTH, TILE_GRID_HEIGHT, panoHeading, tilt);
    
    // Calculate relative heading for analysis
    let relH = angular.heading - panoHeading;
    if (relH < -180) relH += 360;
    if (relH > 180) relH -= 360;
    
    // Store marked point
    const markedPoint = {
        panoId,
        panoHeading,
        tilt,
        roll,
        heading: angular.heading,
        pitch: angular.pitch,
        relH,
        screenX,
        screenY,
        uncorrectedX: uncorrected.x,
        uncorrectedY: uncorrected.y,
        correctedX: corrected.x,
        correctedY: corrected.y,
        yCorrection: corrected.yCorrection,
        timestamp: Date.now()
    };
    markedPoints.push(markedPoint);
    
    // Add visual marker on overlay
    addMarkerToOverlay(screenX, screenY, markedPoints.length);
    
    console.log(
        `MARK #${markedPoints.length}: h=${angular.heading.toFixed(2)}° p=${angular.pitch.toFixed(2)}° relH=${relH.toFixed(2)}° tilt=${tilt.toFixed(2)}°\n` +
        `  uncorrected: (${uncorrected.x.toFixed(0)}, ${uncorrected.y.toFixed(0)}) corrected: (${corrected.x.toFixed(0)}, ${corrected.y.toFixed(0)}) yCorr=${corrected.yCorrection.toFixed(1)}px`
    );
    
    // Update status
    const statusEl = document.getElementById('status') || document.getElementById('detectionStatus');
    if (statusEl) {
        statusEl.textContent = `Marked point #${markedPoints.length} at h=${angular.heading.toFixed(1)}° p=${angular.pitch.toFixed(1)}° (correction: ${corrected.yCorrection.toFixed(0)}px)`;
    }
}

/**
 * Add visual marker to the detection overlay.
 */
function addMarkerToOverlay(screenX, screenY, number) {
    const overlay = document.getElementById('detectionOverlay');
    if (!overlay) return;
    
    // Create marker group
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.classList.add('sign-marker');
    g.setAttribute('data-marker-num', number);
    
    // Crosshair
    const size = 12;
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', screenX - size);
    line1.setAttribute('y1', screenY);
    line1.setAttribute('x2', screenX + size);
    line1.setAttribute('y2', screenY);
    line1.setAttribute('stroke', '#00ff00');
    line1.setAttribute('stroke-width', '2');
    
    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', screenX);
    line2.setAttribute('y1', screenY - size);
    line2.setAttribute('x2', screenX);
    line2.setAttribute('y2', screenY + size);
    line2.setAttribute('stroke', '#00ff00');
    line2.setAttribute('stroke-width', '2');
    
    // Number label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', screenX + size + 4);
    text.setAttribute('y', screenY - size);
    text.setAttribute('fill', '#00ff00');
    text.setAttribute('font-size', '14');
    text.setAttribute('font-weight', 'bold');
    text.textContent = `#${number}`;
    
    g.appendChild(line1);
    g.appendChild(line2);
    g.appendChild(text);
    overlay.appendChild(g);
}

/**
 * Clear all marked points and visual markers.
 */
function clearMarkedPoints() {
    markedPoints = [];
    cachedPanoMetadata = null;
    const overlay = document.getElementById('detectionOverlay');
    if (overlay) {
        overlay.querySelectorAll('.sign-marker').forEach(el => el.remove());
    }
    console.log('Cleared all marked points');
}

/**
 * Update SVG overlay with detection boxes.
 */
function updateDetectionOverlay() {
    const overlay = document.getElementById('detectionOverlay');
    if (!overlay || !detectionPanorama) return;
    
    const pov = detectionPanorama.getPov();
    const container = document.getElementById('detectionPanorama');
    const width = container.clientWidth;
    const height = container.clientHeight;
    const fov = zoomToFov(pov.zoom || 1);
    
    // Clear existing boxes (but keep markers)
    overlay.querySelectorAll(':not(.sign-marker)').forEach(el => el.remove());
    
    // Draw each detection if visible
    for (const det of currentDetections) {
        const screen = angularToScreen(det, pov.heading, pov.pitch, fov, width, height);
        if (!screen) continue;
        
        // Color based on confidence
        const hue = det.confidence * 120;
        const color = `hsl(${hue}, 100%, 50%)`;
        
        // Create clickable rect
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', screen.x);
        rect.setAttribute('y', screen.y);
        rect.setAttribute('width', screen.width);
        rect.setAttribute('height', screen.height);
        rect.setAttribute('fill', 'rgba(255, 255, 255, 0.1)');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', '3');
        rect.style.cursor = 'pointer';
        rect.style.transition = 'all 0.15s ease';
        rect.style.pointerEvents = 'auto';
        
        // Hover effects
        rect.addEventListener('mouseenter', () => {
            rect.setAttribute('stroke-width', '5');
            rect.setAttribute('fill', 'rgba(255, 255, 255, 0.3)');
            rect.style.filter = 'drop-shadow(0 0 8px rgba(255, 255, 255, 0.8))';
        });
        rect.addEventListener('mouseleave', () => {
            rect.setAttribute('stroke-width', '3');
            rect.setAttribute('fill', 'rgba(255, 255, 255, 0.1)');
            rect.style.filter = 'none';
        });
        
        // Click to save sign
        rect.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            
            cropAndSaveSign(det);
        });
        rect.addEventListener('mousedown', (e) => e.stopPropagation());
        rect.addEventListener('mouseup', (e) => e.stopPropagation());
        overlay.appendChild(rect);
        
        // Create label
        const label = `${det.class_name} ${Math.round(det.confidence * 100)}%`;
        const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelBg.setAttribute('x', screen.x);
        labelBg.setAttribute('y', screen.y - 20);
        labelBg.setAttribute('width', label.length * 8 + 8);
        labelBg.setAttribute('height', '18');
        labelBg.setAttribute('fill', color);
        overlay.appendChild(labelBg);
        
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', screen.x + 4);
        text.setAttribute('y', screen.y - 6);
        text.setAttribute('fill', 'white');
        text.setAttribute('font-size', '12');
        text.setAttribute('font-weight', 'bold');
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
            fullscreenControl: false
        });
        
        povChangeListener = detectionPanorama.addListener('pov_changed', updateDetectionOverlay);
        panoChangeListener = detectionPanorama.addListener('pano_changed', clearDetections);
        
        // Track mouse position at document level (works over bounding boxes too)
        document.addEventListener('mousemove', trackMousePosition);
        document.addEventListener('keydown', handleSignMarking);
        document.addEventListener('keydown', handleMarkerKeyboard);
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
    if (event.key === 'Escape' && markedPoints.length > 0) {
        clearMarkedPoints();
        const statusEl = document.getElementById('status') || document.getElementById('detectionStatus');
        if (statusEl) statusEl.textContent = 'Markers cleared. Ctrl+click to mark sign centers.';
    }
}

/**
 * Clear current detections.
 */
function clearDetections() {
    currentDetections = [];
    updateDetectionOverlay();
    
    const statusEl = document.getElementById('detectionStatus');
    if (statusEl) {
        statusEl.textContent = 'Panorama changed. Click "Detect" to scan for parking signs';
    }
}

/**
 * Run detection and display results on panorama.
 */
async function runDetectionOnPanorama(panoId, heading, statusEl, useCurrentPov = false) {
    let fov = 90;
    let pitch = PANORAMA_DEFAULTS.pitch;
    let detectHeading = heading;
    let detectPanoId = panoId;
    
    const container = document.getElementById('detectionPanorama');
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

        if (typeof detectionPanorama.getPano === 'function') {
            const currentPano = detectionPanorama.getPano();
            if (currentPano) detectPanoId = currentPano;
        }
    }
    
    const imageUrl = getStreetViewImageUrl(detectPanoId, detectHeading, pitch, fov, imgWidth, imgHeight);
    
    if (statusEl) statusEl.textContent = 'Detecting parking signs...';
    
    try {
        const result = await runDetection(imageUrl);
        
        currentDetections = result.detections.map(det => 
            detectionToAngular(det, detectHeading, pitch, fov, imgWidth, imgHeight)
        );
        
        detectionPov = { heading: detectHeading, pitch, fov };
        updateDetectionOverlay();
        
        const count = result.detections.length;
        const timeMs = result.inference_time_ms;
        if (statusEl) {
            statusEl.textContent = count > 0 
                ? `Found ${count} parking sign${count > 1 ? 's' : ''} (${timeMs}ms). Click a box to save.`
                : `No parking signs detected (${timeMs}ms)`;
        }
        
        return result;
    } catch (err) {
        console.error('Detection error:', err);
        if (statusEl) statusEl.textContent = `Detection failed: ${err.message}`;
        throw err;
    }
}

/**
 * Crop and save sign using high-resolution tiles.
 */
async function cropAndSaveSign(det) {
    const statusEl = document.getElementById('status') || document.getElementById('detectionStatus');
    const apiUrl = window.DETECTION_CONFIG?.API_URL;
    
    if (!apiUrl || !detectionPanorama) {
        if (statusEl) statusEl.textContent = 'Cannot save: API not configured';
        return;
    }
    
    const panoId = detectionPanorama.getPano();
    if (!panoId) {
        if (statusEl) statusEl.textContent = 'Cannot save: no panorama loaded';
        return;
    }
    
    if (statusEl) statusEl.textContent = 'Saving sign...';
    
    try {
        const session = await getSessionToken();
        const metadata = await fetchStreetViewMetadata(panoId, session);
        
        const imageWidth = TILE_GRID_WIDTH;
        const imageHeight = TILE_GRID_HEIGHT;
        const panoHeading = metadata.heading || 0;
        const tilt = metadata.tilt ?? 90;
        
        // Compute both uncorrected and corrected coordinates for comparison
        const uncorrected = headingPitchToPixel(det.heading, det.pitch, imageWidth, imageHeight, panoHeading);
        const corrected = headingPitchToPixelCorrected(det.heading, det.pitch, imageWidth, imageHeight, panoHeading, tilt);
        const signSize = angularToPixelSize(det.angularWidth, det.angularHeight, imageWidth, imageHeight);
        
        // Calculate relative heading for context
        let relH = det.heading - panoHeading;
        if (relH < -180) relH += 360;
        if (relH > 180) relH -= 360;
        
        console.log(
            `CROP DEBUG: pano=${panoId} panoH=${panoHeading.toFixed(1)}° tilt=${(metadata.tilt ?? 90).toFixed(2)}°\n` +
            `  detection: h=${det.heading.toFixed(2)}° p=${det.pitch.toFixed(2)}° relH=${relH.toFixed(2)}° size=${det.angularWidth.toFixed(2)}°x${det.angularHeight.toFixed(2)}°\n` +
            `  uncorrected: (${uncorrected.x.toFixed(0)}, ${uncorrected.y.toFixed(0)}) corrected: (${corrected.x.toFixed(0)}, ${corrected.y.toFixed(0)}) yCorr=${corrected.yCorrection.toFixed(1)}px size=${signSize.width.toFixed(0)}x${signSize.height.toFixed(0)}`
        );
        
        // Use corrected coordinates with 1.2x padding
        const { tiles, tileX1, tileY1, cropBounds } = getTilesForRegion(
            corrected.x, corrected.y, signSize.width, signSize.height, 1.2
        );
        
        const resp = await fetch(`${apiUrl}/crop-sign-tiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pano_id: panoId,
                tiles: tiles,
                tile_x1: tileX1,
                tile_y1: tileY1,
                crop_x: cropBounds.x,
                crop_y: cropBounds.y,
                crop_width: cropBounds.width,
                crop_height: cropBounds.height,
                confidence: det.confidence,
                api_key: window.GOOGLE_CONFIG?.API_KEY,
                session_token: session
            })
        });
        
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Save failed: ${resp.status} - ${errText}`);
        }
        
        const result = await resp.json();
        
        if (statusEl) {
            statusEl.textContent = `Saved: ${result.filename} (${result.width}x${result.height}px)`;
        }
        
    } catch (err) {
        console.error('Save error:', err);
        if (statusEl) statusEl.textContent = `Save failed: ${err.message}`;
    }
}

/**
 * Clean up detection panorama when closing modal.
 */
function cleanupDetectionPanorama() {
    currentDetections = [];
    if (document.getElementById('detectionOverlay')) {
        document.getElementById('detectionOverlay').innerHTML = '';
    }
}
