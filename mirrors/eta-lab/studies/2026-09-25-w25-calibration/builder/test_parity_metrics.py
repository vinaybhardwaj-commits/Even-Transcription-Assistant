"""Visible tests for the builder calibration (the hidden acceptance suite is held by eta-refuter-2)."""
import unittest

import parity_metrics as P


class T(unittest.TestCase):
    def test_edit_rate_basic(self):
        self.assertEqual(P.edit_rate("abc", "abc"), 0.0)
        self.assertAlmostEqual(P.edit_rate("abcd", "abxd"), 0.25)

    def test_norm(self):
        self.assertEqual(P.norm("  Hello,   World!! "), "hello world")

    def test_repetition_simple(self):
        self.assertEqual(P.repetition_metrics(["hi there", "hi there", "ok"]), (2, 2, 0))

    def test_boundaries(self):
        self.assertTrue(P.boundaries_ok([(0.0, 1.0)], [(0.4, 1.3)]))
        self.assertFalse(P.boundaries_ok([(0.0, 1.0)], [(0.0, 1.0), (1.0, 2.0)]))

    def test_summary_empty(self):
        self.assertEqual(P.edit_rate_summary([]), {"n": 0, "max": None, "p95": None, "over_5pct": 0})


if __name__ == "__main__":
    unittest.main()
