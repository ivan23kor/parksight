# Training Experiment Status

| Experiment | Notebook | Status | mAP50-95 | Notes |
|------------|----------|--------|----------|-------|
| A | 01 | ✅ Complete | ~0.775 | Negatives (91%) + no aug: unstable |
| B | 02 | ✅ Complete | 0.758 | No negatives + aug: **old baseline** |
| C | 04 | ✅ Complete | **0.991** ⭐ | Controlled negatives (20%) + aug |
| D | 05 | ✅ Complete | **0.990** ⭐ | Large model YOLO11L: no gain vs M |
| E | 06 | ❌ Failed | - | High res (1024px): numpy error |
| **7** | **07** | **🚀 READY** | **Target: >0.99** | **BEST CONFIG - extended training** |

## Recent Results (March 2025)

Both experiments C and D achieved **near-perfect performance** (0.99 mAP50-95):

| Metric | Exp C (YOLO11M) | Exp D (YOLO11L) |
|--------|-----------------|-----------------|
| Best mAP@50 | 0.972 (ep 45) | 0.971 (ep 35) |
| Best mAP@50-95 | **0.991** (ep 44) | **0.991** (ep 31) |
| Final mAP@50 | 0.971 | 0.962 |
| Final mAP@50-95 | 0.991 | 0.990 |
| Epochs trained | 52 | 38 |
| Parameters | 20M | 25M |

## Key Findings

### 🎯 Performance Leap
- **31% improvement** from old baseline (0.758 → 0.991 mAP50-95)
- Both experiments converged to nearly identical performance
- Model size (M vs L) made minimal difference

### 📊 Conclusions
1. **YOLO11M + Controlled Negatives** is optimal configuration
   - Same performance as larger model
   - Faster training (batch 16 vs 12)
   - More efficient inference

2. **Controlled negatives (20%)** strategy worked
   - Provided stable training
   - No overfitting to negatives

3. **~0.99 mAP50-95** may represent practical limit
   - Further improvements likely need:
     - More training data
     - Better annotation quality
     - Multi-scale/cascade architectures

## Experiment E: High Resolution (1024px)

**Status:** Failed with numpy compatibility error

**Original Hypothesis:** Small/distant signs cause recall/mAP50-95 issues

**Relevance:** **LOW** - Current results already excellent (0.99 mAP50-95)

**Recommendation:** **SKIP** unless:
- You need to detect very small signs (<20px)
- You're seeing specific failure cases on small signs

## Recommended Next Steps

### Option 1: Deploy to Production ✅ RECOMMENDED
Current performance is production-ready:
- 0.99 mAP50-95 is near-perfect
- YOLO11M is efficient for real-time inference
- Model is stable and well-trained

### Option 2: Address Specific Failure Modes
If you're seeing specific issues:
1. **Analyze false positives/negatives** on test set
2. **Targeted data collection** for failure cases
3. **Hard negative mining** for specific scenarios

### Option 3: Edge Case Experiments (if needed)
- **F: Multi-scale training** - Better for varying sign sizes
- **G: Tiled inference** - For very high-res input images
- **H: Ensemble** - Combine multiple models for edge cases

## Environment Fixes Applied

Notebooks 04 and 06 include numpy compatibility fix:
```python
!pip install "numpy<2" --force-reinstall -q
```

Notebook 06 needs verification that fix is in correct order (ultralytics first, then numpy downgrade).
