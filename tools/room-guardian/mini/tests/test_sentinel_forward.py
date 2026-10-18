import importlib, json, os, sys, tempfile, threading, time, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "subscriber"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "router"))
import sentinel_forward as sf
import subscriber as sb

T0 = 1789315200  # 2026-10-17 00:00:00 UTC, fixed


class Clock:
    def __init__(self, t): self.t = t
    def __call__(self): return self.t
    def adv(self, s): self.t += s


class Poster:
    """poster(url, token, body_bytes, timeout) -> status; records every call (the token is asserted, never printed)."""
    def __init__(self, status=200):
        self.status = status
        self.calls = []
    def __call__(self, url, token, body, timeout=10):
        self.calls.append({"url": url, "token": token, "body": json.loads(body), "timeout": timeout})
        return self.status


class Sink:
    def __init__(self): self.quiet = []
    def open_quiet_rooms(self): return []
    def open_rooms(self, kind): return []
    def guardian_quiet(self, room, q, now): self.quiet.append(room)


def health(code=None, **over):
    line = {"room_id": "r1", "ts": T0, "state": "ok", "capture_open": True, "zero_ratio": 0.9, "mode": "shadow"}
    if code is not None:
        line["code"] = code
    line.update(over)
    return line


def mk_home():
    t = tempfile.mkdtemp()
    for d in ("data", "logs", "etc"):
        os.makedirs(os.path.join(t, d))
    return t


class ExtractTests(unittest.TestCase):
    def test_no_code_is_nothing(self):
        self.assertIsNone(sf.extract(health()))
        self.assertIsNone(sf.extract(health(code="SOMETHING_ELSE")))
        self.assertIsNone(sf.extract(health(code=42)))
        self.assertIsNone(sf.extract("not a dict"))

    def test_fields_fail_closed_and_absent_become_null(self):
        p = sf.extract(health(code="OK", mic_class="c270", mode="live", peak=5, last_action=""))
        self.assertEqual(p, {"code": "OK", "mic_class": "unknown", "zr": 0.9, "peak": None,
                             "last_action": None, "last_result": None, "mode": "shadow"})

    def test_pre_s2_field_names_are_read_as_fallbacks(self):
        p = sf.extract(health(code="MIC_DEAD_WEBCAM", zero_ratio_2s=0.7, peak_2s=0.0004, mic_class="webcam"))
        self.assertEqual(p["zr"], 0.7)
        self.assertEqual(p["peak"], 0.0004)
        self.assertEqual(p["mic_class"], "webcam")


