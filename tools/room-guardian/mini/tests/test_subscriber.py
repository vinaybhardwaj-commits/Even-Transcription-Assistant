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
    def __init__(self): self.quiet, self.rec = [], []
    def guardian_quiet(self, room, q, now): self.quiet.append((room, int(q)))
    def guardian_recovered(self, room, now): self.rec.append(room)

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


if __name__ == "__main__":
    unittest.main()
