#!/usr/bin/env python3
"""
Build unified parking sign dataset from multiple sources.
Outputs YOLOv8 format with single class: parking_sign
"""

import csv
import json
import shutil
import random
from pathlib import Path
from PIL import Image

# Configuration
RANDOM_SEED = 42
TARGET_SIZE = 512
TRAIN_RATIO = 0.8
VAL_RATIO = 0.1
TEST_RATIO = 0.1

BASE_DIR = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "parking-sign-detection-coco-dataset"


def convert_sf_parking_signs():
    """Convert SF parking signs from CSV to YOLO format."""
    sf_dir = BASE_DIR / "sf-parking-signs"

    annotations = []

    # Process training set
    train_csv = sf_dir / "trainingset_annotations.csv"
    train_img_dir = sf_dir / "trainingset" / "trainingset"

    with open(train_csv) as f:
        reader = csv.DictReader(f)
        for row in reader:
            img_name = row["image_name"].strip()
            img_path = train_img_dir / img_name
            if img_path.exists():
                annotations.append({
                    "image_path": img_path,
                    "xmin": int(row[" xmin"]) if " xmin" in row else int(row["xmin"]),
                    "xmax": int(row[" xmax"]) if " xmax" in row else int(row["xmax"]),
                    "ymin": int(row[" ymin"]) if " ymin" in row else int(row["ymin"]),
                    "ymax": int(row[" ymax"]) if " ymax" in row else int(row["ymax"]),
                    "source": "sf_train",
                })

    # Process validation set
    val_csv = sf_dir / "validationset_annotations.csv"
    val_img_dir = sf_dir / "validationset" / "validationset"

    with open(val_csv) as f:
        reader = csv.DictReader(f)
        for row in reader:
            img_name = row["image_name"].strip()
            img_path = val_img_dir / img_name
            if img_path.exists():
                annotations.append({
                    "image_path": img_path,
                    "xmin": int(row[" xmin"]) if " xmin" in row else int(row["xmin"]),
                    "xmax": int(row[" xmax"]) if " xmax" in row else int(row["xmax"]),
                    "ymin": int(row[" ymin"]) if " ymin" in row else int(row["ymin"]),
                    "ymax": int(row[" ymax"]) if " ymax" in row else int(row["ymax"]),
                    "source": "sf_val",
                })

    print(f"SF Parking Signs: {len(annotations)} annotations")
    return annotations


def convert_parking_sign_coco():
    """Convert parking-sign-coco to unified format."""
    coco_dir = BASE_DIR / "parking-sign-coco"

    annotations = []

    for split in ["train", "valid", "test"]:
        split_dir = coco_dir / split
        coco_json = split_dir / "_annotations.coco.json"

        if not coco_json.exists():
            continue

        with open(coco_json) as f:
            coco = json.load(f)

        images = {img["id"]: img for img in coco["images"]}

        for ann in coco["annotations"]:
            img_info = images[ann["image_id"]]
            img_path = split_dir / img_info["file_name"]

            if not img_path.exists():
                continue

            x, y, w, h = ann["bbox"]
            annotations.append({
                "image_path": img_path,
                "xmin": int(x),
                "xmax": int(x + w),
                "ymin": int(y),
                "ymax": int(y + h),
                "source": f"coco_{split}",
            })

    print(f"Parking Sign COCO: {len(annotations)} annotations")
    return annotations


