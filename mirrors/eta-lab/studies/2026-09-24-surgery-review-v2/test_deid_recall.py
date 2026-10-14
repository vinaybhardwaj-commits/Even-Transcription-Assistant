"""Tests for deid_recall.py on INVENTED fixtures only (no real text). Run: python3 -m unittest test_deid_recall -v  (needs no model or GPU)."""
import contextlib, io, json, os, random, shutil, stat, subprocess, tempfile, unittest

import deid
import deid_recall as dr

CUE_TURNS = ["My phone number is 9845012345 please note it.", "Her name is Ramesh and she was born in 1950.", "The address is 22 Cross Road, ok.",
             "Aadhaar 123456789012 is on the card.", "Nine eight four five zero one two three four five is the number."]
CAPS_TURNS = ["We will ask Kavita about the scan.", "Then Suresh will come back next week.", "It was Mohammed who called us."]
BASE_TURNS = ["We will do the knee replacement next month.", "Take one tablet twice a day after food.", "The scan shows wear on the inner side."]


def fixture(n_each=12):
    """Invented records {item, room, i, en}: 12 of each kind spread over 3 items and 2 rooms."""
    recs, i = [], 0
    for kind in (CUE_TURNS, CAPS_TURNS, BASE_TURNS):
        for j in range(n_each):
            recs.append({"item": f"P0{j % 3}", "room": f"R{j % 2}", "i": i, "en": kind[j % len(kind)]})
            i += 1
    return recs


def deided(recs):
    return [{**r, "en": r["en"].replace("Ramesh", "[PATIENT_NAME]").replace("9845012345", "[PHONE]")} for r in recs]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="deid_recall_test_")
        self.recs = fixture()
        self.raw, self.dei = self.path("raw.json", self.recs), self.path("dei.json", deided(self.recs))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, name, obj):
        p = os.path.join(self.tmp, name)
        with open(p, "w") as fh:
            json.dump(obj, fh)
        return p

    def sample(self, seed=27, out="out", raw=None, **kw):
        args = ["sample", "--raw", raw or self.raw, "--deid", self.dei, "--seed", str(seed), "--out-dir", os.path.join(self.tmp, out),
                "--n-cue", str(kw.get("n_cue", 6)), "--n-caps", str(kw.get("n_caps", 3)), "--n-base", str(kw.get("n_base", 3))]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dr.main(args)
        with open(os.path.join(self.tmp, out, "sample.json")) as fh:
            return json.load(fh), buf.getvalue()

    def code(self, argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), self.assertRaises(SystemExit) as cm:
            dr.main(argv)
        return cm.exception.code, buf.getvalue()


class TestSampling(Base):
    def keys(self, s):
        return [t["key"] for t in s["turns"]]

    def test_same_seed_same_sample(self):
        self.assertEqual(self.keys(self.sample(27, "a")[0]), self.keys(self.sample(27, "b")[0]))

    def test_different_seed_different_sample(self):  # fails if the seed is ignored
        self.assertNotEqual(self.keys(self.sample(27, "a")[0]), self.keys(self.sample(28, "b")[0]))

    def test_input_order_does_not_matter(self):  # fails if the stable sort is dropped
        shuffled = list(self.recs); random.Random(5).shuffle(shuffled)
        self.assertEqual(self.keys(self.sample(27, "a")[0]), self.keys(self.sample(27, "b", raw=self.path("raw2.json", shuffled))[0]))

    def test_strata_are_pure(self):
        s, _ = self.sample(27, n_cue=8, n_caps=8, n_base=8)
        raw = dr.load_turns(self.raw)
        for t in s["turns"]:
            self.assertEqual({"cue": "cue", "caps": "caps", "baseline": "none"}[t["stratum"]], dr.cue_kind(raw[t["key"]]))

    def test_sizes_are_capped_by_the_pool(self):
        s, _ = self.sample(27, n_cue=500, n_caps=500, n_base=500)
        self.assertEqual(len(s["turns"]), len(self.recs))
        self.assertEqual(len(set(self.keys(s))), len(self.recs))

    def test_stdout_and_sample_json_carry_no_text(self):  # every fixture sentence, not a hand-picked few: any printed turn must be caught
        s, out = self.sample(27)
        blob = out + json.dumps(s)
        for sentence in CUE_TURNS + CAPS_TURNS + BASE_TURNS:
            self.assertNotIn(sentence[:14], blob)
        for word in ("Ramesh", "Kavita", "9845012345", "knee", "Aadhaar", "tablet"):
            self.assertNotIn(word, blob)

    def test_files_are_private_and_the_sheet_has_both_sides(self):
        self.sample(27, "priv")
        d = os.path.join(self.tmp, "priv")
        for f in ("sample.json", "sheet.txt", "labels_template.json"):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(d, f)).st_mode), 0o600)
        with open(os.path.join(d, "sheet.txt")) as fh:
            sheet = fh.read()
        self.assertIn("RAW :", sheet); self.assertIn("DEID:", sheet)

    def test_refuses_to_write_inside_a_git_tree(self):  # a throwaway repo; the target dir does not exist yet, so the guard must walk up to an existing ancestor
        repo = os.path.join(self.tmp, "repo")
        subprocess.run(["git", "init", "-q", repo], check=True)
        target = os.path.join(repo, "not", "yet", "there")
        with self.assertRaises(SystemExit):
            dr.main(["sample", "--raw", self.raw, "--deid", self.dei, "--seed", "1", "--out-dir", target])
        self.assertFalse(os.path.exists(target))

    def test_mismatched_inputs_exit(self):
        bad = self.path("dei_short.json", deided(self.recs)[:-1])
        with self.assertRaises(SystemExit):
            dr.main(["sample", "--raw", self.raw, "--deid", bad, "--seed", "1", "--out-dir", os.path.join(self.tmp, "x")])

    def test_duplicate_keys_are_an_error(self):
        with self.assertRaises(ValueError):
            dr.load_turns(self.path("dup.json", self.recs + [self.recs[0]]))


