"""Ledger behaviour of kit/vault-push.py against a stub ingest server. Run: python3 -m unittest discover -s test"""
import http.server, json, os, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path

PUSH = Path(__file__).resolve().parents[2] / "vault-push.py"
RUN = "hist-bulk-20260924T1912-ab12cd3"


class Stub(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        srv = self.server
        srv.requests.append((self.path, self.headers.get("Authorization"), body))
        assert "urllib" not in self.headers.get("User-Agent", "urllib")  # Cloudflare 403s the default UA
        code, out = srv.responder(self.path, body)
        self.send_response(code); self.end_headers(); self.wfile.write(json.dumps(out).encode())
    def log_message(self, *a): pass


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "root"; self.state = self.tmp / "state"
        (self.tmp / "tok").write_text("secret-token-value\n"); os.chmod(self.tmp / "tok", 0o600)
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Stub); self.srv.requests = []; self.srv.store = {}
        self.srv.responder = self.ok_responder
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.shutdown)

    def ok_responder(self, path, body):
        key = path[len("/v1/obj/"):]
        if key in self.srv.store:
            return (200, {"status": "identical"}) if self.srv.store[key] == body else (409, {"existing_sha256": "e" * 64})
        self.srv.store[key] = body
        return 201, {"status": "created"}

    def mk(self, name="w1", text="{}"):
        p = self.root / "runs" / RUN / "room_x" / "2026-09-24" / f"{name}.json"
        p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
        os.utime(p, (time.time() - 60, time.time() - 60))
        return p

    def push(self, *args):
        env = {**os.environ, "LAB_INGEST_URL": f"http://127.0.0.1:{self.srv.server_port}", "LAB_INGEST_TOKEN_FILE": str(self.tmp / "tok"),
               "LAB_VAULT_STATE": str(self.state), "LAB_VAULT_ROOTS": str(self.root)}
        return subprocess.run([sys.executable, str(PUSH), *args], env=env, capture_output=True, text=True)

    def test_push_once_then_ledger_skips(self):
        p = self.mk()
        r = self.push("--path", str(p)); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.push("--scan").returncode, 0)
        self.assertEqual(len(self.srv.requests), 1)  # never double-pushed
        self.assertEqual(self.srv.requests[0][0], f"/v1/obj/runs/{RUN}/room_x/2026-09-24/w1.json")
        self.assertNotIn("secret-token-value", r.stdout + r.stderr)

    def test_failure_stays_pending_and_is_retried(self):
        p = self.mk()
        self.srv.responder = lambda *a: (503, {"error": "down"})
        self.assertEqual(self.push("--path", str(p)).returncode, 1)
        self.assertIn('"pending": 1', self.push("--status").stdout)
        self.srv.responder = self.ok_responder
        self.assertEqual(self.push("--scan").returncode, 0)
        self.assertEqual(len(self.srv.store), 1)

    def test_connection_error_stays_pending(self):
        p = self.mk(); self.srv.shutdown(); self.srv.server_close()
        r = self.push("--path", str(p)); self.assertEqual(r.returncode, 1)
        self.assertIn('"ledger_keys": 0', r.stdout)

    def test_409_alerts_never_silent(self):
        p = self.mk(text='{"a":1}'); self.assertEqual(self.push("--path", str(p)).returncode, 0)
        p.write_text('{"a":2}'); os.utime(p, (time.time() - 60,) * 2)
        r = self.push("--scan"); self.assertEqual(r.returncode, 3)
        self.assertIn("CONFLICT", r.stderr); self.assertIn("CONFLICT", (self.state / "ALERTS.log").read_text())
        self.assertEqual(self.push("--status").returncode, 3)  # stays visible

    def test_rejected_not_hammered_until_rewritten(self):
        p = self.mk(); self.srv.responder = lambda *a: (422, {"error": "provenance rejected"})
        self.assertEqual(self.push("--scan").returncode, 1); n = len(self.srv.requests)
        self.push("--scan"); self.assertEqual(len(self.srv.requests), n)
        self.srv.responder = self.ok_responder
        p.write_text('{"fixed":true}'); os.utime(p, (time.time() - 30,) * 2)
        self.assertEqual(self.push("--scan").returncode, 0)

    def test_hold_file_blocks_all_pushes(self):
        p = self.mk(); self.state.mkdir(parents=True, exist_ok=True); (self.state / "HOLD").write_text("region decision")
        self.assertEqual(self.push("--path", str(p)).returncode, 1)
        self.assertEqual(self.push("--scan").returncode, 1)
        self.assertEqual(len(self.srv.requests), 0)
        (self.state / "HOLD").unlink()
        self.assertEqual(self.push("--scan").returncode, 0)

    def test_recent_file_is_left_alone_and_odd_files_ignored(self):
        p = self.mk(); os.utime(p, None)
        self.assertEqual(self.push("--path", str(p)).returncode, 1)
        self.assertEqual(len(self.srv.requests), 0)
        (self.root / "runs" / "notes.txt").write_text("x"); (self.root / "elsewhere").mkdir(); (self.root / "elsewhere" / "a.json").write_text("{}")
        self.assertEqual(self.push("--path", str(self.root / "elsewhere")).returncode, 1)  # nothing pushable
        self.assertEqual(len(self.srv.requests), 0)


if __name__ == "__main__":
    unittest.main()
