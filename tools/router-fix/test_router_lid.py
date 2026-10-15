#!/usr/bin/env python3
"""
W31 router language fix (router-fix/lid). One TestCase per commit's change; synthetic text only.

RUN: ETA_JOBS_DIR=$(mktemp -d) /home/eta/services/eta-router-twin/venv/bin/python -m unittest test_router_lid -v
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import router_server as rs  # noqa: E402


class Resp:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


class WhisperLid(unittest.TestCase):
    def test_request_asks_for_verbose_json_and_no_language(self):
        seen = {}

        def post(url, files=None, data=None, timeout=None):
            seen.update(data)
            return Resp({"text": "x"})
        with mock.patch.object(rs.requests, "post", post), mock.patch("builtins.open", mock.mock_open(read_data=b"")):
            rs.whisper_infer("a.wav")
        self.assertEqual(seen["response_format"], "verbose_json")
        self.assertNotIn("language", seen)

    def test_lid_from_probabilities(self):
        r = {"detected_language": "hindi", "detected_language_probability": 0.7,
             "language_probabilities": {"hi": 0.7, "en": 0.2}}
        self.assertEqual(rs.whisper_lid(r), ("hi", 0.2))

    def test_lid_english_top_only(self):
        r = {"detected_language": "english", "detected_language_probability": 0.97}
        self.assertEqual(rs.whisper_lid(r), ("en", 0.97))

    def test_lid_missing_is_unknown(self):
        self.assertEqual(rs.whisper_lid({"text": "hello"}), ("", None))

    def test_w_lang_is_real_in_process_segment(self):
        calls = []

        def wi(path, language=None, temperature=0.0, temperature_inc=None):
            calls.append(language)
            return {"text": "please take this tablet after food", "detected_language": "english",
                    "language_probabilities": {"en": 0.99}}
        with mock.patch.object(rs, "whisper_infer", wi), mock.patch.object(rs, "USE_SRAVAANI", False):
            seg = rs.process_segment("a.wav", 0, 3, ["en"])
        self.assertEqual(seg["lang"], "en")
        self.assertEqual(calls, [None])  # w_lang == "en": no second forced-en decode


class Deterministic(unittest.TestCase):
    def _post(self, **kw):
        seen = {}

        def post(url, files=None, data=None, timeout=None):
            seen.update(data)
            return Resp({"text": "x"})
        with mock.patch.object(rs.requests, "post", post), mock.patch("builtins.open", mock.mock_open(read_data=b"")):
            rs.whisper_infer("a.wav", **kw)
        return seen

    def test_default_call_unchanged(self):
        self.assertNotIn("temperature_inc", self._post())

    def test_zero_sent_as_string(self):
        self.assertEqual(self._post(temperature_inc=0.0)["temperature_inc"], "0.0")

    def test_judging_call_has_fallback_off(self):
        kw = {}

        def wi(path, language=None, temperature=0.0, temperature_inc=None):
            kw.update(language=language, ti=temperature_inc)
            return {"text": EN, "detected_language": "english", "language_probabilities": {"en": 0.99}}
        with mock.patch.object(rs, "whisper_infer", wi), mock.patch.object(rs, "USE_SRAVAANI", False):
            rs.process_segment("a.wav", 0, 3, ["en"])
        self.assertEqual(kw, {"language": None, "ti": 0.0})


class EmitJudgedText(unittest.TestCase):
    def test_emits_judged_text_and_decodes_once_even_when_lang_not_en(self):
        calls = []

        def wi(path, language=None, temperature=0.0, temperature_inc=None):
            calls.append(language)
            # detected language says hindi, p(en) high enough to stay English: old code re-decoded
            return {"text": EN if len(calls) == 1 else "a different unjudged sentence entirely here",
                    "detected_language": "hindi", "language_probabilities": {"hi": 0.05, "en": 0.95}}
        with mock.patch.object(rs, "whisper_infer", wi), mock.patch.object(rs, "USE_SRAVAANI", False):
            seg = rs.process_segment("a.wav", 0, 3, ["en"])
        self.assertEqual(calls, [None])
        self.assertEqual(seg["text"], EN)

    def test_repair_flag_survives(self):
        loop = "the patient has fever. the patient has fever. the patient has fever. and a cough today"
        with mock.patch.object(rs, "whisper_infer", lambda *a, **k: {"text": loop, "detected_language": "english",
                               "language_probabilities": {"en": 0.99}}), mock.patch.object(rs, "USE_SRAVAANI", False):
            seg = rs.process_segment("a.wav", 0, 3, ["en"])
        self.assertTrue(seg.get("repair_applied"))
        self.assertNotEqual(seg["text"], loop)


if __name__ == "__main__":
    unittest.main()


def _run(w_text, p_en, indic, sra, cands=("en", "kn", "hi")):
    """process_segment with every engine stubbed; returns (segment, indic langs called)."""
    called = []

    def wi(path, language=None, temperature=0.0, temperature_inc=None):
        return {"text": w_text, "detected_language": "english",
                "language_probabilities": {"en": p_en}}

    def ii(path, language, decoding="rnnt"):
        if decoding != "ctc":  # M6's hi/mr tiebreak calls ctc separately; not the main head loop
            called.append(language)
        return {"text": indic.get(language, "")}
    with mock.patch.object(rs, "whisper_infer", wi), mock.patch.object(rs, "indic_infer", ii), \
            mock.patch.object(rs, "sravaani_infer", lambda p: {"ok": True, "text": sra}), \
            mock.patch.object(rs, "USE_SRAVAANI", True):
        return rs.process_segment("a.wav", 0, 3, list(cands)), called


EN = "the patient came in yesterday with a fever and a bad cough"
HI = "मरीज कल बुखार और खांसी के साथ आया था और दवा ले रहा है"


class Gate(unittest.TestCase):
    def test_low_p_en_lets_shorter_native_text_beat_english(self):
        seg, _ = _run(EN * 2, 0.5, {}, HI)  # english is LONGER than the Indic text
        self.assertEqual(seg["engine"], "sravaani")

    def test_high_p_en_keeps_old_override_rules(self):
        seg, _ = _run(EN * 2, 0.97, {}, HI)
        self.assertEqual((seg["lang"], seg["engine"]), ("en", "whisper"))

    def test_threshold_is_config(self):
        with mock.patch.object(rs, "EN_GATE_P", 0.4):
            seg, _ = _run(EN * 2, 0.5, {}, HI)
        self.assertEqual(seg["engine"], "whisper")

    def test_unknown_p_en_opens_gate(self):
        with mock.patch.object(rs, "whisper_infer", lambda *a, **k: {"text": EN * 2}), \
                mock.patch.object(rs, "sravaani_infer", lambda p: {"ok": True, "text": HI}), \
                mock.patch.object(rs, "indic_infer", lambda *a, **k: {"text": ""}):
            seg = rs.process_segment("a.wav", 0, 3, ["en", "kn"])
        self.assertEqual(seg["engine"], "sravaani")

    def test_gate_open_no_indic_text_keeps_english(self):
        seg, _ = _run(EN, 0.5, {}, "")
        self.assertEqual((seg["lang"], seg["text"]), ("en", EN))

    def test_gate_open_runs_all_heads(self):
        _, called = _run(EN, 0.5, {}, HI)
        self.assertEqual(called, ["kn", "hi"])


class NoShortCircuit(unittest.TestCase):
    def test_all_heads_run_when_english_real_and_first_head_empty(self):
        seg, called = _run(EN, 0.99, {}, "")
        self.assertEqual(called, ["kn", "hi"])
        self.assertEqual(seg["lang"], "en")

    def test_later_head_result_is_considered(self):
        seg, called = _run("okay", 0.99, {"hi": HI * 3}, "", cands=("en", "kn", "hi"))
        self.assertEqual(called, ["kn", "hi"])
        self.assertFalse(hasattr(rs, "SHORT_CIRCUIT"))


NAMASTE_HI = "नमस्ते"  # Devanagari


class M6ScriptPick(unittest.TestCase):
    def test_script_maps_directly_for_non_devanagari(self):
        te_text = "తెలుగు పాట"  # Telugu
        self.assertEqual(rs.pick_indic_lang_by_sravaani(te_text, {}), "te")

    def test_devanagari_defaults_to_hi_without_a_tiebreak_call(self):
        self.assertEqual(rs.pick_indic_lang_by_sravaani(NAMASTE_HI, {}), "hi")

    def test_devanagari_switches_to_mr_when_ctc_clearly_closer(self):
        def ii(wav, language, decoding=None, timeout=None):
            self.assertEqual(decoding, "ctc")
            return {"text": NAMASTE_HI if language == "mr" else "completely unrelated text xyz"}
        got = rs.pick_indic_lang_by_sravaani(NAMASTE_HI, {}, indic_infer_fn=ii, seg_wav="a.wav")
        self.assertEqual(got, "mr")

    def test_devanagari_stays_hi_when_margin_not_met(self):
        def ii(wav, language, decoding=None, timeout=None):
            return {"text": NAMASTE_HI}  # hi and mr equally close: no clear win for mr
        got = rs.pick_indic_lang_by_sravaani(NAMASTE_HI, {}, indic_infer_fn=ii, seg_wav="a.wav")
        self.assertEqual(got, "hi")

    def test_devanagari_ctc_empty_stays_hi(self):
        # rnnt-on-real-audio defect (#4422): an empty ctc answer must not crash or false-switch.
        got = rs.pick_indic_lang_by_sravaani(NAMASTE_HI, {}, indic_infer_fn=lambda *a, **k: {"text": ""}, seg_wav="a.wav")
        self.assertEqual(got, "hi")

    def test_no_indic_infer_fn_skips_tiebreak(self):
        self.assertEqual(rs.pick_indic_lang_by_sravaani(NAMASTE_HI, {}), "hi")

    def test_g1_empty_hi_head_does_not_let_a_bad_mr_win_by_default(self):
        # lid-debug #4428 G1: an empty hi head must not make mr win just by being the only one that
        # answered -- mr's own text has to actually resemble SraVaani's.
        def ii(wav, language, decoding=None, timeout=None):
            return {"text": "" if language == "hi" else "completely unrelated garbage text abcdef"}
        got = rs.pick_indic_lang_by_sravaani(NAMASTE_HI, {}, indic_infer_fn=ii, seg_wav="a.wav")
        self.assertEqual(got, "hi")

    def test_g1_empty_hi_head_lets_a_good_mr_win(self):
        def ii(wav, language, decoding=None, timeout=None):
            return {"text": "" if language == "hi" else NAMASTE_HI}
        got = rs.pick_indic_lang_by_sravaani(NAMASTE_HI, {}, indic_infer_fn=ii, seg_wav="a.wav")
        self.assertEqual(got, "mr")

    def test_latin_sravaani_returns_none_ie_fallback(self):
        self.assertIsNone(rs.pick_indic_lang_by_sravaani("hello there", {"hi": "x" * 20}))

    def test_empty_sravaani_returns_none(self):
        self.assertIsNone(rs.pick_indic_lang_by_sravaani("", {"hi": "x" * 20}))


class GraphemeLen(unittest.TestCase):
    def test_matra_does_not_add_a_grapheme(self):
        base = "क"
        with_matra = base + "ा"  # ka + aa-matra: still one grapheme
        self.assertEqual(rs._grapheme_len(with_matra), 1)

    def test_virama_attaches_to_the_preceding_consonant_only(self):
        # क + virama + ष: virama attaches to क (1 grapheme so far); ष starts a new one. An earlier
        # version also skipped ष (modelling a Devanagari conjunct); refuter-2 #4459/#4468 found that
        # breaks Tamil (see below), so a following consonant is never absorbed, on any script.
        self.assertEqual(rs._grapheme_len("क" + "्" + "ष"), 2)

    def test_tamil_pulli_mid_word_does_not_undercount(self):
        # eta-refuter-2 #4459/#4468 regression: pulli (0x0BCD) ends a syllable in Tamil rather than
        # joining a conjunct. "கல்வி" (education) is 3 syllables: க, ல், வி.
        self.assertEqual(rs._grapheme_len("கல்வி"), 3)

    def test_removes_the_tamil_over_telugu_bias(self):
        telugu = "తమిళ"   # Telugu spelling of the same word, no closing virama: 4 code points
        tamil = "தமிழ்"   # Tamil spelling needs a closing pulli/virama (#4216): 5 code points
        self.assertGreater(len(tamil), len(telugu))  # code-point length: Tamil looks "longer"
        self.assertEqual(rs._grapheme_len(tamil), rs._grapheme_len(telugu))  # graphemes: equal (3 each)

    def test_process_segment_uses_sravaani_script_not_longest_head(self):
        # Telugu SraVaani text shorter than a Tamil Conformer hallucination: old rule picked ta
        # (longest); the fix must pick te (SraVaani's own script).
        te_sra = "తెలుగు మాట్లాడుతున్నారు"
        ta_hallucination = "பீள்ளை" * 6  # much longer, Tamil script
        with mock.patch.object(rs, "whisper_infer", lambda *a, **k: {"text": "", "detected_language": "telugu", "language_probabilities": {"te": 0.9, "en": 0.02}}), \
                mock.patch.object(rs, "indic_infer", lambda p, language, decoding="rnnt": {"text": ta_hallucination if language == "ta" else (te_sra if language == "te" else "")}), \
                mock.patch.object(rs, "sravaani_infer", lambda p: {"ok": True, "text": te_sra}), \
                mock.patch.object(rs, "USE_SRAVAANI", True):
            seg = rs.process_segment("a.wav", 0, 3, ["en", "kn", "hi", "ta", "te"])
        self.assertEqual(seg["lang"], "te")


class ETRNumeralExtraction(unittest.TestCase):
    def test_dose_and_followup_extracted_in_order(self):
        w = "Metformin 500 mg twice a day. Come back after 14 days."
        c = rs.extract_numeral_candidates(w)
        self.assertEqual([(x["value"], x["unit"], x["kind"]) for x in c],
                          [(500, "mg", "dose"), (14, "days", "follow_up")])

    def test_million_artifact_normalised_to_mg(self):
        c = rs.extract_numeral_candidates("Amlodipine, 5 million twice a day")
        self.assertEqual(c, [{"value": 5, "unit": "mg", "kind": "dose", "span": (12, 21)}])

    def test_garbled_mg_suffix_still_normalised(self):
        c = rs.extract_numeral_candidates("metformin 500 mgras after food")
        self.assertEqual(c[0]["unit"], "mg")
        self.assertEqual(c[0]["value"], 500)

    def test_no_false_positive_on_frequency_pattern(self):
        self.assertEqual(rs.extract_numeral_candidates("take 1-0-1 tablets"), [])


class ETRValueAnchor(unittest.TestCase):
    def test_exact_english_number_word_anchors_with_unit_cue(self):
        got = rs.find_value_anchor("टैबलेट फाइव मिलीग्राम लीजिए", 5, kind="dose")
        self.assertIsNotNone(got)

    def test_no_cue_no_candidate(self):
        # "five" is exactly right, but nothing marks it as a dose (lid-debug #4501: "No cue = no
        # splice") -- could just as well be a room number or a count of something else.
        self.assertIsNone(rs.find_value_anchor("फाइव लोग आए थे", 5, kind="dose"))

    def test_day_cue_required_for_follow_up(self):
        self.assertIsNotNone(rs.find_value_anchor("टेन डेज़ बाद आइए", 10, kind="follow_up"))
        self.assertIsNone(rs.find_value_anchor("टेन लोग आए", 10, kind="follow_up"))

    def test_native_number_word_does_not_anchor_v1_scope(self):
        # चालीस = native Hindi "forty": out of ETR v1 scope (en-by-ear only), must fail closed
        self.assertIsNone(rs.find_value_anchor("चालीस मिलीग्राम वन संडे", 40, kind="dose"))

    def test_garbled_beyond_recognition_does_not_anchor(self):
        # lid-debug's actual S1 example: "paim soman" for "five hundred" -- not an exact spelling
        self.assertIsNone(rs.find_value_anchor("मेट फ़ॉर्म इन पाइम सोमन मिलीग्राम", 500, kind="dose"))

    def test_drug_name_fragment_does_not_false_match_a_short_number(self):
        # regression (the original, fuzzy-matching bug this design replaces): "फ़ॉर्म इन" (part of
        # "Metformin") must not anchor "fourteen" -- it isn't an exact spelling of it at all now.
        self.assertIsNone(rs.find_value_anchor("तो मेट फ़ॉर्म इन दिन फाइव हंड्रेड", 14, kind="follow_up"))

    def test_scope_devanagari_hi_mr_works(self):
        self.assertIsNotNone(rs.find_value_anchor("टैबलेट फाइव मिलीग्राम लीजिए", 5, kind="dose"))

    def test_scope_southern_scripts_do_not_recover_in_v1(self):
        # Documented gap (PREREG-ETR-v1.md addendum, lid-debug #4522): "five" is spelled with a
        # different vowel convention in each of these, not just different codepoints for "फाइव".
        for text in ("ಫೈವ್ ಮಿಲಿಗ್ರಾಂ", "ஃபைவ் மில்லிகிராம்", "ఫైవ్ మిల్లీగ్రామ్", "ഫൈവ് മില്ലിഗ്രാം"):
            self.assertIsNone(rs.find_value_anchor(text, 5, kind="dose"))

    def test_digit_form_also_anchors(self):
        self.assertIsNotNone(rs.find_value_anchor("देवनागरी अंक ५०० मिलीग्राम", 500, kind="dose"))

    def test_compound_number_ones_part_does_not_anchor_alone(self):
        # found by the decoy gate on real S1 output (clin_hi-en_5): "twenty one days" is two tokens;
        # the bare "one" must not independently anchor value 1.
        text = "ट्वेंटी वन डेज़ बाद वापस"
        self.assertIsNone(rs.find_value_anchor(text, 1, kind="follow_up"))
        self.assertEqual(rs.find_value_anchor(text, 21, kind="follow_up"), (0, 2))

    def test_compound_number_tens_part_does_not_anchor_alone(self):
        # symmetric case (clin_hi-en_6): "forty five" must not let bare "forty" claim value 40.
        text = "फ़ोर्टी फ़ाइव डेज़ बाद वापस"
        self.assertIsNone(rs.find_value_anchor(text, 40, kind="follow_up"))
        self.assertIsNone(rs.find_value_anchor(text, 5, kind="follow_up"))
        self.assertEqual(rs.find_value_anchor(text, 45, kind="follow_up"), (0, 2))

    def test_frequency_continuation_refuses_the_anchor(self):
        # lid-debug #4518: "N once/times a day" is a frequency, not a dose value, whatever N is.
        self.assertIsNone(rs.find_value_anchor("टेक इट वन्स अ डे आफ्टर फूड", 1, kind="dose"))

    def test_real_one_mg_dose_still_anchors(self):
        # 1 mg is a real clinical1 dose (Glimepiride); the guards must not blanket-refuse value 1.
        self.assertIsNotNone(rs.find_value_anchor("ग्लैम्पराइड वन मिलीग्राम वन्स अ डे", 1, kind="dose"))

    def test_value_one_needs_an_immediate_unit_cue_not_within_the_normal_window(self):
        self.assertIsNone(rs.find_value_anchor("वन गोली मिलीग्राम", 1, kind="dose"))
        self.assertIsNotNone(rs.find_value_anchor("फाइव गोली मिलीग्राम", 5, kind="dose"))

    def test_exclude_spans_finds_a_distinct_occurrence(self):
        text = "फाइव मिलीग्राम फिर फाइव मिलीग्राम"
        first = rs.find_value_anchor(text, 5, kind="dose")
        second = rs.find_value_anchor(text, 5, kind="dose", exclude_spans=[first])
        self.assertIsNotNone(second)
        self.assertNotEqual(first, second)


class ETRInsertNeverOverwrite(unittest.TestCase):
    def test_native_words_all_survive_in_order(self):
        # lid-debug #4502 (withdrawing #4436's "replace in place"): every native word is kept.
        native = "मेट फ़ॉर्म इन फाइव हंड्रेड मिलीग्राम आफ़्टर फ़ूड"
        r = rs.recover_english_numerals(native, "Metformin 500 mg after food")
        for w in native.split():
            self.assertIn(w, r["text"])
        self.assertEqual([x["value"] for x in r["recovered"]], [500])

    def test_recovered_value_is_delimited_and_placed_right_after_its_anchor(self):
        native = "मेट फ़ॉर्म इन फाइव हंड्रेड मिलीग्राम आफ़्टर फ़ूड"
        r = rs.recover_english_numerals(native, "Metformin 500 mg after food")
        tag = f"{rs.ETR_DELIM[0]}500 mg{rs.ETR_DELIM[1]}"
        self.assertIn(tag, r["text"])
        # right after "फाइव हंड्रेड" (the anchor), not appended at the end of the sentence
        self.assertLess(r["text"].index(tag), r["text"].index("आफ़्टर"))

    def test_unrecoverable_value_leaves_text_unchanged(self):
        native = "मेट फ़ॉर्म इन पाइम सोमन ट्वाइस अडे"
        r = rs.recover_english_numerals(native, "Metformin 500 mg twice a day")
        self.assertEqual(r["recovered"], [])
        self.assertEqual(r["unanchored"], [500])
        self.assertEqual(r["text"], native)

    def test_repeated_values_get_distinct_spans_and_both_insertions_appear(self):
        native = "फाइव मिलीग्राम फिर फाइव मिलीग्राम"
        r = rs.recover_english_numerals(native, "5 mg and 5 mg")
        self.assertEqual(len(r["recovered"]), 2)
        self.assertNotEqual(r["recovered"][0]["token_span"], r["recovered"][1]["token_span"])
        tag = f"{rs.ETR_DELIM[0]}5 mg{rs.ETR_DELIM[1]}"
        self.assertEqual(r["text"].count(tag), 2)

    def test_no_candidates_returns_text_unchanged(self):
        native = "टेन डेज़ बाद आइए"
        r = rs.recover_english_numerals(native, "no numbers here at all")
        self.assertEqual(r["text"], native)
        self.assertEqual(r["recovered"], [])