class TestIndependentCue(unittest.TestCase):
    def test_spoken_number_the_redactor_cannot_parse_is_still_a_cue(self):  # deid needs a run of 7; five digit words are enough here
        text = "Call nine eight four five zero later."
        self.assertEqual(deid.spoken_digit_spans(text), [])
        self.assertEqual(dr.cue_kind(text), "cue")

    def test_hindi_and_kannada_spellings_and_script_digits(self):
        for text in ("Number hai nau aath char paanch shunya.", "Nanna number ombattu entu naalku aidu sonne.", "Phone ९८४५० please.", "Call 98 45 0 now."):
            self.assertEqual(dr.cue_kind(text), "cue", text)

    def test_ordinary_number_words_are_not_a_cue(self):
        for text in ("We need one or two tablets.", "Come in two weeks and do it once.", "It takes about one hour."):
            self.assertNotEqual(dr.cue_kind(text), "cue", text)

    def test_the_cue_detector_does_not_call_the_redactors_digit_detector(self):  # fails if the circular call comes back
        with open(dr.__file__) as fh:
            body = fh.read().split("def cue_kind")[1].split("def wilson")[0]
        self.assertNotIn("spoken_digit_spans", body)
        self.assertNotIn("deid.", body)


class TestScoring(Base):
    def labels(self, sample, **over):
        lab = {t["key"]: {"present": {}, "missed": {}, "doctors_kept_ok": 0, "doctors_removed_wrongly": 0} for t in sample["turns"]}
        lab.update(over)
        return lab

    def score(self, sample_path, lab, gate=None):
        argv = ["score", "--sample", sample_path, "--labels", self.path("lab.json", lab)] + (["--gate-max-missed", str(gate)] if gate is not None else [])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dr.main(argv)
        return json.loads(buf.getvalue())

    def setUp(self):
        super().setUp()
        self.s, _ = self.sample(27, "sc")
        self.sp = os.path.join(self.tmp, "sc", "sample.json")
        self.k = [t["key"] for t in self.s["turns"]]

    def test_wilson_known_value(self):
        self.assertEqual(dr.wilson(9, 10), (0.596, 0.982))
        self.assertEqual(dr.wilson(0, 0), (None, None))

    def test_scorer_states_the_lowercase_name_limit(self):
        out = self.score(self.sp, self.labels(self.s))
        self.assertTrue(any("lowercase" in c for c in out["caveats"]))

    def test_recall_and_doctor_counts(self):
        lab = self.labels(self.s)
        lab[self.k[0]] = {"present": {"name": 4, "phone": 1}, "missed": {"name": 1}, "doctors_kept_ok": 2, "doctors_removed_wrongly": 1}
        lab[self.k[1]] = {"present": {"name": 5}, "missed": {}, "doctors_kept_ok": 0, "doctors_removed_wrongly": 0}
        r = self.score(self.sp, lab)
        self.assertEqual((r["identifiers_present"], r["missed"], r["recall"]), (10, 1, 0.9))
        self.assertEqual(r["doctors"], {"kept_ok": 2, "removed_wrongly": 1})
        self.assertEqual(r["by_stratum_type"]["ALL"]["name"]["present"], 9)

    def test_gate_fails_on_any_miss(self):  # fails if the gate is dropped
        lab = self.labels(self.s); lab[self.k[0]] = {"present": {"name": 3}, "missed": {"name": 1}}
        code, _ = self.code(["score", "--sample", self.sp, "--labels", self.path("l.json", lab), "--gate-max-missed", "0"])
        self.assertEqual(code, 1)

    def test_gate_passes_with_no_miss(self):
        lab = self.labels(self.s); lab[self.k[0]] = {"present": {"name": 3}, "missed": {}}
        self.assertEqual(self.score(self.sp, lab, gate=0)["missed"], 0)

    def test_labels_must_cover_exactly_the_sample(self):
        for lab in ({k: v for k, v in list(self.labels(self.s).items())[1:]}, {**self.labels(self.s), "zzz#R0#999": {"present": {}}}):
            code, out = self.code(["score", "--sample", self.sp, "--labels", self.path("l.json", lab)])
            self.assertEqual(code, 2); self.assertIn("error", out)

    def test_bad_labels_are_rejected(self):
        for bad in ({"present": {"name": 1}, "missed": {"name": 2}}, {"present": {"passport": 1}, "missed": {}}, {"present": {}, "missed": {"name": 1}}):
            lab = self.labels(self.s); lab[self.k[0]] = bad
            code, _ = self.code(["score", "--sample", self.sp, "--labels", self.path("l.json", lab)])
            self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
