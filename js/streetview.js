/**
 * Google Street View integration.
 * Handles session tokens, bulk panoId fetching, and panorama display.
 */

const SESSION_KEY = 'gsv_session_token';
let panoramaInstance = null;

/**
 * Get or create a session token for the Map Tiles API.
 * Tokens are cached in localStorage for ~13 days.
 * @returns {Promise<string>} Session token
 */
async function getSessionToken() {
    // Check for cached token
    const cached = localStorage.getItem(SESSION_KEY);
    if (cached) {
        try {
            const { token, expiry } = JSON.parse(cached);
            if (Date.now() < expiry && token) {
                console.log('Using cached session token');
                return token;
            }
        } catch (e) {
            // Invalid cache, will create new token
            console.warn('Invalid cached session token, creating new one');
        }
        // Clear invalid/expired cache
        localStorage.removeItem(SESSION_KEY);
    }

    // Create new session
    const apiKey = window.GOOGLE_CONFIG?.API_KEY;
    if (!apiKey) {
        throw new Error('Google API key not configured');
    }

    console.log('Creating new session token...');
    const resp = await fetch(
        `https://tile.googleapis.com/v1/createSession?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mapType: 'streetview',
                language: 'en-US',
                region: 'US'
            })
        }
    );

    if (!resp.ok) {
        const errorText = await resp.text();
        console.error('Session creation failed:', resp.status, errorText);
        
        // Parse error for more helpful message
        let errorMessage = `Failed to create session (${resp.status})`;
        try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.error?.message) {
                errorMessage = errorJson.error.message;
            }
            // Check for common issues
            if (errorJson.error?.details) {
                for (const detail of errorJson.error.details) {
                    if (detail.reason === 'API_KEY_SERVICE_BLOCKED') {
                        errorMessage = 'Map Tiles API is not enabled. Please enable it in Google Cloud Console.';
                    } else if (detail.reason === 'BILLING_DISABLED') {
                        errorMessage = 'Billing is not enabled for this Google Cloud project.';
                    }
                }
            }
        } catch (e) {
            // Keep original error text
        }
        
        throw new Error(errorMessage);
    }

    const data = await resp.json();
    console.log('Session created successfully');

    // Cache token for ~13 days (tokens last ~2 weeks)
    const expiry = Date.now() + 13 * 24 * 60 * 60 * 1000;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: data.session, expiry }));

    return data.session;
}

/**
 * Clear cached session token.
 * Call this if you get auth errors to force token refresh.
 */
function clearSessionToken() {
    localStorage.removeItem(SESSION_KEY);
}

/**
 * Fetch panorama IDs for multiple locations in bulk.
 * Max 100 locations per request.
 * @param {Array} locations - Array of {lat, lon} objects
 * @param {string} session - Session token
 * @returns {Promise<Array>} Array of panoId strings (empty string = no coverage)
 */
async function fetchPanoIds(locations, session) {
    const apiKey = window.GOOGLE_CONFIG?.API_KEY;
    if (!apiKey) {
        throw new Error('Google API key not configured');
    }

    if (locations.length > 100) {
        throw new Error('Maximum 100 locations per panoIds request');
    }

    const resp = await fetch(
        `https://tile.googleapis.com/v1/streetview/panoIds?session=${session}&key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locations: locations.map(l => ({ lat: l.lat, lng: l.lon })),
                radius: 50
            })
        }
    );

    if (!resp.ok) {
        // If auth error, clear token so next call will refresh
        if (resp.status === 401 || resp.status === 403) {
            clearSessionToken();
        }
        const errorText = await resp.text();
        throw new Error(`panoIds request failed: ${resp.status} - ${errorText}`);
    }

    const data = await resp.json();
    return data.panoIds || [];
}

/**
 * Open or update Street View panorama.
 * Reuses single instance for efficiency.
 * @param {string} panoId - Panorama ID
 * @param {number} heading - View heading in degrees
 * @param {HTMLElement} containerEl - DOM element to render panorama in
 */
function openPanorama(panoId, heading, containerEl) {
    const pov = typeof getDefaultPov === 'function' 
        ? getDefaultPov(heading) 
        : { heading, pitch: 0, zoom: 1 };
    
    if (!panoramaInstance) {
        panoramaInstance = new google.maps.StreetViewPanorama(containerEl, {
            pano: panoId,
            pov,
            zoom: pov.zoom,
            zoomControl: true,
            addressControl: true,
            showRoadLabels: true,
            motionTracking: false,
            motionTrackingControl: false
        });
        // Allow unlimited zoom (Google API caps at its own limit)
        panoramaInstance.set('zoom', pov.zoom);
    } else {
        panoramaInstance.setPano(panoId);
        panoramaInstance.setPov(pov);
    }
}

/**
 * Check if panorama instance exists.
 * @returns {boolean}
 */
function hasPanoramaInstance() {
    return panoramaInstance !== null;
}

/**
 * Destroy panorama instance.
 * Call when closing modal to free resources.
 */
function destroyPanorama() {
    if (panoramaInstance) {
        // Clear the container
        const container = panoramaInstance.getContainer();
        if (container) {
            container.innerHTML = '';
        }
        panoramaInstance = null;
    }
}
