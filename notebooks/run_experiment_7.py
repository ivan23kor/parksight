#!/usr/bin/env python3
"""
Parking Sign Detection - Experiment 7: BEST CONFIGURATION

This script can be run directly on Kaggle or locally.
Combines all winning elements for maximum quality.

Usage on Kaggle:
    1. Upload dataset: parking-sign-detection-coco-dataset
    2. Create notebook with this as a single cell
    3. Run with GPU (P100 or T4)

Usage locally:
    python run_experiment_7.py --data-path /path/to/dataset
"""

from ultralytics import YOLO
import pandas as pd
import matplotlib.pyplot as plt
import shutil
import yaml
import os
import argparse
from pathlib import Path

# =============================================================================
# CONFIGURATION
# =============================================================================

TARGET_NEGATIVE_RATIO = 0.20  # 20% controlled negatives
RUN_NAME = "parking_sign_best"

TRAIN_PARAMS = {
    "epochs": 100,
    "patience": 12,
    "imgsz": 640,
    "batch": 16,
    "workers": 4,
    "device": "0,1",  # Multi-GPU - adjust if only 1 GPU
    "cos_lr": True,
    "lr0": 0.005,
    "lrf": 0.005,
    "optimizer": "auto",
    "weight_decay": 0.0005,
    "momentum": 0.937,
    # Full augmentation suite
    "mosaic": 1.0,
    "mixup": 0.08,
    "copy_paste": 0.05,
    "degrees": 8.0,
    "translate": 0.1,
    "scale": 0.4,
    "shear": 2.0,
    "perspective": 0.0001,
    "fliplr": 0.5,
    "flipud": 0.0,
    "hsv_h": 0.01,
    "hsv_s": 0.5,
    "hsv_v": 0.3,
    "close_mosaic": 25,
    "pretrained": True,
    "verbose": True,
    "save_period": 10,
    "exist_ok": True,
}

# =============================================================================
# SETUP
# =============================================================================

def setup_paths(data_path):
    """Setup paths based on environment."""
    if Path('/kaggle/input').exists():
        # Kaggle environment
        DATASET_PATH = Path('/kaggle/input/parking-sign-detection-coco-dataset/parking-sign-detection-coco-dataset')
        WORKING_PATH = Path('/kaggle/working')
    else:
        # Local environment
        DATASET_PATH = Path(data_path)
        WORKING_PATH = DATASET_PATH.parent

    FILTERED_PATH = WORKING_PATH / 'dataset_controlled_negatives'
    FILTERED_DATA_YAML = FILTERED_PATH / 'data.yaml'
    OUTPUT_PATH = WORKING_PATH

    return DATASET_PATH, FILTERED_PATH, FILTERED_DATA_YAML, OUTPUT_PATH

# =============================================================================
# DATETASET PREPARATION
# =============================================================================

def create_filtered_dataset(original_path, filtered_path, target_neg_ratio=0.20):
    """Create dataset with controlled negative samples."""
    if filtered_path.exists():
        print(f"Filtered dataset already exists at {filtered_path}")
        return filtered_path / 'data.yaml'

    print(f"Creating filtered dataset at {filtered_path}")
    print(f"Target negative ratio: {target_neg_ratio:.1%}")

    filtered_path.mkdir(parents=True, exist_ok=True)

    for split in ['train', 'valid', 'test']:
        (filtered_path / split / 'images').mkdir(parents=True, exist_ok=True)
        (filtered_path / split / 'labels').mkdir(parents=True, exist_ok=True)

        label_dir = original_path / split / 'labels'
        img_dir = original_path / split / 'images'

        if not label_dir.exists():
            continue

        label_files = list(label_dir.glob('*.txt'))

        positives = []
        negatives = []

        for label_file in label_files:
            with open(label_file, 'r') as f:
                content = f.read().strip()

            if not content or content.strip() == '':
                negatives.append(label_file)
            else:
                positives.append(label_file)

        n_positives = len(positives)
        n_negatives_to_sample = int(n_positives * target_neg_ratio / (1 - target_neg_ratio))

        if split != 'train':
            selected_labels = positives
        else:
            n_negatives_to_sample = min(n_negatives_to_sample, len(negatives))
            sampled_negatives = list(pd.Series(negatives).sample(n_negatives_to_sample, random_state=42))
            selected_labels = positives + sampled_negatives

        for label_file in selected_labels:
            shutil.copy(label_file, filtered_path / split / 'labels' / label_file.name)
            img_file = img_dir / (label_file.stem + '.jpg')
            if img_file.exists():
                shutil.copy(img_file, filtered_path / split / 'images' / img_file.name)

        print(f"{split}: {n_positives} positives + {len(negatives) if split == 'train' else 0} negatives = {len(selected_labels)} total")

    # Create filtered data.yaml
    original_data_yaml = original_path / 'data.yaml'
    with open(original_data_yaml, 'r') as f:
        original_config = yaml.safe_load(f)

    filtered_config = original_config.copy()
    filtered_config['path'] = str(filtered_path)
    filtered_config['train'] = str((filtered_path / 'train' / 'images'))
    filtered_config['val'] = str((filtered_path / 'valid' / 'images'))
    filtered_config['test'] = str((filtered_path / 'test' / 'images'))

    with open(filtered_path / 'data.yaml', 'w') as f:
        yaml.dump(filtered_config, f)

    return filtered_path / 'data.yaml'

