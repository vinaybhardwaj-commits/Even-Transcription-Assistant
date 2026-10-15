"""FR1 2.4 d' (Mini side): the consult_open hold in the control line, and start_day after a kiosk reboot. Both behind default-off flags.
KIOSK_RE_V2 is the new-form regex of ~/oc/herdr-lead/CONTROL-CONSULT-OPEN-SHAPE-15OCT.md with its "(...same as today...)" part written out."""
import json, os, re, sys, tempfile, threading, unittest
from datetime import datetime, timezone
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
import consult_hold as ch
import start_day as sd
import ubus_bus
from test_router import ar, FakeBus
from test_subscriber import Clock

KIOSK_RE_V2 = (r'^\{"consult_open": \{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}, "kill": (true|false), "modes": '
               r'\{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$')
KIOSK_RE_OLD = r'^\{"kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$'
T = 1760000000.0


class Sink:
    def __init__(self): self.down, self.up, self.sd_failed = 0, 0, []
    def consult_hold_source_down(self, now): self.down += 1
    def consult_hold_source_up(self, now): self.up += 1
    def start_day_failed(self, room, now): self.sd_failed.append(room)
    def guardian_quiet(self, *a): pass
    def guardian_recovered(self, *a): pass


ROOMS = ["opd-6", "opd-7"]
MAP = {"opd-6": {"machine": "M6", "room_id": "b6", "slug": "s6"}, "opd-7": {"machine": "M7", "room_id": "b7", "slug": "s7"}}
MAP2 = dict(MAP, **{"opd-7": {"machine": ["M7", "M7b"], "room_id": "b7", "slug": "s7"}})        # a two-machine room (map only machines in use)
QUIET = {"capture_open": True, "zero_ratio": 1.0}                 # digital silence: the only quiet line unless capture_closed_counts_quiet is on


class Src:
    """Injected live sources. Each value is data or an exception instance to raise; calls counts invocations per source."""
    def __init__(self, presence=None, session=None, windows=None, levels=None):
        self.v = {"presence": [("M6", T - 10, None), ("M7", T - 10, None)] if presence is None else presence, "levels": [] if levels is None else levels,
                  "session": set() if session is None else session, "windows": [] if windows is None else windows}
        self.calls = {"presence": 0, "session": 0, "windows": 0, "levels": 0}
    def __getitem__(self, name):
        def f(now, arg):
            self.calls[name] += 1
            v = self.v[name]
            if isinstance(v, BaseException):
                raise v
            if name == "presence" and isinstance(v, list) and v and all(isinstance(x, tuple) and len(x) == 3 for x in v):
                # shorthand (machine, heartbeat ts, encounter marker): a heartbeat row, plus an encounter_open when the marker is set
                return {"hb": [(m, t) for m, t, _e in v], "enc": [(m, "encounter_open", t) for m, t, e in v if e]}
            if name == "presence" and isinstance(v, list) and not v:
                return {"hb": [], "enc": []}
            return v
        return f


def mk(src=None, clock=None, rooms=ROOMS, rmap=MAP, audit=None, sink=None, health=True, **kw):
    clock = clock or Clock(T); src = Src() if src is None else src
    h = ch.ConsultHold(rooms, rmap, src, clock, audit_path=audit, sink=sink, **kw)
    if health:
        for r in rooms:
            h.note_health(r, QUIET, clock())
    return h, clock, src


class ControlLine(unittest.TestCase):
    def sub(self, rooms, consult=None, kill=False):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        open(os.path.join(t.name, "kill-switch"), "w").write("on\n" if kill else "off\n")
        return sb.Subscriber(os.path.join(t.name, "d"), t.name, rooms, Sink(), Clock(T), consult=consult)

    def test_flag_off_is_todays_exact_bytes(self):
        s = self.sub(["opd-6-webcam-only-am8n"])
        self.assertEqual(s.control_message(), '{"kill": false, "modes": {"opd-6-webcam-only-am8n": "shadow"}, "ts": 1760000000}')
        self.assertNotIn("consult_open", s.control_message())

    def test_flag_on_0_1_5_64_rooms_match_the_kiosk_new_form_regex(self):
        for n in (0, 1, 5, 64):
            rooms = [f"opd-{i}" if i % 2 else f"r{i}_x" for i in range(n)]
            rmap = {r: {"machine": "m" + r, "room_id": "b" + r, "slug": "s" + r} for r in rooms}
            src = Src(presence=[("m" + r, T - 5, None) for r in rooms])
            for kill in (True, False):
                hold, _, _ = mk(src, rooms=rooms, rmap=rmap)
                msg = self.sub(rooms, hold, kill).control_message()
                self.assertTrue(re.fullmatch(KIOSK_RE_V2, msg), (n, kill, msg[:90]))
                self.assertFalse(re.fullmatch(KIOSK_RE_OLD, msg))
                o = json.loads(msg); self.assertEqual(sorted(o["consult_open"]), sorted(rooms)); self.assertEqual(o["kill"], kill)
                self.assertTrue(msg.startswith('{"consult_open": '))                  # sort_keys puts it first

    def test_the_contract_example_shape(self):
        r = "opd-6-webcam-only-am8n"
        hold, _, _ = mk(Src(presence=[("M", T - 1, None)]), rooms=[r], rmap={r: {"machine": "M", "room_id": "b", "slug": "s"}})
        self.assertEqual(self.sub([r], hold).control_message(),
                         '{"consult_open": {"opd-6-webcam-only-am8n": false}, "kill": false, "modes": {"opd-6-webcam-only-am8n": "shadow"}, "ts": 1760000000}')

    def test_modes_and_kill_keep_their_meaning_with_the_hold_on(self):
        hold, _, _ = mk()
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        open(os.path.join(t.name, "kill-switch"), "w").write("off\n"); os.makedirs(os.path.join(t.name, "modes")); open(os.path.join(t.name, "modes", "opd-6"), "w").write("heal")
        s = sb.Subscriber(os.path.join(t.name, "d"), t.name, ROOMS, Sink(), Clock(T), consult=hold)
        o = json.loads(s.control_message()); self.assertEqual((o["kill"], o["modes"]), (False, {"opd-6": "heal", "opd-7": "shadow"}))

    def test_validate_rooms_counts_the_hold_when_the_flag_is_on(self):
        for L in range(30, 65):
            rooms = [("r%02d" % i).ljust(L, "x") for i in range(64)]
            if sb.validate_rooms(rooms) is None and sb.validate_rooms(rooms, consult_open=True) is not None:
                return
        self.fail("no 64-room slug length fits without the hold but not with it")

    def test_room_budget_with_the_flag_on(self):
        """I1: the 4000-byte cap. 64 rooms fit with the hold only for slugs of 18 characters or fewer (measured here); 19 is refused at start."""
        mk_rooms = lambda L: [("r%02d" % i).ljust(L, "x") for i in range(64)]
        self.assertIsNone(sb.validate_rooms(mk_rooms(18), consult_open=True)); self.assertIsNotNone(sb.validate_rooms(mk_rooms(19), consult_open=True))

    def test_a_non_bool_hold_value_is_published_true(self):
        class Odd:
            def hold(self, now): return {"opd-6": None}
        s = self.sub(["opd-6", "opd-7"], Odd())
        self.assertEqual(json.loads(s.control_message())["consult_open"], {"opd-6": True, "opd-7": True})


