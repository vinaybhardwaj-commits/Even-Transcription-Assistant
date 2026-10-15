#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tokenize_tracks as tt  # noqa: E402
import agreement as ag  # noqa: E402


class TokenizeTracks(unittest.TestCase):
    def test_uses_word_times_when_present(self):
        segs = [{"t0_ms": 0, "t1_ms": 2000, "text": "hello world",
                "words": [{"w": "hello", "t0_ms": 0, "t1_ms": 900},
                          {"w": "world", "t0_ms": 900, "t1_ms": 2000}]}]
        toks = tt.tokenize_track(0, segs)
        self.assertEqual([t["id"] for t in toks], ["0:0:0", "0:0:1"])
        self.assertFalse(toks[0]["interp"])
        self.assertEqual(toks[1]["t0_ms"], 900)

    def test_interpolates_evenly_when_no_word_times(self):
        segs = [{"t0_ms": 0, "t1_ms": 1000, "text": "one two three four"}]
        toks = tt.tokenize_track(1, segs)
        self.assertEqual(len(toks), 4)
        self.assertTrue(all(t["interp"] for t in toks))
        self.assertEqual(toks[0]["t0_ms"], 0)
        self.assertEqual(toks[-1]["t1_ms"], 1000)
        self.assertEqual(toks[1]["id"], "1:0:1")

    def test_empty_segment_contributes_nothing(self):
        segs = [{"t0_ms": 0, "t1_ms": 1000, "text": ""}]
        self.assertEqual(tt.tokenize_track(0, segs), [])

    def test_missing_span_still_emits_tokens_with_no_times(self):
        segs = [{"text": "hello world"}]
        toks = tt.tokenize_track(0, segs)
        self.assertEqual(len(toks), 2)
        self.assertIsNone(toks[0]["t0_ms"])

    def test_is_monotone_true_for_in_order_refs(self):
        flat = tt.tokenize_tracks({0: [{"t0_ms": 0, "t1_ms": 1000, "text": "a b c"}]})
        self.assertTrue(tt.is_monotone(["0:0:0", "0:0:1", "0:0:2"], flat))

    def test_is_monotone_false_for_backward_jump(self):
        flat = tt.tokenize_tracks({0: [{"t0_ms": 0, "t1_ms": 1000, "text": "a b c"}]})
        self.assertFalse(tt.is_monotone(["0:0:2", "0:0:0"], flat))


class Agreement(unittest.TestCase):
    def test_identical_text_agrees_fully(self):
        m = ag.agreement_matrix({"sravaani": "मेट फ़ॉर्म इन", "hi": "मेट फ़ॉर्म इन"})
        self.assertEqual(m["sravaani"]["hi"], 1.0)
        self.assertEqual(m["sravaani"]["sravaani"], 1.0)

    def test_empty_track_is_none_not_zero(self):
        m = ag.agreement_matrix({"sravaani": "मेट फ़ॉर्म इन", "ta": ""})
        self.assertIsNone(m["sravaani"]["ta"])

    def test_completely_different_text_scores_low(self):
        m = ag.agreement_matrix({"a": "मेट फ़ॉर्म इन फाइव हंड्रेड", "b": "पूरी तरह से अलग वाक्य यहां"})
        self.assertLess(m["a"]["b"], 0.5)

    def test_most_agreed_with_picks_the_highest(self):
        m = ag.agreement_matrix({"sravaani": "मेट फ़ॉर्म इन", "hi": "मेट फ़ॉर्म इन", "ta": "पूरी तरह अलग"})
        other, score = ag.most_agreed_with(m, "sravaani")
        self.assertEqual(other, "hi")
        self.assertEqual(score, 1.0)

    def test_most_agreed_with_none_when_no_comparable_evidence(self):
        m = ag.agreement_matrix({"sravaani": "", "ta": ""})
        self.assertEqual(ag.most_agreed_with(m, "sravaani"), (None, 0.0))




class LidDetectedTokens(unittest.TestCase):
    def test_tokens_carry_their_segments_detected_language(self):
        import tokenize_tracks as tt
        segs = [{"t0_ms": 0, "t1_ms": 1000, "text": "a b", "extras": {"lid": {"detected": "hi"}}},
                {"t0_ms": 1000, "t1_ms": 2000, "text": "c"}]
        toks = tt.tokenize_track(0, segs)
        self.assertEqual([t["lid_detected"] for t in toks], ["hi", "hi", None])


if __name__ == "__main__":
    unittest.main()
