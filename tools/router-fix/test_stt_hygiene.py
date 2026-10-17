#!/usr/bin/env python3
"""
A-ETA-1 + A-ETA-2 in the router: max_context=0 on every whisper call, and an idempotent
post-decode collapse that runs BEFORE the English hallucination guard.

RUN (from the router checkout, with the venv that has fastapi/requests):
    ETA_JOBS_DIR=$(mktemp -d) ./.venv/bin/python -m unittest test_stt_hygiene -v

No audio, no network, no engines: whisper, VAD and the segment worker are patched. All text is
synthetic.
"""
import importlib.util
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import router_server as rs  # noqa: E402

SHIM_PATH = os.path.expanduser("~/.local/bin/whisper-shim.py")

LOOPY = [
    "the patient has fever. the patient has fever. the patient has fever.",
    "okay okay okay sir okay okay okay sir okay okay okay sir",
    "thank you thank you thank you thank you",
    "take this tablet twice a day\nafter food\nafter food\nafter food",
    "no no\nplease come back next week",
    "",
]


class Resp:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


class MaxContext(unittest.TestCase):
    """A-ETA-1: every router->whisper call sends max_context=0."""

    def _sent(self, **kw):
        with tempfile.NamedTemporaryFile(suffix=".wav") as f, \
                mock.patch.object(rs.requests, "post", return_value=Resp({"text": "x"})) as post:
            rs.whisper_infer(f.name, **kw)
        self.assertEqual(post.call_count, 1)
        self.assertTrue(post.call_args.args[0].endswith("/inference"))
        return post.call_args.kwargs["data"]

    def test_auto_language_sends_max_context_0(self):
        self.assertEqual(self._sent()["max_context"], "0")

    def test_forced_english_sends_max_context_0(self):
        data = self._sent(language="en")
        self.assertEqual(data["max_context"], "0")
        self.assertEqual(data["language"], "en")

    def test_whisper_infer_is_the_only_post_to_whisper(self):
        with open(rs.__file__, encoding="utf-8") as fh:
            src = fh.read()
        self.assertEqual(src.count("{WHISPER_URL}/inference"), 1)


