"""The detection box must map into crop coordinates for the popup overlay."""

import unittest

from backend.detector import _box_in_crop


class BoxInCropTest(unittest.TestCase):
    def test_inside_box_maps_to_fractions(self):
        self.assertEqual(
            _box_in_crop((120, 60, 200, 140), (100, 40, 300, 240), (200, 200)),
            [0.1, 0.1, 0.5, 0.5],
        )

    def test_box_equal_to_bounds_covers_crop(self):
        self.assertEqual(
            _box_in_crop((100, 40, 300, 240), (100, 40, 300, 240), (200, 200)),
            [0.0, 0.0, 1.0, 1.0],
        )

    def test_overflowing_box_clamps_to_crop(self):
        self.assertEqual(
            _box_in_crop((0, 0, 400, 400), (100, 40, 300, 240), (200, 200)),
            [0.0, 0.0, 1.0, 1.0],
        )


if __name__ == "__main__":
    unittest.main()
