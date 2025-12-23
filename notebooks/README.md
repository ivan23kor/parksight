# Parking Sign Detection Training

YOLOv8 parking sign detector trained on Kaggle with documented augmentation experiments.

## Dataset

- **Source**: Roboflow parking sign dataset
- **Images**: 1,300 (1,200 train / 75 val / 25 test)
- **Classes**: 6 (A, P, PX, R, S, Temp)
- **Resolution**: 512x512
- **Format**: COCO → YOLOv8

## Quick Start

### 1. Upload Dataset to Kaggle

```bash
# Install Kaggle CLI
uv pip install kaggle

# Initialize and upload
kaggle datasets init -p datasets/parking-sign-coco
kaggle datasets create -p datasets/parking-sign-coco --public
```

### 2. Create Notebook on Kaggle

1. Go to kaggle.com/code
2. New Notebook → Import `parking_sign_training.ipynb`
3. Add your dataset: "+ Add Data" → search your username
4. Enable GPU: Settings → Accelerator → GPU T4 x2
5. Run all cells

### 3. Download Trained Model

After training, download from Kaggle:
- `parking_sign_detector.pt` - PyTorch weights
- `parking_sign_detector.onnx` - ONNX format

## Augmentation Experiments

| Experiment | Description | Key Augmentations |
|------------|-------------|-------------------|
| exp1_baseline | Roboflow only | None |
| exp2_mosaic | + Mosaic | mosaic=1.0, scale=0.5 |
| exp3_hsv | + Color | hsv_h/s/v shifts |
| exp4_geometric | + Transforms | rotation, shear, perspective |
| exp5_full | All combined | Everything above |

Pre-applied by Roboflow: rotation ±15°, brightness ±15%, blur 0-2.5px

## Expected Results

Training time: ~30-45 min per experiment on Kaggle T4

Target metrics:
- mAP50: >0.85
- mAP50-95: >0.60

## Files

```
notebooks/
├── parking_sign_training.ipynb  # Main training notebook
└── README.md                    # This file

configs/
└── augmentation.yaml            # Augmentation parameters

datasets/parking-sign-coco/
├── convert_to_yolo.py           # Format conversion script
├── data.yaml                    # YOLOv8 config
├── train/                       # Training images + labels
├── valid/                       # Validation images + labels
└── test/                        # Test images + labels
```

## Usage

```python
from ultralytics import YOLO

model = YOLO("parking_sign_detector.pt")
results = model("street_image.jpg")
results[0].show()
```

## License

Dataset: CC BY 4.0 (Roboflow)
