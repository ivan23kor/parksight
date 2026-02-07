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
from PIL import Image, ImageDraw
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


class CropSignTilesRequest(BaseModel):
    pano_id: str
    tiles: list[dict]  # Tiles to fetch (list of {x, y} at zoom level 5)
    tile_x1: int  # Origin tile x
    tile_y1: int  # Origin tile y
    crop_x: int  # Crop bounds within stitched tile image
    crop_y: int
    crop_width: int
    crop_height: int
    confidence: float = 0.0
    api_key: str
    session_token: str


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


TILE_SIZE = 512  # Street View tile size

@app.post("/crop-sign-tiles")
async def crop_sign_tiles(request: CropSignTilesRequest):
    """
    Fetch Street View tiles at max zoom, stitch if needed, crop sign region.
    This gives much higher resolution than the Static API.
    """
    async with httpx.AsyncClient() as client:
        # Fetch all required tiles
        tile_images = {}
        for tile in request.tiles:
            url = (
                f"https://tile.googleapis.com/v1/streetview/tiles/5/{tile['x']}/{tile['y']}"
                f"?session={request.session_token}&key={request.api_key}&panoId={request.pano_id}"
            )
            try:
                resp = await client.get(url, timeout=10.0)
                resp.raise_for_status()
                tile_img = Image.open(io.BytesIO(resp.content))
                # Resize if tile size doesn't match expected
                if tile_img.size != (TILE_SIZE, TILE_SIZE):
                    tile_img = tile_img.resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)
                tile_images[(tile['x'], tile['y'])] = tile_img
            except httpx.HTTPError as e:
                raise HTTPException(status_code=400, detail=f"Failed to fetch tile {tile}: {e}")
    
    # Calculate stitched image size
    num_tiles_x = max(t['x'] for t in request.tiles) - request.tile_x1 + 1
    num_tiles_y = max(t['y'] for t in request.tiles) - request.tile_y1 + 1
    stitch_width = num_tiles_x * TILE_SIZE
    stitch_height = num_tiles_y * TILE_SIZE
    
    # Create stitched image
    stitched = Image.new('RGB', (stitch_width, stitch_height))
    for (tx, ty), tile_img in tile_images.items():
        if tile_img.mode != 'RGB':
            tile_img = tile_img.convert('RGB')
        paste_x = (tx - request.tile_x1) * TILE_SIZE
        paste_y = (ty - request.tile_y1) * TILE_SIZE
        stitched.paste(tile_img, (paste_x, paste_y))
    
    # Calculate crop bounds (clamped to image)
    x1 = max(0, request.crop_x)
    y1 = max(0, request.crop_y)
    x2 = min(stitch_width, request.crop_x + request.crop_width)
    y2 = min(stitch_height, request.crop_y + request.crop_height)
    
    cropped = stitched.crop((x1, y1, x2, y2))
    
    # Draw debug crosshair at crop center (where we expect the sign to be)
    crop_w, crop_h = cropped.size
    cx, cy = crop_w // 2, crop_h // 2
    draw = ImageDraw.Draw(cropped)
    # Yellow crosshair
    draw.line([(cx - 15, cy), (cx + 15, cy)], fill='yellow', width=2)
    draw.line([(cx, cy - 15), (cx, cy + 15)], fill='yellow', width=2)
    # Red horizontal lines at 10px intervals for measuring offset
    for dy in range(-50, 51, 10):
        if dy != 0:
            y_line = cy + dy
            if 0 <= y_line < crop_h:
                draw.line([(cx - 8, y_line), (cx + 8, y_line)], fill='red', width=1)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_conf{request.confidence:.2f}.jpg"
    cropped.save(DETECTED_SIGNS_DIR / filename, quality=95)
    
    return {
        "filename": filename,
        "width": x2 - x1,
        "height": y2 - y1,
        "tiles_fetched": len(request.tiles)
    }


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


from fastapi.responses import Response

@app.get("/detect-debug")
async def detect_debug(image_url: str, confidence: float = 0.15):
    """
    Run detection and return the image with bounding boxes drawn.
    Use this to verify YOLO is detecting correctly.
    """
    if not image_url:
        raise HTTPException(status_code=400, detail="image_url is required")
    
    # Fetch image
    async with httpx.AsyncClient() as client:
        resp = await client.get(image_url, timeout=10.0)
        resp.raise_for_status()
        image_bytes = resp.content
    
    # Load image
    image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    draw = ImageDraw.Draw(image)
    
    # Run inference
    results = model.predict(image, conf=confidence, verbose=False)
    
    # Draw boxes
    for r in results:
        if r.boxes is not None:
            for box in r.boxes:
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                conf = float(box.conf[0])
                cls_name = model.names[int(box.cls[0])]
                
                # Draw red box
                draw.rectangle([x1, y1, x2, y2], outline='red', width=3)
                # Draw label
                label = f"{cls_name} {conf:.0%}"
                draw.rectangle([x1, y1-20, x1+len(label)*8, y1], fill='red')
                draw.text((x1+2, y1-18), label, fill='white')
    
    # Draw center crosshair
    cx, cy = image.width // 2, image.height // 2
    draw.line([(cx-20, cy), (cx+20, cy)], fill='lime', width=2)
    draw.line([(cx, cy-20), (cx, cy+20)], fill='lime', width=2)
    
    # Save to bytes
    buf = io.BytesIO()
    image.save(buf, format='JPEG', quality=90)
    buf.seek(0)
    
    return Response(content=buf.getvalue(), media_type="image/jpeg")


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
