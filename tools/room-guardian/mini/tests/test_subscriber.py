import json, os, sys, tempfile, unittest
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "subscriber"))
import subscriber as sb
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "router"))

IST = timezone(timedelta(hours=5, minutes=30))
T0 = datetime(2026, 10, 13, 11, 0, tzinfo=IST).timestamp()

class Clock:
    def __init__(self, t): self.t = t
    def __call__(self): return self.t
    def adv(self, s): self.t += s

class Sink:
    def __init__(self): self.quiet, self.rec, self.kinds, self.invalid, self.cap_rec = [], [], [], [], []
    def guardian_quiet(self, room, q, now): self.quiet.append((room, int(q)))
    def guardian_recovered(self, room, now): self.rec.append(room)
    def heal_kind(self, room, kind, now): self.kinds.append((room, kind))
    def heal_action(self, room, line, now): self.actions = getattr(self, "actions", []) + [line]
    def heal_invalid(self, room, now): self.invalid.append(room)
    def capture_recovered(self, room, now): self.cap_rec.append(room)

class SubscriberTests(unittest.TestCase):
    def mk(self, rooms=("r1", "r2")):
        self.t = tempfile.TemporaryDirectory(); self.addCleanup(self.t.cleanup)
        self.clock, self.sink = Clock(T0), Sink()
        return sb.Subscriber(os.path.join(self.t.name, "data"), self.t.name, rooms, self.sink, self.clock)

    def test_topic_parse(self):
        self.assertEqual(sb.parse_topic("kiosk/r1/health"), ("r1", "health"))
        self.assertEqual(sb.parse_topic("kiosk/r1/probe-reply"), ("r1", "probe-reply"))
        for bad in ("kiosk/r1/other", "kiosk//health", "kiosk/../health", "x/r1/health", "kiosk/r1/health/x", "kiosk/r 1/health"):
            self.assertIsNone(sb.parse_topic(bad), bad)

    def test_lines_stored_as_jsonl_per_day_and_bad_json_dropped(self):
        s = self.mk()
        self.assertTrue(s.on_line("kiosk/r1/health", '{"a":1}\n')); self.assertTrue(s.on_line("kiosk/r1/heal", '{"b":2}'))
        self.assertFalse(s.on_line("kiosk/r1/health", "not json")); self.assertFalse(s.on_line("other/r1/health", "{}"))
        d = os.path.join(s.data, "2026-10-13")
        self.assertEqual(open(os.path.join(d, "r1.health.jsonl")).read(), '{"a":1}\n')
        self.assertEqual(sorted(os.listdir(d)), ["r1.heal.jsonl", "r1.health.jsonl"])

    def test_health_line_with_unknown_sense_keys_passes_through_unchanged(self):
        # S2: the kiosk health line gains zr, peak, mic_class; the subscriber stores the line as received and keeps handling it
        s = self.mk()
        line = '{"room_id":"r1","rms_dbfs_2s":-70.1,"guardian":"v","zr":0.800,"peak":0.0009,"mic_class":"tonor"}\n'
        self.assertTrue(s.on_line("kiosk/r1/health", line))
        d = os.path.join(s.data, "2026-10-13")
        self.assertEqual(open(os.path.join(d, "r1.health.jsonl")).read(), line)
        self.assertEqual(s.last_health["r1"][1]["zr"], 0.8); self.assertEqual(s.last_health["r1"][1]["mic_class"], "tonor")
        nulls = '{"room_id":"r1","zr":null,"peak":null,"mic_class":null}\n'
        self.assertTrue(s.on_line("kiosk/r1/health", nulls))
        self.assertEqual(open(os.path.join(d, "r1.health.jsonl")).read(), line + nulls)

    def test_quiet_after_120s_once_then_recovery_closes(self):
        s = self.mk()
        self.clock.adv(100); s.on_line("kiosk/r1/health", "{}"); self.assertEqual(s.check_quiet(), [])
        self.clock.adv(21); self.assertEqual(s.check_quiet(), ["r2"])          # r2 never spoke: counted from start, 121 s
        self.clock.adv(500); self.assertEqual(s.check_quiet(), ["r1"])          # r1 now quiet; r2 not re-raised
        self.assertEqual([q[0] for q in self.sink.quiet], ["r2", "r1"])
        s.on_line("kiosk/r2/health", "{}"); self.assertEqual(self.sink.rec, ["r2"])
        s.on_line("kiosk/r2/heal", "{}"); self.assertEqual(self.sink.rec, ["r2"])
        self.clock.adv(121); self.assertEqual(s.check_quiet(), ["r2"])          # a new quiet spell raises again

    def test_exactly_120s_is_not_quiet(self):
        s = self.mk(); self.clock.adv(120); self.assertEqual(s.check_quiet(), [])

    def test_prune_keeps_30_days(self):
        s = self.mk()
        for name in ("2026-09-12", "2026-09-13", "2026-10-13", "notes"):
            os.makedirs(os.path.join(s.data, name))
        self.assertEqual(s.prune(), ["2026-09-12"])                             # 2026-09-13 is exactly 30 days back: kept
        self.assertEqual(sorted(os.listdir(s.data)), ["2026-09-13", "2026-10-13", "_to_delete", "notes"])   # moved aside, not deleted
        self.assertEqual(os.listdir(os.path.join(s.data, "_to_delete")), ["2026-09-12"])

    def test_control_fail_safe_and_modes(self):
        s = self.mk()
        self.assertEqual(s.control_snapshot(), {"kill": True, "modes": {"r1": "shadow", "r2": "shadow"}})   # no files: kill on, shadow
        open(os.path.join(s.ctl, "kill-switch"), "w").write("off\n"); os.makedirs(os.path.join(s.ctl, "modes"))
        open(os.path.join(s.ctl, "modes", "r1"), "w").write("heal\n"); open(os.path.join(s.ctl, "modes", "r2"), "w").write("HEALX")
        self.assertEqual(s.control_snapshot(), {"kill": False, "modes": {"r1": "heal", "r2": "shadow"}})
        sent = []; s.publish_control(lambda t, m: sent.append((t, json.loads(m))))
        self.assertEqual(sent[0][0], "guardian/control"); self.assertFalse(sent[0][1]["kill"])


    def test_control_payload_carries_ts_and_keeps_existing_fields(self):
        import time
        self.t = tempfile.TemporaryDirectory(); self.addCleanup(self.t.cleanup)
        s = sb.Subscriber(os.path.join(self.t.name, "data"), self.t.name, ["r1"], Sink(), time.time)
        open(os.path.join(s.ctl, "kill-switch"), "w").write("off\n")
        before = int(time.time()); p = s.control_payload(); after = int(time.time())
        self.assertIsInstance(p["ts"], int); self.assertNotIsInstance(p["ts"], bool)
        self.assertTrue(before - 2 <= p["ts"] <= after + 2)
        self.assertEqual({k: v for k, v in p.items() if k != "ts"}, s.control_snapshot())       # every existing field unchanged
        self.assertEqual(sorted(p), ["kill", "modes", "ts"])
        sent = []; s.publish_control(lambda t, m: sent.append((t, json.loads(m))))
        self.assertEqual(sent[0][0], "guardian/control"); self.assertTrue(abs(sent[0][1]["ts"] - time.time()) <= 2)
        self.assertFalse(sent[0][1]["kill"]); self.assertEqual(sent[0][1]["modes"], {"r1": "shadow"})

    def test_ts_is_taken_at_each_call_not_cached(self):
        self.t = tempfile.TemporaryDirectory(); self.addCleanup(self.t.cleanup)
        c = Clock(T0); s = sb.Subscriber(os.path.join(self.t.name, "data"), self.t.name, ["r1"], Sink(), c)
        a = s.control_payload()["ts"]; c.adv(40); b = s.control_payload()["ts"]
        self.assertEqual(b - a, 40)


