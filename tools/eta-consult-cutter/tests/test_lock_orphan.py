import fcntl, json, os, tempfile, unittest
from cutter import config as C, run as R

class RunLock(unittest.TestCase):
    def test_second_concurrent_run_exits_0_with_a_log_line_and_does_nothing(self):
        d = tempfile.mkdtemp(); C.RUN_LOCK = f"{d}/cutter.lock"
        first = R.acquire_run_lock(); self.assertIsNotNone(first)
        self.assertIsNone(R.acquire_run_lock())                                                       # a second run cannot get the lock
        from unittest import mock
        calls = []                                                                                    # must not even reach the database
        with mock.patch.dict(os.environ, {"CUTTER_LOCK_WAIT_S": "0"}), mock.patch.object(R.SP, "load_prints", lambda strict=False: {}), mock.patch.object(R.Wn, "fetch", lambda since: calls.append(since) or []), self.assertLogs("cutter", level="INFO") as cm: rc = R.main(["--once"])      # m3-21c: --once waits CUTTER_LOCK_WAIT_S; 0 = no wait
        self.assertEqual(rc, 0); self.assertEqual(calls, []); self.assertTrue(any("another cutter run" in m for m in cm.output))
        first.close(); again = R.acquire_run_lock(); self.assertIsNotNone(again); again.close()        # released when the first run ends

