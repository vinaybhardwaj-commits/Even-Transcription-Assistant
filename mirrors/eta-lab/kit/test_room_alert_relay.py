#!/usr/bin/env python3
"""Tests for kit/room-alert-relay.py (Fable ruling 137; eta-refuter #404/#409/#415/#422). Run: python3 kit/test_room_alert_relay.py
No network, no real bus: an in-memory bus, a scripted door, a fake MCP stdio server for the real client class."""
import importlib.util, json, os, subprocess, sys, tempfile, textwrap, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("relay", os.environ.get("RELAY_UNDER_TEST") or os.path.join(HERE, "room-alert-relay.py"))
R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R)

def rd(path):
    with open(path) as f:
        return f.read()


def wf(path, text):
    with open(path, "w") as f:
        f.write(text)


OK_HB = {"state": "ok", "age_s": 30, "last_ok": True, "evaluated": 3, "last_error": None}


def row(i, kind="offline", **kw):
    return {"id": i, "created_at": "2026-09-24T10:00:00Z", "kind": kind, "room_ids": ["room_x"], "room_name": "Room A", "status_from": "ok",
            "status_to": "offline", "subject": f"subject {i}", "body": f"body {i}", **kw}


def door_ok(new=(), late=(), hb=OK_HB, **kw):
    d = {"ok": True, "new": list(new), "new_truncated": False, "late": list(late), "late_truncated": False, "head_id": 0, "heartbeat": hb}
    d.update(kw); return d


class FakeBus:
    def __init__(self, refuse_text_for=(), fail=False):
        self.posts, self.threads, self.refuse, self.fail = [], set(), set(refuse_text_for), fail
    def thread_exists(self, tid):
        if self.fail: raise R.BusError("bus down")
        return tid in self.threads
    def post(self, to, subject, body, priority, thread_id):
        if self.fail: raise R.BusError("bus down")
        if any(r in body for r in self.refuse): raise R.BusRefused("refused: looks like a secret")
        self.posts.append({"to": to, "subject": subject, "body": body, "priority": priority, "thread": thread_id}); self.threads.add(thread_id)
    def close(self): pass


class Clock:
    def __init__(self, t=1_800_000_000): self.t = t
    def __call__(self): return self.t


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.bus = FakeBus(); self.clock = Clock(); self.answers = []
        self.after_ids = []; self.lookbacks = []
    def door(self, after_id, lookback=None):
        self.after_ids.append(after_id); self.lookbacks.append(lookback)
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(a, Exception): raise a
        return a
    def relay(self, bus=None):
        return R.Relay(self.door, lambda: (bus or self.bus), state_dir=self.d, clock=self.clock)
    def silent_posts(self): return [p for p in self.bus.posts if "SILENT" in p["subject"] or "recovered" in p["subject"]]
    def alert_posts(self): return [p for p in self.bus.posts if p["thread"].startswith("room-alert-") and p["thread"][11:].isdigit()]


