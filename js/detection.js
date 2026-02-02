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
 * Build Street View Static API URL.
 * @param {string} panoId - Panorama ID
 * @param {number} heading - View heading in degrees
 * @param {number} pitch - View pitch in degrees
 * @param {number} fov - Field of view in degrees
 * @param {number} width - Image width (default 640)
 * @param {number} height - Image height (default 640)
 * @returns {string} Street View Static API URL
 */
function getStreetViewImageUrl(panoId, heading, pitch = -5, fov = 90, width = 640, height = 640) {
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
    
    // For Street View static API, the horizontal FOV is specified,
    // and vertical FOV is determined by aspect ratio
    const vFov = hFov * (imgHeight / imgWidth);
    
    // Convert pixel offset to angular offset
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
 * Convert angular detection back to screen coordinates.
 * @param {Object} angularDet - Angular detection
 * @param {number} currentHeading - Current POV heading
 * @param {number} currentPitch - Current POV pitch
 * @param {number} currentFov - Current horizontal FOV
 * @param {number} screenWidth - Screen width
 * @param {number} screenHeight - Screen height
 * @returns {Object|null} Screen coordinates or null if out of view
 */
function angularToScreen(angularDet, currentHeading, currentPitch, currentFov, screenWidth, screenHeight) {
    // Calculate heading difference (handle wrap-around)
    let headingDiff = angularDet.heading - currentHeading;
    if (headingDiff > 180) headingDiff -= 360;
    if (headingDiff < -180) headingDiff += 360;
    
    const pitchDiff = angularDet.pitch - currentPitch;
    
    // Calculate vertical FOV based on aspect ratio
    // Panorama viewer maintains aspect ratio, so vertical FOV = horizontal FOV * (height/width)
    const aspectRatio = screenHeight / screenWidth;
    const verticalFov = currentFov * aspectRatio;
    
    // Check if in view (with some margin)
    const halfHFov = currentFov / 2;
    const halfVFov = verticalFov / 2;
    if (Math.abs(headingDiff) > halfHFov + angularDet.angularWidth / 2) return null;
    if (Math.abs(pitchDiff) > halfVFov + angularDet.angularHeight / 2) return null;
    
    // Convert to screen coordinates - use separate pixels/degree for X and Y
    const pixelsPerDegreeX = screenWidth / currentFov;
    const pixelsPerDegreeY = screenHeight / verticalFov;
    const centerX = screenWidth / 2 + headingDiff * pixelsPerDegreeX;
    const centerY = screenHeight / 2 - pitchDiff * pixelsPerDegreeY;  // Y inverted
    const width = angularDet.angularWidth * pixelsPerDegreeX;
    const height = angularDet.angularHeight * pixelsPerDegreeY;
    
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
    
    // Calculate current FOV from zoom (approximate)
    // Google Street View: zoom 0 = ~180° FOV, zoom 1 = ~90°, zoom 2 = ~45°, etc.
    const fov = 180 / Math.pow(2, pov.zoom || 1);
    
    // Clear existing boxes
    overlay.innerHTML = '';
    
    // Draw each detection if visible
    for (const det of currentDetections) {
        const screen = angularToScreen(det, pov.heading, pov.pitch, fov, width, height);
        if (!screen) continue;
        
        // Color based on confidence
        const hue = det.confidence * 120;
        const color = `hsl(${hue}, 100%, 50%)`;
        
        // Create rect
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', screen.x);
        rect.setAttribute('y', screen.y);
        rect.setAttribute('width', screen.width);
        rect.setAttribute('height', screen.height);
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', color);
        rect.setAttribute('stroke-width', '3');
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
    if (detectionPanorama) {
        // Update existing panorama
        detectionPanorama.setPano(panoId);
        detectionPanorama.setPov({ heading, pitch: -5, zoom: 1 });
    } else {
        // Create new panorama
        detectionPanorama = new google.maps.StreetViewPanorama(container, {
            pano: panoId,
            pov: { heading, pitch: -5 },
            zoom: 1,
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
    let pitch = -5;
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
        // Calculate FOV from zoom: zoom 0 = ~180°, zoom 1 = ~90°, zoom 2 = ~45°
        fov = 180 / Math.pow(2, pov.zoom || 1);
        // Clamp FOV to reasonable range for static API (max 120°)
        fov = Math.min(120, Math.max(20, fov));

        if (typeof detectionPanorama.getPano === 'function') {
            const currentPano = detectionPanorama.getPano();
            if (currentPano) detectPanoId = currentPano;
        }
    }
    
    // Build image URL with matching aspect ratio
    const imageUrl = getStreetViewImageUrl(detectPanoId, detectHeading, pitch, fov, imgWidth, imgHeight);
    
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
 * Clean up detection panorama when closing modal.
 */
function cleanupDetectionPanorama() {
    currentDetections = [];
    if (document.getElementById('detectionOverlay')) {
        document.getElementById('detectionOverlay').innerHTML = '';
    }
}
