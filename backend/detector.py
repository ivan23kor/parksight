"""Use the trained parking sign model on a caller-supplied street photo."""

import base64
import io
import threading
import time
from pathlib import Path

from PIL import Image

MODEL_PATH = Path(__file__).parent / "models" / "best_openvino_model"
_model = None
_model_lock = threading.Lock()


def _get_model():
    global _model
    with _model_lock:
        if _model is None:
            from ultralytics import YOLO

            _model = YOLO(str(MODEL_PATH), task="detect")
        return _model


def _overlap(a, b):
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return intersection / max(1, area_a + area_b - intersection)


def _box_in_crop(box, bounds, size):
    """Map a photo-space box to normalized crop coordinates, clamped to the crop."""
    x1, y1, x2, y2 = box
    left, top, _, _ = bounds
    width, height = size
    return [
        round(min(max((x1 - left) / max(1, width), 0), 1), 4),
        round(min(max((y1 - top) / max(1, height), 0), 1), 4),
        round(min(max((x2 - left) / max(1, width), 0), 1), 4),
        round(min(max((y2 - top) / max(1, height), 0), 1), 4),
    ]


def _crop_data(image: Image.Image, box):
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    width = max(120, (x2 - x1) * 2.3)
    height = max(160, (y2 - y1) * 1.6)
    bounds = (
        max(0, round(cx - width / 2)),
        max(0, round(cy - height / 2)),
        min(image.width, round(cx + width / 2)),
        min(image.height, round(cy + height / 2)),
    )
    crop = image.crop(bounds)
    normalized = _box_in_crop(box, bounds, crop.size)
    if crop.width < 640:
        scale = min(3, 640 / max(1, crop.width))
        crop = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    crop.save(output, format="JPEG", quality=88)
    return base64.b64encode(output.getvalue()).decode("ascii"), normalized


def detect_photo(image: Image.Image) -> tuple[list[dict], int]:
    """Return sign crops from a caller-supplied street photo."""
    model = _get_model()
    started = time.perf_counter()
    image = image.convert("RGB")
    image.thumbnail((1800, 1400), Image.Resampling.LANCZOS)
    window_width, window_height = min(768, image.width), min(768, image.height)

    def offsets(length, window):
        step = max(1, window - 128)
        values = list(range(0, max(1, length - window + 1), step))
        last = max(0, length - window)
        if values[-1] != last:
            values.append(last)
        return values

    candidates = []
    for top in offsets(image.height, window_height):
        for left in offsets(image.width, window_width):
            window = image.crop((left, top, left + window_width, top + window_height))
            result = model.predict(window, conf=0.18, imgsz=512, verbose=False)[0]
            for box in result.boxes:
                x1, y1, x2, y2 = (float(value) for value in box.xyxy[0].tolist())
                candidates.append((float(box.conf[0]), (left + x1, top + y1, left + x2, top + y2)))

    accepted = []
    for confidence, box in sorted(candidates, reverse=True):
        if any(_overlap(box, existing[1]) > 0.45 for existing in accepted):
            continue
        accepted.append((confidence, box))
        if len(accepted) >= 12:
            break

    detections = []
    for confidence, box in accepted:
        crop_base64, normalized = _crop_data(image, box)
        detections.append({
            "confidence": round(confidence, 3),
            "box": normalized,
            "crop_base64": crop_base64,
        })
    return detections, round((time.perf_counter() - started) * 1000)
