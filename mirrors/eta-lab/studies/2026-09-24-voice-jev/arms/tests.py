"""Harness tests (no network). Run: python3 tests.py"""
import json, os, subprocess, sys, tempfile, unittest
import common as C, combine as K, score as S, arm4_gemini as G

HERE = C.HERE
RULE = os.path.join(HERE, "COMBINE_RULE.md")
RSHA = C.sha256_file(RULE)


class TestFreeze(unittest.TestCase):
    def test_sha(self): self.assertTrue(C.freeze_text()[1].startswith("b961291ae64c"))
    def test_questions_verbatim(self):
        q = C.questions("Dr Z")
        self.assertEqual(q["q1"]["instructions"], "Who is most likely speaking in THIS TURN?")
        self.assertEqual(q["q2"]["instructions"], "Is THIS TURN spoken by the same person as the previous turn?")
        self.assertIn("third person", q["q3"]["instructions"])
        self.assertEqual(list(q["q1"]["criteria"]), C.Q1_KEYS)
    def test_arm4_prompts_verbatim(self): G.prompt_parts()


class TestDoubtful(unittest.TestCase):  # 5 hand-checked cases
    def test_cases(self):
        f = C.is_doubtful
        self.assertTrue(f({"margin": 0.09, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2}))       # margin below 0.10
        self.assertFalse(f({"margin": 0.10, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2}))      # margin exactly 0.10 is not < 0.10
        self.assertTrue(f({"margin": 0.40, "speaker_basis": "diarization_only", "nemotron_n": 2, "pyannote_n": 2}))  # basis
        self.assertTrue(f({"margin": 0.40, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 3}))       # counts disagree
        self.assertFalse(f({"margin": 0.40, "speaker_basis": "voice_match", "nemotron_n": None, "pyannote_n": 3}))   # missing count is no disagreement
        self.assertTrue(f({"margin": None, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2}))       # missing margin = doubtful (D1)


class TestCombine(unittest.TestCase):
    rule = {"conf_threshold": 0.70}
    def test_q1(self):
        q = lambda c, p: {"choice": c, "confidence": p}
        self.assertEqual(K.q1_to_final(q("doctor", 0.70), 0.70), "doctor")          # >= is inclusive
        self.assertEqual(K.q1_to_final(q("doctor", 0.69), 0.70), "unsure")
        self.assertEqual(K.q1_to_final(q("patient", 0.95), 0.70), "not_doctor")
        self.assertEqual(K.q1_to_final(q("cannot_tell", 0.99), 0.70), "unsure")
        self.assertEqual(K.q1_to_final(None, 0.70), "unsure")
    def test_confident_keeps_arm1(self):
        a1 = {"doubtful": False, "is_doctor": True}
        self.assertEqual(K.combine(3, a1, {"q1": {"choice": "patient", "confidence": 0.99}}, self.rule), "doctor")
    def test_doubtful_and_missing(self):
        a1 = {"doubtful": True, "is_doctor": True}
        self.assertEqual(K.combine(3, a1, {"q1": {"choice": "patient", "confidence": 0.9}}, self.rule), "not_doctor")
        self.assertEqual(K.combine(3, a1, None, self.rule), "unsure")
        self.assertEqual(K.combine(3, a1, {"error": "x"}, self.rule), "unsure")
        self.assertEqual(K.combine(4, a1, {"answer": "marked_middle_speaker"}, self.rule), "doctor")
        self.assertEqual(K.combine(4, a1, {"answer": "cannot_tell"}, self.rule), "unsure")
    def test_rule_hash_enforced(self):
        self.assertEqual(K.load_rule(RULE, RSHA[:12])["conf_threshold"], 0.70)
        with self.assertRaises(SystemExit): K.load_rule(RULE, "000000000000")
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f: f.write(open(RULE).read().replace("0.70", "0.60", 1))
        with self.assertRaises(SystemExit): K.load_rule(f.name, RSHA[:12])         # tampered threshold is caught
        os.unlink(f.name)


