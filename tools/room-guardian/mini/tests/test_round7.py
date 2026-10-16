"""FR1 2.4 d' Round 7 (final refute 3504ebf0, 2 MUST): the per-item merge keeps `post`; the hold is computed on a background refresher and the publish thread only reads a
snapshot; a server `recovered` row keeps usb_device_missing open; the start_day send runs in a worker; run_subscriber's wiring is under test."""
import importlib, json, os, re, sys, tempfile, threading, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
import consult_hold as ch
import start_day as sd
from test_router import ar, FakeBus
from test_subscriber import CAEnv, Clock, T0
from test_dprime import Src, Sink, MAP, ROOMS, QUIET, T, KIOSK_RE_V2, mk, health

_HOME = tempfile.mkdtemp(prefix="rs-home-"); os.makedirs(os.path.join(_HOME, "logs"), exist_ok=True)
_old_home = os.environ.get("GUARDIAN_HOME"); os.environ["GUARDIAN_HOME"] = _HOME
rs = importlib.import_module("run_subscriber")                      # its HOME (and the log file) are under a temp dir, never the live tree
if _old_home is None: os.environ.pop("GUARDIAN_HOME", None)
else: os.environ["GUARDIAN_HOME"] = _old_home


def machines(n): return {f"room-{i}": {"machine": f"M{i}", "room_id": f"b{i}", "slug": f"s{i}"} for i in range(n)}


class MergeKeepsPost(unittest.TestCase):                                                       # M1
    def two(self):
        return {"opd-6": MAP["opd-6"], "opd-7": MAP["opd-7"]}

    class Flaky(Src):
        """A batched Presence read raises (a transient Neon error); the per-item reads succeed and carry the R3-F1 rows."""
        def __getitem__(self, name):
            inner = Src.__getitem__(self, name)
            def f(now, arg):
                if name == "presence" and len(arg) > 1: raise RuntimeError("too many connections")
                if name == "presence":
                    v = self.v["presence"]
                    return {k: [x for x in v[k] if x[0] in arg] for k in ("hb", "enc", "post")}
                return inner(now, arg)
            return f

    def test_the_merge_carries_every_key_including_post(self):
        parts = [{"hb": [("M6", 1)], "enc": [("M6", "encounter_close", 2)], "post": [("M6", "encounter_open", 3)]}, {"hb": [("M7", 1)], "enc": [], "post": [("M7", "encounter_open", 4)]}]
        m = ch.ConsultHold._merge("presence", parts)
        self.assertEqual(sorted(m), sorted(ch.PRESENCE_KEYS)); self.assertEqual(m["post"], [("M6", "encounter_open", 3), ("M7", "encounter_open", 4)])
        self.assertEqual(m["hb"], [("M6", 1), ("M7", 1)])

    def test_a_batched_fault_then_good_single_reads_still_reads_the_post_override(self):
        pres = {"hb": [("M6", T - 5), ("M7", T - 5)], "enc": [("M6", "encounter_close", T - 480)], "post": [("M6", "encounter_open", T - 900)]}
        h, _, src = mk(self.Flaky(presence=pres)); out = h.hold()
        self.assertEqual(out, {"opd-6": True, "opd-7": False}); self.assertIn("presence_consulting", h.last["opd-6"][1])      # the refuter's repro: was False
        h, _, _ = mk(self.Flaky(presence=pres), post_open_overrides_url_close=False); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})   # switch off: today's rule
        h, _, _ = mk(Src(presence=pres)); self.assertEqual(h.hold(), {"opd-6": True, "opd-7": False})                            # the batched path gives the same answer

    def test_a_reply_missing_a_batched_key_is_a_source_error(self):
        src = Src(presence={"hb": [("M6", T - 5), ("M7", T - 5)], "enc": []}); src.strict = True
        self.assertEqual(mk(src)[0].hold(), {"opd-6": True, "opd-7": True})                     # the batched reply has no `post`: down, true
        class OneShort(Src):
            def __getitem__(self, name):
                inner = Src.__getitem__(self, name)
                def f(now, arg):
                    if name == "presence" and len(arg) > 1: raise RuntimeError("x")
                    if name == "presence" and "M7" in arg: return {"hb": [(a, T - 5) for a in arg], "enc": []}     # M7's single read comes back without `post`
                    if name == "presence": return {"hb": [(a, T - 5) for a in arg], "enc": [], "post": []}
                    return inner(now, arg)
                return f
        s2 = OneShort(); s2.strict = True; h, _, _ = mk(s2); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": True})        # that item only: a source error for opd-7, nothing for opd-6


