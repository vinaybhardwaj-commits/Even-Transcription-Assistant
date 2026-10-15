"""FR1 2.4 d' (Mini side): the consult_open hold in the control line, and start_day after a kiosk reboot. Both behind default-off flags.
KIOSK_RE_V2 is the new-form regex of ~/oc/herdr-lead/CONTROL-CONSULT-OPEN-SHAPE-15OCT.md with its "(...same as today...)" part written out."""
import json, os, re, sys, tempfile, threading, unittest
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


def win(slug, rid, t_open, t_close=None): return (slug, rid, t_open, t_close)


class Loader:
    """Injected source. data = (windows, known) or an exception instance to raise; calls counts invocations."""
    def __init__(self, data): self.data, self.calls = data, 0
    def __call__(self, now):
        self.calls += 1
        if isinstance(self.data, BaseException):
            raise self.data
        return self.data


ROOMS = ["opd-6", "opd-7"]
MAP = {"opd-6": "slug-6", "opd-7": "slug-7"}
KNOWN = [("slug-6", "id6"), ("slug-7", "id7")]


def mk(loader, clock=None, rooms=ROOMS, rmap=MAP, audit=None, sink=None, **kw):
    clock = clock or Clock(T)
    return ch.ConsultHold(rooms, rmap, loader, clock, audit_path=audit, sink=sink, **kw), clock


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
            rmap = {r: f"s-{r}" for r in rooms}
            known = [(f"s-{r}", f"id-{r}") for r in rooms]
            for kill in (True, False):
                hold, _ = mk(Loader(([win(f"s-{rooms[0]}", f"id-{rooms[0]}", T - 60)] if rooms else [], known)), rooms=rooms, rmap=rmap)
                msg = self.sub(rooms, hold, kill).control_message()
                self.assertTrue(re.fullmatch(KIOSK_RE_V2, msg), (n, kill, msg[:90]))
                self.assertFalse(re.fullmatch(KIOSK_RE_OLD, msg))
                o = json.loads(msg); self.assertEqual(sorted(o["consult_open"]), sorted(rooms)); self.assertEqual(o["kill"], kill)
                self.assertTrue(msg.startswith('{"consult_open": '))                  # sort_keys puts it first

    def test_the_contract_example_shape(self):
        hold, _ = mk(Loader(([], [("slug-x", "i")])), rooms=["opd-6-webcam-only-am8n"], rmap={"opd-6-webcam-only-am8n": "slug-x"})
        self.assertEqual(self.sub(["opd-6-webcam-only-am8n"], hold).control_message(),
                         '{"consult_open": {"opd-6-webcam-only-am8n": false}, "kill": false, "modes": {"opd-6-webcam-only-am8n": "shadow"}, "ts": 1760000000}')

    def test_modes_and_kill_keep_their_meaning_with_the_hold_on(self):
        hold, _ = mk(Loader(([], KNOWN)))
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

    def test_a_non_bool_hold_value_is_published_true(self):
        class Odd:
            def hold(self, now): return {"opd-6": None}
        s = self.sub(["opd-6", "opd-7"], Odd())
        self.assertEqual(json.loads(s.control_message())["consult_open"], {"opd-6": True, "opd-7": True})