class Delivery(Base):
    def test_new_rows_posted_once_and_cursor_advances(self):
        self.answers = [door_ok(new=[row(5), row(7)])]; r = self.relay()
        self.assertEqual(r.poll_once(), "OK")
        self.assertEqual([p["thread"] for p in self.alert_posts()], ["room-alert-5", "room-alert-7"]); self.assertEqual(r.state["cursor"], 7)
        r.poll_once(); self.assertEqual(len(self.alert_posts()), 2, "F3: the same rows offered again must not post again")
    def test_priority_by_kind(self):
        self.answers = [door_ok(new=[row(1, "offline"), row(2, "degraded"), row(3, "fleet_outage"), row(4, "recovered")])]; self.relay().poll_once()
        self.assertEqual({p["thread"]: p["priority"] for p in self.alert_posts()}, {"room-alert-1": "urgent", "room-alert-2": "urgent", "room-alert-3": "urgent", "room-alert-4": "normal"})
    def test_late_rows_are_posted_and_do_not_move_the_cursor(self):
        self.answers = [door_ok(new=[row(10)], late=[row(6)])]; r = self.relay(); r.poll_once()
        self.assertEqual(sorted(p["thread"] for p in self.alert_posts()), ["room-alert-10", "room-alert-6"]); self.assertEqual(r.state["cursor"], 10)
    def test_dedupe_against_the_store_it_posted_to_across_a_restart(self):
        self.answers = [door_ok(new=[row(3)])]; self.relay().poll_once()
        os.remove(os.path.join(self.d, "relay-room-alerts.state.json"))       # lose the cursor: a duplicate would follow if dedupe were local
        self.relay().poll_once(); self.assertEqual(len(self.alert_posts()), 1)
    def test_post_failure_keeps_the_cursor_and_retry_does_not_duplicate(self):
        self.answers = [door_ok(new=[row(1), row(2)])]
        class Flaky(FakeBus):
            n = 0
            def post(s, *a, **k):
                s.n += 1
                if s.n == 2: raise R.BusError("bus down")
                FakeBus.post(s, *a, **k)
        b = Flaky(); r = self.relay(b); self.assertEqual(r.poll_once(), "SILENT:bus"); self.assertEqual(r.state["cursor"], 0)
        b.n = 99; r.poll_once(); self.assertEqual(sorted(p["thread"] for p in b.posts if p["thread"].startswith("room-alert-")), ["room-alert-1", "room-alert-2"])
    def test_a_transient_bus_failure_is_not_mistaken_for_a_refusal(self):
        self.answers = [door_ok(new=[row(1)])]
        class Down(FakeBus):
            def post(s, *a, **k): raise R.BusError("bus call bus_post timed out")
        r = self.relay(Down()); self.assertEqual(r.poll_once(), "SILENT:bus"); self.assertEqual(r.state["cursor"], 0)
        self.assertFalse(any("withheld" in p["subject"] for p in self.bus.posts))
    def test_poison_row_gets_a_content_free_note_and_does_not_block(self):
        self.bus = FakeBus(refuse_text_for=["POISON"]); self.answers = [door_ok(new=[row(9, body="POISON text")])]; r = self.relay(); r.poll_once()
        self.assertEqual(r.state["cursor"], 9); self.assertIn("withheld", self.bus.posts[0]["subject"])
    def test_new_truncated_pages_again_immediately(self):
        self.answers = [door_ok(new=[row(1), row(2)], new_truncated=True), door_ok(new=[row(3)])]; r = self.relay(); r.poll_once()
        self.assertEqual(self.after_ids, [0, 2]); self.assertEqual(len(self.alert_posts()), 3)
    def test_100_plus_rows_then_one_new_row_is_returned(self):
        self.answers = [door_ok(new=[row(i) for i in range(1, 51)], new_truncated=True), door_ok(new=[row(i) for i in range(51, 101)], new_truncated=True), door_ok(new=[row(101)])]
        self.relay().poll_once(); self.assertEqual(len(self.alert_posts()), 101)
    def test_bounded_paging(self):
        self.answers = [door_ok(new=[row(1)], new_truncated=True)]; r = self.relay(); self.assertIn("pages_capped", r.poll_once()); self.assertLessEqual(len(self.after_ids), R.MAX_PAGES)


