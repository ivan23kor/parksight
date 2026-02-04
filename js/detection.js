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
let zoomedDetection = null;  // Currently zoomed detection (for save-on-second-click)

/**
 * Calculate FOV from Street View zoom level.
 * Google's Street View uses: fov = 2 * atan(2^(1-zoom))
 * This is more accurate than the simplified 180/2^zoom formula.
 * Source: https://stackoverflow.com/questions/32808818
 * @param {number} zoom - Zoom level (typically 0-4)
 * @returns {number} Field of view in degrees
 */
function zoomToFov(zoom) {
    return Math.atan(Math.pow(2, 1 - zoom)) * 360 / Math.PI;
}

// Tile constants
const TILE_SIZE = 512;  // Street View tile size in pixels
const MAX_ZOOM = 5;     // Maximum zoom level for Street View tiles
// At zoom level 5: 32 tiles wide × 16 tiles tall = 16384 × 8192 pixels
const TILE_GRID_WIDTH = 32 * TILE_SIZE;   // 16384
const TILE_GRID_HEIGHT = 16 * TILE_SIZE;  // 8192

/**
 * Convert heading/pitch to pixel coordinates in the full panorama.
 * Uses equirectangular projection.
 * @param {number} heading - Heading in degrees (compass coords, 0=North)
 * @param {number} pitch - Pitch in degrees (-90 to 90)
 * @param {number} imageWidth - Full panorama width in pixels
 * @param {number} imageHeight - Full panorama height in pixels
 * @param {number} panoHeading - Panorama's orientation from metadata (compass heading of pano front)
 * @returns {{x: number, y: number}} Pixel coordinates
 */
function headingPitchToPixel(heading, pitch, imageWidth, imageHeight, panoHeading = 0) {
    // Convert compass heading to panorama-relative heading
    // Tile grid x=0 is the panorama's front direction (panoHeading in compass coords)
    let h = (heading - panoHeading + 360) % 360;
    
    // Equirectangular projection:
    // x = (heading / 360) * imageWidth
    // y = ((90 - pitch) / 180) * imageHeight
    const x = (h / 360) * imageWidth;
    const y = ((90 - pitch) / 180) * imageHeight;
    
    return { x, y };
}

/**
 * Convert angular dimensions to pixel dimensions.
 * @param {number} angularWidth - Width in degrees
 * @param {number} angularHeight - Height in degrees
 * @param {number} imageWidth - Full panorama width
 * @param {number} imageHeight - Full panorama height
 * @returns {{width: number, height: number}} Pixel dimensions
 */
function angularToPixelSize(angularWidth, angularHeight, imageWidth, imageHeight) {
    const width = (angularWidth / 360) * imageWidth;
    const height = (angularHeight / 180) * imageHeight;
    return { width, height };
}

/**
 * Get tile coordinates that cover a pixel region.
 * @param {number} x - Center x in pixels
 * @param {number} y - Center y in pixels  
 * @param {number} width - Width in pixels
 * @param {number} height - Height in pixels
 * @param {number} padding - Padding multiplier (1.2 = 20% padding)
 * @returns {{tiles: Array, cropBounds: Object}} Tile coords and crop bounds within stitched image
 */
function getTilesForRegion(x, y, width, height, padding = 1.2) {
    // Apply padding
    const pw = width * padding;
    const ph = height * padding;
    
    // Calculate bounds
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
    
    return {
        tiles,
        tileX1,
        tileY1,
        cropBounds
    };
}

/**
 * Build Street View Static API URL.
 * @param {string} panoId - Panorama ID
 * @param {number} heading - View heading in degrees
 * @param {number} pitch - View pitch in degrees
 * @param {number} fov - Field of view in degrees
 * @param {number} width - Image width (default 640)
 * @param {number} height - Image height (default 640)
 * @returns {string} Street View Static API URL
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
 * @param {string} imageUrl - URL of the image to analyze
 * @param {number} confidence - Confidence threshold (0-1)
 * @returns {Promise<Object>} Detection response with boxes and timing
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
        // Fetch throws a TypeError for network-level failures (connection refused, blocked by client,
        // CORS issues, etc.). Give a more actionable message.
        console.error('Detection request failed before reaching the server.', { apiUrl, err });

        const msg = `Can't reach the detection API (${apiUrl}). ` +
            `Make sure the backend is running (try ${apiUrl}/health). ` +
            `If you see net::ERR_BLOCKED_BY_CLIENT, disable/whitelist ad blockers or privacy extensions for localhost.`;

        throw new Error(msg);
    }

    if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`Detection failed: ${resp.status} - ${errorText}`);
    }

    return resp.json();
}

/**
 * Convert pixel coordinates to angular coordinates relative to POV.
 * Uses linear mapping (degrees per pixel).
 * @param {number} x - Pixel x
 * @param {number} y - Pixel y
 * @param {number} hFov - Horizontal field of view in degrees
 * @param {number} imgWidth - Image width
 * @param {number} imgHeight - Image height
 * @returns {{headingOffset: number, pitchOffset: number}}
 */
