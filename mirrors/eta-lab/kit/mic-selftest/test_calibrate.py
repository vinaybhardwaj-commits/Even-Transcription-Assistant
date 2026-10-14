"""Offline tests for calibrate.py (ruling 369 item 1, eta-refuter #2118 item 1): the dead threshold comes from labelled stretches of TAPE, is reported per stretch, and is
'proposed' until it can be checked against an occupied ground-truth stretch."""
import contextlib, functools, io, json, os, random, shutil, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calibrate as C
import mic_selftest as M

SR = M.SR


@functools.lru_cache(maxsize=None)
def pcm(seconds, sigma, seed):
    r = random.Random(seed)
    return b"".join(int(max(-1, min(1, r.gauss(0, sigma))) * 32767).to_bytes(2, "little", signed=True) for _ in range(seconds * SR))


class Calibrate(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.d, True)

    def tape(self, name, seconds, sigma, seed=1):
        p = os.path.join(self.d, name)
        with open(p, "wb") as f:
            f.write(pcm(seconds, sigma, seed))
        return p

    def spec(self, empty_sigma=0.002, used_sigma=0.03, extra=()):
        st = [dict(file=self.tape("e.pcm", 300, empty_sigma), label="empty", room="opd4"), dict(file=self.tape("u.pcm", 300, used_sigma, 2), label="used", room="opd3")]
        return dict(source="synthetic", stretches=st + list(extra))

    def test_dead_threshold_is_1_10_x_the_highest_empty_window_level(self):
        cal = C.calibrate(self.spec())
        lv = C.window_levels(C.frame_rms(pcm(300, 0.002, 1)))
        self.assertAlmostEqual(cal["dead_rms_max"], 1.10 * max(lv), places=5)
        self.assertEqual((cal["dead_window_s"], cal["dead_quantile"]), (120, 0.90))
        empty_frames = C.frame_rms(pcm(300, 0.002, 1))
        self.assertAlmostEqual(cal["speech_rms"], 1.10 * max(empty_frames), places=5)
        self.assertGreater(cal["speech_rms"], cal["dead_rms_max"])

    def test_the_rule_fires_in_the_empty_room_and_never_in_the_occupied_ones(self):
        cal = C.calibrate(self.spec(extra=[dict(file=self.tape("q.pcm", 300, 0.006, 3), label="quiet", room="opd5")]))
        rows = {r["label"]: r for r in cal["stretches"]}
        self.assertEqual(rows["empty"]["dead_trigger_rate"], 1.0)
        self.assertEqual(rows["used"]["dead_trigger_rate"], 0.0)
        self.assertEqual(rows["quiet"]["dead_trigger_rate"], 0.0)

    def test_an_occupied_quiet_room_as_quiet_as_the_empty_one_refuses(self):
        clash = self.spec(extra=[dict(file=self.tape("q3.pcm", 300, 0.0021, 4), label="quiet")])
        with self.assertRaises(ValueError) as cm:
            C.calibrate(clash)
        self.assertIn("no separation", str(cm.exception))

    def test_unlabelled_stretches_are_reported_but_never_change_the_threshold(self):
        base = C.calibrate(self.spec())
        more = C.calibrate(self.spec(extra=[dict(file=self.tape("x.pcm", 300, 0.0021, 5), label="unlabelled", room="opd7")]))
        self.assertEqual(base["dead_rms_max"], more["dead_rms_max"])
        self.assertEqual(more["stretches"][-1]["label"], "unlabelled")
        self.assertGreater(more["stretches"][-1]["dead_trigger_rate"], 0.5)           # reported: this room would fire

    def test_without_an_occupied_stretch_only_a_proposal_with_a_warning_can_be_written(self):
        only_empty = dict(source="synthetic", stretches=[dict(file=self.tape("e.pcm", 300, 0.002), label="empty")])
        cal = C.calibrate(only_empty)
        self.assertEqual(cal["status"], "proposed")
        self.assertTrue(cal["warnings"])
        with self.assertRaises(ValueError):
            C.calibrate(only_empty, status="preregistered")
        with self.assertRaises(M.Refuse):                                              # and load_calibration refuses a proposal
            path = os.path.join(self.d, "p.json")
            with open(path, "w") as f:
                json.dump(cal, f)
            M.load_calibration(path)

    def test_needs_an_empty_stretch_and_valid_labels_and_enough_tape(self):
        with self.assertRaises(ValueError):
            C.calibrate(dict(stretches=[dict(file=self.tape("u.pcm", 300, 0.03), label="used")]))
        bad = self.spec()
        bad["stretches"][0]["label"] = "silent"
        with self.assertRaises(ValueError):
            C.calibrate(bad)
        short = dict(stretches=[dict(file=self.tape("s.pcm", 60, 0.002), label="empty"), dict(file=self.tape("u.pcm", 300, 0.03), label="used")])
        with self.assertRaises(ValueError):
            C.calibrate(short)                                                          # an empty stretch shorter than the 120 s window

    def test_from_to_select_the_stretch(self):
        p = os.path.join(self.d, "mix.pcm")
        with open(p, "wb") as f:
            f.write(pcm(30, 0.002, 1) + pcm(30, 0.05, 2))
        rms = C.frame_rms(C.read_stretch(dict(file=p, from_s=0, to_s=30)))
        self.assertEqual(len(rms), 30)
        self.assertLess(max(rms), 0.01)
        self.assertGreater(min(C.frame_rms(C.read_stretch(dict(file=p, from_s=30)))), 0.03)

    def test_a_stats_jsonl_stretch_reads_only_its_room_and_time_range(self):
        p = os.path.join(self.d, "stats.jsonl")
        with open(p, "w") as f:
            f.write(json.dumps(dict(room_id="room_a", started_at="2026-09-25T03:00:00.500Z", idx=0, seconds=4, rms=[0.1, 0.2, 0.3, 0.4], peak=[1, 1, 1, 1], exact_zero_seconds=0)) + "\n")
            f.write(json.dumps(dict(room_id="room_b", started_at="2026-09-25T03:00:00.500Z", idx=0, seconds=4, rms=[9, 9, 9, 9], peak=[1, 1, 1, 1], exact_zero_seconds=0)) + "\n")
            f.write(json.dumps(dict(room_id="room_a", started_at="2026-09-25T03:00:04.500Z", idx=1, seconds=4, rms=[0.5, 0.6, 0.7, 0.8], peak=[1, 1, 1, 1], exact_zero_seconds=0)) + "\n")
            f.write(json.dumps(dict(room_id="room_a", started_at="2026-09-25T04:00:00Z", error="decode failed")) + "\n")
        got = C.read_stats_series(dict(stats_jsonl=p, room_id="room_a", from_iso="2026-09-25T03:00:01Z", to_iso="2026-09-25T03:00:06Z"))
        self.assertEqual(got, [0.2, 0.3, 0.4, 0.5, 0.6])

    def test_cli_writes_proposed_by_default_and_preregistered_only_when_asked(self):
        spec = self.spec()
        sp = os.path.join(self.d, "spec.json")
        with open(sp, "w") as f:
            json.dump(spec, f)
        out = os.path.join(self.d, "calibration.json")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out]), 0)
        with open(out) as f:
            self.assertEqual(json.load(f)["status"], "proposed")
        with self.assertRaises(M.Refuse):
            M.load_calibration(out)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out, "--preregister"]), 0)
        cal, sha = M.load_calibration(out)
        self.assertEqual((cal["status"], len(sha)), ("preregistered", 64))
        bad = self.spec(empty_sigma=0.02, used_sigma=0.021)
        with open(sp, "w") as f:
            json.dump(bad, f)
        os.remove(out)
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out, "--preregister"]), 1)
        self.assertFalse(os.path.exists(out))


if __name__ == "__main__":
    unittest.main()
