#!/usr/bin/env python3
"""
Build unified parking sign dataset from multiple sources.
Outputs YOLOv8 format with single class: parking_sign

Includes negative sample generation: crops background regions from annotated
images (areas without parking signs) to reduce false positives on cars,
business signs, and other non-target objects.
"""

import csv
import json
import shutil
import random
from pathlib import Path
from PIL import Image

# Configuration
RANDOM_SEED = 42
TARGET_SIZE = 640  # Standard YOLO size, better for small object detection
TRAIN_RATIO = 0.8
VAL_RATIO = 0.1
TEST_RATIO = 0.1

# Negative sample generation
NEGATIVES_PER_IMAGE = 10  # Background crops per annotated image
NEGATIVE_SIZE_JITTER = 0.5  # ±50% variation around sign size

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

        if width > 0.005 and height > 0.005:  # Keep smaller boxes for small sign detection
            yolo_annotations.append(f"0 {x_center:.6f} {y_center:.6f} {width:.6f} {height:.6f}")

    return yolo_annotations


def boxes_overlap(box_a, box_b):
    """Check if two boxes (xmin, ymin, xmax, ymax) overlap."""
    return not (box_a[2] <= box_b[0] or box_b[2] <= box_a[0] or
                box_a[3] <= box_b[1] or box_b[3] <= box_a[1])


def generate_negative_crops(img_path: Path, annotations: list, dst_dir_img: Path,
                            dst_dir_label: Path, prefix: str) -> int:
    """
    Crop background regions from an annotated image to use as negative samples.
    Crop sizes are similar to the parking sign sizes in that image (±jitter).
    Crops must not overlap any annotation, but may overlap each other.

    Returns the number of negative samples generated.
    """
    try:
        img = Image.open(img_path)
    except Exception:
        return 0

    orig_w, orig_h = img.size

    # Collect all annotation boxes in original image coords
    gt_boxes = []
    sign_widths = []
    sign_heights = []
    for ann in annotations:
        gt_boxes.append((ann["xmin"], ann["ymin"], ann["xmax"], ann["ymax"]))
        sign_widths.append(ann["xmax"] - ann["xmin"])
        sign_heights.append(ann["ymax"] - ann["ymin"])

    if not sign_widths:
        return 0

    # Use median sign size as the base for negative crop dimensions
    median_w = sorted(sign_widths)[len(sign_widths) // 2]
    median_h = sorted(sign_heights)[len(sign_heights) // 2]

    # Minimum crop must be at least 16px
    if median_w < 16 or median_h < 16:
        return 0

    count = 0
    max_attempts = NEGATIVES_PER_IMAGE * 30  # Avoid infinite loops

    for attempt in range(max_attempts):
        if count >= NEGATIVES_PER_IMAGE:
            break

        # Randomize crop size around the median sign size (±jitter)
        jitter_w = random.uniform(1 - NEGATIVE_SIZE_JITTER, 1 + NEGATIVE_SIZE_JITTER)
        jitter_h = random.uniform(1 - NEGATIVE_SIZE_JITTER, 1 + NEGATIVE_SIZE_JITTER)
        crop_w = max(16, int(median_w * jitter_w))
        crop_h = max(16, int(median_h * jitter_h))

        # Clamp to image bounds
        crop_w = min(crop_w, orig_w)
        crop_h = min(crop_h, orig_h)

        # Random position
        x1 = random.randint(0, orig_w - crop_w)
        y1 = random.randint(0, orig_h - crop_h)
        x2 = x1 + crop_w
        y2 = y1 + crop_h

        crop_box = (x1, y1, x2, y2)

        # Must not overlap any annotation (but may overlap other negatives)
        if any(boxes_overlap(crop_box, gt) for gt in gt_boxes):
            continue

        # Crop, resize to TARGET_SIZE, and save
        cropped = img.crop(crop_box)
        cropped_resized = cropped.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)

        neg_name = f"{prefix}_neg{count:02d}.jpg"
        cropped_resized.save(dst_dir_img / neg_name, quality=95)

        # Empty label file = background / no detections
        (dst_dir_label / neg_name.replace(".jpg", ".txt")).write_text("")

        count += 1

    return count


def build_dataset():
    """Build unified dataset with negative samples for reduced false positives."""
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
    total_negatives = 0

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

            # Generate negative crops (background regions) for training only
            if split_name == "train":
                neg_count = generate_negative_crops(
                    img_path, image_annotations[img_path],
                    OUTPUT_DIR / split_name / "images",
                    OUTPUT_DIR / split_name / "labels",
                    prefix=f"{split_name}_{i:05d}",
                )
                total_negatives += neg_count

            if (i + 1) % 500 == 0:
                print(f"  Processed {i + 1}/{len(images)}")

        print(f"  Completed {len(images)} images")

    total_images = len(all_images) + total_negatives

    # Create data.yaml
    data_yaml = f"""# Unified Parking Sign Detection Dataset
# Combined from: parking-sign-coco, sf-parking-signs
# Total images: {total_images} ({len(all_images)} annotated + {total_negatives} negative)
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
    print(f"Total annotated images: {len(all_images)}")
    print(f"Total negative samples: {total_negatives}")
    print(f"Total images: {total_images}")
    print(f"Total annotations: {total_annotations}")
    print(f"{'='*50}")


if __name__ == "__main__":
    build_dataset()