class TestBlinding(unittest.TestCase):
    def test_truth_key_refused(self):
        with self.assertRaises(SystemExit): C.blind_check("/x/cards.jsonl", [{"turn_id": "a", "truth": 1}])
        with self.assertRaises(SystemExit): C.blind_check("/x/speaker-count-30/key.json", [])
        with self.assertRaises(SystemExit): C.blind_check("/x/truth_turns.jsonl", [])
        C.blind_check("/x/cards.jsonl", [{"turn_id": "a", "card_text": "hi"}])


class TestTruthAndSelection(unittest.TestCase):
    def test_load_truth(self):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for r in [{"turn_id": "a", "labels": {"V": "doctor", "S": "cannot tell"}},            # 1 usable answer -> doctor
                      {"turn_id": "b", "labels": {"V": "doctor", "S": "patient"}},                # disagree -> excluded
                      {"turn_id": "c", "labels": {"V": "cannot tell", "S": "Cannot_tell"}},       # none usable -> excluded
                      {"turn_id": "d", "labels": {"V": "companion or relative", "S": "staff"}},   # both not-doctor -> agree
                      {"turn_id": "e", "rater": "V", "label": "doctor"}, {"turn_id": "e", "rater": "S", "label": "doctor"}]:
                f.write(json.dumps(r) + "\n")
        t, rep = S.load_truth(f.name); os.unlink(f.name)
        self.assertEqual(t, {"a": True, "d": False, "e": True})
        self.assertEqual((rep["excluded_raters_disagree"], rep["excluded_no_usable_answer"], rep["disagree_turn_ids"]), (1, 1, ["b"]))
    def test_select_turns(self):
        rows = [{"turn_id": f"c{i:03d}", "margin": 0.3, "speaker_basis": "voice_match"} for i in range(100)] + [{"turn_id": f"d{i}", "margin": 0.01, "speaker_basis": "voice_match"} for i in range(5)]
        s1 = C.select_turns(rows, "doubtful+sample"); s2 = C.select_turns(list(reversed(rows)), "doubtful+sample")
        self.assertEqual(s1, s2)                                                                 # order-independent, reproducible
        self.assertEqual((len([t for t in s1 if t[0] == "d"]), len([t for t in s1 if t[0] == "c"])), (5, 40))
        import random; self.assertEqual(sorted(t for t in s1 if t[0] == "c"), sorted(random.Random(24092026).sample(sorted(r["turn_id"] for r in rows if r["turn_id"][0] == "c"), 40)))
        self.assertEqual(C.select_turns(rows, "doubtful"), {f"d{i}" for i in range(5)})
        self.assertEqual(C.select_turns(rows, "doubtful+sample", ["d1", "c000"]) - {"c000"}, {"d1"})
    def test_addendum_sha(self): self.assertTrue(C.addendum_sha().startswith("9c335c59c5be")); self.assertEqual(set(C.stamp()), {"freeze_sha12", "addendum_sha12"})


class TestArm1(unittest.TestCase):
    def test_role_mapping(self):
        d = tempfile.mkdtemp(); inp = f"{d}/in.jsonl"
        rows = [{"turn_id": "a", "window_id": "w", "role": "clinician", "margin": .5, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2},
                {"turn_id": "b", "window_id": "w", "role": "", "margin": .5, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2},
                {"turn_id": "c", "window_id": "w", "role": None, "margin": .5, "speaker_basis": "voice_match"}, {"turn_id": "e", "window_id": "w", "role": "patient", "margin": .5, "speaker_basis": "voice_match"}]
        with open(inp, "w") as f: f.write("".join(json.dumps(r) + "\n" for r in rows))
        subprocess.run([sys.executable, os.path.join(HERE, "arm1.py"), "--in", inp, "--out", f"{d}/o.jsonl"], check=True, capture_output=True)
        o = {r["turn_id"]: r for r in C.read_jsonl(f"{d}/o.jsonl")}
        self.assertEqual([o[k]["is_doctor"] for k in "abce"], [True, False, False, False]); self.assertEqual([o[k]["role_empty"] for k in "abce"], [False, True, True, False])
        self.assertEqual(o["a"]["addendum_sha12"], "9c335c59c5be")
        rows[0].pop("role")
        with open(inp, "w") as f: f.write("".join(json.dumps(r) + "\n" for r in rows))
        self.assertNotEqual(subprocess.run([sys.executable, os.path.join(HERE, "arm1.py"), "--in", inp, "--out", f"{d}/o2.jsonl"], capture_output=True).returncode, 0)   # missing key refused


