"""
Parking Sign Detection API.
FastAPI backend for YOLO11 inference on Street View images.
"""
import io
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
from ultralytics import YOLO

# Paths
MODEL_PATH = Path(__file__).parent.parent / "notebooks/output/test_run/train/weights/best.pt"
DETECTED_SIGNS_DIR = Path(__file__).parent.parent / "detected_signs"
DETECTED_SIGNS_DIR.mkdir(exist_ok=True)

# Load model at startup
print(f"Loading model from: {MODEL_PATH}")
model = YOLO(str(MODEL_PATH))
print(f"Model loaded. Classes: {model.names}")

app = FastAPI(title="Parking Sign Detection API")

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DetectionRequest(BaseModel):
    image_url: Optional[str] = None
    confidence: float = 0.15


class SaveSignRequest(BaseModel):
    pano_id: str
    heading: float
    pitch: float
    fov: float
    angular_width: float  # Sign's angular width in degrees
    angular_height: float  # Sign's angular height in degrees
    confidence: float = 0.0
    api_key: str


class Detection(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float
    class_name: str


class DetectionResponse(BaseModel):
    detections: list[Detection]
    inference_time_ms: float
    image_width: int
    image_height: int


class SaveSignResponse(BaseModel):
    filename: str
    size: int


def parse_streetview_url(url: str) -> dict | None:
    """
    Parse Street View Static API URL to extract parameters.
    Returns dict with pano, heading, pitch, fov, size, key or None if not a Street View URL.
    """
    parsed = urlparse(url)
    if 'streetview' not in parsed.path:
        return None
    
    params = parse_qs(parsed.query)
    # parse_qs returns lists, get first value
    result = {}
    for key in ['pano', 'heading', 'pitch', 'fov', 'size', 'key']:
        if key in params:
            result[key] = params[key][0]
    
    # Parse size into width/height
    if 'size' in result:
        match = re.match(r'(\d+)x(\d+)', result['size'])
        if match:
            result['width'] = int(match.group(1))
            result['height'] = int(match.group(2))
    
    # Convert numeric fields
    for key in ['heading', 'pitch', 'fov']:
        if key in result:
            result[key] = float(result[key])
    
    return result


def build_streetview_url(pano: str, heading: float, pitch: float, fov: float, 
                         width: int, height: int, api_key: str) -> str:
    """Build a Street View Static API URL."""
    return (
        f"https://maps.googleapis.com/maps/api/streetview?"
        f"size={width}x{height}&pano={pano}&heading={heading:.2f}"
        f"&pitch={pitch:.2f}&fov={fov:.2f}&key={api_key}"
    )


def pixel_to_angular_offset(x: float, y: float, h_fov: float, 
                            img_width: int, img_height: int) -> tuple[float, float]:
    """
    Convert pixel coordinates to angular offset from image center.
    Returns (heading_offset, pitch_offset) in degrees.
    """
    center_x = img_width / 2
    center_y = img_height / 2
    v_fov = h_fov * (img_height / img_width)
    
    deg_per_px_x = h_fov / img_width
    deg_per_px_y = v_fov / img_height
    
    heading_offset = (x - center_x) * deg_per_px_x
    pitch_offset = -(y - center_y) * deg_per_px_y  # Y inverted
    
    return heading_offset, pitch_offset


async def fetch_zoomed_sign_image(
    client: httpx.AsyncClient,
    sv_params: dict,
    det_x1: float, det_y1: float, det_x2: float, det_y2: float,
    img_width: int, img_height: int,
    padding: float = 1.5
) -> bytes | None:
    """
    Fetch a high-resolution zoomed image centered on a detected sign.
    
    Args:
        client: HTTP client
        sv_params: Parsed Street View URL parameters
        det_x1, det_y1, det_x2, det_y2: Detection box in pixels
        img_width, img_height: Original image dimensions
        padding: Multiplier for FOV (1.5 = 50% padding around sign)
    
    Returns:
        Image bytes or None on failure
    """
    if not sv_params or 'pano' not in sv_params or 'key' not in sv_params:
        return None
    
    base_heading = sv_params.get('heading', 0)
    base_pitch = sv_params.get('pitch', 0)
    base_fov = sv_params.get('fov', 90)
    
    # Calculate detection center and size
    det_center_x = (det_x1 + det_x2) / 2
    det_center_y = (det_y1 + det_y2) / 2
    det_width = det_x2 - det_x1
    det_height = det_y2 - det_y1
    
    # Convert detection center to angular offset
    heading_offset, pitch_offset = pixel_to_angular_offset(
        det_center_x, det_center_y, base_fov, img_width, img_height
    )
    
    # New heading/pitch centered on the sign
    new_heading = (base_heading + heading_offset) % 360
    new_pitch = base_pitch + pitch_offset
    
    # Calculate angular size of the detection
    v_fov = base_fov * (img_height / img_width)
    angular_width = det_width * (base_fov / img_width)
    angular_height = det_height * (v_fov / img_height)
    
    # New FOV: just big enough for the sign with padding, clamped to [10, 120]
    new_fov = max(angular_width, angular_height) * padding
    new_fov = max(10, min(120, new_fov))
    
    # Request max resolution (640x640 square for best quality)
    zoom_url = build_streetview_url(
        sv_params['pano'], new_heading, new_pitch, new_fov,
        640, 640, sv_params['key']
    )
    
    try:
        resp = await client.get(zoom_url, timeout=10.0)
        resp.raise_for_status()
        return resp.content
    except httpx.HTTPError as e:
        print(f"Failed to fetch zoomed image: {e}")
        return None


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "model": str(MODEL_PATH.name)}