class HoldSemantics(unittest.TestCase):
    def test_both_live_signals_fresh_and_quiet_is_false(self):
        h, _, _ = mk(); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})

    def test_each_signal_alone_makes_a_room_true(self):
        cases = {
            "presence stale (no event)": dict(src=Src(presence=[("M7", T - 5, None)])),
            "presence stale (121 s)": dict(src=Src(presence=[("M6", T - 121, None), ("M7", T - 5, None)])),
            "presence consulting": dict(src=Src(presence=[("M6", T - 5, "enc-1"), ("M7", T - 5, None)])),
            "presence error": dict(src=Src(presence=RuntimeError("down"))),
            "session open with level activity": dict(src=Src(session={"b6"}, levels=[("b6", T - 5)])),
            "session error": dict(src=Src(session=RuntimeError("down"))),
            "windows open (enabled)": dict(src=Src(windows=[("s6", "b6", T - 600, None)]), consult_windows_enabled=True),
            "windows error (enabled)": dict(src=Src(windows=RuntimeError("down")), consult_windows_enabled=True),
        }
        for name, kw in cases.items():
            with self.subTest(name):
                h, _, _ = mk(**kw); self.assertTrue(h.hold()["opd-6"], name)

    def test_kiosk_health_alone(self):
        for name, feed, want in (("missing", None, True), ("active capture", {"capture_open": True, "zero_ratio": 0.2}, True), ("capture, no ratio", {"capture_open": True}, True),
                                 ("capture, NaN ratio", {"capture_open": True, "zero_ratio": float("nan")}, True), ("capture, bool ratio", {"capture_open": True, "zero_ratio": True}, True),
                                 ("capture_open missing", {"zero_ratio": 1.0}, True), ("capture_open str", {"capture_open": "false"}, True),
                                 ("digital silence", {"capture_open": True, "zero_ratio": 0.99}, False), ("capture closed (quiet, fable 17:16)", {"capture_open": False}, False),
                                 ("inf ratio", {"capture_open": True, "zero_ratio": float("inf")}, True), ("ratio above 1", {"capture_open": True, "zero_ratio": 5}, True),
                                 ("negative ratio", {"capture_open": True, "zero_ratio": -1}, True), ("str ratio", {"capture_open": True, "zero_ratio": "1.0"}, True),
                                 ("ratio exactly 1", {"capture_open": True, "zero_ratio": 1}, False), ("ratio 0.98", {"capture_open": True, "zero_ratio": 0.98}, False)):
            with self.subTest(name):
                h, _, _ = mk(health=False)
                if feed is not None: h.note_health("opd-6", feed, T)
                h.note_health("opd-7", QUIET, T)
                self.assertEqual(h.hold()["opd-6"], want, name)

    def test_the_two_minute_boundary_on_every_fresh_signal(self):
        h, clock, _ = mk(Src(presence=[("M6", T - 120, None), ("M7", T - 120, None)]))
        self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})                 # exactly 120 s old: still fresh
        h2, _, _ = mk(Src(presence=[("M6", T - 120.5, None), ("M7", T - 120.5, None)]))
        self.assertEqual(h2.hold(), {"opd-6": True, "opd-7": True})
        h4, c4, s4 = mk(); c4.adv(30); s4.v["presence"] = [("M6", c4() - 1, None), ("M7", c4() - 1, None)]
        for r in ROOMS: h4.note_health(r, QUIET, c4())
        self.assertEqual(h4.hold(c4()), {"opd-6": False, "opd-7": False})

    def test_health_older_than_120_s_is_stale(self):
        h, clock, src = mk(); h.hold(); clock.adv(121)
        src.v["presence"] = [("M6", clock() - 1, None), ("M7", clock() - 1, None)]
        self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True})            # presence and session refreshed, health not fed
        h.note_health("opd-6", QUIET, clock()); h.note_health("opd-7", QUIET, clock())
        self.assertEqual(h.hold(clock()), {"opd-6": False, "opd-7": False})

    def test_unmapped_rooms_are_true(self):
        for rmap in ({"opd-6": MAP["opd-6"]}, {"opd-6": MAP["opd-6"], "opd-7": {"machine": "M7"}}, {"opd-6": MAP["opd-6"], "opd-7": {"room_id": "b7"}},
                     {"opd-6": MAP["opd-6"], "opd-7": "s7"}, {"opd-6": MAP["opd-6"], "opd-7": None}, {"opd-6": MAP["opd-6"], "opd-7": {"machine": [], "room_id": "b7"}}):
            with self.subTest(rmap=rmap):
                h, _, _ = mk(rmap=rmap); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": True})

    def test_windows_can_force_true_never_false(self):
        W = dict(consult_windows_enabled=True)
        h, _, _ = mk(Src(windows=[("s6", "b6", T - 600, None)]), **W); self.assertEqual(h.hold(), {"opd-6": True, "opd-7": False})
        h, _, _ = mk(Src(windows=[("s6", "b6", T - 9000, T - 8000)]), **W); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})
        h, _, _ = mk(Src(presence=[], windows=[]), **W); self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})        # quiet windows cannot rescue a stale presence
        h, _, _ = mk(Src(session={"b6"}, levels=[("b6", T - 5)], windows=[]), **W); self.assertTrue(h.hold()["opd-6"])
        self.assertTrue(ch.window_open(T - 900, T - 60, T)); self.assertFalse(ch.window_open(T - 900, T - 300, T)); self.assertFalse(ch.window_open(T - 5 * 3600, None, T))
        for bad in ((None, None), (float("nan"), None), (True, None), ("x", None), (T - 900, float("nan")), (T - 900, "x"), (float("inf"), None), (T + 500, None)):
            self.assertTrue(ch.window_open(bad[0], bad[1], T), bad)

    def test_garbage_replies_hold_and_never_raise(self):
        for bad in (None, 5, "x", [("a",)], [("M6", T)], [1, 2], (1, 2, 3)):
            for name in ("presence", "session", "levels"):
                if name == "levels" and isinstance(bad, list):
                    continue                                                                         # a list of odd rows is a valid reply: rows for unknown rooms are dropped
                src = Src(session={"b6", "b7"} if name == "levels" else None); src.v[name] = bad        # levels only matter for a room with an open session
                h, _, _ = mk(src)
                out = h.hold(); self.assertEqual(out["opd-6"], True, (name, bad))                  # each of these sources is required for a false
            out = mk(Src(windows=bad))[0].hold()                                                    # windows off (default): garbage changes nothing, never raises
            self.assertEqual(out, {"opd-6": False, "opd-7": False}, bad)
            if bad is not None and not isinstance(bad, list):                                       # (None is the stub default; a list of odd rows is a valid reply, those rows are dropped)
                out = mk(Src(windows=bad), consult_windows_enabled=True)[0].hold()                  # windows on: a bad reply is a read error, true for the slugged rooms
                self.assertEqual(out["opd-6"], True, bad)

    def test_timeout_and_no_pileup_of_fetch_threads(self):
        gate = threading.Event(); self.addCleanup(gate.set); calls = []
        class Hung(dict):
            def __getitem__(self, n):
                def f(now, arg): calls.append(n); gate.wait(10); return []
                return f
        h, clock, _ = mk(Hung(), timeout_s=0.05)
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})
        for _ in range(10):
            clock.adv(31); h.hold(clock())
        self.assertEqual(sorted(calls), ["levels", "presence", "session"])           # one thread per source; none started while one was alive

    def test_cache_is_30_s(self):
        h, clock, src = mk(); h.hold(); clock.adv(29); h.hold(clock()); self.assertEqual(src.calls["presence"], 1)
        clock.adv(2); h.hold(clock()); self.assertEqual(src.calls["presence"], 2)

    def test_audit_line_per_room_lists_the_deciding_signals_and_only_on_change(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); path = os.path.join(t.name, "a.jsonl")
        h, clock, src = mk(audit=path)
        h.hold(); h.hold()
        lines = [json.loads(x) for x in open(path)]
        self.assertEqual([(l["room"], l["consult_open"], l["why"], l["signals"]) for l in lines], [("opd-6", False, "clear", ["clear"]), ("opd-7", False, "clear", ["clear"])])
        src.v["session"] = {"b6"}; clock.adv(31)
        for r in ROOMS: h.note_health(r, QUIET, clock())
        src.v["presence"] = [("M6", clock() - 1, "e"), ("M7", clock() - 1, None)]; h.hold(clock())
        lines = [json.loads(x) for x in open(path)]; self.assertEqual(len(lines), 3)
        self.assertEqual((lines[2]["room"], lines[2]["consult_open"], lines[2]["why"], lines[2]["signals"], lines[2]["ts"]),
                         ("opd-6", True, "presence_consulting", ["presence_consulting"], int(T + 31)))

    def test_audit_write_fault_never_changes_the_hold(self):
        h, _, _ = mk(audit="/nonexistent-dir/x.jsonl"); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})