class ForwardTests(unittest.TestCase):
    def setUp(self):
        self.home = mk_home()
        self.state = os.path.join(self.home, "data", "sentinel-forward-state.json")
        self.audit = os.path.join(self.home, "logs", "sentinel-forward-audit.jsonl")
        self.clock = Clock(T0)
        self.poster = Poster()
        self.f = sf.SentinelForward(self.poster, self.state, self.clock, self.audit, background=False)

    def token_env(self, token="sentinel-tok-secret"):
        t = tempfile.NamedTemporaryFile("w", suffix=".token", delete=False)
        t.write(token); t.close()
        self.addCleanup(os.unlink, t.name)
        old = os.environ.get("MICGUARD_TOKEN_FILE")
        os.environ["MICGUARD_TOKEN_FILE"] = t.name
        self.addCleanup(lambda: os.environ.pop("MICGUARD_TOKEN_FILE", None) if old is None else os.environ.__setitem__("MICGUARD_TOKEN_FILE", old))

    def test_token_missing_no_post_and_no_token_event(self):
        os.environ["MICGUARD_TOKEN_FILE"] = "/nonexistent-a-token-file"
        self.addCleanup(os.environ.pop, "MICGUARD_TOKEN_FILE", None)
        self.f.on_health("r1", health("MIC_MUTED_TONOR"), T0)
        self.assertEqual(self.poster.calls, [])
        self.assertIn("sentinel_no_token", open(self.audit).read())

    def test_first_line_posts_then_60s_rate_limit_then_code_change(self):
        self.token_env()
        self.f.on_health("r1", health("MIC_MUTED_TONOR"), T0)
        self.assertEqual(len(self.poster.calls), 1)
        self.clock.adv(59); self.f.on_health("r1", health("MIC_MUTED_TONOR"), T0 + 59)
        self.assertEqual(len(self.poster.calls), 1)                       # 59 s: still inside the 60 s window
        self.clock.adv(1); self.f.on_health("r1", health("MIC_MUTED_TONOR"), T0 + 60)
        self.assertEqual(len(self.poster.calls), 2)                       # 60 s: the refresh tick
        self.clock.adv(10); self.f.on_health("r1", health("OK"), T0 + 70)
        self.assertEqual(len(self.poster.calls), 3)                       # a code change posts immediately
        self.assertEqual([c["body"]["events"][0]["payload"]["code"] for c in self.poster.calls],
                         ["MIC_MUTED_TONOR", "MIC_MUTED_TONOR", "OK"])
        self.clock.adv(10); self.f.on_health("r1", health("OK"), T0 + 80)
        self.assertEqual(len(self.poster.calls), 3)

    def test_failed_post_backs_off_and_is_not_retried_before_next_retry(self):
        self.token_env()
        self.poster.status = 500
        self.f.on_health("r1", health("RECORDER_DOWN"), T0)
        self.assertEqual(len(self.poster.calls), 1)                       # t0: fails, backoff 5 s -> next_retry T0+5
        self.clock.adv(4); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 4)
        self.assertEqual(len(self.poster.calls), 1)                       # t4: still inside the 5 s backoff -- no re-post
        self.clock.adv(11); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 15)
        self.assertEqual(len(self.poster.calls), 2)                       # t15: backoff elapsed, retry (fails again, backoff 10 s -> T0+25)
        self.clock.adv(9); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 24)
        self.assertEqual(len(self.poster.calls), 2)                       # t24: inside the 10 s backoff -- no re-post
        self.poster.status = 200
        self.clock.adv(6); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 30)
        self.assertEqual(len(self.poster.calls), 3)                       # t30: retry succeeds; streak cleared
        self.clock.adv(15); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 45)
        self.assertEqual(len(self.poster.calls), 3)                       # back inside the 60 s window from the success
        st = json.load(open(self.state))["rooms"]["r1"]
        self.assertEqual(st, {"code": "RECORDER_DOWN", "posted_at": T0 + 30, "pending_code": None, "fails": 0,
                              "next_retry": None, "backoff_s": 0, "attempted_at": T0 + 30})
        audit = open(self.audit).read()
        self.assertIn("sentinel_post_failed", audit)
        self.assertIn("sentinel_backoff", audit)
        self.assertIn("sentinel_forwarded", audit)

    def test_failing_endpoint_is_not_hammered(self):
        """F1 repro: a 503 endpoint must not get one post per 10 s health line. With backoff, 61 lines -> 4 posts."""
        self.token_env()
        self.poster.status = 503
        for t in range(0, 61, 10):
            self.f.on_health("r1", health("RECORDER_DOWN"), T0 + t)
        self.assertEqual(len(self.poster.calls), 4)                       # t0, t10, t20, t40 (t30/t50/t60 inside backoff)
        st = json.load(open(self.state))["rooms"]["r1"]
        self.assertEqual(st["fails"], 4)
        self.assertEqual(st["next_retry"], T0 + 40 + 40)                  # backoff 40 s after the 4th failure

    def test_backoff_doubles_to_a_5_minute_cap_and_logs_one_line_per_step(self):
        self.token_env()
        self.poster.status = 503
        at, backs = T0, [5, 10, 20, 40, 80, 160, 300, 300]
        for i, b in enumerate(backs):
            self.f.on_health("r1", health("RECORDER_DOWN"), at)
            self.assertEqual(len(self.poster.calls), i + 1)
            at = at + b                                                    # next attempt exactly at next_retry
        st = json.load(open(self.state))["rooms"]["r1"]
        self.assertEqual(st["fails"], 8)
        self.assertEqual(st["backoff_s"], 300)                            # capped: the 8th failure does not grow past 5 min
        self.assertEqual(st["next_retry"], at - 300 + 300)
        steps = [l for l in open(self.audit).read().splitlines() if "sentinel_backoff" in l]
        self.assertEqual(len(steps), 7)                                   # one line per step (5,10,20,40,80,160,300), not per item
        self.assertEqual([json.loads(l)["backoff_s"] for l in steps], [5, 10, 20, 40, 80, 160, 300])

    def test_code_change_during_backoff_posts_immediately(self):
        self.token_env()
        self.poster.status = 503
        self.f.on_health("r1", health("RECORDER_DOWN"), T0)                # fails, backoff 5 s
        self.clock.adv(2); self.f.on_health("r1", health("PRESENCE_DEAD"), T0 + 2)
        self.assertEqual(len(self.poster.calls), 2)                       # a NEW state is not rate-limited away
        self.assertEqual(self.poster.calls[-1]["body"]["events"][0]["payload"]["code"], "PRESENCE_DEAD")

    def test_event_shape_and_seq_never_reused(self):
        self.token_env()
        self.f.on_health("r1", health("TAILNET_DOWN", mic_class="unknown"), T0)
        self.clock.adv(70); self.f.on_health("r1", health("TAILNET_DOWN", mic_class="unknown"), T0 + 70)
        ev0 = self.poster.calls[0]["body"]["events"][0]
        ev1 = self.poster.calls[1]["body"]["events"][0]
        self.assertEqual(ev0["kind"], sf.KIND)
        self.assertEqual(ev0["source"], sf.SOURCE)
        self.assertEqual(ev0["machine"], "r1")
        self.assertEqual(ev0["room_id"], "r1")
        self.assertEqual(ev0["install_id"], "mini-sentinel-forwarder")
        self.assertEqual(ev0["boot_id"], str(T0))
        self.assertTrue(ev0["ts"].endswith("Z"))
        self.assertEqual(sorted(ev0["payload"]), ["code", "last_action", "last_result", "mic_class", "mode", "peak", "zr"])
        self.assertEqual(ev1["seq"], ev0["seq"] + 1)
        st = json.load(open(self.state))
        self.assertEqual(st["seq"], 2)
        self.assertEqual(st["rooms"]["r1"], {"code": "TAILNET_DOWN", "posted_at": T0 + 70, "pending_code": None, "fails": 0,
                                             "next_retry": None, "backoff_s": 0, "attempted_at": T0 + 70})
        # a restart (a new forwarder on the same state file) continues the seq, never reuses it
        f2 = sf.SentinelForward(self.poster, self.state, self.clock, self.audit, background=False)
        self.clock.adv(70); f2.on_health("r1", health("TAILNET_DOWN", mic_class="unknown"), T0 + 140)
        self.assertEqual(self.poster.calls[-1]["body"]["events"][0]["seq"], 3)

    def test_token_comes_from_the_poller_config_and_is_never_logged(self):
        self.token_env("sentinel-tok-secret")
        os.environ["MICGUARD_INGEST_URL"] = "https://example.test/api/kiosk-health"
        self.addCleanup(os.environ.pop, "MICGUARD_INGEST_URL", None)
        self.f.on_health("r1", health("MIC_PERM"), T0)
        c = self.poster.calls[0]
        self.assertEqual(c["url"], "https://example.test/api/kiosk-health")
        self.assertEqual(c["token"], "sentinel-tok-secret")
        for line in open(self.audit).read().splitlines():
            self.assertNotIn("sentinel-tok-secret", line)
        self.assertNotIn("sentinel-tok-secret", json.dumps(self.poster.calls[0]["body"]))