class BackgroundRefresher(unittest.TestCase):                                                  # M2
    def bg(self, src, rooms=ROOMS, rmap=MAP, **kw):
        h, clock, _ = mk(src, rooms=rooms, rmap=rmap, background=True, **kw); self.addCleanup(h.stop); return h, clock

    def test_hold_never_runs_a_source_on_the_calling_thread_and_never_blocks(self):
        gate = threading.Event(); self.addCleanup(gate.set); who = []
        class Slow(Src):
            def __getitem__(self, name):
                def f(now, arg): who.append(threading.current_thread().name); gate.wait(5); return Src.__getitem__(self, name)(now, arg)
                return f
        h, clock = self.bg(Slow(), cache_s=0.05, timeout_s=5)
        t0 = time.monotonic(); out = h.hold(); dt = time.monotonic() - t0
        self.assertEqual(out, {"opd-6": True, "opd-7": True}); self.assertLess(dt, 0.2)       # no snapshot yet: true at once, not after a refresh
        time.sleep(0.1)
        self.assertTrue(who); self.assertTrue(all(n == "consult-hold-refresher" or n.startswith("Thread") for n in who))
        self.assertNotIn(threading.current_thread().name, who)

    def test_snapshot_age_and_death(self):
        h, clock = self.bg(Src()); h._stop.set()                                              # manual rounds: no thread, so the test controls the snapshot
        self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True})                     # none yet
        h._snap = (h.compute(clock()), clock()); self.assertEqual(h.hold(clock()), {"opd-6": False, "opd-7": False})
        self.assertEqual(h.hold(clock() + 90), {"opd-6": False, "opd-7": False})              # exactly 90 s old: still usable (DPM-6: was 60 s, I2: was 120 s)
        self.assertEqual(h.hold(clock() + 91), {"opd-6": True, "opd-7": True})                # older than 90 s: every room held
        h._snap = ({"opd-6": False, "opd-7": False}, float("nan")); self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True})
        h._snap = ("garbage", clock()); self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True})                # a bad snapshot never raises

    def test_a_refresher_that_raises_publishes_true_and_keeps_running(self):
        h, clock = self.bg(Src(), cache_s=0.02)
        calls = []; orig = h.compute
        def boom(now):
            calls.append(1)
            if len(calls) == 1: raise SystemExit("refresher fault")
            return orig(now)
        h.compute = boom
        h.start(); time.sleep(0.3)
        self.assertGreaterEqual(len(calls), 2)                                                # it survived the first fault and ran again
        time.sleep(0.1); self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})           # health was fed in mk and the later round is good

    def test_a_dead_refresher_is_restarted_by_the_next_read(self):
        h, clock = self.bg(Src(), cache_s=0.02); h.hold(); time.sleep(0.1); first = h._thread
        self.assertTrue(first.is_alive()); h._stop.set(); first.join(2); self.assertFalse(first.is_alive())
        h._stop.clear(); h.hold(); self.assertIsNot(h._thread, first); self.assertTrue(h._thread.is_alive())

    def test_one_whole_refresh_is_bounded_by_the_budget(self):
        class Slow(Src):
            def __getitem__(self, name):
                def f(now, arg): time.sleep(0.3); return Src.__getitem__(self, name)(now, arg)
                return f
        h, clock, _ = mk(Slow(), refresh_budget_s=0.5, timeout_s=5)
        t0 = time.monotonic(); out = h.compute(clock()); dt = time.monotonic() - t0
        self.assertLess(dt, 1.0)                                                               # presence (0.3) + session (0.3 > the remaining 0.2): the rest is cut, not waited for
        self.assertTrue(all(out.values()))                                                     # a source that was cut is down, so true

    def test_the_cache_age_counts_from_the_refresh_end(self):
        clock = Clock(T)
        class Slow(Src):
            def __getitem__(self, name):
                inner = Src.__getitem__(self, name)
                def f(now, arg): clock.adv(10); return inner(now, arg)                         # each read takes 10 s of fake time
                return f
        h, _, src = mk(Slow(), clock=clock, rmap=MAP)
        h.compute(clock()); n = sum(src.calls.values()); self.assertGreaterEqual(clock() - T, 30)
        self.assertEqual(h.tried_at, clock())                                                  # the refresh END
        h.compute(clock() + 29); self.assertEqual(sum(src.calls.values()), n)                  # 29 s after the END: cached
        h.compute(clock() + 31); self.assertGreater(sum(src.calls.values()), n)

    def test_9_and_64_rooms_slow_stubs_every_publish_is_prompt_and_every_room_publishes(self):
        for nrooms, cadence in ((9, 0.02), (64, 0.02)):
            with self.subTest(rooms=nrooms):
                rmap = machines(nrooms); rooms = sorted(rmap)
                class Slow(Src):
                    """A batched read errors after 0.15 s; each single read takes 0.04 s (scaled down from 1.5 s and 2.5 s)."""
                    def __getitem__(self, name):
                        inner = Src.__getitem__(self, name)
                        def f(now, arg):
                            if name in ("presence", "session", "levels") and arg is not None and len(arg) > 1: time.sleep(0.15); raise RuntimeError("batched read failed")
                            time.sleep(0.04); return inner(now, arg)
                        return f
                src = Slow(presence=[(m["machine"], T - 5, None) for m in rmap.values()]); src.v["presence"] = [(m["machine"], time.time() - 5, None) for m in rmap.values()]
                h = ch.ConsultHold(rooms, rmap, src, time.time, background=True, cache_s=0.05, refresh_budget_s=20); self.addCleanup(h.stop)
                tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup); open(os.path.join(tmp.name, "kill-switch"), "w").write("off\n")
                sub = sb.Subscriber(os.path.join(tmp.name, "d"), tmp.name, rooms, Sink(), time.time, consult=h)
                stamps = {r: [] for r in rooms}; worst_pub = worst_line = 0.0
                end = time.monotonic() + 1.5
                while time.monotonic() < end:
                    for r in rooms:
                        t0 = time.monotonic(); msg = sub.control_message(); worst_pub = max(worst_pub, time.monotonic() - t0); stamps[r].append(time.monotonic())
                        self.assertTrue(re.fullmatch(KIOSK_RE_V2, msg) if nrooms <= 9 else msg.startswith("{"))
                    t0 = time.monotonic(); sub.on_line(f"kiosk/{rooms[0]}/health", json.dumps({"zero_ratio": 1.0, "capture_open": False})); worst_line = max(worst_line, time.monotonic() - t0)
                    time.sleep(cadence)
                self.assertLess(worst_pub, 0.1); self.assertLess(worst_line, 0.1)               # no publish and no health line waited on the refresh
                self.assertTrue(all(len(v) >= 5 for v in stamps.values()))                       # every room got lines all along (gaps = the loop, not the hold)
                for v in stamps.values():
                    self.assertLess(max(b - a for a, b in zip(v, v[1:])), 0.5)

    def test_the_real_cadence_with_a_fake_clock_never_withholds_a_room(self):
        # 30 s publish period over 10 min, 9 rooms; the hold is computed by manual rounds that each take 40 s of fake time (a slow refresh). Publishing never waits.
        clock = Clock(T); rmap = machines(9); rooms = sorted(rmap)
        class Slow(Src):
            def __getitem__(self, name):
                inner = Src.__getitem__(self, name)
                def f(now, arg): clock.adv(5); return inner(now, arg)
                return f
        src = Slow(presence=[(m["machine"], T - 5, None) for m in rmap.values()])
        h = ch.ConsultHold(rooms, rmap, src, clock, background=True); h._stop.set()
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup); open(os.path.join(tmp.name, "kill-switch"), "w").write("off\n")
        sub = sb.Subscriber(os.path.join(tmp.name, "d"), tmp.name, rooms, Sink(), clock, consult=h)
        lines = {r: [] for r in rooms}; calls_before = None
        for tick in range(20):                                                                 # 20 ticks of 30 s
            for r in rooms:
                calls_before = dict(src.calls); sub.control_message(); self.assertEqual(src.calls, calls_before)     # publishing reads no source
                lines[r].append(clock())
            clock.adv(30)
            if tick % 2 == 0:                                                                  # the refresher finishes a slow round every other tick
                end = h.compute(clock()); h._snap = (end, clock())
                for r in rooms: sub.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": False, "ts": clock()}))
        for r in rooms:
            self.assertEqual(len(lines[r]), 20); self.assertLessEqual(max(b - a for a, b in zip(lines[r], lines[r][1:])), 60)    # a line at least every 60 s


