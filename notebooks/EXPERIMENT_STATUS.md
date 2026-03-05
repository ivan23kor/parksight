# Training Experiment Status

| Experiment | Notebook | Status | Key Finding |
|------------|----------|--------|-------------|
| A | 01 | ✅ Complete | Negatives (91%) + no aug: unstable |
| B | 02 | ✅ Complete | No negatives + aug: **baseline** (mAP50-95=0.758) |
| C | 04 | ⏳ Ready | Controlled negatives (20%) + aug |
| D | 05 | ✅ Complete | Large model: **worse** than B (mAP50-95=0.735) |
| E | 06 | ⏳ Ready | High res (1024px): pending |

## Baseline (Version B) - Target to Beat
- **mAP50-95: 0.758** ← Main metric
- mAP50: 0.989
- Precision: 0.980
- Recall: 0.962

## Next Experiments Priority

### 1. Experiment E: High Resolution (1024px)
**Hypothesis:** Small/distant signs cause recall/mAP50-95 issues

### 2. Experiment C: Controlled Negatives (20%)
**Hypothesis:** Targeted negatives reduce false positives

## Data-Centric Experiments (if above fail)
- F: Multi-scale training
- G: Hard negative mining
- H: Sign cropping augmentation
- I: Dataset expansion (more diverse signs)

## Environment Fix Applied
Both notebooks 04 and 06 include:
```python
!pip uninstall numpy -y -q
!pip install "numpy<2" -q
!pip install ultralytics -q
```
