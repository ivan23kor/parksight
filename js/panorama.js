/**
 * Shared panorama configuration and initialization.
 * Used by both ui-map and ui-panorama for consistent behavior.
 */

// Default panorama settings
const PANORAMA_DEFAULTS = {
    pitch: 0,        // Look straight ahead (0 = horizon)
    zoom: 2.5,       // 2.5x zoom for better sign visibility
    sideOffset: 45   // Degrees to offset when looking at street side
};

/**
 * Calculate heading with optional side offset.
 * @param {number} baseHeading - Base heading (street bearing or fixed direction)
 * @param {string} side - 'right', 'left', or 'straight'
 * @param {string|null} oneway - OSM oneway tag value (for street bearing adjustment)
 * @returns {number} Final heading in degrees (0-360)
 */
function calculateHeadingWithSide(baseHeading, side = 'straight', oneway = null) {
    let heading = baseHeading;

    // Normalize to 0-360
    heading = ((heading % 360) + 360) % 360;

    // Handle one-way=-1 (way direction opposite to traffic)
    if (oneway === '-1') {
        heading = (heading + 180) % 360;
    }

    // Apply side offset
    if (side === 'right') {
        heading = (heading + PANORAMA_DEFAULTS.sideOffset) % 360;
    } else if (side === 'left') {
        heading = (heading - PANORAMA_DEFAULTS.sideOffset + 360) % 360;
    }
    // 'straight' = no offset

    return heading;
}

/**
 * Get default POV for panorama initialization.
 * @param {number} heading - View heading
 * @returns {Object} POV object {heading, pitch, zoom}
 */
function getDefaultPov(heading) {
    return {
        heading,
        pitch: PANORAMA_DEFAULTS.pitch,
        zoom: PANORAMA_DEFAULTS.zoom
    };
}
