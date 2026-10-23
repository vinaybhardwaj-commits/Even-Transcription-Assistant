"""FR1 D7 (22 Oct): the Mini router's own ubus identity, scoped ack reads, one alert per state change. No real shim is started: Popen and select are mocked."""
import io, json, os, sys, unittest
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import safenet      # FR1 D7-4 MUST-1: scratch GUARDIAN_HOME / inbox / shim BEFORE any router module is imported
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "router"))
from test_router import ar, FakeBus, Clock, row, TUE_11, SUN_12, ist
import ubus_bus
# importing run_router sets Router.inbox_path (the REAL gating inbox) and Router.log_fn for the job: import it ONCE, here, with both patched, so
# the import can never leak into any test (D7 F0). Every test that needs an inbox uses a scratch file.
with mock.patch.object(ar.Router, "inbox_path", None), mock.patch.object(ar.Router, "log_fn", None):
    import run_router
assert ar.Router.inbox_path is None and ar.Router.log_fn is None

CFG = {"to": ["gating-lead"], "ackers": ["gating-lead"], "subject_prefix": "", "wake": False}


class FakeStdout:
    def __init__(self): self.lines = []
    def readline(self): return self.lines.pop(0) if self.lines else ""


class FakeStdin:
    def __init__(self, proc): self.proc, self.buf = proc, ""
    def write(self, s):
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self.proc.on_request(json.loads(line))
    def flush(self): pass
    def close(self): pass


class FakeShim:
    """Stands in for the ubus stdio shim: answers initialize and tools/call with canned results and records every call."""
    def __init__(self, whoami="room-guardian", registered=True):
        self.whoami, self.registered, self.calls, self.terminated = whoami, registered, [], False
        self.stdout, self.stdin = FakeStdout(), FakeStdin(self)
        self.register_ok = True
    def on_request(self, req):
        if "id" not in req:
            return
        if req["method"] == "tools/call":
            name, args = req["params"]["name"], req["params"]["arguments"]
            self.calls.append((name, args))
            if name == "ubus_register" and not self.register_ok:
                out = {"ok": False, "error": "handle_in_use"}
            elif name == "ubus_whoami":
                out = {"ok": True, "handle": self.whoami, "registered": self.registered}
            else:
                out = {"ok": True, "messages": []}
            result = {"content": [{"type": "text", "text": json.dumps(out)}]}
        else:
            result = {}
        self.stdout.lines.append(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}) + "\n")
    def terminate(self): self.terminated = True
    def wait(self, timeout=None): return 0


