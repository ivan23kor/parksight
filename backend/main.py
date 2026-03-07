"""
Parking Sign Detection API.
FastAPI backend for YOLO11 inference on Street View images.
"""
import base64
import asyncio
import io
import math
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
from pydantic import BaseModel
from ultralytics import YOLO

# Paths
MODEL_PATH = Path(__file__).parent / "models" / "best.pt"
DETECTED_SIGNS_DIR = Path(__file__).parent.parent / "detected_signs"
DETECTED_SIGNS_DIR.mkdir(exist_ok=True)

# Load model at startup
print(f"Loading model from: {MODEL_PATH}")
model = YOLO(str(MODEL_PATH))
print(f"Model loaded. Classes: {model.names}")

app = FastAPI(title="Parking Sign Detection API")
app.mount("/detected-signs", StaticFiles(directory=str(DETECTED_SIGNS_DIR)), name="detected-signs")

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
    debug: bool = False
    save: bool = True
    include_image: bool = False


class SignPreviewRequest(BaseModel):
    pano_id: str
    heading: float
    pitch: float
    angular_width: float
    angular_height: float
    confidence: float = 0.0
    api_key: str
    padding: float = 1.2
    vertical_padding: float = 2.8
    width: int = 320
    height: int = 640
    crop_width_ratio: float = 1 / 7
    crop_height_ratio: float = 1 / 2
    save: bool = False
    include_image: bool = True


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


class AngularDetection(BaseModel):
    heading: float
    pitch: float
    angular_width: float
    angular_height: float
    confidence: float
    class_name: str


class SahiRequest(BaseModel):
    pano_id: str
    heading: float
    pitch: float = 0.0
    fov: float = 90.0
    slice_fov: float = 45.0
    overlap: float = 0.3
    confidence: float = 0.15
    nms_iou_threshold: float = 0.5
    api_key: str
    img_width: int = 640
    img_height: int = 640


class SahiResponse(BaseModel):
    detections: list[AngularDetection]
    total_inference_time_ms: float
    slices_count: int


def pixel_to_angular(x: float, y: float, pov_heading: float, pov_pitch: float,
                     h_fov: float, img_w: int, img_h: int) -> tuple[float, float]:
    """
    Convert pixel coords in a gnomonic (perspective) image to world heading/pitch.
    Uses the same PanoMarker 3D basis-vector math as the frontend's screenToAngular().
    Coordinate system: x=East, y=North, z=Up.
    """
    h0 = math.radians(pov_heading)
    p0 = math.radians(pov_pitch)
    cos_p0 = math.cos(p0)
    sin_p0 = math.sin(p0)
    cos_h0 = math.cos(h0)
    sin_h0 = math.sin(h0)

    # Focal length (matches directionToScreen / PanoMarker)
    f = (img_w / 2) / math.tan(math.radians(h_fov / 2))

    # Pixel offsets from center (Y flipped)
    du = x - img_w / 2
    dv = img_h / 2 - y

    # POV center direction in 3D (x=East, y=North, z=Up)
    x0 = f * cos_p0 * sin_h0
    y0 = f * cos_p0 * cos_h0
    z0 = f * sin_p0

    # Image plane basis vectors (from PanoMarker)
    ux, uy, uz = cos_h0, -sin_h0, 0.0
    vx, vy, vz = -sin_p0 * sin_h0, -sin_p0 * cos_h0, cos_p0

    # 3D point on the image plane
    px = x0 + du * ux + dv * vx
    py = y0 + du * uy + dv * vy
    pz = z0 + du * uz + dv * vz

    # Convert to heading/pitch
    r = math.sqrt(px * px + py * py + pz * pz)
    world_heading = math.degrees(math.atan2(px, py)) % 360
    world_pitch = math.degrees(math.asin(max(-1.0, min(1.0, pz / r))))

    return world_heading, world_pitch