class TestScorer(unittest.TestCase):
    """Hand-computed. 6 turns: d1-d4 doubtful, c1-c2 confident. Truth (both raters): d1 doctor, d2 doctor, d3 staff, d4 patient, c1 doctor, c2 patient."""
    def w(self, n, rows):
        with open(os.path.join(self.tmp, n), "w") as f: f.write("".join(json.dumps(r) + "\n" for r in rows))
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        a1 = lambda t, wid, role, dbt: {"turn_id": t, "window_id": wid, "arm": 1, "role": role, "role_empty": not role, "is_doctor": role == "clinician", "doubtful": dbt, "margin": 0.05 if dbt else 0.3, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2}
        # arm1 on doubtful: d1 right, d2 wrong, d3 wrong, d4 right => 2/4
        self.w("arm1.jsonl", [a1("d1", "w1", "clinician", True), a1("d2", "w1", "", True), a1("d3", "w2", "clinician", True), a1("d4", "w2", "patient", True), a1("c1", "w3", "clinician", False), a1("c2", "w3", "patient", False)])
        self.w("truth.jsonl", [{"turn_id": t, "labels": {"V": l, "S": l}} for t, l in [("d1", "doctor"), ("d2", "doctor"), ("d3", "staff"), ("d4", "patient"), ("c1", "doctor"), ("c2", "patient")]])
        q = lambda t, ch, cf: {"turn_id": t, "arm": 3, "q1": {"choice": ch, "confidence": cf}, "usage": {"input_tokens": 100, "output_tokens": 10}, "latency_s": 2.0}
        # arm3: d1 doctor .9 right; d2 doctor .8 right; d3 patient .9 right; d4 doctor .6 -> unsure (wrong) => 3/4.  Direct on confident: c1 patient (flip), c2 doctor (flip)
        self.w("arm3.jsonl", [q("d1", "doctor", .9), q("d2", "doctor", .8), q("d3", "patient", .9), q("d4", "doctor", .6), q("c1", "patient", .99), q("c2", "doctor", .99)])
        self.w("windows.jsonl", [{"window_id": w, "duration_s": 1800} for w in ("w1", "w2", "w3")])
        self.cmd = [sys.executable, os.path.join(HERE, "score.py"), "--arm1", f"{self.tmp}/arm1.jsonl", "--truth", f"{self.tmp}/truth.jsonl", "--arm3", f"{self.tmp}/arm3.jsonl",
                    "--rule", RULE, "--rule-sha", RSHA, "--windows", f"{self.tmp}/windows.jsonl", "--outdir", f"{self.tmp}/out"]
    def run_score(self, extra=()):
        subprocess.run(self.cmd + list(extra), check=True, capture_output=True); return json.load(open(f"{self.tmp}/out/results.json"))
    def test_numbers(self):
        r = self.run_score(); a1, a3 = r["arms"]["arm1"], r["arms"]["arm3"]
        self.assertEqual((a1["doubtful"]["correct"], a1["doubtful"]["n"], a1["confident"]["correct"]), (2, 4, 2))
        self.assertEqual((a3["doubtful"]["correct"], a3["doubtful"]["n"], a3["confident"]["correct"]), (3, 4, 2))
        self.assertEqual((a3["unsure_n"], a3["unsure_doubtful_n"], a3["missing_n"]), (1, 1, 0))
        self.assertEqual(a3["vs_arm1_doubtful"], {"arm_right_arm1_wrong": 2, "arm_wrong_arm1_right": 1, "mcnemar_exact_p": 1.0, "gain_pp": 25.0})
        self.assertEqual((a3["confident_sample"]["n"], a3["confident_sample"]["flipped_right_to_wrong"], a3["confident_sample"]["would_have_changed"]), (2, 2, 2))
        self.assertEqual(a3["escalated_share"], round(4 / 6, 4)); self.assertEqual(a3["cost"]["audio_hours"], 1.5); self.assertEqual(a3["cost"]["call_seconds_per_audio_hour"], round(12.0 / 1.5, 3))
        self.assertEqual(r["arm1_empty_role"], {"not_doctor_turns": 3, "not_doctor_with_empty_role": 1})
        self.assertEqual((r["freeze_sha12"], r["addendum_sha12"], r["combine_rule_sha256"]), ("b961291ae64c", "9c335c59c5be", RSHA))
        c = a3["pass_bar"]["criteria"]                                       # F1 fails (4 < 60), F3 fails (p=1), F4 fails (2 flips), F5 not run
        self.assertEqual(c, {"F1_n_doubtful_with_truth>=60": False, "F2_gain>=5pp": True, "F3_mcnemar_p<0.05": False, "F4_zero_confident_sample_flips": False, "F5_stability": False})
        self.assertFalse(a3["pass_bar"]["meets_pass_bar"])
    def test_missing_counted(self):
        self.w("arm3.jsonl", [{"turn_id": "d1", "arm": 3, "q1": {"choice": "doctor", "confidence": .9}}])            # d2, d3, d4 never run
        a3 = self.run_score()["arms"]["arm3"]; self.assertEqual((a3["missing_n"], a3["errors_n"], a3["doubtful"]["correct"]), (3, 0, 1))
    def test_disagreement_excluded(self):
        self.w("truth.jsonl", [{"turn_id": "d1", "labels": {"V": "doctor", "S": "patient"}}, {"turn_id": "d2", "labels": {"V": "doctor", "S": "cannot tell"}}])
        r = self.run_score(); self.assertEqual(r["truth"]["excluded_raters_disagree"], 1); self.assertEqual(r["arms"]["arm3"]["doubtful"]["n"], 1)
    def test_stability(self):
        q = lambda t, ch, cf: {"turn_id": t, "arm": 3, "q1": {"choice": ch, "confidence": cf}}
        same = [q("d1", "doctor", .9), q("d2", "doctor", .8), q("d3", "patient", .9), q("d4", "doctor", .6)]
        self.w("rq_same.jsonl", same)
        s = self.run_score(["--requery3", f"{self.tmp}/rq_same.jsonl"])["arms"]["arm3"]["stability"]
        self.assertEqual((s["agreement"], s["agreement_ok"], s["share_ok"], s["win_holds_with_requery"]), (1.0, True, True, False))   # stable, gain still 25pp, but F3 (p<0.05) cannot hold on 4 turns
        self.assertEqual(s["paired_with_requery"]["gain_pp"], 25.0)
        self.w("rq_flip.jsonl", [q("d1", "patient", .9), q("d2", "patient", .9), q("d3", "doctor", .9), q("d4", "doctor", .6)])
        s = self.run_score(["--requery3", f"{self.tmp}/rq_flip.jsonl"])["arms"]["arm3"]["stability"]
        self.assertEqual((s["agreement"], s["holds"]), (0.25, False))
    def test_rerun_identical(self):
        a = json.dumps(self.run_score(), sort_keys=True); self.assertEqual(a, json.dumps(self.run_score(), sort_keys=True))
    def test_wrong_rule_sha_refused(self):
        r = subprocess.run(self.cmd[:-4] + ["--rule-sha", "000000000000", "--outdir", f"{self.tmp}/o2"], capture_output=True, text=True); self.assertNotEqual(r.returncode, 0)
    def test_sign_test(self):
        self.assertEqual(S.sign_test_p(0, 0), 1.0); self.assertAlmostEqual(S.sign_test_p(9, 1), 0.0215, 3); self.assertEqual(S.sign_test_p(5, 5), 1.0)
    def test_counts_gate_and_q3(self):
        hum = {f"w{i}": [3, 3] for i in range(19)}
        self.assertFalse(S.score_counts([], [], [], hum, None)["scored"])                      # 19 < 20: not scored
        hum["w19"] = [2]; hum["w0"] = [2, 4]
        l2 = [{"kind": "l2", "window_id": f"w{i}", "speakers": 3} for i in range(20)]
        a1 = [{"window_id": f"w{i}", "nemotron_n": 3, "pyannote_n": 2} for i in range(20)]
        q3 = [{"window_id": "w1", "q3_p": .9}, {"window_id": "w1", "q3_p": .1}, {"window_id": "w19", "q3_p": .2}, {"window_id": "w0", "q3_p": .9}]
        r = S.score_counts(q3, l2, a1, hum, None)
        self.assertEqual(r["human_ids_matching_no_source"], [])
        hum["cwZZ"] = [3]; self.assertEqual(S.score_counts(q3, l2, a1, hum, None)["human_ids_matching_no_source"], ["cwZZ"])
        self.assertTrue(r["scored"]); self.assertEqual(r["arm4_l2"], {"n_any": 20, "exact_any": 18, "n_consensus": 19, "exact_consensus": 18})   # w19 human=[2] and w0 human=[2,4] both miss a 3
        self.assertEqual(r["arm3_q3_third_person"], {"n": 2, "tp": 1, "fp": 0, "fn": 0, "tn": 1})    # w0 straddles 3 -> excluded; w1 tp; w19 tn


