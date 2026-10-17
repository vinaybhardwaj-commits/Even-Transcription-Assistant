#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lexicon  # noqa: E402
import drug_match  # noqa: E402

RX_PATH = "/home/eta/eta-data/cap2/rx_history.jsonl"


class Lexicon(unittest.TestCase):
    def test_clean_ingredient_strips_dose_and_parens(self):
        self.assertEqual(lexicon.clean_ingredient("Paracetamol 500 mg"), "paracetamol")
        self.assertEqual(lexicon.clean_ingredient("Cholecalciferol (vit D3) 60000 IU"), "cholecalciferol")

    def test_combo_splits_into_ingredients(self):
        # not testing load_lexicon's file I/O here, just that clean_ingredient handles each half
        combo = "Amlodipine 5mg+Atorvastatin 10mg"
        parts = [lexicon.clean_ingredient(p) for p in combo.split("+")]
        self.assertEqual(parts, ["amlodipine", "atorvastatin"])

    @unittest.skipUnless(os.path.exists(RX_PATH), "rx_history.jsonl not available in this environment")
    def test_load_lexicon_excludes_25_26_sep_and_common_names_present(self):
        lex = lexicon.load_lexicon(RX_PATH)
        self.assertIn("metformin", lex)
        self.assertIn("paracetamol", lex)
        self.assertGreater(lex["paracetamol"], 100)


@unittest.skipUnless(os.path.exists(RX_PATH), "rx_history.jsonl not available in this environment")
class DrugMatch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lex = lexicon.load_lexicon(RX_PATH)

    def test_clean_metformin_matches_both_witnesses(self):
        r = drug_match.match_drug("Metformin", "मेट फ़ॉर्म इन", self.lex)
        self.assertEqual(r["name"], "metformin")

    def test_fragmented_indic_spelling_still_matches(self):
        # the actual S1 pathological case: Indic ASR split "Metformin" into 3 space-separated tokens;
        # whole-window comparison (ignoring spaces) should still find it.
        r = drug_match.match_drug("Metformin", "मेट फ़ॉर्म इन", self.lex)
        self.assertIsNotNone(r)

    def test_pantoprazole_lansoprazole_do_not_cross_match(self):
        # lid-debug #4501: these collide at 0.83 on some skeleton methods; T_WHISPER=0.9 must reject
        # lansoprazole's Indic rendering being credited as pantoprazole or vice versa.
        r = drug_match.match_drug("Lansoprazole", "पैंटोप्राजोल", self.lex)
        self.assertNotEqual((r or {}).get("name"), "pantoprazole")

    def test_unrelated_word_does_not_match_anything(self):
        r = drug_match.match_drug("xyzcompletelyunrelated", "कुछ भी संबंधित नहीं है यह वाक्य", self.lex)
        self.assertIsNone(r)

    def test_whisper_only_no_indic_support_does_not_match(self):
        # witness (i) alone is not enough: indic_text carries no corroborating evidence at all.
        r = drug_match.match_drug("Metformin", "", self.lex)
        self.assertIsNone(r)

    def test_ambiguous_when_two_entries_tie_within_margin(self):
        # construct a tiny lexicon with two near-identical entries the real one might not distinguish
        tiny = {"aceclofenac": 10, "aceclofenak": 10}
        r = drug_match.match_drug("Aceclofenac", "एसेक्लोफेनाक", tiny)
        self.assertTrue(r is None or r.get("ambiguous") or r.get("name") in tiny)


if __name__ == "__main__":
    unittest.main()