function pixelToAngular(x, y, hFov, imgWidth, imgHeight) {
    // Center of image is (0, 0) in angular terms
    const centerX = imgWidth / 2;
    const centerY = imgHeight / 2;
    
    // Vertical FOV based on aspect ratio
    const vFov = hFov * (imgHeight / imgWidth);
    
    // Linear mapping: degrees per pixel
    const degreesPerPixelX = hFov / imgWidth;
    const degreesPerPixelY = vFov / imgHeight;
    
    const headingOffset = (x - centerX) * degreesPerPixelX;
    const pitchOffset = -(y - centerY) * degreesPerPixelY;  // Y is inverted
    
    return { headingOffset, pitchOffset };
}

/**
 * Convert detection box to angular coordinates.
 * @param {Object} det - Detection {x1, y1, x2, y2, confidence, class_name}
 * @param {number} povHeading - POV heading when detected
 * @param {number} povPitch - POV pitch when detected
 * @param {number} hFov - Horizontal field of view
 * @param {number} imgWidth - Image width
 * @param {number} imgHeight - Image height
 * @returns {Object} Angular detection
 */
function detectionToAngular(det, povHeading, povPitch, hFov, imgWidth, imgHeight) {
    const centerX = (det.x1 + det.x2) / 2;
    const centerY = (det.y1 + det.y2) / 2;
    const width = det.x2 - det.x1;
    const height = det.y2 - det.y1;
    
    const { headingOffset, pitchOffset } = pixelToAngular(centerX, centerY, hFov, imgWidth, imgHeight);
    
    // Linear angular size
    const vFov = hFov * (imgHeight / imgWidth);
    const degreesPerPixelX = hFov / imgWidth;
    const degreesPerPixelY = vFov / imgHeight;
    
    return {
        heading: povHeading + headingOffset,
        pitch: povPitch + pitchOffset,
        angularWidth: width * degreesPerPixelX,
        angularHeight: height * degreesPerPixelY,
        confidence: det.confidence,
        class_name: det.class_name
    };
}

/**
 * Convert angular detection back to screen coordinates using gnomonic projection.
 * @param {Object} angularDet - Angular detection
 * @param {number} currentHeading - Current POV heading
 * @param {number} currentPitch - Current POV pitch
 * @param {number} currentFov - Current horizontal FOV
 * @param {number} screenWidth - Screen width
 * @param {number} screenHeight - Screen height
 * @returns {Object|null} Screen coordinates or null if out of view
 */