class Boom(Sink):
    def consult_hold_source_down(self, now): raise RuntimeError("store locked")
    def consult_hold_source_up(self, now): raise RuntimeError("store locked")


class StuckSource(unittest.TestCase):
    def down_env(self, sink):
        return mk(Src(presence=RuntimeError("down")), sink=sink)

    def test_case_opens_after_30_min_of_source_error_once_and_closes_on_recovery(self):
        sink = Sink(); h, clock, src = self.down_env(sink)
        for _ in range(59):
            h.hold(clock()); clock.adv(30)
        self.assertEqual(sink.down, 0)                                            # 29.5 min
        h.hold(clock()); clock.adv(30); h.hold(clock()); self.assertEqual(sink.down, 1)
        for _ in range(8):
            clock.adv(30); h.hold(clock())
        self.assertEqual(sink.down, 1)
        src.v["presence"] = [("M6", clock() - 1, None), ("M7", clock() - 1, None)]; clock.adv(30); h.hold(clock())
        self.assertEqual((sink.down, sink.up), (1, 1))

    def test_a_missing_mapping_alone_is_not_a_source_error(self):
        sink = Sink(); h, clock, _ = mk(rmap={}, sink=sink)
        for _ in range(80):
            self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True}); clock.adv(30)
        self.assertEqual(sink.down, 0)

    def test_the_case_through_the_real_router_is_normal_priority_not_v_and_closes_on_recovery(self):
        router = ar.Router(ar.SqliteStore(), lambda: FakeBus(), Clock(T)); sink = sb.RouterSink(router)
        h, clock, src = self.down_env(sink)
        for _ in range(64):
            h.hold(clock()); clock.adv(30)
        self.assertEqual([x["room_id"] for x in router.store.list_open() if x["kind"] == "consult_hold_source_down"], ["mini"])
        self.assertNotIn("consult_hold_source_down", ar.URGENT); self.assertNotIn("consult_hold_source_down", ar.V_KINDS)
        src.v["presence"] = [("M6", clock() - 1, None), ("M7", clock() - 1, None)]; clock.adv(30); h.hold(clock())
        self.assertEqual([x for x in router.store.list_open() if x["kind"] == "consult_hold_source_down"], [])


class NeverBreaksControl(unittest.TestCase):
    """M1 (refute): no exception from the hold path may reach control_message, or no room gets a control line, which the kiosks read as a kill."""
    def control(self, hold):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); open(os.path.join(t.name, "kill-switch"), "w").write("off\n")
        clock = hold.clock
        return sb.Subscriber(os.path.join(t.name, "d"), t.name, ROOMS, Sink(), clock, consult=hold)

    def test_a_raising_sink_and_a_raising_store_still_publish_every_room_true(self):
        router = ar.Router(ar.SqliteStore(), lambda: FakeBus(), Clock(T))
        def locked(*a): raise RuntimeError("database is locked")
        router.store.alloc_local_id = locked; router.store.insert = locked
        for sink in (Boom(), sb.RouterSink(router)):
            h, clock, src = mk(Src(presence=RuntimeError("down")), sink=sink); s = self.control(h)
            for i in range(80):                                                   # 40 min: through the 30 min mark where the case is attempted
                msg = s.control_message(); self.assertTrue(re.fullmatch(KIOSK_RE_V2, msg))
                self.assertEqual(json.loads(msg)["consult_open"], {"opd-6": True, "opd-7": True})
                clock.adv(30)
            src.v["presence"] = [("M6", clock() - 1, None), ("M7", clock() - 1, None)]; clock.adv(31)           # recovery with a raising close
            for r in ROOMS: h.note_health(r, QUIET, clock())
            self.assertEqual(json.loads(s.control_message())["consult_open"], {"opd-6": False, "opd-7": False})

    def test_a_failing_sink_is_retried_at_most_every_5_min(self):
        class Count(Boom):
            n = 0
            def consult_hold_source_down(self, now): Count.n += 1; raise RuntimeError("x")
        h, clock, _ = mk(Src(presence=RuntimeError("down")), sink=Count())
        for _ in range(240):
            h.hold(clock()); clock.adv(30)                                        # 2 h
        self.assertLess(Count.n, 20); self.assertGreater(Count.n, 1)

    def test_an_exception_inside_the_hold_computation_holds_every_room(self):
        h, clock, _ = mk(); h._room = lambda r, now: 1 / 0
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})
        def boom(now): raise RuntimeError("refresh broke")
        h._refresh = boom
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})
        h._audit = lambda *a: (_ for _ in ()).throw(KeyError("audit"))
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})
        s = self.control(h); self.assertEqual(json.loads(s.control_message())["consult_open"], {"opd-6": True, "opd-7": True})

    def test_a_hold_that_raises_outright_is_caught_by_the_control_snapshot(self):
        class Raises:
            clock = Clock(T)
            def hold(self, now): raise RuntimeError("x")
            def note_health(self, *a): raise RuntimeError("x")
        s = self.control(Raises())
        self.assertEqual(json.loads(s.control_message())["consult_open"], {"opd-6": True, "opd-7": True})
        self.assertTrue(s.on_line("kiosk/opd-6/health", json.dumps({"zero_ratio": 0.0})))    # a failing note_health does not stop health handling


class PgSources(unittest.TestCase):
    """S3: pg_sources against a fake psycopg: read-only at connect, the 5 s statement timeout, parameters bound, credential read from the file."""
    def setUp(self):
        self.calls = []
        outer = self
        class Conn:
            read_only = False
            def execute(self, sql, params): outer.calls.append(("execute", sql, params)); self.sql = sql; return self
            def fetchall(self): return outer.rows[self.sql] if isinstance(outer.rows, dict) else outer.rows
            def close(self): outer.calls.append(("close",))
        self.conn = Conn(); self.rows = []
        class Fake:
            @staticmethod
            def connect(url, **kw): outer.calls.append(("connect", url, kw)); return outer.conn
        self.saved = sys.modules.get("psycopg"); sys.modules["psycopg"] = Fake
        self.addCleanup(lambda: sys.modules.__setitem__("psycopg", self.saved) if self.saved else sys.modules.pop("psycopg", None))
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); self.f = os.path.join(t.name, "db.url"); open(self.f, "w").write("postgres://u:p@h/db\n")

    def test_connect_options_and_cleanup(self):
        ch.pg_sources(self.f)["session"](T, ["b6"])
        kind, url, kw = self.calls[0]
        self.assertEqual((kind, url), ("connect", "postgres://u:p@h/db"))
        self.assertIn("default_transaction_read_only=on", kw["options"]); self.assertIn("statement_timeout=5000", kw["options"]); self.assertEqual(kw["connect_timeout"], 5)
        self.assertTrue(self.conn.read_only); self.assertEqual(self.calls[-1], ("close",))

    def test_sql_is_constant_with_bound_parameters(self):
        at = datetime.fromtimestamp(T - 3, timezone.utc)
        self.rows = {ch.HB_SQL: [("M6", at)], ch.ENC_SQL: [("M6", "encounter_open", at)], ch.POST_SQL: [("M6", "encounter_open", at)]}
        out = ch.pg_sources(self.f)["presence"](T, ["M6"])
        self.assertEqual(out, {"hb": [("M6", T - 3)], "enc": [("M6", "encounter_open", T - 3)], "post": [("M6", "encounter_open", T - 3)]})
        ex = [c for c in self.calls if c[0] == "execute"]; self.assertEqual([x[1] for x in ex], [ch.HB_SQL, ch.ENC_SQL, ch.POST_SQL]); self.assertEqual(ex[0][2][0], ["M6"])
        utc = timezone.utc                                                                           # I-1: the lookbacks are pinned (heartbeat 2 min, encounter events 4 h)
        self.assertEqual(ex[0][2][1], datetime.fromtimestamp(T - 120, utc)); self.assertEqual(ex[1][2][1], datetime.fromtimestamp(T - 4 * 3600, utc))
        self.assertEqual(ex[2][2][1], datetime.fromtimestamp(T - 4 * 3600, utc)); self.assertEqual(ch.ENC_LOOKBACK_S, 4 * 3600)
        self.rows = [("b6",)]; self.assertEqual(ch.pg_sources(self.f)["session"](T, ["b6"]), {"b6"})
        self.rows = [("s6", "b6", datetime.fromtimestamp(T - 9, timezone.utc), None)]; self.assertEqual(ch.pg_sources(self.f)["windows"](T, None), [("s6", "b6", T - 9, None)])
        self.rows = [("b6", datetime.fromtimestamp(T - 3, timezone.utc))]; self.assertEqual(ch.pg_sources(self.f)["levels"](T, ["b6"]), [("b6", T - 3)])
        for q in (ch.HB_SQL, ch.ENC_SQL, ch.POST_SQL, ch.SESSION_SQL, ch.LEVEL_SQL, ch.WIN_SQL):
            self.assertIn("%s", q); self.assertNotIn("{", q)

    def test_a_missing_credential_file_is_a_source_error_not_a_crash(self):
        h = ch.ConsultHold(ROOMS, MAP, ch.pg_sources("/nonexistent/db.url"), Clock(T))
        for r in ROOMS: h.note_health(r, QUIET, T)
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})


