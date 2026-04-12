"""
Parking Sign Detection API.
FastAPI backend for YOLO11 inference on Street View images.
"""
import base64
import asyncio
import io
import math
import os
import re
import json as _json
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional, Any
from urllib.parse import parse_qs, urlparse

import logging

import httpx
import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw
from pydantic import BaseModel
from transformers import pipeline
from ultralytics import YOLO

# Paths
MODEL_PATH = Path(__file__).parent / "models" / "best.pt"
DETECTED_SIGNS_DIR = Path(__file__).parent.parent / "detected_signs"
DETECTED_SIGNS_DIR.mkdir(exist_ok=True)
DETECT_TILES_DEBUG_DIR = Path(__file__).parent.parent / "debug_detect_tiles"
DETECT_TILES_DEBUG_DIR.mkdir(exist_ok=True)

# Load YOLO model at startup
print(f"Loading model from: {MODEL_PATH}")
model = YOLO(str(MODEL_PATH))
print(f"Model loaded. Classes: {model.names}")
print(f"YOLO device: {model.device}, model type: {model.type}")

# Load Depth Anything V2 model at startup
_depth_device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Loading Depth Anything V2 on {_depth_device}...")
depth_model = pipeline(
    "depth-estimation",
    model="depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf",
    device=_depth_device,
)
print("Depth Anything V2 loaded.")

# Warmup both models with dummy input to trigger PyTorch lazy init
print("Warming up models...")
_warmup_img = Image.fromarray(np.zeros((512, 512, 3), dtype=np.uint8))
_t0 = time.perf_counter()
model.predict(_warmup_img, imgsz=512, verbose=False)
print(f"  YOLO warmup: {time.perf_counter() - _t0:.2f}s")
_t0 = time.perf_counter()
depth_model(_warmup_img)
print(f"  Depth warmup: {time.perf_counter() - _t0:.2f}s")
print("Warmup complete.")

logger = logging.getLogger(__name__)

from contextlib import asynccontextmanager

httpx_client: httpx.AsyncClient | None = None

@asynccontextmanager
async def lifespan(application: FastAPI):
    global httpx_client
    httpx_client = httpx.AsyncClient()
    yield
    await httpx_client.aclose()
    httpx_client = None

app = FastAPI(title="Parking Sign Detection API", lifespan=lifespan)
app.mount("/detected-signs", StaticFiles(directory=str(DETECTED_SIGNS_DIR)), name="detected-signs")
app.mount("/debug-detect-tiles", StaticFiles(directory=str(DETECT_TILES_DEBUG_DIR)), name="debug-detect-tiles")

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Sign panel inference constants (must match frontend constants in js/detection.js)
SIGN_PANEL_ASPECT_RATIO = 182.0 / 111.0  # ≈ 1.64
SIGN_PANEL_HEIGHT_CM = 45
ASPECT_RATIO_TOLERANCE = 0.15
ASPECT_RATIO_2_STACKED_THRESHOLD = 2.5
ASPECT_RATIO_3_STACKED_THRESHOLD = 3.5
ASPECT_RATIO_HORIZONTAL_THRESHOLD = 1.5


def infer_sign_cluster_height(angular_height: float, angular_width: float, source_detections_count: int = 1) -> tuple[int, str]:
    """
    Infer parking sign cluster configuration from bounding box aspect ratio.
    Returns (reference_height_cm, panel_layout) tuple.
    """
    if angular_width <= 0:
        return 45, "unknown"

    observed_aspect_ratio = angular_height / angular_width

    # Single panel or 2×2 grid
    if abs(observed_aspect_ratio - SIGN_PANEL_ASPECT_RATIO) < ASPECT_RATIO_TOLERANCE:
        if source_detections_count >= 3:
            return 90, "2x2_grid"
        return 45, "single"

    # Vertically stacked (H:W >> 1.64)
    if observed_aspect_ratio > SIGN_PANEL_ASPECT_RATIO:
        stack_factor = observed_aspect_ratio / SIGN_PANEL_ASPECT_RATIO

        if stack_factor < ASPECT_RATIO_2_STACKED_THRESHOLD:
            return 90, "2_stacked"
        elif stack_factor < ASPECT_RATIO_3_STACKED_THRESHOLD:
            return 135, "3_stacked"
        else:
            return 135, "3_stacked+"

    # Horizontally side-by-side (H:W << 1.64)
    if observed_aspect_ratio < SIGN_PANEL_ASPECT_RATIO / ASPECT_RATIO_HORIZONTAL_THRESHOLD:
        return 45, "2_horizontal"

    return 45, "unknown"


def fit_per_detection_affine(
    ref1_d_pred: float,
    ref1_d_real: float,
    ref1_size_px: float,
    ref2_d_pred: float,
    ref2_d_real: float,
    ref2_size_px: float,
) -> tuple[float, float, float, float]:
    """
    Fit affine transform coefficients from two calibration references.

    For depth: d_real = s_d * d_pred + t_d
    For size: size_real = s_s * size_pred + t_s

    Args:
        ref1_d_pred: Predicted depth at reference 1 (meters)
        ref1_d_real: Ground truth depth at reference 1 (meters)
        ref1_size_px: Bounding box size at reference 1 (pixels)
        ref2_d_pred: Predicted depth at reference 2 (meters)
        ref2_d_real: Ground truth depth at reference 2 (meters)
        ref2_size_px: Bounding box size at reference 2 (pixels)

    Returns:
        (s_d, t_d, s_s, t_s_factor) tuple
        where:
        - s_d: Scale factor for depth
        - t_d: Shift factor for depth (meters)
        - s_s: Scale factor for size
        - t_s_factor: Effective shift per unit pixel size
    """
    if ref1_d_pred == ref2_d_pred:
        # Can't fit affine with identical predictions
        return 1.0, 0.0, 1.0, 0.0

    # Fit depth affine: [d_pred_1, 1; d_pred_2, 1] @ [s_d, t_d]^T = [d_real_1, d_real_2]^T
    # Using least squares: d_real = s_d * d_pred + t_d
    denom = ref2_d_pred - ref1_d_pred
    s_d = (ref2_d_real - ref1_d_real) / denom
    t_d = ref1_d_real - s_d * ref1_d_pred

    # Fit size affine (same slope as depth, but different intercept)
    s_s = s_d  # Same scale factor for size as for depth
    t_s_factor = (ref1_d_real - s_s * ref1_d_pred)  # Effective shift per unit pixel size

    return s_d, t_d, s_s, t_s_factor


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


