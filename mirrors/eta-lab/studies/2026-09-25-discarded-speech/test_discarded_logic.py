"""Tests for discarded_logic.py on INVENTED numbers. Run: python3 -B -W error::ResourceWarning -m unittest test_discarded_logic"""
import unittest
import discarded_logic as D


class LanguageTests(unittest.TestCase):
    def test_top1_when_dominant(self):
        self.assertEqual(D.room_languages({"kn": 80, "hi": 10}), (["kn"], "room-top1"))

    def test_top2_when_split(self):
        self.assertEqual(D.room_languages({"kn": 50, "hi": 40, "ta": 5}), (["kn", "hi"], "room-top2"))

    def test_too_few_indic_uses_the_corpus_pair(self):
        self.assertEqual(D.room_languages({"kn": 10, "en": 900}), (["kn", "hi"], "corpus-top2"))

    def test_non_indic_labels_are_ignored(self):
        self.assertEqual(D.room_languages({"en": 500, "und": 500, "hi": 60}), (["hi"], "room-top1"))

    def test_tie_breaks_alphabetically(self):
        self.assertEqual(D.room_languages({"ta": 30, "kn": 30, "hi": 1})[0], ["kn", "ta"])


class ChunkTests(unittest.TestCase):
    def test_splits_at_60_and_drops_short_tails(self):
        self.assertEqual(D.chunks([(0, 130)]), [(0.0, 60.0), (60.0, 120.0), (120.0, 130.0)])
        self.assertEqual(D.chunks([(0, 62)]), [(0.0, 60.0)])                       # a 2 s tail is under 5 s
        self.assertEqual(D.chunks([(10, 14)]), [])

    def test_each_span_is_cut_separately(self):
        self.assertEqual(D.chunks([(0, 30), (100, 190)]), [(0.0, 30.0), (100.0, 160.0), (160.0, 190.0)])


class WindowTests(unittest.TestCase):
    def row(self, n, s, diar, arm="indic", length=60.0):
        c = dict(arm=arm, lang="kn", n_words=n, score=s)
        return dict(len_s=length, best=D.best_output([c]), diar_s=diar, cands=[c])

    def test_substantive_needs_words_score_and_diarized_speech(self):
        b = dict(n_words=5, score=0.6)
        self.assertTrue(D.substantive(b, 5.0))
        self.assertFalse(D.substantive(dict(n_words=4, score=0.9), 30))
        self.assertFalse(D.substantive(dict(n_words=9, score=0.59), 30))
        self.assertFalse(D.substantive(b, 4.9))
        self.assertFalse(D.substantive(None, 30))

    def test_real_at_exactly_twenty_percent(self):
        rows = [self.row(20, 0.9, 40)] + [self.row(0, 1.0, 0) for _ in range(4)]      # 60 s of 300 s
        w = D.window_summary(rows)
        self.assertEqual((w["substantive_frac"], w["real"]), (0.2, True))
        self.assertFalse(D.window_summary([self.row(20, 0.9, 40)] + [self.row(0, 1.0, 0) for _ in range(5)])["real"])

    def test_text_without_diarized_speech_is_not_substantive(self):
        w = D.window_summary([self.row(30, 0.9, 1.0)])
        self.assertFalse(w["real"])
        self.assertEqual((w["text_only_frac"], w["diar_only_frac"]), (1.0, 0.0))

    def test_best_output_prefers_score_then_words(self):
        self.assertEqual(D.best_output([dict(arm="a", n_words=50, score=0.5), dict(arm="b", n_words=6, score=0.9)])["arm"], "b")
        self.assertEqual(D.best_output([dict(arm="a", n_words=5, score=0.9), dict(arm="b", n_words=9, score=0.9)])["arm"], "b")
        self.assertIsNone(D.best_output([]))

    def test_empty_window(self):
        self.assertEqual(D.window_summary([])["real"], False)


class DecisionTests(unittest.TestCase):
    def test_controls_must_separate(self):
        self.assertFalse(D.decide(10, 30, 6, 10, 0, 14)["controls_separate"])            # accepted 6 < 7
        self.assertFalse(D.decide(10, 30, 8, 10, 2, 14)["controls_separate"])            # noisy 2 > 1
        self.assertTrue(D.decide(0, 30, 7, 10, 1, 14)["controls_separate"])

    def test_verdict_bands(self):
        self.assertIn("MATERIALLY", D.decide(6, 30, 9, 10, 0, 14)["verdict"])
        self.assertIn("SOME", D.decide(2, 30, 9, 10, 0, 14)["verdict"])
        self.assertIn("SOME", D.decide(5, 30, 9, 10, 0, 14)["verdict"])
        self.assertIn("no material", D.decide(1, 30, 9, 10, 0, 14)["verdict"])
        self.assertIn("no material", D.decide(0, 30, 9, 10, 0, 14)["verdict"])

    def test_clopper_pearson_known_values(self):
        lo, hi = D.clopper_pearson(1, 30)
        self.assertAlmostEqual(hi, 0.1722, places=3)                                   # the 17.2 % refuter-2 quoted for 1/30
        self.assertAlmostEqual(lo, 0.0008, places=3)
        self.assertEqual(D.clopper_pearson(0, 30)[0], 0.0)
        self.assertAlmostEqual(D.clopper_pearson(0, 30)[1], 0.1157, places=3)
        self.assertEqual(D.clopper_pearson(30, 30)[1], 1.0)


class UnionTests(unittest.TestCase):
    def test_union_seconds(self):
        self.assertEqual(D.union_seconds([(0, 10), (5, 12), (20, 25)]), 17.0)
        self.assertEqual(D.union_seconds([]), 0.0)


if __name__ == "__main__":
    unittest.main()
