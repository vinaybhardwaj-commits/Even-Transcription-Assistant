"""FR1 stream byte cap + bounded concurrent control publish. Stdlib unittest. Nothing here prints line content."""
import json, os, subprocess, sys, tempfile, threading, time, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
from test_subscriber import CAEnv, T0
import test_round7 as r7
rs = r7.rs
CAP = sb.STREAM_MAX_BYTES


def line(n, ch="a"):
    """A JSON line of exactly n bytes (ASCII)."""
    pad = n - len('{"k":""}')
    return '{"k":"' + ch * pad + '"}'


def day_dir(e):
    return os.path.join(e.sub.data, "2026-10-13")


def stored(e, room, stream):
    p = os.path.join(day_dir(e), f"{room}.{stream}.jsonl")
    return open(p, "rb").read() if os.path.exists(p) else None


class CapTests(unittest.TestCase):
    def test_constant(self):
        self.assertEqual(CAP, 4000)

    def test_4000_stored_4001_not_every_stream_str_and_bytes(self):
        for stream in sb.STREAMS:
            for kind in ("str", "bytes"):
                with self.subTest(stream=stream, kind=kind):
                    e = CAEnv(); conv = (lambda s: s.encode()) if kind == "bytes" else (lambda s: s)
                    e.sub.on_line(f"kiosk/r1/{stream}", conv(line(CAP)))
                    self.assertEqual(stored(e, "r1", stream), (line(CAP) + "\n").encode())
                    e2 = CAEnv()
                    e2.sub.on_line(f"kiosk/r1/{stream}", conv(line(CAP + 1) + "\n"))
                    self.assertIsNone(stored(e2, "r1", stream))

    def test_multibyte_counts_bytes_not_chars(self):
        for kind in ("str", "bytes"):
            with self.subTest(kind=kind):
                e = CAEnv(); conv = (lambda s: s.encode()) if kind == "bytes" else (lambda s: s)
                n_chars = 2000                                    # 2000 chars of 2 bytes = 4000 body bytes + 8 framing > cap, though chars << cap
                raw = '{"k":"' + "é" * n_chars + '"}'
                self.assertLess(len(raw), CAP); self.assertGreater(len(raw.encode()), CAP)
                e.sub.on_line("kiosk/r1/health", conv(raw))
                self.assertIsNone(stored(e, "r1", "health"))
                e.sub.on_line("kiosk/r1/health", conv('{"k":"' + "é" * 1995 + '"}'))   # 3990 + 8 = 3998 bytes: stored
                self.assertIsNotNone(stored(e, "r1", "health"))

    def test_bytes_crlf_at_the_cap_is_stored_as_body_plus_lf(self):
        for stream in sb.STREAMS:
            with self.subTest(stream=stream):
                e = CAEnv(); e.sub.on_line(f"kiosk/r1/{stream}", line(CAP).encode() + b"\r\n")        # 4000 bytes + CRLF: not oversize
                self.assertEqual(stored(e, "r1", stream), (line(CAP) + "\n").encode())
                e = CAEnv(); e.sub.on_line(f"kiosk/r1/{stream}", line(100).encode() + b"\r\n")       # CRLF folded to LF, as text mode did
                self.assertEqual(stored(e, "r1", stream), (line(100) + "\n").encode())
                e = CAEnv(); e.sub.on_line(f"kiosk/r1/{stream}", line(CAP + 1).encode() + b"\r\n")
                self.assertIsNone(stored(e, "r1", stream))

    def test_str_path_excludes_the_newline_from_the_cap(self):
        e = CAEnv(); e.sub.on_line("kiosk/r1/health", line(CAP) + "\n")
        self.assertEqual(stored(e, "r1", "health"), (line(CAP) + "\n").encode())
        e = CAEnv(); e.sub.on_line("kiosk/r1/health", line(CAP) + "\r\n")          # CRLF is not counted either (the str path stores it as main did: only the LF is stripped)
        self.assertIsNotNone(stored(e, "r1", "health"))

    def test_audit_has_reason_bytes_ts_and_no_content(self):
        e = CAEnv()
        e.sub.on_line("kiosk/r1/canary", line(CAP + 50, "S").encode())
        rows = open(os.path.join(day_dir(e), "r1.canary-invalid.jsonl")).read().splitlines()
        self.assertEqual(len(rows), 1); r = json.loads(rows[0])
        self.assertEqual(set(r), {"ts", "reason", "bytes"}); self.assertEqual((r["reason"], r["bytes"], r["ts"]), ("oversize", CAP + 50, int(T0)))
        self.assertNotIn("SSSS", open(os.path.join(day_dir(e), "r1.canary-invalid.jsonl")).read())

    def test_audit_dedupe_per_room_per_stream_per_10_min(self):
        e = CAEnv(); aud = lambda room, st: os.path.join(day_dir(e), f"{room}.{st}-invalid.jsonl")
        count = lambda room, st: len(open(aud(room, st)).read().splitlines()) if os.path.exists(aud(room, st)) else 0
        big = line(CAP + 1)
        for _ in range(5): e.sub.on_line("kiosk/r1/health", big)
        self.assertEqual(count("r1", "health"), 1)
        e.sub.on_line("kiosk/r1/heal", big); e.sub.on_line("kiosk/r2/health", big)      # other stream, other room: own audit each
        self.assertEqual((count("r1", "heal"), count("r2", "health")), (1, 1))
        e.clock.adv(599); e.sub.on_line("kiosk/r1/health", big); self.assertEqual(count("r1", "health"), 1)
        e.clock.adv(1); e.sub.on_line("kiosk/r1/health", big); self.assertEqual(count("r1", "health"), 2)

    def test_no_case_opened_and_no_state_touched(self):
        e = CAEnv()
        for st in sb.STREAMS:
            for body in (line(CAP + 1), '{"result":"escalated","k":"' + "x" * CAP + '"}'):
                self.assertFalse(e.sub.on_line(f"kiosk/r1/{st}", body))
        self.assertEqual(e.router.store.list_open(), []); self.assertEqual(e.bus.real, [])
        self.assertNotIn("r1", e.sub.last_health)

    def test_oversize_does_not_count_as_a_health_line(self):
        e = CAEnv(); before = e.sub.last_seen["r1"]; e.clock.adv(50)
        e.sub.on_line("kiosk/r1/health", line(CAP + 1)); self.assertEqual(e.sub.last_seen["r1"], before)

    def test_audit_fault_never_raises(self):
        e = CAEnv()
        with mock.patch("builtins.open", side_effect=OSError("disk")):
            self.assertFalse(e.sub.on_line("kiosk/r1/health", line(CAP + 1)))

    def test_at_or_under_cap_stored_output_byte_identical_str_vs_bytes(self):
        for body in ('{"zero_ratio": 0.0}', '{"a":"é"}', line(CAP)):
            a, b = CAEnv(), CAEnv()
            a.sub.on_line("kiosk/r1/health", body); b.sub.on_line("kiosk/r1/health", body.encode() + b"\n")
            self.assertEqual(stored(a, "r1", "health"), stored(b, "r1", "health"))
            self.assertEqual(stored(a, "r1", "health"), (body + "\n").encode())

    def test_5000_digit_canary_integer_is_an_oversize_audit_not_a_case(self):
        e = CAEnv(); self.assertFalse(e.sub.on_line("kiosk/r1/canary", "1" * 5000))
        self.assertEqual([json.loads(l)["reason"] for l in open(os.path.join(day_dir(e), "r1.canary-invalid.jsonl"))], ["oversize"]); self.assertEqual(e.router.store.list_open(), [])

    def test_non_utf8_line_is_audited_not_stored_deduped_no_content(self):
        for stream in sb.STREAMS:
            with self.subTest(stream=stream):
                e = CAEnv(); bad = b'{"k":"\xff\xfeSECRETTEXT"}\n'
                aud = os.path.join(day_dir(e), f"r1.{stream}-invalid.jsonl")
                for _ in range(3): self.assertFalse(e.sub.on_line(f"kiosk/r1/{stream}", bad))
                self.assertIsNone(stored(e, "r1", stream)); self.assertEqual(e.router.store.list_open(), [])
                txt = open(aud).read(); rows = [json.loads(l) for l in txt.splitlines()]
                self.assertEqual(len(rows), 1); self.assertEqual(set(rows[0]), {"ts", "reason", "bytes"})
                self.assertEqual((rows[0]["reason"], rows[0]["bytes"]), ("not_utf8", len(bad.rstrip(b"\n")))); self.assertNotIn("SECRET", txt)
                e.clock.adv(600); e.sub.on_line(f"kiosk/r1/{stream}", bad); self.assertEqual(len(open(aud).read().splitlines()), 2)

    def test_non_utf8_and_oversize_dedupe_independently(self):
        e = CAEnv(); e.sub.on_line("kiosk/r1/health", b"\xff"); e.sub.on_line("kiosk/r1/health", line(CAP + 1).encode())
        rows = [json.loads(l)["reason"] for l in open(os.path.join(day_dir(e), "r1.health-invalid.jsonl"))]
        self.assertEqual(rows, ["not_utf8", "oversize"])

    def test_reader_hands_bytes(self):
        src = open(os.path.join(HERE, "..", "subscriber", "run_subscriber.py")).read()
        self.assertNotIn("text=True)", src[src.index("def reader"):src.index("def publish(")])