class RecSink(Sink):
    def __init__(self): super().__init__(); self.esc, self.res = [], []
    def heal_escalated(self, room, now): self.esc.append(room)
    def heal_resolved(self, room, now): self.res.append(room)

class HealTests(unittest.TestCase):
    def test_heal_result_escalated_and_resolved_routed_to_sink(self):
        with tempfile.TemporaryDirectory() as t:
            sink, clock = RecSink(), Clock(T0)
            s = sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sink, clock)
            s.on_line("kiosk/r1/heal", '{"result":"ok","shadow":true}'); s.on_line("kiosk/r1/heal", '{"result":"escalated"}')
            s.on_line("kiosk/r1/heal", '{"result":"ESCALATED"}'); s.on_line("kiosk/r1/heal", "garbage")
            self.assertEqual((sink.esc, sink.res), (["r1", "r1"], ["r1"]))
            self.assertEqual(sink.invalid, [])                                      # "garbage" cannot be attributed to the coreaudio rule: logged only, no case

class SeedTests(unittest.TestCase):
    def test_restart_with_open_quiet_case_then_room_speaks_closes_it(self):
        import alert_router as ar
        class Bus:
            def __init__(s): s.msgs = []
            def post(s, subject, body, priority, thread_id): s.msgs.append({"subject": subject, "thread": thread_id, "body": body})
            def thread_messages(s, tid): return [m for m in s.msgs if m["thread"] == tid]
        with tempfile.TemporaryDirectory() as t:
            clock, bus, path = Clock(T0), Bus(), os.path.join(t, "cases.sqlite")
            router = ar.Router(ar.SqliteStore(path), lambda: bus, clock)
            sub1 = sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sb.RouterSink(router, lambda: bus), clock)
            clock.adv(121); self.assertEqual(sub1.check_quiet(), ["r1"])
            router2 = ar.Router(ar.SqliteStore(path), lambda: bus, clock)            # subscriber process restarts
            sink2 = sb.RouterSink(router2, lambda: bus)
            self.assertEqual(sink2.open_quiet_rooms(), ["r1"])
            sub2 = sb.Subscriber(os.path.join(t, "d"), t, ["r1", "r2"], sink2, clock, quiet_seed=sink2.open_quiet_rooms() + ["gone"])
            self.assertEqual(sub2.quiet, {"r1"})                                      # unknown rooms are not seeded
            clock.adv(30); sub2.on_line("kiosk/r1/health", "{}")
            self.assertIsNone(router2.store.get_open("r1", "guardian_quiet"))
            self.assertEqual(len(router2.store.list_notes()), 1)              # R2: the CLOSED note is queued; the router tick sends it
            router2.tick(bus); self.assertEqual(len([m for m in bus.msgs if "CLOSED" in m["body"]]), 1)


# ---- coreaudio heal alerts (kiosk/<room>/heal kinds -> durable cases)
from test_router import ar, FakeBus
from test_router import ist as _ist

SUN_NOON = _ist(2026, 10, 18, 12)       # Sunday: no clinic hours
TUE_22H = _ist(2026, 10, 13, 22)        # Tuesday 22:00: outside clinic hours


class CAEnv:
    def __init__(self, t0=T0, rooms=("r1", "r2")):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock, self.bus = Clock(t0), FakeBus()
        self.router = ar.Router(ar.SqliteStore(), lambda: self.bus, self.clock)
        self.sub = sb.Subscriber(os.path.join(self.tmp.name, "d"), self.tmp.name, list(rooms), sb.RouterSink(self.router), self.clock)

    def heal(self, obj, room="r1", raw=None):
        return self.sub.on_line(f"kiosk/{room}/heal", raw if raw is not None else json.dumps(obj))

    def health(self, obj, room="r1"):
        return self.sub.on_line(f"kiosk/{room}/health", json.dumps(obj))

    def open(self, room="r1"):
        return {c["kind"]: c for c in self.router.store.list_open() if c["room_id"] == room}

    def v_texts(self):
        return [m for m in self.bus.real if "V room-alert-" in m["body"] or "V: patient-impacting" in m["body"]]


