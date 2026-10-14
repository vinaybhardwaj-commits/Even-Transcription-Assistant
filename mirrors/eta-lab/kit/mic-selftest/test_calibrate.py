"""Offline tests for calibrate.py (ruling 369 item 1): the threshold comes from labelled stretches of tape and must separate them."""
import contextlib, io, json, os, random, shutil, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calibrate as C
import mic_selftest as M

SR = M.SR


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

    def spec(self, empty_sigma=0.002, used_sigma=0.03):
        return dict(source="synthetic", stretches=[
            dict(file=self.tape("e.pcm", 60, empty_sigma), label="empty", room="opd4"),
            dict(file=self.tape("u.pcm", 60, used_sigma, 2), label="used", room="opd3")])

    def test_threshold_sits_above_the_empty_room_and_below_the_used_room(self):
        cal = C.calibrate(self.spec())
        self.assertEqual(cal["status"], "preregistered")
        empty_max = max(C.frame_rms(pcm(60, 0.002, 1)))
        self.assertAlmostEqual(cal["dead_rms_max"], 1.25 * empty_max, places=5)
        self.assertLess(cal["dead_rms_max"], C.pct(C.frame_rms(pcm(60, 0.03, 2)), 1))
        self.assertGreater(cal["speech_rms"], cal["dead_rms_max"])

    def test_no_separation_writes_nothing(self):
        with self.assertRaises(ValueError):
            C.calibrate(self.spec(empty_sigma=0.02, used_sigma=0.021))

    def test_needs_both_labels_and_valid_labels(self):
        one = self.spec()
        one["stretches"] = one["stretches"][:1]
        with self.assertRaises(ValueError):
            C.calibrate(one)
        bad = self.spec()
        bad["stretches"][0]["label"] = "quiet"
        with self.assertRaises(ValueError):
            C.calibrate(bad)

    def test_from_to_select_the_stretch(self):
        p = os.path.join(self.d, "mix.pcm")
        with open(p, "wb") as f:
            f.write(pcm(30, 0.002, 1) + pcm(30, 0.05, 2))
        rms = C.frame_rms(C.read_stretch(dict(file=p, from_s=0, to_s=30)))
        self.assertEqual(len(rms), 30)
        self.assertLess(max(rms), 0.01)
        rms2 = C.frame_rms(C.read_stretch(dict(file=p, from_s=30)))
        self.assertGreater(min(rms2), 0.03)

    def test_output_loads_as_a_calibration_and_cli_writes_it(self):
        spec = self.spec()
        sp = os.path.join(self.d, "spec.json")
        with open(sp, "w") as f:
            json.dump(spec, f)
        out = os.path.join(self.d, "calibration.json")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out]), 0)
        cal, sha = M.load_calibration(out)
        self.assertEqual(cal["status"], "preregistered")
        self.assertEqual(len(sha), 64)
        bad = self.spec(empty_sigma=0.02, used_sigma=0.021)
        with open(sp, "w") as f:
            json.dump(bad, f)
        os.remove(out)
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(C.main([sp, "--out", out]), 1)
        self.assertFalse(os.path.exists(out))


if __name__ == "__main__":
    unittest.main()