def health(boot_age, usb=True, rec_age=50, cap=False, **kw):
    d = {"room_id": "r1", "ts": 1, "boot_age_s": boot_age, "usb_mic_present": usb, "recorder_pid_age_s": rec_age, "capture_open": cap}
    d.update(kw); return d


class StartDay(unittest.TestCase):
    def mk(self, **kw):
        self.sent, self.sink, self.clock = [], Sink(), Clock(T)
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); self.dir = t.name
        self.sender_err = kw.pop("err", None)
        def sender(room):
            self.sent.append(room)
            if self.sender_err: raise self.sender_err
        self.sd = sd.StartDayAfterBoot(sender, os.path.join(t.name, "state.json"), self.sink, self.clock, **kw)
        return self.sd

    def test_sent_once_per_boot(self):
        s = self.mk(); s.on_health("r1", health(100))
        self.assertEqual(self.sent, ["r1"])
        self.clock.adv(10); s.on_health("r1", health(112)); self.clock.adv(10); s.on_health("r1", health(121))
        self.assertEqual(self.sent, ["r1"])                                       # same boot (epoch within tolerance), not re-sent
        self.clock.adv(7200); s.on_health("r1", health(200))                       # a new boot
        self.assertEqual(self.sent, ["r1", "r1"])

    def test_not_sent_when_a_condition_fails(self):
        s = self.mk()
        for h in (health(600), health(1000), health(100, usb=False), health(100, usb=None), health(100, rec_age=None), health(None), health("100"),
                  health(True), health(-5), {"room_id": "r1"}, "x"):
            s.on_health("r1", h)
        self.assertEqual(self.sent, [])
        s.on_health("r1", health(599)); self.assertEqual(self.sent, ["r1"])        # the edge that qualifies

    def test_state_survives_a_subscriber_restart(self):
        s = self.mk(); s.on_health("r1", health(100))
        s2 = sd.StartDayAfterBoot(lambda r: self.sent.append(r), os.path.join(self.dir, "state.json"), self.sink, self.clock)
        self.clock.adv(30); s2.on_health("r1", health(130)); self.assertEqual(self.sent, ["r1"])

    def test_no_started_state_within_10_min_opens_start_day_failed_once(self):
        s = self.mk(); s.on_health("r1", health(100))
        self.clock.adv(599); s.check(); self.assertEqual(self.sink.sd_failed, [])
        self.clock.adv(2); s.check(); s.check(); self.assertEqual(self.sink.sd_failed, ["r1"])

    def test_capture_open_in_time_means_started(self):
        s = self.mk(); s.on_health("r1", health(100))
        self.clock.adv(120); s.on_health("r1", health(220, cap=True))
        self.clock.adv(1000); s.check(); self.assertEqual(self.sink.sd_failed, [])

    def test_a_send_error_is_not_retried_and_surfaces_after_the_deadline(self):
        s = self.mk(err=RuntimeError("no path")); s.on_health("r1", health(100)); s.on_health("r1", health(105))
        self.assertEqual(self.sent, ["r1"]); self.clock.adv(601); s.check(); self.assertEqual(self.sink.sd_failed, ["r1"])

    def test_flag_off_sends_nothing(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        sub = sb.Subscriber(os.path.join(t.name, "d"), t.name, ["r1"], Sink(), Clock(T))                    # start_day=None is the off state
        self.assertTrue(sub.on_line("kiosk/r1/health", json.dumps(health(100)))); sub.check_start_day()
        self.assertIsNone(sub.start_day)

    def test_subscriber_feeds_health_lines_to_it(self):
        s = self.mk(); t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        sub = sb.Subscriber(os.path.join(t.name, "d"), t.name, ["r1"], Sink(), self.clock, start_day=s)
        sub.on_line("kiosk/r1/health", json.dumps(health(100))); sub.on_line("kiosk/r1/health", json.dumps(health(110)))
        self.assertEqual(self.sent, ["r1"])
        self.clock.adv(700); sub.check_start_day(); self.assertEqual(self.sink.sd_failed, ["r1"])

    def test_start_day_failed_is_urgent_a_v_kind_in_the_coreaudio_window_and_ack_only(self):
        k = "start_day_failed"
        self.assertTrue(k in ar.URGENT and k in ar.V_KINDS and k in ar.OPEN_KINDS and k in ar.ACK_CLOSE_KINDS and k in ar.ACK_ONLY_KINDS)
        night = 1760000000 - 14 * 3600                                           # same day, early morning IST (before 07:00)
        self.assertEqual(ar.is_v_window(k, T), ar.is_v_window("capture_dead", T)); self.assertEqual(ar.is_v_window(k, night), ar.is_v_window("capture_dead", night))
        router = ar.Router(ar.SqliteStore(), lambda: FakeBus(), Clock(T)); sink = sb.RouterSink(router)
        sink.start_day_failed("r1", T)
        router.on_row(None, {"id": 99, "kind": "recovered", "room_ids": ["r1"]})
        self.assertEqual([c["kind"] for c in router.store.list_open()], [k])     # a server recovered row does not close it

    def test_a_state_write_fault_never_loses_the_send_or_the_page(self):          # S1
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        sent, sink, clock = [], Sink(), Clock(T)
        s = sd.StartDayAfterBoot(lambda r: sent.append(r), os.path.join(t.name, "no-such-dir", "state.json"), sink, clock)
        s.on_health("r1", health(100)); s.on_health("r1", health(110))
        self.assertEqual(sent, ["r1"])                                              # sent once even though nothing could be saved
        clock.adv(601); s.check(); s.check(); self.assertEqual(sink.sd_failed, ["r1"])  # and the page was not lost

    def test_the_state_is_on_disk_before_the_send(self):                          # S3 (state saved before send)
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); path = os.path.join(t.name, "state.json"); seen = []
        def sender(room): seen.append(json.load(open(path)))
        sd.StartDayAfterBoot(sender, path, Sink(), Clock(T)).on_health("r1", health(100))
        self.assertEqual(len(seen), 1); self.assertIn("r1", seen[0])

    def test_a_sink_fault_on_the_failed_page_is_retried_not_lost(self):
        class Flaky(Sink):
            n = 0
            def start_day_failed(self, room, now):
                Flaky.n += 1
                if Flaky.n == 1: raise RuntimeError("store locked")
                super().start_day_failed(room, now)
        s = self.mk(); s.sink = Flaky(); s.on_health("r1", health(100)); self.clock.adv(601)
        s.check(); self.assertEqual(s.sink.sd_failed, [])
        s.check(); self.assertEqual(s.sink.sd_failed, [])                           # I-e: not retried inside 5 min
        self.clock.adv(301); s.check(); self.assertEqual(s.sink.sd_failed, ["r1"])

    def test_a_corrupt_state_entry_is_dropped_and_never_raises(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); path = os.path.join(t.name, "state.json")
        json.dump({"r1": {"sent_at": 5}, "r2": {"boot": "x", "sent_at": 5}, "r3": 7}, open(path, "w"))
        s = sd.StartDayAfterBoot(lambda r: None, path, Sink(), Clock(T)); self.assertEqual(s.state, {})
        s.on_health("r1", health(100)); s.check()

    def test_nan_and_inf_boot_ages_send_nothing(self):                            # S4
        s = self.mk()
        for v in (float("nan"), float("inf"), float("-inf")):
            s.on_health("r1", health(v))
        self.assertEqual(self.sent, [])

    def test_a_start_day_fault_does_not_stop_the_rest_of_health_handling(self):    # I4
        class Raises:
            def on_health(self, *a): raise RuntimeError("x")
            def check(self, *a): raise RuntimeError("x")
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        sub = sb.Subscriber(os.path.join(t.name, "d"), t.name, ["r1"], Sink(), Clock(T), start_day=Raises())
        self.assertTrue(sub.on_line("kiosk/r1/health", json.dumps({"zero_ratio": 0.0})))
        self.assertEqual(sub.ok_streak["r1"], 1); sub.check_start_day()
        s2 = self.mk(); s2.state_path = None
        s2.on_health("r1", {"boot_age_s": 100, "usb_mic_present": True, "recorder_pid_age_s": 5, "capture_open": False}, now="bad")      # a fault inside is swallowed

    def test_command_sender_has_no_shell_a_30_s_timeout_and_refuses_an_option_looking_room(self):    # S3, I3
        got = []
        send = sd.command_sender(["/bin/x", "--flag"], runner=lambda argv, **kw: got.append((argv, kw)))
        send("r1"); argv, kw = got[0]
        self.assertEqual(argv, ["/bin/x", "--flag", "r1"]); self.assertEqual(kw["timeout"], 30); self.assertTrue(kw["check"]); self.assertFalse(kw.get("shell", False))
        for bad in ("-x", "--help", "", None):
            with self.assertRaises(ValueError):
                send(bad)
        self.assertEqual(len(got), 1)

    def test_build_refuses_without_a_start_day_cmd(self):                           # S3 (refuse to start)
        for flags in ({}, {"start_day_cmd": []}, {"start_day_cmd": None}):
            with self.assertRaises(sd.ConfigError):
                sd.build(flags, Sink(), tempfile.gettempdir())
        s = sd.build({"start_day_cmd": ["/bin/x"]}, Sink(), tempfile.gettempdir(), runner=lambda *a, **k: None)
        self.assertEqual(s.state_path, os.path.join(tempfile.gettempdir(), "data", "start-day-state.json"))


