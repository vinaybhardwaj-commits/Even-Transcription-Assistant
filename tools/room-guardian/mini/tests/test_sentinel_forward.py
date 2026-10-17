import importlib, json, os, sys, tempfile, threading, time, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "subscriber"))
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

    def test_post_failure_is_not_marked_and_retries(self):
        self.token_env()
        self.poster.status = 500
        self.f.on_health("r1", health("RECORDER_DOWN"), T0)
        self.assertEqual(len(self.poster.calls), 1)
        self.clock.adv(15); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 15)
        self.assertEqual(len(self.poster.calls), 2)                       # failed send: retried on the next line, not rate-limited away
        self.poster.status = 200
        self.clock.adv(15); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 30)
        self.assertEqual(len(self.poster.calls), 3)
        self.clock.adv(15); self.f.on_health("r1", health("RECORDER_DOWN"), T0 + 45)
        self.assertEqual(len(self.poster.calls), 3)                       # now marked: back inside the 60 s window
        audit = open(self.audit).read()
        self.assertIn("sentinel_post_failed", audit)
        self.assertIn("sentinel_forwarded", audit)

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
        self.assertEqual(st["rooms"]["r1"], {"code": "TAILNET_DOWN", "posted_at": T0 + 70})
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
