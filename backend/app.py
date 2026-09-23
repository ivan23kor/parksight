"""Small Calgary Tower map and sign review from shareable street photos."""

import asyncio
import base64
import binascii
import io
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel, Field

from backend.credentials import key
from backend.detector import MODEL_PATH, detect_photo
from backend.ocr import MODEL as OCR_MODEL, read_sign


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
client: httpx.AsyncClient | None = None
detection_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global client
    client = httpx.AsyncClient(timeout=25, limits=httpx.Limits(max_connections=16))
    yield
    await client.aclose()
    client = None


app = FastAPI(title="ParkSight Calgary Tower", lifespan=lifespan)


class ReadRequest(BaseModel):
    image_base64: str = Field(min_length=100, max_length=12_000_000)


@app.get("/api/config")
async def config():
    return {
        "google_maps_key": key("GOOGLE_MAPS_BROWSER_KEY"),
        "gemini_ready": bool(key("GEMINI_API_KEY")),
        "detector_ready": MODEL_PATH.is_dir(),
        "ocr_model": OCR_MODEL,
    }


@app.get("/api/health")
async def health():
    browser_ready = bool(key("GOOGLE_MAPS_BROWSER_KEY"))
    return {
        "status": "ready" if browser_ready and MODEL_PATH.is_dir() and key("GEMINI_API_KEY") else "map_only",
        "google_ready": browser_ready,
        "gemini_ready": bool(key("GEMINI_API_KEY")),
        "detector_ready": MODEL_PATH.is_dir(),
    }


@app.post("/api/detect-photo")
async def detect_uploaded_photo(request: ReadRequest):
    if not MODEL_PATH.is_dir():
        raise HTTPException(503, "Parking sign model is missing")
    try:
        image = Image.open(io.BytesIO(base64.b64decode(request.image_base64, validate=True)))
        if image.width * image.height > 50_000_000:
            raise ValueError("Photo is too large")
        async with detection_lock:
            detections, model_ms = await asyncio.to_thread(detect_photo, image)
        return {"detections": detections, "model_ms": model_ms}
    except (OSError, ValueError, binascii.Error) as error:
        raise HTTPException(400, f"Photo could not be read: {error}") from error


@app.post("/api/read-sign")
async def read(request: ReadRequest):
    if client is None:
        raise HTTPException(503, "OCR is unavailable")
    if not key("GEMINI_API_KEY"):
        raise HTTPException(503, "Gemini is not configured")
    try:
        return await read_sign(client, request.image_base64)
    except httpx.HTTPStatusError as error:
        raise HTTPException(502, f"Gemini returned {error.response.status_code}") from error
    except httpx.HTTPError as error:
        raise HTTPException(502, "Gemini could not be reached") from error
    except (KeyError, IndexError, ValueError) as error:
        raise HTTPException(502, f"Sign reading failed: {error}") from error


app.mount("/data", StaticFiles(directory=ROOT / "data"), name="data")
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