class TestPassBarCanPass(unittest.TestCase):
    def test_all_five(self):
        rule = {"conf_threshold": 0.7}; a1, truth, outs = {}, {}, {}
        for i in range(70):                       # 70 doubtful, truth doctor. arm1 right on 0..34; arm right on 10..59 -> b=25 (35..59), c=10 (0..9)
            t = f"d{i}"; truth[t] = True
            a1[t] = {"turn_id": t, "window_id": "w", "is_doctor": i < 35, "doubtful": True}
            outs[t] = {"turn_id": t, "q1": {"choice": "doctor" if 10 <= i < 60 else "patient", "confidence": .9}}
        for i in range(40):                       # 40 confident, arm 1 right, arm agrees
            t = f"c{i}"; truth[t] = True; a1[t] = {"turn_id": t, "window_id": "w", "is_doctor": True, "doubtful": False}; outs[t] = {"turn_id": t, "q1": {"choice": "doctor", "confidence": .9}}
        rq = {t: outs[t] for t in list(outs)[:14]}
        st = S.stability(3, a1, truth, outs, rq, rule, None)
        sm = S.summarize(3, S.score_turns(3, a1, truth, outs, rule), 1.0, outs, {}, st)
        self.assertEqual(sm["vs_arm1_doubtful"]["arm_right_arm1_wrong"], 25); self.assertEqual(sm["vs_arm1_doubtful"]["arm_wrong_arm1_right"], 10)
        self.assertTrue(sm["pass_bar"]["meets_pass_bar"], sm["pass_bar"])
        outs["c0"] = {"turn_id": "c0", "q1": {"choice": "patient", "confidence": .9}}          # one confident flip kills it
        sm = S.summarize(3, S.score_turns(3, a1, truth, outs, rule), 1.0, outs, {}, st)
        self.assertFalse(sm["pass_bar"]["meets_pass_bar"]); self.assertFalse(sm["pass_bar"]["criteria"]["F4_zero_confident_sample_flips"])


class TestClipCutter(unittest.TestCase):
    def test_turn_clip_length(self):
        fx = os.path.join(HERE, "fixture", "fxw00.wav")
        if not os.path.exists(fx): self.skipTest("run make_fixture.py first")
        out = tempfile.mktemp(suffix=".wav")
        secs = G.cut_turn_clip(fx, 6.0, 9.0, out)     # 5 s pre + 0.25 beep + 3 s + 0.25 beep + 5 s post = 13.5 (window is 18.9 s long)
        self.assertAlmostEqual(secs, 13.5, delta=0.1)
        secs = G.cut_turn_clip(fx, 0.0, 3.0, out)     # turn at file start: no pre segment
        self.assertAlmostEqual(secs, 3.0 + 0.5 + 5.0, delta=0.1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
