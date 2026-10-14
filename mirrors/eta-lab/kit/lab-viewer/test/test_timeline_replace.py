"""timeline_seed.py load --replace safety (eta-refuter-2 #8105 F1/F2) with a fake `npx wrangler` backed by a directory. Run: python3 test/test_timeline_replace.py"""
import hashlib, json, os, stat, subprocess, sys, tempfile, unittest
from pathlib import Path
TOOLS = Path(__file__).resolve().parents[1] / "tools"
FAKE = '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
a = sys.argv[1:]                       # wrangler r2 object get|put BUCKET/KEY ...
op, bk = a[3], a[4]; store = Path(os.environ["FAKE_R2"]); p = store / bk.replace("/", "__")
if op == "get":
    n = int(os.environ.get("FAKE_GET_OK", "999"));  cf = store / "_gets"; c = int(cf.read_text()) if cf.exists() else 0; cf.write_text(str(c + 1))
    if c >= n: sys.stderr.write("network error"); sys.exit(1)
    if not p.exists(): sys.stderr.write("The specified key does not exist."); sys.exit(1)
    sys.stdout.buffer.write(p.read_bytes())
else:
    p.write_bytes(Path(a[a.index("--file") + 1]).read_bytes())
'''

class T(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp()); (self.t / "bin").mkdir(); (self.t / "r2").mkdir(); (self.t / "d" / "timeline" / "room_x").mkdir(parents=True)
        f = self.t / "bin" / "npx"; f.write_text(FAKE); f.chmod(0o755)
        self.live = json.dumps({"schema": 1, "old": True}).encode()
        (self.t / "r2" / "eta-lab-ratings__timeline__room_x__2026-09-25.json").write_bytes(self.live)
        (self.t / "d/timeline/room_x/2026-09-25.json").write_text(json.dumps({"schema": 1, "new": True}))
    def run_load(self, sidecar=None, get_ok=None):
        if sidecar is not None: (self.t / "d/timeline/room_x/2026-09-25.livesha").write_text(sidecar)
        env = {**os.environ, "PATH": f"{self.t/'bin'}:{os.environ['PATH']}", "FAKE_R2": str(self.t / "r2")}
        if get_ok is not None: env["FAKE_GET_OK"] = str(get_ok)
        return subprocess.run([sys.executable, str(TOOLS / "timeline_seed.py"), "load", "--dir", str(self.t / "d"), "--replace"], capture_output=True, text=True, env=env)
    def live_now(self): return (self.t / "r2" / "eta-lab-ratings__timeline__room_x__2026-09-25.json").read_bytes()
    def archives(self): return [p for p in (self.t / "r2").iterdir() if "timeline-history" in p.name]
    def test_ok_archives_then_replaces(self):
        r = self.run_load(sidecar=hashlib.sha256(self.live).hexdigest()); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.archives()), 1); self.assertEqual(self.archives()[0].read_bytes(), self.live); self.assertIn(b"new", self.live_now())
    def test_failed_second_get_refuses_and_keeps_live(self):   # F2: exists() get ok (1st), archive get fails (2nd)
        r = self.run_load(get_ok=1); self.assertNotEqual(r.returncode, 0); self.assertEqual(self.live_now(), self.live); self.assertEqual(self.archives(), [])
    def test_archive_readback_failure_keeps_live(self):        # gets: exists ok, old ok, archive read-back fails
        r = self.run_load(get_ok=2); self.assertNotEqual(r.returncode, 0); self.assertEqual(self.live_now(), self.live)
    def test_live_changed_since_merge_refuses(self):           # F1
        r = self.run_load(sidecar="0" * 64); self.assertNotEqual(r.returncode, 0); self.assertIn("changed in R2", r.stderr); self.assertEqual(self.live_now(), self.live); self.assertEqual(self.archives(), [])
if __name__ == "__main__": unittest.main()
