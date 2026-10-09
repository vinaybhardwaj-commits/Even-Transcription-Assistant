"""Outage-proof delivery: chunking, 413 split, single-item poison drop, logging without secrets, fake-server dry run.
Everything is local: fake post functions and a 127.0.0.1 server. No live posts."""
import http.server, json, os, sys, tempfile, threading, time, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from poller.transport import (Verdict, deliver, http_post, load_spool, log_line, scrub, spool_stats, take_chunk,
                              MAX_BODY_CHARS, MAX_ITEMS)

NOW = 1_800_000_000
TOKEN = "tok-SUPER-SECRET-123"
URL = "https://example.invalid/api/presence?key=URLQUERYSECRET"


def ev(i, pad=0, ts=None):
    t = ts if ts is not None else NOW - 3600 + i
    return {"machine": f"m{i % 8}", "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)), "idle_s": i,
            "locked": False, "chrome_running": True, "console_user": "u" + "x" * pad, "state": "ok", "poller_version": "1.0.0"}


def idx(e):
    return e["idle_s"]


class Rec:
    """A fake post: records every chunk, answers via a rule."""
    def __init__(self, rule=lambda chunk: "ok"):
        self.rule, self.chunks = rule, []

    def __call__(self, url, token, chunk):
        self.chunks.append(list(chunk))
        r = self.rule(chunk)
        return r if isinstance(r, str) else r


