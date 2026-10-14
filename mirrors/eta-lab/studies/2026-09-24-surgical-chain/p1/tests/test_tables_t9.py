import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import link3_tables_t9 as T9T


class T9TablesSelftest(unittest.TestCase):
    def test_selftest_invented_ids(self):
        self.assertEqual(T9T.selftest().split()[0], "link3_tables_t9")

    def test_rate_floor_below_ten_says_too_small(self):
        """Refuter-2 #2668 F1: with fewer than 10 scored non-excluded items there is no rate."""
        counts = T9T.rate_floor_checks()
        self.assertEqual(counts["small_scored"], 6)

    def test_rate_boundary_at_exactly_ten_shows_rate(self):
        counts = T9T.rate_floor_checks()
        self.assertEqual(counts["ten_scored"], 10)
        self.assertEqual(counts["rate"], "3/10")

    def test_leak_guard_fires(self):
        """Refuter-2 #2668 F2: an item id reaching the output blob is refused."""
        self.assertEqual(T9T.leak_guard_check(), "refused")


if __name__ == "__main__":
    unittest.main()
