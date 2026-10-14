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


if __name__ == "__main__":
    unittest.main()
