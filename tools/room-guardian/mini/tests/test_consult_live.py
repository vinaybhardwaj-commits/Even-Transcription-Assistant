"""S3 Mini side (plan gap G1): the affirmative `consult_live` map in the control line, behind the flags consult_live_publish (default false) and
consult_open_publish. Absent means unknown: a stale, unknown, unmapped or DB-errored room is ABSENT from the map, never true. consult_open keeps its
existing fail-closed hold unchanged. consult_live_publish off = today's exact bytes (golden strings); on = form 3, sort_keys order
(consult_live, consult_open, kill, modes, ts). KIOSK_RE_V3 is the Mini side's shape test; the kiosk parser ships in its own slice, first (release order)."""
import json, os, re, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
import consult_hold as ch
import ubus_bus
from test_subscriber import Clock
from test_dprime import Src, Sink, MAP, ROOMS, T, KIOSK_RE_OLD, KIOSK_RE_V2, mk

KIOSK_RE_V3 = (r'^\{"consult_live": \{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}, '
               r'"consult_open": \{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}, '
               r'"kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$')

def presence(hb=(("M6", T - 5), ("M7", T - 5)), post=(), enc=()):
    """A full presence source value (all three PRESENCE_KEYS): post rows are (machine, event, ts_epoch), the query's one-newest-POST-row-per-machine shape."""
    return {"hb": list(hb), "enc": list(enc), "post": list(post)}


def open_at(ts, m="M6"):
    return [(m, "encounter_open", ts)]


def close_at(ts, m="M6"):
    return [(m, "encounter_close", ts)]