def angular_iou(a: AngularDetection, b: AngularDetection) -> float:
    """Compute IoU between two detections in angular (heading x pitch) space."""
    # Box edges
    a_left = a.heading - a.angular_width / 2
    a_right = a.heading + a.angular_width / 2
    a_top = a.pitch + a.angular_height / 2
    a_bottom = a.pitch - a.angular_height / 2

    b_left = b.heading - b.angular_width / 2
    b_right = b.heading + b.angular_width / 2
    b_top = b.pitch + b.angular_height / 2
    b_bottom = b.pitch - b.angular_height / 2

    # Handle heading wrap-around: shift b relative to a
    heading_diff = b.heading - a.heading
    if heading_diff > 180:
        heading_diff -= 360
    elif heading_diff < -180:
        heading_diff += 360
    # Re-center b on a's frame
    b_left_adj = a.heading + heading_diff - b.angular_width / 2
    b_right_adj = a.heading + heading_diff + b.angular_width / 2

    inter_left = max(a_left, b_left_adj)
    inter_right = min(a_right, b_right_adj)
    inter_bottom = max(a_bottom, b_bottom)
    inter_top = min(a_top, b_top)

    inter_w = max(0, inter_right - inter_left)
    inter_h = max(0, inter_top - inter_bottom)
    inter_area = inter_w * inter_h

    a_area = a.angular_width * a.angular_height
    b_area = b.angular_width * b.angular_height
    union_area = a_area + b_area - inter_area

    if union_area <= 0:
        return 0.0
    return inter_area / union_area


def nms_angular(detections: list[AngularDetection], iou_threshold: float = 0.5) -> list[AngularDetection]:
    """Non-Maximum Suppression in angular space."""
    if not detections:
        return []
    # Sort by confidence descending
    sorted_dets = sorted(detections, key=lambda d: d.confidence, reverse=True)
    keep = []
    for det in sorted_dets:
        suppressed = False
        for kept in keep:
            if angular_iou(det, kept) > iou_threshold:
                suppressed = True
                break
        if not suppressed:
            keep.append(det)
    return keep


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
    
    if request.debug:
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
    
    should_save = request.save or request.include_image
    filename = None
    if should_save:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_conf{request.confidence:.2f}.jpg"
        cropped.save(DETECTED_SIGNS_DIR / filename, quality=95)

    response = {
        "filename": filename,
        "image_url": f"/detected-signs/{filename}" if filename else None,
        "width": x2 - x1,
        "height": y2 - y1,
        "tiles_fetched": len(request.tiles)
    }

    if request.include_image:
        image_buffer = io.BytesIO()
        cropped.save(image_buffer, format="JPEG", quality=90)
        response["image_base64"] = base64.b64encode(image_buffer.getvalue()).decode("ascii")

    return response


