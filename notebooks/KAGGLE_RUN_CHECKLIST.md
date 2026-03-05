# Kaggle Run Checklist

## Immediate Actions

### 1. Run Experiment E: High Resolution (1024px)
**Notebook:** `06_parking_sign_training_highres.ipynb`

**Status:** ✅ Ready (environment fix included)

**Run on Kaggle:**
1. Upload to Kaggle
2. Enable GPU (T4)
3. Run all cells
4. Download results when complete

**Expected metrics:**
- mAP50-95 > 0.775
- Recall > 0.962

---

### 2. Run Experiment C: Controlled Negatives
**Notebook:** `04_parking_sign_training_controlled_negatives.ipynb`

**Status:** ✅ Ready (environment fix included)

**Expected metrics:**
- Precision > 0.980
- Stable loss curve
- mAP50 ≥ 0.985

---

## Environment Fix (Already Applied)

Both notebooks include:
```python
!pip uninstall numpy -y -q
!pip install "numpy<2" -q
!pip install ultralytics -q
```

---

## Experiment D Results (Completed)

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Precision | 0.970 | - | ✅ Good |
| Recall | 0.939 | ≥0.985 | ❌ Missed |
| mAP50 | 0.979 | ≥0.985 | ❌ Missed |
| mAP50-95 | 0.735 | >0.775 | ❌ Missed |

**Conclusion:** Larger model (25M params) performed WORSE than Version B (20M params).
Bottleneck is **data quality/diversity, not model capacity**.

---

## Verification After Each Run

1. Check `results.csv` for final metrics
2. Compare with Version B baseline:
   - mAP50=0.989
   - mAP50-95=0.758
   - R=0.962
3. Document in `logs/logX.txt`