class LiveSemantics(unittest.TestCase):
    """The fable ruling for consult_live: true only on a fresh heartbeat AND a newest POST-driven open within OPEN_UNCLOSED_MAX_S; false on a close; anything
    else absent. consult_open is asserted alongside in every case to pin that it is UNCHANGED."""

    def live(self, src, **kw):
        h, _, _ = mk(src, **kw)
        return h.live(), h.hold()

    def test_a_fresh_post_open_is_true_and_a_room_without_a_post_event_is_absent(self):
        out, hold = self.live(Src(presence=presence(post=open_at(T - 30))))
        self.assertEqual(out, {"opd-6": True})                                   # opd-7: fresh heartbeat, no POST event -> ABSENT, never true
        self.assertEqual(hold, {"opd-6": True, "opd-7": False})                   # consult_open: the open holds opd-6, opd-7 stays clear

    def test_a_fresh_close_is_false(self):
        out, hold = self.live(Src(presence=presence(post=close_at(T - 10) + close_at(T - 30, "M7"))))
        self.assertEqual(out, {"opd-6": False, "opd-7": False})
        self.assertEqual(hold, {"opd-6": False, "opd-7": False})                  # closes never hold the room either

    def test_a_stale_heartbeat_is_absent_not_false(self):
        """THE MUTANT (a stale room reporting false instead of absent) must fail this test."""
        out, _ = self.live(Src(presence=presence(hb=(("M6", T - 121), ("M7", T - 5)), post=open_at(T - 30) + close_at(T - 30, "M7"))))
        self.assertEqual(out, {"opd-7": False})                                  # opd-6 (hb 121 s old > 120 s) is ABSENT, not false

    def test_the_two_minute_heartbeat_boundary_is_inclusive_as_in_the_hold(self):
        out, _ = self.live(Src(presence=presence(hb=(("M6", T - 120), ("M7", T - 5)), post=open_at(T - 30))))
        self.assertEqual(out, {"opd-6": True})                                   # exactly 120 s old: still fresh

    def test_an_open_older_than_OPEN_UNCLOSED_MAX_S_is_absent_and_the_edge_is_inclusive(self):
        out, _ = self.live(Src(presence=presence(post=open_at(T - ch.OPEN_UNCLOSED_MAX_S - 1) + close_at(T - 30, "M7"))))
        self.assertEqual(out, {"opd-7": False})                                  # outside the window: ABSENT
        out, _ = self.live(Src(presence=presence(post=open_at(T - ch.OPEN_UNCLOSED_MAX_S))))
        self.assertEqual(out, {"opd-6": True})                                   # exactly at the window edge: within

    def test_a_future_open_is_never_affirmed(self):
        out, _ = self.live(Src(presence=presence(post=open_at(T + 100))))
        self.assertEqual(out, {})                                                # unknown clock state: absent, never true

    def test_a_db_error_takes_the_whole_map_and_leaves_consult_open_fail_closed(self):
        out, hold = self.live(Src(presence=RuntimeError("neon down")))
        self.assertEqual(out, {})                                                # the WHOLE map absent
        self.assertEqual(hold, {"opd-6": True, "opd-7": True})                   # consult_open unchanged: fail closed, every room held

    def test_a_db_error_in_any_other_source_takes_the_whole_map_too(self):
        out, hold = self.live(Src(presence=presence(post=open_at(T - 30)), session=RuntimeError("session down")))
        self.assertEqual(out, {})                                                # presence alone would have said opd-6 true
        self.assertEqual(hold, {"opd-6": True, "opd-7": True})                   # session_down holds everything, as before

    def test_a_per_room_read_error_takes_the_whole_map_too(self):
        src = Src(presence=presence(post=open_at(T - 30)))
        src.v["presence"]["post"].append(("M6",))                                # a malformed row: dropped by _clean, marked as the item's error
        out, _ = self.live(src)
        self.assertEqual(out, {})                                                # any DB error, whole map absent

    def test_an_unmapped_room_is_absent(self):
        h, _, _ = mk(Src(presence=presence(post=open_at(T - 30) + open_at(T - 30, "M7"))), rmap={"opd-6": MAP["opd-6"]})
        self.assertEqual(h.live(), {"opd-6": True})                              # opd-7 is not in consult_room_map at all

    def test_a_multi_machine_room_follows_its_newest_post_event_and_needs_every_heartbeat(self):
        rmap = {"opd-7": {"machine": ["M7", "M7b"], "room_id": "b7", "slug": "s7"}}
        both = (("M7", T - 5), ("M7b", T - 5))
        h, _, _ = mk(Src(presence=presence(hb=both, post=[("M7", "encounter_close", T - 100), ("M7b", "encounter_open", T - 50)])), rooms=["opd-7"], rmap=rmap)
        self.assertEqual(h.live(), {"opd-7": True})                              # the newest POST row across the machines decides
        h, _, _ = mk(Src(presence=presence(hb=both, post=[("M7", "encounter_open", T - 50), ("M7b", "encounter_close", T - 100)])), rooms=["opd-7"], rmap=rmap)
        self.assertEqual(h.live(), {"opd-7": True})                              # an open newer than the close: still within its window
        h, _, _ = mk(Src(presence=presence(hb=both, post=close_at(T - 50, "M7") + close_at(T - 100, "M7b"))), rooms=["opd-7"], rmap=rmap)
        self.assertEqual(h.live(), {"opd-7": False})
        h, _, _ = mk(Src(presence=presence(hb=(("M7", T - 5), ("M7b", T - 121)), post=open_at(T - 30, "M7"))), rooms=["opd-7"], rmap=rmap)
        self.assertEqual(h.live(), {})                                           # one machine's heartbeat stale: the room is absent


