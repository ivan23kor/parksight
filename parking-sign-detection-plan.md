# Parking Sign Detection & Location System

## Overview
Build a system to automatically detect parking signs in street imagery (Mapillary), extract their restrictions using OCR, and correlate them with precise street locations on the map. This creates a comprehensive database of parking regulations.

## Key Requirements
- Fetch high-resolution street images from Mapillary API
- Detect and segment parking signs in images
- Extract text using OCR and parse parking rules
- Correlate signs with GPS coordinates and map display
- Store in spatial database for querying

## Implementation Strategy

### Phase 1: MVP (Quick Start - 2-4 weeks)
Use existing models to get working prototype quickly.

**1. Mapillary API Integration**
- Get Mapillary access token
- Fetch images by bounding box
- Extract GPS and camera pose metadata

**2. Use Pre-trained Models**
- YOLOv8 for traffic sign detection
- PaddleOCR for text extraction
- Simple regex-based rule parser

**3. Basic Data Storage**
- PostgreSQL + PostGIS for spatial data
- Simple JSON structure for sign properties

### Phase 2: Custom Training (4-8 weeks)
Improve accuracy with domain-specific models.

**1. Dataset Creation**
- Collect 1000+ parking sign examples
- Annotate with bounding boxes and text labels
- Create hierarchical classification:
  - Sign type (parking, no parking, restriction)
  - Time restrictions (2HR, 30min, etc.)
  - Valid days/times

**2. Model Fine-tuning**
- Fine-tune YOLOv8 on parking signs
- Train custom OCR model for sign fonts
- Add confidence scoring

**3. Advanced Processing**
- Duplicate detection across images
- 3D position estimation from camera pose
- Clustering signs into parking zones

## Technical Architecture

### 1. Data Flow
```
Mapillary API → Image Processing → Detection → OCR → Parsing → Database → Map Display
```

### 2. Key Components

**Frontend (current app)**
- Extend existing map view
- Add parking sign overlay layer
- Click for sign details popup

**Backend Services**
- Mapillary API client
- Image processing service
- OCR service
- Spatial database queries

**ML Pipeline**
- Sign detection model
- Text extraction
- Rule parser
- Confidence scoring

### 3. Data Schema
```json
{
    "type": "Feature",
    "geometry": {"type": "Point", "coordinates": [lng, lat]},
    "properties": {
        "sign_type": "parking_time_restriction",
        "text": "2HR PARKING 9AM-7PM",
        "rules": {
            "max_duration": 7200,
            "time_window": ["09:00", "19:00"],
            "days": ["Mon-Sat"]
        },
        "confidence": 0.95,
        "source": "mapillary",
        "image_id": "xxx123"
    }
}
```

## API Integration

### Mapillary Endpoints
```javascript
// Get images in area
GET https://graph.mapillary.com/images
?access_token={TOKEN}
&bbox={west,south,east,north}
&fields=id,geometry,compass_angle,captured_at

// Get image details
GET https://graph.mapillary.com/{image_id}
?fields=geometry,compass_angle,exif_orientation

// Get sequence for continuous coverage
GET https://graph.mapillary.com/image_sequences
?access_token={TOKEN}
&bbox={west,south,east,north}
```

## ML Model Options

### Option A: Transfer Learning (Recommended)
```python
# Base model: YOLOv8
model = YOLO('yolov8n.pt')
results = model.train(
    data='parking_signs.yaml',
    epochs=100,
    imgsz=640,
    batch=16
)
```

### Option B: Cloud Services
```python
# Google Vision API
from google.cloud import vision
client = vision.ImageAnnotatorClient()
response = client.text_detection(image=content)

# Amazon Rekognition
import boto3
client = boto3.client('rekognition')
response = client.detect_text(Image={'Bytes': image_bytes})
```

## Implementation Steps

### 1. Environment Setup
```bash
# Backend
python -m venv venv
pip install fastapi uvicorn psycopg2-binary postgis
pip install ultralytics paddlepaddle paddleocr

# Database
CREATE DATABASE parking_signs;
CREATE EXTENSION postgis;
```

### 2. Core Files Structure
```
/home/ivan23kor/Code/free-parking/
├── index.html                    # Frontend map (extend)
├── js/
│   ├── mapillary-client.js       # API integration
│   ├── parking-layer.js          # Map overlay
│   └── sign-popup.js             # UI components
├── backend/
│   ├── server.py                 # FastAPI backend
│   ├── models/
│   │   ├── detection.py          # YOLOv8 wrapper
│   │   └── ocr.py                # PaddleOCR wrapper
│   ├── database/
│   │   ├── connection.py         # Postgres client
│   │   └── models.py             # SQLAlchemy models
│   └── services/
│       ├── mapillary.py          # API client
│       └── processor.py          # Image pipeline
└── models/
    ├── parking_detector.pt       # Trained model
    └── sign_ocr.onnx             # OCR model
```

### 3. Key Code Locations
- **index.html**: Add parking sign toggle button and layer
- **js/parking-layer.js**: L.geoJSON layer for signs
- **backend/server.py**: API endpoints for sign queries
- **backend/services/processor.py**: Main processing pipeline

## Cost Considerations

### Mapillary (Meta)
- Free for non-commercial use
- Enterprise pricing for production

### Google Cloud Vision
- $1.50 per 1000 text detections
- $1.50 per 1000 object localizations

### Self-hosted
- NVIDIA GPU (~$200/month)
- Server costs
- Maintenance overhead

## Success Metrics
- Detection accuracy (>90% for common signs)
- OCR accuracy (>85% for text)
- Geolocation precision (<2m error)
- Processing speed (<1 second per image)

## Next Steps
1. Get Mapillary developer access
2. Set up PostgreSQL + PostGIS
3. Implement basic YOLOv8 detection
4. Add PaddleOCR for text
5. Create map visualization layer
6. Deploy prototype to test area