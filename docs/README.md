# Parking Sign Detection Training

YOLO11 parking sign detector trained on Kaggle.

**Model:** YOLO11m (medium)

## Dataset

**Unified Parking Sign Detection Dataset** - `parking-sign-detection-coco-dataset.zip`

- **3,213 images** with 1 class (`parking_sign`)
- **Train/Val/Test split:** 2,570 / 321 / 322 (80/10/10)
- **Resolution:** 512x512 (standardized)
- **Format:** YOLO

## Quick Start (Kaggle)

1. Upload dataset to kaggle.com/datasets
2. Import notebook `06_parking_sign_training_highres.ipynb` or `04_parking_sign_training_controlled_negatives.ipynb`
3. Add dataset, enable GPU (T4), run

See `KAGGLE_RUN_CHECKLIST.md` for detailed run instructions.

## Experiment Status

See `EXPERIMENT_STATUS.md` for current experiment results.

## Files

```
notebooks/
├── 01_parking_sign_training.ipynb                      # Experiment A
├── 02_parking_sign_training_baseline.ipynb             # Experiment B (baseline)
├── 03_parking_sign_training_fullaug.ipynb              # Experiment B variant
├── 04_parking_sign_training_controlled_negatives.ipynb # Experiment C (pending)
├── 05_parking_sign_training_large_model.ipynb          # Experiment D (completed)
├── 06_parking_sign_training_highres.ipynb              # Experiment E (pending)
├── EXPERIMENT_STATUS.md                                 # Experiment tracking
└── KAGGLE_RUN_CHECKLIST.md                              # Run instructions
```

## Baseline (Version B)

- mAP50-95: 0.758
- mAP50: 0.989
- Precision: 0.980
- Recall: 0.962
