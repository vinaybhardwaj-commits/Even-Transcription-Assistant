"""PHI on a box with a second account: the CLARITY and PRESCRIBE builds must write every dir 0700 and every file 0600 even under umask 002 (refuter-2 #4141). Synthetic inputs only.
Run: python3 kit/lab-viewer/test/test_seed_perms.py"""
import hashlib, importlib.util, json, os, shutil, stat, sys, tempfile, unittest, wave
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def modes(root):
    bad = []
    for p in [Path(root), *Path(root).rglob("*")]:
        m = stat.S_IMODE(p.stat().st_mode)
        if m & 0o077:
            bad.append((str(p.relative_to(root)) if p != Path(root) else ".", oct(m)))
    return bad


class Perms(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp()); self.old = os.umask(0o002)

    def tearDown(self):
        os.umask(self.old); shutil.rmtree(self.t, ignore_errors=True)

    def test_prescribe_build_is_private(self):
        m = load("prescribe_seed")
        scored, links = self.t / "s.jsonl", self.t / "l.jsonl"
        scored.write_text(json.dumps({"consult_id": "C1", "room": "room_x", "class": "CAPTURED", "basis": "b", "item_id": "i", "item_type": "drug", "term": "t", "score": 1.0, "matched": "m"}) + "\n")
        links.write_text(json.dumps({"consult_id": "C1", "span": ["2026-09-25T10:00:00+05:30", "2026-09-25T10:10:00+05:30"]}) + "\n")
        m.build(str(scored), str(links), str(self.t / "out"))
        self.assertEqual(modes(self.t / "out"), [])

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_clarity_build_is_private(self):
        m = load("clarity_seed")
        aud, pb = self.t / "aud", self.t / "pb"; aud.mkdir(); pb.mkdir()
        w = wave.open(str(aud / "L001.wav"), "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000); w.close()
        (aud / "MANIFEST.tsv").write_text("id\tk\tt0\tt1\tsha256\tduration\nL001\tk\t0\t1\tabc\t1.0\n")
        outs = {}
        for name, row in {"whisper": {"id": "L001", "ok": True, "text": "x"}, "sravaani": {"id": "L001", "ok": True, "text": "x"}, "indic-ctc": {"id": "L001", "skipped": "n"},
                          "whisper-lid": {"id": "L001", "ok": True, "detected_language": "english", "prob": 0.9, "top3": [["en", 0.9]]}}.items():
            (pb / f"{name}.jsonl").write_text(json.dumps(row) + "\n")
            outs[f"out/{name}.jsonl"] = {"sha256": hashlib.sha256((pb / f"{name}.jsonl").read_bytes()).hexdigest()}
        (pb / "PHASEB-MANIFEST.json").write_text(json.dumps({"outputs": outs}))
        (self.t / "seed.json").write_text(json.dumps({"rows": [{"id": "L001", "n": 1, "lang": "en"}]}))
        m.AUDIO, m.PB, m.SEED = aud, pb, self.t / "seed.json"
        m.AUDIO_MANIFEST_SHA = hashlib.sha256((aud / "MANIFEST.tsv").read_bytes()).hexdigest()
        m.build(str(self.t / "out"))
        self.assertEqual(modes(self.t / "out"), [])
        self.assertTrue((self.t / "out" / "clarity" / "audio" / "L001.webm").exists())


    def test_scorecard_build_validates_and_is_private(self):
        m = load("clarity_seed")
        ok = {"schema": 1, "run_id": "r", "prereg_sha256": "ab12cd34ef56", "old": "o", "new": "n", "rows": [{"lang": "hi", "cond": "all", "n": 4, "old": {"wer": 0.3}, "new": {"wer": 0.2}}]}
        f = self.t / "s1.json"; f.write_text(json.dumps(ok))
        m.build_scorecard(str(f), None, None, str(self.t / "out"))
        self.assertEqual(modes(self.t / "out"), [])
        self.assertEqual(json.loads((self.t / "out" / "clarity" / "scorecard.json").read_text())["s1"]["run_id"], "r")
        for bad in ({**ok, "prereg_sha256": ""}, {**ok, "rows": []}, {**ok, "rows": [{"lang": "xx", "cond": "all"}]},
                    {**ok, "rows": [{"lang": "hi", "cond": "all", "old": {"wer": 999}, "new": {}}]}, {**ok, "schema": 2}):
            f.write_text(json.dumps(bad))
            with self.assertRaises(SystemExit):
                m.build_scorecard(str(f), None, None, str(self.t / "out2"))
        s3 = {**ok, "rows": [{"lang": "hi", "n": 3, "old": {"wrong_pct": 5}, "new": {"wrong_pct": 3}}]}
        f.write_text(json.dumps(s3))
        with self.assertRaises(SystemExit):   # an S3 without the judge validation is refused
            m.build_scorecard(None, None, str(f), str(self.t / "out3"))
        j = lambda acc, usable, rows=s3["rows"]: {**s3, "rows": rows, "judge": {"model": "m", "validated_on": "st", "accuracy": acc, "usable": usable}}
        for bad in (j({"overall": 80, "per_lang": {"hi": 40}}, True),    # flag true against failing numbers
                    j({"overall": 96, "per_lang": {}}, True)):                                                                # a language in the rows with no proven accuracy
            f.write_text(json.dumps(bad))
            with self.assertRaises(SystemExit):
                m.build_scorecard(None, None, str(f), str(self.t / "out4"))
        # judge-only S3 (no router rows yet) loads only while the judge is marked not usable
        f.write_text(json.dumps(j({"overall": 96, "per_lang": {"hi": 91}}, False, rows=[])))
        m.build_scorecard(None, None, str(f), str(self.t / "out7"))
        f.write_text(json.dumps(j({"overall": 96, "per_lang": {"hi": 91}}, True, rows=[])))
        with self.assertRaises(SystemExit):
            m.build_scorecard(None, None, str(f), str(self.t / "out8"))
        f.write_text(json.dumps({**ok, "rows": []}))
        with self.assertRaises(SystemExit):   # an S1 with no rows is still refused
            m.build_scorecard(str(f), None, None, str(self.t / "out9"))
        # F1 (refuter-2 #4339): once rows exist, kept_error_pct (top-level) is required, so every S3 number sits beside its kept-set error rate
        proven = j({"overall": 96, "per_lang": {"hi": 91}}, True)
        f.write_text(json.dumps(proven))
        with self.assertRaises(SystemExit):
            m.build_scorecard(None, None, str(f), str(self.t / "out5-missing"))
        f.write_text(json.dumps({**proven, "kept_error_pct": 8.1}))
        m.build_scorecard(None, None, str(f), str(self.t / "out5"))
        strict = j({"overall": 96, "per_lang": {"hi": 91}}, False)   # a stricter evaluator flag (e.g. min n per label) is honoured, not refused
        f.write_text(json.dumps({**strict, "kept_error_pct": 8.1}))
        m.build_scorecard(None, None, str(f), str(self.t / "out6"))
        f.write_text(json.dumps({**proven, "kept_error_pct": "high"}))   # kept_error_pct must be a number 0..100
        with self.assertRaises(SystemExit):
            m.build_scorecard(None, None, str(f), str(self.t / "out5-bad"))
        self.assertEqual(modes(self.t / "out5"), [])


if __name__ == "__main__":
    unittest.main()
