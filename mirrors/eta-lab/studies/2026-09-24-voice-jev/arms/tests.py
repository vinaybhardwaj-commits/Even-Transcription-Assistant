"""Harness tests (no network). Run: python3 tests.py"""
import json, os, subprocess, sys, tempfile, unittest
import common as C, combine as K, score as S, arm4_gemini as G

HERE = C.HERE
RULE = os.path.join(HERE, "COMBINE_RULE.md")
RSHA = C.sha256_file(RULE)


class TestEveryScriptRuns(unittest.TestCase):
    def test_help(self):
        for f in ("arm1.py", "arm_jev.py", "arm4_gemini.py", "score.py", "make_fixture.py"):
            r = subprocess.run([sys.executable, os.path.join(HERE, f), "--help"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f + ": " + r.stderr[-300:])


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
        f = lambda **k: C.is_doubtful({"margin": 0.4, "best": 0.7, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2, **k})
        self.assertFalse(f())
        self.assertTrue(f(margin=0.09))                        # margin below 0.10
        self.assertFalse(f(margin=0.10))                       # margin exactly 0.10 is not < 0.10
        self.assertTrue(f(speaker_basis="diarization_only"))   # basis
        self.assertTrue(f(pyannote_n=3))                       # counts disagree
        self.assertFalse(f(nemotron_n=None, pyannote_n=3))     # missing count is no disagreement
        self.assertTrue(f(margin=None))                        # missing margin = doubtful (D1)
        self.assertTrue(f(best=0.49)); self.assertFalse(f(best=0.50)); self.assertTrue(f(best=None))   # ruling 186: best >= 0.50 needed for CONFIDENT


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
    def test_truth_source_priority_e3(self):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for r in [{"turn_id": "a", "source": "who_is_speaking", "labels": {"V": "patient"}}, {"turn_id": "a", "source": "e3_recovered", "is_doctor": True},
                      {"turn_id": "a", "source": "v_existing", "labels": {"V": "cannot tell"}}]:   # v_existing outranks but has no usable answer -> falls to e3_recovered
                f.write(json.dumps(r) + "\n")
        t, rep = S.load_truth(f.name); os.unlink(f.name)
        self.assertEqual((t, rep["usable_by_source"]), ({"a": True}, {"e3_recovered": 1}))
    def test_truth_source_priority(self):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            for r in [{"turn_id": "a", "source": "who_is_speaking", "labels": {"V": "patient"}}, {"turn_id": "a", "source": "v_existing", "labels": {"V": "doctor"}},   # v_existing wins
                      {"turn_id": "b", "source": "who_is_speaking", "labels": {"V": "staff"}}]:
                f.write(json.dumps(r) + "\n")
        t, rep = S.load_truth(f.name); os.unlink(f.name)
        self.assertEqual(t, {"a": True, "b": False}); self.assertEqual(rep["usable_by_source"], {"v_existing": 1, "who_is_speaking": 1})
    def test_select_turns(self):
        rows = [{"turn_id": f"c{i:03d}", "margin": 0.3, "best": 0.7, "speaker_basis": "voice_match"} for i in range(100)] + [{"turn_id": f"d{i}", "margin": 0.01, "best": 0.7, "speaker_basis": "voice_match"} for i in range(5)]
        page = [f"c{i:03d}" for i in range(0, 80, 2)] + ["zzz"]                 # 40 page items + an id arm 1 does not know
        self.assertEqual(C.select_turns(rows, "doubtful+page", None, page), {f"d{i}" for i in range(5)} | set(page[:40]))
        self.assertEqual(C.select_turns(rows, "doubtful"), {f"d{i}" for i in range(5)})
        self.assertEqual(C.select_turns(rows, "doubtful+page", ["d1", "c000", "c001"], page) , {"d1", "c000"})   # refuter's --turn-ids restricts further
        with self.assertRaises(SystemExit): C.select_turns(rows, "doubtful+page")                            # the page ids are required
    def test_extra_ids_and_non_production_guard(self):
        rows = [{"turn_id": "d1", "margin": 0.01, "best": .7, "speaker_basis": "voice_match"}, {"turn_id": "c1", "margin": .3, "best": .7, "speaker_basis": "voice_match"}]
        self.assertEqual(C.select_turns(rows, "doubtful+page", None, [], ["e3x1", "c1"]), {"d1", "e3x1"})       # c1 is in arm 1: no back door; e3x1 (no arm 1 row) is added
        d = tempfile.mkdtemp()
        with open(f"{d}/in.jsonl", "w") as f: f.write(json.dumps({"turn_id": "x", "window_id": "w", "role": None, "margin": None, "best": None, "speaker_basis": "voice_match", "production_row": False}) + "\n")
        r = subprocess.run([sys.executable, os.path.join(HERE, "arm1.py"), "--in", f"{d}/in.jsonl", "--out", f"{d}/o.jsonl"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn("production_row is false", r.stderr)
        with open(f"{d}/a1.jsonl", "w") as f: f.write(json.dumps({"turn_id": "x", "window_id": "w", "is_doctor": False, "doubtful": True, "role": None, "production_row": False}) + "\n")
        with open(f"{d}/t.jsonl", "w") as f: f.write(json.dumps({"turn_id": "x", "labels": {"V": "doctor"}}) + "\n")
        r = subprocess.run([sys.executable, os.path.join(HERE, "score.py"), "--arm1", f"{d}/a1.jsonl", "--truth", f"{d}/t.jsonl", "--rule", RULE, "--rule-sha", RSHA, "--outdir", f"{d}/out"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn("production_row=false", r.stderr)
    def test_addendum_sha(self): self.assertTrue(C.addendum_sha().startswith("9c335c59c5be")); self.assertTrue(C.addendum166_sha().startswith("87b8cdac4330")); self.assertEqual(set(C.stamp()), {"freeze_sha12", "addendum_sha12", "addendum166_sha12"})


class TestArm1(unittest.TestCase):
    def test_role_mapping(self):
        d = tempfile.mkdtemp(); inp = f"{d}/in.jsonl"
        rows = [{"turn_id": "a", "window_id": "w", "role": "clinician", "margin": .5, "best": .7, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2},
                {"turn_id": "b", "window_id": "w", "role": "", "margin": .5, "best": .7, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2},
                {"turn_id": "c", "window_id": "w", "role": None, "margin": .5, "best": .7, "speaker_basis": "voice_match"}, {"turn_id": "e", "window_id": "w", "role": "patient", "margin": .5, "best": .7, "speaker_basis": "voice_match"}]
        with open(inp, "w") as f: f.write("".join(json.dumps(r) + "\n" for r in rows))
        subprocess.run([sys.executable, os.path.join(HERE, "arm1.py"), "--in", inp, "--out", f"{d}/o.jsonl"], check=True, capture_output=True)
        o = {r["turn_id"]: r for r in C.read_jsonl(f"{d}/o.jsonl")}
        self.assertEqual([o[k]["is_doctor"] for k in "abce"], [True, False, False, False]); self.assertEqual([o[k]["role_empty"] for k in "abce"], [False, True, True, False])
        self.assertEqual((o["a"]["addendum_sha12"], o["a"]["addendum166_sha12"]), ("9c335c59c5be", "87b8cdac4330"))
        rows[1].pop("best")                                                                                                                                 # missing best key refused
        with open(inp, "w") as f: f.write("".join(json.dumps(r) + "\n" for r in rows))
        self.assertNotEqual(subprocess.run([sys.executable, os.path.join(HERE, "arm1.py"), "--in", inp, "--out", f"{d}/o3.jsonl"], capture_output=True).returncode, 0)
        rows[1]["best"] = .7
        rows[0].pop("role")
        with open(inp, "w") as f: f.write("".join(json.dumps(r) + "\n" for r in rows))
        self.assertNotEqual(subprocess.run([sys.executable, os.path.join(HERE, "arm1.py"), "--in", inp, "--out", f"{d}/o2.jsonl"], capture_output=True).returncode, 0)   # missing key refused


class TestScorer(unittest.TestCase):
    """Hand-computed. 6 turns: d1-d4 doubtful, c1-c2 confident. Truth (both raters): d1 doctor, d2 doctor, d3 staff, d4 patient, c1 doctor, c2 patient."""
    def w(self, n, rows):
        with open(os.path.join(self.tmp, n), "w") as f: f.write("".join(json.dumps(r) + "\n" for r in rows))
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        a1 = lambda t, wid, role, dbt: {"turn_id": t, "window_id": wid, "arm": 1, "role": role, "role_empty": not role, "is_doctor": role == "clinician", "doubtful": dbt, "margin": 0.05 if dbt else 0.3, "best": 0.7, "speaker_basis": "voice_match", "nemotron_n": 2, "pyannote_n": 2}
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
        v = a3["vs_arm1_doubtful"]
        self.assertEqual({k: v[k] for k in ("arm_right_arm1_wrong", "arm_wrong_arm1_right", "mcnemar_exact_p", "gain_pp")}, {"arm_right_arm1_wrong": 2, "arm_wrong_arm1_right": 1, "mcnemar_exact_p": 1.0, "gain_pp": 25.0})
        # 215 by hand: doubtful roles clinician d1 d3, empty d2, patient d4 -> weights .5/.25/.25. arm1 right d1,d4 -> .5*.5+.25*0+.25*1 = .5; arm3 right d1,d2,d3 -> .5*1+.25*1+.25*0 = .75
        self.assertEqual((v["role_weights"], v["weighted_acc_arm1"], v["weighted_acc_arm"], v["gain_pp_weighted"]), ({"clinician": 0.5, "empty": 0.25, "patient": 0.25}, 0.5, 0.75, 25.0))
        self.assertEqual((a3["confident_sample"]["n"], a3["confident_sample"]["flipped_right_to_wrong"], a3["confident_sample"]["would_have_changed"]), (2, 2, 2)); self.assertEqual(a3["pass_bar"]["F4_status"], "INSUFFICIENT")
        self.assertEqual(a3["escalated_share"], round(4 / 6, 4)); self.assertEqual(a3["cost"]["audio_hours"], 1.5); self.assertEqual(a3["cost"]["call_seconds_per_audio_hour"], round(12.0 / 1.5, 3))
        self.assertEqual(r["arm1_empty_role"], {"not_doctor_turns": 3, "not_doctor_with_empty_role": 1})
        self.assertEqual((r["freeze_sha12"], r["addendum_sha12"], r["addendum166_sha12"], r["combine_rule_sha256"]), ("b961291ae64c", "9c335c59c5be", "87b8cdac4330", RSHA))
        c = a3["pass_bar"]["criteria"]                                       # F1 fails (4 < 60), F3 fails (p=1), F4 fails (2 flips), F5 not run
        self.assertEqual(c, {"F1_n_doubtful_with_truth>=60": False, "F2_weighted_gain>=5pp_and_unweighted_same_sign": True, "F3_mcnemar_p<0.05_unweighted": False, "F4_zero_confident_flips_n>=30": False, "F5_stability": False})
        self.assertFalse(a3["pass_bar"]["meets_pass_bar"])
    def test_missing_counted(self):
        self.w("arm3.jsonl", [{"turn_id": "d1", "arm": 3, "q1": {"choice": "doctor", "confidence": .9}}])            # d2, d3, d4 never run
        a3 = self.run_score()["arms"]["arm3"]; self.assertEqual((a3["missing_n"], a3["errors_n"], a3["doubtful"]["correct"]), (3, 0, 1))
    def test_vpilot_with_and_without(self):
        rows = [{"turn_id": t, "source": "v_existing", "labels": {"V": l}} for t, l in [("d1", "doctor"), ("d2", "doctor"), ("d3", "staff"), ("c1", "doctor"), ("c2", "patient")]]
        rows.append({"turn_id": "d4", "source": "vpilot_voice_verified", "is_doctor": False})              # only d4 comes from the +22 source
        self.w("truth.jsonl", rows)
        r = self.run_score(); w = r["without_vpilot_voice_verified"]
        self.assertEqual((r["truth"]["usable_by_source"], r["arms"]["arm3"]["doubtful"]["n"]), ({"v_existing": 5, "vpilot_voice_verified": 1}, 4))
        self.assertEqual((w["truth"]["usable_by_source"], w["arms"]["arm3"]["doubtful"]["n"], w["truth"]["excluded_sources"]), ({"v_existing": 5}, 3, ["vpilot_voice_verified"]))
        self.assertTrue(os.path.exists(f"{self.tmp}/out/SUMMARY_without_vpilot.md"))
        self.assertEqual(r["arms"]["arm1"]["doubtful"]["n"], 4); self.assertEqual(w["arms"]["arm1"]["doubtful"]["n"], 3)
    def test_pinned_weights_used_and_stamped(self):
        pin = f"{self.tmp}/role_shares.json"
        with open(pin, "w") as f: json.dump({"all_pool_doubtful": {"n": 100, "counts": {"empty": 90, "clinician": 10}, "shares": {"empty": 0.9, "clinician": 0.1}}}, f)
        r = self.run_score(["--role-weights", pin]); v = r["arms"]["arm3"]["vs_arm1_doubtful"]
        self.assertEqual(v["role_weights"], {"clinician": 0.1, "empty": 0.9})                              # the pinned shares, not the arm 1 file's 0.5/0.25/0.25
        self.assertEqual((r["f2_role_weights_source"]["file"], r["f2_role_weights_source"]["shares"]), ("role_shares.json", {"empty": 0.9, "clinician": 0.1}))
        self.assertEqual(v["roles_without_labelled_turns"], [])                                            # both pinned roles have labelled turns here
        self.assertIn("weights role_shares.json@", open(f"{self.tmp}/out/SUMMARY.md").read())
        self.assertIn("NOT PINNED", json.dumps(self.run_score()["f2_role_weights_source"]))                # without the flag it says so
    def test_stale_rows_excluded_from_cost_and_missing(self):
        old = {"turn_id": "gone1", "arm": 3, "q1": {"choice": "doctor", "confidence": .9}, "usage": {"input_tokens": 5000, "output_tokens": 10}, "latency_s": 9.0}   # id not in arm1: an earlier hand-off
        dup = {"turn_id": "d1", "arm": 3, "q1": {"choice": "patient", "confidence": .9}, "usage": {"input_tokens": 5000, "output_tokens": 10}, "latency_s": 9.0}     # superseded by the later d1 row
        rows = C.read_jsonl(f"{self.tmp}/arm3.jsonl"); self.w("arm3.jsonl", [old, dup] + rows)
        a3 = self.run_score()["arms"]["arm3"]
        self.assertEqual(a3["stale_rows_excluded"], 2); self.assertEqual((a3["cost"]["tokens_in"], a3["cost"]["call_seconds_total"]), (600, 12.0))   # only the 6 current rows count
        self.assertEqual(a3["doubtful"]["correct"], 3)                                                                                             # d1 is the later (doctor .9) row
    def test_cards_define_current_run(self):
        self.w("cards.jsonl", [{"turn_id": t, "window_id": "w"} for t in ("d1", "d2", "d3", "d4")])            # c1, c2 exist in arm1 but have no card in this hand-off
        a3 = self.run_score(["--cards", f"{self.tmp}/cards.jsonl"])["arms"]["arm3"]
        self.assertEqual(a3["stale_rows_excluded"], 2); self.assertEqual(a3["cost"]["tokens_in"], 400)         # c1, c2 rows are not part of the current run
        self.assertEqual(a3["confident_sample"]["n"], 0)                                                       # so the confident sample has nothing to judge
    def test_split_stale_moves_and_keeps(self):
        rows = C.read_jsonl(f"{self.tmp}/arm3.jsonl"); self.w("arm3.jsonl", [{"turn_id": "gone1", "arm": 3}] + rows)
        self.w("cards.jsonl", [{"turn_id": t, "window_id": "w"} for t in ("d1", "d2", "d3", "d4", "c1", "c2")])
        r = subprocess.run([sys.executable, os.path.join(HERE, "split_stale.py"), "--cards", f"{self.tmp}/cards.jsonl", f"{self.tmp}/arm3.jsonl"], capture_output=True, text=True)
        self.assertIn("moved to", r.stdout, r.stderr[-300:]); self.assertEqual(len(C.read_jsonl(f"{self.tmp}/arm3.jsonl")), 6); self.assertEqual(C.read_jsonl(f"{self.tmp}/arm3.jsonl.stale.jsonl"), [{"turn_id": "gone1", "arm": 3}])
        self.w("arm3.jsonl", [{"turn_id": "gone2", "arm": 3}] + C.read_jsonl(f"{self.tmp}/arm3.jsonl"))                                            # a second pass appends, never overwrites
        subprocess.run([sys.executable, os.path.join(HERE, "split_stale.py"), "--cards", f"{self.tmp}/cards.jsonl", f"{self.tmp}/arm3.jsonl"], check=True, capture_output=True)
        self.assertEqual([x["turn_id"] for x in C.read_jsonl(f"{self.tmp}/arm3.jsonl.stale.jsonl")], ["gone1", "gone2"])
    def test_weighting_rules(self):
        c = lambda gw, gu, p=0.01, b=9, cc=1: S.win_criteria({"gain_pp_weighted": gw, "gain_pp": gu, "mcnemar_exact_p": p, "arm_right_arm1_wrong": b, "arm_wrong_arm1_right": cc})
        self.assertEqual(c(6, 2), {"F2": True, "F3": True})
        self.assertFalse(c(4.9, 10)["F2"])           # weighted below 5 pp fails even if unweighted looks great
        self.assertFalse(c(6, -1)["F2"])             # weighted passes but unweighted has the opposite sign
        self.assertFalse(c(6, 0)["F2"])              # zero unweighted difference is not the same (positive) sign
        self.assertFalse(c(None, 5)["F2"]); self.assertFalse(c(6, 5, p=0.2)["F3"]); self.assertFalse(c(6, 5, b=1, cc=9)["F3"])
        # weighted accuracy: 50/50 role weights, but the labelled sample is 8 'empty' turns (2 right) and 2 'clinician' turns (2 right)
        rows = [{"stratum": "empty", "x": i < 2} for i in range(8)] + [{"stratum": "clinician", "x": True}] * 2
        wa, miss = S.weighted_acc(rows, "x", {"empty": .5, "clinician": .5})
        self.assertAlmostEqual(wa, .5 * .25 + .5 * 1.0); self.assertEqual(miss, [])
        wa, miss = S.weighted_acc(rows, "x", {"empty": .5, "clinician": .25, "patient": .25}); self.assertEqual(miss, ["patient"]); self.assertAlmostEqual(wa, (.5 * .25 + .25) / .75)
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
        st = S.stability(3, a1, truth, outs, rq, rule, S.role_weights(list(a1.values())))
        W = S.role_weights(list(a1.values()))
        sm = S.summarize(3, S.score_turns(3, a1, truth, outs, rule), 1.0, outs, {}, st, W)
        self.assertEqual(sm["vs_arm1_doubtful"]["arm_right_arm1_wrong"], 25); self.assertEqual(sm["vs_arm1_doubtful"]["arm_wrong_arm1_right"], 10)
        self.assertTrue(sm["pass_bar"]["meets_pass_bar"], sm["pass_bar"]); self.assertEqual(sm["pass_bar"]["status"], "ADOPTABLE")
        outs["c0"] = {"turn_id": "c0", "q1": {"choice": "patient", "confidence": .9}}          # one confident flip kills it
        sm = S.summarize(3, S.score_turns(3, a1, truth, outs, rule), 1.0, outs, {}, st, W)
        self.assertFalse(sm["pass_bar"]["meets_pass_bar"]); self.assertEqual((sm["pass_bar"]["F4_status"], sm["pass_bar"]["status"]), ("FAIL", "NOT_ADOPTED"))
        outs["c0"] = {"turn_id": "c0", "q1": {"choice": "doctor", "confidence": .9}}
        for i in range(12): del a1[f"c{i}"]; del truth[f"c{i}"]                                             # only 28 confident human-labelled turns: F4 needs >= 30
        sm = S.summarize(3, S.score_turns(3, a1, truth, outs, rule), 1.0, outs, {}, st, W)
        self.assertEqual((sm["confident_sample"]["n"], sm["pass_bar"]["F4_status"], sm["pass_bar"]["meets_pass_bar"], sm["pass_bar"]["status"]), (28, "INSUFFICIENT", False, "CONTINUE_ONLY (F4 insufficient)"))


class TestRequeryGuard(unittest.TestCase):
    def test_refuses_without_refuter_flag(self):                      # ruling 248
        r = subprocess.run(["bash", os.path.join(HERE, "run_requery.sh"), "/dev/null", tempfile.mkdtemp()], capture_output=True, text=True, env={**os.environ, "VJ_REFUTER": ""})
        self.assertEqual(r.returncode, 2); self.assertIn("ruling 248", r.stdout)


class TestResumeAndPaths(unittest.TestCase):
    def test_changed_card_reruns_and_same_card_resumes(self):
        d = tempfile.mkdtemp(); card = lambda txt: {"turn_id": "t1", "window_id": "w", "doctor_name": "Dr A", "card_text": txt, "raw_text": txt}
        a1 = f"{d}/arm1.jsonl"
        with open(a1, "w") as f: f.write(json.dumps({"turn_id": "t1", "window_id": "w", "role": "", "margin": None, "best": None, "speaker_basis": "voice_match"}) + "\n")
        run = lambda txt: (open(f"{d}/cards.jsonl", "w").write(json.dumps(card(txt)) + "\n"), subprocess.run([sys.executable, os.path.join(HERE, "arm_jev.py"), "--arm", "3", "--in", f"{d}/cards.jsonl", "--out", f"{d}/o.jsonl",
                    "--backend", "mock", "--arm1", a1, "--select", "doubtful"], capture_output=True, text=True).stdout)[1]
        self.assertIn("1 run, 0 resumed", run("Turn: card version one"))
        self.assertIn("0 run, 1 resumed", run("Turn: card version one"))       # identical card: resumed
        self.assertIn("1 run, 0 resumed", run("Turn: card version TWO"))       # re-rendered card: re-run
    def test_relative_clip_path_resolved(self):
        d = tempfile.mkdtemp(); os.makedirs(f"{d}/clips")
        subprocess.run([G.ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=12", f"{d}/clips/t1.wav"], check=True)
        with open(f"{d}/clips.jsonl", "w") as f: f.write(json.dumps({"turn_id": "t1", "window_id": "w", "audio_path": "clips/t1.wav", "turn_start_s": 4.0, "turn_end_s": 7.0, "window_start_s": 0.0, "window_end_s": 12.0}) + "\n")
        r = subprocess.run([sys.executable, os.path.join(HERE, "arm4_gemini.py"), "--in", f"{d}/clips.jsonl", "--out", f"{d}/o.jsonl", "--backend", "mock", "--clip-dir", f"{d}/cut", "--select", "all"], capture_output=True, text=True)
        self.assertIn("0 errors", r.stdout, r.stderr[-300:]); rows = C.read_jsonl(f"{d}/o.jsonl"); self.assertEqual({x["kind"] for x in rows}, {"l1", "l2"}); self.assertTrue(all("input_sha12" in x for x in rows))


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