@app.post("/save-sign")
async def save_sign(request: SaveSignRequest):
    """
    Save a zoomed Street View image of a parking sign.
    Called when user clicks on a detection to save it.
    """
    # Build Street View URL for the sign (centered on sign)
    url = build_streetview_url(
        request.pano_id, request.heading, request.pitch, request.fov,
        640, 640, request.api_key
    )
    
    # Fetch the image
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=10.0)
            resp.raise_for_status()
            image_bytes = resp.content
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")
    
    # Load and crop to just the sign
    image = Image.open(io.BytesIO(image_bytes))
    img_w, img_h = image.size
    
    # Calculate sign size in pixels (sign is centered in image)
    # pixels_per_degree = image_width / fov
    px_per_deg = img_w / request.fov
    sign_w_px = request.angular_width * px_per_deg
    sign_h_px = request.angular_height * px_per_deg
    
    # Add small padding (20%)
    padding = 1.2
    crop_w = sign_w_px * padding
    crop_h = sign_h_px * padding
    
    # Crop from center
    cx, cy = img_w / 2, img_h / 2
    x1 = max(0, int(cx - crop_w / 2))
    y1 = max(0, int(cy - crop_h / 2))
    x2 = min(img_w, int(cx + crop_w / 2))
    y2 = min(img_h, int(cy + crop_h / 2))
    
    cropped = image.crop((x1, y1, x2, y2))
    
    # Save the cropped image
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_conf{request.confidence:.2f}.jpg"
    cropped.save(DETECTED_SIGNS_DIR / filename, quality=95)
    
    return {"filename": filename, "size": (x2-x1) * (y2-y1)}


@app.post("/detect", response_model=DetectionResponse)
async def detect(request: DetectionRequest):
    """
    Run parking sign detection on an image.
    
    Args:
        request: DetectionRequest with image_url and optional confidence threshold
        
    Returns:
        DetectionResponse with bounding boxes and inference time
    """
    if not request.image_url:
        raise HTTPException(status_code=400, detail="image_url is required")
    
    # Fetch image
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(request.image_url, timeout=10.0)
            resp.raise_for_status()
            image_bytes = resp.content
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")
    
    # Load image
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image_width, image_height = image.size
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load image: {e}")
    
    # Run inference
    start_time = time.time()
    results = model.predict(image, conf=request.confidence, verbose=False)
    inference_time_ms = (time.time() - start_time) * 1000
    
    # Parse results
    detections = []
    for r in results:
        if r.boxes is not None:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
                conf = float(box.conf[0])
                
                detections.append(Detection(
                    x1=x1,
                    y1=y1,
                    x2=x2,
                    y2=y2,
                    confidence=conf,
                    class_name=model.names[cls_id],
                ))
    
    return DetectionResponse(
        detections=detections,
        inference_time_ms=round(inference_time_ms, 1),
        image_width=image_width,
        image_height=image_height,
    )


@app.post("/detect-file", response_model=DetectionResponse)
async def detect_file(file: UploadFile = File(...), confidence: float = 0.15):
    """
    Run parking sign detection on an uploaded file.

    Args:
        file: Uploaded image file
        confidence: Optional confidence threshold

    Returns:
        DetectionResponse with bounding boxes and inference time
    """
    # Read file
    image_bytes = await file.read()

    # Save image for debugging/dataset analysis
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    image_path = DETECTION_IMAGES_DIR / f"detection_{timestamp}.jpg"
    image_path.write_bytes(image_bytes)

    # Load image
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image_width, image_height = image.size
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load image: {e}")

    # Run inference
    start_time = time.time()
    results = model.predict(image, conf=confidence, verbose=False)
    inference_time_ms = (time.time() - start_time) * 1000

    # Parse results
    detections = []
    for r in results:
        if r.boxes is not None:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                detections.append(Detection(
                    x1=float(box.xyxy[0][0]),
                    y1=float(box.xyxy[0][1]),
                    x2=float(box.xyxy[0][2]),
                    y2=float(box.xyxy[0][3]),
                    confidence=float(box.conf[0]),
                    class_name=model.names[cls_id],
                ))

    return DetectionResponse(
        detections=detections,
        inference_time_ms=round(inference_time_ms, 1),
        image_width=image_width,
        image_height=image_height,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