class QueueTests(unittest.TestCase):
    """F1: the background queue is bounded (drop-oldest, counted) and holds one pending post per room (latest wins)."""

    def setUp(self):
        self.home = mk_home()
        self.f = sf.SentinelForward(Poster(), os.path.join(self.home, "data", "sentinel-forward-state.json"),
                                    Clock(T0), os.path.join(self.home, "logs", "sentinel-forward-audit.jsonl"), background=True)

    def test_queue_is_bounded_and_drops_the_oldest_counting_the_drop(self):
        for i in range(sf.MAX_PENDING + 4):
            self.f._queue_item(f"r{i}", "OK", b"{}" , T0 + i)
        self.assertEqual(len(self.f._queued), sf.MAX_PENDING)
        self.assertEqual(self.f.drops, 4)
        self.assertNotIn("r0", self.f._queued)                            # the four oldest are gone
        self.assertNotIn("r3", self.f._queued)
        self.assertIn("r4", self.f._queued)
        self.assertIn(f"r{sf.MAX_PENDING + 3}", self.f._queued)
        self.assertEqual(json.load(open(os.path.join(self.home, "data", "sentinel-forward-state.json")))["drops"], 4)

    def test_a_newer_line_for_a_queued_room_replaces_the_body_latest_wins(self):
        self.f._queue_item("r1", "OK", b'{"a":1}', T0)
        self.f._queue_item("r1", "RECORDER_DOWN", b'{"a":2}', T0 + 10)
        self.assertEqual(len(self.f._queued), 1)
        self.assertEqual(self.f._queued["r1"][0], "RECORDER_DOWN")
        self.assertEqual(self.f._queued["r1"][1], b'{"a":2}')
        self.assertEqual(self.f.drops, 0)