class ShimTests(unittest.TestCase):
    def start(self, whoami="room-guardian", environ=None, registered=True, register_ok=True):
        shim, seen = FakeShim(whoami, registered), {}
        shim.register_ok = register_ok
        def popen(argv, **kw):
            seen.update(kw); return shim
        env = environ if environ is not None else dict(os.environ)
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(ubus_bus.subprocess, "Popen", popen), \
                mock.patch.object(ubus_bus.select, "select", lambda r, w, x, t: (r, [], [])):
            try:
                return ubus_bus.UbusBus(CFG, timeout=2), shim, seen, None
            except ubus_bus.UbusError as e:
                return None, shim, seen, e

    def test_the_shim_env_sets_the_identity_vars_even_when_the_parent_env_has_others(self):
        hostile = {"PATH": "/usr/bin", "UBUS_HANDLE": "ubus-refuter", "UBUS_SESSION": "cc:local", "UBUS_RUNTIME": "claude-code", "UBUS_OWNER": "someone",
                   "UBUS_ORCHESTRATOR": "herdr-lead", "HERDR_AGENT_NAME": "pane-x", "HERDR_PANE_ID": "w1:p2", "CLAUDECODE": "1"}
        bus, shim, seen, err = self.start(environ=hostile)
        self.assertIsNone(err)
        env = seen["env"]
        self.assertEqual((env["UBUS_HANDLE"], env["UBUS_SESSION"], env["UBUS_RUNTIME"], env["UBUS_OWNER"], env["UBUS_ORCHESTRATOR"]),
                         ("room-guardian", "h:room-guardian", "other", "fable", "guardian-lead"))
        self.assertFalse([k for k in env if k.startswith("HERDR") or k == "CLAUDECODE"])        # no herdr branch in deriveIdentity
        self.assertEqual(env["PATH"], "/usr/bin")
        reg = [a for n, a in shim.calls if n == "ubus_register"][0]
        self.assertEqual((reg["handle"], reg["session"], reg["runtime"], reg["owner"], reg["orchestrator"]),
                         ("room-guardian", "h:room-guardian", "other", "fable", "guardian-lead"))
        self.assertEqual([n for n, _ in shim.calls], ["ubus_register", "ubus_whoami"])
        self.assertFalse({"rename", "exclusive"} & set(reg))                # D7-2: adopt the live row h:room-guardian, never rename it

    def test_registered_false_is_a_mismatch_too(self):
        bus, shim, seen, err = self.start(registered=False)
        self.assertIsNone(bus); self.assertIsInstance(err, ubus_bus.UbusIdentityError)
        self.assertEqual(str(err), "identity room-guardian registered=false"); self.assertNotIn("ubus_send", [n for n, _ in shim.calls])

    def test_a_handle_mismatch_keeps_the_identity_prefix_whatever_registered_is(self):
        # D7-4 NIT-3: registered True, False or unknown (None): the message starts "identity <handle>" and the alarm text is the same handle
        for reg, tail in ((True, ""), (False, " registered=false"), (None, "")):
            with self.subTest(registered=reg):
                bus, shim, _seen, err = self.start(whoami="ubus-refuter@vinays-mac-mini-3", registered=reg)
                self.assertIsNone(bus); self.assertIsInstance(err, ubus_bus.UbusIdentityError)
                self.assertEqual(str(err), "identity ubus-refuter@vinays-mac-mini-3" + tail)
                self.assertEqual((err.identity, err.handle, err.registered), ("ubus-refuter@vinays-mac-mini-3", "ubus-refuter@vinays-mac-mini-3", reg))
                self.assertNotIn("ubus_send", [n for n, _ in shim.calls])
        bus, shim, _seen, err = self.start(register_ok=False)           # a register fault: no handle, no registered, the reason text
        self.assertEqual((err.handle, err.registered, err.identity), (None, None, "register ubus_register: handle_in_use"))

    def test_a_whoami_mismatch_raises_and_sends_nothing(self):
        bus, shim, seen, err = self.start(whoami="ubus-refuter@vinays-mac-mini-3")
        self.assertIsNone(bus); self.assertIsInstance(err, ubus_bus.UbusError)
        self.assertEqual(str(err), "identity ubus-refuter@vinays-mac-mini-3")
        self.assertNotIn("ubus_send", [n for n, _ in shim.calls]); self.assertTrue(shim.terminated)

    def test_a_whoami_mismatch_through_the_router_tick_sends_nothing(self):
        shims = []
        def popen(argv, **kw):
            shims.append(FakeShim("ubus-refuter@vinays-mac-mini-3")); return shims[-1]
        logs = []
        if True:
            r = ar.Router(ar.SqliteStore(), None, Clock(TUE_11)); r.on_row(None, row(100, "offline"))
            with mock.patch.object(ubus_bus.subprocess, "Popen", popen), mock.patch.object(ubus_bus.select, "select", lambda a, b, c, t: (a, [], [])), \
                    mock.patch.object(run_router, "log", logs.append):
                bus = run_router.LazyBus(CFG)
                out = r.tick(bus); bus.close()
        self.assertIsNone(ar.Router.inbox_path); self.assertIsNone(ar.Router.log_fn)
        self.assertGreaterEqual(out["errors"], 1); self.assertIn("identity", out["error"])
        self.assertEqual(len(shims), 1)                                    # one start per tick, remembered
        self.assertFalse([1 for s in shims for n, _ in s.calls if n == "ubus_send"])
        self.assertEqual(r.store.get_open("r1", "offline")["page_count"], 0)   # still due: nothing went out under another name
        self.assertTrue(any("identity ubus-refuter" in l for l in logs))

    def test_forbidden_and_not_registered_reads_raise_denied(self):
        bus, shim, _seen, _err = self.start()
        for text in ("forbidden", "not_registered"):
            bus._tool = lambda name, args, t=text: (_ for _ in ()).throw(ubus_bus.UbusError(f"{name}: {t}"))
            with self.assertRaises(ubus_bus.UbusDenied):
                bus.thread_messages("room-alert-1")

    def test_a_register_refusal_raises_identity_error_and_sends_nothing(self):
        # FR1 D7-3: a refused ubus_register raises UbusIdentityError, so no ROUTER SILENT line is written
        bus, shim, seen, err = self.start(register_ok=False)
        self.assertIsNone(bus); self.assertIsInstance(err, ubus_bus.UbusIdentityError)
        self.assertIn("register", str(err)); self.assertIn("handle_in_use", str(err))
        self.assertEqual([n for n, _ in shim.calls], ["ubus_register"])
        self.assertTrue(shim.terminated)


class SilentBus:
    """Every bus call fails the way LazyBus does after a whoami mismatch."""
    def __init__(self): self.calls = 0
    def _boom(self, *a):
        self.calls += 1; raise ubus_bus.UbusIdentityError("ubus-refuter@vinays-mac-mini-3", True)
    post = thread_messages = _boom


class FailLoudTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.inbox = os.path.join(self.tmp.name, "INBOX-scratch.md")          # never the real gating inbox
        self.clock, self.bus = Clock(TUE_11), SilentBus()
        self.r = ar.Router(ar.SqliteStore(), lambda: self.bus, self.clock, os.path.join(self.tmp.name, "local.json"))
        self.r.inbox_path = self.inbox
        self.r.on_row(None, row(100, "offline"))

    def lines(self):
        return [l for l in open(self.inbox).read().splitlines() if "ROUTER SILENT" in l] if os.path.exists(self.inbox) else []

    def test_a_mismatch_writes_one_line_per_hour(self):
        import contextlib
        with contextlib.redirect_stderr(io.StringIO()) as err:
            for _ in range(10):
                out = self.r.tick(self.bus); self.assertIn("identity", out["error"]); self.clock.adv(30)
            self.assertEqual(len(self.lines()), 1)
            self.assertTrue(self.lines()[0].endswith("room-guardian ROUTER SILENT: identity ubus-refuter@vinays-mac-mini-3"))
            self.clock.t = TUE_11 + 3600; self.r.tick(self.bus)
            for _ in range(10): self.clock.adv(30); self.r.tick(self.bus)
        self.assertEqual(len(self.lines()), 2)
        self.assertEqual(err.getvalue().count("ROUTER SILENT: identity"), 2)
        self.assertEqual(self.r.store.get_open("r1", "offline")["page_count"], 0)

    def test_the_hourly_stamp_survives_a_restart(self):
        import contextlib
        with contextlib.redirect_stderr(io.StringIO()):
            self.r.tick(self.bus)
            r2 = ar.Router(self.r.store, lambda: self.bus, self.clock, os.path.join(self.tmp.name, "local.json")); r2.inbox_path = self.inbox
            self.clock.adv(600); r2.tick(self.bus)
        self.assertEqual(len(self.lines()), 1)

    def test_the_startup_check_runs_with_no_open_case(self):
        shims = []
        def popen(argv, **kw):
            shims.append(FakeShim(self.who)); return shims[-1]
        for who, ok in (("room-guardian", True), ("ubus-refuter@vinays-mac-mini-3", False)):
            self.who, logs = who, []
            r = ar.Router(ar.SqliteStore(), None, self.clock, os.path.join(self.tmp.name, f"l-{ok}.json")); r.inbox_path = self.inbox
            self.assertEqual(r.store.list_open(), [])
            import contextlib
            with mock.patch.object(ubus_bus.subprocess, "Popen", popen), mock.patch.object(ubus_bus.select, "select", lambda a, b, c, t: (a, [], [])), \
                    mock.patch.object(run_router, "log", logs.append), mock.patch.object(run_router, "_whoami_logged", None), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(run_router.startup_check(r, CFG), ok)
            self.assertEqual([n for n, _ in shims[-1].calls], ["ubus_register", "ubus_whoami"])
            if ok:
                self.assertIn("whoami handle=room-guardian session=h:room-guardian registered=True why=ok", logs)
        self.assertEqual(len(shims), 2); self.assertEqual(len(self.lines()), 1)

    def test_a_register_refusal_writes_router_silent_and_sends_nothing(self):
        # FR1 D7-3: a refused ubus_register at tick time writes one ROUTER SILENT line
        shims = []
        def popen(argv, **kw):
            s = FakeShim("room-guardian"); s.register_ok = False; shims.append(s); return s
        # make a fresh router that will actually try to start the shim, not use self.bus (SilentBus)
        r2 = ar.Router(self.r.store, ubus_bus.UbusBus, self.clock, os.path.join(self.tmp.name, "local2.json"))
        r2.inbox_path = self.inbox
        import contextlib
        with mock.patch.object(ubus_bus.subprocess, "Popen", popen), mock.patch.object(ubus_bus.select, "select", lambda a, b, c, t: (a, [], [])), \
                contextlib.redirect_stderr(io.StringIO()):
            bus = run_router.LazyBus(CFG)
            for _ in range(5):
                try:
                    r2.tick(bus)
                finally:
                    bus.close()
                    bus = run_router.LazyBus(CFG)
                self.clock.adv(30)
        self.assertEqual(len(self.lines()), 1)
        self.assertTrue("ROUTER SILENT: identity register" in self.lines()[0] and "handle_in_use" in self.lines()[0])
        self.assertEqual(self.r.store.get_open("r1", "offline")["page_count"], 0)


class StopLoop(Exception):
    pass


class FakeTime:
    """FR1 D7-4: the clock and the sleep of run_router.main(). sleep advances the clock and, once stop_after seconds have passed, ends the loop."""
    def __init__(self, t0, stop_after):
        self.t0, self.t, self.stop_after, self.sleeps = t0, t0, stop_after, []
    def time(self): return self.t
    def sleep(self, s):
        self.sleeps.append(s); self.t += s
        if self.t - self.t0 > self.stop_after:
            raise StopLoop()
    def __getattr__(self, name): return getattr(__import__("time"), name)


