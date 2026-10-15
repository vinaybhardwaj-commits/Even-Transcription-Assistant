#!/usr/bin/env python3
"""ADDENDUM-8 V7 fixtures: clinical content in English clause text must be supported by the clause's own
cited kept items / kept entities."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import number_parse as npm  # noqa: E402
import validator as v  # noqa: E402

RIDX = npm.build_reverse_index(200)
LEX = {"pantoprazole": 9, "ferrous sulfate": 5, "metformin": 8, "lansoprazole": 4}


def kept(idx, text, kind="copy", **extra):
    return idx, {"index": idx, "item": {"kind": kind, **extra}, "text": text}


def check(clause_text, cites, items, entities=()):
    kb = dict(items)
    return v.v7_check_clause({"text": clause_text, "native_idx": cites}, kb, list(entities), LEX, RIDX)


class V7Numbers(unittest.TestCase):
    def test_unsupported_dose_dropped(self):
        r = check("ferrous sulfate 800 mg", [0], [kept(0, "आयरन")])
        self.assertEqual(r["reason"], "clause_unsupported_number")
        self.assertEqual(r["unsupported_numbers"][0]["value"], "800")

    def test_digit_copy_supported(self):
        self.assertIsNone(check("take 500 mg", [0, 1], [kept(0, "500"), kept(1, "mg")]))

    def test_devanagari_english_by_ear_supported(self):
        self.assertIsNone(check("for twenty one days", [0], [kept(0, "ट्वेंटी वन")]))

    def test_indic_digits_supported(self):
        self.assertIsNone(check("take 500 mg", [0], [kept(0, "५००")]))

    def test_comma_and_decimal_canonical(self):
        self.assertIsNone(check("1,500 mg and 0.5 mg", [0], [kept(0, "1500 0.50")]))

    def test_entity_supports_number(self):
        ent = {"kind": "dose", "value": "40", "unit": "mg", "native_items": [0]}
        self.assertIsNone(check("forty mg", [0], [kept(0, "फोर्टी")], [ent]))

    def test_entity_outside_citations_does_not_support(self):
        ent = {"kind": "dose", "value": "40", "unit": "mg", "native_items": [1]}
        self.assertIsNotNone(check("forty mg", [0], [kept(0, "x"), kept(1, "40")], [ent]))

    def test_frequency_words_not_numbers(self):
        self.assertIsNone(check("twice a day, once at night", [0], [kept(0, "x")]))
        self.assertIsNone(check("three times a day", [0], [kept(0, "x")]))

    def test_compound_words_parse_as_one_value(self):
        nums = [n["value"] for n in v.v7_extract_numbers("twenty one, fifteen hundred, one hundred and five")]
        self.assertEqual(nums, ["21", "1500", "105"])

    def test_cited_but_wrong_value_dropped(self):
        self.assertIsNotNone(check("take 100 mg", [0], [kept(0, "500")]))

    def test_collateral_non_dose_flag(self):
        r = check("patient is 45 years old", [0], [kept(0, "x")])
        self.assertTrue(r["collateral_non_dose"])
        r = check("take 45 mg", [0], [kept(0, "x")])
        self.assertFalse(r["collateral_non_dose"])


class V7Drugs(unittest.TestCase):
    def test_drug_with_matching_entity_kept(self):
        ent = {"kind": "drug", "value": "pantoprazole", "unit": None, "native_items": [0]}
        self.assertIsNone(check("give pantoprazole", [0], [kept(0, "pantoprazole")], [ent]))

    def test_drug_no_support_dropped(self):
        r = check("give metformin", [0], [kept(0, "टैब")])
        self.assertEqual(r["reason"], "clause_unsupported_drug")
        self.assertEqual(r["unsupported_drugs"], ["metformin"])

    def test_cited_latin_copy_supports(self):
        self.assertIsNone(check("give Pantoprazole", [0], [kept(0, "Pantoprazole")]))

    def test_lexicon_generic_norm_supports_by_w(self):
        it = kept(0, "पैंटोप्राजोल", kind="norm", rule="lexicon_generic", w="pantoprazole")
        self.assertIsNone(check("give pantoprazole", [0], [it]))

    def test_ambiguous_match_is_not_a_drug(self):
        self.assertEqual(v.v7_drug_names("pantoprazole", {"pantoprazole": 1, "pantoprazola": 1}), set())

    def test_similar_but_different_drug_not_supported(self):
        r = check("give lansoprazole", [0], [kept(0, "pantoprazole")])
        self.assertEqual(r["reason"], "clause_unsupported_drug")


class V7Slice(unittest.TestCase):
    def test_filter_drops_whole_clause_clinical(self):
        kb = dict([kept(0, "500")])
        good = {"text": "500 mg", "native_idx": [0]}
        bad = {"text": "900 mg", "native_idx": [0]}
        k, d, _ = v.v7_filter_clauses([good, bad], kb, [], LEX, RIDX)
        self.assertEqual(k, [good])
        self.assertTrue(d[0]["clinical"])


class V7ValidateSlice(unittest.TestCase):
    def _run(self, clause_text, v7):
        import test_validator as tv
        resp = {"native_items": [{"kind": "copy", "refs": ["0:0:2"]}], "entities": [],
                "en_clauses": [{"text": clause_text, "native_idx": [0]}]}
        return v.validate_slice(resp, tv.FLAT, tv.RIDX, 0.95, tv.INDIC_TEXTS, tv.DRUG_CANDIDATES,
                                v7_lexicon=LEX if v7 else None)

    def test_supported_clause_unchanged(self):
        r = self._run("40 mg", True)
        self.assertEqual(r["outcome"], "pass")
        self.assertEqual(r["v7_dropped_clauses"], [])

    def test_unsupported_number_falls_back_and_keeps_pre_v7(self):
        r = self._run("800 mg", True)
        self.assertEqual(r["outcome"], "fallback")
        self.assertEqual(r["outcome_no_v7"], "pass")
        self.assertEqual(r["pre_v7"]["outcome"], "pass")
        self.assertTrue(r["clinical_dropped"])

    def test_v7_off_is_dd22636_behaviour(self):
        r = self._run("800 mg", False)
        self.assertEqual(r["outcome"], "pass")
        self.assertNotIn("v7_dropped_clauses", r)


LEX8 = dict(LEX, iron=3, urea=2, coq=1)


def check8(text, cites, items, policy):
    return v.v7_eval_clause({"text": text, "native_idx": cites}, dict(items), [], LEX8, RIDX, policy)


class V7Addendum8a(unittest.TestCase):
    def test_short_generic_exact_match_only_under_8a(self):
        items = [kept(0, "गोली")]
        self.assertIsNone(check8("iron tablet", [0], items, "built")[0])
        bad, info = check8("iron tablet", [0], items, "8a")
        self.assertEqual(bad["unsupported_drugs"], ["iron"])
        self.assertIsNone(check8("iron tablet", [0], [kept(0, "iron")], "8a")[0])

    def test_short_non_generic_word_skipped_and_counted(self):
        bad, info = check8("min vit tab", [0], [kept(0, "x")], "8a")
        self.assertIsNone(bad)
        self.assertGreaterEqual(info["skipped_short"], 1)

    def test_indic_drug_support_only_under_8a_and_tracked(self):
        items = [kept(0, "पैंटोप्राजोल")]
        self.assertEqual(check8("pantoprazole", [0], items, "built")[0]["unsupported_drugs"], ["pantoprazole"])
        bad, info = check8("pantoprazole", [0], items, "8a")
        self.assertIsNone(bad)
        self.assertEqual(info["only_indic_drugs"], ["pantoprazole"])

    def test_ascii_item_never_gets_indic_support(self):
        self.assertEqual(v.v7_indic_drug_names("pantoprazole", LEX8), set())

    def test_8a_drop_is_omission_no_fallback_and_replay_matches(self):
        import test_validator as tv
        resp = {"native_items": [{"kind": "copy", "refs": ["0:0:2"]}], "entities": [],
                "en_clauses": [{"text": "800 mg", "native_idx": [0]}, {"text": "40 mg", "native_idx": [0]}]}
        r = v.validate_slice(resp, tv.FLAT, tv.RIDX, 0.95, tv.INDIC_TEXTS, tv.DRUG_CANDIDATES,
                             v7_lexicon=LEX, v7_policy="8a")
        self.assertEqual(r["outcome"], "pass")
        self.assertEqual([c["text"] for c in r["en_clauses"]], ["40 mg"])
        self.assertEqual(len(r["v7_dropped_clauses"]), 1)
        self.assertFalse(r["v7_dropped_clauses"][0]["clinical"])
        self.assertTrue(r["v7_dropped_clauses"][0]["omission"])
        b = v.validate_slice(resp, tv.FLAT, tv.RIDX, 0.95, tv.INDIC_TEXTS, tv.DRUG_CANDIDATES, v7_lexicon=LEX)
        self.assertEqual(b["outcome"], "fallback")
        rb = v.v7_replay(b, LEX, tv.RIDX, "built")
        r8 = v.v7_replay(b, LEX, tv.RIDX, "8a")
        self.assertEqual(rb["outcome"], "fallback")
        self.assertEqual(r8["outcome"], "pass")
        self.assertEqual([c["text"] for c in r8["en_clauses"]], ["40 mg"])


if __name__ == "__main__":
    unittest.main()