class ControlLineFlags(unittest.TestCase):
    FORM1 = '{"kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'
    FORM2 = '{"consult_open": {"opd-6": false, "opd-7": false}, "kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'
    FORM3 = '{"consult_live": {"opd-6": true}, "consult_open": {"opd-6": true, "opd-7": false}, "kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'
    FORM3_EMPTY = '{"consult_live": {}, "consult_open": {"opd-6": true, "opd-7": true}, "kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'

    def sub(self, hold=None, consult_live=False):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        open(os.path.join(t.name, "kill-switch"), "w").write("off\n")
        return sb.Subscriber(os.path.join(t.name, "d"), t.name, list(ROOMS), Sink(), Clock(T), consult=hold, consult_live=consult_live)

    def test_flag_off_is_the_base_bytes(self):
        self.assertEqual(self.sub().control_message(), self.FORM1)               # no hold at all (both flags off): today's line, byte for byte
        hold, _, _ = mk()                                                        # hold on, consult_live_publish off (default)
        msg = self.sub(hold).control_message()
        self.assertEqual(msg, self.FORM2)                                        # byte-identical to the base form-2 line
        self.assertNotIn("consult_live", msg)
        self.assertEqual(self.sub(None, consult_live=True).control_message(), self.FORM1)   # live flag alone (hold never built): today's line

    def test_flag_on_publishes_form_3_in_sort_keys_order(self):
        hold, _, _ = mk(Src(presence=presence(post=open_at(T - 30))))
        msg = self.sub(hold, consult_live=True).control_message()
        self.assertEqual(msg, self.FORM3)
        self.assertTrue(re.fullmatch(KIOSK_RE_V3, msg))
        self.assertFalse(re.fullmatch(KIOSK_RE_V2, msg))
        self.assertFalse(re.fullmatch(KIOSK_RE_OLD, msg))
        self.assertEqual(list(json.loads(msg)), ["consult_live", "consult_open", "kill", "modes", "ts"])

    def test_flag_on_with_a_db_error_publishes_an_empty_map_and_consult_open_all_true(self):
        hold, _, _ = mk(Src(presence=RuntimeError("neon down")))
        msg = self.sub(hold, consult_live=True).control_message()
        self.assertEqual(msg, self.FORM3_EMPTY)                                  # the whole map absent, the key itself stays (fixed form-3 shape)
        o = json.loads(msg)
        self.assertEqual(o["consult_live"], {}); self.assertEqual(o["consult_open"], {"opd-6": True, "opd-7": True})

    def test_false_values_reach_the_line_next_to_false_hold_values(self):
        hold, _, _ = mk(Src(presence=presence(post=close_at(T - 30) + close_at(T - 30, "M7"))))
        o = json.loads(self.sub(hold, consult_live=True).control_message())
        self.assertEqual(o["consult_live"], {"opd-6": False, "opd-7": False})
        self.assertEqual(o["consult_open"], {"opd-6": False, "opd-7": False})

    def test_canonical_control_refuses_consult_live_without_consult_open(self):
        with self.assertRaises(ValueError):
            sb.canonical_control({"consult_live": {"r1": True}, "kill": False, "modes": {"r1": "shadow"}, "ts": 1760000000})
        ok = {"consult_live": {"r1": True}, "consult_open": {"r1": True}, "kill": False, "modes": {"r1": "shadow"}, "ts": 1760000000}
        self.assertEqual(sb.canonical_control(ok), json.dumps(ok, sort_keys=True))


class LiveSnapshot(unittest.TestCase):
    """Background mode: live() READS the refresher's snapshot (never computes on the publish thread) and an old or missing snapshot is an empty map."""

    def test_a_background_snapshot_is_read_not_computed_and_goes_empty_past_90_s(self):
        h, clock, _ = mk(Src(presence=presence(post=open_at(T - 30))), background=True)
        h._stop.set()                                                            # no refresher thread: the test owns the snapshot
        self.assertEqual(h.live(clock()), {})                                    # none yet: absent, not false
        h._snap_live = ({"opd-6": True}, clock())
        self.assertEqual(h.live(clock()), {"opd-6": True})                       # read, not computed
        self.assertEqual(h.live(clock() + h.snap_max_age), {"opd-6": True})      # exactly at the 90 s limit: still usable
        self.assertEqual(h.live(clock() + h.snap_max_age + 1), {})               # older: the whole map absent
        h._snap_live = ("garbage", clock()); self.assertEqual(h.live(clock()), {})
        h._snap_live = ({"opd-6": True}, float("nan")); self.assertEqual(h.live(clock()), {})

    def test_a_live_fault_never_raises_by_itself_or_through_the_hold(self):
        h, _, _ = mk(Src(presence=presence(post=open_at(T - 30))))
        h._room_live = lambda r, now: 1 / 0
        self.assertEqual(h.live(), {})                                           # a per-room fault: absent, never false
        h2, _, _ = mk(Src(presence=presence(post=open_at(T - 30))))
        h2.compute = lambda now=None: (_ for _ in ()).throw(RuntimeError("refresh broke"))
        self.assertEqual(h2.live(), {})                                          # a fault out of compute: empty map, no raise