class LockWait(unittest.TestCase):
    def setUp(self): d = tempfile.mkdtemp(); C.RUN_LOCK = f"{d}/cutter.lock"
    def fake_clock(self):
        t = [0.0]; return (lambda: t[0]), (lambda s: t.__setitem__(0, t[0] + s))
    def test_lock_wait_s_env(self):
        from unittest import mock
        for v, want in (("", 900.0), ("x", 900.0), ("-1", 900.0), ("inf", 900.0), ("0", 0.0), ("30", 30.0)):
            with mock.patch.dict(os.environ, {"CUTTER_LOCK_WAIT_S": v}): self.assertEqual(R.lock_wait_s(), want)
    def test_polls_every_5s_and_gets_the_lock_when_released(self):
        held = R.acquire_run_lock(); clock, sleep = self.fake_clock(); sleeps = []
        def sl(s): sleeps.append(s); sleep(s); (held.close() if len(sleeps) == 3 else None)
        f, w = R.acquire_run_lock_wait(900, sleep=sl, clock=clock); self.assertIsNotNone(f); self.assertEqual((sleeps, w), ([5.0, 5.0, 5.0], 15.0)); f.close()
    def test_gives_up_after_the_wait(self):
        held = R.acquire_run_lock(); clock, sleep = self.fake_clock(); f, w = R.acquire_run_lock_wait(12, sleep=sleep, clock=clock); self.assertIsNone(f); self.assertEqual(w, 12.0); held.close()
    def test_free_lock_waits_nothing(self):
        f, w = R.acquire_run_lock_wait(900); self.assertIsNotNone(f); self.assertEqual(w, 0.0); f.close()
    def main_with_lock(self, argv, wait="0.3"):
        from unittest import mock
        held = R.acquire_run_lock(); calls = []
        with mock.patch.dict(os.environ, {"CUTTER_LOCK_WAIT_S": wait}), mock.patch.object(R.SP, "load_prints", lambda strict=True: {}), mock.patch.object(R.Wn, "fetch", lambda since: calls.append(since) or []), \
             mock.patch.object(R, "LOCK_POLL_S", 0.05), mock.patch.object(R, "acquire_run_lock_wait", wraps=lambda w, **k: R.__dict__["_orig_wait"](w, poll_s=0.05, **k)) as aw:
            import io, contextlib; buf = io.StringIO()
            with contextlib.redirect_stdout(buf): rc = R.main(argv)
        held.close(); return rc, json.loads(buf.getvalue().strip().splitlines()[-1]), aw.call_count
    def test_marker_written_while_waiting_and_removed_after(self):
        held = R.acquire_run_lock(); mk = tempfile.mkdtemp() + "/hourly-waiting"; clock, sleep = self.fake_clock(); seen = []
        def sl(s):
            sleep(s); seen.append(json.load(open(mk))); (held.close() if len(seen) == 2 else None)
        f, w = R.acquire_run_lock_wait(900, sleep=sl, clock=clock, marker=mk); self.assertIsNotNone(f)
        self.assertEqual(seen[0]["pid"], os.getpid()); self.assertIn("start", seen[0]); self.assertFalse(os.path.exists(mk)); f.close()
    def test_marker_removed_on_exception_and_on_timeout_and_not_written_when_lock_free(self):
        mk = tempfile.mkdtemp() + "/m"; held = R.acquire_run_lock(); clock, sleep = self.fake_clock()
        def boom(s): raise RuntimeError("x")
        with self.assertRaises(RuntimeError): R.acquire_run_lock_wait(900, sleep=boom, clock=clock, marker=mk)
        self.assertFalse(os.path.exists(mk))
        f, _ = R.acquire_run_lock_wait(5, sleep=sleep, clock=clock, marker=mk); self.assertIsNone(f); self.assertFalse(os.path.exists(mk)); held.close()
        f, _ = R.acquire_run_lock_wait(900, sleep=boom, clock=clock, marker=mk); self.assertIsNotNone(f); self.assertFalse(os.path.exists(mk)); f.close()
    def test_sigterm_while_waiting_removes_the_marker_and_the_handler_is_restored(self):
        import signal, subprocess, sys, time
        d = tempfile.mkdtemp(); mk = f"{d}/hourly-waiting"; lk = f"{d}/cutter.lock"
        held = open(lk, "a"); fcntl.flock(held, fcntl.LOCK_EX)
        code = "import sys; sys.path.insert(0, %r); from cutter import config as C, run as R; C.RUN_LOCK = %r; R.acquire_run_lock_wait(60, marker=%r)" % (os.path.dirname(os.path.dirname(os.path.abspath(__file__))), lk, mk)
        p = subprocess.Popen([sys.executable, "-c", code])
        for _ in range(100):
            if os.path.exists(mk): break
            time.sleep(0.1)
        self.assertTrue(os.path.exists(mk)); p.send_signal(signal.SIGTERM); rc = p.wait(timeout=10)
        self.assertEqual(rc, 128 + signal.SIGTERM); self.assertFalse(os.path.exists(mk)); held.close()
        C.RUN_LOCK = lk; h2 = open(lk, "a"); fcntl.flock(h2, fcntl.LOCK_EX); before = signal.getsignal(signal.SIGTERM)
        f, _ = R.acquire_run_lock_wait(0.2, marker=mk, poll_s=0.05); self.assertIsNone(f); self.assertEqual(signal.getsignal(signal.SIGTERM), before); self.assertFalse(os.path.exists(mk)); h2.close()
    def test_main_hourly_waits_then_reports_locked_with_lock_waited_s(self):
        R._orig_wait = R.acquire_run_lock_wait
        try: rc, out, n = self.main_with_lock(["--once"])
        finally: pass
        self.assertEqual((rc, out["locked"], n), (0, True, 1)); self.assertGreaterEqual(out["lock_waited_s"], 0.3)
    def test_other_modes_do_not_wait(self):
        R._orig_wait = R.acquire_run_lock_wait
        for argv in (["--once", "--only", "u"], ["--once", "--dry-run"], ["--once", "--windows-file", "/nonexistent"], ["--backfill", "2026-10-01", "2026-10-02"]):
            rc, out, n = self.main_with_lock(argv, wait="900"); self.assertEqual((rc, out, n), (0, {"locked": True}, 0))
    def test_summary_carries_lock_waited_s_and_budget_clock_starts_after_the_lock(self):
        from unittest import mock
        seen = {}; times = iter([1000.0, 1000.0, 1000.0, 1000.0])
        def run_once(windows, ctx, only, d_from, d_to, dry, min_open=None, recut=False, budget_s=None, t0=None): seen["t0"] = t0; return dict(eligible=0), []
        import io, contextlib; buf = io.StringIO()
        with mock.patch.object(R.SP, "load_prints", lambda strict=True: {}), mock.patch.object(R, "acquire_run_lock_wait", lambda w: (object(), 42.0)), mock.patch.object(R.time, "time", lambda: 5000.0), \
             mock.patch.object(R.Wn, "fetch", lambda since: []), mock.patch.object(R, "make_ctx", lambda now, **kw: dict(now=now)), mock.patch.object(R, "run_once", run_once), mock.patch.object(R, "mirror_pending", lambda *a, **k: 0), contextlib.redirect_stdout(buf):
            R.main(["--once"])
        out = json.loads(buf.getvalue().strip().splitlines()[-1]); self.assertEqual(out["lock_waited_s"], 42.0); self.assertEqual(seen["t0"], 5000.0)
if __name__ == "__main__": unittest.main()