class CropSignStaticRequest(BaseModel):
    """Request for cropping a sign using Static API at max resolution (640x640)."""
    pano_id: str
    heading: float
    pitch: float
    angular_width: float
    angular_height: float
    confidence: float = 0.0
    api_key: str
    padding: float = 1.5  # FOV = sign size * padding
    save: bool = False
    include_image: bool = True


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
    crop_height_ratio: float = 3 / 4
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
    bbox_x1: Optional[float] = None
    bbox_y1: Optional[float] = None
    bbox_x2: Optional[float] = None
    bbox_y2: Optional[float] = None
    depth_anything_meters: Optional[float] = None
    depth_anything_meters_raw: Optional[float] = None
    # Depth calibration fields (Phase 1: Height inference)
    inferred_panel_layout: Optional[str] = None
    reference_height_cm: Optional[int] = None
    depth_calibrated: Optional[float] = None
    pixel_size: Optional[int] = None
    size_correction: Optional[float] = None


class SinglePanoRequest(BaseModel):
    pano_id: str
    heading: float
    pitch: float = 0.0
    fov: float = 90.0
    confidence: float = 0.15
    api_key: str
    img_width: int = 640
    img_height: int = 640
    skip_depth: bool = False


class DetectionPanoResponse(BaseModel):
    detections: list[AngularDetection]
    total_inference_time_ms: float
    slices_count: int


class DetectTilesRequest(BaseModel):
    pano_id: str
    tiles: list[dict]
    tile_x1: int
    tile_y1: int
    session_token: str
    api_key: str
    confidence: float = 0.15
    skip_depth: bool = False
    request_heading: Optional[float] = None
    request_pitch: Optional[float] = None
    request_fov: Optional[float] = None
    viewport_width: Optional[int] = None
    viewport_height: Optional[int] = None
    detection_band_center_pitch: Optional[float] = None
    detection_band_half_height_degrees: Optional[float] = None
    detection_band_top_pitch: Optional[float] = None
    detection_band_bottom_pitch: Optional[float] = None


class DetectTilesDebugArtifact(BaseModel):
    image_filename: str
    image_url: str
    metadata_filename: str
    metadata_url: str
    tile_image_filenames: list[str]
    tile_image_urls: list[str]


class PixelDetection(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float
    full_pano_x1: float
    full_pano_y1: float
    full_pano_x2: float
    full_pano_y2: float
    heading: float
    pitch: float
    angular_width: float
    angular_height: float
    confidence: float
    class_name: str
    depth_anything_meters: Optional[float] = None
    depth_anything_meters_raw: Optional[float] = None
    inferred_panel_layout: Optional[str] = None
    reference_height_cm: Optional[int] = None
    depth_calibrated: Optional[float] = None
    pixel_size: Optional[int] = None
    size_correction: Optional[float] = None


class TileDetectionResponse(BaseModel):
    detections: list[PixelDetection]
    total_inference_time_ms: float
    stitched_width: int
    stitched_height: int
    pano_heading: float
    tiles_count: int
    tile_api_requests: int
    debug_artifact: Optional[DetectTilesDebugArtifact] = None


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
        resp = await httpx_client.get(zoom_url, timeout=10.0)
        resp.raise_for_status()
        return resp.content
    except httpx.HTTPError as e:
        print(f"Failed to fetch zoomed image: {e}")
        return None


try:
    from backend.streets_db import query_streets as _query_streets
except ImportError:
    from streets_db import query_streets as _query_streets


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "model": str(MODEL_PATH.name)}


@app.get("/streets")
async def get_streets(south: float, west: float, north: float, east: float):
    """Query local OSM streets within bounding box."""
    try:
        ways = _query_streets(south, west, north, east)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return ways


DUMP_PATH = Path("/tmp/parksight-dump.json")


@app.post("/dump")
async def save_dump(body: dict):
    """Save frontend state dump to a well-known file for agent reading."""
    DUMP_PATH.write_text(_json.dumps(body, indent=2))
    return {"ok": True, "path": str(DUMP_PATH)}


TILE_SIZE = 512  # Street View tile size
TILE_ZOOM = 5
TILE_GRID_COLUMNS = 32
TILE_GRID_ROWS = 16
FULL_PANO_WIDTH = TILE_GRID_COLUMNS * TILE_SIZE
FULL_PANO_HEIGHT = TILE_GRID_ROWS * TILE_SIZE


def normalize_tile_x(tile_x: int) -> int:
    return tile_x % TILE_GRID_COLUMNS


def clamp_tile_y(tile_y: int) -> int:
    return max(0, min(TILE_GRID_ROWS - 1, tile_y))


def unwrapped_pixel_to_heading_pitch(
    x: float,
    y: float,
    pano_heading: float,
    image_width: int = FULL_PANO_WIDTH,
    image_height: int = FULL_PANO_HEIGHT,
) -> tuple[float, float]:
    wrapped_x = x % image_width
    h = (wrapped_x / image_width) * 360.0
    pitch = 90.0 - (y / image_height) * 180.0
    heading = (h - 180.0 + pano_heading + 360.0) % 360.0
    return heading, pitch


