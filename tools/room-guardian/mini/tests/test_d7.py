"""FR1 D7 (22 Oct): the Mini router's own ubus identity, scoped ack reads, one alert per state change. No real shim is started: Popen and select are mocked."""
import io, json, os, sys, unittest
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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
    def on_request(self, req):
        if "id" not in req:
            return
        if req["method"] == "tools/call":
            name, args = req["params"]["name"], req["params"]["arguments"]
            self.calls.append((name, args))
            out = {"ok": True, "handle": self.whoami, "registered": self.registered} if name == "ubus_whoami" else {"ok": True, "messages": []}
            result = {"content": [{"type": "text", "text": json.dumps(out)}]}
        else:
            result = {}
        self.stdout.lines.append(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}) + "\n")
    def terminate(self): self.terminated = True
    def wait(self, timeout=None): return 0


class ShimTests(unittest.TestCase):
    def start(self, whoami="room-guardian", environ=None, registered=True):
        shim, seen = FakeShim(whoami, registered), {}
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
                self.assertIn("whoami handle=room-guardian session=h:room-guardian registered=True", logs)
        self.assertEqual(len(shims), 2); self.assertEqual(len(self.lines()), 1)


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
