#!/usr/bin/env python3
"""Tests for fuserv2e. Run: python3 fuserv2e/test_fuserv2e.py  (synthetic strings only; the two DEV Tamil renderings are disclosed fixtures)."""
import ast, os, random, re, sys, unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import fuserv2e as f  # noqa: E402
import fuserv2 as f2  # noqa: E402

LEX = {"metformin": 50, "pantoprazole": 40, "amlodipine": 30, "telmisartan": 20, "urea": 5, "iron": 5, "coal tar": 3,
       "amlodipine besylate": 3, "domperidone": 10, "atorvastatin": 10}


def seg(text, t0=0, t1=4000):
    return [{"t0_ms": t0, "t1_ms": t1, "text": text}]


def tracks(a, b=None, c=None, t=(0, 0, 0)):
    b = a if b is None else b
    c = a if c is None else c
    return {n: {"status": "ok", "segments": seg(x, tt)} for n, x, tt in zip(f.TRACKS, (a, b, c), t)}


def P(text):
    return {"engines": {"stt": {"text": text, "segments": [{"start_s": 0, "end_s": 3, "text": text, "engine": "x"}]}}}


class M(unittest.TestCase):
    lex = f.LexE(LEX)

    def m(self, *toks):
        return self.lex.match_span(list(toks))

    def test_exact_and_misspelling(self):
        self.assertEqual(self.m("metformin")["name"], "metformin")
        self.assertEqual(self.m("telmisartin")["name"], "telmisartan")

    def test_m1_letter_check_blocks_skeleton_only_match(self):
        tok = "matfarmana"  # skeleton sim 1.0 to metformin, letter sim 0.6
        self.assertGreaterEqual(f.dm._sim(f.dm._english_skeleton(tok), f.dm._english_skeleton("metformin")), 0.9)
        self.assertLess(f.letter_sim(tok, "metformin"), 0.65)
        self.assertIsNone(self.m(tok))

    def test_m2_english_token_never_joins_or_matches(self):
        self.assertIsNone(self.m("met", "formin"))          # 'met' is an English word
        self.assertIsNone(self.m("we", "are"))
        self.assertIsNone(self.m("urea"))                   # M3 short name
        self.assertIsNone(self.m("iron"))                   # M3/M4
        self.assertIsNone(self.m("tell", "me"))

    def test_m2_two_token_join_ok_when_both_non_english_and_long(self):
        self.assertEqual(self.m("panto", "prazole")["name"], "pantoprazole")
        self.assertIsNone(self.m("pa", "ntoprazole"))       # a token < 3 letters

    def test_m2_multiword_name_word_by_word_same_count(self):
        self.assertEqual(self.m("amlodipine", "besylate")["name"], "amlodipine besylate")
        self.assertIsNone(self.m("amlodipinebesilate"))

    def test_m3_m4b_filter(self):
        for n in ("urea", "iron", "coal tar"):
            self.assertNotIn(n, self.lex.names)
        self.assertIn("metformin", self.lex.names)

    def test_m5_exclusion_honoured(self):
        lx = f.LexE(LEX, excluded={"metformin"})
        self.assertIsNone(lx.match_span(["metformin"]))

    def test_ambiguity_margin(self):
        lx = f.LexE({"telmisartan": 1, "telmisartin": 1})
        self.assertIsNone(lx.match_span(["telmisartan"]))