class Round3(unittest.TestCase):
    def enc(self, *events, hb=(("M6", T - 5), ("M7", T - 5))):
        return {"hb": list(hb), "enc": list(events)}

    def hold(self, src, **kw):
        h, _, _ = mk(src, **kw); return h.hold()

    def test_heartbeats_only_ten_minutes_into_a_consult_read_as_consulting(self):                     # R2-M1
        src = Src(presence=self.enc(("M6", "encounter_open", T - 600), hb=[("M6", T - 5), ("M6", T - 35), ("M6", T - 65), ("M7", T - 5)]))
        self.assertEqual(self.hold(src), {"opd-6": True, "opd-7": False})
        h, _, _ = mk(src); h.hold()
        self.assertIn("presence_consulting", h.last["opd-6"][1])

    def test_the_newest_open_or_close_decides(self):
        for ev, want in ((("M6", "encounter_open", T - 10), True), (("M6", "encounter_close", T - 10), False), (("M6", "encounter_open", T - 3 * 3600), True),
                         (("M6", "encounter_other", T - 10), True), (("M6", "encounter_open", float("nan")), True), (("M6", "encounter_open", None), True)):
            with self.subTest(ev=ev):
                self.assertEqual(self.hold(Src(presence=self.enc(ev)))["opd-6"], want)
        self.assertEqual(self.hold(Src(presence=self.enc()))["opd-6"], False)                         # no open/close in the lookback and fresh heartbeats: not consulting
        self.assertEqual(self.hold(Src(presence=self.enc(("M7", "encounter_open", T - 10))))["opd-6"], False)            # another machine's open does not hold this room
        self.assertEqual(self.hold(Src(presence=self.enc(("M7b", "encounter_open", T - 10), hb=[("M6", T - 5), ("M7", T - 5), ("M7b", T - 5)])), rmap=MAP2)["opd-7"], True)    # any of the room's machine keys

    def test_stale_heartbeats_are_down_even_with_no_events(self):
        self.assertTrue(self.hold(Src(presence=self.enc(hb=[("M6", T - 121), ("M7", T - 5)])))["opd-6"])
        self.assertTrue(self.hold(Src(presence=self.enc(hb=[("M7", T - 5)])))["opd-6"])
        self.assertFalse(self.hold(Src(presence=self.enc(hb=[("M6", T - 120), ("M7", T - 5)])))["opd-6"])
        self.assertTrue(self.hold(Src(presence=self.enc(hb=[("M6", float("nan")), ("M7", T - 5)])))["opd-6"])

    def test_presence_sql_names_and_has_no_limit_before_the_per_machine_filter(self):                # I-c
        for q in (ch.HB_SQL, ch.ENC_SQL, ch.POST_SQL):
            self.assertIn("DISTINCT ON (p.machine)", q); self.assertNotIn("LIMIT", q)
        self.assertIn("'encounter_open'", ch.ENC_SQL); self.assertIn("'encounter_close'", ch.ENC_SQL)
        self.assertNotIn("p.source", ch.ENC_SQL); self.assertIn("p.source = 'ext'", ch.HB_SQL)             # events from any source; heartbeats from the extension only

    def test_capture_closed_switch_defaults_true(self):                                                # fable 17:16
        closed = {"capture_open": False}
        for kw, want in (({}, False), ({"capture_closed_counts_quiet": True}, False), ({"capture_closed_counts_quiet": False}, True), ({"capture_closed_counts_quiet": "false"}, False),
                         ({"capture_closed_counts_quiet": 0}, False)):
            with self.subTest(kw=kw):
                h, _, _ = mk(health=False, **kw); h.note_health("opd-6", closed, T); h.note_health("opd-7", QUIET, T)
                self.assertEqual(h.hold()["opd-6"], want)                                            # only a literal false turns the switch off
        h, _, _ = mk(health=False)
        h.note_health("opd-6", {"capture_open": "no"}, T); h.note_health("opd-7", {}, T)
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})                                  # the switch only changes a literal false

    def test_fable_17_16_scenarios(self):
        closed = {"capture_open": False}
        def room(src, health=closed):
            h, _, _ = mk(src, health=False); h.note_health("opd-6", health, T); h.note_health("opd-7", QUIET, T); return h.hold()["opd-6"]
        self.assertFalse(room(Src(presence=self.enc(), session=set())))                              # capture_open false + Presence no-open + no active session
        self.assertFalse(room(Src(presence=self.enc(("M6", "encounter_close", T - 9)), session={"b6"}, levels=[("b6", None)])))   # open session, but only silence
        self.assertTrue(room(Src(presence=self.enc(("M6", "encounter_open", T - 9)), session=set())))      # capture_open false + Presence open-without-close
        self.assertTrue(room(Src(presence=self.enc(), session={"b6"}, levels=[("b6", T - 20)])))           # open session with level activity

    def test_open_session_requires_levels_switch_defaults_true(self):                                # fable 17:16
        base = dict(session={"b6"})
        self.assertFalse(self.hold(Src(**base))["opd-6"])                                            # default: an open session with no level activity does not hold
        self.assertTrue(self.hold(Src(**base), open_session_requires_levels=False)["opd-6"])         # switched off: any open session holds
        for name, levels, want in (("recent activity", [("b6", T - 30)], True), ("exactly 120 s", [("b6", T - 120)], True), ("activity 121 s ago", [("b6", T - 121)], False),
                                   ("only silence", [("b6", None)], False), ("no row", [], False), ("other room's activity", [("b7", T - 5)], False),
                                   ("NaN time", [("b6", float("nan"))], True)):
            with self.subTest(name):
                h, _, _ = mk(Src(levels=levels, **base))
                self.assertEqual(h.hold()["opd-6"], want, name)
        h, _, _ = mk(Src(levels=RuntimeError("down"), **base)); self.assertTrue(h.hold()["opd-6"])
        h, _, src = mk(Src(session=set())); self.assertFalse(h.hold()["opd-6"]); self.assertEqual(src.calls["levels"], 1)
        h, _, src = mk(Src(session={"b6"}), open_session_requires_levels=False); self.assertTrue(h.hold()["opd-6"]); self.assertEqual(src.calls["levels"], 0)   # off: not queried

    def test_level_sql_is_bound_and_counts_null_and_out_of_range_as_activity(self):
        self.assertIn("session_open = true", ch.LEVEL_SQL); self.assertNotIn("{", ch.LEVEL_SQL); self.assertIn("zero_ratio IS NULL", ch.LEVEL_SQL); self.assertIn("> 1", ch.LEVEL_SQL)

    def test_an_erroring_source_is_down_at_once_not_after_120_s(self):                              # S-a
        for name, bad in (("presence", RuntimeError("x")), ("session", RuntimeError("x")), ("levels", RuntimeError("x"))):
            with self.subTest(name):
                h, clock, src = mk(Src(session={"b6", "b7"}, levels=[("b6", None), ("b7", None)]) if name == "levels" else None)
                self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})
                src.v[name] = bad; clock.adv(31)
                for r in ROOMS: h.note_health(r, QUIET, clock())
                if name != "presence": src.v["presence"] = {"hb": [("M6", clock() - 1), ("M7", clock() - 1)], "enc": []}
                else: src.v["session"] = set()
                self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True})
                src.v[name] = {"hb": [("M6", clock() + 29), ("M7", clock() + 29)], "enc": []} if name == "presence" else (set() if name == "session" else [])
                clock.adv(31)
                for r in ROOMS: h.note_health(r, QUIET, clock())
                src.v["presence"] = {"hb": [("M6", clock() - 1), ("M7", clock() - 1)], "enc": []}
                self.assertEqual(h.hold(clock()), {"opd-6": False, "opd-7": False})                  # and clears on the next good fetch

    def test_session_stale_after_a_good_fetch_is_true(self):                                         # S-b (mutant N9)
        h, clock, _ = mk(); self.assertEqual(h.hold(T), {"opd-6": False, "opd-7": False})
        h.cache_s = 10 ** 9                                       # no refetch: only the session data ages (the other three are re-fed fresh)
        h.data["presence"] = (self.enc(hb=[("M6", T + 125), ("M7", T + 125)]), T + 130); h.data["windows"] = ([], T + 130)
        for r in ROOMS: h.note_health(r, QUIET, T + 130)
        self.assertEqual(h.hold(T + 130), {"opd-6": True, "opd-7": True})                            # session data is 130 s old
        self.assertEqual(h.last["opd-6"][1], ("session_down",))

    def test_the_session_sql_has_no_started_at_upper_bound(self):                                    # S-c
        self.assertNotIn("<=", ch.SESSION_SQL); self.assertIn("s.started_at > %s", ch.SESSION_SQL)

    def test_health_freshness_is_the_older_of_receive_time_and_line_ts(self):                         # I-a
        for line_ts, want in ((T - 3600, True), (T - 121, True), (T - 119, False), (T, False), (T + 500, False), (None, False), (float("nan"), False), ("x", False)):
            with self.subTest(line_ts=line_ts):
                h, _, _ = mk(health=False); h.note_health("opd-7", QUIET, T)
                h.note_health("opd-6", dict(QUIET, ts=line_ts) if line_ts is not None else QUIET, T)
                self.assertEqual(h.hold()["opd-6"], want)

    def test_the_failed_page_retry_is_audited_once_per_5_min_not_every_loop(self):                    # I-e
        class Broken(Sink):
            def start_day_failed(self, room, now): raise RuntimeError("store locked")
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); audit = os.path.join(t.name, "a.jsonl"); clock = Clock(T)
        s = sd.StartDayAfterBoot(lambda r: None, os.path.join(t.name, "s.json"), Broken(), clock, audit)
        s.on_health("r1", health(100)); clock.adv(601)
        for _ in range(720):
            s.check(); clock.adv(5)                                                                  # one hour of 5 s loops
        n = sum(1 for l in open(audit) if "start_day_failed_sink_fault" in l)
        self.assertGreaterEqual(n, 2); self.assertLessEqual(n, 13)

    def test_new_switches_default_true_in_the_config(self):                                          # fable 17:16
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "router.json")
        for extra, want in (({}, (True, True)), ({"capture_closed_counts_quiet": "false", "open_session_requires_levels": 0}, (True, True)),
                            ({"capture_closed_counts_quiet": False}, (False, True)), ({"open_session_requires_levels": False}, (True, False)),
                            ({"capture_closed_counts_quiet": True, "open_session_requires_levels": True}, (True, True))):
            json.dump(dict({"to": ["a"], "ackers": ["a"]}, **extra), open(p, "w")); c = ubus_bus.load_cfg(p)
            self.assertEqual((c["capture_closed_counts_quiet"], c["open_session_requires_levels"]), want)

    def test_a_read_error_in_one_rooms_source_holds_that_room_only(self):                           # fable 17:16
        class Picky(Src):
            """presence and session fail for any batch that includes M7 / b7, but answer for a single item; M7's own query fails."""
            def __getitem__(self, name):
                inner = Src.__getitem__(self, name)
                def f(now, arg):
                    if name in ("presence", "session", "levels") and len(arg) > 1: raise RuntimeError("batch failed")
                    if name == "presence" and "M7" in arg: raise RuntimeError("M7 read failed")
                    return inner(now, arg)
                return f
        h, clock, _ = mk(Picky())
        self.assertEqual(h.hold(), {"opd-6": False, "opd-7": True})                                  # opd-7 only; opd-6 is unaffected
        self.assertIn("presence_down", h.last["opd-7"][1]); self.assertEqual(h.last["opd-6"][1], ("clear",))
        # a session read that fails for one room only
        class PickyS(Src):
            def __getitem__(self, name):
                inner = Src.__getitem__(self, name)
                def f(now, arg):
                    if name == "session" and (len(arg) > 1 or "b7" in arg): raise RuntimeError("session read failed")
                    return inner(now, arg)
                return f
        h2, _, _ = mk(PickyS()); self.assertEqual(h2.hold(), {"opd-6": False, "opd-7": True}); self.assertIn("session_down", h2.last["opd-7"][1])

    def test_a_malformed_row_for_one_machine_holds_that_room_only(self):
        pres = {"hb": [("M6", T - 5), ("M7", T - 5), ("M7",)], "enc": [("M6", "encounter_close", T - 9), ("M7", "encounter_open")]}
        out = self.hold(Src(presence=pres)); self.assertEqual(out, {"opd-6": False, "opd-7": True})
        pres = {"hb": [("M6", T - 5), ("M7", T - 5), 5, (), None], "enc": []}                       # rows with no readable machine are dropped, nothing breaks
        self.assertEqual(self.hold(Src(presence=pres)), {"opd-6": False, "opd-7": False})
        self.assertEqual(self.hold(Src(session={"b6", "b7", 5, None}, levels=[("b6", None), ("b7",), 3])), {"opd-6": False, "opd-7": True})    # b7's malformed level row holds only opd-7

    def test_windows_off_by_default_makes_no_query_and_ignores_open_windows(self):                    # Round 3b
        h, clock, src = mk(Src(windows=[("s6", "b6", T - 60, None)]))
        self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False}); self.assertEqual(src.calls["windows"], 0)
        for v in (False, "true", 1, None):
            h, _, src = mk(Src(windows=[("s6", "b6", T - 60, None)]), consult_windows_enabled=v)
            self.assertEqual(h.hold()["opd-6"], False, v); self.assertEqual(src.calls["windows"], 0)           # only a literal true enables it
        sink = Sink(); h2, clock2, _ = mk(Src(windows=RuntimeError("down")), sink=sink)
        for _ in range(80):
            h2.hold(clock2()); clock2.adv(30)
            for r in ROOMS: h2.note_health(r, QUIET, clock2())
        self.assertEqual(sink.down, 0)                                                               # an off source being "down" opens no stuck-source case

    def test_windows_enabled_error_or_staleness_holds_the_slugged_room(self):                      # Round 3b
        W = dict(consult_windows_enabled=True)
        h, clock, src = mk(Src(windows=RuntimeError("down")), **W)
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True}); self.assertIn("windows_down", h.last["opd-6"][1])
        src.v["windows"] = []; clock.adv(31)
        for r in ROOMS: h.note_health(r, QUIET, clock())
        src.v["presence"] = {"hb": [("M6", clock() - 1), ("M7", clock() - 1)], "enc": []}
        self.assertEqual(h.hold(clock()), {"opd-6": False, "opd-7": False})                         # recovers on the next good read
        h.cache_s = 10 ** 9; h.data["windows"] = ([], clock() - 130)                                # stale after a good read, no refetch
        for r in ROOMS: h.note_health(r, QUIET, clock())
        h.data["presence"] = (src.v["presence"], clock())
        self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True})
        # a room with no slug has no windows signal to fail
        rmap = {"opd-6": MAP["opd-6"], "opd-7": {"machine": ["M7"], "room_id": "b7"}}
        h3, _, _ = mk(Src(windows=RuntimeError("down")), rmap=rmap, **W); self.assertEqual(h3.hold(), {"opd-6": True, "opd-7": False})
        # enabled, a windows read error also counts toward the 30 min stuck-source case
        sink = Sink(); h4, c4, _ = mk(Src(windows=RuntimeError("down")), sink=sink, **W)
        for _ in range(64):
            h4.hold(c4()); c4.adv(30)
        self.assertEqual(sink.down, 1)

    def test_windows_switch_in_the_config(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "router.json")
        for extra, want in (({}, False), ({"consult_windows_enabled": "true"}, False), ({"consult_windows_enabled": 1}, False), ({"consult_windows_enabled": False}, False),
                            ({"consult_windows_enabled": True}, True)):
            json.dump(dict({"to": ["a"], "ackers": ["a"]}, **extra), open(p, "w")); self.assertEqual(ubus_bus.load_cfg(p)["consult_windows_enabled"], want)


