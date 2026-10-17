#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import number_parse as np  # noqa: E402


class NumberParse(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idx = np.build_reverse_index(2000)

    def test_simple_value(self):
        r = np.parse_numbers("फाइव हंड्रेड मिलीग्राम", self.idx)
        self.assertEqual([x["value"] for x in r], [500])

    def test_compound_read_as_one_span_not_split(self):
        r = np.parse_numbers("ट्वेंटी वन डेज़ बाद वापस", self.idx)
        self.assertEqual([x["value"] for x in r], [21])
        self.assertEqual(r[0]["token_span"], [0, 2])

    def test_multiple_distinct_numbers(self):
        r = np.parse_numbers("टेन डेज़ फिर फोर्टी फ़ाइव डेज़", self.idx)
        self.assertEqual([x["value"] for x in r], [10, 45])

    def test_native_number_word_not_parsed(self):
        # out of scope (en-by-ear only), same as ETR v1
        r = np.parse_numbers("चालीस मिलीग्राम", self.idx)
        self.assertEqual(r, [])

    def test_drug_name_fragment_is_not_a_false_parse(self):
        # regression: "फ़ॉर्म इन" (part of "Metformin") must not itself parse as any number
        r = np.parse_numbers("तो मेट फ़ॉर्म इन फाइव हंड्रेड", self.idx)
        self.assertEqual([x["value"] for x in r], [500])

    def test_empty_text(self):
        self.assertEqual(np.parse_numbers("", self.idx), [])

    def test_frequency_continuation_is_tagged_not_dropped(self):
        # lid-debug #4741 N1: "वन सडे" (once a day) must be tagged role=frequency, not silently a
        # value-1 dose -- a norm rule (B3 V2) that re-parses text and sees role=value only must reject
        # this, but the parse itself still records it (a real number was written, just not a dose).
        r = np.parse_numbers("वन सडे आफ़्टर फ़ूड", self.idx)
        self.assertEqual(len(r), 1)
        self.assertEqual(r[0]["value"], 1)
        self.assertEqual(r[0]["role"], "frequency")

    def test_ordinary_dose_value_is_tagged_value(self):
        r = np.parse_numbers("फाइव हंड्रेड मिलीग्राम", self.idx)
        self.assertEqual(r[0]["role"], "value")

    def test_nearby_cue_true_and_false(self):
        text = "फाइव हंड्रेड मिलीग्राम आफ़्टर फ़ूड"
        span = np.parse_numbers(text, self.idx)[0]["token_span"]
        import router_server as rs
        self.assertTrue(np.nearby_cue(text, span, rs._UNIT_CUE_WORDS))
        self.assertFalse(np.nearby_cue("फाइव लोग आए थे यहां पर", [0, 1], rs._UNIT_CUE_WORDS))


class ReverseIndexCollisions(unittest.TestCase):
    def test_no_collision_in_0_9999_and_build_succeeds(self):
        # lid-debug #4741 N2: fail LOUD on a collision, not silent first-wins. Empirically, 0-9999 has
        # none today; this test both proves that and pins the fail-loud behavior via the next test.
        idx = np.build_reverse_index(9999)
        self.assertGreater(len(idx), 0)

    def test_a_real_collision_raises(self):
        import router_server as rs
        import unittest.mock as mock
        original = rs._number_spellings_deva
        with mock.patch.object(rs, "_number_spellings_deva",
                              lambda v: ["same"] if v in (5, 7) else original(v)):
            with self.assertRaises(np.SpellingCollisionError):
                np.build_reverse_index(10)


if __name__ == "__main__":
    unittest.main()