class PhraseCollapse(unittest.TestCase):
    def test_sentence_repeated_three_times_keeps_one(self):
        self.assertEqual(rs.collapse_phrase_loops(LOOPY[0]), "the patient has fever.")

    def test_nested_loop_reaches_fixed_point(self):
        self.assertEqual(rs.collapse_phrase_loops(LOOPY[1]), "okay sir")

    def test_sticky_word(self):
        self.assertEqual(rs.collapse_phrase_loops("fever fever fever since monday"),
                         "fever since monday")

    def test_two_repeats_are_not_a_loop(self):
        for t in ("thank you thank you", "fever fever since monday", "no no no"):
            self.assertEqual(rs.collapse_phrase_loops(t), t)

    def test_distinct_lines_survive(self):
        t = "take this tablet twice a day\nafter food\ncome back next week"
        self.assertEqual(rs.collapse_phrase_loops(t), t)

    def test_loop_inside_a_line_leaves_other_lines(self):
        t = "cough for two weeks\ncough cough cough\nno fever"
        self.assertEqual(rs.collapse_phrase_loops(t), "cough for two weeks\ncough\nno fever")

    # --- Refuter F2: a number is never collapsed as a repeated word. ---
    def test_spelled_number_regimen_is_kept(self):
        for t in ("take one one one after food", "take two two two tablets",
                  "take 1 1 1 after food", "500 500 500 mg", "half half half tablet",
                  "ek ek ek goli", "ondu ondu ondu",
                  "\u0926\u094b \u0926\u094b \u0926\u094b",       # Devanagari "two" x3
                  "\u0cae\u0cc2\u0cb0\u0cc1 \u0cae\u0cc2\u0cb0\u0cc1 \u0cae\u0cc2\u0cb0\u0cc1"):  # Kannada "three" x3
            self.assertEqual(rs.collapse_phrase_loops(t), t)

    def test_repeated_phrase_holding_a_number_is_kept(self):
        # Round-2 follow-up: a phrase is not a loop when it carries a number.
        for t in ("one tablet one tablet one tablet",
                  "take 2 drops take 2 drops take 2 drops",
                  "saade teen saade teen saade teen",
                  "dedh goli dedh goli dedh goli",
                  "second dose second dose second dose",
                  "ek-ek goli ek-ek goli ek-ek goli",
                  "\u0c95\u0cbe\u0cb2\u0cc1 \u0cae\u0cbe\u0ca4\u0ccd\u0cb0\u0cc6 "
                  "\u0c95\u0cbe\u0cb2\u0cc1 \u0cae\u0cbe\u0ca4\u0ccd\u0cb0\u0cc6 "
                  "\u0c95\u0cbe\u0cb2\u0cc1 \u0cae\u0cbe\u0ca4\u0ccd\u0cb0\u0cc6"):  # Kannada "quarter tablet" x3
            self.assertEqual(rs.collapse_phrase_loops(t), t)

    def test_repeated_phrase_without_a_number_still_collapses(self):
        self.assertEqual(rs.collapse_phrase_loops("take the tablet take the tablet take the tablet"),
                         "take the tablet")

    def test_number_word_list_covers_spoken_fractions_and_ordinals(self):
        for w in ("dedh", "dhai", "saade", "sawa", "paune", "pauna", "kaalu", "mukkalu", "ardha",
                  "first", "third", "pehla", "doosra", "teesri", "modalu", "eradane",
                  "gyarah", "bees", "sau", "ippattu", "nooru", "lakh", "dozen", "triple",
                  "\u0938\u093e\u0922\u093c\u0947",          # Devanagari saadhe
                  "\u0cae\u0cc1\u0c95\u0ccd\u0c95\u0cbe\u0cb2\u0cc1"):  # Kannada mukkalu
            self.assertTrue(rs.is_number_token(w), w)

    # --- Round 3: the lexicon is generated, and the two scripts cannot drift apart. ---
    def test_romanised_and_native_halves_cover_the_same_numbers_0_to_100(self):
        for lang, table in rs.number_lexicon().items():
            romanised = {n for n, (rom, _) in table.items() if rom}
            native = {n for n, (_, nat) in table.items() if nat}
            self.assertEqual(romanised, native, lang)
            self.assertEqual(romanised, set(range(101)), lang)

    def test_every_generated_form_is_a_number_token(self):
        for lang, table in rs.number_lexicon().items():
            for n, (rom, nat) in table.items():
                for w in rom | nat:
                    self.assertTrue(rs.is_number_token(w), f"{lang} {n} {w}")

    def test_kannada_sandhi_forms(self):
        kn = rs.number_lexicon()["kn"]
        self.assertIn("\u0c87\u0caa\u0ccd\u0caa\u0ca4\u0ccd\u0ca4\u0cca\u0c82\u0ca6\u0cc1", kn[21][1])  # ಇಪ್ಪತ್ತೊಂದು
        self.assertIn("\u0c87\u0caa\u0ccd\u0caa\u0ca4\u0ccd\u0ca4\u0cc8\u0ca6\u0cc1", kn[25][1])  # ಇಪ್ಪತ್ತೈದು
        self.assertIn("\u0c8e\u0caa\u0ccd\u0caa\u0ca4\u0ccd\u0ca4\u0cc8\u0ca6\u0cc1", kn[75][1])  # ಎಪ್ಪತ್ತೈದು
        self.assertIn("\u0c87\u0caa\u0ccd\u0caa\u0ca4\u0ccd\u0cae\u0cc2\u0cb0\u0cc1", kn[23][1])  # ಇಪ್ಪತ್ಮೂರು
        self.assertIn("ippattondu", kn[21][0])
        self.assertIn("eppattaidu", kn[75][0])
        self.assertIn("ippatmooru", kn[23][0])

    def test_refuter_dose_cases_stay_uncollapsed(self):
        for t in ("pachas milligram pachas milligram pachas milligram",
                  "\u092a\u091a\u093e\u0938 milligram \u092a\u091a\u093e\u0938 milligram \u092a\u091a\u093e\u0938 milligram",  # पचास
                  "\u092a\u0902\u0926\u094d\u0930\u0939 milligram \u092a\u0902\u0926\u094d\u0930\u0939 milligram \u092a\u0902\u0926\u094d\u0930\u0939 milligram",  # पंद्रह
                  "\u092a\u0902\u0926\u094d\u0930\u0939 \u092a\u0902\u0926\u094d\u0930\u0939 \u092a\u0902\u0926\u094d\u0930\u0939",  # पंद्रह x3
                  "pachhattar milligram pachhattar milligram pachhattar milligram",
                  "aivattu milligram aivattu milligram aivattu milligram",
                  "hadinaidu mg hadinaidu mg hadinaidu mg",
                  "\u00bd tablet \u00bd tablet \u00bd tablet"):  # ½
            self.assertEqual(rs.collapse_phrase_loops(t), t)

    def test_unicode_numeric_characters_are_numbers(self):
        for w in ("\u00bd", "\u00bc", "\u00be", "\u0968\u096b", "\u0ce8\u0ceb", "1\u00bd"):  # ½ ¼ ¾ २५ ೨೫ 1½
            self.assertTrue(rs.is_number_token(w), w)
        for w in ("tablet", "follow-up", "and/or", "x-ray", "milligram"):
            self.assertFalse(rs.is_number_token(w), w)

    def test_hyphen_and_slash_regimens_are_numbers(self):
        for w in ("ek-ek", "1-0-1", "one/two", "do-do,"):
            self.assertTrue(rs.is_number_token(w), w)
        for w in ("follow-up", "and/or", "x-ray"):
            self.assertFalse(rs.is_number_token(w), w)

    def test_non_number_word_still_collapses_beside_a_number(self):
        self.assertEqual(rs.collapse_phrase_loops("tablet tablet tablet two two two"), "tablet two two two")

    def test_is_number_token(self):
        for w in ("one", "Two,", "10mg", "1.5", "teen", "ondu"):
            self.assertTrue(rs.is_number_token(w), w)
        for w in ("tablet", "fever", "", "--"):
            self.assertFalse(rs.is_number_token(w), w)

    def test_short_phrase_under_8_chars_is_not_a_loop(self):
        # R5: a 2-word phrase under 8 characters repeated 3x is left alone.
        for t in ("no sir no sir no sir", "ok ji ok ji ok ji"):
            self.assertEqual(rs.collapse_phrase_loops(t), t)

    def test_idempotent(self):
        for t in LOOPY:
            once = rs.collapse_phrase_loops(t)
            self.assertEqual(rs.collapse_phrase_loops(once), once, t)


