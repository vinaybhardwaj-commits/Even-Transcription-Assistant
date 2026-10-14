"""Tests for readability.py on INVENTED text only (generic greetings/words, no patient content). Run here:  python3 -B -W error::ResourceWarning -m unittest test_readability"""
import unittest
import readability as Rd

VOCAB = set("please take this tablet twice a day after food the doctor thank you good morning how are feeling today pain fever cough sleep water".split())
KN = "ನಮಸ್ಕಾರ ಡಾಕ್ಟರ್ ಹೇಗಿದ್ದೀರಿ ಇವತ್ತು ನೋವು ಇದೆಯಾ"
HI = "नमस्ते डॉक्टर साहब आज बुखार है और खांसी भी है"


def rd(text, lang="en", engine="whisper"):
    return Rd.readability(text, lang, engine, VOCAB)


class CleanTextTests(unittest.TestCase):
    def test_clean_english_is_not_flagged(self):
        r = rd("please take this tablet twice a day after food")
        self.assertEqual((r["score"], r["reasons"], r["flagged"]), (1.0, [], False))

    def test_clean_kannada_and_hindi_in_their_own_scripts(self):
        for lang, t in (("kn", KN), ("hi", HI)):
            r = rd(t, lang, "sravaani")
            self.assertEqual((r["reasons"], r["flagged"], r["script_match"]), ([], False, True), lang)

    def test_code_mixing_is_not_penalised(self):
        r = rd(KN + " BP check madidira", "kn", "sravaani")
        self.assertFalse(r["flagged"])
        self.assertNotIn("mixed_indic", r["reasons"])

    def test_digits_only_is_neutral(self):
        r = rd("120 80 72")
        self.assertEqual((r["score"], r["reasons"], r["dominant_script"]), (1.0, [], None))

    def test_empty_text(self):
        r = rd("")
        self.assertEqual((r["score"], r["flagged"], r["short"]), (1.0, False, True))


class GarbleTests(unittest.TestCase):
    def test_non_words_in_english(self):
        r = rd("zxqv vrtlk bnmkl plkjh wxyzq qrstu")
        self.assertIn("non_words", r["reasons"])
        self.assertTrue(r["flagged"])
        self.assertAlmostEqual(r["non_word_rate"], 1.0)

    def test_short_words_are_not_counted_as_non_words(self):
        r = rd("a b c xx zz qq")
        self.assertIsNone(r["non_word_rate"])

    def test_latin_from_an_indic_engine_is_flagged_even_with_an_unknown_label(self):
        r = rd("namaskara doctor eppadi irukkeenga inniku novu iruka", "und", "sravaani")
        self.assertIn("indic_engine_latin", r["reasons"])
        self.assertNotIn("script_mismatch", r["reasons"])                    # 'und' carries no expected script
        self.assertTrue(r["flagged"])

    def test_indic_label_with_latin_text_is_a_script_mismatch(self):
        r = rd("namaskara doctor eppadi irukkeenga", "kn", "sravaani")
        self.assertIn("script_mismatch", r["reasons"])
        self.assertEqual(r["score"], 0.0)                                      # 0.60 + 0.45 + ... capped

    def test_wrong_indic_script_for_the_label(self):
        r = rd(HI, "kn", "sravaani")
        self.assertIn("script_mismatch", r["reasons"])
        self.assertTrue(r["flagged"])

    def test_two_indic_scripts_mixed(self):
        r = rd(KN + " " + HI, "kn", "sravaani")
        self.assertIn("mixed_indic", r["reasons"])
        self.assertEqual(r["indic_scripts"], 2)

    def test_phrase_loop(self):
        r = rd("thank you doctor " * 5)
        self.assertIn("loop", r["reasons"])
        self.assertTrue(r["flagged"])

    def test_one_word_run(self):
        r = rd("ok ok ok ok ok ok")
        self.assertIn("token_run", r["reasons"])
        self.assertEqual(r["run_repeat"], 6)

    def test_low_variety_needs_twelve_tokens(self):
        self.assertIsNone(rd("good good good morning")["uniq_ratio"])
        r = rd("good morning good morning good morning good morning good morning good morning")
        self.assertIsNotNone(r["uniq_ratio"])
        self.assertIn("low_variety", r["reasons"])

    def test_giant_token(self):
        self.assertIn("giant_token", rd("please " + "x" * 34)["reasons"])


class ScoreTests(unittest.TestCase):
    def test_score_is_within_bounds_and_monotonic_with_penalties(self):
        a = rd("please take this tablet")["score"]
        b = rd("please take this tablet zxqv vrtlk bnmkl")["score"]
        c = rd("zxqv vrtlk bnmkl plkjh wxyzq qrstu")["score"]
        self.assertTrue(1.0 >= a > b > c >= 0.0)

    def test_flag_threshold_is_below_0_60(self):
        self.assertEqual(Rd.FLAG_BELOW, 0.60)
        f = Rd.features("please take this tablet", "en", VOCAB)
        s, _ = Rd.score(f, "whisper", "en")
        self.assertEqual(s, 1.0)


class VocabTests(unittest.TestCase):
    def test_vocab_needs_count_and_windows(self):
        v = Rd.build_vocab({"tablet": (50, 20), "rare": (50, 2), "once": (3, 3), "a": (100, 50)})
        self.assertEqual(v, {"tablet"})                                        # 'rare' too few windows, 'once' too few counts, 'a' too short


if __name__ == "__main__":
    unittest.main()