# =============================================================================
# TRAINING
# =============================================================================

def train_model(data_yaml, output_path):
    """Train the model with best configuration."""
    print("=" * 60)
    print("TRAINING EXPERIMENT 7: BEST CONFIGURATION")
    print("=" * 60)
    print(f"\nConfiguration summary:")
    print(f"  Model: YOLO11m (20M params)")
    print(f"  Negatives: Controlled ({TARGET_NEGATIVE_RATIO:.0%} ratio)")
    print(f"  Augmentation: Full suite")
    print(f"  Training: {TRAIN_PARAMS['epochs']} max epochs, patience={TRAIN_PARAMS['patience']}")
    print(f"\nExpected results: mAP50-95 ~0.99")
    print("=" * 60)

    # Update params with paths
    params = TRAIN_PARAMS.copy()
    params["data"] = str(data_yaml)
    params["project"] = str(output_path / "runs")
    params["name"] = RUN_NAME

    # Load and train
    model = YOLO("yolo11m.pt")
    train_results = model.train(**params)

    return output_path / "runs" / RUN_NAME / "weights" / "best.pt"

# =============================================================================
# EVALUATION
# =============================================================================

def evaluate_model(model_path, data_yaml):
    """Evaluate model on test set."""
    print("\nEvaluating on test set...")

    model = YOLO(model_path)
    results = model.val(data=str(data_yaml), split="test")

    metrics = {
        'mAP50': results.box.map50,
        'mAP50_95': results.box.map,
        'precision': results.box.mp,
        'recall': results.box.mr,
    }

    print(f"\n{'='*50}")
    print(f"TEST SET RESULTS")
    print(f"{'='*50}")
    print(f"  Precision:  {metrics['precision']:.4f}")
    print(f"  Recall:     {metrics['recall']:.4f}")
    print(f"  mAP@50:     {metrics['mAP50']:.4f}")
    print(f"  mAP@50-95:  {metrics['mAP50_95']:.4f}")
    print(f"{'='*50}")

    return metrics

# =============================================================================
# MAIN
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description='Train parking sign detection model')
    parser.add_argument('--data-path', type=str, default='/kaggle/input/parking-sign-detection-coco-dataset/parking-sign-detection-coco-dataset',
                       help='Path to dataset')
    args = parser.parse_args()

    # Setup
    DATASET_PATH, FILTERED_PATH, FILTERED_DATA_YAML, OUTPUT_PATH = setup_paths(args.data_path)

    print(f"Dataset: {DATASET_PATH}")
    print(f"Output: {OUTPUT_PATH}")

    # Prepare dataset
    print("\n" + "="*60)
    print("PREPARING DATASET")
    print("="*60)
    create_filtered_dataset(DATASET_PATH, FILTERED_PATH, TARGET_NEGATIVE_RATIO)

    # Train
    print("\n" + "="*60)
    print("TRAINING")
    print("="*60)
    best_model_path = train_model(FILTERED_DATA_YAML, OUTPUT_PATH)

    # Evaluate
    print("\n" + "="*60)
    print("EVALUATION")
    print("="*60)
    metrics = evaluate_model(best_model_path, FILTERED_DATA_YAML)

    # Summary
    print(f"\n{'='*60}")
    print(f"FINAL SUMMARY")
    print(f"{'='*60}")
    print(f"Model saved to: {best_model_path}")
    print(f"mAP@50-95: {metrics['mAP50_95']:.4f}")

    if metrics['mAP50_95'] >= 0.99:
        print(f"\n✅ EXCELLENT - Model ready for deployment!")
    elif metrics['mAP50_95'] >= 0.98:
        print(f"\n✅ VERY GOOD - Near-production quality.")
    else:
        print(f"\n⚠️  May need further tuning.")

if __name__ == "__main__":
    main()
