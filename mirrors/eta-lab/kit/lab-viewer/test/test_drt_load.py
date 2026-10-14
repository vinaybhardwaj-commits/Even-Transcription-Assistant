import json, shutil, subprocess, sys, tempfile, hashlib, unittest
from pathlib import Path
SRC = Path.home() / "eta-data/drtpqma/2026-09-29"
TOOL = Path(__file__).resolve().parents[1] / "tools/drt_load.py"

def run(d, drt="", enc="", tap="", *x):
    return subprocess.run([sys.executable, str(TOOL), "--date", "2026-09-29", "--dir", str(d), "--drt-sha", drt, "--enc-sha", enc, "--tapes-sha", tap, *x], capture_output=True, text=True)

@unittest.skipUnless((SRC / "drt.json").exists(), "linker's 29 Sep files not on this box")
class T(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        for n in ("drt.json", "encounters.json", "tapes.json"):
            shutil.copy(SRC / n, self.d / n)
        h = lambda n: hashlib.sha256((self.d / n).read_bytes()).hexdigest()
        self.a = (h("drt.json")[:8], h("encounters.json")[:8], h("tapes.json")[:12])
    def tearDown(self): shutil.rmtree(self.d)
    def test_ok_and_dry(self):
        r = run(self.d, *self.a); self.assertEqual(r.returncode, 0, r.stderr); self.assertIn("nothing written", r.stdout)
    def test_wrong_sha(self):
        self.assertEqual(run(self.d, "deadbeef", self.a[1], self.a[2]).returncode, 1)
    def test_audio_on_held(self):
        p = self.d / "drt.json"; d = json.loads(p.read_text())
        d["encounters"][0]["room_source"] = "held_out"; p.write_text(json.dumps(d))
        r = run(self.d, hashlib.sha256(p.read_bytes()).hexdigest()[:8], self.a[1], self.a[2]); self.assertEqual(r.returncode, 1); self.assertIn("held-out", r.stderr)
    def test_bad_key(self):
        p = self.d / "drt.json"; d = json.loads(p.read_text())
        d["encounters"][0]["audio"][0]["key"] = "results/x.webm"; p.write_text(json.dumps(d))
        self.assertEqual(run(self.d, hashlib.sha256(p.read_bytes()).hexdigest()[:8], self.a[1], self.a[2]).returncode, 1)
    def test_apply_without_token_refuses(self):
        import os
        env = {k: v for k, v in os.environ.items() if k != "CLOUDFLARE_API_TOKEN"}
        if (Path.home() / ".claude/secrets/cloudflare_api_token").exists(): self.skipTest("token file present")
        r = subprocess.run([sys.executable, str(TOOL), "--date", "2026-09-29", "--dir", str(self.d), "--drt-sha", self.a[0], "--enc-sha", self.a[1], "--tapes-sha", self.a[2], "--apply"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 1)
if __name__ == "__main__": unittest.main()