class Lookback(Base):
    def test_first_poll_uses_the_wide_window_then_a_short_one(self):
        self.answers = [door_ok()]; r = self.relay(); r.poll_once(); self.clock.t += 60; r.poll_once()
        self.assertEqual(self.lookbacks, [R.LOOKBACK_FIRST, R.LOOKBACK_BASE + 1])
    def test_the_window_grows_with_the_gap_since_the_last_good_read(self):
        self.answers = [door_ok()]; r = self.relay(); r.poll_once()
        for gap_s, want in ((60, 4), (20 * 60, 23), (5 * 3600, R.LOOKBACK_MAX)):
            self.clock.t += gap_s; r2 = self.relay(); r2.poll_once(); self.assertEqual(self.lookbacks[-1], want, f"gap {gap_s}s")
            self.clock.t -= 0
    def test_a_failed_read_does_not_reset_the_gap(self):
        self.answers = [door_ok()]; r = self.relay(); r.poll_once()
        self.answers = [R.DoorError("http 500")]; self.clock.t += 600; r.poll_once()       # a failed read must not count as a good one
        self.answers = [door_ok()]; self.clock.t += 60; r.poll_once(); self.assertEqual(self.lookbacks[-1], 11 + R.LOOKBACK_BASE)
    def test_a_200_with_a_bad_payload_does_not_count_as_a_good_read(self):
        for name, bad in (("ok false", {"ok": False, "error": "db down"}), ("missing lists", {"ok": True, "heartbeat": OK_HB}),
                          ("row without an id", door_ok(new=[{"kind": "offline"}]))):
            with self.subTest(name):
                self.d = tempfile.mkdtemp(); self.lookbacks = []; self.clock = Clock()
                self.answers = [door_ok()]; r = self.relay(); r.poll_once()
                self.answers = [bad]; self.clock.t += 600; r.poll_once()                 # the door ANSWERED (a 200), but not with a readable outbox
                self.answers = [door_ok()]; self.clock.t += 60; r.poll_once()
                self.assertEqual(self.lookbacks[-1], 11 + R.LOOKBACK_BASE, "the gap must still run from the last GOOD read (11 min ago)")
    def test_the_window_never_exceeds_the_tools_ceiling(self):
        self.answers = [door_ok()]; r = self.relay(); r.poll_once(); self.clock.t += 10 * 24 * 3600; r.poll_once(); self.assertEqual(self.lookbacks[-1], 60)


class SilentA(Base):
    def _enter_clear_reenter(self, bad):
        self.answers = [bad, door_ok(), bad]; r = self.relay()
        self.assertEqual(r.poll_once(), "SILENT:a"); self.assertEqual(len(self.silent_posts()), 1, "posted once on entering")
        self.assertEqual(r.poll_once(), "OK"); self.assertEqual(len(self.silent_posts()), 2, "one recovery when it clears")
        self.assertEqual(r.poll_once(), "SILENT:a"); self.assertEqual(len(self.silent_posts()), 3, "F10: re-armed, so SILENT enter, clear, re-enter posts THREE messages")
    def test_door_exception(self): self._enter_clear_reenter(R.DoorError("http 500"))
    def test_not_ok_true(self): self._enter_clear_reenter({"ok": False, "error": "db down"})
    def test_ok_missing(self): self._enter_clear_reenter({"new": [], "late": [], "heartbeat": OK_HB})
    def test_ok_is_a_truthy_non_true(self): self._enter_clear_reenter({"ok": "yes", "new": [], "late": [], "heartbeat": OK_HB})
    def test_new_key_missing(self): self._enter_clear_reenter({"ok": True, "late": [], "heartbeat": OK_HB})
    def test_row_without_integer_id(self): self._enter_clear_reenter(door_ok(new=[{"id": "7", "kind": "offline"}]))
    def test_a_failed_read_is_never_no_new_rows(self):
        self.answers = [R.DoorError("http 401")]; r = self.relay(); self.assertTrue(r.poll_once().startswith("SILENT:a"))
    def test_repeated_silent_polls_post_once(self):
        self.answers = [R.DoorError("x")]; r = self.relay(); [r.poll_once() for _ in range(5)]; self.assertEqual(len(self.silent_posts()), 1)


