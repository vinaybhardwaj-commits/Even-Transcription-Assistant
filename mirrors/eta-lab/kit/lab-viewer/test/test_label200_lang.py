"""427L R4: the >=85% single-language rule and share rounding over the identified speech.
Run: python3 -m unittest discover -s kit/lab-viewer/test -p 'test_label200_lang.py'"""
import importlib.util, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("m427", Path(__file__).resolve().parents[1] / "tools" / "make_label200_lang.py")
m427 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m427)


class T(unittest.TestCase):
    def test_single_when_one_covers_85_percent(self):
        ld, kind = m427.breakdown({"kn": 85.0, "en": 15.0})
        self.assertEqual(kind, "single")
        self.assertEqual(ld, [["kn", 100]])

    def test_multiple_below_85(self):
        ld, kind = m427.breakdown({"kn": 60.0, "en": 30.0, "hi": 10.0})
        self.assertEqual(kind, "multiple")
        self.assertEqual(sorted(x[1] for x in ld), [10, 30, 60])
        self.assertEqual(ld[0], ["kn", 60])

    def test_edge_just_below_85_is_multiple(self):
        ld, kind = m427.breakdown({"kn": 84.9, "en": 15.1})
        self.assertEqual(kind, "multiple")

    def test_und_is_not_a_language(self):
        # "und" is excluded from the denominator; the share is over IDENTIFIED speech only.
        ld, kind = m427.breakdown({"kn": 90.0, "und": 10.0})
        self.assertEqual(kind, "single")
        self.assertEqual(ld, [["kn", 100]])
        ld, kind = m427.breakdown({"und": 100.0})
        self.assertEqual(kind, "none")
        self.assertEqual(ld, [])

    def test_rounding_drops_small_and_sums_to_100(self):
        ld, _ = m427.breakdown({"kn": 50.0, "en": 48.0, "ta": 1.5, "ml": 0.5})
        self.assertEqual(sum(p for _, p in ld), 100)
        self.assertEqual([k for k, _ in ld], ["kn", "en"])

    def test_largest_remainder(self):
        ld, _ = m427.breakdown({"kn": 1, "en": 1, "hi": 1})
        self.assertEqual(sorted(p for _, p in ld), [33, 33, 34])

    def test_overlap_secs_clips_to_span(self):
        tl = [{"lang": "kn", "start_s": 0, "end_s": 10}, {"lang": "en", "start_s": 10, "end_s": 20}]
        by = m427.overlap_secs(tl, 5, 15)
        self.assertEqual(dict(by), {"kn": 5.0, "en": 5.0})

    def test_overlap_ignores_malformed(self):
        self.assertEqual(dict(m427.overlap_secs([{"lang": "kn"}, None, {"start_s": 0, "end_s": 5, "lang": "ta"}], 0, 5)), {"ta": 5.0})


if __name__ == "__main__":
    unittest.main()