class HoldSemantics(unittest.TestCase):
    def hold_for(self, windows, now=T, known=KNOWN, **kw):
        h, c = mk(Loader((windows, known)), **kw)
        return h.hold(now)

    def test_open_unclosed_closed_recently_and_old(self):
        self.assertEqual(self.hold_for([win("slug-6", "id6", T - 600)]), {"opd-6": True, "opd-7": False})                 # unclosed, 10 min old
        self.assertEqual(self.hold_for([win("slug-6", "id6", T - 900, T - 60)])["opd-6"], True)                           # closed 60 s ago: still held
        self.assertEqual(self.hold_for([win("slug-6", "id6", T - 900, T - 300)])["opd-6"], False)                         # closed 5 min ago
        self.assertEqual(self.hold_for([win("slug-6", "id6", T - 5 * 3600)])["opd-6"], False)                             # unclosed over 4 h: not open (Rooms Live rule)
        self.assertEqual(self.hold_for([win("slug-6", "id6", T + 500)])["opd-6"], True)                                   # t_open in the future: held
        self.assertEqual(self.hold_for([win("slug-6", "id6", None)])["opd-6"], True)                                      # unreadable row: held

    def test_query_error_and_timeout_hold_every_room(self):
        h, _ = mk(Loader(RuntimeError("connection refused")))
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})
        gate = threading.Event(); self.addCleanup(gate.set)
        h2, _ = mk(lambda now: (gate.wait(5), ([], KNOWN))[1], timeout_s=0.05)
        self.assertEqual(h2.hold(), {"opd-6": True, "opd-7": True})

    def test_a_malformed_reply_holds(self):
        h, _ = mk(Loader(("not", "a", "pair")))
        self.assertEqual(h.hold(), {"opd-6": True, "opd-7": True})

    def test_stale_data_holds_after_120_s_and_a_short_failure_keeps_the_last_good_answer(self):
        loader = Loader(([], KNOWN)); h, clock = mk(loader)
        self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})
        loader.data = RuntimeError("down"); clock.adv(70)
        self.assertEqual(h.hold(clock()), {"opd-6": False, "opd-7": False})       # 70 s old: inside 120 s
        clock.adv(61)                                                             # 131 s since the last good fetch
        self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True})

    def test_no_mapping_no_data_and_ambiguous_mapping_hold_only_the_affected_room(self):
        self.assertEqual(self.hold_for([], rmap={"opd-6": "slug-6"}), {"opd-6": False, "opd-7": True})                    # opd-7 has no mapping
        self.assertEqual(self.hold_for([], rmap={"opd-6": "slug-6", "opd-7": ""}), {"opd-6": False, "opd-7": True})
        self.assertEqual(self.hold_for([], known=[("slug-6", "id6")]), {"opd-6": False, "opd-7": True})                   # slug-7 never seen: no data
        self.assertEqual(self.hold_for([], known=KNOWN + [("slug-6", "id6b")]), {"opd-6": True, "opd-7": False})          # slug-6 is two rooms: ambiguous
        self.assertEqual(self.hold_for([win("slug-7", "i1", T - 9000, T - 8000), win("slug-7", "i2", T - 9000, T - 8000)]),
                         {"opd-6": False, "opd-7": True})                                                                 # two room ids among the windows

    def test_cache_is_60_s(self):
        loader = Loader(([], KNOWN)); h, clock = mk(loader)
        h.hold(); clock.adv(59); h.hold(clock()); self.assertEqual(loader.calls, 1)
        clock.adv(2); h.hold(clock()); self.assertEqual(loader.calls, 2)

    def test_audit_line_per_room_only_on_change(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); path = os.path.join(t.name, "a.jsonl")
        loader = Loader(([], KNOWN)); h, clock = mk(loader, audit=path)
        h.hold(); h.hold()
        lines = [json.loads(x) for x in open(path)]
        self.assertEqual([(l["room"], l["consult_open"], l["why"]) for l in lines], [("opd-6", False, "clear"), ("opd-7", False, "clear")])
        loader.data = ([win("slug-6", "id6", T - 10)], KNOWN); clock.adv(61); h.hold(clock())
        lines = [json.loads(x) for x in open(path)]; self.assertEqual(len(lines), 3)
        self.assertEqual((lines[2]["room"], lines[2]["consult_open"], lines[2]["why"], lines[2]["ts"]), ("opd-6", True, "open_window", int(T + 61)))
        loader.data = RuntimeError("x"); clock.adv(200); h.hold(clock())
        self.assertEqual(sorted((l["room"], l["why"]) for l in [json.loads(x) for x in open(path)][3:]), [("opd-6", "source_down"), ("opd-7", "source_down")])

    def test_audit_write_fault_never_changes_the_hold(self):
        h, _ = mk(Loader(([], KNOWN)), audit="/nonexistent-dir/x.jsonl")
        self.assertEqual(h.hold(), {"opd-6": False, "opd-7": False})


class StuckSource(unittest.TestCase):
    def test_case_opens_after_30_min_of_source_error_once_and_closes_on_recovery(self):
        sink = Sink(); loader = Loader(RuntimeError("down")); h, clock = mk(loader, sink=sink)
        for _ in range(29):
            h.hold(clock()); clock.adv(60)
        self.assertEqual(sink.down, 0)                                            # 29 min
        h.hold(clock()); clock.adv(60); h.hold(clock()); clock.adv(60); h.hold(clock())
        self.assertEqual(sink.down, 1)
        for _ in range(5):
            clock.adv(60); h.hold(clock())
        self.assertEqual(sink.down, 1)                                            # one case, not one per tick
        loader.data = ([], KNOWN); clock.adv(60); h.hold(clock())
        self.assertEqual((sink.down, sink.up), (1, 1))

    def test_a_missing_mapping_alone_is_not_a_source_error(self):
        sink = Sink(); h, clock = mk(Loader(([], KNOWN)), rmap={}, sink=sink)
        for _ in range(40):
            self.assertEqual(h.hold(clock()), {"opd-6": True, "opd-7": True}); clock.adv(60)
        self.assertEqual(sink.down, 0)

    def test_the_case_through_the_real_router_is_normal_priority_not_v_and_closes_on_recovery(self):
        router = ar.Router(ar.SqliteStore(), lambda: FakeBus(), Clock(T))
        sink = sb.RouterSink(router)
        loader = Loader(RuntimeError("down")); h, clock = mk(loader, sink=sink)
        for _ in range(32):
            h.hold(clock()); clock.adv(60)
        c = [x for x in router.store.list_open() if x["kind"] == "consult_hold_source_down"]
        self.assertEqual([(x["room_id"]) for x in c], ["mini"])
        self.assertNotIn("consult_hold_source_down", ar.URGENT); self.assertNotIn("consult_hold_source_down", ar.V_KINDS)
        loader.data = ([], KNOWN); clock.adv(60); h.hold(clock())
        self.assertEqual([x for x in router.store.list_open() if x["kind"] == "consult_hold_source_down"], [])


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