class ServerRecoveredKeepsUsbDeviceMissing(unittest.TestCase):                                 # S1
    def test_a_recovered_row_does_not_close_it_a_health_line_does(self):
        e = CAEnv(T0); e.heal({"room_id": "r1", "layer": "usb", "action": "escalate", "reason": "usb_device_missing", "result": "escalated"})
        e.router.on_row(None, {"id": 901, "kind": "recovered", "room_ids": ["r1"]})
        self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["usb_device_missing"])
        self.assertIn("usb_device_missing", ar.RECOVERY_KEEP_KINDS); self.assertTrue(ar.ACK_ONLY_KINDS < ar.RECOVERY_KEEP_KINDS)
        e.router.on_row(None, {"id": 902, "kind": "recorder_off", "room_ids": ["r1"]}); e.router.on_row(None, {"id": 903, "kind": "recovered", "room_ids": ["r1"]})
        self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["usb_device_missing"])      # ordinary cases still close
        e.health({"usb_mic_present": True}); self.assertEqual(e.router.store.list_open(), [])


class StartDayWorker(unittest.TestCase):                                                       # S2
    def test_the_send_runs_off_the_loop_thread_and_the_loop_never_waits(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); path = os.path.join(t.name, "s.json"); seen, who = [], []
        def slow(room):
            who.append(threading.current_thread().name); seen.append(json.load(open(path))); time.sleep(0.4)       # state is on disk BEFORE the send
        s = sd.StartDayAfterBoot(slow, path, Sink(), Clock(T), background=True)
        t0 = time.monotonic(); s.on_health("r1", health(100)); dt = time.monotonic() - t0
        self.assertLess(dt, 0.15)                                                              # the loop did not wait for the 0.4 s send
        for _ in range(100):
            if seen: break
            time.sleep(0.02)
        self.assertEqual(len(seen), 1); self.assertIn("r1", seen[0]); self.assertEqual(who, ["start-day-sender"])
        time.sleep(0.6); self.assertTrue(json.load(open(path))["r1"]["send_ok"])               # recorded after the send
        s.on_health("r1", health(110)); time.sleep(0.1); self.assertEqual(len(seen), 1)         # once per boot

    def test_a_failing_sender_does_not_kill_the_worker(self):
        done = []
        def sender(room):
            done.append(room)
            if room == "r1": raise RuntimeError("no path")
        s = sd.StartDayAfterBoot(sender, None, Sink(), Clock(T), background=True)
        s.on_health("r1", health(100)); s.on_health("r2", health(100))
        for _ in range(100):
            if len(done) == 2: break
            time.sleep(0.02)
        self.assertEqual(sorted(done), ["r1", "r2"])
        for _ in range(50):
            if s.state["r1"]["send_ok"] is False and s.state["r2"]["send_ok"] is True: break
            time.sleep(0.02)
        self.assertEqual((s.state["r1"]["send_ok"], s.state["r2"]["send_ok"]), (False, True))

    def test_a_slow_send_does_not_block_health_handling(self):
        gate = threading.Event(); self.addCleanup(gate.set)
        s = sd.StartDayAfterBoot(lambda r: gate.wait(5), None, Sink(), Clock(T), background=True)
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        sub = sb.Subscriber(os.path.join(tmp.name, "d"), tmp.name, ["r1"], Sink(), Clock(T), start_day=s)
        t0 = time.monotonic(); sub.on_line("kiosk/r1/health", json.dumps(health(100, zero_ratio=0.0))); sub.on_line("kiosk/r1/health", json.dumps(health(105, zero_ratio=0.0)))
        self.assertLess(time.monotonic() - t0, 0.2); self.assertEqual(sub.ok_streak.get("r1"), 2)
        sub.check_start_day()                                                                  # the failure check is not blocked either

    def test_build_makes_a_background_sender_only_when_asked(self):
        self.assertTrue(sd.build({"start_day_cmd": ["/bin/x"]}, Sink(), tempfile.gettempdir(), background=True).background)
        self.assertFalse(sd.build({"start_day_cmd": ["/bin/x"]}, Sink(), tempfile.gettempdir()).background)


