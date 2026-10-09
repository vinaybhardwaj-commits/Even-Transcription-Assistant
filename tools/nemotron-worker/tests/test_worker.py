"""Unit tests for the Nemotron worker's client loop against a fake server. Standard library only:

    python3 -m unittest discover -s tools/nemotron-worker/tests -v

The fake server plays the three merged routes (pending / ingest / heartbeat) plus the presigned clip GET. The engine
is a stub; decode is a stub (no ffmpeg). Real code under test: Api, fetch_clip, Worker.step/process/post_ingest,
to_turns, the backoff, the rate cap, the VRAM wait, SIGTERM handling, the temp-dir lifetime and what is logged.
Fixtures are typed by hand (ids, bytes, hashes), never derived from the code under test.
"""
import hashlib
import io
import json
import logging
import os
import signal
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import worker  # noqa: E402

TOKEN = "tok-test-7f3a9c"  # synthetic
CLIP_BYTES = b"RIFF-not-really-audio-0123456789"
# canonical-JSON sha256 of StubEngine.config, computed with lib/diarize-nemotron/validate.ts configHash (tsx) and pinned.
STOCK_CONFIG = {"spkcache_len": 264, "fifo_len": 40, "chunk_len": 340, "chunk_right_context": 40,
                "spkcache_update_period": 300, "sample_rate": 16000, "batch_size": 1, "latency": "offline_30.4s",
                "checkpoint": "stock"}
STOCK_CONFIG_HASH_TS = "c80a0d84dba75ecba400ab98e5cfaa511bf84ae8a8c396e9803a937e4b1796c6"


