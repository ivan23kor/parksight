"""
Unit tests for affine depth calibration fitting.
Tests fit_per_detection_affine() with known reference points.
"""

def fit_per_detection_affine(
    ref1_d_pred: float,
    ref1_d_real: float,
    ref1_size_px: float,
    ref2_d_pred: float,
    ref2_d_real: float,
    ref2_size_px: float,
) -> tuple:
    """
    Fit affine transform coefficients from two calibration references.
    For depth: d_real = s_d * d_pred + t_d
    """
    if ref1_d_pred == ref2_d_pred:
        return 1.0, 0.0, 1.0, 0.0

    denom = ref2_d_pred - ref1_d_pred
    s_d = (ref2_d_real - ref1_d_real) / denom
    t_d = ref1_d_real - s_d * ref1_d_pred
    s_s = s_d
    t_s_factor = (ref1_d_real - s_s * ref1_d_pred)

    return s_d, t_d, s_s, t_s_factor


# Test cases
test_cases = [
    {
        "name": "Linear mapping (no shift, scale=1.0)",
        "ref1": {"d_pred": 10.0, "d_real": 10.0, "size_px": 100},
        "ref2": {"d_pred": 20.0, "d_real": 20.0, "size_px": 50},
        "expected": {"s_d": 1.0, "t_d": 0.0, "s_s": 1.0, "t_s": 0.0},
    },
    {
        "name": "Scale with shift (s_d=1.5, t_d=-5.0)",
        "ref1": {"d_pred": 10.0, "d_real": 10.0, "size_px": 100},
        "ref2": {"d_pred": 20.0, "d_real": 25.0, "size_px": 50},
        # d_real = 1.5 * d_pred - 5.0
        # At ref1: 10.0 = 1.5 * 10.0 - 5.0 = 15.0 - 5.0 = 10.0 ✓
        # At ref2: 25.0 = 1.5 * 20.0 - 5.0 = 30.0 - 5.0 = 25.0 ✓
        "expected": {"s_d": 1.5, "t_d": -5.0, "s_s": 1.5, "t_s": -5.0},
    },
    {
        "name": "Scale correction (systematic underestimation, s_d=1.2)",
        "ref1": {"d_pred": 15.0, "d_real": 18.0, "size_px": 80},
        "ref2": {"d_pred": 25.0, "d_real": 30.0, "size_px": 48},
        # d_real = 1.2 * d_pred + 0.0
        # At ref1: 18.0 = 1.2 * 15.0 = 18.0 ✓
        # At ref2: 30.0 = 1.2 * 25.0 = 30.0 ✓
        "expected": {"s_d": 1.2, "t_d": 0.0, "s_s": 1.2, "t_s": 0.0},
    },
    {
        "name": "Identical predictions (edge case)",
        "ref1": {"d_pred": 15.0, "d_real": 18.0, "size_px": 80},
        "ref2": {"d_pred": 15.0, "d_real": 20.0, "size_px": 80},
        "expected": {"s_d": 1.0, "t_d": 0.0, "s_s": 1.0, "t_s": 0.0},
    },
]

# Run tests
print("Running fit_per_detection_affine() unit tests...\n")
passed = 0
failed = 0

for test in test_cases:
    s_d, t_d, s_s, t_s = fit_per_detection_affine(
        test["ref1"]["d_pred"],
        test["ref1"]["d_real"],
        test["ref1"]["size_px"],
        test["ref2"]["d_pred"],
        test["ref2"]["d_real"],
        test["ref2"]["size_px"],
    )

    expected = test["expected"]
    # Use tolerance for float comparison
    s_d_match = abs(s_d - expected["s_d"]) < 1e-6
    t_d_match = abs(t_d - expected["t_d"]) < 1e-6
    s_s_match = abs(s_s - expected["s_s"]) < 1e-6
    t_s_match = abs(t_s - expected["t_s"]) < 1e-6

    success = s_d_match and t_d_match and s_s_match and t_s_match

    if success:
        print(f"✓ {test['name']}")
        passed += 1
    else:
        print(f"✗ {test['name']}")
        print(f"  Expected: s_d={expected['s_d']}, t_d={expected['t_d']}")
        print(f"  Got:      s_d={s_d:.6f}, t_d={t_d:.6f}")
        failed += 1

print(f"\n{passed} passed, {failed} failed")
exit(1 if failed > 0 else 0)
