#!/usr/bin/env python3
"""Quick test to verify dataset and training setup works."""
from pathlib import Path
from ultralytics import YOLO

DATASET_PATH = Path("/kaggle/input/parking-sign-detection-coco-dataset")
DATA_YAML = DATASET_PATH / "data.yaml"

print(f"Dataset exists: {DATASET_PATH.exists()}")
print(f"Contents: {list(DATASET_PATH.iterdir())}")
print(f"data.yaml exists: {DATA_YAML.exists()}")

# Quick training test - 1 epoch
model = YOLO("yolo11n.pt")  # Use yolo11n for faster test
results = model.train(
    data=str(DATA_YAML),
    epochs=1,
    imgsz=512,
    batch=8,
    project="/kaggle/working/output/test_run",
    exist_ok=True,
)
print("Training test passed!")