function angularToScreen(angularDet, currentHeading, currentPitch, currentFov, screenWidth, screenHeight) {
    const toRad = deg => deg * Math.PI / 180;
    
    // Calculate heading difference (handle wrap-around)
    let headingDiff = angularDet.heading - currentHeading;
    if (headingDiff > 180) headingDiff -= 360;
    if (headingDiff < -180) headingDiff += 360;
    
    const pitchDiff = angularDet.pitch - currentPitch;
    
    // Check if roughly in view
    const halfHFov = currentFov / 2;
    if (Math.abs(headingDiff) > Math.min(85, halfHFov + 20)) return null;
    if (Math.abs(pitchDiff) > 60) return null;
    
    // Gnomonic projection: x = f * tan(angle)
    // f = (screenWidth / 2) / tan(hFov / 2)
    const focalLength = (screenWidth / 2) / Math.tan(toRad(currentFov / 2));
    
    const headingRad = toRad(headingDiff);
    const pitchRad = toRad(pitchDiff);
    
    const centerX = screenWidth / 2 + focalLength * Math.tan(headingRad);
    const centerY = screenHeight / 2 - focalLength * Math.tan(pitchRad);
    
    // Box size using gnomonic projection for edges
    const halfAngW = angularDet.angularWidth / 2;
    const halfAngH = angularDet.angularHeight / 2;
    
    const leftX = screenWidth / 2 + focalLength * Math.tan(toRad(headingDiff - halfAngW));
    const rightX = screenWidth / 2 + focalLength * Math.tan(toRad(headingDiff + halfAngW));
    const topY = screenHeight / 2 - focalLength * Math.tan(toRad(pitchDiff + halfAngH));
    const bottomY = screenHeight / 2 - focalLength * Math.tan(toRad(pitchDiff - halfAngH));
    
    const width = rightX - leftX;
    const height = bottomY - topY;
    
    // Visibility check
    if (centerX + width / 2 < 0 || centerX - width / 2 > screenWidth) return null;
    if (centerY + height / 2 < 0 || centerY - height / 2 > screenHeight) return null;
    
    return {
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
        confidence: angularDet.confidence,
        class_name: angularDet.class_name
    };
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
    
    // Calculate current FOV from zoom
    const fov = zoomToFov(pov.zoom || 1);
    
    // Store debug info for Ctrl+click measurement (no logging)
    if (currentDetections.length > 0) {
        const det = currentDetections[0];
        let headingDiff = det.heading - pov.heading;
        if (headingDiff > 180) headingDiff -= 360;
        if (headingDiff < -180) headingDiff += 360;
        const pitchDiff = det.pitch - pov.pitch;
        
        const toRad = deg => deg * Math.PI / 180;
        const focalLength = (width / 2) / Math.tan(toRad(fov / 2));
        const calcX = width / 2 + focalLength * Math.tan(toRad(headingDiff));
        const calcY = height / 2 - focalLength * Math.tan(toRad(pitchDiff));
        
        window._calcBoxCenter = { x: calcX, y: calcY, headingDiff, pitchDiff, zoom: pov.zoom, fov, width, height };
    }
    
    // Clear existing boxes
    overlay.innerHTML = '';
    
    // Ctrl+click handler for measurement - attach to container, not overlay
    const panoContainer = document.getElementById('detectionPanorama');
    if (panoContainer && !panoContainer._measurementHandlerAttached) {
        panoContainer._measurementHandlerAttached = true;
        panoContainer.addEventListener('click', (e) => {
            if (!e.ctrlKey) return;  // Only on Ctrl+click
            e.preventDefault();
            e.stopPropagation();
            
            const rect = panoContainer.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickY = e.clientY - rect.top;
            
            if (window._calcBoxCenter) {
                const calc = window._calcBoxCenter;
                const centerX = calc.width / 2;
                const centerY = calc.height / 2;
                
                const dataPoint = {
                    zoom: calc.zoom,
                    fov: calc.fov,
                    headingDiff: Math.round(calc.headingDiff * 100) / 100,
                    pitchDiff: Math.round(calc.pitchDiff * 100) / 100,
                    calcX: Math.round(calc.x),
                    calcY: Math.round(calc.y),
                    actualX: Math.round(clickX),
                    actualY: Math.round(clickY),
                    // Ratio: how far actual is vs calculated (from center)
                    ratioX: calc.x !== centerX ? ((clickX - centerX) / (calc.x - centerX)).toFixed(3) : 'N/A',
                    ratioY: calc.y !== centerY ? ((clickY - centerY) / (calc.y - centerY)).toFixed(3) : 'N/A'
                };
                
                console.log('MEASUREMENT:', JSON.stringify(dataPoint));
                window._measurements = window._measurements || [];
                window._measurements.push(dataPoint);
            }
        }, true);  // Use capture phase
    }
    
    // Debug: draw measurement grid
    // Center crosshair
    const centerLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    centerLine.setAttribute('x1', width / 2);
    centerLine.setAttribute('y1', 0);
    centerLine.setAttribute('x2', width / 2);
    centerLine.setAttribute('y2', height);
    centerLine.setAttribute('stroke', 'rgba(255,255,0,0.5)');
    centerLine.setAttribute('stroke-width', '1');
    overlay.appendChild(centerLine);
    
    const hCenterLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    hCenterLine.setAttribute('x1', 0);
    hCenterLine.setAttribute('y1', height / 2);
    hCenterLine.setAttribute('x2', width);
    hCenterLine.setAttribute('y2', height / 2);
    hCenterLine.setAttribute('stroke', 'rgba(255,255,0,0.5)');
    hCenterLine.setAttribute('stroke-width', '1');
    overlay.appendChild(hCenterLine);
    
    // Grid lines every 100px with labels
    for (let x = 0; x <= width; x += 100) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x);
        line.setAttribute('y1', 0);
        line.setAttribute('x2', x);
        line.setAttribute('y2', height);
        line.setAttribute('stroke', 'rgba(255,255,255,0.2)');
        line.setAttribute('stroke-width', '1');
        overlay.appendChild(line);
        
        // Label showing pixels from center
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', x + 2);
        label.setAttribute('y', 12);
        label.setAttribute('fill', 'rgba(255,255,255,0.6)');
        label.setAttribute('font-size', '10');
        label.textContent = `${Math.round(x - width/2)}px`;
        overlay.appendChild(label);
    }
    
    for (let y = 0; y <= height; y += 100) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', 0);
        line.setAttribute('y1', y);
        line.setAttribute('x2', width);
        line.setAttribute('y2', y);
        line.setAttribute('stroke', 'rgba(255,255,255,0.2)');
        line.setAttribute('stroke-width', '1');
        overlay.appendChild(line);
    }
    
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
        rect.setAttribute('fill', 'rgba(255, 255, 255, 0.1)');  // Slight fill for clickable area
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', '3');
        rect.style.cursor = 'pointer';
        rect.style.transition = 'all 0.15s ease';
        rect.style.pointerEvents = 'auto';  // Override parent's pointer-events: none
        
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
        
        // Click to zoom/save sign - stop propagation to prevent panorama interaction
        rect.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            handleDetectionClick(det);
        });
        rect.addEventListener('mousedown', (e) => e.stopPropagation());
        rect.addEventListener('mouseup', (e) => e.stopPropagation());
        overlay.appendChild(rect);
        
        // Create label background
        const label = `${det.class_name} ${Math.round(det.confidence * 100)}%`;
        const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        labelBg.setAttribute('x', screen.x);
        labelBg.setAttribute('y', screen.y - 20);
        labelBg.setAttribute('width', label.length * 8 + 8);
        labelBg.setAttribute('height', '18');
        labelBg.setAttribute('fill', color);
        overlay.appendChild(labelBg);
        
        // Create label text
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
 * @param {string} panoId - Panorama ID
 * @param {number} heading - Initial heading
 * @param {HTMLElement} container - Container element
 */
