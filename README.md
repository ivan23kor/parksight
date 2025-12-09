# Map Overlay Visualization App

An interactive web-based map visualization tool that allows users to overlay data and select/highlight streets within rectangular areas.

## Features

### Core Functionality
- Interactive map with multiple tile providers (OpenStreetMap, CartoDB)
- Overlay support for GeoJSON and KML files
- Customizable overlay styling (color, width, opacity)
- Drawing tools (lines, polygons, markers)

### Street Selection
- Rectangle area selection tool
- Automatic fetching of street data from OpenStreetMap via Overpass API
- Highlighting of streets within selected bounds
- Customizable highlight colors and styles
- Street information display on hover/click

### Map Providers
- OpenStreetMap
- CartoDB Positron (light theme)
- CartoDB Dark (dark theme)

## Getting Started

### Prerequisites
- Python 3.x (for local server)
- Modern web browser

### Installation
1. Clone or download the project
2. Navigate to the project directory
3. Run the local server:
   ```bash
   npm run serve
   ```

### Usage
1. Open your browser and go to `http://localhost:8080`
2. Use the sidebar controls to interact with the map:
   - Switch between map providers
   - Load GeoJSON/KML files
   - Draw custom overlays
   - Select areas to highlight streets

## API Integration

### Overpass API
The app uses the Overpass API to fetch OpenStreetMap data. When you select a rectangular area, it queries for streets within that bounds.

### Example Query
```javascript
// Streets query filters for these highway types:
// - primary
// - secondary
// - tertiary
// - residential
// - service
// - unclassified
```

## File Structure
```
map-overlay-app/
├── src/
│   └── index.html      # Main application file
├── dist/               # Distribution folder
├── docs/               # Documentation
├── package.json        # Project configuration
└── README.md          # This file
```

## Dependencies
- Leaflet.js - Interactive maps
- Turf.js - Geospatial analysis (included via CDN)

## Browser Compatibility
- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## License
MIT License