#!/usr/bin/env python3
"""
Simple parking sign detection inference.
Usage: python run_inference.py <image_path>
"""
import sys
from pathlib import Path
from ultralytics import YOLO
import cv2

MODEL_PATH = Path(__file__).parent / "output/test_run/train/weights/best.pt"

def main():
    if len(sys.argv) < 2:
        print("Usage: python run_inference.py <image_path>")
        sys.exit(1)

    img_path = Path(sys.argv[1])
    if not img_path.exists():
        print(f"Image not found: {img_path}")
        sys.exit(1)

    print(f"Loading model: {MODEL_PATH}")
    model = YOLO(str(MODEL_PATH))
    print(f"Classes: {model.names}")

    print(f"\nRunning inference on: {img_path}")
    results = model.predict(str(img_path), conf=0.25)

    # Display results
    for r in results:
        if r.boxes is not None:
            print(f"\nDetections: {len(r.boxes)}")
            for i, box in enumerate(r.boxes):
                cls = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                print(f"  [{i}] {model.names[cls]}: {conf:.3f} @ [{x1:.0f}, {y1:.0f}, {x2:.0f}, {y2:.0f}]")
        else:
            print("No detections")

    # Show annotated image
    print("\nDisplaying results...")
    for r in results:
        im = r.plot()
        cv2.imshow("Parking Sign Detection", im)
        print("Press any key to close...")
        cv2.waitKey(0)
        cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