class SilentB(Base):
    def status(self, hb): self.answers = [door_ok(hb=hb)]; return self.relay().poll_once()
    def test_unhealthy_heartbeats(self):
        for name, hb in [("missing", None), ("bool true", {"state": "ok", "age_s": True}), ("negative", {"state": "ok", "age_s": -1}), ("null age", {"state": "ok", "age_s": None}),
                         ("string age", {"state": "ok", "age_s": "5"}), ("nan", {"state": "ok", "age_s": float("nan")}), ("state none", {"state": "none"}), ("state stale", {"state": "stale", "age_s": 400}),
                         ("age 301", {"state": "ok", "age_s": 301}), ("no age", {"state": "ok"}), ("a list", [1]), ("inf", {"state": "ok", "age_s": float("inf")})]:
            with self.subTest(name): self.tearDown_dirs(); self.assertEqual(self.status(hb), "SILENT:b")
    def tearDown_dirs(self): self.d = tempfile.mkdtemp()
    def test_healthy_boundaries(self):
        for age in (0, 1, 60, 299, 300, 12.5): self.tearDown_dirs(); self.assertEqual(self.status({"state": "ok", "age_s": age}), "OK")
    def test_alerts_still_delivered_while_the_heartbeat_is_bad(self):
        self.answers = [door_ok(new=[row(4)], hb={"state": "none"})]; self.assertEqual(self.relay().poll_once(), "SILENT:b"); self.assertEqual(len(self.alert_posts()), 1)
    def test_late_truncated_is_silent_c(self):
        self.answers = [door_ok(late=[row(1)], late_truncated=True)]; self.assertEqual(self.relay().poll_once(), "SILENT:c")


class Restart(Base):
    def test_start_repost_is_throttled_and_a_crash_loop_is_bounded(self):
        self.answers = [R.DoorError("x")]; self.relay().poll_once()                     # first run: enter posts once
        for _ in range(10): self.clock.t += 20; self.relay().poll_once()                # ten restarts within 30 min
        self.assertEqual(len(self.silent_posts()), 1, "restarts inside the throttle window must not re-post")
        self.clock.t += R.START_REPOST_S + 1; self.relay().poll_once()
        self.assertEqual(len(self.silent_posts()), 2, "after the window one start-time re-post")
    def test_a_changed_silent_set_posts_at_once_on_start(self):
        self.answers = [R.DoorError("x")]; self.relay().poll_once()
        self.answers = [door_ok(hb={"state": "none"})]; self.clock.t += 5; self.relay().poll_once()
        self.assertGreaterEqual(len(self.silent_posts()), 2)
    def test_last_poll_file_is_written_every_poll_and_greppable(self):
        self.answers = [door_ok()]; r = self.relay(); r.poll_once()
        line = rd(os.path.join(self.d, "relay-room-alerts.last-poll"))
        self.assertRegex(line, r"^epoch=\d+ iso=\S+ status=OK cursor=0\n$"); self.clock.t += 60; r.poll_once()
        self.assertIn(f"epoch={self.clock.t}", rd(os.path.join(self.d, "relay-room-alerts.last-poll")))
    def test_bus_down_is_visible_in_the_last_poll_file(self):
        self.answers = [door_ok(new=[row(1)])]; r = self.relay(FakeBus(fail=True)); self.assertEqual(r.poll_once(), "SILENT:bus")
        self.assertIn("status=SILENT:bus", rd(os.path.join(self.d, "relay-room-alerts.last-poll")))


class SingleInstance(unittest.TestCase):
    def test_two_relays_over_the_same_lock_one_runs(self):
        d = tempfile.mkdtemp(); lock = os.path.join(d, "l.lock")
        holder = subprocess.Popen([sys.executable, "-c", textwrap.dedent(f"""
            import importlib.util,time
            s=importlib.util.spec_from_file_location('r',{os.path.join(HERE,'room-alert-relay.py')!r}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
            f=m.take_lock({lock!r}); print('held' if f else 'none', flush=True); time.sleep(6)""")], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "held"); self.assertIsNone(R.take_lock(lock), "the second relay must not start")
        finally: holder.kill(); holder.wait(); holder.stdout.close()
        f = R.take_lock(lock); self.assertIsNotNone(f, "released when the holder died (kernel flock, no pid reuse hole)"); f.close()
    def test_a_stale_pid_in_the_lock_file_does_not_block(self):
        d = tempfile.mkdtemp(); lock = os.path.join(d, "l.lock"); wf(lock, str(os.getpid()))   # a LIVE pid, nobody holds the flock
        f = R.take_lock(lock); self.assertIsNotNone(f); f.close()