class Round4(unittest.TestCase):
    def enc(self, *events, post=(), hb=(("M6", T - 5), ("M7", T - 5), ("M7b", T - 5))):
        return {"hb": list(hb), "enc": list(events), "post": list(post)}

    def hold(self, pres, rmap=MAP, **kw):
        h, _, _ = mk(Src(presence=pres), rmap=rmap, **kw); return h.hold()

    def test_every_mapped_machine_needs_a_fresh_heartbeat(self):                                     # R3-M1
        fresh = [("M6", T - 5), ("M7", T - 5), ("M7b", T - 5)]
        self.assertEqual(self.hold(self.enc(hb=fresh), MAP2), {"opd-6": False, "opd-7": False})
        for name, hb in (("one machine dead (absent)", [("M6", T - 5), ("M7", T - 5)]), ("one machine stale", [("M6", T - 5), ("M7", T - 5), ("M7b", T - 121)]),
                         ("other one dead", [("M6", T - 5), ("M7b", T - 5)]), ("NaN ts", [("M6", T - 5), ("M7", T - 5), ("M7b", float("nan"))])):
            with self.subTest(name):
                out = self.hold(self.enc(hb=hb), MAP2); self.assertEqual(out, {"opd-6": False, "opd-7": True}, name)
        h, _, _ = mk(Src(presence=self.enc(hb=[("M6", T - 5), ("M7", T - 5)])), rmap=MAP2); h.hold(); self.assertIn("presence_stale", h.last["opd-7"][1])
        # the dead machine's own heartbeat rows of the OTHER machine do not count for it
        self.assertEqual(self.hold(self.enc(hb=[("M6", T - 5), ("M7", T - 5), ("M7", T - 6)]), MAP2)["opd-7"], True)
        self.assertEqual(self.hold(self.enc(hb=[("M6", T - 5), ("M7", T - 120), ("M7b", T - 120)]), MAP2)["opd-7"], False)    # exactly 120 s: still fresh

    def test_post_open_overrides_a_later_url_close(self):                                              # R3-F1, the refuter's repro
        post = [("M6", "encounter_open", T - 900)]; url_close = ("M6", "encounter_close", T - 480)
        self.assertEqual(self.hold(self.enc(url_close, post=post))["opd-6"], True)                     # POST open 15 min ago, URL close 8 min ago, no POST close
        self.assertEqual(self.hold(self.enc(url_close, post=post), post_open_overrides_url_close=False)["opd-6"], False)   # switch off: the newest-of-either rule
        self.assertEqual(self.hold(self.enc(url_close, post=[("M6", "encounter_close", T - 500)]))["opd-6"], False)        # newest POST event is a close: no override
        self.assertEqual(self.hold(self.enc(("M6", "encounter_open", T - 60), post=[("M6", "encounter_close", T - 500)]))["opd-6"], True)   # a later URL open still holds
        self.assertEqual(self.hold(self.enc(post=[("M7", "encounter_open", T - 900)]))["opd-6"], False)    # another machine's POST open does not hold this room
        self.assertEqual(self.hold(self.enc(url_close, post=[("M6", "encounter_open", float("nan"))]))["opd-6"], True)    # unreadable ts: held
        h, _, _ = mk(Src(presence=self.enc(url_close, post=post))); h.hold(); self.assertIn("presence_consulting", h.last["opd-6"][1])

    def test_post_override_switch_defaults_true_in_the_config(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "router.json")
        for extra, want in (({}, True), ({"post_open_overrides_url_close": "false"}, True), ({"post_open_overrides_url_close": 0}, True), ({"post_open_overrides_url_close": False}, False),
                            ({"post_open_overrides_url_close": True}, True)):
            json.dump(dict({"to": ["a"], "ackers": ["a"]}, **extra), open(p, "w")); self.assertEqual(ubus_bus.load_cfg(p)["post_open_overrides_url_close"], want)

    def test_post_sql_is_pinned(self):
        q = ch.POST_SQL
        self.assertIn("p.payload->>'encounter_id' IS NOT NULL", q); self.assertIn("<> ''", q); self.assertIn("'encounter_open', 'encounter_close'", q)
        self.assertNotIn("p.source", q)

    def test_newest_means_server_insert_order_not_the_doctor_clock(self):                           # I-2, S-2 (mutant P3)
        for name in ("HB_SQL", "ENC_SQL", "POST_SQL"):
            q = getattr(ch, name)
            self.assertRegex(q, r"ORDER BY p\.machine, p\.id DESC$", name)                          # the newest row per machine is the highest id
            self.assertNotIn("p.ts DESC", q); self.assertNotIn("ASC", q)
            self.assertIn("DISTINCT ON (p.machine)", q)

    def test_one_room_a_source_error_after_a_good_read_is_true_at_once(self):                       # S-1 (mutant P5)
        one = {"opd-6": MAP["opd-6"]}
        for name in ("presence", "session"):
            with self.subTest(name):
                src = Src(presence=[("M6", T - 10, None)]); h, clock, _ = mk(src, rooms=["opd-6"], rmap=one)
                self.assertEqual(h.hold(), {"opd-6": False})
                src.v[name] = RuntimeError("down"); clock.adv(31)
                h.note_health("opd-6", QUIET, clock())
                if name == "session": src.v["presence"] = {"hb": [("M6", clock() - 1)], "enc": []}
                else: src.v["session"] = set()
                self.assertEqual(h.hold(clock()), {"opd-6": True})                                   # no per-room retry for one room: only the err flag holds it

    def test_windows_on_a_garbage_row_for_the_rooms_slug_holds_that_room(self):                      # S-3
        W = dict(consult_windows_enabled=True)
        h, _, _ = mk(Src(windows=[("s6",), ("s7", "b7", T - 9000, T - 8000)]), **W)
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": False}); self.assertIn("windows_down", h.last["opd-6"][1])
        h, _, _ = mk(Src(windows=[("other",), 5]), **W); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})        # a row for no mapped slug is dropped

    def test_one_rooms_fault_leaves_the_other_rooms_values_intact(self):                              # I-4 (mutant P16)
        h, _, _ = mk(); orig = h._room
        def picky(r, now):
            if r == "opd-7": raise RuntimeError("room fault")
            return orig(r, now)
        h._room = picky
        self.assertEqual(h.hold(), {"opd-6": False, "opd-7": True})                                  # exactly: only the faulting room is held
        self.assertEqual(h.last["opd-7"][1], ("fault",)); self.assertEqual(h.last["opd-6"][1], ("clear",))