class MainTests(unittest.TestCase):
    """run_router.main() against a scratch home: a fake clock, a fake shim, and no path outside the scratch dir (D7-4 MUST-1)."""
    GLOBALS = ("ACKERS", "_whoami_logged", "inbox_path", "log_fn", "HOME", "ubus_HOME", "time", "Popen", "select")

    @staticmethod
    def globals_now():
        return {"ACKERS": set(ar.ACKERS), "_whoami_logged": run_router._whoami_logged, "inbox_path": ar.Router.inbox_path, "log_fn": ar.Router.log_fn,
                "HOME": run_router.HOME, "ubus_HOME": ubus_bus.HOME, "time": run_router.time, "Popen": ubus_bus.subprocess.Popen,
                "select": ubus_bus.select.select}

    @classmethod
    def setUpClass(cls):
        cls.before = cls.globals_now()

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.t = self.tmp.name
        self.inbox = os.path.join(self.t, "INBOX-scratch.md")
        self.logs, self.shims, self.opened = [], [], []
        os.makedirs(os.path.join(self.t, "etc")); os.makedirs(os.path.join(self.t, "data"))
        with open(os.path.join(self.t, "etc", "router.json"), "w") as f:
            json.dump(CFG, f)

    def tearDown(self):
        # D7-4 SHOULD-3: main() sets alert_router.ACKERS and run_router._whoami_logged; put back every global it can change
        ar.ACKERS = set(self.before["ACKERS"]); run_router._whoami_logged = self.before["_whoami_logged"]
        ar.Router.inbox_path = self.before["inbox_path"]; ar.Router.log_fn = self.before["log_fn"]

    def run_main(self, popen=None, startup_check=None, stop_after=100, record=False):
        """Returns (FakeTime, attempts): the clock offsets at which startup_check ran. startup_check None: the real one."""
        ft, attempts = FakeTime(TUE_11, stop_after), []
        real_check = run_router.startup_check
        def popen_(argv, **kw):
            self.assertFalse(safenet.is_live(argv[0]), argv)        # the real shim path is never used
            s = popen(len(self.shims) + 1) if popen else FakeShim("room-guardian")
            self.shims.append(s); return s
        def check(router, cfg):
            attempts.append(ft.t - ft.t0)
            return startup_check(len(attempts)) if startup_check else real_check(router, cfg)
        import builtins, contextlib, sqlite3
        real_open, real_connect = builtins.open, sqlite3.connect
        def rec_open(file, *a, **kw):
            if isinstance(file, (str, bytes, os.PathLike)): self.opened.append(os.fsdecode(file))
            return real_open(file, *a, **kw)
        def rec_connect(database, *a, **kw):
            self.opened.append(os.fsdecode(database)); return real_connect(database, *a, **kw)
        with contextlib.ExitStack() as st:
            st.enter_context(mock.patch.dict(os.environ, {"GUARDIAN_HOME": self.t, "GUARDIAN_GATING_INBOX": self.inbox}))
            for obj, name, val in ((run_router, "HOME", self.t), (ubus_bus, "HOME", self.t), (ar.Router, "inbox_path", self.inbox), (run_router, "log", self.logs.append),
                                   (run_router, "time", ft), (run_router, "startup_check", check), (ubus_bus.subprocess, "Popen", popen_),
                                   (ubus_bus.select, "select", lambda a, b, c, t: (a, [], []))):
                st.enter_context(mock.patch.object(obj, name, val))
            run_router._whoami_logged = None            # main() sets it (and alert_router.ACKERS); tearDown puts both back
            if record:
                for obj, name, val in ((builtins, "open", rec_open), (sqlite3, "connect", rec_connect)):
                    st.enter_context(mock.patch.object(obj, name, val))
                for name in ("makedirs", "mkdir", "replace", "rename", "remove", "walk"):
                    fn = getattr(os, name)
                    def wrap(path, *a, _fn=fn, **kw):
                        self.opened.append(os.fsdecode(path))
                        if _fn in (os.replace, os.rename) and a: self.opened.append(os.fsdecode(a[0]))      # the destination too
                        return _fn(path, *a, **kw)
                    st.enter_context(mock.patch.object(os, name, wrap))
            st.enter_context(contextlib.redirect_stderr(io.StringIO()))
            try:
                run_router.main()
            except StopLoop:
                pass
        return ft, attempts

    def startup_lines(self):
        return [l for l in self.logs if l.startswith("whoami handle=")]

    def test_main_calls_startup_check_before_the_loop(self):
        # FR1 D7-3 NIT-1: main() calls startup_check before entering the tick loop
        ft, attempts = self.run_main(stop_after=10)
        self.assertEqual(attempts, [0])                                   # at t0, before the first sleep
        self.assertEqual(self.startup_lines(), ["whoami handle=room-guardian session=h:room-guardian registered=True why=ok"])
        self.assertGreaterEqual(len(ft.sleeps), 1); self.assertEqual(len(self.shims), 1)          # the shim started once: nothing is due, so no tick starts it

    def test_a_startup_check_that_never_succeeds_retries_at_30_60_to_300_s_and_then_stops(self):
        # D7-4 SHOULD-2 + NIT-1: attempts at exactly 0, 30, 60 ... 300 s (the first retry 30 s after the failed attempt), none after 300 s
        ft, attempts = self.run_main(startup_check=lambda n: False, stop_after=900)
        self.assertEqual(attempts, [30 * i for i in range(11)])
        self.assertNotIn(30, attempts[:1]); self.assertEqual(attempts[1] - attempts[0], 30)
        self.assertEqual([a for a in attempts if a > 300], [])
        self.assertGreater(ft.t - ft.t0, 600)                            # the loop kept ticking long after the window closed

    def test_refused_refused_ok_is_three_attempts_and_none_after_the_success(self):
        ft, attempts = self.run_main(startup_check=lambda n: n >= 3, stop_after=600)
        self.assertEqual(attempts, [0, 30, 60])
        self.assertGreater(ft.t - ft.t0, 300)                            # 10 more ticks, no further attempt

    def test_a_first_attempt_that_succeeds_is_the_only_attempt(self):
        ft, attempts = self.run_main(startup_check=lambda n: True, stop_after=600)
        self.assertEqual(attempts, [0])

    def test_every_attempt_logs_one_whoami_line_with_the_reason(self):
        # D7-4 NIT-2 / NIT-3: a refused register, a handle mismatch with registered unknown, a mismatch with registered true, then OK
        def popen(n):
            s = FakeShim({1: "room-guardian", 2: "ubus-refuter@vinays-mac-mini-3", 3: "ubus-refuter@vinays-mac-mini-3"}.get(n, "room-guardian"),
                         registered=None if n == 2 else True)
            s.register_ok = n != 1
            return s
        ft, attempts = self.run_main(popen=popen, stop_after=200)
        self.assertEqual(attempts, [0, 30, 60, 90])
        self.assertEqual(self.startup_lines(), [
            "whoami handle=none session=h:room-guardian registered=none why=register ubus_register: handle_in_use",
            "whoami handle=ubus-refuter@vinays-mac-mini-3 session=h:room-guardian registered=none why=identity ubus-refuter@vinays-mac-mini-3",
            "whoami handle=ubus-refuter@vinays-mac-mini-3 session=h:room-guardian registered=True why=identity ubus-refuter@vinays-mac-mini-3",
            "whoami handle=room-guardian session=h:room-guardian registered=True why=ok"])
        self.assertEqual(len(self.shims), 4); self.assertFalse([1 for s in self.shims for n, _ in s.calls if n == "ubus_send"])
        self.assertFalse([l for l in self.logs if l.startswith("bus start failed")])
        silent = open(self.inbox).read().count("ROUTER SILENT")
        self.assertEqual(silent, 1)                                       # one line per hour, whatever the number of failed attempts

    def test_main_opens_only_paths_under_the_scratch_dir(self):
        # D7-4 MUST-1 guard: every store, state and inbox path main() opens lies under the test's temp dir (recorded), none under the live home
        os.makedirs(os.path.join(self.t, "data", "_to_delete"))
        self.run_main(popen=lambda n: FakeShim("ubus-refuter@vinays-mac-mini-3"), record=True, stop_after=100)    # a failed startup also writes the inbox line
        paths = [p for p in self.opened if p != ":memory:"]
        names = {os.path.basename(p) for p in paths}
        self.assertTrue({"router.json", "cases.sqlite"} <= names and [n for n in names if n.startswith("router-local.json")], names)   # the three the live router uses were all recorded
        self.assertTrue(os.path.exists(self.inbox)); self.assertIn("INBOX-scratch.md", names)
        for p in paths:
            self.assertTrue(safenet.under(p, self.t), p)
            self.assertFalse(safenet.is_live(p), p)
        self.assertFalse(safenet.is_live(run_router.HOME)); self.assertFalse(safenet.is_live(ubus_bus.HOME))

    def test_zy_a_real_run_changes_the_globals_that_tearDown_must_put_back(self):
        # D7-4 SHOULD-3: proves main() sets ACKERS and _whoami_logged, so the zz test below is about the restore and not about a main() that never touched them
        self.run_main(stop_after=100)
        self.assertEqual(ar.ACKERS, {"gating-lead"}); self.assertIsNotNone(run_router._whoami_logged)

    def test_zz_the_module_globals_are_unchanged_after_the_main_tests(self):
        # D7-4 SHOULD-3: runs last in this class (name order); tearDown of every earlier test restored what main() sets
        now = self.globals_now()
        for k in self.GLOBALS:
            self.assertEqual(now[k], self.before[k], k)
        self.assertEqual(ar.ACKERS, {"gating-lead", "fleet"}); self.assertIsNone(run_router._whoami_logged)


