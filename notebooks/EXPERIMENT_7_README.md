# Experiment 7: Best Configuration

## Overview

Combines all winning elements from Experiments C and D for maximum quality training.

## Configuration

| Component | Setting | Justification |
|-----------|---------|---------------|
| **Model** | YOLO11m | Proven best balance - same performance as L with 20% fewer params |
| **Negatives** | 20% controlled | Prevents overfitting, stable training |
| **Augmentation** | Full suite | Mosaic, mixup, copy-paste, rotation, scale, etc. |
| **Epochs** | 100 | Extended training for maximum quality |
| **Patience** | 12 | More time for late-stage improvements |
| **Batch** | 16 | Optimal for 2x Tesla T4 |
| **LR Schedule** | Cosine decay | Proven effective |

## Augmentation Details

```
mosaic: 1.0
mixup: 0.08
copy_paste: 0.05
degrees: 8.0 (rotation)
translate: 0.1
scale: 0.4
shear: 2.0
perspective: 0.0001
fliplr: 0.5
hsv_h: 0.01
hsv_s: 0.5
hsv_v: 0.3
```

## Running on Kaggle

### Option 1: Using the Notebook
1. Upload `07_parking_sign_training_best.ipynb` to Kaggle
2. Ensure dataset `parking-sign-detection-coco-dataset` is added
3. Enable GPU (P100 or T4 x2)
4. Run all cells

### Option 2: Using the Script
1. Create a new notebook on Kaggle
2. Add as a single cell:
```python
# Upload run_experiment_7.py as a dataset or paste content
!pip install ultralytics -q
!python run_experiment_7.py
```

## Expected Results

Based on Experiments C and D:
- **mAP@50-95:** ~0.99 (target)
- **mAP@50:** ~0.97
- **Precision:** ~0.96-0.98
- **Recall:** ~0.96-0.98

## Files Generated

| File | Description |
|------|-------------|
| `runs/parking_sign_best/weights/best.pt` | Best model (PyTorch) |
| `runs/parking_sign_best/weights/last.pt` | Last epoch model |
| `runs/parking_sign_best/results.csv` | Training metrics |
| `best_model.onnx` | ONNX export for CPU/edge |

## Next Steps After Training

1. **If mAP@50-95 ≥ 0.99:** Deploy to production
2. **If 0.98 ≤ mAP@50-95 < 0.99:** Analyze test failures
3. **If mAP@50-95 < 0.98:** Investigate data/label quality

## Deployment

For different environments:
- **GPU server:** Use `best.pt` with ultralytics
- **CPU/edge:** Use `best_model.onnx` with ONNX Runtime
- **Web apps:** Use ONNX + FastAPI/Flask backend

## Monitoring

Training produces these artifacts:
- Real-time progress bars
- Validation after each epoch
- Early stopping if no improvement for 12 epochs
- Saved checkpoints every 10 epochs