function initDetectionPanorama(panoId, heading, container) {
    const pov = getDefaultPov(heading);
    
    if (detectionPanorama) {
        // Update existing panorama
        detectionPanorama.setPano(panoId);
        detectionPanorama.setPov(pov);
    } else {
        // Create new panorama
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
        
        // Listen for POV changes to update overlay (zoom/pan preserves boxes)
        povChangeListener = detectionPanorama.addListener('pov_changed', updateDetectionOverlay);
        
        // Listen for pano changes (user clicks to navigate) to clear detections
        panoChangeListener = detectionPanorama.addListener('pano_changed', clearDetections);
    }
    
    // Clear detections
    currentDetections = [];
    updateDetectionOverlay();
}

/**
 * Clear current detections (called when panorama changes).
 */
function clearDetections() {
    currentDetections = [];
    zoomedDetection = null;
    updateDetectionOverlay();
    
    // Update status to prompt user to re-detect
    const statusEl = document.getElementById('detectionStatus');
    if (statusEl) {
        statusEl.textContent = 'Panorama changed. Click "Detect" to scan for parking signs';
    }
}

/**
 * Run detection and display results on panorama.
 * @param {string} panoId - Panorama ID
 * @param {number} heading - View heading (optional, uses current POV if not provided)
 * @param {HTMLElement} statusEl - Status element
 * @param {boolean} useCurrentPov - If true, use current panorama POV instead of passed heading
 * @returns {Promise<Object>} Detection results
 */