class CountingBus(FakeBus):
    """FakeBus that records every thread read with the clock. deny: None, "case" (case threads forbidden), "yesterday" (case threads and
    yesterday's day thread forbidden: the usual live picture), or "all" + reason (every thread denied with that reason)."""
    def __init__(self, clock, deny=None, why="forbidden"):
        super().__init__(); self.clock, self.deny, self.why, self.reads = clock, deny, why, []
    def thread_messages(self, tid):
        self.reads.append((tid, self.clock()))
        is_case = not tid.startswith(ar.BATCH_PREFIX)
        if (self.deny == "all") or (self.deny in ("case", "yesterday") and is_case) or (self.deny == "yesterday" and tid == ar.batch_tid(self.clock() - 86400)):
            raise ubus_bus.UbusDenied(f"ubus_thread: {self.why}")
        return super().thread_messages(tid)
    def case_reads(self, fid): return [t for tid, t in self.reads if tid == f"room-alert-{fid}"]
    def read_times(self): return sorted({t for _tid, t in self.reads})


class AckReadTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.store = Clock(TUE_11), ar.SqliteStore()

    def test_an_unpaged_open_case_is_never_read(self):
        bus = CountingBus(self.clock); bus.fail = True                  # the send fails, so the case stays unpaged
        r = ar.Router(self.store, lambda: bus, self.clock); r.on_row(bus, row(100, "offline"))
        bus.real.append({"from": "fleet", "subject": "ACK room-alert-100", "body": "", "thread": ar.batch_tid(self.clock())})   # an ack is there, yet unread
        for _ in range(10):
            r.tick(bus); self.clock.adv(30)
        self.assertEqual(self.store.get_open("r1", "offline")["page_count"], 0)
        self.assertIsNone(self.store.get_open("r1", "offline")["acked_at"])          # no ack read for a case this router has not paged
        self.assertEqual(bus.case_reads(100), [])
        self.assertTrue(all(tid.startswith(ar.BATCH_PREFIX) for tid, _ in bus.reads))   # only the pre-send crash-marker read of the day threads

    def test_the_case_thread_is_never_read(self):
        bus = CountingBus(self.clock, deny="case"); r = ar.Router(self.store, lambda: bus, self.clock); r.on_row(bus, row(100, "offline"))
        for _ in range(20):
            r.tick(bus); self.clock.adv(30)
        self.assertEqual(bus.case_reads(100), [])                       # D7-2: acks come on the day threads only

    def test_a_paged_case_is_read_at_most_once_per_120_s_over_10_ticks(self):
        bus = CountingBus(self.clock); r = ar.Router(self.store, lambda: bus, self.clock); r.on_row(bus, row(100, "offline"))
        t0 = self.clock()
        for _ in range(10):
            r.tick(bus); self.clock.adv(30)
        reads = bus.read_times()                                         # t0: the crash-marker read before page 1; then the ack reads
        self.assertEqual(reads, [t0, t0 + 30, t0 + 150, t0 + 270])
        self.assertTrue(all(b - a >= ar.ACK_READ_S for a, b in zip(reads[1:], reads[2:])))

    def test_every_read_denied_backs_the_case_off_to_600_s_and_logs_once(self):
        for why in ("forbidden", "not_registered"):
            with self.subTest(why=why):
                clock = Clock(TUE_11); bus = CountingBus(clock, deny="all", why=why); r = ar.Router(ar.SqliteStore(), lambda: bus, clock)
                logs = []; r.log_fn = logs.append
                r.on_row(bus, row(100, "offline")); t0 = clock()
                for _ in range(42):
                    out = r.tick(bus); self.assertEqual(out["errors"], 0); clock.adv(30)
                self.assertEqual(bus.read_times(), [t0, t0 + 30, t0 + 630, t0 + 1230])
                self.assertEqual(logs, [f"ack read {why}: case room-alert-100, next read in 600s"])
                self.assertIsNone(r.store.get_open("r1", "offline")["acked_at"])            # no ack yet

    def test_one_denied_day_thread_does_not_back_off_and_a_batch_ack_is_seen_within_120_s(self):
        bus = CountingBus(self.clock, deny="yesterday"); r = ar.Router(self.store, lambda: bus, self.clock); r.on_row(bus, row(100, "offline"))
        logs = []; r.log_fn = logs.append
        r.tick(bus); t_page = self.clock()
        self.clock.adv(30); r.tick(bus)                                  # first ack read: yesterday forbidden, today readable: no back-off
        bus.real.append({"from": "fleet", "subject": "Re: ROOM ALERT", "body": "ACK room-alert-100", "thread": ar.batch_tid(self.clock())})
        acked_at = None
        for _ in range(8):
            self.clock.adv(30)
            if r.tick(bus)["acked"]:
                acked_at = self.clock(); break
        self.assertIsNotNone(acked_at); self.assertLessEqual(acked_at - (t_page + 30), ar.ACK_READ_S)
        self.assertEqual(logs, []); self.assertEqual(self.store.get_open("r1", "offline")["acked_by"], "fleet")

    def test_an_ack_is_still_seen_after_the_backoff(self):
        bus = CountingBus(self.clock); r = ar.Router(self.store, lambda: bus, self.clock); r.on_row(bus, row(100, "offline"))
        r.tick(bus); self.clock.adv(30); r.tick(bus)
        bus.human("gating-lead", "ACK room-alert-100", "room-alert-100")
        self.clock.adv(60); self.assertEqual(r.tick(bus)["acked"], 0)        # 90 s after the last read: not yet
        self.clock.adv(60); self.assertEqual(r.tick(bus)["acked"], 1)


