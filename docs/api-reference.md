# API Reference

## Map Overlay App API Documentation

### Core Classes and Functions

#### `L.map`
Creates the main Leaflet map instance.

```javascript
const map = L.map('map').setView([latitude, longitude], zoomLevel);
```

#### Overlay Management

##### `addOverlay(geojson, name)`
Adds a GeoJSON overlay to the map.

**Parameters:**
- `geojson` (Object): GeoJSON data object
- `name` (String): Display name for the overlay

**Example:**
```javascript
const geojson = {
    "type": "FeatureCollection",
    "features": [...]
};
addOverlay(geojson, "My Overlay");
```

##### `removeOverlay(id)`
Removes an overlay by its ID.

**Parameters:**
- `id` (String): Overlay identifier

#### Street Selection

##### `fetchStreetsInBounds(bounds)`
Fetches street data from Overpass API within specified bounds.

**Parameters:**
- `bounds` (L.LatLngBounds): Geographic bounds for street query

**Returns:**
- Promise: Resolves with Overpass API response

##### `overpassToGeoJSON(overpassData)`
Converts Overpass API response to GeoJSON format.

**Parameters:**
- `overpassData` (Object): Response from Overpass API

**Returns:**
- Object: GeoJSON FeatureCollection

### Event Handlers

#### Map Events
- `mousedown`: Initiates rectangle selection
- `mousemove`: Updates rectangle during drag
- `mouseup`: Finalizes selection and fetches streets
- `click`: Cancels selection mode

#### Control Events
- Map provider change
- File upload
- Drawing tool activation
- Color/width changes

### Configuration Options

#### Map Providers
```javascript
const mapProviders = {
    openstreetmap: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    cartodb: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    'cartodb-dark': 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
};
```

#### Overpass Query
```javascript
const overpassQuery = `
    [out:json][timeout:30];
    (
        way["highway"~"^(primary|secondary|tertiary|residential|service|unclassified)$"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});
    );
    (._;>;);
    out geom;
`;
```

### Style Options

#### Overlay Styles
```javascript
const style = {
    color: '#ff0000',      // Line color
    weight: 3,             // Line width
    opacity: 0.8,          // Line opacity
    fillOpacity: 0.3       // Fill opacity for polygons
};
```

#### Rectangle Selection
```javascript
const selectionStyle = {
    color: '#007bff',      // Border color
    weight: 2,             // Border width
    fillOpacity: 0.1,      // Fill opacity
    dashArray: '5, 5'      // Dashed line pattern
};
```