class Round5(unittest.TestCase):
    def test_a_body_failed_consult_start_counts_as_post_driven(self):                                # S-1
        q = ch.POST_SQL
        self.assertIn("AND ((p.payload->>'encounter_id' IS NOT NULL AND p.payload->>'encounter_id' <> '') OR p.payload->>'reason' LIKE 'body\\_%%') AND p.machine", q)
        # (the clause is an OR alternative to a non-empty encounter_id, with the underscore escaped and the % doubled for psycopg)
        self.assertEqual(q.replace("%s", "").replace("%%", "").count("%"), 0)                          # no stray % that psycopg would read as a placeholder
        self.assertEqual(q.count("%s"), 2)
        # the refuter's repro at the hold level: the SQL returns the body-failed POST open as a POST event (encounter_id null, reason body_not_json); a URL close came later
        pres = {"hb": [("M6", T - 5), ("M7", T - 5)], "enc": [("M6", "encounter_close", T - 480)], "post": [("M6", "encounter_open", T - 900)]}
        h, _, _ = mk(Src(presence=pres)); self.assertEqual(h.hold()["opd-6"], True)
        h, _, _ = mk(Src(presence=pres), post_open_overrides_url_close=False); self.assertEqual(h.hold()["opd-6"], False)

    def test_the_post_sql_reason_values_match_the_extension(self):
        # lib/body.js WHY and agent.js onCompleted: reason = 'body_' + why, why in WHY, so every reason starts with 'body_'
        for why in ("no_body", "form_no_key", "raw_missing", "raw_file_only", "too_large", "not_json", "json_no_key", "bad_uid"):
            self.assertTrue(("body_" + why).startswith("body_"))

    def flags(self, extra):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "router.json")
        json.dump(dict({"to": ["a"], "ackers": ["a"], "consult_room_map": MAP, "consult_db_url_file": "/nonexistent/db.url"}, **extra), open(p, "w"))
        return ubus_bus.load_cfg(p)

    def test_build_wires_every_switch_the_way_run_subscriber_does(self):                              # S-2 (mutant Q10)
        sink = Sink()
        cases = (({}, (True, True, True, False)),
                 ({"post_open_overrides_url_close": False, "capture_closed_counts_quiet": False, "open_session_requires_levels": False, "consult_windows_enabled": True},
                  (False, False, False, True)),
                 ({"post_open_overrides_url_close": True, "capture_closed_counts_quiet": True, "open_session_requires_levels": True, "consult_windows_enabled": False},
                  (True, True, True, False)),
                 ({"post_open_overrides_url_close": False}, (False, True, True, False)), ({"capture_closed_counts_quiet": False}, (True, False, True, False)),
                 ({"open_session_requires_levels": False}, (True, True, False, False)), ({"consult_windows_enabled": True}, (True, True, True, True)))
        for extra, want in cases:
            with self.subTest(extra=extra):
                h = ch.build(self.flags(extra), ROOMS, sink, tempfile.gettempdir(), Clock(T), sources=Src())
                self.assertEqual((h.post_override, h.closed_quiet, h.need_levels, h.windows_on), want)
                self.assertIs(h.sink, sink); self.assertEqual(h.map, MAP); self.assertEqual(h.rooms, ROOMS)
                self.assertEqual(h.audit_path, os.path.join(tempfile.gettempdir(), "logs", "consult-hold-audit.jsonl"))

    def test_the_default_sources_use_the_configured_credential_file(self):
        h = ch.build(self.flags({}), ROOMS, Sink(), tempfile.gettempdir(), Clock(T))
        for r in ROOMS: h.note_health(r, QUIET, T)
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})                                   # the nonexistent credential file is a read error: true, nothing raised

    def test_run_subscriber_hands_the_flags_to_build(self):
        src = open(os.path.join(HERE, "..", "subscriber", "run_subscriber.py")).read()
        self.assertIn("consult_hold.build(flags, rooms, sink, HOME, time.time)", src)
        for name in ("post_open_overrides_url_close", "capture_closed_counts_quiet", "open_session_requires_levels", "consult_windows_enabled"):
            self.assertNotIn(name, src)                                                              # no per-switch wiring left in main() that a mutation could break unseen