class D4E(unittest.TestCase):
    lex = f.LexE(LEX)
    TAMIL_METFORMIN = "மெட் ஃபார்மின்"      # disclosed DEV fixtures (rendering of a split Tamil-script name)
    TAMIL_PANTO = "பாண்டோ பிரசோல்"

    def test_split_tamil_names_are_held(self):
        self.assertTrue(f.p_has_drug(self.TAMIL_METFORMIN + " 500 mg", "metformin", self.lex))
        self.assertTrue(f.p_has_drug("இதை " + self.TAMIL_PANTO + " எடுங்கள்", "pantoprazole", self.lex))

    def test_no_insert_when_p_holds_split_tamil(self):
        r = f.fuse_window(P(self.TAMIL_METFORMIN), tracks("take metformin 500 mg daily"), self.lex, "D-any", lambda: None)
        self.assertEqual(r["inserts"], [])
        self.assertEqual(r["text"], self.TAMIL_METFORMIN)

    def test_latin_hold_and_absent(self):
        self.assertTrue(f.p_has_drug("take metformin daily", "metformin", self.lex))
        self.assertFalse(f.p_has_drug("take something daily", "metformin", self.lex))

    def test_pinned_romaniser_blob(self):
        self.assertIsNotNone(f.mic())
        self.assertTrue(f.MIC_BLOB.startswith("3b5b3c047bfd"))


class ED(unittest.TestCase):
    lex = f.LexE(LEX)

    def run_d(self, a, b, c, variant="D-any"):
        return f.fuse_window(P("नमस्ते"), tracks(a, b, c), self.lex, variant, lambda: None)

    def test_two_of_three_agree_gives_dose(self):
        r = self.run_d("metformin 500 mg", "metformin 500 mg", "metformin 50 mg")
        self.assertEqual(r["inserts"][0]["value"], "500")
        self.assertTrue(r["text"].startswith("metformin 500 mg.\n"))

    def test_disagreement_is_drug_only(self):
        r = self.run_d("metformin 500 mg", "metformin 50 mg", "metformin 5 mg")
        self.assertEqual(r["inserts"][0]["value"], "")
        self.assertTrue(r["text"].startswith("metformin.\n"))

    def test_single_track_dose_is_dropped(self):
        r = self.run_d("metformin 500 mg", "metformin", "metformin")
        self.assertEqual(r["inserts"][0]["value"], "")

    def test_unit_conflict_is_no_agreement(self):
        r = self.run_d("metformin 500 mg", "metformin 500 g", "metformin")
        self.assertEqual(r["inserts"][0]["value"], "")

    def test_unit_taken_from_carrying_track(self):
        r = self.run_d("metformin 500 mg", "metformin 500", "metformin")
        self.assertEqual((r["inserts"][0]["value"], r["inserts"][0]["unit"]), ("500", "mg"))

    def test_d_two_applies_e_d(self):
        r = self.run_d("metformin 500", "metformin 500", "hello", "D-two")
        self.assertEqual(r["inserts"][0]["value"], "500")


class Fuse(unittest.TestCase):
    lex = f.LexE(LEX)

    def test_byte_identical_suffix_and_time_order(self):
        p = "नमस्ते डॉक्टर"
        r = f.fuse_window(P(p), tracks("amlodipine 5 mg then metformin 500 mg"), self.lex, "D-any", lambda: None)
        self.assertTrue(r["text"].endswith("\n" + p))
        self.assertEqual([i["drug"] for i in r["inserts"]], ["amlodipine", "metformin"])

    def test_missing_track_leaves_p(self):
        tr = tracks("metformin 500 mg")
        del tr["whisper-auto"]
        r = f.fuse_window(P("x"), tr, self.lex, "D-any", lambda: None)
        self.assertEqual((r["text"], r["inserts"]), ("x", []))

    def test_guard_before_content(self):
        def guard():
            raise RuntimeError("held-out")
        with self.assertRaises(RuntimeError):
            f.fuse_window(None, None, self.lex, "D-any", guard)

    def test_english_collision_not_inserted(self):
        r = f.fuse_window(P("नमस्ते"), tracks("these are fine and we are ok, tell me"), self.lex, "D-any", lambda: None)
        self.assertEqual(r["inserts"], [])


