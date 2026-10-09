import json, os, sys, tempfile, time, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from poller.events import FIELDS, collect
from poller.probe import ProbeError, parse_probe, PROBE_SCRIPT
from poller.transport import deliver, drop_expired, load_spool

HOST = {"machine": "m1", "ssh": "u@1.2.3.4"}
OK = "idle_s=42\nlocked=0\nlock_src=py\nchrome=1\nuser=drvinnyrb\n"
NOW = 1_800_000_000


class T(unittest.TestCase):
    def test_parse(self):
        p = parse_probe(OK)
        self.assertEqual((p["idle_s"], p["locked"], p["chrome_running"], p["console_user"]),
                         (42, 0, 1, "drvinnyrb"))
        self.assertEqual(parse_probe("idle_s=-1\nlocked=1\nchrome=0\nuser=root\n")["idle_s"], None)
        self.assertEqual(parse_probe("idle_s=1\nlocked=0\nchrome=0\nuser=a b/c\n")["console_user"], None)
        with self.assertRaises(ProbeError):
            parse_probe("garbage")

    def test_schema_exact(self):
        for runner in (lambda t, s: OK, lambda t, s: 1 / 0):
            ev = collect(HOST, runner, NOW)
            self.assertEqual(tuple(ev.keys()), FIELDS)
            self.assertEqual(set(ev), {"machine", "ts", "idle_s", "locked", "chrome_running",
                                       "console_user", "state", "poller_version"})
        self.assertEqual(collect(HOST, lambda t, s: OK, NOW)["state"], "ok")

    def test_unreachable(self):
        def boom(t, s):
            raise ProbeError("ssh timeout")
        ev = collect(HOST, boom, NOW)
        self.assertEqual(ev["state"], "unreachable")
        self.assertEqual((ev["locked"], ev["chrome_running"], ev["idle_s"], ev["console_user"]),
                         (False, False, 0, None))

    def test_tick_deadline_hung_host(self):
        import poller.main as M
        def runner(target, script):
            if "hang" in target:
                time.sleep(30)
            return OK
        hosts = [{"machine": "a", "ssh": "u@ok"}, {"machine": "b", "ssh": "u@hang"}, {"machine": "c", "ssh": "u@ok"}]
        t0 = time.time()
        evs = M.tick(hosts, runner, deadline=1)
        self.assertLess(time.time() - t0, 5)
        self.assertEqual([e["machine"] for e in evs], ["a", "b", "c"])
        self.assertEqual([e["state"] for e in evs], ["ok", "unreachable", "ok"])
        self.assertEqual(tuple(evs[1]), FIELDS)

    def test_run_hard_timeout(self):
        from poller.probe import _run
        t0 = time.time()
        with self.assertRaises(ProbeError):
            _run(["/bin/sh", "-c", "sleep 30"], "", 1)
        self.assertLess(time.time() - t0, 6)

    def test_python_stub_shell_fallback(self):
        # Fake Mac whose python is the xcode-select stub: probe reports the shell path.
        stub = "idle_s=7\nlocked=1\nlock_src=sh\nchrome=0\nuser=drvinnyrb\n"
        ev = collect(HOST, lambda t, s: stub, NOW)
        self.assertEqual((ev["state"], ev["locked"], ev["idle_s"]), ("ok", True, 7))
        ev = collect(HOST, lambda t, s: OK, NOW)
        self.assertIs(ev["locked"], False)
        self.assertIs(ev["chrome_running"], True)
        self.assertIsInstance(ev["idle_s"], int)
        self.assertIsNone(collect(HOST, lambda t, s: "idle_s=1\nlocked=-1\nchrome=0\nuser=a\n", NOW)["locked"])
        self.assertEqual(parse_probe(stub)["lock_src"], "sh")
        self.assertIn("xcode-select -p", PROBE_SCRIPT)   # stub guard
        self.assertIn("IOConsoleLocked", PROBE_SCRIPT)   # shell fallback
        for banned in ("Cookies", "History", "Local State", "Default/", "url", "tab"):
            self.assertNotIn(banned.lower(), PROBE_SCRIPT.lower().replace("current", "").replace("ioreg", ""))

    def test_24h_expiry(self):
        fmt = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
        old, fresh = {"ts": fmt(NOW - 24 * 3600 - 5)}, {"ts": fmt(NOW - 3600)}
        self.assertEqual(drop_expired([old, fresh], NOW), [fresh])
        with tempfile.TemporaryDirectory() as d:
            fail = lambda *a: "retry"
            self.assertEqual(deliver([old, fresh], d, "http://x", "t", fail, NOW), "queued")
            self.assertEqual(load_spool(os.path.join(d, "spool.jsonl")), [fresh])
            seen = []
            self.assertEqual(deliver([], d, "http://x", "t", lambda u, t, b: seen.append(b) or "ok", NOW), "posted")
            self.assertEqual(seen, [[fresh]])
            self.assertEqual(load_spool(os.path.join(d, "spool.jsonl")), [])

    def test_post_contract(self):
        ev = collect(HOST, lambda t, s: OK, NOW)
        with tempfile.TemporaryDirectory() as d:
            sp = os.path.join(d, "spool.jsonl")
            self.assertEqual(deliver([ev], d, "http://x", "t", lambda *a: "drop", NOW), "dropped")
            self.assertEqual(load_spool(sp), [])
            self.assertEqual(deliver([ev], d, "http://x", "t", lambda *a: "retry", NOW), "queued")
            self.assertEqual(len(load_spool(sp)), 1)
            self.assertEqual(deliver([], d, "http://x", "t", lambda *a: "ok", NOW), "posted")
            # backoff window: no POST attempted, batch stays queued
            self.assertEqual(deliver([ev], d, "http://x", "t", lambda *a: 1 / 0, NOW, attempt=False), "queued")

    def test_http_status_mapping(self):
        import threading, http.server
        from poller.transport import http_post
        code = {"c": 200}
        auth = []
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                auth.append(self.headers.get("Authorization"))
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(code["c"]); self.end_headers(); self.wfile.write(b"{}")
            def log_message(self, *a): pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_port}/"
        try:
            for c, want in ((200, "ok"), (400, "drop"), (401, "retry"), (403, "retry"), (404, "retry"), (413, "split"),
                            (422, "drop"), (429, "retry"), (500, "retry"), (503, "retry"), (307, "retry")):
                code["c"] = c
                self.assertEqual(http_post(url, "tok", [{}]), want, c)
            self.assertEqual(auth[0], "Bearer tok")
        finally:
            srv.shutdown()
        r = http_post("http://127.0.0.1:1/?secret=abc", "tok-SECRET", [{}], timeout=1)
        self.assertEqual(r, "retry")
        self.assertTrue(r.detail.startswith(("URLError", "ConnectionRefusedError")), r.detail)
        self.assertNotIn("secret=abc", r.detail)
        self.assertNotIn("127.0.0.1:1", r.detail)
        self.assertNotIn("tok-SECRET", r.detail)

    def test_jsonl_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            ev = collect(HOST, lambda t, s: OK, NOW)
            self.assertEqual(deliver([ev], d, None, None, now=NOW), "jsonl")
            f = [x for x in os.listdir(d) if x.endswith(".jsonl")][0]
            self.assertEqual(json.loads(open(os.path.join(d, f)).readline()), ev)


if __name__ == "__main__":
    unittest.main()