@app.post("/preview-sign")
async def preview_sign(request: SignPreviewRequest):
    """
    Fetch a sign-centered Street View image at the tightest practical FOV.
    This avoids enlarging a tiny crop from the full panorama when the sign is
    far down the street.
    """
    width = max(64, min(request.width, 640))
    height = max(64, min(request.height, 640))

    # Street View's FOV is horizontal. Keep the horizontal framing tight and
    # rely on a tall aspect ratio to preserve more context above and below.
    horizontal_padding = max(request.padding, 1.0)
    vertical_padding = max(request.vertical_padding, 1.0)
    aspect_scale = height / width

    horizontal_fov = max(abs(request.angular_width), 0.1) * horizontal_padding
    required_vertical_fov = max(abs(request.angular_height), 0.1) * vertical_padding
    vertical_fit_horizontal_fov = math.degrees(
        2.0
        * math.atan(
            math.tan(math.radians(required_vertical_fov) / 2.0) / aspect_scale
        )
    )
    requested_fov = max(horizontal_fov, vertical_fit_horizontal_fov)
    fov = max(10.0, min(25.0, requested_fov))

    image_url = build_streetview_url(
        request.pano_id,
        request.heading,
        request.pitch,
        fov,
        width,
        height,
        request.api_key,
    )

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(image_url, timeout=10.0)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=400, detail=f"Failed to fetch sign preview: {e}")

    try:
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to decode sign preview: {e}")

    crop_width_ratio = min(max(request.crop_width_ratio, 0.05), 1.0)
    crop_height_ratio = min(max(request.crop_height_ratio, 0.05), 1.0)
    crop_width = max(1, round(image.width * crop_width_ratio))
    crop_height = max(1, round(image.height * crop_height_ratio))
    crop_left = max(0, (image.width - crop_width) // 2)
    crop_top = max(0, (image.height - crop_height) // 2)
    image = image.crop(
        (
            crop_left,
            crop_top,
            crop_left + crop_width,
            crop_top + crop_height,
        )
    )

    filename = None
    if request.save:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_preview_conf{request.confidence:.2f}.jpg"
        image.save(DETECTED_SIGNS_DIR / filename, quality=95)

    response = {
        "filename": filename,
        "image_url": f"/detected-signs/{filename}" if filename else None,
        "width": image.width,
        "height": image.height,
        "fov": fov,
    }

    if request.include_image:
        image_buffer = io.BytesIO()
        image.save(image_buffer, format="JPEG", quality=90)
        response["image_base64"] = base64.b64encode(image_buffer.getvalue()).decode("ascii")

    return response


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


@app.post("/detect-sahi", response_model=SahiResponse)
async def detect_sahi(request: SahiRequest):
    """
    Slicing Aided Hyper Inference (SAHI) for parking sign detection.

    Slices the panorama view into overlapping higher-zoom windows,
    runs YOLO on each, converts detections to angular coordinates,
    and merges with NMS.
    """
    # Calculate slice headings to cover the requested FOV
    step = request.slice_fov * (1 - request.overlap)
    num_slices = max(1, math.ceil(request.fov / step))
    # Center the slices around the requested heading
    total_span = (num_slices - 1) * step if num_slices > 1 else 0
    start_heading = request.heading - total_span / 2

    slices = []
    for i in range(num_slices):
        slice_heading = (start_heading + i * step) % 360
        slices.append(slice_heading)

    print(f"SAHI: {num_slices} slices, FOV={request.slice_fov}°, "
          f"step={step:.1f}°, headings={[f'{h:.1f}' for h in slices]}")

    # Fetch all slice images in parallel
    async def fetch_slice(client: httpx.AsyncClient, heading: float) -> tuple[float, bytes | None]:
        url = build_streetview_url(
            request.pano_id, heading, request.pitch, request.slice_fov,
            request.img_width, request.img_height, request.api_key
        )
        try:
            resp = await client.get(url, timeout=10.0)
            resp.raise_for_status()
            return heading, resp.content
        except httpx.HTTPError as e:
            print(f"SAHI: Failed to fetch slice at heading {heading:.1f}°: {e}")
            return heading, None

    async with httpx.AsyncClient() as client:
        tasks = [fetch_slice(client, h) for h in slices]
        results = await asyncio.gather(*tasks)

    # Run inference on each slice and collect angular detections
    all_angular_dets: list[AngularDetection] = []
    total_inference_ms = 0.0

    for slice_heading, image_bytes in results:
        if image_bytes is None:
            continue

        try:
            image = Image.open(io.BytesIO(image_bytes))
            img_w, img_h = image.size
        except Exception as e:
            print(f"SAHI: Failed to load slice image at heading {slice_heading:.1f}°: {e}")
            continue

        start_time = time.time()
        yolo_results = model.predict(image, conf=request.confidence, verbose=False)
        total_inference_ms += (time.time() - start_time) * 1000

        for r in yolo_results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
                conf = float(box.conf[0])
                cls_name = model.names[int(box.cls[0])]

                # Detection center and size in pixels
                cx = (x1 + x2) / 2
                cy = (y1 + y2) / 2
                det_w = x2 - x1
                det_h = y2 - y1

                # Convert center to angular coords
                center_heading, center_pitch = pixel_to_angular(
                    cx, cy, slice_heading, request.pitch,
                    request.slice_fov, img_w, img_h
                )

                # Convert corners to get angular dimensions
                tl_h, tl_p = pixel_to_angular(x1, y1, slice_heading, request.pitch, request.slice_fov, img_w, img_h)
                tr_h, tr_p = pixel_to_angular(x2, y1, slice_heading, request.pitch, request.slice_fov, img_w, img_h)
                bl_h, bl_p = pixel_to_angular(x1, y2, slice_heading, request.pitch, request.slice_fov, img_w, img_h)
                br_h, br_p = pixel_to_angular(x2, y2, slice_heading, request.pitch, request.slice_fov, img_w, img_h)

                # Angular width: average of top and bottom edge spans
                top_w = tr_h - tl_h
                if top_w > 180: top_w -= 360
                if top_w < -180: top_w += 360
                bot_w = br_h - bl_h
                if bot_w > 180: bot_w -= 360
                if bot_w < -180: bot_w += 360
                ang_w = abs((top_w + bot_w) / 2)

                # Angular height: average of left and right edge spans
                ang_h = abs(((tl_p - bl_p) + (tr_p - br_p)) / 2)

                all_angular_dets.append(AngularDetection(
                    heading=center_heading,
                    pitch=center_pitch,
                    angular_width=ang_w,
                    angular_height=ang_h,
                    confidence=conf,
                    class_name=cls_name,
                ))

    print(f"SAHI: {len(all_angular_dets)} raw detections before NMS")

    # NMS to merge overlapping detections from adjacent slices
    merged = nms_angular(all_angular_dets, request.nms_iou_threshold)

    print(f"SAHI: {len(merged)} detections after NMS")

    return SahiResponse(
        detections=merged,
        total_inference_time_ms=round(total_inference_ms, 1),
        slices_count=num_slices,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
