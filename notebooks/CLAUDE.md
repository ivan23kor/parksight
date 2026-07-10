# Training Agent Guide

## Purpose

`datasets/` and `notebooks/` contain the YOLO parking sign detector training pipeline. Training is intended to run on Kaggle GPUs; local runs are for scripts, inspection, and small checks only.

## Dataset

The unified YOLO dataset is built with:

```bash
python3 datasets/build_unified_dataset.py
```

The detector is single-class: `parking_sign`.

## Current Model State

The best documented configuration is YOLO11m with controlled negatives and augmentation. Historical experiment logs showed approximately `0.991` mAP50-95 for Experiment C, with YOLO11L providing no meaningful gain. The production model path used by the backend is `backend/models/best.pt`.

Treat old experiment notebooks as reproducibility artifacts, not live TODO lists. Issue #2 tracks real-world production validation and any data/model follow-up that is justified by observed failures.

## Notebook Roles

- `01_parking_sign_training.ipynb` - early baseline.
- `02_parking_sign_training_baseline.ipynb` - old no-negative baseline.
- `03_parking_sign_training_fullaug.ipynb` - augmentation experiment.
- `04_parking_sign_training_controlled_negatives.ipynb` - best documented controlled-negative run.
- `05_parking_sign_training_large_model.ipynb` - large-model comparison.
- `06_parking_sign_training_highres.ipynb` - high-resolution experiment that previously hit numpy compatibility issues.
- `07_parking_sign_training_best.ipynb` and `run_experiment_7.py` - extended version of the best configuration.

## When Adding Training Work

Add new work only when there is a current issue or observed production failure. Prefer diagnostics that produce false-positive/false-negative examples, confidence distributions, and concrete hard-negative candidates.
