"""kit/lab-vault/check-copies.py against a stub inventory Worker and a fake `ssh` (the Mini). Run: python3 -m unittest discover -s test"""
import hashlib, http.server, json, os, stat, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

CHECK = Path(__file__).resolve().parents[1] / "check-copies.py"
RUN = "hist-miner-20260924T1845-0186177"


class Inv(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        prefix = self.path.split("prefix=")[1].split("&")[0]
        objs = [{"key": k, "size": 1, "sha256": v} for k, v in self.server.vault.items() if k.startswith(prefix)]
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({"objects": objs, "truncated": False, "cursor": None}).encode())
    def log_message(self, *a): pass


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()); self.home = self.tmp / "home"
        self.hist_mining = self.home / "eta-data/hist-mining"
        f = self.hist_mining / "runs" / RUN / "room_x/2026-09-15/w1.json"
        f.parent.mkdir(parents=True); f.write_text('{"a":1}'); os.utime(f, (time.time() - 3 * 3600,) * 2)
        self.file, self.key = f, f"runs/{RUN}/room_x/2026-09-15/w1.json"
        self.sha = hashlib.sha256(f.read_bytes()).hexdigest()
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Inv); self.srv.vault = {self.key: self.sha}
        threading.Thread(target=self.srv.serve_forever, daemon=True).start(); self.addCleanup(self.srv.shutdown)
        (self.tmp / "tok").write_text("t" * 40)
        self.mini_lines = [f"{self.sha}  hist-mining/{self.key}"]
        (self.tmp / "bin").mkdir(); self.ssh = self.tmp / "bin/ssh"
        self.hsend = self.tmp / "hsend.sh"; self.hsend.write_text(f'#!/bin/zsh\nprintf "%s\\n" "$1" >> {self.tmp}/alerts.log\n')

    def run_check(self, *args):
        self.ssh.write_text("#!/bin/sh\ncat <<'EOF'\n" + "\n".join(self.mini_lines) + "\nEOF\n"); self.ssh.chmod(0o755)
        env = {**os.environ, "HOME": str(self.home), "PATH": f"{self.tmp}/bin:{os.environ['PATH']}", "LAB_VAULT_ROOTS": str(self.hist_mining),
               "LAB_INVENTORY_URL": f"http://127.0.0.1:{self.srv.server_port}", "LAB_INVENTORY_TOKEN_FILE": str(self.tmp / "tok"),
               "LAB_HSEND": str(self.hsend), "LAB_VAULT_REPORTS": str(self.tmp / "reports")}
        return subprocess.run([sys.executable, str(CHECK), *args], env=env, capture_output=True, text=True)

    def alerts(self):
        p = self.tmp / "alerts.log"; return p.read_text() if p.exists() else ""

    def test_new_layout_key_is_compared_on_the_mini_and_all_clear(self):  # the KeyError the refuter found
        r = self.run_check(); self.assertEqual(r.returncode, 0, r.stdout + r.stderr); self.assertIn('"mini_files_checked": 1', r.stdout); self.assertEqual(self.alerts(), "")

    def test_missing_on_mini_and_sha_mismatch_alert(self):
        self.mini_lines = []
        r = self.run_check(); self.assertEqual(r.returncode, 1); self.assertIn("not on Mini", r.stdout); self.assertIn("gap", self.alerts())
        self.mini_lines = ["0" * 64 + f"  hist-mining/{self.key}"]
        self.assertIn("SHA MISMATCH box vs Mini", self.run_check().stdout)

    def test_vault_gap_sha_and_extra(self):
        self.srv.vault[self.key] = "f" * 64
        self.assertIn("SHA MISMATCH box vs vault", self.run_check().stdout)
        del self.srv.vault[self.key]
        self.assertIn("in box, not in vault", self.run_check().stdout)
        self.srv.vault[self.key] = self.sha; self.srv.vault[f"runs/{RUN}/room_x/2026-09-15/ghost.json"] = "a" * 64
        self.assertIn("in vault, not in box", self.run_check().stdout)
        self.srv.vault[f"runs/vj-backfill-20260924/selftest/2026-09-24/t.json"] = "b" * 64; del self.srv.vault[f"runs/{RUN}/room_x/2026-09-15/ghost.json"]
        self.assertEqual(self.run_check().returncode, 0)  # selftest keys are ignored

    def test_accepted_exception_is_listed_not_alerted(self):
        del self.srv.vault[self.key]; self.mini_lines = []
        (self.tmp / "exc.json").write_text(json.dumps({self.key: "refused 422, write-once, cannot be fixed"}))
        os.environ["LAB_VAULT_EXCEPTIONS"] = str(self.tmp / "exc.json"); self.addCleanup(os.environ.pop, "LAB_VAULT_EXCEPTIONS")
        r = self.run_check(); self.assertEqual(r.returncode, 0, r.stdout); self.assertIn("accepted_exceptions", r.stdout)

    def test_recent_file_is_within_lag_not_a_gap(self):
        os.utime(self.file, None); del self.srv.vault[self.key]; self.mini_lines = []
        self.assertEqual(self.run_check().returncode, 0)

    def test_crash_alerts_and_exits_nonzero(self):
        env_bad = self.srv.server_port; self.srv.shutdown()
        r = self.run_check(); self.assertEqual(r.returncode, 2); self.assertIn("CRASHED", self.alerts())

    def test_undelivered_alert_leaves_marker_and_exits_3(self):
        self.hsend.write_text("#!/bin/zsh\nexit 1\n")
        self.srv.vault.clear()  # a real gap, so an alert is attempted
        os.utime(self.file, (time.time() - 3 * 3600,) * 2)
        r = self.run_check(); self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertTrue(any(p.name.startswith("ALERT-UNDELIVERED-") for p in (self.tmp / "reports").iterdir()))
        self.srv.shutdown()
        r = self.run_check(); self.assertEqual(r.returncode, 3)  # a crash whose alert is lost is also 3

    def test_transient_network_error_is_retried_but_dead_inventory_still_crashes(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cc", CHECK); cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)
        calls = {"n": 0}; real = cc.urllib.request.urlopen
        class R:
            def __enter__(s): return s
            def __exit__(s, *a): pass
            def read(s): return b'{"ok":1}'
        def flaky(req, timeout=0):
            calls["n"] += 1
            if calls["n"] < 3: raise cc.urllib.error.URLError("temporary failure in name resolution")
            return R()
        real_sleep = cc.time.sleep
        self.addCleanup(setattr, cc.urllib.request, "urlopen", real); self.addCleanup(setattr, cc.time, "sleep", real_sleep)
        cc.urllib.request.urlopen = flaky; cc.time.sleep = lambda s: None
        self.assertEqual(cc.fetch_json("http://x", "t"), {"ok": 1}); self.assertEqual(calls["n"], 3)
        calls["n"] = -99
        with self.assertRaises(cc.urllib.error.URLError): cc.fetch_json("http://x", "t", tries=2)
        def http401(req, timeout=0):
            calls["n"] += 1; raise cc.urllib.error.HTTPError("u", 401, "no", {}, None)
        calls["n"] = 0; cc.urllib.request.urlopen = http401
        with self.assertRaises(cc.urllib.error.HTTPError): cc.fetch_json("http://x", "t")
        self.assertEqual(calls["n"], 1)  # a real HTTP error is not retried

    def test_unreachable_mini_is_a_gap(self):
        self.ssh.write_text("#!/bin/sh\necho 'ssh: connect timed out' >&2\nexit 255\n"); self.ssh.chmod(0o755)
        env = None
        self.mini_lines = []
        # run_check rewrites the fake ssh, so emulate failure through an unusable host instead
        r = subprocess.run([sys.executable, str(CHECK)], env={**os.environ, "HOME": str(self.home), "PATH": f"{self.tmp}/bin:{os.environ['PATH']}", "LAB_VAULT_ROOTS": str(self.hist_mining),
                            "LAB_INVENTORY_URL": f"http://127.0.0.1:{self.srv.server_port}", "LAB_INVENTORY_TOKEN_FILE": str(self.tmp / "tok"), "LAB_HSEND": str(self.hsend), "LAB_VAULT_REPORTS": str(self.tmp / "reports")}, capture_output=True, text=True)
        self.assertEqual(r.returncode, 1); self.assertIn("mini unreachable", r.stdout)


if __name__ == "__main__":
    unittest.main()