async def fetch_streetview_tile_image(
    pano_id: str,
    tile_x: int,
    tile_y: int,
    session_token: str,
    api_key: str,
) -> Image.Image:
    safe_x = normalize_tile_x(tile_x)
    safe_y = clamp_tile_y(tile_y)
    url = (
        f"https://tile.googleapis.com/v1/streetview/tiles/{TILE_ZOOM}/{safe_x}/{safe_y}"
        f"?session={session_token}&key={api_key}&panoId={pano_id}"
    )
    resp = await httpx_client.get(url, timeout=10.0)
    resp.raise_for_status()
    tile_img = Image.open(io.BytesIO(resp.content))
    if tile_img.size != (TILE_SIZE, TILE_SIZE):
        tile_img = tile_img.resize((TILE_SIZE, TILE_SIZE), Image.Resampling.LANCZOS)
    if tile_img.mode != "RGB":
        tile_img = tile_img.convert("RGB")
    return tile_img


async def stitch_requested_tiles(
    pano_id: str,
    tiles: list[dict],
    tile_x1: int,
    tile_y1: int,
    session_token: str,
    api_key: str,
) -> tuple[Image.Image, int, int, int]:
    tile_images: dict[tuple[int, int], Image.Image] = {}
    for tile in tiles:
        tx = int(tile["x"])
        ty = int(tile["y"])
        try:
            tile_images[(tx, ty)] = await fetch_streetview_tile_image(
                pano_id,
                tx,
                ty,
                session_token,
                api_key,
            )
        except httpx.HTTPError as e:
            raise HTTPException(status_code=400, detail=f"Failed to fetch tile {tile}: {e}")

    num_tiles_x = max(int(t["x"]) for t in tiles) - tile_x1 + 1
    num_tiles_y = max(int(t["y"]) for t in tiles) - tile_y1 + 1
    stitch_width = num_tiles_x * TILE_SIZE
    stitch_height = num_tiles_y * TILE_SIZE

    stitched = Image.new("RGB", (stitch_width, stitch_height))
    for (tx, ty), tile_img in tile_images.items():
        paste_x = (tx - tile_x1) * TILE_SIZE
        paste_y = (ty - tile_y1) * TILE_SIZE
        stitched.paste(tile_img, (paste_x, paste_y))

    tile_api_requests = len(tile_images)
    return stitched, stitch_width, stitch_height, tile_api_requests


