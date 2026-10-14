"""Tests for lang_judge.py on INVENTED data with a stub transport (no network, no key)."""
import json, os, subprocess, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lang_judge as J


def reply(fg, switch=False, model=J.MODEL, provider="Google", bg="none"):
    return 200, {"model": model, "provider": provider, "choices": [{"message": {"content": json.dumps({"foreground_lang": fg, "switch": switch, "background": bg})}}]}


def tone(path, s=2):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={s}", "-ar", "16000", "-ac", "1", path], check=True)


class T(unittest.TestCase):
    def setUp(self):
        J._sleep = lambda s: None

    def test_truth_label(self):
        self.assertEqual(J.truth_label({"kind": "dialogue", "events": [{"lang": "hi"}]}), "hi")
        self.assertEqual(J.truth_label({"kind": "dialogue", "events": [{"lang": "hi-en"}]}), "hi")       # English words inside a Hindi sentence: still hi
        self.assertEqual(J.truth_label({"kind": "dialogue", "events": [{"lang": "kn-en"}]}), "kn")
        self.assertEqual(J.truth_label({"kind": "dialogue", "events": [{"lang": "hi"}, {"lang": "en"}]}), "mixed")
        self.assertEqual(J.truth_label({"kind": "silence", "events": [{}]}), "none")
        self.assertIsNone(J.truth_label({"kind": "dialogue", "events": [{"lang": "fr"}]}))

    def test_truth_uses_only_the_judged_part(self):
        ev = [{"lang": "hi", "start_ms": 1000}, {"lang": "en", "start_ms": 40000}]
        self.assertEqual(J.truth_label({"kind": "dialogue", "events": ev}), "hi")

    def test_condition_of(self):
        self.assertEqual(J.condition_of("dlg_en_2"), "clean"); self.assertEqual(J.condition_of("dlg_en_2__fan_snr10"), "fan10")
        self.assertEqual(J.condition_of("dlg_en_2__babble_snr5"), "babble5")

    def test_gate_applies_inside_each_condition(self):
        rows = [dict(id="a%d" % i, truth="en", label="en", condition="clean") for i in range(5)] + [dict(id="b%d" % i, truth="en", label="en" if i else "hi", condition="fan10") for i in range(5)]
        r = J.report(rows); self.assertFalse(r["usable"]); self.assertFalse(r["per_condition"]["fan10"]["usable"]); self.assertTrue(r["per_condition"]["clean"]["usable"])

    def test_resume_refuses_a_different_prompt(self):
        d = tempfile.mkdtemp(); tone(d + "/a.wav"); os.makedirs(d + "/out")
        open(d + "/out/judged.jsonl", "w").write(json.dumps(dict(id="a", label="en", prompt_sha256="0" * 64)) + "\n")
        with self.assertRaises(SystemExit):
            J.run_judged([dict(id="a", audio=d + "/a.wav")], d + "/out", lambda b: reply("en"), d)

    def test_parse_label(self):
        self.assertEqual(J.parse_label(reply("kn", bg="hi")[1]), ("kn", "hi"))
        self.assertEqual(J.parse_label(reply("hi", switch=True, bg="none")[1]), ("mixed", "none"))
        self.assertIsNone(J.parse_label(reply("french")[1]))
        self.assertIsNone(J.parse_label(reply("kn", bg="french")[1]))
        self.assertIsNone(J.parse_label(reply("mixed")[1]))                                                                 # v4: "mixed" is not a valid foreground_lang; only `switch` produces it
        self.assertIsNone(J.parse_label(reply("none", switch=True)[1]))                                                     # contradictory: switching with no foreground speech
        self.assertIsNone(J.parse_label({"choices": [{"message": {"content": json.dumps({"language": "kn"})}}]}))          # the v1/v2 single-field reply is no longer accepted
        self.assertIsNone(J.parse_label({"choices": [{"message": {"content": json.dumps({"foreground": "kn", "background": "none"})}}]}))  # the v3 two-field reply is no longer accepted (no `switch`)
        self.assertIsNone(J.parse_label({"choices": [{"message": {"content": "hi"}}]}))
        self.assertIsNone(J.parse_label({}))

    def test_switch_is_the_only_route_to_mixed(self):
        """v4's design point: mixed is derived from the explicit `switch` boolean, never chosen directly as a label."""
        self.assertEqual(J.parse_label(reply("en", switch=True, bg="hi")[1]), ("mixed", "hi"))
        self.assertEqual(J.parse_label(reply("en", switch=False, bg="hi")[1]), ("en", "hi"))
        self.assertNotIn("mixed", J.FG_LANGS)

    def test_background_language_never_changes_the_scored_label(self):
        d = tempfile.mkdtemp(); p = d + "/a.mp3"; tone(d + "/a.wav"); J.to_mp3(d + "/a.wav", p)
        r = J.judge_one(p, lambda b: reply("en", bg="hi"))
        self.assertEqual((r["label"], r["background"]), ("en", "hi"))

    def test_prompt_asks_foreground_only(self):
        for w in ("FOREGROUND", "Background voices NEVER", '"foreground_lang"', '"switch"', '"background"'):
            self.assertIn(w, J.PROMPT)

    def test_switch_covers_across_turn_switching(self):
        """eta-refuter-2 #4373: diar-lab's mixed generator alternates language PER TURN, so `switch` must cover
        switching ACROSS a speaker's own consecutive turns, not only within one turn."""
        self.assertIn("across their own consecutive turns", J.PROMPT)

    def test_route_mismatch_and_missing_provider(self):
        d = tempfile.mkdtemp(); p = d + "/a.mp3"; tone(d + "/a.wav"); J.to_mp3(d + "/a.wav", p)
        self.assertEqual(J.judge_one(p, lambda b: reply("en", model="other/model"))["status"], "route_mismatch")
        self.assertEqual(J.judge_one(p, lambda b: reply("en", provider=""))["status"], "route_mismatch")
        self.assertEqual(J.judge_one(p, lambda b: reply("en"))["label"], "en")

    def test_retry_then_ok_and_two_failures(self):
        d = tempfile.mkdtemp(); p = d + "/a.mp3"; tone(d + "/a.wav"); J.to_mp3(d + "/a.wav", p)
        seq = iter([(429, None), reply("ta")])
        self.assertEqual(J.judge_one(p, lambda b: next(seq))["label"], "ta")
        self.assertEqual(J.judge_one(p, lambda b: (400, None))["label"], "error")
        seq = iter([reply("xx"), reply("yy")])
        self.assertEqual(J.judge_one(p, lambda b: next(seq))["status"], "bad_reply")

    def test_request_is_the_frozen_route(self):
        b = J.request_body("QUJD")
        self.assertEqual((b["model"], b["temperature"], b["provider"]), (J.MODEL, 0, {"zdr": True, "data_collection": "deny", "allow_fallbacks": False}))
        self.assertEqual(b["messages"][0]["content"][1]["input_audio"]["format"], "mp3")
        self.assertNotIn("Authorization", json.dumps(b))

    def test_report_gate(self):
        rows = [dict(id=str(i), truth="hi", label="hi") for i in range(5)] + [dict(id="e%d" % i, truth="en", label="en") for i in range(5)]
        r = J.report(rows); self.assertTrue(r["usable"])
        rows[0]["label"] = "en"                                    # hi 4/5 = 80% < 90%
        r = J.report(rows); self.assertFalse(r["usable"]); self.assertIn("hi", r["labels_below_gate"])
        few = [dict(id="a", truth="hi", label="hi")] * 3           # n<5: gate not met
        self.assertFalse(J.report(few)["usable"])
        self.assertFalse(J.report([dict(id="x", truth="hi", label="error")] * 5)["usable"])

    def test_resume_skips_done_and_logs_no_text(self):
        d = tempfile.mkdtemp(); tone(d + "/a.wav"); tone(d + "/b.wav")
        items = [dict(id="a", audio=d + "/a.wav"), dict(id="b", audio=d + "/b.wav")]
        calls = []
        def send(b): calls.append(1); return reply("en")
        J.run_judged(items[:1], d + "/out", send, d)
        got = J.run_judged(items, d + "/out", send, d)
        self.assertEqual(len(calls), 2); self.assertEqual(set(got), {"a", "b"})
        self.assertEqual(oct(os.stat(d + "/out/judged.jsonl").st_mode & 0o777), "0o600")
        self.assertEqual(set(json.loads(open(d + "/out/judged.jsonl").readline())), {"id", "label", "background", "status", "model", "provider", "prompt_sha256"})

    def test_long_window_refused(self):
        d = tempfile.mkdtemp(); tone(d + "/a.wav", 40)
        json.dump(dict(id="a", audio=d + "/a.wav"), open(d + "/m.jsonl", "w"))
        os.environ["OPENROUTER_API_KEY"] = "stub"
        with self.assertRaises(SystemExit):
            J.main(["window", "--manifest", d + "/m.jsonl", "--out", d + "/o"])


if __name__ == "__main__":
    unittest.main()