class CadenceTests(unittest.TestCase):
    def run_6h(self, t0, kind="offline"):
        clock, bus = Clock(t0), FakeBus(); r = ar.Router(ar.SqliteStore(), lambda: bus, clock); r.on_row(bus, row(100, kind))
        sent = []
        for _ in range(6 * 3600 // 30):
            n = len(bus.real); r.tick(bus)
            sent += [(clock() - t0, m["subject"]) for m in bus.real[n:]]
            clock.adv(30)
        return sent

    def test_six_hours_unacked_is_one_page_and_two_reminders_in_and_out_of_clinic(self):
        for name, t0 in (("clinic", TUE_11), ("sunday", SUN_12), ("night", ist(2026, 10, 13, 1, 0))):
            with self.subTest(name):
                if name == "clinic": self.assertTrue(ar.is_clinic(t0) and ar.is_clinic(t0 + 6 * 3600 - 30))
                else: self.assertFalse(ar.is_clinic(t0))
                self.assertEqual(self.run_6h(t0), [(0, "ROOM ALERT: 1 new, 0 cleared, 0 reminder(s)"),
                                                   (7200, "ROOM ALERT: 0 new, 0 cleared, 1 reminder(s)"),
                                                   (14400, "ROOM ALERT: 0 new, 0 cleared, 1 reminder(s)")])

    def test_a_clear_is_exactly_one_cleared_line(self):
        for how in ("recovered", "ack_close", "ack_then_recovered"):
            with self.subTest(how):
                clock, bus = Clock(TUE_11), FakeBus(); r = ar.Router(ar.SqliteStore(), lambda: bus, clock)
                kind = "capture_dead" if how == "ack_close" else "offline"
                r.on_row(bus, row(100, kind)); r.tick(bus)
                if how == "recovered":
                    clock.adv(600); r.on_row(bus, row(101, "recovered"))
                else:
                    bus.human("gating-lead", "ACK room-alert-100", "room-alert-100")
                for i in range(40):
                    clock.adv(30); r.tick(bus)
                    if how == "ack_then_recovered" and i == 20: r.on_row(bus, row(102, "recovered"))
                posts = [m for m in bus.real if m["from"] == "router"]
                lines = [l for m in posts for l in m["body"].splitlines() if "[cleared]" in l]
                self.assertEqual(len(lines), 1, lines); self.assertTrue(lines[0].startswith(f"room-alert-100 {kind} in r1 cleared: "))
                self.assertEqual([m["subject"] for m in posts if "[cleared]" in m["body"]], ["ROOM ALERT: 0 new, 1 cleared, 0 reminder(s)"])
                self.assertEqual(len(posts), 2)                          # the page and the cleared line; no note message

    def test_a_case_never_paged_gets_no_cleared_line(self):
        clock, bus = Clock(TUE_11), FakeBus(); r = ar.Router(ar.SqliteStore(), lambda: bus, clock)
        r.on_row(bus, row(100, "offline")); r.on_row(bus, row(101, "recovered")); r.tick(bus)
        self.assertEqual(bus.real, [])

    def test_twenty_notes_go_out_only_in_the_21_00_digest(self):
        t0 = ist(2026, 10, 13, 9, 0); clock, bus, store = Clock(t0), FakeBus(), ar.SqliteStore(); r = ar.Router(store, lambda: bus, clock)
        for i in range(20):
            store.add_note(f"note {i:02d} room-alert-{500 + i} offline in r{i} CLOSED (recovery) after 3 min. Pages sent 0, duplicates folded 0.", clock())
            clock.adv(1800); r.tick(bus)
        clock.t = ist(2026, 10, 13, 20, 59) + 30; r.tick(bus)
        self.assertEqual(bus.sends, 0)
        clock.t = ist(2026, 10, 13, 21, 0); out = r.tick(bus)
        self.assertEqual((bus.sends, out["notes"], out["digest"]), (1, 20, 1))
        self.assertEqual(bus.real[0]["subject"], "ROOM DIGEST 2026-10-13")
        for i in range(20): self.assertIn(f"note {i:02d} room-alert-{500 + i}", bus.real[0]["body"])
        self.assertEqual(store.list_notes(), [])
        for _ in range(10): clock.adv(30); r.tick(bus)
        self.assertEqual(bus.sends, 1)

    def test_notes_that_do_not_fit_continue_the_same_evening_and_later_notes_wait(self):
        clock, bus, store = Clock(ist(2026, 10, 13, 20, 0)), FakeBus(), ar.SqliteStore(); r = ar.Router(store, lambda: bus, clock)
        for i in range(60): store.add_note(f"long note {i:02d} " + "x" * 100, clock())
        clock.t = ist(2026, 10, 13, 21, 0); r.tick(bus); clock.adv(30); r.tick(bus)
        self.assertEqual([m["subject"] for m in bus.real], ["ROOM DIGEST 2026-10-13", "ROOM DIGEST 2026-10-13 (cont.)"])
        self.assertEqual(store.list_notes(), [])
        self.assertTrue(all(len(m["body"]) <= ar.BODY_CAP for m in bus.real))
        store.add_note("late note", clock()); clock.adv(30); r.tick(bus)
        self.assertEqual(bus.sends, 2)                                         # queued after the digest: waits for tomorrow's
        clock.t = ist(2026, 10, 14, 21, 0); r.tick(bus); self.assertIn("late note", bus.real[-1]["body"])

    def test_two_cases_opening_in_one_tick_are_one_message(self):
        clock, bus = Clock(TUE_11), FakeBus(); r = ar.Router(ar.SqliteStore(), lambda: bus, clock)
        r.on_row(bus, row(100, "offline")); r.on_row(bus, row(200, "degraded", "r2")); r.tick(bus)
        self.assertEqual(bus.sends, 1); self.assertEqual(bus.real[0]["subject"], "ROOM ALERT: 2 new, 0 cleared, 0 reminder(s)")
        self.assertIn("room-alert-100 offline in r1", bus.real[0]["body"]); self.assertIn("room-alert-200 degraded in r2", bus.real[0]["body"])

    def test_a_case_acked_before_d7_gets_no_cleared_line_when_it_recovers(self):
        clock, bus, store = Clock(TUE_11), FakeBus(), ar.SqliteStore()
        store.insert({"first_id": 60, "room_id": "r1", "kind": "offline", "opened_at": clock() - 900, "last_paged_at": clock() - 900, "page_count": 1,
                      "suppressed_count": 0, "acked_by": "fleet", "acked_at": clock() - 300, "closed_at": None, "close_reason": None})   # acked under the old code
        r = ar.Router(store, lambda: bus, clock); r.tick(bus)
        clock.adv(60); r.on_row(bus, row(61, "recovered")); self.assertIsNone(store.get_open("r1", "offline"))
        for _ in range(5): clock.adv(30); r.tick(bus)
        self.assertEqual([m for m in bus.real if "[cleared]" in m["body"]], [])

    def test_cleared_state_survives_restart_and_pre_d7_closes_are_not_announced(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "local.json"); clock, bus, store = Clock(TUE_11), FakeBus(), ar.SqliteStore()
            store.insert({"first_id": 50, "room_id": "r9", "kind": "offline", "opened_at": clock() - 900, "last_paged_at": clock() - 900, "page_count": 1,
                          "suppressed_count": 0, "acked_by": None, "acked_at": None, "closed_at": clock() - 60, "close_reason": "recovery"})   # closed before D7 ran
            r = ar.Router(store, lambda: bus, clock, p); r.on_row(bus, row(100, "offline")); r.tick(bus)
            clock.adv(60); r.on_row(bus, row(101, "recovered")); r.tick(bus)
            self.assertEqual([l.split()[0] for m in bus.real for l in m["body"].splitlines() if "[cleared]" in l], ["room-alert-100"])
            r2 = ar.Router(store, lambda: bus, clock, p); clock.adv(30); r2.tick(bus)
            self.assertEqual(bus.sends, 2)


if __name__ == "__main__":
    unittest.main()