class ConfigFlags(unittest.TestCase):
    def cfg(self, extra):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "router.json")
        d = {"to": ["a"], "ackers": ["a"]}; d.update(extra); json.dump(d, open(p, "w")); return ubus_bus.load_cfg(p)

    def test_flags_default_off_and_only_a_literal_true_turns_them_on(self):
        c = self.cfg({}); self.assertEqual((c["consult_open_publish"], c["start_day_after_boot"], c["consult_room_map"], c["start_day_cmd"]), (False, False, {}, []))
        for v in ("true", 1, "yes", None, [True]):
            c = self.cfg({"consult_open_publish": v, "start_day_after_boot": v}); self.assertEqual((c["consult_open_publish"], c["start_day_after_boot"]), (False, False))
        c = self.cfg({"consult_open_publish": True, "start_day_after_boot": True}); self.assertEqual((c["consult_open_publish"], c["start_day_after_boot"]), (True, True))

    def test_the_live_router_config_has_neither_flag(self):
        p = os.path.expanduser("~/oc/fleet-access/guardian/etc/router.json")
        if not os.path.exists(p):
            self.skipTest("no live config on this machine")
        c = ubus_bus.load_cfg(p); self.assertEqual((c["consult_open_publish"], c["start_day_after_boot"]), (False, False))


if __name__ == "__main__":
    unittest.main()
