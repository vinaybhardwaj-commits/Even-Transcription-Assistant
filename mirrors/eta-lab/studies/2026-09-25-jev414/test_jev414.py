#!/usr/bin/env python3
"""unittest for the r414.2 freeze v2 (page-seed sources). python3 -B test_jev414.py."""
import json, os, subprocess, sys, tempfile, unittest
import jevcfg414 as cfg

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


class Wording(unittest.TestCase):
    def test_bindings(self):
        for s, w in cfg.SETS.items():
            self.assertIn("{K}", w["instructions"], s)
            self.assertGreaterEqual(len(w["criteria"]), 4, s)
            self.assertIn("cannot_tell", w["criteria"], s)
            self.assertNotIn("unsure", w["criteria"], s)

    def test_questions_name_own_key(self):
        q = cfg.questions_for(cfg.LABEL200, ["L001", "L042"])
        self.assertIn("named L001", q["L001"]["instructions"])
        self.assertNotIn("L042", q["L001"]["instructions"])

    def test_frozen_choice_sets(self):
        self.assertEqual(set(cfg.LABEL200["criteria"]),
                         {"readable", "romanised_readable", "garbled",
                          "wrong_language", "cannot_tell"})
        self.assertEqual(set(cfg.BA106["criteria"]),
                         {"A_better", "B_better", "same", "neither_readable", "cannot_tell"})
        self.assertEqual(set(cfg.RATE20["criteria"]),
                         {"yes", "partly", "no", "cannot_tell"})

    def test_refuter_fixes_applied(self):
        self.assertIn("coherent clinical speech in English", cfg.LABEL200["criteria"]["wrong_language"])
        self.assertIn("you cannot hear the audio", cfg.BA106["instructions"].lower())
        self.assertIn("the gloss may help", cfg.LABEL200["criteria"]["readable"])
        self.assertEqual(cfg.LABEL200["version"], "lv1.2")
        self.assertEqual(cfg.BA106["version"], "bv1.2")


def mk_seeds(d, n=200, miss=None):
    p200 = os.path.join(d, "l200.json")
    json.dump({"rows": [{"id": f"L{i:03d}", "lang": "hi" if i % 2 else "und",
                         "text": f"invented text {i}", "n": i, "dur_s": 1}
                        for i in range(1, n + 1)]}, open(p200, "w"))
    gloss = {f"L{i:03d}": f"gloss {i}" for i in range(1, n + 1)}
    gloss.pop(miss, None)
    return p200, gloss


class Glue(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name

    def _run(self, args):
        return subprocess.run([PY, "-B", os.path.join(HERE, args[0])] + args[1:],
                              capture_output=True, text=True, cwd=HERE)

    def _batches(self, n=200, miss=None):
        p200, gloss = mk_seeds(self.d, n, miss)
        gp = os.path.join(self.d, "g.json")
        json.dump(gloss, open(gp, "w"))
        bdir = os.path.join(self.d, "b")
        r = self._run(["build_batches.py", "--set", "label200", "--seed", p200,
                       "--gloss", gp, "--out", bdir])
        return bdir, r

    def test_build_and_merge_ok(self):
        bdir, r = self._batches()
        self.assertEqual(r.returncode, 0, r.stderr)
        files = sorted(f for f in os.listdir(bdir) if f.endswith(".json"))
        self.assertEqual(len(files), 25)
        adir = os.path.join(self.d, "a")
        os.mkdir(adir)
        for bf in files:
            bdoc = json.load(open(os.path.join(bdir, bf)))
            ans = {"answers": {k: {"choice": "garbled", "confidence": 0.7,
                                   "probabilities": {c: 0.2 for c in cfg.LABEL200["criteria"]}}
                               for k in bdoc["questions"]}}
            json.dump(ans, open(os.path.join(adir, bf[:-5] + ".answers.json"), "w"))
        r = self._run(["merge_answers.py", "--batches", bdir, "--answers", adir,
                       "--out", os.path.join(self.d, "out.json")])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        merged = json.load(open(os.path.join(self.d, "out.json")))
        self.assertEqual(len(merged), 200)
        self.assertEqual(merged["L001"]["label"], "garbled")

    def test_gloss_miss_aborts(self):
        _, r = self._batches(miss="L005")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("gloss miss L005", r.stderr)

    def test_dropped_answer_aborts(self):
        bdir, _ = self._batches()
        adir = os.path.join(self.d, "a2")
        os.mkdir(adir)
        for bf in sorted(os.listdir(bdir)):
            bdoc = json.load(open(os.path.join(bdir, bf)))
            ks = list(bdoc["questions"])
            drop = ks[-1] if bf == "label200_b02.json" else None
            ans = {"answers": {k: {"choice": "readable", "confidence": 0.6,
                                   "probabilities": {}} for k in ks if k != drop}}
            json.dump(ans, open(os.path.join(adir, bf[:-5] + ".answers.json"), "w"))
        r = self._run(["merge_answers.py", "--batches", bdir, "--answers", adir,
                       "--out", os.path.join(self.d, "o2.json")])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("dropped answer", r.stderr)

    def test_illegal_choice_aborts(self):
        bdir, _ = self._batches()
        adir = os.path.join(self.d, "a3")
        os.mkdir(adir)
        for bf in sorted(os.listdir(bdir)):
            bdoc = json.load(open(os.path.join(bdir, bf)))
            ans = {"answers": {k: {"choice": "flagged", "confidence": 0.6,
                                   "probabilities": {}} for k in bdoc["questions"]}}
            json.dump(ans, open(os.path.join(adir, bf[:-5] + ".answers.json"), "w"))
        r = self._run(["merge_answers.py", "--batches", bdir, "--answers", adir,
                       "--out", os.path.join(self.d, "o3.json")])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not in frozen criteria", r.stderr)

    def test_rate20_grains(self):
        seed = os.path.join(self.d, "s2.json")
        lines = lambda en: [{"lang": "hi", "t": 1, "text": "la"},
                            {"lang": "en", "t": 2, "text": "english line"},
                            {"lang": "hi", "t": 3, "text": "lb"}]
        json.dump({"excerpts": [{"id": f"R{i:02d}", "lines": lines(i)} for i in range(1, 21)]},
                  open(seed, "w"))
        for name, gmap, want in (
            ("excerpt", {f"R{i:02d}": "ga gb" for i in range(1, 21)}, "ga gb"),
            ("line", {f"R{i:02d}": ["ga", "gb"] for i in range(1, 21)}, "ga\ngb")):
            gp = os.path.join(self.d, f"gr_{name}.json")
            json.dump(gmap, open(gp, "w"))
            bdir = os.path.join(self.d, f"br_{name}")
            r = self._run(["build_batches.py", "--set", "rate20", "--seed", seed,
                           "--gloss", gp, "--out", bdir])
            self.assertEqual(r.returncode, 0, r.stderr)
            doc = json.load(open(os.path.join(bdir, "rate20_b01.json")))
            e = doc["state"]["R01"]
            self.assertEqual(e["text"], "la\nlb")
            self.assertNotIn("english line", e["text"])
            self.assertEqual(e["gloss_en"], want)
            self.assertEqual(e["langs"], ["hi"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
