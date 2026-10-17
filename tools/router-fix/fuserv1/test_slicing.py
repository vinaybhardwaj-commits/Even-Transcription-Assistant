#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import slicing as sl  # noqa: E402


class Slicing(unittest.TestCase):
    def test_no_tracks_gives_one_slice_for_the_whole_short_window(self):
        slices = sl.cut_slices(0, 20_000)
        self.assertEqual(len(slices), 1)
        self.assertEqual(slices[0]["cut_source"], "window")
        self.assertEqual((slices[0]["core_t0_ms"], slices[0]["core_t1_ms"]), (0, 20_000))

    def test_diar_turns_cut_at_speaker_boundaries(self):
        diar = [{"t0_ms": 0, "t1_ms": 10_000}, {"t0_ms": 10_000, "t1_ms": 25_000}]
        slices = sl.cut_slices(0, 25_000, diar_segments=diar)
        self.assertEqual([(s["core_t0_ms"], s["core_t1_ms"]) for s in slices], [(0, 10_000), (10_000, 25_000)])
        self.assertTrue(all(s["cut_source"] == "diar" for s in slices))

    def test_context_padding_clipped_to_window_bounds(self):
        diar = [{"t0_ms": 0, "t1_ms": 10_000}, {"t0_ms": 10_000, "t1_ms": 20_000}]
        slices = sl.cut_slices(0, 20_000, diar_segments=diar, context_ms=5_000)
        self.assertEqual(slices[0]["t0_ms"], 0)  # clipped at window start, not -5000
        self.assertEqual(slices[0]["t1_ms"], 15_000)  # 10000 + 5000 context
        self.assertEqual(slices[1]["t0_ms"], 5_000)  # 10000 - 5000 context
        self.assertEqual(slices[1]["t1_ms"], 20_000)  # clipped at window end

    def test_falls_back_to_vad_when_no_diar(self):
        vad = [{"t0_ms": 0, "t1_ms": 8_000}, {"t0_ms": 12_000, "t1_ms": 30_000}]
        slices = sl.cut_slices(0, 30_000, vad_segments=vad)
        self.assertTrue(all(s["cut_source"] == "vad" for s in slices))

    def test_diar_preferred_over_vad_when_both_present(self):
        diar = [{"t0_ms": 0, "t1_ms": 30_000}]
        vad = [{"t0_ms": 0, "t1_ms": 15_000}, {"t0_ms": 15_000, "t1_ms": 30_000}]
        slices = sl.cut_slices(0, 30_000, diar_segments=diar, vad_segments=vad)
        self.assertEqual(slices[0]["cut_source"], "diar")

    def test_long_turn_split_to_respect_max_slice_ms(self):
        diar = [{"t0_ms": 0, "t1_ms": 100_000}]  # a single 100s turn
        slices = sl.cut_slices(0, 100_000, diar_segments=diar, max_slice_ms=45_000)
        self.assertTrue(all(s["core_t1_ms"] - s["core_t0_ms"] <= 45_000 for s in slices))
        self.assertEqual(slices[0]["core_t0_ms"], 0)
        self.assertEqual(slices[-1]["core_t1_ms"], 100_000)
        # covers the whole span with no gaps or overlaps in the CORE spans
        for a, b in zip(slices, slices[1:]):
            self.assertEqual(a["core_t1_ms"], b["core_t0_ms"])

    def test_zero_length_gap_produces_no_empty_slice(self):
        diar = [{"t0_ms": 0, "t1_ms": 10_000}, {"t0_ms": 10_000, "t1_ms": 10_000}, {"t0_ms": 10_000, "t1_ms": 20_000}]
        slices = sl.cut_slices(0, 20_000, diar_segments=diar)
        self.assertTrue(all(s["core_t1_ms"] > s["core_t0_ms"] for s in slices))


if __name__ == "__main__":
    unittest.main()