class NoScorerImport(unittest.TestCase):
    def test_no_scorer_import_in_fuserv2e_and_fuserv2(self):
        for path in (os.path.join(_HERE, "fuserv2e.py"), os.path.join(_HERE, "..", "fuserv2", "fuserv2.py")):
            tree = ast.parse(open(path).read())
            names = set()
            for n in ast.walk(tree):
                if isinstance(n, ast.Import):
                    names |= {a.name for a in n.names}
                elif isinstance(n, ast.ImportFrom):
                    names.add(n.module or "")
            self.assertFalse({x for x in names if "clinical_score" in x or "cap_scorer" in x}, path)
            self.assertNotIn("import clinical_score", open(path).read().replace("clinical_score.py", ""))

    def test_vendored_romaniser_is_the_pinned_blob(self):
        import hashlib
        d = open(f.MIC_PATH, "rb").read()
        self.assertTrue(hashlib.sha1(b"blob %d\0" % len(d) + d).hexdigest().startswith("3b5b3c047bfd"))


# ---- property test (may import the scorer): S1 credits P's native name => D4-E detects it
SCORER_DIR = "/tmp/wt-rf-s1-m6/kit/diag-rig"
_CONS = {"k": 0x15, "c": 0x15, "g": 0x17, "j": 0x1C, "t": 0x24, "d": 0x26, "n": 0x28, "p": 0x2A, "f": 0x2B, "b": 0x2C, "m": 0x2E,
         "y": 0x2F, "r": 0x30, "l": 0x32, "v": 0x35, "w": 0x35, "s": 0x38, "h": 0x39, "z": 0x38, "x": 0x38, "q": 0x15}
_VOW = {"a": None, "e": 0x47, "i": 0x3F, "o": 0x4B, "u": 0x41, "y": 0x3F}
_BLOCKS = (0x0900, 0x0B80, 0x0C00, 0x0C80, 0x0D00)   # Devanagari, Tamil, Telugu, Kannada, Malayalam


def render(word, base, rng=None, noise=0.0):
    out, i = [], 0
    ch = [c for c in word.lower() if c.isalpha()]
    while i < len(ch):
        c = ch[i]
        if rng and rng.random() < noise:
            i += 1
            continue
        if c in _CONS:
            out.append(chr(base + _CONS[c]))
            nxt = ch[i + 1] if i + 1 < len(ch) else None
            if nxt in _VOW:
                if _VOW[nxt]:
                    out.append(chr(base + _VOW[nxt]))
                i += 2
                continue
            if nxt is not None:
                out.append(chr(base + 0x4D))
        i += 1
    return "".join(out)


class Property(unittest.TestCase):
    def test_s1_credit_implies_d4e(self):
        if not os.path.isdir(SCORER_DIR):
            self.skipTest("scorer worktree absent")
        sys.path.insert(0, SCORER_DIR)
        import clinical_score as cs
        sys.path.insert(0, os.path.join(_HERE, "..", "fuserv1"))
        import lexicon
        lx = lexicon.load_lexicon("/home/eta/eta-data/cap2/rx_history.jsonl")
        lex = f.LexE(lx)
        rng = random.Random(7)
        n_credit = n_miss = 0
        misses = []
        for name in sorted(lx):
            first = name.split()[0]
            for base in _BLOCKS:
                for variant in range(6):
                    noise = 0.0 if variant < 2 else 0.12
                    words = name.split() if variant % 2 == 0 else [name.replace(" ", "")]
                    rendered = []
                    for w in words:
                        rendered.append(render(w, base, rng, noise))
                    if variant >= 4 and len(rendered[0]) > 4:  # split one word in two
                        h = len(rendered[0]) // 2
                        rendered = [rendered[0][:h], rendered[0][h:]] + rendered[1:]
                    text = "இது " + " ".join(rendered) + " தினம்" if base == 0x0B80 else "यह " + " ".join(rendered) + " दिन"
                    toks = cs.tokens(text)
                    if cs._find(first, toks, 0.72) is not None:
                        n_credit += 1
                        if not f.p_has_drug(text, name, lex):
                            n_miss += 1
                            misses.append((name, text))
        print(f"\nproperty: S1 credited {n_credit}, D4-E missed {n_miss}")
        self.assertGreater(n_credit, 500)
        self.assertEqual(n_miss, 0, misses[:10])


if __name__ == "__main__":
    unittest.main()