class ShimOutput(unittest.TestCase):
    """The collapse is a no-op on answers the shim has already collapsed."""

    def test_shim_flagged_answer_is_not_touched(self):
        text, fixed = rs.whisper_text({"text": " " + LOOPY[2] + " ", "shim_collapse": True})
        self.assertEqual(text, LOOPY[2])
        self.assertFalse(fixed)

    def test_unflagged_answer_is_collapsed(self):
        text, fixed = rs.whisper_text({"text": LOOPY[2]})
        self.assertEqual(text, "thank you")
        self.assertTrue(fixed)

    def test_router_collapse_changes_nothing_after_the_real_shim(self):
        if not os.path.exists(SHIM_PATH):
            self.skipTest("whisper-shim not on this machine")
        spec = importlib.util.spec_from_file_location("whisper_shim_readonly", SHIM_PATH)
        shim = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(shim)  # module-level code only defines; no server starts
        for t in LOOPY:
            for line in t.split("\n"):
                shimmed = shim._collapse_phrase_loops(line.strip())
                self.assertEqual(rs.collapse_phrase_loops(shimmed), shimmed, line)


def seg(start, end, text, **kw):
    return {"start_s": start, "end_s": end, "lang": "en", "engine": "whisper", "text": text, **kw}


class SegmentCollapse(unittest.TestCase):
    def test_identical_neighbour_dropped_and_span_folded(self):
        out, n = rs.collapse_segments([seg(0, 29, "please take rest"), seg(28, 45, "Please take rest.")])
        self.assertEqual(n, 1)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["end_s"], 45)
        self.assertEqual(out[0]["text"], "please take rest")

    def test_identical_after_whitespace_and_danda_fold_dropped(self):
        a = "blood pressure is one forty over ninety today"
        b = "Blood pressure is  one forty over ninety today \u0964"
        _, n = rs.collapse_segments([seg(0, 5, a), seg(5, 9, b)])
        self.assertEqual(n, 1)

    # --- Refuter F1: nothing fuzzy. Each of these pairs is distinct content and must be KEPT. ---
    def test_swapped_dose_pair_is_kept(self):
        a = "Take 2 tablets in the morning and 1 tablet at night."
        b = "Take 1 tablet in the morning and 2 tablets at night."
        out, n = rs.collapse_segments([seg(0, 4, a), seg(4, 8, b)])
        self.assertEqual(n, 0)
        self.assertEqual([s["text"] for s in out], [a, b])
        self.assertFalse(rs.identical_after_fold(a, b))

    def test_morning_night_pair_is_kept(self):
        base = "continue the same tablet for the next two weeks and take it with warm water every {}"
        a, b = base.format("morning"), base.format("night")
        out, n = rs.collapse_segments([seg(0, 6, a), seg(6, 12, b)])
        self.assertEqual(n, 0)
        self.assertEqual(len(out), 2)

    def test_same_words_different_order_is_kept(self):
        _, n = rs.collapse_segments([seg(0, 2, "no pain today yes"), seg(2, 4, "yes pain today no")])
        self.assertEqual(n, 0)

    def test_yes_yes_from_different_speakers_is_kept(self):
        out, n = rs.collapse_segments([seg(0, 1, "Yes.", speaker="S0"), seg(1.2, 2, "Yes.", speaker="S1")])
        self.assertEqual(n, 0)
        self.assertEqual(len(out), 2)

    def test_yes_yes_across_a_gap_over_1_5_s_is_kept(self):
        out, n = rs.collapse_segments([seg(0, 1, "Yes."), seg(2.6, 3.2, "Yes.")])
        self.assertEqual(n, 0)
        self.assertEqual(len(out), 2)

    def test_yes_yes_contiguous_same_speaker_is_a_loop(self):
        _, n = rs.collapse_segments([seg(0, 1, "Yes.", speaker="S0"), seg(1.5, 2, "yes", speaker="S0")])
        self.assertEqual(n, 1)

    def test_distinct_neighbours_kept(self):
        segs = [seg(0, 5, "how long have you had the cough"), seg(5, 9, "about two weeks"),
                seg(9, 12, "any fever with the cough")]
        out, n = rs.collapse_segments(segs)
        self.assertEqual(n, 0)
        self.assertEqual([s["text"] for s in out], [s["text"] for s in segs])

    def test_indic_vowel_signs_are_not_folded_away(self):
        # Two different Hindi words that differ only by a vowel sign must stay distinct.
        _, n = rs.collapse_segments([seg(0, 2, "\u0915\u092e"), seg(2, 4, "\u0915\u093e\u092e")])
        self.assertEqual(n, 0)

    def test_non_consecutive_repeat_is_kept(self):
        segs = [seg(0, 2, "yes doctor"), seg(2, 4, "does it hurt here"), seg(4, 6, "yes doctor")]
        out, n = rs.collapse_segments(segs)
        self.assertEqual(n, 0)
        self.assertEqual(len(out), 3)

    def test_refused_rows_kept_and_never_matched(self):
        refused = seg(2, 4, "", confidence="low_confidence", refused=True)
        segs = [seg(0, 2, "take the syrup"), refused, seg(4, 6, "take the syrup")]
        out, n = rs.collapse_segments(segs)
        self.assertEqual(n, 0)
        self.assertEqual(len(out), 3)

    def test_input_not_mutated(self):
        segs = [seg(0, 2, "same line here"), seg(2, 4, "same line here")]
        rs.collapse_segments(segs)
        self.assertEqual(segs[0]["end_s"], 2)

    def test_idempotent(self):
        segs = [seg(0, 2, "same line here"), seg(2, 4, "same line here"), seg(4, 6, "same line here"),
                seg(6, 8, "different line now"), seg(8, 9, "")]
        once, n1 = rs.collapse_segments(segs)
        twice, n2 = rs.collapse_segments(once)
        self.assertEqual(n1, 2)
        self.assertEqual(n2, 0)
        self.assertEqual(twice, once)


