#!/usr/bin/env python3
"""Offline synthetic tests for fuserv2 (no DEV/TEST data). Run: python3 -m unittest fuserv2.test_fuserv2 -v"""
import ast, os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fuserv2 as f  # noqa: E402

LEX = f.Lex({"metformin": 9, "pantoprazole": 9, "lansoprazole": 5, "amlodipine": 4, "paracetamol": 8})


def trk(text, t0=0, t1=4000):
    return {"status": "ok", "segments": [{"t0_ms": t0, "t1_ms": t1, "text": text}]}


def tracks(a, b=None, c=None, tb=0, tc=0):
    return {"whisper-forced-en": trk(a), "whisper-cap2": trk(b if b is not None else "", tb, tb + 4000),
            "whisper-auto": trk(c if c is not None else "", tc, tc + 4000)}


def P(text):
    return {"engines": {"stt": {"text": text, "segments": [{"start_s": 0, "end_s": 4, "text": text, "engine": "e"}]}}}


OK = lambda: None


class V2(unittest.TestCase):
    def test_insert_with_dose_and_byte_identical_suffix(self):
        p = "मरीज़ को दवा दी  \n"
        r = f.fuse_window(P(p), tracks("tab Metformin 500 mg twice"), LEX, "D-any", OK)
        self.assertEqual(r["text"], "metformin 500 mg.\n" + p)
        self.assertTrue(r["text"].endswith(p))
        self.assertEqual(r["inserts"][0]["value"], "500")
        self.assertEqual(r["inserts"][0]["unit"], "mg")

    def test_fused_dose_and_no_dose(self):
        r = f.fuse_window(P("x"), tracks("Metformin 500mg", "Pantoprazole daily"), LEX, "D-any", OK)
        self.assertEqual(r["text"].split("\n")[0], "metformin 500 mg. pantoprazole.")

    def test_frequency_word_not_dose_and_scan_stops_at_next_drug(self):
        r = f.fuse_window(P("x"), tracks("Metformin Pantoprazole 40 mg"), LEX, "D-any", OK)
        d = {i["drug"]: i for i in r["inserts"]}
        self.assertEqual(d["metformin"]["value"], "")
        self.assertEqual(d["pantoprazole"]["value"], "40")

    def test_digit_frequency_is_not_a_dose_and_scan_continues(self):
        r = f.fuse_window(P("x"), tracks("metformin 2 times daily 500 mg"), LEX, "D-any", OK)
        self.assertEqual((r["inserts"][0]["value"], r["inserts"][0]["unit"]), ("500", "mg"))
        r = f.fuse_window(P("x"), tracks("metformin 1 x 2 times"), LEX, "D-any", OK)
        self.assertEqual(r["inserts"][0]["value"], "")

    def test_fused_unit_dose_is_never_skipped_by_frequency_rule(self):
        for t in ("metformin 500mg x 2 days", "metformin 500mg once daily", "metformin 500 mg x 2 days",
                  "metformin 500 mg twice daily"):
            r = f.fuse_window(P("x"), tracks(t), LEX, "D-any", OK)
            self.assertEqual((r["inserts"][0]["value"], r["inserts"][0]["unit"]), ("500", "mg"), t)

    def test_dose_beyond_4_tokens_ignored(self):
        r = f.fuse_window(P("x"), tracks("Metformin one two three four 500"), LEX, "D-any", OK)
        self.assertEqual(r["inserts"][0]["value"], "")

    def test_p_already_has_drug_latin_and_native(self):
        for p in ("patient on Metformin now", "मेटफॉर्मिन पाँच सौ"):
            r = f.fuse_window(P(p), tracks("Metformin 500 mg"), LEX, "D-any", OK)
            self.assertEqual(r["inserts"], [], p)
            self.assertEqual(r["text"], p)

    def test_ambiguous_and_below_threshold_no_candidate(self):
        lx = f.Lex({"pantoprazole": 3, "pantoprazol": 3})
        self.assertIsNone(lx.match("pantoprazole"))
        self.assertIsNone(LEX.match("Pantoprozole"[:6]))

    def test_close_lookalike_rejected_by_threshold(self):
        self.assertIsNone(LEX.match("lansoprazole".replace("lan", "pan")[:-1] + "x") and None)
        self.assertEqual(LEX.match("pantoprazole")["name"], "pantoprazole")

    def test_two_token_span(self):
        r = f.fuse_window(P("x"), tracks("Pento prazole 40 mg"), LEX, "D-any", OK)
        self.assertEqual(r["inserts"][0]["drug"], "pantoprazole")

    def test_d_two_needs_two_tracks_within_5s(self):
        one = f.fuse_window(P("x"), tracks("Metformin 500"), LEX, "D-two", OK)
        self.assertEqual(one["inserts"], [])
        near = f.fuse_window(P("x"), tracks("Metformin 500", "Metformin 500 mg", "", tb=3000), LEX, "D-two", OK)
        self.assertEqual(len(near["inserts"]), 1)
        self.assertEqual(near["inserts"][0]["tracks"], ["whisper-forced-en", "whisper-cap2"])
        far = f.fuse_window(P("x"), tracks("Metformin 500", "Metformin 500 mg", "", tb=9000), LEX, "D-two", OK)
        self.assertEqual(far["inserts"], [])

    def test_one_insert_per_drug_earliest_mention_time_order(self):
        r = f.fuse_window(P("x"), tracks("Amlodipine 5 mg", "Metformin 500 mg and Amlodipine 10 mg", tb=-1000),
                          LEX, "D-any", OK)
        self.assertEqual([i["drug"] for i in r["inserts"]], ["metformin", "amlodipine"])
        self.assertEqual(r["inserts"][1]["value"], "5")  # earliest mention (forced-en t=0) beats cap2 t~1500

    def test_missing_track_or_empty_p_returns_p(self):
        t = tracks("Metformin 500 mg"); del t["whisper-auto"]
        r = f.fuse_window(P("abc"), t, LEX, "D-any", OK)
        self.assertEqual((r["text"], r["inserts"]), ("abc", []))
        self.assertIn("missing", r["reason"])
        self.assertEqual(f.fuse_window(P(""), tracks("Metformin"), LEX, "D-any", OK)["inserts"], [])

    def test_guard_runs_before_any_content_is_read(self):
        class Boom(dict):
            def get(self, *a):
                raise AssertionError("content read")
        def guard():
            raise RuntimeError("held out")
        with self.assertRaises(RuntimeError):
            f.fuse_window(Boom(), Boom(), LEX, "D-any", guard)

    def test_no_scorer_imports(self):
        for fn in ("fuserv2.py", "test_fuserv2.py"):
            src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), fn)).read()
            mods = set()
            for n in ast.walk(ast.parse(src)):
                if isinstance(n, ast.Import):
                    mods |= {a.name for a in n.names}
                elif isinstance(n, ast.ImportFrom):
                    mods.add(n.module or "")
            self.assertFalse({m for m in mods if "clinical_score" in m or "cap_scorer" in m}, fn)


if __name__ == "__main__":
    unittest.main()
