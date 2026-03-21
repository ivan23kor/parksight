// Google Maps API configuration
const getGoogleApiKey = () => {
    // 1. Check window.env (injected by server at runtime)
    if (window.env?.GOOGLE_MAPS_API_KEY) {
        return window.env.GOOGLE_MAPS_API_KEY;
    }
    // 2. Check localStorage (for local dev)
    const stored = localStorage.getItem('GOOGLE_MAPS_API_KEY');
    if (stored) return stored;
    // 3. Check URL query param
    const params = new URLSearchParams(window.location.search);
    const fromParam = params.get('api_key');
    if (fromParam) return fromParam;
    throw new Error('GOOGLE_MAPS_API_KEY not found in env, localStorage, or URL param');
};

window.GOOGLE_CONFIG = {
    API_KEY: getGoogleApiKey()
};

// Parking sign detection API configuration
window.DETECTION_CONFIG = {
    API_URL: 'http://127.0.0.1:8000',
    CONFIDENCE_THRESHOLD: 0.15,
    // Depth calibration parameters
    // For affine calibration: d_calibrated = DEPTH_SCALE_FACTOR * d_raw + DEPTH_SHIFT_M
    DEPTH_SCALE_FACTOR: 1.0,  // Scale factor for Depth Anything estimates (default: no scaling)
    DEPTH_SHIFT_M: 0.0,        // Additive shift for depth estimates in meters (default: no shift)
    DEPTH_CALIBRATION_MODE: "single_reference"  // "none" | "single_reference" | "affine"
};