class FlagDefaultTests(unittest.TestCase):
    """P6: the flag defaults to false -- only a literal true turns the forwarder on."""

    def _cfg(self, **extra):
        import ubus_bus
        t = tempfile.mkdtemp()
        p = os.path.join(t, "router.json")
        json.dump(dict({"to": ["a"], "ackers": ["a"]}, **extra), open(p, "w"))
        return ubus_bus.load_cfg(p)

    def test_absent_key_defaults_false(self):
        self.assertIs(self._cfg()["sentinel_forward"], False)

    def test_only_a_literal_true_turns_it_on(self):
        self.assertIs(self._cfg(sentinel_forward=True)["sentinel_forward"], True)
        for bad in ("true", 1, "yes", None, {}):
            self.assertIs(self._cfg(sentinel_forward=bad)["sentinel_forward"], False)


class WiringTests(unittest.TestCase):
    def test_flag_off_build_subscriber_has_no_forwarder_and_posts_nothing(self):
        rs = importlib.import_module("run_subscriber")
        home = mk_home()
        s = rs.build_subscriber({}, ["r1"], {}, Sink(), home, Clock(T0))
        self.assertIsNone(s.sentinel)
        self.assertTrue(s.on_line("kiosk/r1/health", json.dumps(health("MIC_MUTED_TONOR")) + "\n"))
        self.assertEqual(self._posts(home), [])
        self.assertFalse(os.path.exists(os.path.join(home, "data", "sentinel-forward-state.json")))

    def test_flag_on_build_subscriber_wires_the_forwarder(self):
        rs = importlib.import_module("run_subscriber")
        home = mk_home()
        s = rs.build_subscriber({}, ["r1"], {"sentinel_forward": True}, Sink(), home, Clock(T0))
        self.assertIsNotNone(s.sentinel)
        if s.sentinel._worker is not None:
            self.addCleanup(s.sentinel._worker.join, 5)

    def test_subscriber_health_line_drives_the_forwarder(self):
        home = mk_home()
        poster = Poster()
        f = sf.SentinelForward(poster, os.path.join(home, "data", "sentinel-forward-state.json"), Clock(T0),
                               os.path.join(home, "logs", "sentinel-forward-audit.jsonl"), background=False)
        self.token_env()
        s = sb.Subscriber(os.path.join(home, "data"), os.path.join(home, "etc"), ("r1",), Sink(), Clock(T0), sentinel=f)
        self.assertTrue(s.on_line("kiosk/r1/health", json.dumps(health("PRESENCE_DEAD")) + "\n"))
        self.assertEqual(len(poster.calls), 1)
        self.assertEqual(poster.calls[0]["body"]["events"][0]["payload"]["code"], "PRESENCE_DEAD")

    def test_background_flag_on_posts_via_worker_thread(self):
        home = mk_home()
        poster = Poster()
        f = sf.build({}, home, clock=Clock(T0), poster=poster, background=True)
        self.token_env()
        f.on_health("r1", health("OK"), T0)
        deadline = time.time() + 5
        while not poster.calls and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(poster.calls), 1)
        if f._worker is not None:
            f._worker.join(5)

    def _posts(self, home):
        p = os.path.join(home, "logs", "sentinel-forward-audit.jsonl")
        return [l for l in open(p).read().splitlines() if l] if os.path.exists(p) else []

    def token_env(self, token="sentinel-tok-secret"):
        t = tempfile.NamedTemporaryFile("w", suffix=".token", delete=False)
        t.write(token); t.close()
        self.addCleanup(os.unlink, t.name)
        old = os.environ.get("MICGUARD_TOKEN_FILE")
        os.environ["MICGUARD_TOKEN_FILE"] = t.name
        self.addCleanup(lambda: os.environ.pop("MICGUARD_TOKEN_FILE", None) if old is None else os.environ.__setitem__("MICGUARD_TOKEN_FILE", old))


if __name__ == "__main__":
    unittest.main()
