# Parking Sign Detection Training

YOLO12 parking sign detector trained on Kaggle with documented augmentation experiments.

**Model:** YOLO12n (attention-centric architecture, 40.6 mAP on COCO)

## Dataset

**Unified Parking Sign Detection Dataset** - `unified-parking-signs.zip`

- **3,213 images** with 1 class (`parking_sign`)
- **Combined from:**
  - parking-sign-coco (Roboflow): 1,300 images, 512x512
  - sf-parking-signs (Figure Eight): 1,913 images, resized from 1050x1050
- **Train/Val/Test split:** 2,570 / 321 / 322 (80/10/10)
- **Resolution:** 512x512 (standardized)
- **Format:** YOLOv8 (ready to train)

## Quick Start

### 1. Upload Dataset to Kaggle

Manual upload at kaggle.com/datasets/new:
- Upload `datasets/unified-parking-signs.zip`
- Title: "Unified Parking Sign Detection Dataset"
- Make public

### 2. Create Notebook on Kaggle

1. Go to kaggle.com/code
2. New Notebook → Import `parking_sign_training.ipynb`
3. Add your dataset: "+ Add Data" → search "unified-parking-signs"
4. Enable GPU: Settings → Accelerator → GPU T4
5. Run all cells

### 3. Download Trained Model

After training, download from Kaggle:
- `parking_sign_detector.pt` - PyTorch weights
- `parking_sign_detector.onnx` - ONNX format

## Augmentation Experiments

| Experiment | Description | Key Augmentations |
|------------|-------------|-------------------|
| exp1_baseline | Minimal | mosaic=0.0 |
| exp2_mosaic | Mosaic | mosaic=1.0, scale=0.5 |
| exp3_hsv | Color | hsv_h/s/v shifts |
| exp4_geometric | Transforms | rotation, shear, perspective |
| exp5_full | All combined | Everything above |

### Pre-applied (in dataset)
- Roboflow subset: rotation ±15°, brightness ±15%, blur 0-2.5px
- SF subset: raw images (no augmentation)

## Expected Results

Training time: ~2-3 hours total for 5 experiments on Kaggle T4

Target metrics:
- mAP50: >0.90
- mAP50-95: >0.70

## Files

```
notebooks/
├── parking_sign_training.ipynb  # Main training notebook
└── README.md                    # This file

configs/
└── augmentation.yaml            # Augmentation parameters

datasets/
├── build_unified_dataset.py     # Dataset building script
├── unified-parking-signs.zip    # Kaggle upload (296MB)
└── unified-parking-signs/       # Built dataset
    ├── data.yaml                # YOLO12 config
    ├── train/                   # 2,570 images
    ├── valid/                   # 321 images
    └── test/                    # 322 images
```

## Usage

```python
from ultralytics import YOLO

model = YOLO("parking_sign_detector.pt")
results = model("street_image.jpg")
results[0].show()
```

## Data Sources

- Roboflow parking-sign dataset (CC BY 4.0)
- Figure Eight SF Parking Signs dataset