class RoomBudgetAndWiring(unittest.TestCase):
    def test_validate_rooms_counts_the_consult_live_map_too(self):
        short = [f"r{i}" for i in range(64)]
        self.assertIsNone(sb.validate_rooms(short))
        self.assertIsNone(sb.validate_rooms(short, consult_live=True))           # both maps still fit with 2-3 char slugs
        long = [("r%02d" % i).ljust(18, "x") for i in range(64)]
        self.assertIsNone(sb.validate_rooms(long, consult_open=True))            # form 2 fits at 18 (measured, test_dprime)
        err = sb.validate_rooms(long, consult_live=True)
        self.assertIsNotNone(err); self.assertIn("4000", err)                    # form 3 counts BOTH maps: refused at 18

    def test_load_cfg_consult_live_publish_defaults_off_and_only_a_literal_true_turns_it_on(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "router.json")

        def cfg(extra):
            d = {"to": ["a"], "ackers": ["a"]}; d.update(extra); json.dump(d, open(p, "w")); return ubus_bus.load_cfg(p)
        self.assertIs(cfg({})["consult_live_publish"], False)
        for v in ("true", 1, "yes", None, [True], False):
            self.assertIs(cfg({"consult_live_publish": v})["consult_live_publish"], False, v)
        self.assertIs(cfg({"consult_live_publish": True})["consult_live_publish"], True)


class BuildSubscriberWiring(unittest.TestCase):
    """run_subscriber passes the flag end to end: check_rooms counts form 3, build_subscriber hands consult_live to the Subscriber, and the published line is form 3."""
    _HOME = tempfile.mkdtemp(prefix="ctl-home-")
    os.makedirs(os.path.join(_HOME, "logs"), exist_ok=True)
    _old = os.environ.get("GUARDIAN_HOME"); os.environ["GUARDIAN_HOME"] = _HOME
    import run_subscriber as rs
    if _old is None:
        os.environ.pop("GUARDIAN_HOME", None)
    else:
        os.environ["GUARDIAN_HOME"] = _old

    def sink(self):
        from test_router import ar, FakeBus
        return sb.RouterSink(ar.Router(ar.SqliteStore(), lambda: FakeBus(), Clock(T)))

    def build(self, flags, src):
        home = tempfile.mkdtemp(); os.makedirs(os.path.join(home, "etc"))
        open(os.path.join(home, "etc", "kill-switch"), "w").write("off\n")
        s = self.rs.build_subscriber({}, ROOMS, flags, self.sink(), home, Clock(T), consult_sources=src)
        if s.consult is not None:
            s.consult.stop()
            if s.consult._thread is not None:
                s.consult._thread.join(2)                                        # the refresher owns the snapshots until here; the test owns them after
        for r in ROOMS:
            s.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": True, "zero_ratio": 1.0, "ts": T}))
        if s.consult is not None:
            now = s.consult.clock()
            s.consult._snap = (s.consult.compute(now), now)                      # exactly what the refresher would have written, without racing it
            s.consult._snap_live = (dict(s.consult._live), now)
        return s

    def test_both_flags_reach_the_control_line_and_the_line_is_form_3(self):
        flags = {"consult_open_publish": True, "consult_live_publish": True, "consult_room_map": MAP}
        s = self.build(flags, Src())
        self.assertTrue(s.consult_live); self.assertIsNotNone(s.consult)
        msg = s.control_message()
        self.assertTrue(msg.startswith('{"consult_live": '))
        self.assertTrue(re.fullmatch(KIOSK_RE_V3, msg))
        self.assertEqual(list(json.loads(msg)), ["consult_live", "consult_open", "kill", "modes", "ts"])
        o = json.loads(msg)
        self.assertEqual(o["consult_live"], {})                                  # no POST events in the stub: every room absent
        self.assertEqual(o["consult_open"], {"opd-6": False, "opd-7": False})     # health fed, everything clear

    def test_the_live_flag_alone_publishes_the_base_line(self):
        s = self.build({"consult_live_publish": True}, Src())
        self.assertIsNone(s.consult)
        self.assertEqual(s.control_message(), ControlLineFlags.FORM1)            # without consult_open_publish nothing is built: today's bytes

    def test_check_rooms_counts_the_hold_map_and_the_live_map_separately(self):
        long = [("r%02d" % i).ljust(18, "x") for i in range(64)]
        self.assertIsNone(self.rs.check_rooms(long, {"consult_open_publish": True}))
        self.assertIn("4000", self.rs.check_rooms(long, {"consult_open_publish": True, "consult_live_publish": True}))
        self.assertIsNone(self.rs.check_rooms(long, {"consult_live_publish": True}))   # live alone: today's payload
        self.assertIsNone(self.rs.check_rooms(long, {"consult_open_publish": "true", "consult_live_publish": True}))


if __name__ == "__main__":
    unittest.main()