class CAKindTests(unittest.TestCase):
    def test_each_kind_opens_one_case_pages_once_and_is_marked_mini(self):
        for kind in sb.HEAL_KINDS:
            with self.subTest(kind=kind):
                e = CAEnv(); e.heal({"kind": kind, "result": "escalated", "action": "coreaudiod_restart", "before_zero_ratio": 1.0})
                self.assertEqual(list(e.open()), [kind])
                self.assertEqual(e.bus.sends, 0)                                  # opening never touches the bus (R2)
                out = e.router.tick(e.bus); self.assertEqual((out["paged"], e.bus.sends), (1, 1))
                body = e.bus.real[0]["body"]; self.assertIn(f"{kind} in r1.", body); self.assertIn("source=mini.", body)
                self.assertEqual(e.bus.real[0]["priority"], "urgent")

    def test_dedupe_same_kind_in_one_room_is_one_case_and_one_page(self):
        e = CAEnv()
        for _ in range(4): e.heal({"kind": "capture_dead"})
        e.heal({"kind": "capture_dead"}, room="r2")                                # another room is its own case
        e.heal({"kind": "capture_muted"})                                          # another kind is its own case
        c = e.open()["capture_dead"]; self.assertEqual(c["suppressed_count"], 3)
        self.assertEqual(len(e.router.store.list_open()), 3)
        e.router.tick(e.bus); self.assertEqual(e.bus.sends, 1); self.assertEqual(e.bus.real[0]["body"].count("[page 1]"), 3)

    def test_v_flag_in_clinic_hours_for_every_kind(self):
        for kind in sb.HEAL_KINDS:
            with self.subTest(kind=kind):
                e = CAEnv(T0); e.heal({"kind": kind}); e.router.tick(e.bus)
                self.assertEqual(e.v_texts(), [])                                   # V only after the 30 min threshold
                e.clock.adv(1860); e.router.tick(e.bus)
                self.assertTrue(e.v_texts(), "clinic hours, 31 min open, unacked: V")

    def test_v_window_for_the_coreaudio_kinds_is_0700_to_2135_every_day(self):
        for kind in sb.HEAL_KINDS:
            for label, t0, expect_v in (("sunday noon", SUN_NOON, True), ("tue 07:01", _ist(2026, 10, 13, 7, 1), True), ("tue 21:31 (opened 21:00)", _ist(2026, 10, 13, 21, 0), True),
                                        ("tue 06:31 (opened 06:00)", _ist(2026, 10, 13, 6, 0), False), ("tue 21:37 (opened 21:06)", _ist(2026, 10, 13, 21, 6), False)):
                with self.subTest(kind=kind, at=label):
                    e = CAEnv(t0); e.heal({"kind": kind}); e.router.tick(e.bus)
                    e.clock.adv(1860); e.router.tick(e.bus)                      # 31 min later: the V clock is read at THIS time
                    self.assertEqual(bool(e.v_texts()), expect_v)

    def test_other_kinds_keep_the_general_clinic_window(self):
        e = CAEnv(T0); e.router.on_row(e.bus, {"id": 77, "kind": "recorder_off", "room_ids": ["r1"]}); e.router.tick(e.bus)
        e.clock.t = _ist(2026, 10, 13, 21, 45); e.router.tick(e.bus); e.clock.adv(60)
        e2 = CAEnv(_ist(2026, 10, 13, 21, 10)); e2.router.on_row(e2.bus, {"id": 78, "kind": "recorder_off", "room_ids": ["r1"]}); e2.router.tick(e2.bus)
        e2.clock.adv(1860); e2.router.tick(e2.bus)                               # 21:41: outside 07:30-21:30, so no V for a general kind
        self.assertEqual(e2.v_texts(), [])

    def test_no_v_flag_outside_the_window(self):
        for t0 in (TUE_22H, _ist(2026, 10, 14, 3)):
            for kind in sb.HEAL_KINDS:
                with self.subTest(t0=t0, kind=kind):
                    e = CAEnv(t0); e.heal({"kind": kind}); e.router.tick(e.bus)
                    for _ in range(4): e.clock.adv(1860); e.router.tick(e.bus)
                    self.assertEqual(e.v_texts(), []); self.assertGreaterEqual(e.bus.sends, 2)   # still paged, never V

    def test_result_without_kind_for_the_coreaudio_action(self):
        e = CAEnv(); e.heal({"kind": "coreaudio_heal_failed", "result": "escalated", "action": "coreaudiod_restart"}); self.assertEqual(list(e.open()), ["coreaudio_heal_failed"])
        e = CAEnv(); e.heal({"layer": "coreaudio", "result": "escalated", "action": "coreaudiod_restart"}); self.assertEqual(list(e.open()), ["heal_escalated"])   # no kind: the older rule
        e = CAEnv(); e.heal({"layer": "coreaudio", "result": "failed", "action": "coreaudiod_restart"}); self.assertEqual(e.router.store.list_open(), [])
        e = CAEnv(); e.heal({"result": "escalated"}); self.assertEqual(list(e.open()), ["heal_escalated"])          # the older rule is unchanged

    def test_healed_would_do_and_plain_failed_are_logged_only(self):
        e = CAEnv()
        for obj in ({"result": "healed", "action": "coreaudiod_restart", "recorder_pid_same": True}, {"result": "ok", "shadow": True},
                    {"result": "would_do", "action": "coreaudiod_restart"}, {"result": "failed"}, {"result": "HEALED"}):
            e.heal(obj)
        self.assertEqual(e.router.store.list_open(), []); self.assertEqual(e.router.store.list_notes(), [])
        lines = open(os.path.join(e.sub.data, "2026-10-13", "r1.heal.jsonl")).read().splitlines()
        self.assertEqual(len(lines), 5)                                             # every heal line is stored, as received

    def test_healed_result_does_not_close_a_capture_case(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"}); e.heal({"result": "healed", "action": "coreaudiod_restart"})
        self.assertIn("capture_dead", e.open())                                     # only health zero_ratio or ACK closes it


class CACloseTests(unittest.TestCase):
    def good(self, e, n, room="r1", zr=0.0004):
        for _ in range(n): e.health({"zero_ratio": zr}, room=room); e.clock.adv(10)

    def test_four_good_health_lines_close_the_audio_kinds_of_that_room_only(self):
        e = CAEnv()
        for k in ("capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_disturbed"): e.heal({"kind": k})
        e.heal({"kind": "capture_dead"}, room="r2"); e.router.tick(e.bus)
        self.good(e, 3); self.assertEqual(len(e.open("r1")), 4)                      # three is not enough
        self.good(e, 1)
        self.assertEqual(list(e.open("r1")), ["recorder_disturbed"])                 # audio is back; the recorder question stays open
        self.assertIn("capture_dead", e.open("r2"))
        e.router.tick(e.bus); self.assertEqual(e.bus.real[-1]["body"].count("CLOSED (recovery)"), 3)

    def test_a_bad_line_between_resets_the_run(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"})
        self.good(e, 3); e.health({"zero_ratio": 0.5}); self.good(e, 3); self.assertIn("capture_dead", e.open())
        self.good(e, 1); self.assertEqual(e.open(), {})
        e = CAEnv(); e.heal({"kind": "capture_dead"})
        self.good(e, 3); e.health({"no_zero_ratio": 1}); self.good(e, 3); self.assertIn("capture_dead", e.open())   # a line without zero_ratio is not a good line

    def test_good_lines_before_the_alert_do_not_count(self):
        e = CAEnv(); self.good(e, 10)
        e.heal({"kind": "capture_dead"}); self.good(e, 3); self.assertIn("capture_dead", e.open())
        self.good(e, 1); self.assertEqual(e.open(), {})

    def test_the_run_is_per_room(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"}); e.heal({"kind": "capture_dead"}, room="r2")
        self.good(e, 2, "r1"); self.good(e, 2, "r2"); self.good(e, 2, "r1"); self.assertEqual(e.open("r1"), {}); self.assertIn("capture_dead", e.open("r2"))

    def test_zero_ratio_that_does_not_recover(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"})
        for zr in (0.05, 0.06, 0.5, 1.0, True, False, "0.01", None, -0.1, 1.5, float("nan"), [0.0]):
            for _ in range(5): e.health({"zero_ratio": zr}); self.assertIn("capture_dead", e.open(), zr)
        self.good(e, 4, zr=0); self.assertEqual(e.open(), {})                        # int 0 is a number under 0.05

    def test_recovery_then_new_event_opens_a_new_case(self):
        e = CAEnv(); e.heal({"kind": "capture_muted"}); first = e.open()["capture_muted"]["first_id"]
        self.good(e, 4); e.heal({"kind": "capture_muted"})
        self.assertNotEqual(e.open()["capture_muted"]["first_id"], first)

    def test_ack_closes_every_new_kind_and_stops_pages(self):
        for kind in sb.HEAL_KINDS + ("heal_message_invalid",):
            with self.subTest(kind=kind):
                e = CAEnv()
                e.heal({"kind": kind} if kind != "heal_message_invalid" else {"kind": "nope"})
                cid = e.open()[kind]["first_id"]; e.router.tick(e.bus)
                e.bus.human("gating-lead", f"ACK room-alert-{cid}", f"room-alert-{cid}")
                e.clock.adv(30); out = e.router.tick(e.bus)
                self.assertEqual(out["acked"], 1); self.assertEqual(e.open(), {})
                row = e.router.store.db.execute("SELECT close_reason, acked_by FROM room_alert_case WHERE first_id=?", (cid,)).fetchone()
                self.assertEqual(tuple(row), ("acked", "gating-lead"))
                self.assertIn("CLOSED (acked by gating-lead)", e.bus.real[-1]["body"])
                n = e.bus.sends; e.clock.adv(3600); e.router.tick(e.bus); self.assertEqual(e.bus.sends, n)       # no more pages

    def test_ack_from_a_non_acker_does_not_close(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"}); cid = e.open()["capture_dead"]["first_id"]; e.router.tick(e.bus)
        e.bus.human("someone-else", f"ACK room-alert-{cid}", f"room-alert-{cid}"); e.clock.adv(30); e.router.tick(e.bus)
        self.assertIn("capture_dead", e.open())

    def test_ack_does_not_close_an_older_kind(self):
        e = CAEnv(); e.heal({"result": "escalated"}); cid = e.open()["heal_escalated"]["first_id"]; e.router.tick(e.bus)
        e.bus.human("fleet", f"ACK room-alert-{cid}", f"room-alert-{cid}"); e.clock.adv(30); e.router.tick(e.bus)
        self.assertIn("heal_escalated", e.open())                                    # unchanged behaviour: ack stops pages, recovery closes


class CAInvalidTests(unittest.TestCase):
    BAD = [{"kind": "capture_ded"}, {"kind": "recorder_disturbd"}, {"kind": ""}, {"kind": None}, {"kind": ["capture_dead"]}, {"kind": 5},
           {"kind": "capture_dead", "result": "weird"}, {"kind": "capture_dead", "result": 5}, {"kind": "capture_dead", "layer": "coreaudio", "result": "nope"}, {"kind": "capture_dead", "layer": "coreaudio", "result": ["ok"]},
           {"kind": "capture_muted", "action": "coreaudiod_restart", "result": None}, {"kind": "x", "layer": "coreaudio"},
           {"kind": "capture_dead", "mode": "armed"}, {"kind": "capture_dead", "kill": "yes"}, {"kind": "capture_dead", "control_age_s": "5"},
           {"kind": "capture_dead", "control_age_s": -1}, {"kind": "capture_dead", "guards": [1]}, {"kind": "capture_dead", "zero_ratio_before": 1.5},
           {"kind": "capture_dead", "zero_ratio_after": "0.1"}, {"kind": "capture_dead", "zero_ratio_before": True},
           {"kind": "capture_dead", "recorder_pid_before": -3}, {"kind": "capture_dead", "coreaudiod_pid_after": "9"}, {"kind": "capture_dead", "recorder_pid_after": 1.5}]
    # today's kiosk heal schema (R9 on main): no kind. None of these may ever be invalid.
    R9 = {"room_id": "opd6", "ts": 1760500000, "action": "restart_recorder", "layer": "recorder", "reason": "tape stalled", "before": {"pid": 11}, "after": None,
          "result": "would_do", "shadow": True, "target": "recorder", "severity": "info"}

    def test_validate_heal_shapes(self):
        for obj in self.BAD + [[1], "x", 5, None, True, [{"kind": "capture_dead"}]]:
            self.assertFalse(sb.validate_heal(obj)[0], obj)
        good = [{"kind": k} for k in sb.HEAL_KINDS] + [{"kind": "recorder_changed"}] + [{"layer": "coreaudio", "result": r} for r in sb.HEAL_RESULTS] + [
            {"kind": "capture_dead", "result": "Escalated", "extra": 1},
            {"kind": "capture_dead", "result": "would_do", "mode": "shadow", "kill": False, "control_age_s": 12.5, "guards": {"a": True}, "zero_ratio_before": 0.99,
             "zero_ratio_after": None, "coreaudiod_pid_before": 100, "coreaudiod_pid_after": 200, "recorder_pid_before": 5, "recorder_pid_after": 5}]
        for obj in good:
            self.assertEqual(sb.validate_heal(obj), (True, None), obj)

    def test_scope(self):
        for obj in (self.R9, {}, {"result": "nope"}, {"layer": "recorder", "result": "zzz"}, [1], "x", 5, None, {"layer": "Coreaudio"}, {"layer": "coreaudio"},
                    {"layer": "coreaudio", "result": "zzz"}, dict(self.R9, layer="coreaudio")):
            self.assertFalse(sb.coreaudio_scope(obj), obj)
        for obj in ({"kind": "x"}, {"kind": None}, {"kind": "capture_dead", "layer": "coreaudio"}, dict(self.R9, kind="capture_dead")):
            self.assertTrue(sb.coreaudio_scope(obj), obj)

    def test_r9_shaped_lines_are_stored_and_never_open_a_case(self):
        e = CAEnv()
        for res in ("would_do", "deferred", "log_only", "alert", "heal", "aborted_killswitch", "aborted_stale_control", "something_new", 7, None, ["x"]):
            e.heal(dict(self.R9, result=res))
        e.heal({k: v for k, v in self.R9.items() if k != "result"}); e.heal(dict(self.R9, layer=None)); e.heal(dict(self.R9, severity={"a": 1}, shadow="maybe"))
        self.assertEqual(e.router.store.list_open(), []); self.assertEqual(e.router.store.list_notes(), [])
        lines = open(os.path.join(e.sub.data, "2026-10-13", "r1.heal.jsonl")).read().splitlines()
        self.assertEqual(len(lines), 14); self.assertEqual(json.loads(lines[0]), dict(self.R9, result="would_do"))     # stored as received
        self.assertEqual(e.router.store.list_inbox_pending(), [])                                                       # and no HEAL action line queued

    def test_r9_shape_keeps_the_older_handling(self):
        e = CAEnv(); e.heal(dict(self.R9, result="escalated")); self.assertEqual(list(e.open()), ["heal_escalated"])
        e.heal(dict(self.R9, result="healed")); self.assertEqual(e.open(), {})                                           # the older close, unchanged

    def test_r9_with_the_coreaudio_action_but_no_kind_is_the_older_rule(self):
        for layer in ("recorder", "coreaudio"):
            e = CAEnv(); e.heal(dict(self.R9, layer=layer, action="coreaudiod_restart", result="healed"))
            self.assertEqual(e.router.store.list_open(), []); self.assertEqual(e.router.store.list_inbox_pending(), [])

    # The lines the kiosk's R9 heal.sh emits for the coreaudio layer TODAY (no kind): heal_event <action> <layer> <reason> <before> <after> <result> <shadow> <target> <severity>.
    HEAL_SH_COREAUDIO = [
        ("would_do", "coreaudio", "coreaudiod_wedged", "usb=true engine=false coreaudiod_pid=412", "", "WOULD-DO blocked=killswitch", True, "", ""),     # act_begin, kill switch
        ("would_do", "coreaudio", "coreaudiod_wedged", "usb=true engine=false coreaudiod_pid=412", "", "WOULD-DO", True, "", ""),                          # act_begin, shadow
        ("escalate", "coreaudio", "heal_rate_limited", "actions_last_hour=3", "", "stopped", False, "gating-lead,fleet", "page"),                         # act_begin, rate limit
        ("abort", "coreaudio", "coreaudiod_wedged", "usb=true engine=false coreaudiod_pid=412", "", "aborted_killswitch", False, "", ""),                   # act_step
        ("heal", "coreaudio", "coreaudiod_wedged", "usb=true engine=false coreaudiod_pid=412", "coreaudiod_pid_changed=true", "ok", False, "", ""),       # heal_coreaudiod ok
        ("heal", "coreaudio", "coreaudiod_wedged", "usb=true engine=false coreaudiod_pid=412", "coreaudiod_pid_changed=false", "no_restart_seen", False, "fleet", "page"),
        ("escalate", "coreaudio", "coreaudio_rms_dead", "usb=true engine=false coreaudiod_pid=412 capture_open=true", "", "escalated", True, "fleet", "info"),  # capture not idle
    ]

    def hs_line(self, row):
        a, layer, reason, before, after, result, shadow, target, sev = row
        return json.dumps({"room_id": "opd6", "ts": 1760500000, "action": a, "layer": layer, "reason": reason, "before": before, "after": after,
                           "result": result, "shadow": shadow, "target": target, "severity": sev}, separators=(",", ":"))

    def test_the_exact_heal_sh_coreaudio_layer_lines_never_open_the_invalid_case(self):
        e = CAEnv()
        for row in self.HEAL_SH_COREAUDIO: self.assertTrue(e.heal(None, raw=self.hs_line(row)))
        kinds = [c["kind"] for c in e.router.store.list_open()]
        self.assertNotIn("heal_message_invalid", kinds)
        self.assertEqual(kinds, ["heal_escalated"])                                  # only the one with result "escalated", by the older rule, as before
        queued = [t for _i, t, _c in e.router.store.list_inbox_pending()]             # only the two real restart attempts (ok, no_restart_seen) go to the INBOX
        self.assertEqual([x.split("result=")[1].split()[0] for x in queued], ["ok", "no_restart_seen"])
        lines = open(os.path.join(e.sub.data, "2026-10-13", "r1.heal.jsonl")).read().splitlines()
        self.assertEqual(len(lines), len(self.HEAL_SH_COREAUDIO)); self.assertEqual(lines[0], self.hs_line(self.HEAL_SH_COREAUDIO[0]))

    def test_each_heal_sh_coreaudio_line_alone_opens_no_invalid_case(self):
        for row in self.HEAL_SH_COREAUDIO:
            with self.subTest(result=row[5]):
                e = CAEnv(); e.heal(None, raw=self.hs_line(row))
                self.assertNotIn("heal_message_invalid", [c["kind"] for c in e.router.store.list_open()])

    def test_the_heal_sh_ok_line_closes_heal_escalated_as_before(self):
        e = CAEnv(); e.heal(None, raw=self.hs_line(self.HEAL_SH_COREAUDIO[6])); self.assertEqual(list(e.open()), ["heal_escalated"])
        e.heal(None, raw=self.hs_line(self.HEAL_SH_COREAUDIO[4])); self.assertEqual(e.open(), {})

    def test_every_bad_in_scope_shape_opens_one_invalid_case_and_never_crashes(self):
        e = CAEnv()
        for obj in self.BAD: e.heal(obj)
        self.assertEqual(list(e.open()), ["heal_message_invalid"])
        self.assertEqual(len(e.router.store.list_open()), 1)
        self.assertEqual(e.open()["heal_message_invalid"]["suppressed_count"], len(self.BAD) - 1)
        out = e.router.tick(e.bus); self.assertEqual((out["paged"], e.bus.sends, out["errors"]), (1, 1, 0))
        body = e.bus.real[0]["body"]; self.assertIn("heal_message_invalid in r1", body); self.assertNotIn("capture_ded", body)
        self.assertEqual(e.v_texts(), [])                                            # not patient-impacting by itself

    def test_out_of_scope_garbage_is_never_a_case(self):
        e = CAEnv()
        for raw in ("[1]", '"x"', "5", "null", "true", "{}", '{"result":"nope"}', '{"result":5}', '{"action":"coreaudiod_restart"}'): e.heal(None, raw=raw)
        for raw in ("not json", "{", "", "\x00\xff", "x" * 5000): e.heal(None, raw=raw)
        self.assertEqual(e.router.store.list_open(), [])

    def test_malformed_lines_are_logged_capped_and_json_quoted(self):
        e = CAEnv(); e.heal(None, raw="not json"); e.heal(None, raw="y" * 5000)
        p = os.path.join(e.sub.data, "2026-10-13", "r1.heal-invalid.jsonl")
        rows = [json.loads(l) for l in open(p).read().splitlines()]
        self.assertEqual([r["raw"][:8] for r in rows], ["not json", "yyyyyyyy"]); self.assertEqual(len(rows[1]["raw"]), sb.RAW_CAP)
        self.assertFalse(os.path.exists(os.path.join(e.sub.data, "2026-10-13", "r1.heal.jsonl")))   # the stream file only holds JSON lines
        self.assertEqual(e.router.store.list_open(), [])

    def test_in_scope_invalid_lines_are_stored_as_received(self):
        e = CAEnv(); e.heal(None, raw='{"kind":"capture_ded"}'); e.heal(None, raw='{"kind":"capture_dead","result":"zz"}')
        self.assertEqual(open(os.path.join(e.sub.data, "2026-10-13", "r1.heal.jsonl")).read(), '{"kind":"capture_ded"}\n{"kind":"capture_dead","result":"zz"}\n')

    def test_valid_lines_do_not_open_the_invalid_case_and_other_streams_are_untouched(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"}); e.heal({"result": "healed"})
        e.sub.on_line("kiosk/r1/probe-reply", "garbage"); e.sub.on_line("kiosk/r1/health", "garbage")
        self.assertEqual(list(e.open()), ["capture_dead"])

    def test_recorder_changed_is_an_alias_for_recorder_disturbed(self):
        e = CAEnv(); e.heal({"kind": "recorder_changed"}); self.assertEqual(list(e.open()), ["recorder_disturbed"])
        e.heal({"kind": "recorder_disturbed"}); self.assertEqual(e.open()["recorder_disturbed"]["suppressed_count"], 1)

    def test_invalid_case_survives_a_subscriber_restart_and_dedupes(self):
        with tempfile.TemporaryDirectory() as t:
            path = os.path.join(t, "cases.sqlite"); clock, bus = Clock(T0), FakeBus()
            r1 = ar.Router(ar.SqliteStore(path), lambda: bus, clock)
            sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sb.RouterSink(r1), clock).on_line("kiosk/r1/heal", '{"kind":"nope"}')
            r2 = ar.Router(ar.SqliteStore(path), lambda: bus, clock)
            sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sb.RouterSink(r2), clock).on_line("kiosk/r1/heal", '{"kind":"capture_dead","result":"zz"}')
            self.assertEqual([(c["kind"], c["suppressed_count"]) for c in r2.store.list_open()], [("heal_message_invalid", 1)])


class CAInboxTests(unittest.TestCase):
    HEALED = {"kind": "capture_dead", "layer": "coreaudio", "action": "coreaudiod_restart", "result": "healed", "mode": "heal", "zero_ratio_before": 0.999,
              "zero_ratio_after": 0.0004, "recorder_pid_before": 321, "recorder_pid_after": 321, "reason": "SECRET-FREE-TEXT-MUST-NOT-APPEAR"}

    def env(self, **kw):
        e = CAEnv(**kw); self.d = tempfile.TemporaryDirectory(); self.addCleanup(self.d.cleanup)
        self.path = os.path.join(self.d.name, "INBOX-FROM-GATING.md"); e.router.inbox_path = self.path
        return e

    def text(self): return open(self.path).read()

    def test_heal_action_line_is_one_line_with_the_contract_fields_and_no_free_text(self):
        e = self.env(); open(self.path, "w").write("- earlier entry\n")
        e.heal(self.HEALED); self.assertEqual(e.bus.sends, 0)
        out = e.router.tick(e.bus); self.assertEqual(out["inbox"], 1)
        lines = self.text().splitlines(); self.assertEqual(lines[0], "- earlier entry"); self.assertEqual(len(lines), 2)
        self.assertEqual(lines[1], "- 13 Oct 11:00 IST pico-router HEAL: room=r1 result=healed zero_ratio_before=0.9990 zero_ratio_after=0.0004 recorder_pid_same=y")
        self.assertNotIn("SECRET", self.text())

    def test_every_result_is_appended_whatever_the_action_and_would_do_and_others_are_not(self):
        e = self.env()
        for res in ("healed", "failed", "escalated", "Healed"): e.heal(dict(self.HEALED, result=res, recorder_pid_after=999 if res == "failed" else 321))
        for obj in (dict(self.HEALED, action="other"), {k: v for k, v in self.HEALED.items() if k != "action"}, dict(self.HEALED, action="escalate", result="escalated"),
                    {"kind": "capture_muted", "result": "escalated"}):                     # queued by result, whatever the action (S1 safety net)
            e.heal(obj)
        for obj in (dict(self.HEALED, result="would_do"), dict(self.HEALED, result="ok"), {"kind": "capture_dead", "result": "would_do", "action": "coreaudiod_restart"},
                    {"kind": "capture_dead"}):                                              # would_do, the older ok (invalid), no result: never queued
            e.heal(obj)
        e.router.tick(e.bus); ls = self.text().splitlines()
        self.assertEqual(len(ls), 8); self.assertEqual([x.split("result=")[1].split()[0] for x in ls], ["healed", "failed", "escalated", "healed", "healed", "healed", "escalated", "escalated"])
        self.assertIn("recorder_pid_same=n", ls[1])

    def test_unknown_numbers_are_question_marks(self):
        e = self.env(); e.heal({"kind": "capture_dead", "action": "coreaudiod_restart", "result": "failed"}); e.router.tick(e.bus)
        self.assertIn("zero_ratio_before=? zero_ratio_after=? recorder_pid_same=?", self.text())

    def test_a_file_without_a_final_newline_gets_one_first(self):
        e = self.env(); open(self.path, "w").write("- no newline"); e.heal(self.HEALED); e.router.tick(e.bus)
        self.assertEqual(self.text().splitlines()[0], "- no newline"); self.assertEqual(len(self.text().splitlines()), 2)

    def test_missing_file_is_created_and_a_line_is_never_written_twice(self):
        e = self.env(); e.heal(self.HEALED); e.router.tick(e.bus); e.clock.adv(30); e.router.tick(e.bus); e.router.tick(e.bus)
        self.assertEqual(len(self.text().splitlines()), 1)

    def test_without_inbox_path_the_queue_is_only_written(self):
        e = CAEnv(); e.heal(self.HEALED); out = e.router.tick(e.bus)
        self.assertEqual(len(e.router.store.list_inbox_pending()), 1); self.assertNotIn("inbox", out)

    def test_unwritable_file_alarms_after_five_minutes_once_then_closes_when_it_drains(self):
        e = self.env(); e.router.inbox_path = os.path.join(self.d.name, "nodir", "INBOX.md")
        e.heal(self.HEALED); e.router.tick(e.bus); self.assertEqual(e.open("mini"), {})                                  # not yet: still inside 5 min
        e.clock.adv(299); e.router.tick(e.bus); self.assertEqual(e.open("mini"), {})
        e.clock.adv(2); e.router.tick(e.bus); self.assertEqual(list(e.open("mini")), ["heal_inbox_stuck"])
        first = e.open("mini")["heal_inbox_stuck"]["first_id"]
        for _ in range(3): e.clock.adv(30); e.router.tick(e.bus)
        self.assertEqual(e.open("mini")["heal_inbox_stuck"]["first_id"], first); self.assertEqual(e.open("mini")["heal_inbox_stuck"]["suppressed_count"], 0)
        self.assertTrue(any("heal_inbox_stuck in mini" in m["body"] for m in e.bus.real))
        os.makedirs(os.path.join(self.d.name, "nodir")); e.clock.adv(30); out = e.router.tick(e.bus)
        self.assertEqual(out["inbox"], 1); self.assertEqual(e.open("mini"), {}); self.assertEqual(len(open(e.router.inbox_path).read().splitlines()), 1)

    def test_a_fault_in_the_inbox_stage_does_not_stop_the_others(self):
        e = self.env(); e.router.on_row(e.bus, {"id": 5, "kind": "offline", "room_ids": ["r1"]})
        e.router.store.list_inbox_pending = lambda: (_ for _ in ()).throw(RuntimeError("db"))
        out = e.router.tick(e.bus); self.assertEqual(out["errors"], 1); self.assertEqual(out["paged"], 1)

    def test_heal_inbox_stuck_is_not_a_v_kind(self):
        self.assertNotIn("heal_inbox_stuck", ar.V_KINDS); self.assertIn("heal_inbox_stuck", ar.URGENT)


class CAR9InboxTests(unittest.TestCase):
    """CA-C6 for the kiosk's R9 coreaudio heal (heal.sh): layer coreaudio AND action heal, no kind, not WOULD-DO / shadow."""
    def line(self, **kw):
        base = {"room_id": "opd6", "ts": 1760500000, "action": "heal", "layer": "coreaudio", "reason": "coreaudiod_wedged", "before": "usb=true engine=false coreaudiod_pid=412",
                "after": "coreaudiod_pid_changed=true", "result": "ok", "shadow": False, "target": "", "severity": ""}
        base.update(kw); return base

    def queued(self, e): return [t for _i, t, _c in e.router.store.list_inbox_pending()]

    def test_a_real_r9_coreaudio_heal_is_queued_in_the_same_record_format(self):
        e = CAEnv(); e.heal(self.line())
        self.assertEqual(self.queued(e), ["- 13 Oct 11:00 IST pico-router HEAL: room=r1 result=ok zero_ratio_before=? zero_ratio_after=? recorder_pid_same=? coreaudiod_pid_changed=y"])
        e = CAEnv(); e.heal(self.line(after="coreaudiod_pid_changed=false", result="no_restart_seen", target="fleet", severity="page"))
        self.assertEqual(self.queued(e), ["- 13 Oct 11:00 IST pico-router HEAL: room=r1 result=no_restart_seen zero_ratio_before=? zero_ratio_after=? recorder_pid_same=? coreaudiod_pid_changed=n"])
        e = CAEnv(); e.heal(self.line(after="")); self.assertTrue(self.queued(e)[0].endswith("coreaudiod_pid_changed=?"))

    def test_would_do_shadow_other_actions_and_other_layers_are_not_queued(self):
        e = CAEnv()
        for kw in ({"result": "WOULD-DO"}, {"result": "WOULD-DO blocked=killswitch"}, {"result": "would_do"}, {"shadow": True}, {"action": "would_do"}, {"action": "abort", "result": "aborted_killswitch"},
                   {"action": "escalate", "result": "escalated"}, {"layer": "recorder"}, {"layer": "tcc"}, {"layer": "Coreaudio"}, {"result": None}, {"result": 5}, {"action": None}):
            e.heal(self.line(**kw))
        self.assertEqual(self.queued(e), [])

    def test_the_result_word_is_case_insensitive(self):
        e = CAEnv(); e.heal(self.line(result="OK")); e.heal(self.line(result="No_Restart_Seen"))
        self.assertEqual([("result=ok" in q, "result=no_restart_seen" in q) for q in self.queued(e)], [(True, False), (False, True)])

    def test_no_kiosk_free_text_reaches_the_line(self):
        e = CAEnv(); e.heal(self.line(result="ok; echo SECRET", reason="SECRET reason", before="SECRET before", after="SECRET after coreaudiod_pid_changed=true", target="SECRET"))
        q = self.queued(e); self.assertEqual(len(q), 1); self.assertNotIn("SECRET", q[0]); self.assertIn("result=other", q[0]); self.assertEqual(len(q[0].splitlines()), 1)
        e = CAEnv(); e.heal(self.line(result="x" * 40)); self.assertIn("result=other", self.queued(e)[0])

    def test_r9_lines_still_open_no_case_and_a_kind_line_is_not_queued_twice(self):
        e = CAEnv(); e.heal(self.line()); self.assertEqual(e.router.store.list_open(), [])
        e.heal(dict(self.line(), kind="capture_dead", action="coreaudiod_restart", result="healed"))
        self.assertEqual(len(self.queued(e)), 2)                                    # one R9 line + one kind line, each once

    def test_the_router_appends_it_to_the_inbox(self):
        e = CAEnv(); d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        e.router.inbox_path = os.path.join(d.name, "INBOX.md"); e.heal(self.line()); e.router.tick(e.bus)
        self.assertEqual(len(open(e.router.inbox_path).read().splitlines()), 1); self.assertIn("coreaudiod_pid_changed=y", open(e.router.inbox_path).read())


class CAResultGateTests(unittest.TestCase):
    """M1 (guardian-lead refute): a kind line opens its case ONLY on result failed / escalated (or no result); healed / would_do open nothing."""
    KINDS = ("capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_disturbed", "recorder_changed")      # recorder_changed: the alias
    RESULTS = ("healed", "failed", "escalated", "would_do", "ok")
    ACTIONS = ("coreaudiod_restart", "escalate", "heal", None)

    def test_guardian_leads_100_line_probe(self):
        """5 kinds x 5 results x 4 actions, each on a fresh store."""
        seen = {}
        for kind in self.KINDS:
            for res in self.RESULTS:
                for act in self.ACTIONS:
                    e = CAEnv(); obj = {"kind": kind, "result": res}
                    if act: obj["action"] = act
                    e.heal(obj)
                    opened = sorted(c["kind"] for c in e.router.store.list_open()); queued = len(e.router.store.list_inbox_pending())
                    canon = "recorder_disturbed" if kind == "recorder_changed" else kind
                    with self.subTest(kind=kind, result=res, action=act):
                        if canon == "recorder_disturbed":                                            # CA-C5: any result, top severity
                            self.assertEqual(opened, sorted(["recorder_disturbed"] + (["heal_message_invalid"] if res == "ok" else [])))
                        elif res in ("failed", "escalated"): self.assertEqual(opened, [canon])
                        elif res == "ok": self.assertEqual(opened, ["heal_message_invalid"])        # the older "ok" is not a contract result
                        else: self.assertEqual(opened, [])                                           # healed / would_do: log only
                        self.assertEqual(queued, 1 if res in ("healed", "failed", "escalated") else 0)   # INBOX by result, any action; never would_do
                    seen[(res)] = seen.get(res, 0) + 1
        self.assertEqual(sum(seen.values()), 100)

    def test_a_line_with_no_result_fails_closed_to_the_kinds_case(self):
        for kind in ("capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_disturbed"):
            e = CAEnv(); e.heal({"kind": kind}); self.assertEqual(list(e.open()), [kind]); self.assertEqual(e.router.store.list_inbox_pending(), [])

    def test_unknown_or_malformed_result_is_the_invalid_case(self):
        for res in ("nope", "ok", "", "HEALED2", 5, None, ["failed"], {"a": 1}, True):
            e = CAEnv(); e.heal({"kind": "capture_dead", "result": res})
            self.assertEqual(list(e.open()), ["heal_message_invalid"], res)

    def test_result_case_is_ignored(self):
        e = CAEnv(); e.heal({"kind": "capture_dead", "result": "HEALED"}); self.assertEqual(e.router.store.list_open(), [])
        e.heal({"kind": "capture_dead", "result": "Failed"}); self.assertEqual(list(e.open()), ["capture_dead"])

    def test_a_healed_line_opens_nothing_closes_nothing_and_does_not_reset_the_recovery_run(self):
        e = CAEnv(); e.heal({"kind": "capture_dead", "result": "failed"})
        for _ in range(3): e.health({"zero_ratio": 0.0}); e.clock.adv(10)
        e.heal({"kind": "capture_dead", "result": "healed", "action": "coreaudiod_restart"})      # a later successful heal line: no new case, run keeps counting
        self.assertEqual(e.open()["capture_dead"]["suppressed_count"], 0)
        e.health({"zero_ratio": 0.0}); self.assertEqual(e.open(), {})

    def test_a_shadow_kind_line_opens_its_case_but_never_queues_the_inbox(self):
        for extra in ({"mode": "shadow"}, {"shadow": True}, {"mode": "shadow", "shadow": True}):
            e = CAEnv(); e.heal(dict({"kind": "capture_dead", "result": "escalated", "action": "escalate"}, **extra))
            self.assertEqual(list(e.open()), ["capture_dead"]); self.assertEqual(e.router.store.list_inbox_pending(), [])
        e = CAEnv(); e.heal({"kind": "capture_dead", "result": "escalated", "action": "escalate", "mode": "heal", "shadow": False})
        self.assertEqual(len(e.router.store.list_inbox_pending()), 1)             # a heal-mode line still queues

    def test_the_night_heal_and_the_shadow_would_do_page_nobody(self):
        e = CAEnv(TUE_22H)
        for obj in ({"kind": "capture_dead", "result": "would_do", "mode": "shadow", "action": "coreaudiod_restart"},
                    {"kind": "capture_dead", "result": "healed", "mode": "heal", "action": "coreaudiod_restart", "zero_ratio_before": 1, "zero_ratio_after": 0.0004,
                     "recorder_pid_before": 5, "recorder_pid_after": 5}):
            e.heal(obj)
        out = e.router.tick(e.bus); self.assertEqual((out["paged"], e.bus.sends, e.router.store.list_open()), (0, 0, []))
        self.assertEqual(len(e.router.store.list_inbox_pending()), 1)                             # only the real heal reaches the INBOX queue

    def test_recorder_disturbed_and_its_alias_open_a_case_for_every_result(self):
        for kind in ("recorder_disturbed", "recorder_changed"):
            for res in ("healed", "failed", "escalated", "would_do", "HEALED", "ok", "weird", "", None, 5, ["x"], True, "MISSING"):
                for act in ("coreaudiod_restart", "escalate", "heal", None):
                    e = CAEnv(); obj = {"kind": kind}
                    if res != "MISSING": obj["result"] = res
                    if act: obj["action"] = act
                    e.heal(obj)
                    with self.subTest(kind=kind, result=res, action=act):
                        self.assertIn("recorder_disturbed", [c["kind"] for c in e.router.store.list_open()])
                        self.assertEqual(len([c for c in e.router.store.list_open() if c["kind"] == "recorder_disturbed"]), 1)

    def test_recorder_disturbed_with_a_bad_shape_opens_both_cases_and_other_kinds_do_not(self):
        e = CAEnv(); e.heal({"kind": "recorder_disturbed", "result": "healed", "mode": "armed", "recorder_pid_before": -1})
        self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["heal_message_invalid", "recorder_disturbed"])
        for obj in ({"kind": "capture_dead", "result": "healed", "mode": "armed"}, {"kind": "capture_dead", "result": "healed"}, {"kind": "capture_muted", "result": "would_do"}):
            e = CAEnv(); e.heal(obj); self.assertNotIn("recorder_disturbed", [c["kind"] for c in e.router.store.list_open()])
            self.assertNotIn("capture_dead" if obj["kind"] == "capture_dead" else "capture_muted", [c["kind"] for c in e.router.store.list_open()])

    def test_an_unhashable_kind_does_not_crash(self):
        e = CAEnv()
        for obj in ({"kind": ["recorder_disturbed"]}, {"kind": {"a": 1}}, {"kind": None}, {"kind": 5}):
            e.heal(obj)
        self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["heal_message_invalid"])

    def test_recorder_disturbed_healed_is_paged_and_v_flagged_in_the_window_and_closes_only_on_ack(self):
        e = CAEnv(T0); e.heal({"kind": "recorder_disturbed", "result": "healed", "mode": "heal", "action": "coreaudiod_restart", "recorder_pid_before": 5, "recorder_pid_after": 9})
        out = e.router.tick(e.bus); self.assertEqual((out["paged"], e.bus.sends), (1, 1))
        self.assertIn("recorder_disturbed in r1", e.bus.real[0]["body"]); self.assertEqual(e.bus.real[0]["priority"], "urgent")
        for _ in range(6): e.health({"zero_ratio": 0.0}); e.clock.adv(10)
        self.assertIn("recorder_disturbed", e.open())                                         # audio back does not close it
        e.clock.adv(1800); e.router.tick(e.bus); self.assertTrue(e.v_texts())                 # V inside 07:00-21:35
        cid = e.open()["recorder_disturbed"]["first_id"]; e.bus.human("fleet", f"ACK room-alert-{cid}", f"room-alert-{cid}"); e.clock.adv(30); e.router.tick(e.bus)
        self.assertEqual(e.open(), {})

    def test_validate_heal_drops_ok_for_kind_lines(self):
        self.assertFalse(sb.validate_heal({"kind": "capture_dead", "result": "ok"})[0])
        for r in ("healed", "failed", "escalated", "would_do"): self.assertTrue(sb.validate_heal({"kind": "capture_dead", "result": r})[0])


if __name__ == "__main__":
    unittest.main()