def save_detect_tiles_debug_artifacts(
    request: DetectTilesRequest,
    stitched: Image.Image,
    stitch_width: int,
    stitch_height: int,
    pano_heading: float,
    tile_api_requests: int,
) -> DetectTilesDebugArtifact:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    run_dir = DETECT_TILES_DEBUG_DIR / timestamp
    run_dir.mkdir(parents=True, exist_ok=True)

    stitched_filename = "stitched-input.jpg"
    stitched.save(run_dir / stitched_filename, quality=95)

    tile_image_filenames: list[str] = []
    tile_image_urls: list[str] = []
    normalized_tiles: list[dict[str, Any]] = []
    for index, tile in enumerate(request.tiles):
        tx = int(tile["x"])
        ty = int(tile["y"])
        crop_x1 = (tx - request.tile_x1) * TILE_SIZE
        crop_y1 = (ty - request.tile_y1) * TILE_SIZE
        crop_x2 = crop_x1 + TILE_SIZE
        crop_y2 = crop_y1 + TILE_SIZE
        tile_image = stitched.crop((crop_x1, crop_y1, crop_x2, crop_y2))
        tile_filename = f"tile_{index:02d}_x{tx}_y{ty}.jpg"
        tile_image.save(run_dir / tile_filename, quality=95)
        tile_image_filenames.append(tile_filename)
        tile_image_urls.append(f"/debug-detect-tiles/{timestamp}/{tile_filename}")
        normalized_tiles.append(
            {
                "x": tx,
                "y": ty,
                "normalized_x": normalize_tile_x(tx),
                "normalized_y": clamp_tile_y(ty),
                "stitched_crop": {
                    "x": crop_x1,
                    "y": crop_y1,
                    "width": TILE_SIZE,
                    "height": TILE_SIZE,
                },
                "image_filename": tile_filename,
                "image_url": tile_image_urls[-1],
            }
        )

    metadata = {
        "timestamp": timestamp,
        "pano_id": request.pano_id,
        "confidence": request.confidence,
        "skip_depth": request.skip_depth,
        "pano_heading": pano_heading,
        "request_heading": request.request_heading,
        "request_pitch": request.request_pitch,
        "request_fov": request.request_fov,
        "viewport_width": request.viewport_width,
        "viewport_height": request.viewport_height,
        "detection_band_center_pitch": request.detection_band_center_pitch,
        "detection_band_half_height_degrees": request.detection_band_half_height_degrees,
        "detection_band_top_pitch": request.detection_band_top_pitch,
        "detection_band_bottom_pitch": request.detection_band_bottom_pitch,
        "tile_origin": {
            "tile_x1": request.tile_x1,
            "tile_y1": request.tile_y1,
        },
        "tiles_count": len(request.tiles),
        "tile_api_requests": tile_api_requests,
        "tiles": normalized_tiles,
        "stitched_image": {
            "filename": stitched_filename,
            "url": f"/debug-detect-tiles/{timestamp}/{stitched_filename}",
            "width": stitch_width,
            "height": stitch_height,
        },
    }

    metadata_filename = "metadata.json"
    (run_dir / metadata_filename).write_text(
        _json.dumps(metadata, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    log_payload = {
        "pano_id": request.pano_id,
        "confidence": request.confidence,
        "skip_depth": request.skip_depth,
        "pano_heading": pano_heading,
        "request_heading": request.request_heading,
        "request_pitch": request.request_pitch,
        "request_fov": request.request_fov,
        "viewport_width": request.viewport_width,
        "viewport_height": request.viewport_height,
        "detection_band_center_pitch": request.detection_band_center_pitch,
        "detection_band_half_height_degrees": request.detection_band_half_height_degrees,
        "detection_band_top_pitch": request.detection_band_top_pitch,
        "detection_band_bottom_pitch": request.detection_band_bottom_pitch,
        "tile_x1": request.tile_x1,
        "tile_y1": request.tile_y1,
        "tiles_count": len(request.tiles),
        "tile_api_requests": tile_api_requests,
        "stitched_width": stitch_width,
        "stitched_height": stitch_height,
        "debug_dir": str(run_dir),
    }
    logger.info("detect-tiles request: %s", _json.dumps(log_payload, sort_keys=True))
    print(f"[detect-tiles] {_json.dumps(log_payload, sort_keys=True)}")

    return DetectTilesDebugArtifact(
        image_filename=stitched_filename,
        image_url=f"/debug-detect-tiles/{timestamp}/{stitched_filename}",
        metadata_filename=metadata_filename,
        metadata_url=f"/debug-detect-tiles/{timestamp}/{metadata_filename}",
        tile_image_filenames=tile_image_filenames,
        tile_image_urls=tile_image_urls,
    )

@app.post("/crop-sign-tiles")
async def crop_sign_tiles(request: CropSignTilesRequest):
    """
    Fetch Street View tiles at max zoom, stitch if needed, crop sign region.
    This gives much higher resolution than the Static API.
    """
    stitched, stitch_width, stitch_height, tile_api_requests = await stitch_requested_tiles(
        request.pano_id,
        request.tiles,
        request.tile_x1,
        request.tile_y1,
        request.session_token,
        request.api_key,
    )
    
    # Calculate crop bounds (clamped to image, re-centered if hitting edges)
    x1 = request.crop_x
    y1 = request.crop_y
    x2 = request.crop_x + request.crop_width
    y2 = request.crop_y + request.crop_height

    # Save original bounds for diagnostics
    orig_x1, orig_y1, orig_x2, orig_y2 = x1, y1, x2, y2

    # Shift crop inward when it extends past image boundaries
    if x1 < 0:
        x2 -= x1
        x1 = 0
    if y1 < 0:
        y2 -= y1
        y1 = 0
    if x2 > stitch_width:
        x1 -= (x2 - stitch_width)
        x2 = stitch_width
    if y2 > stitch_height:
        y1 -= (y2 - stitch_height)
        y2 = stitch_height

    # Final clamp (in case crop is larger than image)
    x1 = max(0, x1)
    y1 = max(0, y1)
    
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
        "tiles_fetched": len(request.tiles),
        "tile_api_requests": tile_api_requests,
        "crop_diagnostics": {
            "requested": [orig_x1, orig_y1, orig_x2 - orig_x1, orig_y2 - orig_y1],
            "clamped": [x1, y1, x2 - x1, y2 - y1],
            "stitch_size": [stitch_width, stitch_height],
            "recenter_shift": [orig_x1 - x1, orig_y1 - y1],
        },
    }

    print(
        "[crop-sign-tiles] "
        + _json.dumps(
            {
                "pano_id": request.pano_id,
                "tiles_count": len(request.tiles),
                "tile_api_requests": tile_api_requests,
                "stitch_width": stitch_width,
                "stitch_height": stitch_height,
                "saved_filename": filename,
            },
            sort_keys=True,
        )
    )

    if request.include_image:
        image_buffer = io.BytesIO()
        cropped.save(image_buffer, format="JPEG", quality=90)
        response["image_base64"] = base64.b64encode(image_buffer.getvalue()).decode("ascii")

    return response


@app.post("/detect-tiles", response_model=TileDetectionResponse)
async def detect_tiles(request: DetectTilesRequest):
    """Run YOLO and depth on stitched Street View tiles."""
    try:
        metadata_resp = await httpx_client.get(
            (
                "https://tile.googleapis.com/v1/streetview/metadata"
                f"?session={request.session_token}&key={request.api_key}&panoId={request.pano_id}"
            ),
            timeout=10.0,
        )
        metadata_resp.raise_for_status()
        metadata = metadata_resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch pano metadata: {e}")

    pano_heading = float(metadata.get("heading") or 0.0)

    t_start = time.time()
    print(
        f"[detect-tiles] tile request plan requested_tiles={len(request.tiles)} "
        f"tile_origin=({request.tile_x1},{request.tile_y1})"
    )
    stitched, stitch_width, stitch_height, tile_api_requests = await stitch_requested_tiles(
        request.pano_id,
        request.tiles,
        request.tile_x1,
        request.tile_y1,
        request.session_token,
        request.api_key,
    )
    t_fetch = (time.time() - t_start) * 1000
    debug_artifact = None
    try:
        debug_artifact = save_detect_tiles_debug_artifacts(
            request,
            stitched,
            stitch_width,
            stitch_height,
            pano_heading,
            tile_api_requests,
        )
    except Exception as e:
        print(f"[detect-tiles] debug artifact save failed: {e}")
        traceback.print_exc()

    t_yolo_start = time.time()
    yolo_results = model.predict(
        stitched,
        conf=request.confidence,
        imgsz=512,
        verbose=False,
    )
    t_yolo = (time.time() - t_yolo_start) * 1000

    has_dets = any(r.boxes is not None and len(r.boxes) > 0 for r in yolo_results)
    depth_tensor = None
    t_depth = 0.0
    if has_dets and not request.skip_depth:
        try:
            depth_start = time.time()
            depth_result = depth_model(stitched)
            depth_tensor = depth_result["predicted_depth"]
            t_depth = (time.time() - depth_start) * 1000
        except Exception as e:
            print(f"Tile detect: depth estimation failed: {e}")

    pixel_dets: list[PixelDetection] = []
    for r in yolo_results:
        if r.boxes is None:
            continue
        for box in r.boxes:
            x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
            conf = float(box.conf[0])
            cls_name = model.names[int(box.cls[0])]

            full_x1 = request.tile_x1 * TILE_SIZE + x1
            full_y1 = request.tile_y1 * TILE_SIZE + y1
            full_x2 = request.tile_x1 * TILE_SIZE + x2
            full_y2 = request.tile_y1 * TILE_SIZE + y2

            center_x = (full_x1 + full_x2) / 2.0
            center_y = (full_y1 + full_y2) / 2.0
            center_heading, center_pitch = unwrapped_pixel_to_heading_pitch(
                center_x,
                center_y,
                pano_heading,
            )

            left_heading, _ = unwrapped_pixel_to_heading_pitch(full_x1, center_y, pano_heading)
            right_heading, _ = unwrapped_pixel_to_heading_pitch(full_x2, center_y, pano_heading)
            _, top_pitch = unwrapped_pixel_to_heading_pitch(center_x, full_y1, pano_heading)
            _, bottom_pitch = unwrapped_pixel_to_heading_pitch(center_x, full_y2, pano_heading)

            angular_width = right_heading - left_heading
            if angular_width > 180:
                angular_width -= 360
            if angular_width < -180:
                angular_width += 360
            angular_width = abs(angular_width)
            angular_height = abs(top_pitch - bottom_pitch)

            det_depth_m_raw = None
            det_depth_m = None
            depth_calibrated = None
            pixel_size = int(max(x2 - x1, y2 - y1))
            inferred_height_cm, panel_layout = infer_sign_cluster_height(
                angular_height,
                angular_width,
                source_detections_count=1,
            )

            if depth_tensor is not None:
                try:
                    depth_arr = (
                        depth_tensor.cpu().numpy()
                        if torch.is_tensor(depth_tensor)
                        else np.array(depth_tensor)
                    )
                    px_x = int(min(max((x1 + x2) / 2.0, 0), depth_arr.shape[1] - 1))
                    px_y = int(min(max((y1 + y2) / 2.0, 0), depth_arr.shape[0] - 1))
                    det_depth_m_raw = float(depth_arr[px_y, px_x])
                except Exception as e:
                    print(f"Tile detect: depth sampling failed: {e}")

            if det_depth_m_raw is not None and angular_height > 0:
                ang_h_rad = math.radians(angular_height)
                estimated_height_m = 2 * det_depth_m_raw * math.tan(ang_h_rad / 2)
                reference_height_m = inferred_height_cm / 100.0
                if estimated_height_m > 0:
                    scale_factor = reference_height_m / estimated_height_m
                    det_depth_m = det_depth_m_raw * scale_factor
                    depth_calibrated = det_depth_m
                    pitch_rad = math.radians(center_pitch)
                    det_depth_m = det_depth_m * math.cos(pitch_rad)
                    depth_calibrated = depth_calibrated * math.cos(pitch_rad)

            pixel_dets.append(
                PixelDetection(
                    x1=x1,
                    y1=y1,
                    x2=x2,
                    y2=y2,
                    full_pano_x1=full_x1,
                    full_pano_y1=full_y1,
                    full_pano_x2=full_x2,
                    full_pano_y2=full_y2,
                    heading=center_heading,
                    pitch=center_pitch,
                    angular_width=angular_width,
                    angular_height=angular_height,
                    confidence=conf,
                    class_name=cls_name,
                    depth_anything_meters=det_depth_m,
                    depth_anything_meters_raw=det_depth_m_raw,
                    inferred_panel_layout=panel_layout,
                    reference_height_cm=inferred_height_cm,
                    depth_calibrated=depth_calibrated,
                    pixel_size=pixel_size,
                    size_correction=None,
                )
            )

    total_time_ms = (time.time() - t_start) * 1000
    print(
        f"PROFILE /detect-tiles: fetch={t_fetch:.0f}ms yolo={t_yolo:.0f}ms "
        f"depth={t_depth:.0f}ms dets={len(pixel_dets)} total={total_time_ms:.0f}ms"
    )
    print(
        f"[detect-tiles] tile usage requested_tiles={len(request.tiles)} "
        f"tile_api_requests={tile_api_requests} stitched={stitch_width}x{stitch_height}"
    )
    print(
        "[detect-tiles] result "
        + _json.dumps(
            {
                "pano_id": request.pano_id,
                "detections": len(pixel_dets),
                "fetch_ms": round(t_fetch, 2),
                "yolo_ms": round(t_yolo, 2),
                "depth_ms": round(t_depth, 2),
                "total_ms": round(total_time_ms, 2),
                "tile_api_requests": tile_api_requests,
                "debug_image_url": debug_artifact.image_url if debug_artifact else None,
                "debug_metadata_url": debug_artifact.metadata_url if debug_artifact else None,
                "debug_tile_urls": debug_artifact.tile_image_urls if debug_artifact else [],
            },
            sort_keys=True,
        )
    )

    return TileDetectionResponse(
        detections=pixel_dets,
        total_inference_time_ms=round(t_yolo + t_depth, 1),
        stitched_width=stitch_width,
        stitched_height=stitch_height,
        pano_heading=pano_heading,
        tiles_count=len(request.tiles),
        tile_api_requests=tile_api_requests,
        debug_artifact=debug_artifact,
    )


@app.post("/crop-sign-static")
async def crop_sign_static(request: CropSignStaticRequest):
    """
    Crop sign using Street View Static API at max resolution (640x640).
    Fetches a perspective image centered on the sign - no coordinate conversion,
    so alignment matches the detection bbox exactly.
    """
    # Static API max size: 640x640 (standard), 2048x2048 (premium)
    size = 640
    padding = max(request.padding, 1.0)
    fov = max(abs(request.angular_width), abs(request.angular_height), 0.1) * padding
    fov = max(10.0, min(120.0, fov))

    image_url = build_streetview_url(
        request.pano_id,
        request.heading,
        request.pitch,
        fov,
        size,
        size,
        request.api_key,
    )

    try:
        resp = await httpx_client.get(image_url, timeout=10.0)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch static crop: {e}")

    try:
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to decode static crop: {e}")

    filename = None
    if request.save:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{timestamp}_static_conf{request.confidence:.2f}.jpg"
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

    try:
        resp = await httpx_client.get(image_url, timeout=10.0)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch sign preview: {e}")

    try:
        image = Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to decode sign preview: {e}")

    width_ratio = min(max(request.crop_width_ratio, 0.05), 1.0)
    height_ratio = min(max(request.crop_height_ratio, 0.05), 1.0)
    crop_left = max(0, (image.width * (1 - width_ratio)) // 2)
    crop_right = min(image.width, (image.width * (1 + width_ratio) + 1) // 2)
    crop_top = max(0, (image.height * (1 - height_ratio)) // 2)
    crop_bottom = min(image.height, (image.height * (1 + height_ratio) + 1) // 2)
    image = image.crop((crop_left, crop_top, crop_right, crop_bottom))

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

    t_start_total = time.time()

    # Fetch image
    try:
        t_fetch_start = time.time()
        resp = await httpx_client.get(request.image_url, timeout=10.0)
        resp.raise_for_status()
        image_bytes = resp.content
        t_fetch = (time.time() - t_fetch_start) * 1000
    except httpx.HTTPError as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")

    # Load image
    try:
        t_pil_start = time.time()
        image = Image.open(io.BytesIO(image_bytes))
        image_width, image_height = image.size
        t_pil = (time.time() - t_pil_start) * 1000
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to load image: {e}")

    # Run inference
    t_yolo_start = time.time()
    results = model.predict(image, conf=request.confidence, imgsz=512, verbose=False)
    t_yolo = (time.time() - t_yolo_start) * 1000

    # Extract ultralytics internal timing
    yolo_speed = results[0].speed if results else {}

    # Parse results
    t_parse_start = time.time()
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
    t_parse = (time.time() - t_parse_start) * 1000
    t_total = (time.time() - t_start_total) * 1000

    print(f"PROFILE /detect: fetch={t_fetch:.0f}ms pil={t_pil:.0f}ms yolo={t_yolo:.0f}ms (preproc={yolo_speed.get('preprocess', 0):.0f}ms infer={yolo_speed.get('inference', 0):.0f}ms postproc={yolo_speed.get('postprocess', 0):.0f}ms) parse={t_parse:.0f}ms total={t_total:.0f}ms detections={len(detections)}")

    return DetectionResponse(
        detections=detections,
        inference_time_ms=round(t_yolo, 1),
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
    resp = await httpx_client.get(image_url, timeout=10.0)
    resp.raise_for_status()
    image_bytes = resp.content

    # Load image
    image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    draw = ImageDraw.Draw(image)
    
    # Run inference
    results = model.predict(image, conf=confidence, imgsz=512, verbose=False)
    
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
                draw.text((x1+2, y1-18), label, fill='black')
    
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
    results = model.predict(image, conf=confidence, imgsz=512, verbose=False)
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


async def detect_single_pano_impl(request: SinglePanoRequest) -> DetectionPanoResponse:
    """Single-image panorama detection: 1 fetch, 1 YOLO, 1 depth, no slicing/NMS."""
    t_start = time.time()

    # Fetch one Street View image
    t_fetch_start = time.time()
    url = build_streetview_url(
        request.pano_id, request.heading, request.pitch, request.fov,
        request.img_width, request.img_height, request.api_key
    )
    resp = await httpx_client.get(url, timeout=10.0)
    resp.raise_for_status()
    image_bytes = resp.content
    t_fetch = (time.time() - t_fetch_start) * 1000

    image = Image.open(io.BytesIO(image_bytes))
    img_w, img_h = image.size

    # YOLO inference
    t_yolo_start = time.time()
    yolo_results = model.predict(image, conf=request.confidence, imgsz=512, verbose=False)
    t_yolo = (time.time() - t_yolo_start) * 1000
    yolo_speed = yolo_results[0].speed if yolo_results else {}

    # Depth estimation (only if detections found and not skipped)
    has_dets = any(r.boxes is not None and len(r.boxes) > 0 for r in yolo_results)
    depth_tensor = None
    t_depth = 0.0
    if has_dets and not request.skip_depth:
        try:
            depth_start = time.time()
            depth_result = depth_model(image)
            depth_tensor = depth_result["predicted_depth"]
            t_depth = (time.time() - depth_start) * 1000
        except Exception as e:
            print(f"Single-pano detect: depth estimation failed: {e}")

    # Convert detections to angular coordinates
    angular_dets: list[AngularDetection] = []
    for r in yolo_results:
        if r.boxes is None:
            continue
        for box in r.boxes:
            x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
            conf = float(box.conf[0])
            cls_name = model.names[int(box.cls[0])]
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

            det_depth_m_raw = None
            det_depth_m = None
            if depth_tensor is not None:
                try:
                    depth_arr = depth_tensor.cpu().numpy() if torch.is_tensor(depth_tensor) else np.array(depth_tensor)
                    px_x = int(min(max(cx, 0), depth_arr.shape[1] - 1))
                    px_y = int(min(max(cy, 0), depth_arr.shape[0] - 1))
                    det_depth_m_raw = float(depth_arr[px_y, px_x])
                except Exception as e:
                    print(f"Single-pano detect: depth sampling failed: {e}")

            center_heading, center_pitch = pixel_to_angular(
                cx, cy, request.heading, request.pitch,
                request.fov, img_w, img_h
            )
            tl_h, tl_p = pixel_to_angular(x1, y1, request.heading, request.pitch, request.fov, img_w, img_h)
            tr_h, tr_p = pixel_to_angular(x2, y1, request.heading, request.pitch, request.fov, img_w, img_h)
            bl_h, bl_p = pixel_to_angular(x1, y2, request.heading, request.pitch, request.fov, img_w, img_h)
            br_h, br_p = pixel_to_angular(x2, y2, request.heading, request.pitch, request.fov, img_w, img_h)

            top_w = tr_h - tl_h
            if top_w > 180: top_w -= 360
            if top_w < -180: top_w += 360
            bot_w = br_h - bl_h
            if bot_w > 180: bot_w -= 360
            if bot_w < -180: bot_w += 360
            ang_w = abs((top_w + bot_w) / 2)
            ang_h = abs(((tl_p - bl_p) + (tr_p - br_p)) / 2)

            inferred_height_cm, panel_layout = infer_sign_cluster_height(ang_h, ang_w, source_detections_count=1)
            reference_height_m = inferred_height_cm / 100.0
            pixel_size = int(max(x2 - x1, y2 - y1))
            depth_calibrated = None

            if det_depth_m_raw is not None and ang_h > 0:
                ang_h_rad = math.radians(ang_h)
                estimated_height_m = 2 * det_depth_m_raw * math.tan(ang_h_rad / 2)
                if estimated_height_m > 0:
                    scale_factor = reference_height_m / estimated_height_m
                    det_depth_m = det_depth_m_raw * scale_factor
                    depth_calibrated = det_depth_m
                    pitch_rad = math.radians(center_pitch)
                    det_depth_m = det_depth_m * math.cos(pitch_rad)
                    if depth_calibrated:
                        depth_calibrated = depth_calibrated * math.cos(pitch_rad)

            angular_dets.append(AngularDetection(
                heading=center_heading, pitch=center_pitch,
                angular_width=ang_w, angular_height=ang_h,
                confidence=conf, class_name=cls_name,
                bbox_x1=x1, bbox_y1=y1, bbox_x2=x2, bbox_y2=y2,
                depth_anything_meters=det_depth_m,
                depth_anything_meters_raw=det_depth_m_raw,
                inferred_panel_layout=panel_layout,
                reference_height_cm=inferred_height_cm,
                depth_calibrated=depth_calibrated,
                pixel_size=pixel_size, size_correction=None,
            ))

    t_total = (time.time() - t_start) * 1000
    print(f"PROFILE /detect-single-pano: fetch={t_fetch:.0f}ms yolo={t_yolo:.0f}ms "
          f"(preproc={yolo_speed.get('preprocess', 0):.0f}ms infer={yolo_speed.get('inference', 0):.0f}ms "
          f"postproc={yolo_speed.get('postprocess', 0):.0f}ms) depth={t_depth:.0f}ms "
          f"dets={len(angular_dets)} total={t_total:.0f}ms")

    return DetectionPanoResponse(
        detections=angular_dets,
        total_inference_time_ms=round(t_yolo + t_depth, 1),
        slices_count=1,
    )


@app.post("/detect-single-pano", response_model=DetectionPanoResponse)
async def detect_single_pano(request: SinglePanoRequest):
    """Single-image detection on a Street View panorama."""
    return await detect_single_pano_impl(request)


# OCR prompt for parking sign parsing
OCR_PROMPT = """You are a parking sign parser. You will receive a cropped image from a street-level panorama that a parking-sign detector flagged. Your job is to extract structured parking regulation data.

**CRITICAL: Respond with valid JSON only. No prose, no markdown headers, no explanations outside the JSON structure. Your entire response must be parseable by `JSON.parse()`.**

## Step 1 — Validate
A valid input is an image where **a single parking sign cluster is the primary subject**. A parking sign cluster is defined as one or more rectangular regulatory sign plates mounted on a single post, photographed close enough that the text on each plate is individually legible. The sign plates must convey parking/standing rules to drivers (permitted hours, time limits, payment requirements, no-parking restrictions, tow warnings, permit conditions).

If the image does not match this definition exactly, respond ONLY with:
```
{"is_parking_sign": false, "rejection_reason": "<brief description of what is actually shown>"}
```
Do not attempt extraction from any image that does not meet this definition.

## Step 2 — Extract rules
Every sign cluster is treated as a sequence of one or more rules. A cluster with a single plate is simply a sequence of length one. Extract each rule as a separate entry in the `rules` array, ordered top to bottom.

**Payment splitting rule:** If a single sign plate allows parking with a time limit but payment is required on some days and free on others, split that plate into two separate rule entries — one for the paid days and one for the free days — even if the time window and limit are identical. This is in addition to any other splits required by different time windows or stacked plates.

**Tow zones:** Tow enforcement is extracted separately from parking rules into the `tow_zones` array. Each tow zone entry captures the time window and direction in which towing is enforced. Do not mix tow zone entries into the `rules` array.

**Arrow direction per plate:** Each rule or tow_zone entry must use the arrow direction that appears on THAT SPECIFIC PLATE only. If a sign has multiple stacked plates with different arrows, do NOT apply one plate's arrow to a plate of a different category. If a plate has no visible arrow, set `arrow_direction` to `null` or `"none"`, not the arrow from a plate of a different category.

**Same-category arrow inheritance:** When multiple plates on the same sign post share the same category (e.g., two tow_zone plates, or two parking_allowed rules), they likely regulate the same direction — the sign maker split one regulation across panels for space. If one plate in such a group has an explicit arrow and another plate of the same category has no arrow, the arrowless plate should inherit the arrow direction from its sibling. This only applies within the same category — never inherit arrows across different categories.

Your entire response must conform exactly to this JSON structure:
```
{
  "is_parking_sign": true,
  "confidence_readable": "high" | "medium" | "low",
  "rules": [
    {
      "category": "no_parking" | "parking_allowed" | "loading_zone" | "permit_required",
      "time_limit_minutes": <integer or null>,
      "days": ["mon","tue","wed","thu","fri","sat","sun"] or null,
      "time_start": "HH:MM" or null,
      "time_end": "HH:MM" or null,
      "payment_required": true | false | null,
      "permit_zone": "<zone identifier string or null>",
      "arrow_direction": "left" | "right" | "both" | "none" | null,
      "additional_text": "<any other text on this part of the sign or null>"
    }
  ],
  "tow_zones": [
    {
      "days": ["mon","tue","wed","thu","fri","sat","sun"] or null,
      "time_start": "HH:MM" or null,
      "time_end": "HH:MM" or null,
      "arrow_direction": "left" | "right" | "both" | "none" | null,
      "additional_text": "<any other text on this tow plate or null>"
    }
  ],
  "raw_text": "<all text you can read on the sign, top to bottom, separated by newlines>",
  "notes": "<anything ambiguous, partially occluded, or uncertain. null if nothing to note>"
}
```

## Field guidance
- **`category`:** `"parking_allowed"` covers all cases where parking is permitted, whether free or paid, with or without a time limit. Use `time_limit_minutes` and `payment_required` to distinguish the specifics. All other categories describe restrictions or prohibitions.
- **`payment_required`:** `true` if a meter, pay station, or "PAY" instruction applies. `false` if parking is free during this window. `null` if not determinable from the sign.
- **`days`:** List only the days this specific rule applies to. `"MON THRU FRI"` → `["mon","tue","wed","thu","fri"]`. `"EXCEPT SUNDAY"` → all days except Sunday.
- **`time_start` / `time_end`:** 24-hour format. `"7AM"` → `"07:00"`, `"6P"` → `"18:00"`. Never infer times from phone numbers, stall numbers, zone codes, or any other reference information printed on the sign — put those in `additional_text` or `notes` instead.
- **`arrow_direction`:** Direction from the sign post that this rule applies to. **CRITICAL:** Only use the arrow that appears on the same plate as this rule. Do NOT borrow arrows from plates of a different category. If the plate has no arrow symbol and no same-category sibling has one, use `null` or `"none"`. Otherwise inherit the arrow from the same-category sibling.
- **`confidence_readable`:** Reflects the hardest-to-read rule on the sign. If any plate is partially occluded or at a steep angle, set to `"low"` and explain in `"notes"`.
- Do NOT hallucinate text. If you cannot read a word, write `[illegible]` in `raw_text` and note it.
- Do NOT add any text, commentary, or formatting outside the JSON object."""


class OcrSignRequest(BaseModel):
    """Request for OCR parsing of a detected parking sign."""
    image_base64: str  # Base64-encoded image data


class OcrSignResponse(BaseModel):
    """Response from OCR parsing of a parking sign."""
    is_parking_sign: bool
    confidence_readable: Optional[str] = None
    rules: Optional[list[dict]] = None
    tow_zones: Optional[list[dict]] = None
    raw_text: Optional[str] = None
    notes: Optional[str] = None
    rejection_reason: Optional[str] = None
    inference_time_ms: float


@app.post("/ocr-sign", response_model=OcrSignResponse)
async def ocr_sign(request: OcrSignRequest):
    """
    Parse parking sign text using Gemini 3.1 Flash Lite Preview.

    Takes a base64-encoded cropped sign image and returns structured
    parking regulation data including rules, time limits, and payment info.
    """
    import asyncio
    import base64 as _b64
    raw = _b64.b64decode(request.image_base64[:32])
    mime = "image/png" if raw[:4] == b'\x89PNG' else "image/jpeg"

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not configured")

    model = os.environ.get("GEMINI_OCR_MODEL", "gemini-3.1-flash-lite-preview")

    start_time = time.time()

    max_retries = 3
    for attempt in range(max_retries):
        try:
            resp = await httpx_client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{
                        "parts": [
                            {"inline_data": {"mime_type": mime, "data": request.image_base64}},
                            {"text": OCR_PROMPT}
                        ]
                    }]
                },
                timeout=60.0
            )
            resp.raise_for_status()
            break
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)
                continue
            raise HTTPException(status_code=502, detail=f"OCR API error: {e.response.status_code} {e.response.reason_phrase}")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"OCR API error: {e}")

    inference_time_ms = (time.time() - start_time) * 1000

    data = resp.json()

    # Extract text from Gemini response format
    try:
        content = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError):
        raise HTTPException(status_code=502, detail=f"Unexpected response format: {data}")

    # Parse JSON response
    try:
        # Remove markdown code blocks if present
        if content.startswith("```"):
            lines = content.split("\n")
            # Drop opening ```json line
            lines = lines[1:]
            # Drop closing ``` line (handle trailing whitespace)
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            content = "\n".join(lines)

        parsed = _json.loads(content)
    except _json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"Failed to parse OCR response: {e}")

    return OcrSignResponse(
        is_parking_sign=parsed.get("is_parking_sign", False),
        confidence_readable=parsed.get("confidence_readable"),
        rules=parsed.get("rules"),
        tow_zones=parsed.get("tow_zones"),
        raw_text=parsed.get("raw_text"),
        notes=parsed.get("notes"),
        rejection_reason=parsed.get("rejection_reason"),
        inference_time_ms=round(inference_time_ms, 1)
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
