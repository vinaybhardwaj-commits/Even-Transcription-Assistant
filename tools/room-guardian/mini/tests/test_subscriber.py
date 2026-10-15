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
            self.assertEqual(sink.invalid, ["r1"])                                  # "garbage" is a malformed heal line

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

    def test_no_v_flag_outside_clinic_hours(self):
        for t0 in (SUN_NOON, TUE_22H):
            for kind in sb.HEAL_KINDS:
                with self.subTest(t0=t0, kind=kind):
                    e = CAEnv(t0); e.heal({"kind": kind}); e.router.tick(e.bus)
                    for _ in range(4): e.clock.adv(1860); e.router.tick(e.bus)
                    self.assertEqual(e.v_texts(), []); self.assertGreaterEqual(e.bus.sends, 2)   # still paged, never V

    def test_result_without_kind_for_the_coreaudio_action(self):
        e = CAEnv(); e.heal({"result": "escalated", "action": "coreaudiod_restart"}); self.assertEqual(list(e.open()), ["coreaudio_heal_failed"])
        e = CAEnv(); e.heal({"result": "failed", "action": "coreaudiod_restart"}); self.assertEqual(list(e.open()), ["coreaudio_heal_failed"])
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
    def test_zero_ratio_under_005_closes_the_audio_kinds_of_that_room_only(self):
        e = CAEnv()
        for k in ("capture_dead", "capture_muted", "coreaudio_heal_failed", "recorder_changed"): e.heal({"kind": k})
        e.heal({"kind": "capture_dead"}, room="r2")
        e.router.tick(e.bus)
        e.health({"zero_ratio": 0.0004})
        self.assertEqual(list(e.open("r1")), ["recorder_changed"])                  # audio is back; the recorder question stays open
        self.assertIn("capture_dead", e.open("r2"))
        e.clock.adv(30); e.router.tick(e.bus)
        self.assertEqual(len([m for m in e.bus.real if "CLOSED (recovery)" in m["body"]]), 1)
        self.assertEqual(e.bus.real[-1]["body"].count("CLOSED (recovery)"), 3)

    def test_zero_ratio_that_does_not_recover(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"})
        for zr in (0.05, 0.06, 0.5, 1.0, True, False, "0.01", None, -0.1, 1.5, float("nan"), [0.0]):
            e.health({"zero_ratio": zr}); self.assertIn("capture_dead", e.open(), zr)
        e.health({"other": 0.0}); e.health({}); self.assertIn("capture_dead", e.open())
        e.health({"zero_ratio": 0}); self.assertEqual(e.open(), {})                  # int 0 is a number under 0.05

    def test_recovery_then_new_event_opens_a_new_case(self):
        e = CAEnv(); e.heal({"kind": "capture_muted"}); first = e.open()["capture_muted"]["first_id"]
        e.health({"zero_ratio": 0.0}); e.heal({"kind": "capture_muted"})
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
    BAD = [{"kind": "capture_ded"}, {"kind": "recorder_disturbed"}, {"kind": ""}, {"kind": None}, {"kind": ["capture_dead"]}, {"kind": 5},
           {"result": "nope"}, {"result": 5}, {"result": None}, {"result": ["ok"]}, {}, {"action": "coreaudiod_restart"}, {"kind": "capture_dead", "result": "weird"}]

    def test_validate_heal_shapes(self):
        for obj in self.BAD + [[1], "x", 5, None, True, [{"kind": "capture_dead"}]]:
            self.assertFalse(sb.validate_heal(obj)[0], obj)
        for obj in [{"kind": k} for k in sb.HEAL_KINDS] + [{"result": r} for r in sb.HEAL_RESULTS] + [{"result": "Escalated"}, {"kind": "capture_dead", "result": "escalated", "extra": 1}]:
            self.assertEqual(sb.validate_heal(obj), (True, None), obj)

    def test_every_bad_shape_opens_one_invalid_case_and_never_crashes(self):
        e = CAEnv()
        for obj in self.BAD: e.heal(obj)
        for raw in ("[1]", '"x"', "5", "null", "true"): e.heal(None, raw=raw)
        for raw in ("not json", "{", "", "\x00\xff", "x" * 5000): e.heal(None, raw=raw)
        self.assertEqual(list(e.open()), ["heal_message_invalid"])
        self.assertEqual(len(e.router.store.list_open()), 1)
        self.assertEqual(e.open()["heal_message_invalid"]["suppressed_count"], len(self.BAD) + 5 + 5 - 1)
        out = e.router.tick(e.bus); self.assertEqual((out["paged"], e.bus.sends, out["errors"]), (1, 1, 0))
        body = e.bus.real[0]["body"]; self.assertIn("heal_message_invalid in r1", body); self.assertNotIn("capture_ded", body); self.assertNotIn("xxxx", body)
        self.assertEqual(e.v_texts(), [])                                            # not patient-impacting by itself

    def test_malformed_lines_are_logged_capped_and_json_quoted(self):
        e = CAEnv(); e.heal(None, raw="not json"); e.heal(None, raw="y" * 5000)
        p = os.path.join(e.sub.data, "2026-10-13", "r1.heal-invalid.jsonl")
        rows = [json.loads(l) for l in open(p).read().splitlines()]
        self.assertEqual([r["raw"][:8] for r in rows], ["not json", "yyyyyyyy"]); self.assertEqual(len(rows[1]["raw"]), sb.RAW_CAP)
        self.assertFalse(os.path.exists(os.path.join(e.sub.data, "2026-10-13", "r1.heal.jsonl")))   # the stream file only holds JSON lines

    def test_invalid_json_but_parsed_lines_are_still_stored_as_received(self):
        e = CAEnv(); e.heal(None, raw='{"kind":"capture_ded"}'); e.heal(None, raw="[1]")
        self.assertEqual(open(os.path.join(e.sub.data, "2026-10-13", "r1.heal.jsonl")).read(), '{"kind":"capture_ded"}\n[1]\n')

    def test_valid_lines_do_not_open_the_invalid_case_and_other_streams_are_untouched(self):
        e = CAEnv(); e.heal({"kind": "capture_dead"}); e.heal({"result": "healed"})
        e.sub.on_line("kiosk/r1/probe-reply", "garbage"); e.sub.on_line("kiosk/r1/health", "garbage")
        self.assertEqual(list(e.open()), ["capture_dead"])

    def test_invalid_case_survives_a_subscriber_restart_and_dedupes(self):
        with tempfile.TemporaryDirectory() as t:
            path = os.path.join(t, "cases.sqlite"); clock, bus = Clock(T0), FakeBus()
            r1 = ar.Router(ar.SqliteStore(path), lambda: bus, clock)
            sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sb.RouterSink(r1), clock).on_line("kiosk/r1/heal", "garbage")
            r2 = ar.Router(ar.SqliteStore(path), lambda: bus, clock)
            sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sb.RouterSink(r2), clock).on_line("kiosk/r1/heal", "[]")
            self.assertEqual([(c["kind"], c["suppressed_count"]) for c in r2.store.list_open()], [("heal_message_invalid", 1)])


if __name__ == "__main__":
    unittest.main()
