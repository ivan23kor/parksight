"""
Parking Sign Detection API.
FastAPI backend for YOLO11 inference on Street View images.
"""
import io
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel
from ultralytics import YOLO

# Paths
MODEL_PATH = Path(__file__).parent.parent / "notebooks/output/test_run/train/weights/best.pt"
DETECTION_IMAGES_DIR = Path(__file__).parent.parent / "detection_images"
DETECTION_IMAGES_DIR.mkdir(exist_ok=True)

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


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "model": str(MODEL_PATH.name)}


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
    results = model.predict(image, conf=request.confidence, verbose=False)
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
