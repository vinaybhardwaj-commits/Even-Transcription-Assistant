#!/usr/bin/env python3
"""Tests for validator.py -- FUSER v1's deterministic V1-V6 safety net. Includes the 5 adversarial
fixtures named in the design's build plan (section 8): fabricated ref, cross-track merge, gen dose,
Whisper sentence copy at p(en)<0.9, entity value mismatch. No REB dependency: validator.py's inputs are
plain dicts (token maps, reverse_index, lexicon, prepass-style aux data), matching how prepass.py itself
would call it after B1's tokenisation -- this suite tests the semantic layer in isolation.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import number_parse as npm  # noqa: E402
import validator as v  # noqa: E402

RIDX = npm.build_reverse_index(200)


def tok(k, s, i, text, t0=0, t1=100, citable=True):
    return {"id": f"{k}:{s}:{i}", "text": text, "t0_ms": t0, "t1_ms": t1, "interp": False, "citable": citable}


# A small realistic slice: whisper-auto (k=0) says "tab Pantoprazole 40 mg twice a day" (englified,
# p_en low since the real speech is Hindi); sravaani (k=1) has the native drug name + "twice a day"
# in Hindi, no native number word (so number recovery must come from the whisper digit anchor).
WHISPER_TOKENS = [tok(0, 0, 0, "tab"), tok(0, 0, 1, "Pantoprazole"), tok(0, 0, 2, "40"),
                 tok(0, 0, 3, "mg"), tok(0, 0, 4, "twice"), tok(0, 0, 5, "a"), tok(0, 0, 6, "day")]
SRAVAANI_TOKENS = [tok(1, 0, 0, "टैब"), tok(1, 0, 1, "पैंटोप्राजोल"), tok(1, 0, 2, "मिलीग्राम"),
                   tok(1, 0, 3, "दो"), tok(1, 0, 4, "बार"), tok(1, 0, 5, "रोज"),
                   # a +-5s CONTEXT token (outside the slice's core span) -- payload.py never shows its
                   # id to the model, but "k:s:i" ids are sequential/guessable (eta-refuter-2 #4811 F1).
                   tok(1, 0, 6, "पचास", citable=False)]
FLAT = v.flatten_tokens({"whisper-auto": WHISPER_TOKENS, "sravaani": SRAVAANI_TOKENS})
INDIC_TEXTS = {"sravaani": " ".join(t["text"] for t in SRAVAANI_TOKENS)}
DRUG_CANDIDATES = {
    "sravaani": [{"whisper_span": {"tokens": [WHISPER_TOKENS[1]], "text": "Pantoprazole"},
                 "indic_window": "पैंटोप्राजोल", "indic_tokens": [SRAVAANI_TOKENS[1]],
                 "match": {"name": "pantoprazole", "sim_whisper": 1.0, "sim_indic": 0.95}}],
}


def _resp(native_items, entities=None, en_clauses=None):
    return {"native_items": native_items, "entities": entities or [], "en_clauses": en_clauses or []}


class V1Refs(unittest.TestCase):
    def test_fabricated_ref_is_rejected(self):
        # ADVERSARIAL FIXTURE 1 (design section 8): a ref id that doesn't exist in the slice at all.
        item = {"kind": "copy", "refs": ["9:9:9"]}
        ok, reason = v.check_v1_refs(item["refs"], FLAT)
        self.assertFalse(ok)
        self.assertEqual(reason, "fabricated_ref:9:9:9")

    def test_cross_track_merge_is_rejected(self):
        # ADVERSARIAL FIXTURE 2: refs spliced together from two different tracks presented as one word.
        ok, reason = v.check_v1_refs(["0:0:1", "1:0:1"], FLAT)
        self.assertFalse(ok)
        self.assertEqual(reason, "cross_track_merge")

    def test_non_monotone_refs_within_a_track_rejected(self):
        ok, reason = v.check_v1_refs(["0:0:4", "0:0:1"], FLAT)
        self.assertFalse(ok)
        self.assertEqual(reason, "non_monotone_refs")

    def test_adjacent_same_track_refs_accepted(self):
        ok, reason = v.check_v1_refs(["0:0:0", "0:0:1"], FLAT)
        self.assertTrue(ok)

    def test_context_token_citation_rejected(self):
        # eta-refuter-2 #4811 F1 (BLOCKING): "1:0:6" is a real, real-track token id (not fabricated) but
        # sits outside the slice's core span (citable=False) -- payload.py never shows it to the model,
        # but ids are sequential/guessable, so V1 itself must refuse it, not just rely on the model never
        # guessing. Left unchecked, the same context words could be double-counted by two adjacent slices.
        ok, reason = v.check_v1_refs(["1:0:6"], FLAT)
        self.assertFalse(ok)
        self.assertEqual(reason, "cites_noncitable_token:1:0:6")

    def test_context_token_mixed_with_a_citable_one_still_rejected(self):
        ok, reason = v.check_v1_refs(["1:0:5", "1:0:6"], FLAT)
        self.assertFalse(ok)
        self.assertEqual(reason, "cites_noncitable_token:1:0:6")

    def test_empty_refs_rejected(self):
        ok, reason = v.check_v1_refs([], FLAT)
        self.assertFalse(ok)
        self.assertEqual(reason, "empty_refs")

    def test_ref_reused_across_two_items_is_caught_by_validate_items(self):
        items = [{"kind": "copy", "refs": ["1:0:1"]}, {"kind": "copy", "refs": ["1:0:1"]}]
        out = v.validate_items(items, FLAT, RIDX, None, {}, {})
        self.assertEqual(len(out["kept"]), 1)
        self.assertEqual(out["dropped"][0]["reason"], "ref_reused")

    def test_conflict_with_fewer_than_two_options_rejected(self):
        items = [{"kind": "conflict", "options": [{"refs": ["1:0:1"]}]}]
        out = v.validate_items(items, FLAT, RIDX, None, {}, {})
        self.assertEqual(out["dropped"][0]["reason"], "conflict_needs_two_options")

    def test_conflict_with_two_valid_options_kept(self):
        items = [{"kind": "conflict", "options": [{"refs": ["1:0:1"]}, {"refs": ["0:0:1"]}]}]
        out = v.validate_items(items, FLAT, RIDX, None, {}, {})
        self.assertEqual(len(out["kept"]), 1)


class V2Copy(unittest.TestCase):
    def test_plain_copy_with_no_w_hint_is_accepted(self):
        ok, reason, text = v.check_v2_copy({"kind": "copy", "refs": ["1:0:3", "1:0:4"]}, FLAT)
        self.assertTrue(ok)
        self.assertEqual(text, "दो बार")

    def test_copy_w_matching_materialised_text_is_accepted(self):
        ok, reason, text = v.check_v2_copy({"kind": "copy", "refs": ["1:0:0"], "w": "टैब"}, FLAT)
        self.assertTrue(ok)

    def test_copy_w_not_matching_materialised_text_is_rejected(self):
        # the model cites a real, innocuous token but CLAIMS it says something else entirely.
        ok, reason, text = v.check_v2_copy({"kind": "copy", "refs": ["1:0:0"], "w": "पैंटोप्राजोल"}, FLAT)
        self.assertFalse(ok)
        self.assertEqual(reason, "materialization_mismatch")


class V2Norm(unittest.TestCase):
    def test_number_digits_correct_value_accepted(self):
        item = {"kind": "norm", "refs": ["0:0:2"], "rule": "number_digits", "w": "40"}
        ok, reason, text = v.check_v2_norm(item, FLAT, RIDX, DRUG_CANDIDATES)
        self.assertTrue(ok, reason)

    def test_number_digits_wrong_value_rejected(self):
        item = {"kind": "norm", "refs": ["0:0:2"], "rule": "number_digits", "w": "44"}
        ok, reason, text = v.check_v2_norm(item, FLAT, RIDX, DRUG_CANDIDATES)
        self.assertFalse(ok)
        self.assertEqual(reason, "number_digits_value_mismatch")

    def test_number_digits_on_non_number_tokens_rejected(self):
        item = {"kind": "norm", "refs": ["0:0:0"], "rule": "number_digits", "w": "40"}
        ok, reason, text = v.check_v2_norm(item, FLAT, RIDX, DRUG_CANDIDATES)
        self.assertFalse(ok)
        self.assertEqual(reason, "number_digits_no_single_parse")

    def test_lexicon_generic_with_real_two_witness_backing_accepted(self):
        item = {"kind": "norm", "refs": ["0:0:1"], "rule": "lexicon_generic", "w": "pantoprazole"}
        ok, reason, text = v.check_v2_norm(item, FLAT, RIDX, DRUG_CANDIDATES)
        self.assertTrue(ok, reason)

    def test_lexicon_generic_without_real_backing_rejected(self):
        # a norm item claiming a drug generic name with NO matching drug_candidates entry at all -- the
        # "fabricated fact via norm instead of gen" shape of the gen-dose adversarial pattern.
        item = {"kind": "norm", "refs": ["0:0:0"], "rule": "lexicon_generic", "w": "metformin"}
        ok, reason, text = v.check_v2_norm(item, FLAT, RIDX, DRUG_CANDIDATES)
        self.assertFalse(ok)
        self.assertEqual(reason, "lexicon_generic_no_two_witness_backing")

    def test_lexicon_generic_indic_side_fragment_of_wider_match_rejected(self):
        # eta-refuter-2 #4811 F3: the OLD check accepted on `text in cands["indic_window"]` (substring),
        # so citing just ONE token of a wider two-token aligned match ("मिलीग्राम", textually contained
        # inside "पैंटोप्राजोल मिलीग्राम") could ride in on the real two-witness match for the DRUG word
        # alone. The fix requires refs == the exact aligned token-id set.
        wide_candidates = {"sravaani": [{
            "whisper_span": {"tokens": [WHISPER_TOKENS[1]], "text": "Pantoprazole"},
            "indic_window": "पैंटोप्राजोल मिलीग्राम",
            "indic_tokens": [SRAVAANI_TOKENS[1], SRAVAANI_TOKENS[2]],
            "match": {"name": "pantoprazole", "sim_whisper": 1.0, "sim_indic": 0.9},
        }]}
        # the exact aligned span (both tokens) is accepted:
        ok, reason, text = v.check_v2_norm(
            {"kind": "norm", "refs": ["1:0:1", "1:0:2"], "rule": "lexicon_generic", "w": "pantoprazole"},
            FLAT, RIDX, wide_candidates)
        self.assertTrue(ok, reason)
        # citing only the SECOND token (a fragment inside the window's rendered text, but not the whole
        # matched span) must be rejected -- it was never itself the thing that matched.
        ok, reason, text = v.check_v2_norm(
            {"kind": "norm", "refs": ["1:0:2"], "rule": "lexicon_generic", "w": "pantoprazole"},
            FLAT, RIDX, wide_candidates)
        self.assertFalse(ok)
        self.assertEqual(reason, "lexicon_generic_no_two_witness_backing")

    def test_split_rule_correct_concatenation_accepted(self):
        toks = {"a:0:0": {"id": "a:0:0", "text": "fourtymg", "engine": "whisper-auto", "citable": True}}
        item = {"kind": "norm", "refs": ["a:0:0"], "rule": "split", "w": "fourty mg"}
        ok, reason, text = v.check_v2_norm(item, toks, RIDX, {})
        self.assertTrue(ok, reason)

    def test_split_rule_bad_concatenation_rejected(self):
        toks = {"a:0:0": {"id": "a:0:0", "text": "fourtymg", "engine": "whisper-auto", "citable": True}}
        item = {"kind": "norm", "refs": ["a:0:0"], "rule": "split", "w": "fourty milligrams"}
        ok, reason, text = v.check_v2_norm(item, toks, RIDX, {})
        self.assertFalse(ok)
        self.assertEqual(reason, "split_concatenation_mismatch")

    def test_unknown_rule_rejected(self):
        item = {"kind": "norm", "refs": ["0:0:0"], "rule": "made_up", "w": "x"}
        ok, reason, text = v.check_v2_norm(item, FLAT, RIDX, DRUG_CANDIDATES)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("unknown_rule"))


class V3Gen(unittest.TestCase):
    """V3 is a closed ALLOWLIST (lid-debug #4774, replacing an earlier blocklist-shaped check that had a
    real safety hole: a gen'd NATIVE number word wasn't recognised as a number at all by the English-by-
    ear-only reverse_index, so it sailed straight through -- an invented dose could reach the output text
    with no citation. The fix inverts to a closed connecting-word list + a hard digit/Latin-letter bar,
    so no number in ANY script or spelling can ever pass as gen, only known-ordinary fillers can."""

    def test_ordinary_connecting_word_accepted(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "और"})
        self.assertTrue(ok, reason)

    def test_ordinary_english_filler_accepted(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "hmm"})
        self.assertTrue(ok, reason)

    def test_gen_ascii_digit_dose_rejected(self):
        # ADVERSARIAL FIXTURE 3: the model writes a bare digit dose with no citation at all.
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "40"})
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_has_digit")

    def test_gen_native_digit_numeral_rejected_hi(self):
        # lid-debug #4774's own requested fixture: a native-SCRIPT digit numeral, not ASCII.
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "५०"})  # Devanagari "50"
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_has_digit")

    def test_gen_native_digit_numeral_rejected_kn(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "೫೦"})  # Kannada "50"
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_has_digit")

    def test_gen_native_number_word_rejected_hi(self):
        # THE safety hole this fix closes: "पचास" (fifty) is not in reverse_index at all (English-by-ear
        # scope only) -- the old blocklist-shaped check let this straight through as "not a number".
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "पचास"})
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_native_number_word_rejected_kn(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "ಐವತ್ತು"})  # fifty
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_native_number_word_rejected_ta(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "ஐம்பது"})  # fifty
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_native_number_word_rejected_te(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "యాభై"})  # fifty
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_native_number_word_rejected_ml(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "അമ്പത്"})  # fifty
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_unit_word_rejected_not_on_allowlist(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "mg"})
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_has_latin_letters")

    def test_gen_drug_like_latin_word_rejected(self):
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "Pantoprazole"})
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_has_latin_letters")

    def test_allowlist_exact_match_wins_over_latin_bar_pinned(self):
        # lid-debug #4778: pin the explicit resolution -- an EXACT allowlist hit on a plain Latin word
        # ("and") is accepted despite the Latin-letter bar, while any OTHER Latin word (not on the tiny
        # closed list, however innocuous) still falls through to the bar and is rejected. Never fuzzy or
        # prefix matching: "ands" (not the literal listed word) must NOT ride in on "and" being close.
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "and"})
        self.assertTrue(ok, reason)
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "ands"})
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_has_latin_letters")
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "then"})  # ordinary but NOT on the closed list
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_has_latin_letters")

    def test_hi_en_code_switch_connectors_accepted(self):
        # lid-debug #4778's own example list for option (b): "and"/"so" are common hi-en code-switch
        # connectors, added to match their stated expectation of what the closed list should contain.
        for w in ("and", "so"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertTrue(ok, f"{w!r}: {reason}")

    def test_gen_affirmation_or_negation_rejected_hi(self):
        # lid-debug #4801 / eta-refuter-2 #4811 F2: an INVENTED yes/no with no citation flips a clinical
        # fact ("allergy? no" <-> "allergy? yes") -- same harm class as an invented dose, never gen-able.
        for w in ("नहीं", "ना", "हाँ", "हां"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertFalse(ok, f"{w!r} must be rejected")
            self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_affirmation_or_negation_rejected_kn(self):
        for w in ("ಹೌದು", "ಅಲ್ಲ", "ಇಲ್ಲ"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertFalse(ok, f"{w!r} must be rejected")
            self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_affirmation_or_negation_rejected_ta(self):
        for w in ("ஆமா", "இல்லை", "ஆம்"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertFalse(ok, f"{w!r} must be rejected")
            self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_affirmation_or_negation_rejected_te(self):
        for w in ("అవును", "లేదు"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertFalse(ok, f"{w!r} must be rejected")
            self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_affirmation_or_negation_rejected_ml(self):
        for w in ("അല്ല", "ഇല്ല"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertFalse(ok, f"{w!r} must be rejected")
            self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_affirmation_or_negation_rejected_en(self):
        for w in ("yes", "no", "haan"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertFalse(ok, f"{w!r} must be rejected")
            self.assertEqual(reason, "gen_has_latin_letters")

    def test_gen_consent_ambiguous_okay_equivalents_rejected_every_language(self):
        # lid-debug called "okay"/"ok" borderline ("can mean consent") and said to drop them; the same
        # reasoning is applied to every language's exact equivalent, not just the two English spellings.
        for w in ("ok", "okay", "अच्छा", "ठीक", "ಸರಿ", "சரி", "సరే", "ശരി"):
            ok, reason = v.check_v3_gen({"kind": "gen", "w": w})
            self.assertFalse(ok, f"{w!r} must be rejected")

    def test_gen_unrecognised_native_word_not_on_allowlist_rejected(self):
        # not a number, not a known filler either -- the allowlist's closed-world default is reject,
        # which costs recall (a real ordinary word might get dropped) but never lets fabrication through.
        ok, reason = v.check_v3_gen({"kind": "gen", "w": "अस्पताल"})  # "hospital" -- not on the list
        self.assertFalse(ok)
        self.assertEqual(reason, "gen_not_in_allowlist")

    def test_gen_flows_through_validate_items_and_is_dropped(self):
        items = [{"kind": "gen", "w": "40"}]
        out = v.validate_items(items, FLAT, RIDX, None, {}, {})
        self.assertEqual(out["dropped"][0]["reason"], "gen_has_digit")


class V4WhisperGate(unittest.TestCase):
    def test_high_p_en_whisper_citation_needs_no_anchor(self):
        item = {"kind": "copy", "refs": ["0:0:0", "0:0:1"]}
        ok, reason = v.check_v4_whisper_gate(item, FLAT, "tab Pantoprazole", 0.95, INDIC_TEXTS, DRUG_CANDIDATES)
        self.assertTrue(ok)

    def test_low_p_en_whole_sentence_copy_unanchored_rejected(self):
        # ADVERSARIAL FIXTURE 4: at p(en) < 0.9, copying a whole fluent English SENTENCE (not an
        # isolated, anchored number/unit/drug) must be rejected -- this is exactly L1's failure mode.
        refs = [t["id"] for t in WHISPER_TOKENS]
        text = " ".join(t["text"] for t in WHISPER_TOKENS)
        ok, reason = v.check_v4_whisper_gate({"kind": "copy", "refs": refs}, FLAT, text, 0.3, INDIC_TEXTS, {})
        self.assertFalse(ok)
        self.assertEqual(reason, "whisper_low_pen_unanchored")

    def test_low_p_en_isolated_number_with_indic_anchor_accepted(self):
        refs = ["0:0:2", "0:0:3"]  # "40 mg"
        # the anchor search targets ETR's own scope (English-by-ear spellings only, per L6/
        # number_parse.py) -- "फोर्टि" (phonetic "forty"), not the native Hindi word "चालीस".
        ok, reason = v.check_v4_whisper_gate({"kind": "copy", "refs": refs}, FLAT, "40 mg", 0.3,
                                             {"sravaani": "टैब पैंटोप्राजोल फोर्टि मिलीग्राम"}, {})
        self.assertTrue(ok, reason)

    def test_low_p_en_isolated_number_with_no_indic_anchor_rejected(self):
        refs = ["0:0:2", "0:0:3"]
        ok, reason = v.check_v4_whisper_gate({"kind": "copy", "refs": refs}, FLAT, "40 mg", 0.3,
                                             {"sravaani": "टैब पैंटोप्राजोल मिलीग्राम"}, {})
        self.assertFalse(ok)

    def test_low_p_en_drug_name_with_real_two_witness_match_accepted(self):
        ok, reason = v.check_v4_whisper_gate({"kind": "copy", "refs": ["0:0:1"]}, FLAT, "Pantoprazole", 0.3,
                                             {}, DRUG_CANDIDATES)
        self.assertTrue(ok, reason)

    def test_low_p_en_drug_name_without_two_witness_backing_rejected(self):
        ok, reason = v.check_v4_whisper_gate({"kind": "copy", "refs": ["0:0:1"]}, FLAT, "Pantoprazole", 0.3,
                                             {}, {})
        self.assertFalse(ok)

    def test_no_whisper_citation_at_all_is_exempt(self):
        ok, reason = v.check_v4_whisper_gate({"kind": "copy", "refs": ["1:0:0"]}, FLAT, "टैब", 0.1, {}, {})
        self.assertTrue(ok)

    def test_none_p_en_treated_as_unknown_not_trusted(self):
        # p_en is None ("no LID anywhere in the slice", prepass.py) -- not the same as high-confidence
        # English, so the anchor gate still applies (fail closed, per design L1/L4's spirit).
        refs = [t["id"] for t in WHISPER_TOKENS]
        text = " ".join(t["text"] for t in WHISPER_TOKENS)
        ok, reason = v.check_v4_whisper_gate({"kind": "copy", "refs": refs}, FLAT, text, None, INDIC_TEXTS, {})
        self.assertFalse(ok)


class V5Entities(unittest.TestCase):
    def test_valid_dose_entity_accepted(self):
        kept_by_index = {0: {"text": "40"}}
        out = v.validate_entities([{"kind": "dose", "value": "40", "native_items": [0]}], kept_by_index, RIDX)
        self.assertEqual(len(out["kept"]), 1)

    def test_dose_entity_value_mismatch_rejected(self):
        # ADVERSARIAL FIXTURE 5: entity claims a dose value the cited native item doesn't actually parse to.
        kept_by_index = {0: {"text": "40"}}
        out = v.validate_entities([{"kind": "dose", "value": "80", "native_items": [0]}], kept_by_index, RIDX)
        self.assertEqual(len(out["kept"]), 0)
        self.assertEqual(out["dropped"][0]["reason"], "value_mismatch")

    def test_drug_entity_matching_native_text_accepted(self):
        kept_by_index = {0: {"text": "pantoprazole"}}
        out = v.validate_entities([{"kind": "drug", "value": "pantoprazole", "native_items": [0]}], kept_by_index, RIDX)
        self.assertEqual(len(out["kept"]), 1)

    def test_drug_entity_mismatch_rejected(self):
        kept_by_index = {0: {"text": "pantoprazole"}}
        out = v.validate_entities([{"kind": "drug", "value": "lansoprazole", "native_items": [0]}], kept_by_index, RIDX)
        self.assertEqual(len(out["kept"]), 0)

    def test_entity_citing_a_dropped_item_index_has_no_valid_link(self):
        out = v.validate_entities([{"kind": "dose", "value": "40", "native_items": [7]}], {}, RIDX)
        self.assertEqual(out["dropped"][0]["reason"], "unlinked_native_item")

    def test_entity_with_no_native_items_at_all_rejected(self):
        out = v.validate_entities([{"kind": "freq", "value": "twice_daily", "native_items": []}], {0: {"text": "x"}}, RIDX)
        self.assertEqual(out["dropped"][0]["reason"], "unlinked_native_item")

    def test_non_numeric_non_drug_kind_only_needs_a_valid_link(self):
        kept_by_index = {0: {"text": "दो बार रोज"}}
        out = v.validate_entities([{"kind": "freq", "value": "twice_daily", "native_items": [0]}], kept_by_index, RIDX)
        self.assertEqual(len(out["kept"]), 1)


class V6Clauses(unittest.TestCase):
    def test_clause_citing_valid_item_kept(self):
        out = v.validate_clauses([{"text": "take 40 mg", "native_idx": [0]}], {0: {"text": "40"}}, 1)
        self.assertEqual(len(out["kept"]), 1)
        self.assertEqual(out["omissions"], [])

    def test_clause_with_no_native_idx_dropped(self):
        out = v.validate_clauses([{"text": "take it", "native_idx": []}], {0: {"text": "40"}}, 1)
        self.assertEqual(len(out["kept"]), 0)
        self.assertEqual(out["dropped"][0]["reason"], "no_valid_citation")

    def test_clause_citing_only_dropped_items_treated_as_uncited(self):
        out = v.validate_clauses([{"text": "take it", "native_idx": [9]}], {0: {"text": "40"}}, 1)
        self.assertEqual(len(out["kept"]), 0)

    def test_uncovered_item_counted_as_omission_not_dropped(self):
        out = v.validate_clauses([], {0: {"text": "40"}, 1: {"text": "और"}}, 2)
        self.assertEqual(out["omissions"], [0, 1])
        self.assertEqual(out["dropped"], [])


class OrchestratorOutcome(unittest.TestCase):
    def test_pass_when_nothing_dropped(self):
        resp = _resp([{"kind": "copy", "refs": ["1:0:0"]}],
                    en_clauses=[{"text": "tab", "native_idx": [0]}])
        out = v.validate_slice(resp, FLAT, RIDX, None, {}, {})
        self.assertEqual(out["outcome"], "pass")

    def test_repair_when_small_non_clinical_share_dropped(self):
        # 1 of 21 items dropped (non-clinical gen) is under the 5% ceiling and not a clinical item.
        items = [{"kind": "copy", "refs": ["1:0:0"]}] + [{"kind": "gen", "w": "और"}] * 19 + \
                [{"kind": "gen", "w": "40"}]  # the one clinical-looking gen among 21 total (~4.8%)
        resp = _resp(items)
        out = v.validate_slice(resp, FLAT, RIDX, None, {}, {})
        self.assertEqual(out["outcome"], "fallback")  # clinical_dropped forces fallback regardless of share
        self.assertTrue(out["clinical_dropped"])

    def test_repair_when_small_share_dropped_and_not_clinical(self):
        items = [{"kind": "copy", "refs": ["1:0:0"]}] + [{"kind": "gen", "w": "और"}] * 19 + \
                [{"kind": "copy", "refs": ["9:9:9"]}]  # 1 fabricated ref among 21 (~4.8%), non-clinical
        resp = _resp(items)
        out = v.validate_slice(resp, FLAT, RIDX, None, {}, {})
        self.assertEqual(out["outcome"], "repair")
        self.assertEqual(len(out["native_items"]), 20)

    def test_fallback_when_drop_share_exceeds_ceiling(self):
        items = [{"kind": "copy", "refs": ["1:0:0"]}] + [{"kind": "copy", "refs": ["9:9:9"]}] * 3
        resp = _resp(items)
        out = v.validate_slice(resp, FLAT, RIDX, None, {}, {})
        self.assertEqual(out["outcome"], "fallback")

    def test_fallback_when_any_clinical_item_dropped_even_if_share_tiny(self):
        items = [{"kind": "copy", "refs": ["1:0:0"]}] * 99 + \
                [{"kind": "norm", "refs": ["0:0:2"], "rule": "number_digits", "w": "999"}]
        resp = _resp(items)
        out = v.validate_slice(resp, FLAT, RIDX, None, {}, {})
        self.assertEqual(out["outcome"], "fallback")
        self.assertTrue(out["clinical_dropped"])

    def test_entities_and_clauses_validated_only_on_non_fallback_path(self):
        resp = _resp([{"kind": "norm", "refs": ["0:0:2"], "rule": "number_digits", "w": "40"}],
                    entities=[{"kind": "dose", "value": "40", "native_items": [0]}],
                    en_clauses=[{"text": "40 mg", "native_idx": [0]}])
        out = v.validate_slice(resp, FLAT, RIDX, 0.95, {}, {})  # p_en high: V4 doesn't gate this citation
        self.assertEqual(out["outcome"], "pass")
        self.assertEqual(len(out["entities"]), 1)
        self.assertEqual(len(out["en_clauses"]), 1)

    def test_no_items_at_all_is_a_trivial_pass(self):
        out = v.validate_slice(_resp([]), FLAT, RIDX, None, {}, {})
        self.assertEqual(out["outcome"], "pass")
        self.assertEqual(out["dropped_share"], 0.0)


class Flatten(unittest.TestCase):
    def test_flatten_tags_each_token_with_its_engine(self):
        flat = v.flatten_tokens({"whisper-auto": [tok(0, 0, 0, "hi")]})
        self.assertEqual(flat["0:0:0"]["engine"], "whisper-auto")

    def test_materialize_joins_in_ref_order(self):
        self.assertEqual(v.materialize(["1:0:0", "1:0:1"], FLAT), "टैब पैंटोप्राजोल")

    def test_materialize_skips_unknown_refs_rather_than_crashing(self):
        self.assertEqual(v.materialize(["1:0:0", "9:9:9"], FLAT), "टैब")


if __name__ == "__main__":
    unittest.main()