class RunSubscriberWiring(unittest.TestCase):                                                  # S3 (mutants 54-57)
    def sink(self):
        router = ar.Router(ar.SqliteStore(), lambda: FakeBus(), Clock(T)); return sb.RouterSink(router)

    def test_check_rooms_passes_the_consult_flag_to_validate_rooms(self):
        rooms = [("r%02d" % i).ljust(19, "x") for i in range(64)]                              # fits without the hold, not with it
        self.assertIsNone(rs.check_rooms(rooms, {})); self.assertIsNone(rs.check_rooms(rooms, {"consult_open_publish": False}))
        self.assertIn("4000 bytes", rs.check_rooms(rooms, {"consult_open_publish": True}))
        self.assertIsNone(rs.check_rooms(rooms, {"consult_open_publish": "true"}))              # only a literal true counts
        self.assertIsNotNone(rs.check_rooms("not-a-list", {}))

    def test_housekeeping_runs_every_check_and_one_fault_does_not_skip_the_others(self):
        class S:
            def __init__(self, bad=()): self.called, self.bad = [], bad
            def _c(self, n):
                self.called.append(n)
                if n in self.bad: raise RuntimeError(n)
            def check_quiet(self): self._c("check_quiet")
            def check_start_day(self): self._c("check_start_day")
            def check_usb_verify(self): self._c("check_usb_verify")
            def check_consult_stuck(self): self._c("check_consult_stuck")
        ALL = ["check_quiet", "check_start_day", "check_usb_verify", "check_consult_stuck"]
        s = S(); self.assertEqual(rs.housekeeping(s), []); self.assertEqual(s.called, ALL)
        logs = []; s = S(bad=("check_quiet",)); self.assertEqual(rs.housekeeping(s, logs.append), ["check_quiet"])
        self.assertEqual(s.called, ALL); self.assertEqual(len(logs), 1)
        s = S(bad=("check_start_day", "check_usb_verify")); self.assertEqual(rs.housekeeping(s), ["check_start_day", "check_usb_verify"])
        s = S(bad=ALL[:3]); self.assertEqual(rs.housekeeping(s), ALL[:3]); self.assertEqual(s.called, ALL)

    def test_housekeeping_drives_the_real_subscribers_usb_verify_and_start_day(self):
        e = CAEnv(T0); import usb_verify as uv
        v = uv.UsbVerify(e.sub.sink, None, e.clock); e.sub.usb_verify = v
        e.heal({"room_id": "r1", "layer": "usb", "action": "kiosk_reboot", "reason": "usb_power_off", "result": "healed_pending"})
        e.clock.adv(901); rs.housekeeping(e.sub)
        self.assertIn("usb_reboot_failed", [c["kind"] for c in e.router.store.list_open()])              # the F2 failure opened by the loop's housekeeping
        sd_sink = Sink(); s = sd.StartDayAfterBoot(lambda r: None, None, sd_sink, e.clock); e.sub.start_day = s
        s.on_health("r1", health(100)); e.clock.adv(601); rs.housekeeping(e.sub); self.assertEqual(sd_sink.sd_failed, ["r1"])      # and start_day_failed

    def test_build_subscriber_loads_the_usb_missing_seed_from_the_store(self):
        sink = self.sink(); sink.usb_case("r1", "usb_device_missing", T); sink.usb_case("r9", "usb_device_missing", T)
        s = rs.build_subscriber({}, ["r1", "r2"], {}, sink, tempfile.mkdtemp(), Clock(T))
        self.assertEqual(s.usb_missing, {"r1"})                                                # r9 is not a room of this subscriber
        s.on_line("kiosk/r1/health", json.dumps({"usb_mic_present": True})); self.assertEqual(sink.open_rooms("usb_device_missing"), ["r9"])

    def test_build_subscriber_wires_the_flags_and_the_verify(self):
        home = tempfile.mkdtemp(); s = rs.build_subscriber({"quiet_after_s": 77}, ROOMS, {}, self.sink(), home, Clock(T))
        self.assertIsNone(s.consult); self.assertIsNone(s.start_day); self.assertIsNotNone(s.usb_verify); self.assertEqual(s.quiet_after, 77)
        self.assertEqual(s.usb_verify.state_path, os.path.join(home, "data", "usb-verify-state.json"))
        flags = {"consult_open_publish": True, "consult_room_map": MAP, "consult_db_url_file": "/nonexistent/db.url", "start_day_after_boot": True, "start_day_cmd": ["/bin/x"]}
        s = rs.build_subscriber({}, ROOMS, flags, self.sink(), home, Clock(T)); self.addCleanup(s.consult.stop)
        self.assertTrue(s.consult.background); self.assertTrue(s.start_day.background)          # both run off the loop thread
        self.assertIsNotNone(s.consult._thread)                                                 # the refresher was started
        with self.assertRaises(sd.ConfigError):
            rs.build_subscriber({}, ROOMS, dict(flags, start_day_cmd=[]), self.sink(), home, Clock(T))

    def test_main_uses_these_pieces(self):
        src = open(os.path.join(HERE, "..", "subscriber", "run_subscriber.py")).read()
        main = src[src.index("def main():"):]
        for call in ("check_rooms(rooms, flags)", "build_subscriber(cfg, rooms, flags, sink, HOME, time.time, LOG)", "housekeeping(s, log)", "s.control_message()"):
            self.assertIn(call, main)
        for gone in ("s.check_usb_verify()", "s.check_start_day()", "validate_rooms("):
            self.assertNotIn(gone, main)                                                        # no inline copy left that a mutation could break unseen


if __name__ == "__main__":
    unittest.main()