class FakeServer:
    """Scripted routes. `pending` is a list of (status, body) served in order, then {"windows": []}.
    `ingest` is a list of (status, body) served in order, then 200 stored."""

    def __init__(self):
        self.pending, self.ingest = [], []
        self.posts, self.heartbeats, self.pending_calls, self.clip_gets = [], [], [], 0
        self.clips = {}  # path -> (status, bytes)
        self.auth_seen = set()
        self.elsewhere = 0  # requests that reached a redirect target (must stay 0)
        self.on_ingest = None
        srv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body):
                loc = body.pop("_location", None) if isinstance(body, dict) else None
                raw = json.dumps(body).encode() if isinstance(body, dict) else body
                self.send_response(status)
                if loc:
                    self.send_header("location", srv.base + loc)
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                u = urlparse(self.path)
                if u.path.startswith("/elsewhere"):
                    srv.elsewhere += 1
                    return self._send(200, {"ok": True, "windows": [], "exhausted": 0})
                if u.path.startswith("/clips/"):
                    srv.clip_gets += 1
                    st, b = srv.clips.get(u.path, (404, b"no"))
                    return self._send(st, b)
                srv.auth_seen.add(self.headers.get("authorization"))
                if u.path == "/api/diarize/nemotron/pending":
                    srv.pending_calls.append(parse_qs(u.query))
                    st, b = srv.pending.pop(0) if srv.pending else (200, {"ok": True, "windows": [], "exhausted": 0})
                    return self._send(st, b)
                self._send(404, {"error": "nope"})

            def do_POST(self):
                if self.path.startswith("/elsewhere"):
                    srv.elsewhere += 1
                    return self._send(200, {"ok": True, "result": "stored"})
                srv.auth_seen.add(self.headers.get("authorization"))
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                if self.path == "/api/diarize/nemotron/ingest":
                    srv.posts.append(body)
                    if srv.on_ingest:
                        srv.on_ingest(body)
                    st, b = srv.ingest.pop(0) if srv.ingest else (200, {"ok": True, "result": "stored", "id": "x"})
                    return self._send(st, b)
                if self.path == "/api/diarize/nemotron/heartbeat":
                    srv.heartbeats.append(body)
                    return self._send(200, {"ok": True})
                self._send(404, {"error": "nope"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def window(self, wid, clip="/clips/a", attempt=1):
        return {"window_id": wid, "room_day_id": "rd_fake1", "start_ms": 0, "end_ms": 900000,
                "clip_url": self.base + clip + "?X-Amz-Signature=sekret-sig", "clip_sha256": None, "attempt": attempt}

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class StubEngine:
    model = "nvidia/Nemotron-3-Diarization"
    model_rev = "f667ed73aee57d40cc39428eb768b4fd87a0a29e"
    config = dict(STOCK_CONFIG)

    def __init__(self, segments=None, raise_exc=None, hook=None):
        self.segments = segments if segments is not None else [(1.0004, 2.5, "speaker_1"), (0.2, 1.1, "speaker_0"), (3.0, 3.0, "speaker_2")]
        self.raise_exc, self.hook, self.calls, self.seen_files = raise_exc, hook, 0, []

    def diarize(self, wav):
        self.calls += 1
        self.seen_files.append(wav)
        assert os.path.exists(wav), "the decoded audio must exist during inference"
        if self.hook:
            self.hook()
        if self.raise_exc:
            raise self.raise_exc
        return list(self.segments)


def stub_decode(src, wav):
    with open(src, "rb") as f:
        data = f.read()
    if data.startswith(b"BAD"):
        raise worker.DecodeError("x")
    with open(wav, "wb") as f:
        f.write(b"wav")
    return 60_000


def local_fetch(url, dest, max_bytes, timeout_s):
    """The real fetch_clip, widened to http ONLY so the localhost fake server can serve clips."""
    return worker.fetch_clip(url, dest, max_bytes, timeout_s, schemes=("https", "http"))


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t
        self.sleeps = []

    def __call__(self):
        return self.t


class Base(unittest.TestCase):
    def setUp(self):
        self.srv = FakeServer()
        self.srv.clips["/clips/a"] = (200, CLIP_BYTES)
        self.tmp = tempfile.mkdtemp(prefix="nw-test-")
        self.clock = Clock()
        self.stop = threading.Event()
        self.logbuf = io.StringIO()
        h = logging.StreamHandler(self.logbuf)
        h.setLevel(logging.DEBUG)
        worker.log.addHandler(h)
        worker.log.setLevel(logging.DEBUG)
        self.addCleanup(worker.log.removeHandler, h)
        self.addCleanup(self.srv.close)

    def make(self, engine=None, free=None, fetch=None, **cfg):
        c = worker.Config(base_url=self.srv.base, worker_id="box-test", backoff_min_s=30, backoff_max_s=900,
                          idle_poll_s=60, tmp_root=self.tmp, ingest_retries=2, **cfg)

        def sleep(s):
            self.clock.sleeps.append(s)
            self.clock.t += s
            if len(self.clock.sleeps) >= 50:  # a loop that should have ended fails its assertions instead of hanging
                self.stop.set()
            return self.stop.is_set()

        w = worker.Worker(c, worker.Api(self.srv.base, TOKEN, timeout_s=5), engine or StubEngine(), stop=self.stop,
                          clock=self.clock, sleep=sleep, free_vram=(lambda: free), decode=stub_decode,
                          gpu_name=lambda: "Tesla T4", retry_sleep=lambda s: self.clock.sleeps.append(("retry", s)),
                          fetch=fetch or local_fetch)
        w.backoff.rng = lambda: 0.5  # no jitter in tests: factor 1.0
        return w

    def assertTmpEmpty(self):
        self.assertEqual(os.listdir(self.tmp), [], "audio must be deleted after every window")


class HappyPath(Base):
    def test_pending_fetch_infer_ingest(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        eng = StubEngine()
        w = self.make(eng)
        self.assertTrue(w.step())
        self.assertEqual(len(self.srv.posts), 1)
        b = self.srv.posts[0]
        self.assertEqual(sorted(b), sorted(["window_id", "room_day_id", "engine", "model", "model_rev", "config", "config_hash",
                                            "worker_id", "machine", "audio_ms", "clip_sha256", "status", "error_code", "turns"]))
        self.assertEqual(b["window_id"], "bw_fake_1")
        self.assertEqual(b["room_day_id"], "rd_fake1")
        self.assertEqual(b["engine"], "nemotron")
        self.assertEqual(b["machine"], "box")
        self.assertEqual(b["worker_id"], "box-test")
        self.assertEqual(b["status"], "ok")
        self.assertIsNone(b["error_code"])
        self.assertEqual(b["audio_ms"], 60000)
        self.assertEqual(b["clip_sha256"], hashlib.sha256(CLIP_BYTES).hexdigest())
        self.assertEqual(b["config_hash"], STOCK_CONFIG_HASH_TS)
        # seconds → ms, sorted by start, labels by first speech, zero-length dropped
        self.assertEqual(b["turns"], [[200, 1100, "spk0"], [1000, 2500, "spk1"]])
        self.assertEqual(self.srv.auth_seen, {f"Bearer {TOKEN}"})
        self.assertEqual(self.srv.pending_calls[0]["worker_id"], ["box-test"])
        self.assertEqual(self.srv.pending_calls[0]["limit"], ["1"])
        self.assertEqual(eng.calls, 1)
        self.assertFalse(os.path.exists(eng.seen_files[0]))
        self.assertTmpEmpty()

    def test_empty_result_posts_empty(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_2")], "exhausted": 0})]
        self.make(StubEngine(segments=[])).step()
        b = self.srv.posts[0]
        self.assertEqual((b["status"], b["turns"], b["error_code"]), ("empty", [], None))
        self.assertEqual(b["clip_sha256"], hashlib.sha256(CLIP_BYTES).hexdigest())

    def test_no_windows_sleeps_idle_poll(self):
        w = self.make()
        self.assertTrue(w.step())
        self.assertEqual(self.clock.sleeps, [60])
        self.assertEqual(self.srv.posts, [])


class Backoff(Base):
    def test_404_disabled_and_503_not_configured_back_off_then_reset(self):
        self.srv.pending = [(404, {"ok": False, "error": "disabled"}), (503, {"ok": False, "error": "not_configured"}),
                            (503, {"ok": False, "error": "db"}), (401, {"ok": False, "error": "unauthorized"}),
                            (200, {"ok": True, "windows": [], "exhausted": 0}),
                            (404, {"ok": False, "error": "disabled"})]
        w = self.make()
        for _ in range(6):
            self.assertTrue(w.step())
        # 30, 60, 120, 240 (doubling), then the idle poll, then reset to 30 after the 200
        self.assertEqual(self.clock.sleeps, [30, 60, 120, 240, 60, 30])
        self.assertEqual(self.srv.posts, [])
        self.assertEqual(self.srv.clip_gets, 0)

    def test_backoff_caps_at_15_min(self):
        self.srv.pending = [(404, {"ok": False, "error": "disabled"})] * 9
        w = self.make()
        for _ in range(9):
            w.step()
        self.assertEqual(self.clock.sleeps[-3:], [900, 900, 900])

    def test_network_failure_backs_off(self):
        w = self.make()
        w.api = worker.Api("http://127.0.0.1:9", TOKEN, timeout_s=2)  # nothing listens on port 9
        self.assertTrue(w.step())
        self.assertEqual(self.clock.sleeps, [30])
        self.assertEqual(w.last_error_code, "network")


class IngestOutcomes(Base):
    def test_409_conflict_moves_on_to_next_window(self):
        self.srv.clips["/clips/b"] = (200, b"second clip bytes")
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1"), self.srv.window("bw_fake_2", "/clips/b")], "exhausted": 0})]
        self.srv.ingest = [(409, {"ok": False, "error": "conflict"})]
        w = self.make(concurrency=2)
        w.cfg.concurrency = 1  # claim 2, process serially
        w.step()
        self.assertEqual([p["window_id"] for p in self.srv.posts], ["bw_fake_1", "bw_fake_2"])
        self.assertEqual(w.counts["conflict"], 1)
        self.assertEqual(w.counts["stored"], 1)

    def test_duplicate_moves_on_without_retry(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.srv.ingest = [(200, {"ok": True, "result": "duplicate"})]
        w = self.make()
        w.step()
        self.assertEqual(len(self.srv.posts), 1)
        self.assertEqual(w.counts["duplicate"], 1)

    def test_blind_and_unknown_window_move_on(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0}),
                            (200, {"ok": True, "windows": [self.srv.window("bw_fake_2")], "exhausted": 0})]
        self.srv.ingest = [(403, {"ok": False, "error": "blind_room_day"}), (404, {"ok": False, "error": "unknown_window"})]
        w = self.make()
        w.step(); w.step()
        self.assertEqual(len(self.srv.posts), 2)
        self.assertEqual((w.counts["blind_room_day"], w.counts["unknown_window"]), (1, 1))

    def test_ingest_503_is_retried_then_stored(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.srv.ingest = [(503, {"ok": False, "error": "db"}), (200, {"ok": True, "result": "stored", "id": "n1"})]
        w = self.make()
        w.step()
        self.assertEqual(len(self.srv.posts), 2)
        self.assertEqual(self.srv.posts[0], self.srv.posts[1], "a retry re-posts the identical body")
        self.assertEqual(w.counts["stored"], 1)
        self.assertIn(("retry", 5.0), self.clock.sleeps)

    def test_ingest_gives_up_after_retries(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.srv.ingest = [(503, {"ok": False, "error": "db"})] * 3
        w = self.make()
        w.step()
        self.assertEqual(len(self.srv.posts), 3)  # 1 + ingest_retries(2)
        self.assertEqual(w.counts["ingest_gave_up"], 1)


class Failures(Base):
    def test_fetch_failure_posts_fetch_failed(self):
        self.srv.clips["/clips/a"] = (403, b"denied")
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1", attempt=2)], "exhausted": 0})]
        self.srv.ingest = [(200, {"ok": True, "result": "failure_recorded", "attempts": 2})]
        eng = StubEngine()
        w = self.make(eng)
        w.step()
        b = self.srv.posts[0]
        self.assertEqual((b["status"], b["error_code"], b["clip_sha256"], b["audio_ms"], b["turns"]),
                         ("failed", "fetch_failed", None, 0, []))
        self.assertEqual(eng.calls, 0)
        self.assertEqual(w.counts["failure_recorded"], 1)
        self.assertTmpEmpty()

    def test_decode_failure_posts_decode_failed_with_hash(self):
        bad = b"BAD audio bytes"
        self.srv.clips["/clips/a"] = (200, bad)
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        eng = StubEngine()
        self.make(eng).step()
        b = self.srv.posts[0]
        self.assertEqual((b["status"], b["error_code"], b["audio_ms"], b["turns"]), ("failed", "decode_failed", 0, []))
        self.assertEqual(b["clip_sha256"], hashlib.sha256(bad).hexdigest())
        self.assertEqual(eng.calls, 0)
        self.assertTmpEmpty()

    def test_engine_exception_posts_infer_failed_and_oom_posts_gpu_oom(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0}),
                            (200, {"ok": True, "windows": [self.srv.window("bw_fake_2")], "exhausted": 0})]
        w = self.make(StubEngine(raise_exc=ValueError("/secret/path/clip.wav broke")))
        w.step()
        w.engine = StubEngine(raise_exc=RuntimeError("CUDA out of memory. Tried to allocate"))
        w.step()
        self.assertEqual([p["error_code"] for p in self.srv.posts], ["infer_failed", "gpu_oom"])
        self.assertEqual([p["audio_ms"] for p in self.srv.posts], [60000, 60000])
        self.assertNotIn("/secret/path", self.logbuf.getvalue())
        self.assertTmpEmpty()

    def test_too_many_speakers_is_a_failure_not_a_bad_post(self):
        segs = [(i, i + 0.5, f"speaker_{i}") for i in range(9)]
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.make(StubEngine(segments=segs)).step()
        self.assertEqual(self.srv.posts[0]["error_code"], "too_many_speakers")


class Manners(Base):
    def test_vram_short_waits_and_does_not_claim(self):
        w = self.make(free=1000, min_free_vram_mib=2048, vram_poll_s=30)
        self.assertTrue(w.step())
        self.assertEqual(self.srv.pending_calls, [])
        self.assertEqual(self.clock.sleeps, [30])

    def test_rate_cap(self):
        self.srv.clips["/clips/b"] = (200, b"b")
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0}),
                            (200, {"ok": True, "windows": [self.srv.window("bw_fake_2", "/clips/b")], "exhausted": 0})]
        w = self.make(rate_per_hour=2)
        w.step(); w.step()
        self.assertEqual(len(self.srv.posts), 2)
        w.step()  # third: capped, sleeps until the first start is an hour old, no claim
        self.assertEqual(len(self.srv.pending_calls), 2)
        self.assertEqual(self.clock.sleeps[-1], 3601)

    def test_gpu_lock_is_taken_during_inference_and_released(self):
        import fcntl
        lock = os.path.join(self.tmp + "-lock")
        self.addCleanup(lambda: os.path.exists(lock) and os.remove(lock))
        held = []

        def probe():
            fd = os.open(lock, os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                held.append(False)
                fcntl.flock(fd, fcntl.LOCK_UN)
            except BlockingIOError:
                held.append(True)
            finally:
                os.close(fd)

        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.make(StubEngine(hook=probe), gpu_lock=lock).step()
        self.assertEqual(held, [True])
        probe()
        self.assertEqual(held, [True, False])

    def test_heartbeat_body(self):
        w = self.make()
        w.counts["stored"] = 3
        self.assertEqual(w.heartbeat_once(), 200)
        hb = self.srv.heartbeats[0]
        self.assertEqual(hb["worker_id"], "box-test")
        self.assertEqual(hb["gpu"], "Tesla T4")
        self.assertEqual(hb["model_rev"], "f667ed73aee57d40cc39428eb768b4fd87a0a29e")
        self.assertEqual(hb["config_hash"], STOCK_CONFIG_HASH_TS)
        self.assertEqual(set(hb) - {"worker_id", "host", "gpu", "model_rev", "config_hash", "queue_depth", "windows_24h",
                                    "last_ok_at", "last_error_code"}, set())


class Shutdown(Base):
    def test_sigterm_mid_inference_still_posts_then_exits(self):
        """A real SIGTERM, delivered while the engine runs: the window is posted, no new claim, run() returns 0."""
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0}),
                            (200, {"ok": True, "windows": [self.srv.window("bw_fake_2")], "exhausted": 0})]
        prev = signal.signal(signal.SIGTERM, lambda *_: self.stop.set())
        self.addCleanup(signal.signal, signal.SIGTERM, prev)
        w = self.make(StubEngine(hook=lambda: os.kill(os.getpid(), signal.SIGTERM)))
        self.assertEqual(w.run(), 0)
        self.assertEqual([p["window_id"] for p in self.srv.posts], ["bw_fake_1"])
        self.assertEqual(len(self.srv.pending_calls), 1)
        self.assertEqual(w.state, "stopped")
        self.assertTmpEmpty()

    def test_stop_before_a_cycle_claims_nothing(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        w = self.make()
        self.stop.set()
        self.assertFalse(w.step())
        self.assertEqual(self.srv.pending_calls, [])

    def test_stop_while_waiting_for_gpu_abandons_unposted(self):
        import fcntl
        lock = self.tmp + "-lock2"
        self.addCleanup(lambda: os.path.exists(lock) and os.remove(lock))
        fd = os.open(lock, os.O_RDWR | os.O_CREAT)
        fcntl.flock(fd, fcntl.LOCK_EX)  # another GPU job holds the lock
        self.addCleanup(os.close, fd)
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        w = self.make(gpu_lock=lock)
        w.gpu.poll_s = 0.05
        threading.Timer(0.3, self.stop.set).start()
        self.assertFalse(w.step())
        self.assertEqual(self.srv.posts, [])
        self.assertEqual(w.counts["abandoned"], 1)
        self.assertTmpEmpty()


class Hygiene(Base):
    def test_logs_and_state_never_carry_url_token_or_turns(self):
        state = os.path.join(self.tmp + "-state.json")
        self.addCleanup(lambda: os.path.exists(state) and os.remove(state))
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.srv.clips["/clips/c"] = (500, b"x")
        self.srv.pending.append((200, {"ok": True, "windows": [self.srv.window("bw_fake_2", "/clips/c")], "exhausted": 0}))
        w = self.make(state_file=state)
        w.step(); w.step(); w.heartbeat_once()
        blob = self.logbuf.getvalue() + open(state).read()
        for bad in ("sekret-sig", "/clips/", TOKEN, "127.0.0.1", "spk0", "speaker_"):
            self.assertNotIn(bad, blob)
        self.assertIn("window=bw_fake_1", blob)

    def test_token_file_must_be_0600(self):
        p = os.path.join(self.tmp + "-tok")
        self.addCleanup(lambda: os.path.exists(p) and os.remove(p))
        with open(p, "w") as f:
            f.write(TOKEN + "\n")
        os.chmod(p, 0o644)
        with self.assertRaises(SystemExit):
            worker.read_token(p)
        os.chmod(p, 0o600)
        self.assertEqual(worker.read_token(p), TOKEN)

    def test_canonical_json_matches_ts(self):
        # Both literals produced by lib/diarize-nemotron/validate.ts (canonicalJson / configHash) via tsx.
        self.assertEqual(worker.canonical_json({"b": True, "a": 7, "z": "x y/z"}), '{"a":7,"b":true,"z":"x y/z"}')
        self.assertEqual(worker.config_hash({"b": True, "a": 7, "z": "x y/z"}),
                         "e1114f28170ca2ef09f25b86512b6689300887587e3c05ba3d3b2988ac303332")
        self.assertEqual(worker.config_hash(STOCK_CONFIG), STOCK_CONFIG_HASH_TS)

    def test_to_turns_rules(self):
        segs = [(0.0, 0.0004, "a"), (-0.5, 0.25, "b"), (59.9, 61.0, "a"), (0.1, 0.3, "a")]
        self.assertEqual(worker.to_turns(segs, 60000), [[0, 250, "spk0"], [100, 300, "spk1"], [59900, 60000, "spk1"]])


if __name__ == "__main__":
    unittest.main()


class Hardening(Base):
    """gating-lead follow-up, 9 Oct: no redirects, https-only clips, NaN guard, temp sweep, base URL, stop wait."""

    def test_3xx_from_pending_is_a_hard_stop_and_never_followed(self):
        self.srv.pending = [(302, {"_location": "/elsewhere/pending"})]
        w = self.make()
        self.assertEqual(w.run(), 3)
        self.assertEqual(self.srv.elsewhere, 0)
        self.assertEqual(w.fatal, "redirect_302")
        self.assertEqual(w.state, "fatal:redirect_302")
        self.assertEqual(len(self.srv.pending_calls), 1)

    def test_3xx_from_ingest_is_a_hard_stop_without_retry(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0}),
                            (200, {"ok": True, "windows": [self.srv.window("bw_fake_2")], "exhausted": 0})]
        self.srv.ingest = [(307, {"_location": "/elsewhere/ingest"})]
        w = self.make()
        self.assertEqual(w.run(), 3)
        self.assertEqual(len(self.srv.posts), 1)
        self.assertEqual(self.srv.elsewhere, 0)
        self.assertEqual(len(self.srv.pending_calls), 1, "no new claim after a hard stop")
        self.assertTmpEmpty()

    def test_3xx_from_heartbeat_is_a_hard_stop(self):
        w = self.make()
        w.api = worker.Api(self.srv.base + "/redir-hb", TOKEN, timeout_s=5)
        orig = self.srv.httpd.RequestHandlerClass.do_POST

        def do_post(h):
            if h.path.startswith("/redir-hb"):
                return h._send(308, {"_location": "/elsewhere/hb"})
            return orig(h)
        self.srv.httpd.RequestHandlerClass.do_POST = do_post
        self.addCleanup(setattr, self.srv.httpd.RequestHandlerClass, "do_POST", orig)
        t = threading.Thread(target=w.heartbeat_loop, daemon=True)
        t.start()
        t.join(5)  # a hard stop ends the loop at once; anything else would sit in its 60 s wait
        stopped_by_itself = not t.is_alive()
        self.stop.set()
        t.join(5)
        self.assertTrue(stopped_by_itself)
        self.assertEqual((w.fatal, self.srv.elsewhere), ("redirect_308", 0))

    def test_clip_redirect_is_not_followed(self):
        self.srv.clips["/clips/a"] = (302, {"_location": "/elsewhere/clip"})
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.make().step()
        self.assertEqual(self.srv.posts[0]["error_code"], "fetch_failed")
        self.assertEqual(self.srv.elsewhere, 0)

    def test_fetch_clip_accepts_https_only(self):
        src = os.path.join(self.tmp, "local.bin")
        with open(src, "wb") as f:
            f.write(b"local file bytes")
        dest = os.path.join(self.tmp, "out.bin")
        for url in ("file://" + src, self.srv.base + "/clips/a", "ftp://example.invalid/x", "/clips/a"):
            with self.assertRaises(worker.FetchError) as cm:
                worker.fetch_clip(url, dest, 1 << 20, 5)
            self.assertEqual(str(cm.exception), "bad_scheme")
            self.assertFalse(os.path.exists(dest))
        self.assertEqual(self.srv.clip_gets, 0)
        os.remove(src)

    def test_production_fetch_refuses_an_http_clip_url(self):
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window("bw_fake_1")], "exhausted": 0})]
        self.make(fetch=worker.fetch_clip).step()  # the default, unwidened fetch
        self.assertEqual((self.srv.posts[0]["status"], self.srv.posts[0]["error_code"]), ("failed", "fetch_failed"))
        self.assertEqual(self.srv.clip_gets, 0)

    def test_nan_inf_or_junk_segments_post_infer_failed(self):
        bad = [[(float("nan"), 1.0, "speaker_0")], [(0.0, float("inf"), "speaker_0")], [("x", 1.0, "speaker_0")],
               [(0.5, 1.0, "speaker_0"), (float("-inf"), 2.0, "speaker_1")]]
        self.srv.pending = [(200, {"ok": True, "windows": [self.srv.window(f"bw_fake_{i}")], "exhausted": 0}) for i in range(len(bad))]
        w = self.make()
        for segs in bad:
            w.engine = StubEngine(segments=segs)
            w.step()
        self.assertEqual([(p["status"], p["error_code"], p["turns"]) for p in self.srv.posts], [("failed", "infer_failed", [])] * 4)
        self.assertTmpEmpty()

    def test_sweep_removes_only_own_old_nemo_dirs(self):
        root = tempfile.mkdtemp(prefix="nw-sweep-")
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        old, fresh, other = (os.path.join(root, n) for n in ("nemo-w-old", "nemo-w-fresh", "keep-me"))
        for d in (old, fresh, other):
            os.mkdir(d)
            with open(os.path.join(d, "clip.bin"), "wb") as f:
                f.write(b"x")
        target = tempfile.mkdtemp(prefix="nw-target-")
        self.addCleanup(lambda: __import__("shutil").rmtree(target, ignore_errors=True))
        os.symlink(target, os.path.join(root, "nemo-w-link"))
        with open(os.path.join(root, "nemo-w-file"), "w") as f:
            f.write("x")
        now = 1_800_000_000.0
        for p in (old, other, os.path.join(root, "nemo-w-file")):
            os.utime(p, (now - 7200, now - 7200))
        os.utime(fresh, (now - 600, now - 600))
        os.utime(os.path.join(root, "nemo-w-link"), (now - 7200, now - 7200), follow_symlinks=False)
        self.assertEqual(worker.sweep_stale_tmp(root, now), 1)
        self.assertEqual(sorted(os.listdir(root)), ["keep-me", "nemo-w-file", "nemo-w-fresh", "nemo-w-link"])
        self.assertTrue(os.path.isdir(target))

    def test_base_url_policy(self):
        ok = worker.check_base_url
        self.assertIsNone(ok("https://www.evenscribe.app", {}))
        self.assertIsNone(ok("https://www.evenscribe.app/", {}))
        for bad in ("https://evenscribe.app", "http://www.evenscribe.app", "https://www.evenscribe.app.evil.example",
                    "https://www.evenscribe.app:8443", "https://u@www.evenscribe.app", "https://www.evenscribe.app/api",
                    "http://127.0.0.1:3000", "", None):
            self.assertIsNotNone(ok(bad, {}), bad)
        self.assertIsNone(ok("http://127.0.0.1:3000", {"NEMOTRON_ALLOW_OTHER_BASE_URL": "1"}))
        self.assertIsNotNone(ok("http://127.0.0.1:3000", {"NEMOTRON_ALLOW_OTHER_BASE_URL": "yes"}))
        self.assertIsNotNone(ok("file:///etc/passwd", {"NEMOTRON_ALLOW_OTHER_BASE_URL": "1"}))
        self.assertEqual(worker.DEFAULT_BASE_URL, "https://www.evenscribe.app")

    def test_stop_waits_at_least_150_s(self):
        import re
        sh = open(os.path.join(os.path.dirname(__file__), "..", "nemotron-worker.sh")).read()
        m = re.search(r"^STOP_WAIT_S=(\d+)$", sh, re.M)
        self.assertIsNotNone(m)
        self.assertGreaterEqual(int(m.group(1)), 150)
        self.assertIn('seq 1 "$STOP_WAIT_S"', sh)
        self.assertNotIn("NEMOTRON_BASE_URL is required", sh)
