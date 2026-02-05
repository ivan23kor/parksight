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
 * Convert heading/pitch to pixel coordinates in the full panorama.
 * Uses equirectangular projection.
 */
function headingPitchToPixel(heading, pitch, imageWidth, imageHeight, panoHeading = 0) {
    // Convert compass heading to panorama-relative heading
    // Add 180° because x=0 is the BACK of the panorama, not the front
    let h = (heading - panoHeading + 180 + 360) % 360;
    
    // Equirectangular projection
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

/**
 * Handle Ctrl key press to mark mouse position for coordinate data collection.
 * Hover mouse over a sign, then press Ctrl to log coordinate data.
 */
async function handleSignMarking(event) {
    // Only trigger on Ctrl key press (not release, not with other keys)
    if (event.key !== 'Control' || event.repeat || !detectionPanorama) return;
    
    const container = document.getElementById('detectionPanorama');
    const screenWidth = container.clientWidth;
    const screenHeight = container.clientHeight;
    
    // Use mouse position
    const screenX = lastMouseX;
    const screenY = lastMouseY;
    
    // Check if mouse is within the panorama
    if (screenX < 0 || screenX > screenWidth || screenY < 0 || screenY > screenHeight) {
        console.log('Mouse is outside panorama area');
        return;
    }
    
    const pov = detectionPanorama.getPov();
    const currentFov = zoomToFov(pov.zoom || 1);
    const panoId = detectionPanorama.getPano();
    
    // Convert screen position to angular coordinates
    const angular = screenToAngular(screenX, screenY, pov.heading, pov.pitch, currentFov, screenWidth, screenHeight);
    
    // Get panorama metadata
    let panoHeading = 0;
    try {
        const session = await getSessionToken();
        const metadata = await fetchStreetViewMetadata(panoId, session);
        panoHeading = metadata.heading || 0;
    } catch (err) {
        console.warn('Could not fetch metadata:', err);
    }
    
    // Convert to equirectangular at MAX zoom (for cropping)
    const maxZoomPixel = headingPitchToPixel(angular.heading, angular.pitch, TILE_GRID_WIDTH, TILE_GRID_HEIGHT, panoHeading);
    
    // Calculate what screen position this would map to if we go from max zoom -> current view
    // This tests our round-trip conversion
    const backToAngular = pixelToHeadingPitch(maxZoomPixel.x, maxZoomPixel.y, TILE_GRID_WIDTH, TILE_GRID_HEIGHT, panoHeading);
    
    // Test screen round-trip using proper 3D projection
    const worldDir = headingPitchToDirection(backToAngular.heading, backToAngular.pitch);
    const backToScreenPos = directionToScreen(worldDir, pov.heading, pov.pitch, currentFov, screenWidth, screenHeight);
    const backToScreenX = backToScreenPos ? backToScreenPos.x : NaN;
    const backToScreenY = backToScreenPos ? backToScreenPos.y : NaN;
    
    // Log comprehensive data (using JSON.stringify for auto-expanded output)
    console.log('=== SIGN MARKING DATA ===');
    console.log('Mouse Position (screen): ' + JSON.stringify({
        x: screenX.toFixed(1),
        y: screenY.toFixed(1),
        screenWidth,
        screenHeight
    }));
    console.log('Current View: ' + JSON.stringify({
        povHeading: pov.heading.toFixed(2),
        povPitch: pov.pitch.toFixed(2),
        zoom: pov.zoom?.toFixed(2),
        fov: currentFov.toFixed(2)
    }));
    console.log('Angular Position: ' + JSON.stringify({
        heading: angular.heading.toFixed(4),
        pitch: angular.pitch.toFixed(4)
    }));
    console.log('Max Zoom Equirectangular (crop coords): ' + JSON.stringify({
        x: maxZoomPixel.x.toFixed(1),
        y: maxZoomPixel.y.toFixed(1),
        panoHeading: panoHeading.toFixed(2),
        gridSize: `${TILE_GRID_WIDTH}x${TILE_GRID_HEIGHT}`
    }));
    console.log('Round-trip back to angular: ' + JSON.stringify({
        heading: backToAngular.heading.toFixed(4),
        pitch: backToAngular.pitch.toFixed(4),
        headingDelta: (backToAngular.heading - angular.heading).toFixed(4),
        pitchDelta: (backToAngular.pitch - angular.pitch).toFixed(4)
    }));
    console.log('Round-trip back to screen (direct calc): ' + JSON.stringify({
        x: backToScreenX.toFixed(1),
        y: backToScreenY.toFixed(1),
        deltaX: (backToScreenX - screenX).toFixed(1),
        deltaY: (backToScreenY - screenY).toFixed(1)
    }));
    
    // Draw a marker at the mouse position
    const overlay = document.getElementById('detectionOverlay');
    if (overlay) {
        // Remove previous markers
        overlay.querySelectorAll('.sign-marker').forEach(el => el.remove());
        
        // Draw crosshair at mouse position (lime = where you clicked)
        const crosshairSize = 30;
        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        marker.classList.add('sign-marker');
        
        // Horizontal line
        const hLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hLine.setAttribute('x1', screenX - crosshairSize);
        hLine.setAttribute('y1', screenY);
        hLine.setAttribute('x2', screenX + crosshairSize);
        hLine.setAttribute('y2', screenY);
        hLine.setAttribute('stroke', 'lime');
        hLine.setAttribute('stroke-width', '3');
        marker.appendChild(hLine);
        
        // Vertical line
        const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        vLine.setAttribute('x1', screenX);
        vLine.setAttribute('y1', screenY - crosshairSize);
        vLine.setAttribute('x2', screenX);
        vLine.setAttribute('y2', screenY + crosshairSize);
        vLine.setAttribute('stroke', 'lime');
        vLine.setAttribute('stroke-width', '3');
        marker.appendChild(vLine);
        
        // If round-trip gives different position, show that too (red = round-trip result)
        if (Math.abs(backToScreenX - screenX) > 2 || Math.abs(backToScreenY - screenY) > 2) {
            const rtLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            rtLine.setAttribute('x1', screenX);
            rtLine.setAttribute('y1', screenY);
            rtLine.setAttribute('x2', backToScreenX);
            rtLine.setAttribute('y2', backToScreenY);
            rtLine.setAttribute('stroke', 'red');
            rtLine.setAttribute('stroke-width', '2');
            rtLine.setAttribute('stroke-dasharray', '4,4');
            marker.appendChild(rtLine);
            
            // Small circle at round-trip position
            const rtCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            rtCircle.setAttribute('cx', backToScreenX);
            rtCircle.setAttribute('cy', backToScreenY);
            rtCircle.setAttribute('r', '8');
            rtCircle.setAttribute('fill', 'none');
            rtCircle.setAttribute('stroke', 'red');
            rtCircle.setAttribute('stroke-width', '2');
            marker.appendChild(rtCircle);
        }
        
        overlay.appendChild(marker);
    }
    
    console.log('=========================');
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
            
            // Log detection coordinates for comparison with Ctrl+mark
            const panoId = detectionPanorama.getPano();
            let panoHeading = 0;
            try {
                const session = await getSessionToken();
                const metadata = await fetchStreetViewMetadata(panoId, session);
                panoHeading = metadata.heading || 0;
            } catch (err) {}
            
            const eqPixel = headingPitchToPixel(det.heading, det.pitch, TILE_GRID_WIDTH, TILE_GRID_HEIGHT, panoHeading);
            console.log('=== DETECTION BOX COORDINATES ===');
            console.log('Angular: ' + JSON.stringify({ heading: det.heading.toFixed(4), pitch: det.pitch.toFixed(4) }));
            console.log('Equirectangular: ' + JSON.stringify({ x: eqPixel.x.toFixed(1), y: eqPixel.y.toFixed(1) }));
            console.log('Detection FOV was: ' + (detectionPov.fov?.toFixed(2) || 'unknown'));
            console.log('Compare with Ctrl+mark on same sign to check for offset');
            console.log('=================================');
            
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
    }
    
    currentDetections = [];
    updateDetectionOverlay();
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
        
        const signCenter = headingPitchToPixel(det.heading, det.pitch, imageWidth, imageHeight, panoHeading);
        const signSize = angularToPixelSize(det.angularWidth, det.angularHeight, imageWidth, imageHeight);
        
        const { tiles, tileX1, tileY1, cropBounds } = getTilesForRegion(
            signCenter.x, signCenter.y, signSize.width, signSize.height
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
