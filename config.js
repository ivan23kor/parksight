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
    HORIZON_HALF_BAND_DEGREES: 10,
};