class StdioBusClient(unittest.TestCase):
    def test_protocol_against_a_fake_server(self):
        d = tempfile.mkdtemp(); srv = os.path.join(d, "fake.py"); run = os.path.join(d, "run.sh"); log = os.path.join(d, "log.jsonl")
        wf(srv, textwrap.dedent(f"""
            import sys,json,os
            assert os.environ.get('ETA_BUS_AS')=='room-alert-relay' and 'HERDR_PANE_ID' not in os.environ
            threads=set()
            for l in sys.stdin:
                o=json.loads(l); open({log!r},'a').write(l)
                if 'id' not in o: continue
                m=o['method']
                if m=='initialize': r={{'protocolVersion':'2025-06-18','capabilities':{{}},'serverInfo':{{'name':'fake'}}}}
                else:
                    a=o['params']['arguments']; n=o['params']['name']
                    if n=='bus_thread': r={{'content':[{{'type':'text','text':json.dumps({{'messages':[{{'id':1}}] if a['thread_id'] in threads else []}})}}]}}
                    elif n=='bus_post':
                        if 'SECRET' in a['body']: r={{'isError':True,'content':[{{'type':'text','text':'looks like a secret'}}]}}
                        else: threads.add(a['thread_id']); r={{'content':[{{'type':'text','text':json.dumps({{'id':5}})}}]}}
                print(json.dumps({{'jsonrpc':'2.0','id':o['id'],'result':r}}),flush=True)"""))
        wf(run, f"#!/bin/sh\nexec {sys.executable} {srv}\n")
        b = R.StdioBus(run=run, timeout=10)
        try:
            self.assertFalse(b.thread_exists("room-alert-1")); b.post(["conductor"], "s", "b", "urgent", "room-alert-1"); self.assertTrue(b.thread_exists("room-alert-1"))
            with self.assertRaises(R.BusRefused): b.post(["conductor"], "s", "SECRET", "normal", "room-alert-2")
        finally: b.close()
        with open(log) as lf:
            sent = [json.loads(l) for l in lf]
        post = [m for m in sent if m.get("params", {}).get("name") == "bus_post"][0]["params"]["arguments"]
        self.assertEqual(post["to"], ["conductor"]); self.assertEqual(post["priority"], "urgent"); self.assertEqual(post["thread_id"], "room-alert-1")


class Door(unittest.TestCase):
    def test_token_is_read_from_a_file_and_never_from_argv(self):
        src = rd(os.path.join(HERE, "room-alert-relay.py"))
        self.assertIn("TOKEN_FILE", src); self.assertNotIn("sys.argv", src.split("def main")[0]); self.assertNotIn("--token", src)
    def test_missing_token_file_and_url_are_door_errors(self):
        R.MCP_URL = ""; 
        with self.assertRaises(R.DoorError): R.http_door(0)
        R.MCP_URL = "http://127.0.0.1:9/x"; R.TOKEN_FILE = "/nonexistent/token"
        with self.assertRaises(R.DoorError): R.http_door(0)