class GuardRunsAfterFix(unittest.TestCase):
    """The English hallucination guard stays, and now judges the repaired text."""

    def _run(self, whisper_body):
        with mock.patch.object(rs, "whisper_infer", return_value=whisper_body):
            return rs.process_segment("unused.wav", 0.0, 5.0, ["en"])

    def test_looped_real_sentence_is_repaired_then_kept(self):
        # Before the fix the guard refused this (a clause repeated 3x).
        self.assertFalse(rs.looks_real_english(LOOPY[0]))
        out = self._run({"text": LOOPY[0], "language": "en"})
        self.assertEqual(out["text"], "the patient has fever.")
        self.assertTrue(out["repair_applied"])
        self.assertNotIn("refused", out)

    def test_guard_still_refuses_what_is_left_after_repair(self):
        out = self._run({"text": "thank you thank you thank you", "language": "en"})
        self.assertTrue(out["refused"])
        self.assertEqual(out["refused_reason"], "english_hallucination_guard")
        self.assertEqual(out["text"], "")

    def test_clean_english_carries_no_repair_flag(self):
        out = self._run({"text": "how long have you had this cough", "language": "en"})
        self.assertNotIn("repair_applied", out)


class WindowAndJob(unittest.TestCase):
    def _window(self, segs):
        spans = [(s["start_s"], s["end_s"]) for s in segs]
        by_start = {s["start_s"]: s for s in segs}
        with mock.patch.object(rs, "wav_duration_s", return_value=60.0), \
                mock.patch.object(rs, "vad_segments", return_value=(spans, "silero-vad")), \
                mock.patch.object(rs, "slice_wav"), \
                mock.patch.object(rs, "is_near_silent_wav", return_value=(False, 0.1, 0.5)), \
                mock.patch.object(rs, "process_segment",
                                  side_effect=lambda w, s, e, c: dict(by_start[s])):
            return rs.transcribe_norm_wav("unused.wav", ["en"], False)

    def test_window_drops_duplicate_and_sets_repair_applied(self):
        r = self._window([seg(0.0, 29.0, "please take rest", repair_applied=True),
                          seg(28.0, 40.0, "please take rest"), seg(40.0, 50.0, "see you next week")])
        self.assertTrue(r["repair_applied"])
        self.assertEqual(r["repair"]["segments_dropped_duplicate"], 1)
        self.assertEqual(r["repair"]["segments_phrase_collapsed"], 1)
        self.assertEqual(r["transcript_native"], "please take rest\nsee you next week")
        self.assertEqual(len(r["language_timeline"]), 2)

    def test_clean_window_repair_false(self):
        r = self._window([seg(0.0, 5.0, "how are you"), seg(5.0, 9.0, "better today")])
        self.assertFalse(r["repair_applied"])

    def test_silent_window_carries_repair_false(self):
        with mock.patch.object(rs, "wav_duration_s", return_value=30.0), \
                mock.patch.object(rs, "vad_segments", return_value=([], "silero-vad")):
            r = rs.transcribe_norm_wav("unused.wav", ["en"], False)
        self.assertEqual(r["status"], "silent_skipped")
        self.assertFalse(r["repair_applied"])

    def test_job_repair_aggregates(self):
        w1 = {"repair_applied": False, "repair": {"segments_phrase_collapsed": 0, "segments_dropped_duplicate": 0}}
        w2 = {"repair_applied": True, "repair": {"segments_phrase_collapsed": 2, "segments_dropped_duplicate": 1}}
        self.assertEqual(rs.job_repair([w1, w2]),
                         {"applied": True, "segments_phrase_collapsed": 2, "segments_dropped_duplicate": 1})
        self.assertFalse(rs.job_repair([w1, w1])["applied"])
        self.assertFalse(rs.job_repair([])["applied"])


if __name__ == "__main__":
    unittest.main()
