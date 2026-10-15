#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import whisper_lid as wl  # noqa: E402


def _seg(t0, t1, detected, p, probs=None):
    return {"t0_ms": t0, "t1_ms": t1,
            "extras": {"lid": {"detected": detected, "p": p, "probs": probs or {detected: p},
                               "scored_ms": [t0, min(t1, t0 + 30000)]}}}


class WhisperLid(unittest.TestCase):
    def test_single_segment_p_en(self):
        segs = [_seg(0, 3000, "en", 0.97, {"en": 0.97, "de": 0.01})]
        self.assertEqual(wl.slice_p_en(segs, 0, 3000), 0.97)

    def test_duration_weighted_mean_across_two_segments(self):
        segs = [_seg(0, 1000, "en", 0.9, {"en": 0.9}), _seg(1000, 4000, "hi", 0.1, {"en": 0.1, "hi": 0.8})]
        # weights: 1000ms @ 0.9, 3000ms @ 0.1 -> (1000*0.9 + 3000*0.1) / 4000 = 0.3
        self.assertAlmostEqual(wl.slice_p_en(segs, 0, 4000), 0.3, places=4)

    def test_missing_code_treated_as_zero(self):
        segs = [_seg(0, 1000, "hi", 0.8, {"hi": 0.8})]  # no "en" key at all
        self.assertEqual(wl.slice_p_en(segs, 0, 1000), 0.0)

    def test_no_lid_anywhere_is_none(self):
        segs = [{"t0_ms": 0, "t1_ms": 1000, "text": "x"}]  # no extras.lid
        self.assertIsNone(wl.slice_p_en(segs, 0, 1000))

    def test_only_partial_overlap_counted(self):
        segs = [_seg(0, 4000, "en", 1.0, {"en": 1.0})]
        # slice only covers [2000,4000) of the segment: overlap 2000ms, still full weight since it's
        # the only segment -> p_en should still be 1.0 (same value throughout)
        self.assertEqual(wl.slice_p_en(segs, 2000, 4000), 1.0)

    def test_segment_outside_slice_not_counted(self):
        segs = [_seg(0, 1000, "en", 1.0, {"en": 1.0}), _seg(5000, 6000, "hi", 1.0, {"hi": 1.0, "en": 0.0})]
        # slice is [0,1000): only the first segment overlaps
        self.assertEqual(wl.slice_p_en(segs, 0, 1000), 1.0)

    def test_top_languages_sorted_and_limited(self):
        segs = [_seg(0, 1000, "hi", 0.5, {"hi": 0.5, "en": 0.3, "ta": 0.1, "kn": 0.1})]
        top = wl.slice_top_languages(segs, 0, 1000, top_n=3)
        self.assertEqual([c for c, _ in top], ["hi", "en"] + (["ta"] if top[2][0] == "ta" else ["kn"]))
        self.assertEqual(len(top), 3)

    def test_top_languages_empty_when_no_lid(self):
        self.assertEqual(wl.slice_top_languages([{"t0_ms": 0, "t1_ms": 1000}], 0, 1000), [])


if __name__ == "__main__":
    unittest.main()