async function runDetectionOnPanorama(panoId, heading, statusEl, useCurrentPov = false) {
    let fov = 90;  // Default FOV for detection
    let pitch = PANORAMA_DEFAULTS.pitch;
    let detectHeading = heading;
    let detectPanoId = panoId;
    
    // Get screen dimensions for aspect ratio matching
    const container = document.getElementById('detectionPanorama');
    const screenWidth = container?.clientWidth || 1920;
    const screenHeight = container?.clientHeight || 1080;
    const aspectRatio = screenWidth / screenHeight;
    
    // Calculate image dimensions - max 640 on longest side, maintain aspect ratio
    let imgWidth, imgHeight;
    if (aspectRatio >= 1) {
        imgWidth = 640;
        imgHeight = Math.round(640 / aspectRatio);
    } else {
        imgHeight = 640;
        imgWidth = Math.round(640 * aspectRatio);
    }
    
    // If using current POV, get it from the panorama.
    // IMPORTANT: the user can also navigate within Street View (pano changes). In that case we must
    // use the CURRENT panoId, not the one from when the modal first opened.
    if (useCurrentPov && detectionPanorama) {
        const pov = detectionPanorama.getPov();
        detectHeading = pov.heading;
        pitch = pov.pitch;
        // Calculate FOV from zoom using the correct formula
        fov = zoomToFov(pov.zoom || 1);
        // Clamp FOV to reasonable range for static API (max 120°)
        fov = Math.min(120, Math.max(20, fov));

        if (typeof detectionPanorama.getPano === 'function') {
            const currentPano = detectionPanorama.getPano();
            if (currentPano) detectPanoId = currentPano;
        }
    }
    
    // Build image URL with matching aspect ratio
    const imageUrl = getStreetViewImageUrl(detectPanoId, detectHeading, pitch, fov, imgWidth, imgHeight);
    
    // Store for diagnostics
    window._lastDetectionUrl = imageUrl;
    
    // Debug: log detection parameters
    console.log('Detection params:', { panoId: detectPanoId, heading: detectHeading, pitch, fov, imgWidth, imgHeight, imageUrl });
    
    if (statusEl) statusEl.textContent = 'Detecting parking signs...';
    
    try {
        const result = await runDetection(imageUrl);
        
        // Convert detections to angular coordinates
        currentDetections = result.detections.map(det => 
            detectionToAngular(det, detectHeading, pitch, fov, imgWidth, imgHeight)
        );
        
        // Store detection POV
        detectionPov = { heading: detectHeading, pitch, fov };
        
        // Update overlay
        updateDetectionOverlay();
        
        // Update status
        const count = result.detections.length;
        const timeMs = result.inference_time_ms;
        if (statusEl) {
            statusEl.textContent = count > 0 
                ? `Found ${count} parking sign${count > 1 ? 's' : ''} (${timeMs}ms)`
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
 * Handle click on a detected sign - zoom first, save on second click.
 * @param {Object} det - Angular detection {heading, pitch, angularWidth, angularHeight}
 */
function handleDetectionClick(det) {
    if (!detectionPanorama) return;
    
    // Check if we're already zoomed to this detection
    if (zoomedDetection === det) {
        // Second click - crop and save from zoomed image
        cropAndSaveSign(det);
        return;
    }
    
    // First click - zoom panorama to max zoom centered on sign
    zoomToDetectionMax(det);
    zoomedDetection = det;
    
    // Update status
    const statusEl = document.getElementById('status') || document.getElementById('detectionStatus');
    if (statusEl) {
        statusEl.textContent = 'Click again to crop and save this sign';
    }
}

/**
 * Zoom panorama to max zoom centered on a detected sign.
 * @param {Object} det - Angular detection {heading, pitch, angularWidth, angularHeight}
 */
function zoomToDetectionMax(det) {
    if (!detectionPanorama) return;
    
    // Max zoom = 5 (FOV ≈ 5.6°), but use 4 for safety (FOV ≈ 11°)
    const maxZoom = 4;
    
    detectionPanorama.setPov({
        heading: det.heading,
        pitch: det.pitch,
        zoom: maxZoom
    });
}

/**
 * Crop and save sign using high-resolution tiles.
 * @param {Object} det - Angular detection
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
    
    if (statusEl) statusEl.textContent = 'Fetching panorama metadata...';
    
    try {
        // Get session token and metadata
        const session = await getSessionToken();
        const metadata = await fetchStreetViewMetadata(panoId, session);
        
        // Use tile grid dimensions at zoom level 5 (32×16 tiles = 16384×8192 pixels)
        const imageWidth = TILE_GRID_WIDTH;
        const imageHeight = TILE_GRID_HEIGHT;
        
        // Get panorama orientation (compass heading of pano's front direction)
        const panoHeading = metadata.heading || 0;
        console.log('Panorama heading:', panoHeading, 'Sign heading:', det.heading);
        
        if (statusEl) statusEl.textContent = 'Calculating tiles...';
        
        // Convert sign's angular position to pixel coordinates
        // Must account for panorama orientation when mapping to tiles
        const signCenter = headingPitchToPixel(det.heading, det.pitch, imageWidth, imageHeight, panoHeading);
        const signSize = angularToPixelSize(det.angularWidth, det.angularHeight, imageWidth, imageHeight);
        
        // Get tiles needed to cover the sign region
        const { tiles, tileX1, tileY1, cropBounds } = getTilesForRegion(
            signCenter.x, signCenter.y, signSize.width, signSize.height
        );
        
        console.log('Tile calculation:', { signCenter, signSize, tiles, cropBounds });
        
        if (statusEl) statusEl.textContent = `Fetching ${tiles.length} tile(s)...`;
        
        // Call backend to fetch tiles and crop
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
            statusEl.textContent = `Saved: ${result.filename} (${result.width}x${result.height}px, ${result.tiles_fetched} tile(s))`;
        }
        
        // Clear zoomed state
        zoomedDetection = null;
        
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