class ConsultStartTests(unittest.TestCase):
    def test_start_from_8_threads_makes_exactly_one_refresher(self):
        import consult_hold as ch
        from test_dprime import mk
        h, _c, _s = mk(); made = []
        real = threading.Thread
        class SlowThread(real):                                    # widens the check-then-start window so an unlocked start() races reliably
            def __init__(self, *a, **kw):
                time.sleep(0.05); super().__init__(*a, **kw)
                if kw.get("name") == "consult-hold-refresher": made.append(self)     # (threading.Thread is global: ignore other code's threads)
        h._loop = lambda: h._stop.wait(5)
        bar = threading.Barrier(8)
        def go(): bar.wait(); h.start()
        with mock.patch.object(ch.threading, "Thread", SlowThread):
            ts = [real(target=go) for _ in range(8)]
            for t in ts: t.start()
            for t in ts: t.join()
        try:
            self.assertEqual(len(made), 1)
        finally:
            h.stop()


class PublishTests(unittest.TestCase):
    ROOMS = [f"room{i}" for i in range(9)]

    def run_round(self, hang, rooms=None, round_s=1.0, workers=8):
        rooms = rooms or self.ROOMS; logs, got, release = [], [], threading.Event()
        lock = threading.Lock()
        def pub(r, m):
            if r in hang: release.wait(30); raise TimeoutError("x")
            with lock: got.append((r, m))
        t = time.time()
        ok = rs.publish_round(rooms, lambda: "M", pub=pub, logger=logs.append, workers=workers, round_s=round_s)
        dt = time.time() - t; release.set()
        return ok, logs, got, dt

    def test_constants(self):
        self.assertEqual((rs.PUBLISH_WORKERS, rs.PUBLISH_ROUND_S), (8, 25))

    def test_one_hanging_of_nine_finishes_within_cap_and_other_eight_publish(self):
        ok, logs, got, dt = self.run_round({"room3"})
        self.assertLess(dt, 4); self.assertEqual(sorted(ok), sorted(r for r in self.ROOMS if r != "room3"))
        self.assertEqual(len(got), 8); self.assertEqual(len(logs), 1); self.assertIn("room3", logs[0])

    def test_all_nine_hanging_finish_within_cap_with_nine_log_lines(self):
        ok, logs, got, dt = self.run_round(set(self.ROOMS))
        self.assertLess(dt, 4); self.assertEqual((ok, got), ([], [])); self.assertEqual(len(logs), 9)
        self.assertEqual({l.split()[2] for l in logs}, set(self.ROOMS))

    def test_failing_room_gets_one_log_line_others_unaffected(self):
        logs, got = [], []
        def pub(r, m):
            if r == "room1": raise OSError("boom")
            got.append(r)
        ok = rs.publish_round(self.ROOMS, lambda: "M", pub=pub, logger=logs.append, round_s=5)
        self.assertEqual(len(got), 8); self.assertEqual(len(logs), 1); self.assertIn("room1", logs[0]); self.assertNotIn("boom", logs[0])

    def test_concurrent_not_serial(self):
        # 8 rooms each take 0.8 s: serial would be 6.4 s, concurrent ~0.8 s
        def pub(r, m): time.sleep(0.8)
        t = time.time(); rs.publish_round(self.ROOMS[:8], lambda: "M", pub=pub, logger=lambda m: None, round_s=5)
        self.assertLess(time.time() - t, 1.2)

    def test_max_8_workers(self):
        lock, cur, peak = threading.Lock(), [0], [0]
        def pub(r, m):
            with lock: cur[0] += 1; peak[0] = max(peak[0], cur[0])
            time.sleep(0.2)
            with lock: cur[0] -= 1
        rs.publish_round([f"r{i}" for i in range(20)], lambda: "M", pub=pub, logger=lambda m: None, round_s=10)
        self.assertEqual(peak[0], 8)

    def test_no_queued_room_publishes_after_the_round_returns(self):
        started, release = [], threading.Event()
        def pub(r, m):
            started.append(r); release.wait(5)
        rooms = [f"q{i}" for i in range(12)]
        logs = []
        rs.publish_round(rooms, lambda: "M", pub=pub, logger=logs.append, workers=8, round_s=0.3)
        n = len(started); release.set(); time.sleep(0.5)
        self.assertEqual(n, 8); self.assertEqual(len(started), 8)           # the 4 queued rooms never ran, even after the hung 8 were released
        self.assertEqual(len(logs), 12)

    def test_message_taken_per_room_in_the_worker(self):
        n = [0]
        def mk(): n[0] += 1; return f"M{n[0]}"
        got = []
        rs.publish_round(self.ROOMS, mk, pub=lambda r, m: got.append(m), logger=lambda m: None, round_s=5)
        self.assertEqual(sorted(got), sorted(f"M{i}" for i in range(1, 10)))

    def test_golden_control_bytes_unchanged_vs_main(self):
        """Main's loop: publish(r, s.control_message()) -> subprocess.run(argv, input=msg + "\\n", text=True, timeout=15, stderr=LOG). Same argv, bytes, timeout; the child now has its own session."""
        e = CAEnv(); calls = []
        class FakeP:
            pid = 0
            def __init__(self, argv, **kw): self.argv, self.kw = argv, kw
            def communicate(self, input=None, timeout=None): calls.append((self.argv, self.kw, input, timeout)); return ("", "")
        golden = sb.canonical_control({"kill": True, "modes": {"r1": "shadow", "r2": "shadow"}, "ts": int(T0)})
        with mock.patch.object(rs.subprocess, "Popen", FakeP):
            ok = rs.publish_round(["r1", "r2"], e.sub.control_message, logger=lambda m: None)
        self.assertEqual(sorted(ok), ["r1", "r2"]); self.assertEqual(len(calls), 2)
        for argv, kw, inp, tmo in calls:
            self.assertEqual(inp, golden + "\n"); self.assertEqual(tmo, 15); self.assertTrue(kw["text"]); self.assertIs(kw["start_new_session"], True)
            self.assertEqual(argv[1:5], [rs.KEY, "pub", "-c", "-b=false"])
        self.assertEqual(sorted(a[-1] for a, *_ in calls), ["/r1/guardian/control", "/r2/guardian/control"])

    def test_timeout_before_exec_leaves_no_orphans(self):
        tag = "61.%d" % (os.getpid() % 1000 + 100)            # a sleep argument unique to this run
        d = tempfile.mkdtemp(); stub = os.path.join(d, "pipe-ssh.sh")
        open(stub, "w").write(f"#!/bin/sh\nsleep {tag} &\nsleep {tag}\n"); os.chmod(stub, 0o755)   # hangs in a pipeline BEFORE any exec, with a grandchild
        def alive(): return subprocess.run(["pgrep", "-f", f"sleep {tag}"], capture_output=True).returncode == 0
        try:
            with mock.patch.object(rs, "PIPE_SSH", stub):
                t0 = time.monotonic()
                with self.assertRaises(subprocess.TimeoutExpired): rs.publish("r1", "M", timeout=1)
                self.assertLess(time.monotonic() - t0, 10)         # the group is killed at the timeout; without it communicate() would wait out the stub's ~60 s sleep
            time.sleep(0.3)
            self.assertFalse(alive())
        finally:
            subprocess.run(["pkill", "-f", f"sleep {tag}"], capture_output=True)

    def test_main_loop_period_unchanged_and_uses_publish_round(self):
        src = open(os.path.join(HERE, "..", "subscriber", "run_subscriber.py")).read(); main = src[src.index("def main():"):]
        self.assertIn('cfg.get("control_publish_s", 30)', main); self.assertIn("publish_round(rooms, s.control_message)", main)


if __name__ == "__main__":
    unittest.main()