def process_image(src_path: Path, dst_path: Path, annotations: list) -> list:
    """Resize image and adjust annotations."""
    img = Image.open(src_path)
    orig_w, orig_h = img.size

    # Resize to target size
    img_resized = img.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
    img_resized.save(dst_path, quality=95)

    # Scale annotations
    scale_x = TARGET_SIZE / orig_w
    scale_y = TARGET_SIZE / orig_h

    yolo_annotations = []
    for ann in annotations:
        xmin = ann["xmin"] * scale_x
        xmax = ann["xmax"] * scale_x
        ymin = ann["ymin"] * scale_y
        ymax = ann["ymax"] * scale_y

        # Convert to YOLO format: class x_center y_center width height (normalized)
        x_center = (xmin + xmax) / 2 / TARGET_SIZE
        y_center = (ymin + ymax) / 2 / TARGET_SIZE
        width = (xmax - xmin) / TARGET_SIZE
        height = (ymax - ymin) / TARGET_SIZE

        # Clamp values
        x_center = max(0, min(1, x_center))
        y_center = max(0, min(1, y_center))
        width = max(0, min(1, width))
        height = max(0, min(1, height))

        if width > 0.01 and height > 0.01:  # Skip tiny boxes
            yolo_annotations.append(f"0 {x_center:.6f} {y_center:.6f} {width:.6f} {height:.6f}")

    return yolo_annotations


def build_dataset():
    """Build unified dataset."""
    random.seed(RANDOM_SEED)

    # Collect all annotations
    sf_annotations = convert_sf_parking_signs()
    coco_annotations = convert_parking_sign_coco()

    # Group annotations by image
    image_annotations: dict[Path, list] = {}

    for ann in sf_annotations + coco_annotations:
        img_path = ann["image_path"]
        if img_path not in image_annotations:
            image_annotations[img_path] = []
        image_annotations[img_path].append(ann)

    # Get unique images
    all_images = list(image_annotations.keys())
    random.shuffle(all_images)

    print(f"\nTotal unique images: {len(all_images)}")

    # Split dataset
    n_train = int(len(all_images) * TRAIN_RATIO)
    n_val = int(len(all_images) * VAL_RATIO)

    train_images = all_images[:n_train]
    val_images = all_images[n_train:n_train + n_val]
    test_images = all_images[n_train + n_val:]

    print(f"Train: {len(train_images)}, Val: {len(val_images)}, Test: {len(test_images)}")

    # Create output directories
    for split in ["train", "valid", "test"]:
        (OUTPUT_DIR / split / "images").mkdir(parents=True, exist_ok=True)
        (OUTPUT_DIR / split / "labels").mkdir(parents=True, exist_ok=True)

    # Process images
    splits = [
        ("train", train_images),
        ("valid", val_images),
        ("test", test_images),
    ]

    total_annotations = 0

    for split_name, images in splits:
        print(f"\nProcessing {split_name}...")

        for i, img_path in enumerate(images):
            # Generate unique filename
            new_name = f"{split_name}_{i:05d}.jpg"
            dst_img = OUTPUT_DIR / split_name / "images" / new_name
            dst_label = OUTPUT_DIR / split_name / "labels" / new_name.replace(".jpg", ".txt")

            # Process image and get YOLO annotations
            yolo_anns = process_image(img_path, dst_img, image_annotations[img_path])

            # Write label file
            dst_label.write_text("\n".join(yolo_anns))
            total_annotations += len(yolo_anns)

            if (i + 1) % 500 == 0:
                print(f"  Processed {i + 1}/{len(images)}")

        print(f"  Completed {len(images)} images")

    # Create data.yaml
    data_yaml = f"""# Unified Parking Sign Detection Dataset
# Combined from: parking-sign-coco, sf-parking-signs
# Total images: {len(all_images)}
# Total annotations: {total_annotations}

path: {OUTPUT_DIR.resolve()}
train: train/images
val: valid/images
test: test/images

nc: 1
names: ['parking_sign']
"""

    (OUTPUT_DIR / "data.yaml").write_text(data_yaml)

    print(f"\n{'='*50}")
    print(f"Dataset built successfully!")
    print(f"Location: {OUTPUT_DIR}")
    print(f"Total images: {len(all_images)}")
    print(f"Total annotations: {total_annotations}")
    print(f"{'='*50}")


if __name__ == "__main__":
    build_dataset()