class Servers:
    """Local HTTP servers on 127.0.0.1 that record what they receive. A CANARY token stands in for the real one."""
    def __init__(self, redirect_to=None, code=302):
        import http.server, threading
        outer = self; self.hits = []; self.redirect_to, self.code = redirect_to, code
        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(h):
                n = int(h.headers.get("content-length") or 0); h.rfile.read(n)
                outer.hits.append({"authorization": h.headers.get("authorization"), "path": h.path})
                if outer.redirect_to:
                    h.send_response(outer.code); h.send_header("Location", outer.redirect_to); h.send_header("content-length", "0"); h.end_headers()
                else:
                    b = b'{"ok":true}'; h.send_response(200); h.send_header("content-length", str(len(b))); h.end_headers(); h.wfile.write(b)
            do_GET = do_POST
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H); self.url = f"http://127.0.0.1:{self.srv.server_port}/x"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
    def close(self): self.srv.shutdown(); self.srv.server_close()


class TokenSafety(unittest.TestCase):
    CANARY = "Bearer CANARY-TOKEN-0123456789"
    def test_an_http_url_is_refused_before_anything_is_sent(self):
        srv = Servers(); tok = os.path.join(tempfile.mkdtemp(), "t"); wf(tok, "CANARY-TOKEN-0123456789")
        old = (R.MCP_URL, R.TOKEN_FILE); R.MCP_URL, R.TOKEN_FILE = srv.url, tok
        try:
            with self.assertRaises(R.DoorError) as cm: R.http_door(0)
            self.assertIn("https", str(cm.exception)); self.assertEqual(srv.hits, [], "the token must not have been sent over http")
        finally: R.MCP_URL, R.TOKEN_FILE = old; srv.close()
    def test_https_check_is_case_insensitive_and_a_bare_host_is_refused(self):
        old = R.MCP_URL
        try:
            for u in ("HTTP://example.invalid/x", "example.invalid/x", "ftp://example.invalid/x", "//example.invalid/x"):
                R.MCP_URL = u
                with self.assertRaises(R.DoorError, msg=u): R.http_door(0)
        finally: R.MCP_URL = old
    def test_an_uppercase_https_scheme_passes_the_check(self):
        old = (R.MCP_URL, R.TOKEN_FILE); R.MCP_URL, R.TOKEN_FILE = "HTTPS://example.invalid/x", "/nonexistent/token"
        try:
            with self.assertRaises(R.DoorError) as cm: R.http_door(0)
            self.assertIn("token file", str(cm.exception), "it got past the scheme check and failed on the missing token file instead")
        finally: R.MCP_URL, R.TOKEN_FILE = old
    def test_a_redirect_never_delivers_the_token_to_the_target(self):
        for code in (301, 302, 303, 307, 308):
            with self.subTest(code=code):
                target = Servers(); origin = Servers(redirect_to=target.url, code=code)
                try:
                    with self.assertRaises(R.DoorError) as cm: R._post(origin.url, {"authorization": self.CANARY}, b"{}")
                    self.assertEqual(target.hits, [], f"a {code} must not reach the other host")
                    self.assertEqual(len(origin.hits), 1); self.assertNotIn("CANARY", str(cm.exception), "the reason must not contain the token")
                finally: origin.close(); target.close()
    def test_a_plain_200_still_works_through_the_no_redirect_opener(self):
        srv = Servers()
        try:
            status, raw = R._post(srv.url, {"authorization": self.CANARY}, b"{}"); self.assertEqual((status, raw), (200, b'{"ok":true}'))
            self.assertEqual(srv.hits[0]["authorization"], self.CANARY)
        finally: srv.close()


class Gitignore(unittest.TestCase):
    def test_relay_state_files_are_ignored(self):
        repo = subprocess.run(["git", "-C", HERE, "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
        for f in ("relay-room-alerts.last-poll", "relay-room-alerts.state.json", "relay-room-alerts.lock"):
            p = subprocess.run(["git", "-C", repo, "check-ignore", "-q", f"bus/{f}"]); self.assertEqual(p.returncode, 0, f"bus/{f} must be gitignored")


if __name__ == "__main__":
    unittest.main(verbosity=1)