class T(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.d = self._d.name
        self.spool = os.path.join(self.d, "spool.jsonl")

    def tearDown(self):
        self._d.cleanup()

    def log(self):
        try:
            with open(os.path.join(self.d, "poller.log")) as f:
                return f.read()
        except FileNotFoundError:
            return ""

    # ---- chunking ----
    def test_chunks_oldest_first_at_most_200_each_saved_as_it_succeeds(self):
        events = [ev(i) for i in range(650)]
        calls = {"n": 0}
        def rule(chunk):
            calls["n"] += 1
            if calls["n"] == 3:  # the third chunk fails: two are already gone from the spool
                return Verdict("retry", "HTTP 503")
            return "ok"
        post = Rec(rule)
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "queued")
        self.assertEqual([len(c) for c in post.chunks], [200, 200, 200])
        self.assertEqual([idx(c[0]) for c in post.chunks], [0, 200, 400], "oldest first")
        left = load_spool(self.spool)
        self.assertEqual([idx(e) for e in left], list(range(400, 650)), "accepted chunks left the spool, the rest stayed")
        post2 = Rec()
        self.assertEqual(deliver([], self.d, URL, TOKEN, post2, NOW), "posted")
        self.assertEqual([len(c) for c in post2.chunks], [200, 50])
        self.assertEqual(load_spool(self.spool), [])

    def test_spool_goes_before_new_events(self):
        from poller.transport import save_spool
        save_spool(self.spool, [ev(i) for i in range(5)])
        post = Rec()
        deliver([ev(i) for i in range(5, 8)], self.d, URL, TOKEN, post, NOW)
        self.assertEqual([idx(e) for c in post.chunks for e in c], list(range(8)))

    def test_body_char_cap(self):
        events = [ev(i, pad=60_000) for i in range(40)]  # ~60 KB each
        chunk = take_chunk(events)
        self.assertGreaterEqual(len(chunk), 1)
        self.assertLessEqual(len(json.dumps(chunk, separators=(",", ":"))), MAX_BODY_CHARS)
        post = Rec()
        deliver(events, self.d, URL, TOKEN, post, NOW)
        self.assertGreater(len(post.chunks), 2)
        for c in post.chunks:
            self.assertLessEqual(len(c), MAX_ITEMS)
            self.assertLessEqual(len(json.dumps(c, separators=(",", ":"))), MAX_BODY_CHARS)
        self.assertEqual([idx(e) for c in post.chunks for e in c], list(range(40)), "nothing lost, order kept")

    # ---- 413 ----
    def test_413_splits_and_never_drops(self):
        events = [ev(i) for i in range(200)]
        post = Rec(lambda c: Verdict("split", "HTTP 413") if len(c) > 30 else "ok")
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "posted")
        sent = [idx(e) for c in post.chunks if len(c) <= 30 for e in c]
        self.assertEqual(sent, list(range(200)), "every item delivered once, in order")
        self.assertEqual(load_spool(self.spool), [])
        self.assertNotIn("DROP", self.log())

    def test_413_on_a_single_item_drops_only_that_item_and_logs_it(self):
        events = [ev(i) for i in range(6)]
        big = events[3]
        post = Rec(lambda c: Verdict("split", "HTTP 413") if (len(c) > 1 or c[0] is big) and big in c else "ok")
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "posted")
        delivered = [idx(e) for c in post.chunks if big not in c for e in c]
        self.assertEqual(sorted(delivered), [0, 1, 2, 4, 5])
        self.assertEqual(load_spool(self.spool), [])
        self.assertEqual(self.log().count("DROP single item"), 1)

    # ---- poison ----
    def test_single_poison_item_is_isolated_and_the_rest_delivered(self):
        events = [ev(i) for i in range(50)]
        poison = events[17]
        post = Rec(lambda c: Verdict("drop", "HTTP 422") if poison in c else "ok")
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "posted")
        delivered = [idx(e) for c in post.chunks if poison not in c for e in c]
        self.assertEqual(sorted(delivered), [i for i in range(50) if i != 17])
        self.assertEqual(load_spool(self.spool), [])
        log = self.log()
        self.assertEqual(log.count("DROP single item"), 1)
        self.assertIn("code=HTTP 422", log)

    def test_a_server_that_rejects_everything_is_not_allowed_to_eat_the_spool(self):
        events = [ev(i) for i in range(30)]
        post = Rec(lambda c: Verdict("drop", "HTTP 400"))
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "queued")
        self.assertGreaterEqual(len(load_spool(self.spool)), 25, "stopped after a few drops, the rest is kept")
        self.assertIn("STOP", self.log())

    def test_retry_keeps_everything_and_writes_one_line(self):
        events = [ev(i) for i in range(10)]
        post = Rec(lambda c: Verdict("retry", "HTTP 503"))
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "queued")
        self.assertEqual(len(load_spool(self.spool)), 10)
        lines = self.log().strip().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ POST FAIL code=HTTP 503 chunk=10 spool=10$")

    def test_exception_in_post_is_a_retry_with_class_and_message(self):
        def boom(u, t, c):
            raise TimeoutError("read timed out")
        self.assertEqual(deliver([ev(1)], self.d, URL, TOKEN, boom, NOW), "queued")
        self.assertIn("code=TimeoutError: read timed out chunk=1 spool=1", self.log())

    # ---- logging carries no secrets ----
    def test_log_has_no_token_and_no_url(self):
        def leaky(u, t, c):
            raise OSError(f"cannot reach {u} with Bearer {t}")
        deliver([ev(1)], self.d, URL, TOKEN, leaky, NOW)
        log = self.log()
        for secret in (TOKEN, "URLQUERYSECRET", "example.invalid", "key="):
            self.assertNotIn(secret, log)
        self.assertIn("<url>", log)
        self.assertNotIn(TOKEN, scrub(f"x {TOKEN} y", TOKEN))
        self.assertNotIn("q=1", scrub("see https://a.b/c?q=1 now"))

    def test_http_post_exception_detail_has_no_secrets(self):
        r = http_post("http://127.0.0.1:1/p?k=URLQUERYSECRET", TOKEN, [{}], timeout=1)
        self.assertEqual(r, "retry")
        for secret in (TOKEN, "URLQUERYSECRET"):
            self.assertNotIn(secret, r.detail)

    # ---- tick-level stats ----
    def test_spool_stats_and_24h_cap(self):
        old = ev(0, ts=NOW - 24 * 3600 - 10)
        fresh = ev(1, ts=NOW - 7200)
        post = Rec(lambda c: Verdict("retry", "HTTP 500"))
        deliver([old, fresh], self.d, URL, TOKEN, post, NOW)
        self.assertEqual(spool_stats(self.d, NOW), (1, 7200), "the 24 h age cap still applies")

    def test_empty_spool_stats(self):
        self.assertEqual(spool_stats(self.d, NOW), (0, 0))

    def test_run_once_logs_spool_when_not_empty(self):
        import poller.main as M
        saved = (M.DATA_DIR, M.load_hosts, M.tick, M.get_url, M.get_token, M.deliver)
        try:
            M.DATA_DIR = self.d
            M.load_hosts = lambda: [{"machine": "a", "ssh": "u@a"}]
            M.tick = lambda hosts: [ev(1, ts=time.time() - 120)]
            M.get_url, M.get_token = (lambda: URL), (lambda: TOKEN)
            M.deliver = lambda events, d, u, t, attempt=True: deliver(events, d, u, t, Rec(lambda c: Verdict("retry", "HTTP 503")))
            M._backoff.update(fails=0, next=0.0)
            M.run_once()
        finally:
            M.DATA_DIR, M.load_hosts, M.tick, M.get_url, M.get_token, M.deliver = saved
            M._backoff.update(fails=0, next=0.0)
        log = self.log()
        self.assertRegex(log, r"TICK mode=queued spool=1 oldest_age_s=1[12]\d")
        self.assertNotIn(TOKEN, log)

    # ---- dry run against a fake server that enforces the real limits ----
    def test_dry_run_fake_server(self):
        state = {"mode": "ok", "inserted": 0, "codes": [], "max_items": 0, "max_chars": 0}
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                text = self.rfile.read(int(self.headers["Content-Length"])).decode()
                items = json.loads(text)
                if self.headers.get("Authorization") != "Bearer " + TOKEN:
                    code = 401
                elif state["mode"] == "down":
                    code = 503
                elif len(text) > 1_000_000 or len(items) > 200:
                    code = 413
                else:
                    code = 200
                    state["inserted"] += len(items)
                    state["max_items"] = max(state["max_items"], len(items))
                    state["max_chars"] = max(state["max_chars"], len(text))
                state["codes"].append(code)
                self.send_response(code); self.end_headers(); self.wfile.write(b"{}")
            def log_message(self, *a): pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_port}/api/presence"
        try:
            # outage: 6318 events pile up (the 7 Oct size); the server is down
            state["mode"] = "down"
            events = [ev(i, ts=NOW - 7200 + i // 10) for i in range(6318)]
            self.assertEqual(deliver(events, self.d, url, TOKEN, now=NOW), "queued")
            self.assertEqual(len(load_spool(self.spool)), 6318, "nothing lost while down")
            self.assertIn("POST FAIL code=HTTP 503 chunk=200 spool=6318", self.log())
            # recovery: one call drains it, every POST within the server limits
            state["mode"] = "ok"
            self.assertEqual(deliver([], self.d, url, TOKEN, now=NOW), "posted")
            self.assertEqual(state["inserted"], 6318)
            self.assertLessEqual(state["max_items"], 200)
            self.assertLessEqual(state["max_chars"], 900_000)
            self.assertNotIn(413, state["codes"], "the old whole-spool POST would have drawn a 413")
            self.assertEqual(load_spool(self.spool), [])
            # the old behaviour for contrast: the whole spool in one POST is refused by this server
            from urllib.request import Request, urlopen
            from urllib.error import HTTPError
            with self.assertRaises(HTTPError) as cm:
                urlopen(Request(url, data=json.dumps(events[:201]).encode(), method="POST",
                                headers={"Authorization": "Bearer " + TOKEN}), timeout=5)
            self.assertEqual(cm.exception.code, 413)
            # a wrong token (401) keeps the data
            self.assertEqual(deliver([ev(1)], self.d, url, "wrong-token", now=NOW), "queued")
            self.assertEqual(len(load_spool(self.spool)), 1)
            self.assertNotIn("wrong-token", self.log())
        finally:
            srv.shutdown()


class Budget(unittest.TestCase):
    """poller-fix-02: the drain has a time budget; the backlog still drains across ticks."""
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.d = self._d.name
        self.spool = os.path.join(self.d, "spool.jsonl")

    def tearDown(self):
        self._d.cleanup()

    def test_slow_server_6318_backlog_tick_deadline_holds_and_drains_across_ticks(self):
        state = {"inserted": [], "delay": 0.15}
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                time.sleep(state["delay"])
                text = self.rfile.read(int(self.headers["Content-Length"])).decode()
                items = json.loads(text)
                code = 413 if len(items) > 200 or len(text) > 1_000_000 else 200
                if code == 200:
                    state["inserted"].extend(idx(e) for e in items)
                self.send_response(code); self.end_headers(); self.wfile.write(b"{}")
            def log_message(self, *a): pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_port}/api/presence"
        events = [ev(i, ts=NOW - 7200 + i // 10) for i in range(6318)]
        try:
            budget = 0.6  # a scaled-down 15 s: ~4 chunks of 0.15 s fit per tick
            durations, results, sizes = [], [], []
            new = events
            for tick in range(40):
                t0 = time.monotonic()
                results.append(deliver(new, self.d, url, TOKEN, now=NOW, budget_s=budget))
                durations.append(time.monotonic() - t0)
                sizes.append(len(load_spool(self.spool)))
                new = []
                if results[-1] == "posted":
                    break
            self.assertEqual(results[-1], "posted")
            self.assertGreater(len(results), 3, "it took several ticks, so the budget really cut each one")
            self.assertTrue(all(r == "partial" for r in results[:-1]), results)
            self.assertLess(max(durations), budget + 0.15 + 0.5, "every tick ends within budget + one POST (+ margin)")
            self.assertTrue(all(a > b for a, b in zip(sizes, sizes[1:])), "the spool shrinks every tick")
            self.assertEqual(state["inserted"], list(range(6318)), "everything delivered once, in order, across ticks")
            self.assertEqual(sizes[-1], 0)
        finally:
            srv.shutdown()

    def test_a_hanging_server_cannot_hold_a_tick_past_budget_plus_five_seconds(self):
        import socket
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); sock.listen(5)  # accepts, never answers
        url = f"http://127.0.0.1:{sock.getsockname()[1]}/"
        try:
            t0 = time.monotonic()
            r = deliver([ev(1)], self.d, url, TOKEN, now=NOW, budget_s=0)
            self.assertLess(time.monotonic() - t0, 0.5, "budget 0: no POST is started")
            self.assertEqual(r, "queued", "no progress this tick: back off")
            t0 = time.monotonic()
            r = deliver([], self.d, url, TOKEN, now=NOW, budget_s=-3)  # timeout floor is 2 s
            self.assertLess(time.monotonic() - t0, 1.0)
            self.assertEqual(len(load_spool(self.spool)), 1)
        finally:
            sock.close()

    def test_post_timeout_is_cut_to_budget_plus_five(self):
        import socket
        sock = socket.socket(); sock.bind(("127.0.0.1", 0)); sock.listen(5)  # accepts, never answers
        url = f"http://127.0.0.1:{sock.getsockname()[1]}/"
        try:
            t0 = time.monotonic()
            r = deliver([ev(1)], self.d, url, TOKEN, now=NOW, budget_s=1)  # timeout = 1 + 5 s, not the usual 15
            took = time.monotonic() - t0
            self.assertEqual(r, "queued")
            self.assertLess(took, 9, took)
            self.assertIn("POST FAIL", open(os.path.join(self.d, "poller.log")).read())
        finally:
            sock.close()

    def test_partial_only_when_a_chunk_was_posted_this_tick(self):
        ticks = {"t": 0.0}
        def clock():  # every look at the clock is 20 s later: the budget (15 s) is gone after the first POST
            ticks["t"] += 20
            return ticks["t"]
        events = [ev(i) for i in range(400)]
        # nothing accepted (a slow server that always answers 413): no progress -> queued -> backoff
        post = Rec(lambda c: Verdict("split", "HTTP 413"))
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW, clock=clock), "queued")
        self.assertEqual(len(load_spool(self.spool)), 400)
        # one chunk accepted, then the budget runs out -> partial
        ticks["t"] = 0.0
        seq = iter(["ok"])
        post = Rec(lambda c: next(seq, "ok"))
        def clock2():
            ticks["t"] += 10
            return ticks["t"]
        ticks["t"] = 0.0
        self.assertEqual(deliver([], self.d, URL, TOKEN, post, NOW, clock=clock2), "partial")
        self.assertEqual(len(load_spool(self.spool)), 200)

    def test_dead_letter_is_bounded_by_7_days_and_5_mb_oldest_first(self):
        from poller.transport import write_dead_letter, DEAD_LETTER_MAX_BYTES
        path = os.path.join(self.d, "dropped.jsonl")
        day = 86400
        write_dead_letter(self.d, ev(1), NOW - 8 * day)   # will age out
        write_dead_letter(self.d, ev(2), NOW - 6 * day)
        write_dead_letter(self.d, ev(3), NOW)
        with open(path) as f:
            ids = [json.loads(l)["event"]["idle_s"] for l in f]
        self.assertEqual(ids, [2, 3], "the 8-day-old line is gone")
        # size: 25,000 lines of ~600 bytes would be 15 MB
        for i in range(10, 2510):
            write_dead_letter(self.d, ev(i, pad=5000), NOW + i)  # ~5 KB each, 2500 of them = 12.5 MB
        self.assertLessEqual(os.path.getsize(path), DEAD_LETTER_MAX_BYTES)
        with open(path) as f:
            ids = [json.loads(l)["event"]["idle_s"] for l in f]
        self.assertEqual(ids[-1], 2509, "the newest line is kept")
        self.assertNotIn(2, ids)
        self.assertEqual(ids, sorted(ids), "oldest dropped first, order kept")

    def test_trickled_reply_cannot_hold_a_post_past_the_wall_clock_limit(self):
        stop = {"v": False}
        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                try:
                    self.wfile.write(b"HTTP/1.0 200 OK\r\nX-Pad: "); self.wfile.flush()
                    for _ in range(60):  # one header byte every 0.5 s: every socket read succeeds, the reply never completes
                        if stop["v"]:
                            break
                        self.wfile.write(b"x"); self.wfile.flush()
                        time.sleep(0.5)
                except OSError:
                    pass
            def log_message(self, *a): pass
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_port}/"
        try:
            t0 = time.monotonic()
            r = deliver([ev(1), ev(2)], self.d, url, TOKEN, now=NOW, budget_s=1)  # wall-clock limit 1 + 5 = 6 s
            took = time.monotonic() - t0
            self.assertEqual(r, "queued")
            self.assertLess(took, 9, f"abandoned at the limit, not after the 30 s trickle ({took:.1f} s)")
            self.assertGreater(took, 4, "it did wait for the limit")
            self.assertEqual(len(load_spool(self.spool)), 2, "nothing lost")
            with open(os.path.join(self.d, "poller.log")) as f:
                self.assertIn("POST FAIL code=TimeoutError", f.read())
        finally:
            stop["v"] = True
            srv.shutdown()

    def test_deadline_wrapper_passes_results_and_exceptions_through(self):
        from poller.transport import call_with_deadline
        self.assertEqual(call_with_deadline(lambda: 7, 2), 7)
        with self.assertRaises(ZeroDivisionError):
            call_with_deadline(lambda: 1 / 0, 2)
        with self.assertRaises(TimeoutError):
            call_with_deadline(lambda: time.sleep(1.5), 0.2)

    def test_partial_is_progress_not_failure_for_backoff(self):
        import poller.main as M
        saved = (M.DATA_DIR, M.load_hosts, M.tick, M.get_url, M.get_token, M.deliver)
        try:
            M.DATA_DIR = self.d
            M.load_hosts = lambda: [{"machine": "a", "ssh": "u@a"}]
            M.tick = lambda hosts: [ev(1, ts=time.time() - 60)]
            M.get_url, M.get_token = (lambda: URL), (lambda: TOKEN)
            M.deliver = lambda events, d, u, t, attempt=True: "partial"
            M._backoff.update(fails=3, next=0.0)
            M.run_once()
            self.assertEqual(M._backoff["fails"], 0)
            M.deliver = lambda events, d, u, t, attempt=True: "queued"
            M.run_once()
            self.assertEqual(M._backoff["fails"], 1, "a real failure still backs off")
        finally:
            M.DATA_DIR, M.load_hosts, M.tick, M.get_url, M.get_token, M.deliver = saved
            M._backoff.update(fails=0, next=0.0)

    def test_post_cap_per_call_is_partial_not_a_backoff_failure(self):
        events = [ev(i) for i in range(1000)]  # five chunks of 200; with the per-call cap lowered to 2 the call stops early
        import poller.transport as TR
        old = TR.MAX_POSTS_PER_CALL
        TR.MAX_POSTS_PER_CALL = 2
        try:
            post = Rec(lambda c: "ok")
            self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "partial")
            self.assertEqual(len(post.chunks), 2)
            self.assertEqual(len(load_spool(self.spool)), 600)
        finally:
            TR.MAX_POSTS_PER_CALL = old

    def test_new_events_are_on_disk_before_the_first_post(self):
        class Died(BaseException):
            pass
        def die(u, t, c):
            raise Died()
        with self.assertRaises(Died):
            deliver([ev(i) for i in range(7)], self.d, URL, TOKEN, die, NOW)
        self.assertEqual([idx(e) for e in load_spool(self.spool)], list(range(7)))

    def test_dropped_items_are_kept_in_dropped_jsonl(self):
        events = [ev(i) for i in range(10)]
        poison = events[4]
        post = Rec(lambda c: Verdict("drop", "HTTP 422") if poison in c else "ok")
        deliver(events, self.d, URL, TOKEN, post, NOW)
        with open(os.path.join(self.d, "dropped.jsonl")) as f:
            kept = [json.loads(l) for l in f]
        self.assertEqual([k["event"] for k in kept], [poison])
        self.assertRegex(kept[0]["dropped_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_systemic_rejection_loses_nothing(self):
        events = [ev(i) for i in range(30)]
        deliver(events, self.d, URL, TOKEN, Rec(lambda c: Verdict("drop", "HTTP 400")), NOW)
        kept = len(load_spool(self.spool))
        with open(os.path.join(self.d, "dropped.jsonl")) as f:
            dead = sum(1 for _ in f)
        self.assertEqual(kept + dead, 30, "every event is either in the spool or in dropped.jsonl")

    def test_chunk_size_grows_back_gradually_after_a_split(self):
        events = [ev(i) for i in range(1000)]
        post = Rec(lambda c: Verdict("split", "HTTP 413") if len(c) > 37 else "ok")
        self.assertEqual(deliver(events, self.d, URL, TOKEN, post, NOW), "posted")
        self.assertLess(len(post.chunks), 60, "a 37-item server is not hit with a fresh 200 every time")


if __name__ == "__main__":
    unittest.main()
