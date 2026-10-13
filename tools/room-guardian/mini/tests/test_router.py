import os, sys, tempfile, unittest
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "router"))
import alert_router as ar
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'subscriber'))
import subscriber as sb
import relay_watcher as rw

IST = timezone(timedelta(hours=5, minutes=30))
def ist(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=IST).timestamp()
TUE_11 = ist(2026, 10, 13, 11)        # Tuesday, clinic hours
TUE_22 = ist(2026, 10, 13, 22)        # Tuesday night
SUN_12 = ist(2026, 10, 18, 12)        # Sunday: no clinic


class Clock:
    def __init__(self, t): self.t = t
    def __call__(self): return self.t
    def adv(self, s): self.t += s


class FakeBus:
    def __init__(self, fail_after=None):
        self.msgs, self.fail_after = [], fail_after
    def post(self, subject, body, priority, thread_id):
        self.msgs.append({"from": "router", "subject": subject, "body": body, "priority": priority, "thread": thread_id})
    def thread_messages(self, tid): return [m for m in self.msgs if m["thread"] == tid]
    def human(self, sender, text, tid): self.msgs.append({"from": sender, "subject": text, "body": "", "thread": tid})
    def pages(self, tid=None): return [m for m in self.msgs if "[page" in m["subject"] and (tid is None or m["thread"] == tid)]


class FlakyStore(ar.SqliteStore):
    """Raises on the first update() after arm(): a crash between the bus post and the state write."""
    armed = False
    def update(self, first_id, **f):
        if self.armed:
            self.armed = False
            raise RuntimeError("crash before state write")
        return super().update(first_id, **f)


def row(i, kind="recorder_off", room="r1"): return {"id": i, "kind": kind, "room_ids": [room], "room_name": "Room One"}


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.clock, self.bus, self.store = Clock(TUE_11), FakeBus(), ar.SqliteStore()
        self.r = ar.Router(self.store, lambda: self.bus, self.clock)

    def test_open_pages_once_then_repages_every_10_min_in_clinic(self):
        self.r.on_row(self.bus, row(100))
        self.assertEqual(len(self.bus.pages()), 1)
        self.clock.adv(599); self.r.tick(self.bus); self.assertEqual(len(self.bus.pages()), 1)
        self.clock.adv(1); self.r.tick(self.bus); self.assertEqual(len(self.bus.pages()), 2)
        self.assertEqual(self.store.get_open("r1", "recorder_off")["page_count"], 2)

    def test_repage_every_30_min_outside_clinic(self):
        self.clock.t = SUN_12
        self.r.on_row(self.bus, row(100, "offline"))
        self.clock.adv(1799); self.r.tick(self.bus); self.assertEqual(len(self.bus.pages()), 1)
        self.clock.adv(1); self.r.tick(self.bus); self.assertEqual(len(self.bus.pages()), 2)

    def test_ack_stops_repages_case_stays_open(self):
        self.r.on_row(self.bus, row(100))
        self.bus.human("gating-lead", "ACK room-alert-100", "room-alert-100")
        self.clock.adv(600); out = self.r.tick(self.bus)
        self.assertEqual(out["acked"], 1)
        self.clock.adv(3000); self.r.tick(self.bus)
        self.assertEqual(len(self.bus.pages()), 1)
        c = self.store.get_open("r1", "recorder_off")
        self.assertEqual(c["acked_by"], "gating-lead"); self.assertIsNone(c["closed_at"])

    def test_ack_only_from_gating_lead_or_fleet_and_exact_id(self):
        self.r.on_row(self.bus, row(12))
        self.bus.human("someone", "ACK room-alert-12", "room-alert-12")
        self.bus.human("fleet", "ACK room-alert-123", "room-alert-12")
        self.clock.adv(600); self.r.tick(self.bus)
        self.assertIsNone(self.store.get_open("r1", "recorder_off")["acked_at"])
        self.bus.human("fleet", "ack room-alert-12 on it", "room-alert-12")
        self.r.tick(self.bus)
        self.assertEqual(self.store.get_open("r1", "recorder_off")["acked_by"], "fleet")

    def test_duplicate_bumps_counter_and_replay_of_same_row_is_idempotent(self):
        self.r.on_row(self.bus, row(100)); self.r.on_row(self.bus, row(100))
        self.assertEqual(self.store.get_open("r1", "recorder_off")["suppressed_count"], 0)
        self.r.on_row(self.bus, row(101)); self.r.on_row(self.bus, row(102))
        c = self.store.get_open("r1", "recorder_off")
        self.assertEqual((c["first_id"], c["suppressed_count"], c["page_count"]), (100, 2, 1))

    def test_recovery_closes_once_and_late_duplicate_opens_new_case(self):
        self.r.on_row(self.bus, row(100)); self.clock.adv(900)
        self.r.on_row(self.bus, row(110, "recovered"))
        self.assertIsNone(self.store.get_open("r1", "recorder_off"))
        closes = [m for m in self.bus.thread_messages("room-alert-100") if "CLOSED" in m["subject"]]
        self.assertEqual(len(closes), 1)
        self.clock.adv(600); self.r.tick(self.bus)
        self.assertEqual(len(self.bus.pages("room-alert-100")), 1)          # no re-page after close
        self.r.on_row(self.bus, row(105))                                    # late duplicate of the closed alert
        self.assertEqual(self.store.get_open("r1", "recorder_off")["first_id"], 105)
        self.assertEqual(len(self.bus.pages("room-alert-105")), 1)

    def test_crash_between_post_and_state_write_no_duplicate_no_loss(self):
        store = FlakyStore(); bus = FakeBus(); r = ar.Router(store, lambda: bus, self.clock)
        store.insert({"first_id": 100, "room_id": "r1", "kind": "recorder_off", "opened_at": self.clock(), "last_paged_at": None, "page_count": 0,
                      "suppressed_count": 0, "acked_by": None, "acked_at": None, "closed_at": None, "close_reason": None})
        store.armed = True
        with self.assertRaises(RuntimeError):
            r.tick(bus)
        self.assertEqual(len(bus.pages()), 1)                                # posted, state not written
        self.assertEqual(store.get_open("r1", "recorder_off")["page_count"], 0)
        r2 = ar.Router(store, lambda: bus, self.clock)                       # restart
        r2.tick(bus)
        self.assertEqual(len(bus.pages()), 1)                                # still one page on the bus
        self.assertEqual(store.get_open("r1", "recorder_off")["page_count"], 1)   # state caught up: alert not lost
        self.clock.adv(600); r2.tick(bus)
        self.assertEqual(len(bus.pages()), 2)                                # next page is page 2

    def test_pane_restart_late_ack_after_40_min(self):
        self.r.on_row(self.bus, row(100, "mic_denied"))
        for _ in range(4):
            self.clock.adv(600); self.r.tick(self.bus)                       # nobody answers for 40 min
        self.assertEqual(len(self.bus.pages()), 5)
        r2 = ar.Router(self.store, lambda: self.bus, self.clock)             # router process restarts too
        self.bus.human("fleet", "ACK room-alert-100", "room-alert-100")      # a pane comes up and acks
        r2.tick(self.bus); self.clock.adv(1200); r2.tick(self.bus)
        self.assertEqual(len(self.bus.pages()), 5)
        self.assertEqual(self.store.get_open("r1", "mic_denied")["acked_by"], "fleet")

    def test_v_rule_patient_impacting_clinic_30_min_once_and_reminder_at_60(self):
        self.r.on_row(self.bus, row(100, "recorder_off")); self.r.on_row(self.bus, row(200, "mic_denied", "r2"))
        for _ in range(3):
            self.clock.adv(600); self.r.tick(self.bus)                       # 30 min
        v = [m for m in self.bus.msgs if m["subject"].startswith("ROOM ALERT V")]
        self.assertEqual(len(v), 1); self.assertEqual(v[0]["thread"], "room-alert-100")      # mic_denied is not V
        for _ in range(3):
            self.clock.adv(600); self.r.tick(self.bus)                       # 60 min
        v = [m for m in self.bus.msgs if m["subject"].startswith("ROOM ALERT V") and m["thread"] == "room-alert-100"]
        self.assertEqual(len(v), 2)
        for _ in range(3):
            self.clock.adv(600); self.r.tick(self.bus)
        self.assertEqual(len([m for m in self.bus.msgs if m["subject"].startswith("ROOM ALERT V") and m["thread"] == "room-alert-100"]), 2)

    def test_v_for_acked_but_unrecovered_and_never_outside_clinic(self):
        self.r.on_row(self.bus, row(100, "no_machine"))
        self.bus.human("gating-lead", "ACK room-alert-100", "room-alert-100")
        self.clock.adv(1860); self.r.tick(self.bus)
        self.assertEqual(len([m for m in self.bus.msgs if m["subject"].startswith("ROOM ALERT V")]), 1)
        bus2, store2 = FakeBus(), ar.SqliteStore(); c2 = Clock(SUN_12); r2 = ar.Router(store2, lambda: bus2, c2)
        r2.on_row(bus2, row(300, "recorder_off")); c2.adv(7200); r2.tick(bus2)
        self.assertEqual(len([m for m in bus2.msgs if "ROOM ALERT V" in m["subject"]]), 0)

    def test_end_of_day_unacked_list_once_per_day(self):
        self.clock.t = ist(2026, 10, 13, 20, 50)
        self.r.on_row(self.bus, row(100)); self.r.on_row(self.bus, row(200, "offline", "r2"))
        self.bus.human("fleet", "ACK room-alert-200", "room-alert-200")
        self.clock.t = ist(2026, 10, 13, 21, 1); self.r.tick(self.bus); self.r.tick(self.bus)
        d = [m for m in self.bus.msgs if m["thread"].startswith("room-alert-digest")]
        self.assertEqual(len(d), 1); self.assertIn("room-alert-100", d[0]["body"]); self.assertNotIn("room-alert-200", d[0]["body"])

    def test_local_state_survives_restart(self):
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "router.json"); r = ar.Router(self.store, lambda: self.bus, self.clock, p)
            self.r = r; r.on_row(self.bus, row(100))
            for _ in range(3): self.clock.adv(600); r.tick(self.bus)
            r2 = ar.Router(self.store, lambda: self.bus, self.clock, p)
            self.clock.adv(60); r2.tick(self.bus)
            self.assertEqual(len([m for m in self.bus.msgs if m["subject"].startswith("ROOM ALERT V")]), 1)


class DurabilityTests(unittest.TestCase):
    def test_restart_durability_wal_file_store(self):
        with tempfile.TemporaryDirectory() as t:
            path = os.path.join(t, "data", "cases.sqlite"); clock, bus = Clock(TUE_11), FakeBus()
            st = ar.SqliteStore(path)
            self.assertEqual(st.db.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
            r = ar.Router(st, lambda: bus, clock); r.on_row(bus, row(100)); r.on_row(bus, row(101))
            clock.adv(600); r.tick(bus)                                       # page 2
            bus.human("gating-lead", "ACK room-alert-100", "room-alert-100"); r.tick(bus)
            r.on_row(bus, row(300, "offline", "r2"))
            st.db.close(); del r, st                                          # process dies
            st2 = ar.SqliteStore(path); r2 = ar.Router(st2, lambda: bus, clock)
            c = st2.get_open("r1", "recorder_off")
            self.assertEqual((c["first_id"], c["page_count"], c["suppressed_count"], c["acked_by"]), (100, 2, 1, "gating-lead"))
            n = len(bus.pages()); r2.tick(bus); self.assertEqual(len(bus.pages()), n)       # no early re-page after restart
            clock.adv(600); r2.tick(bus)
            self.assertEqual([m["thread"] for m in bus.pages()][n:], ["room-alert-300"])    # acked 100 stays quiet; unacked 300 pages
            r2.on_row(bus, row(400, "recovered"))
            self.assertIsNone(st2.get_open("r1", "recorder_off")); self.assertIsNotNone(st2.get_open("r2", "offline"))

    def test_backup_keeps_14_and_is_readable(self):
        with tempfile.TemporaryDirectory() as t:
            st = ar.SqliteStore(os.path.join(t, "cases.sqlite")); r = ar.Router(st, lambda: FakeBus(), Clock(TUE_11)); r.on_row(FakeBus(), row(100))
            for i in range(16):
                last = st.backup_to(os.path.join(t, "backup"), keep=14, stamp=f"202610{i + 1:02d}-020000")
            files = sorted(os.listdir(os.path.join(t, "backup")))
            self.assertEqual((len(files), files[0]), (14, "cases-20261003-020000.sqlite"))
            self.assertEqual(ar.SqliteStore(last).get_open("r1", "recorder_off")["first_id"], 100)

    def test_local_ids_stay_above_server_ids(self):
        st = ar.SqliteStore(); self.assertEqual(st.next_local_id(), 1_000_000_000_001)
        st.insert({"first_id": 1_000_000_000_005, "room_id": "r", "kind": "k", "opened_at": 1, "last_paged_at": None, "page_count": 0, "suppressed_count": 0,
                   "acked_by": None, "acked_at": None, "closed_at": None, "close_reason": None})
        self.assertEqual(st.next_local_id(), 1_000_000_000_006)


class EndToEndQuietTests(unittest.TestCase):
    def test_quiet_to_page_to_ack_to_close(self):
        with tempfile.TemporaryDirectory() as t:
            clock, bus = Clock(TUE_11), FakeBus()
            router = ar.Router(ar.SqliteStore(os.path.join(t, "cases.sqlite")), lambda: bus, clock)
            subr = sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sb.RouterSink(router, lambda: bus), clock)
            subr.on_line("kiosk/r1/health", "{}")
            clock.adv(121); self.assertEqual(subr.check_quiet(), ["r1"])
            c = router.store.get_open("r1", "guardian_quiet"); tid = f"room-alert-{c['first_id']}"
            self.assertGreaterEqual(c["first_id"], 1_000_000_000_001)
            pages = bus.pages(tid); self.assertEqual(len(pages), 1)
            self.assertIn("source=mini", pages[0]["body"]); self.assertIn("guardian_quiet", pages[0]["subject"])
            clock.adv(600); subr.check_quiet(); router.tick(bus)                       # still quiet: one case, re-paged, no second case
            self.assertEqual(len(bus.pages(tid)), 2); self.assertEqual(len(router.store.list_open()), 1)
            bus.human("fleet", f"ACK {tid}", tid); clock.adv(600); router.tick(bus)
            self.assertEqual(len(bus.pages(tid)), 2); self.assertEqual(router.store.get_open("r1", "guardian_quiet")["acked_by"], "fleet")
            clock.adv(30); subr.on_line("kiosk/r1/health", "{}")                       # stream returns: closes
            self.assertIsNone(router.store.get_open("r1", "guardian_quiet"))
            self.assertEqual(len([m for m in bus.thread_messages(tid) if "CLOSED" in m["subject"]]), 1)
            clock.adv(121); self.assertEqual(subr.check_quiet(), ["r1"])               # a later quiet spell is a NEW case
            self.assertNotEqual(router.store.get_open("r1", "guardian_quiet")["first_id"], c["first_id"])
            self.assertEqual(len([m for m in bus.msgs if m["thread"].startswith("room-alert-") and "outbox" in m["body"]]), 0)

    def test_heal_escalated_through_same_path(self):
        with tempfile.TemporaryDirectory() as t:
            clock, bus = Clock(TUE_11), FakeBus()
            router = ar.Router(ar.SqliteStore(), lambda: bus, clock)
            subr = sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sb.RouterSink(router, lambda: bus), clock)
            subr.on_line("kiosk/r1/heal", '{"result":"escalated"}'); subr.on_line("kiosk/r1/heal", '{"result":"escalated"}')
            c = router.store.get_open("r1", "heal_escalated"); self.assertEqual(c["suppressed_count"], 1)
            subr.on_line("kiosk/r1/heal", '{"result":"ok"}'); self.assertIsNone(router.store.get_open("r1", "heal_escalated"))


class KitLateSetTests(unittest.TestCase):
    """The refuter's probes THROUGH the real kit Relay: a door with the server's semantics (new = id > cursor, late = id <= cursor created recently)."""
    KIT = os.path.expanduser("~/dev/eta-lab/kit/room-alert-relay.py")

    def setUp(self):
        if not os.path.exists(self.KIT):
            self.skipTest("kit relay not on this machine")
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "router"))
        import router_relay as rr
        self.rr, self.kit = rr, rr.load_kit(self.KIT)
        self.clock, self.rows, self.bus = Clock(TUE_11), [], FakeBus()
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)

    def stdio(self):
        bus = self.bus
        class S:
            def thread_exists(s, tid): return any(m["thread"] == tid for m in bus.msgs if "[page" not in m["subject"] and "CLOSED" not in m["subject"])
            def post(s, to, subject, body, priority, thread_id): bus.post(subject, body, priority, thread_id)
            def _tool(s, name, args): return {"messages": bus.thread_messages(args["thread_id"])}
            def close(s): pass
        return S()

    def door(self, cursor, lookback):
        new = [r for r in self.rows if r["id"] > cursor]
        late = [r for r in self.rows if r["id"] <= cursor and self.clock() - r["_t"] <= 600]
        return {"ok": True, "new": new, "late": late, "heartbeat": {"state": "ok", "age_s": 5}}

    def build(self, store=None):
        self.store = store or ar.SqliteStore(os.path.join(self.tmp.name, "cases.sqlite"))
        self.router = ar.Router(self.store, self.stdio, self.clock)
        self.relay = self.rr.make_relay_class(self.kit)(self.router, self.door, self.stdio, state_dir=self.tmp.name, clock=self.clock)

    def add(self, i, kind, room="r1"):
        self.rows.append({"id": i, "kind": kind, "room_ids": [room], "room_name": room, "subject": "s", "body": "b", "_t": self.clock()})

    def polls(self, n):
        for _ in range(n):
            self.clock.adv(60); self.relay.poll_once()

    def test_replayed_recovery_does_not_close_a_newer_outage(self):
        self.build(); self.add(5, "offline"); self.polls(1); self.add(6, "recovered"); self.polls(1)
        self.assertIsNone(self.store.get_open("r1", "offline"))
        self.add(7, "offline"); self.polls(4)                                   # 6 stays in the late set for these polls
        c = self.store.get_open("r1", "offline")
        self.assertIsNotNone(c); self.assertEqual(c["first_id"], 7)

    def test_replayed_first_row_of_closed_case_does_not_crash_the_poll(self):
        self.build(); self.add(5, "offline"); self.polls(1); self.add(6, "recovered"); self.polls(1)
        before = self.relay.state["cursor"]
        self.polls(3)                                                           # 5 and 6 replay; must not raise or stall tick/last-poll
        lp = open(os.path.join(self.tmp.name, "relay-room-alerts.last-poll")).read()
        self.assertIn("epoch=%d" % int(self.clock()), lp); self.assertEqual(self.relay.state["cursor"], before)
        self.assertIsNone(self.store.get_open("r1", "offline"))

    def test_duplicate_then_three_polls_counts_once(self):
        self.build(); self.add(5, "offline"); self.polls(1); self.add(6, "offline"); self.polls(4)
        self.assertEqual(self.store.get_open("r1", "offline")["suppressed_count"], 1)

    def test_store_error_in_on_row_is_not_fatal_to_the_poll(self):
        class Boom(ar.SqliteStore):
            def insert(self, case): raise RuntimeError("disk full")
        self.build(Boom(os.path.join(self.tmp.name, "b.sqlite"))); self.add(5, "offline"); self.add(6, "degraded", "r2")
        self.polls(1)
        self.assertEqual(self.relay.state["cursor"], 6)
        self.assertIn("status=OK", open(os.path.join(self.tmp.name, "relay-room-alerts.last-poll")).read())
        self.assertTrue(any(m["thread"] == "room-alert-5" for m in self.bus.msgs))       # the plain kit post still went out

    def test_routed_ids_pruned_after_7_days(self):
        self.build(); self.add(5, "offline"); self.polls(1)
        self.assertTrue(self.store.is_routed(5))
        self.clock.adv(7 * 86400 + 61); self.relay.poll_once()
        self.assertFalse(self.store.is_routed(5))


class ThresholdAndSourceTests(unittest.TestCase):
    def test_v_threshold_pinned_from_below_at_30_min(self):
        for delta, expect in ((1799, 0), (1800, 1)):
            clock, bus, store = Clock(TUE_11), FakeBus(), ar.SqliteStore()
            r = ar.Router(store, lambda: bus, clock); r.on_row(bus, row(100, "recorder_off"))
            bus.human("gating-lead", "ACK room-alert-100", "room-alert-100")
            clock.adv(delta); r.tick(bus)
            self.assertEqual(len([m for m in bus.msgs if m["subject"].startswith("ROOM ALERT V")]), expect, delta)

    def test_clinic_hours_copy_matches_the_ts_source(self):
        import re
        ts = open(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "lib", "alerts", "clinic-hours.ts")).read()
        def num(name):
            m = re.search(r"export const %s = ([0-9 +*]+);" % name, ts); self.assertIsNotNone(m, name)
            return eval(m.group(1), {"__builtins__": {}})
        days = re.search(r"CLINIC_DAYS: readonly number\[\] = \[([0-9, ]+)\];", ts); self.assertIsNotNone(days)
        self.assertEqual(num("CLINIC_START_MIN"), ar.CLINIC_START_MIN)
        self.assertEqual(num("CLINIC_END_MIN"), ar.CLINIC_END_MIN)
        self.assertEqual(tuple(int(x) for x in days.group(1).split(",")), ar.CLINIC_DAYS)
        self.assertEqual(re.search(r"IST_OFFSET_MS = ([0-9_]+);", ts).group(1).replace("_", ""), str(int(ar.IST.utcoffset(None).total_seconds() * 1000)))


class WatcherTests(unittest.TestCase):
    def test_pages_when_last_poll_older_than_10_min_edge_triggered(self):
        with tempfile.TemporaryDirectory() as t:
            lp, st, posts = os.path.join(t, "lp"), os.path.join(t, "st.json"), []
            post = lambda s, b, p: posts.append((s, p))
            open(lp, "w").write("epoch=1000 iso=x status=OK cursor=1\n")
            self.assertEqual(rw.check(lp, st, post, lambda: 1500), "ok"); self.assertEqual(posts, [])
            self.assertEqual(rw.check(lp, st, post, lambda: 1601), "stale"); self.assertEqual(len(posts), 1)
            rw.check(lp, st, post, lambda: 1700); self.assertEqual(len(posts), 1)            # no repeat
            open(lp, "w").write("epoch=1750 status=OK\n")
            self.assertEqual(rw.check(lp, st, post, lambda: 1760), "ok"); self.assertEqual(len(posts), 2)   # recovery note
            os.remove(lp); rw.check(lp, st, post, lambda: 1800); self.assertEqual(len(posts), 3)             # missing file pages


class KitSubclassTests(unittest.TestCase):
    KIT = os.path.expanduser("~/dev/eta-lab/kit/room-alert-relay.py")

    @unittest.skipUnless(os.path.exists(KIT), "kit relay not on this machine")
    def test_subclass_delivers_then_routes_and_ticks(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "router"))
        import router_relay as rr
        kit = rr.load_kit(self.KIT)
        Cls = rr.make_relay_class(kit)

        class StdioFake:
            def __init__(self): self.sent = []
            def thread_exists(self, tid): return any(m[4] == tid for m in self.sent)
            def post(self, to, subject, body, priority, thread_id): self.sent.append((to, subject, body, priority, thread_id))
            def _tool(self, name, args): return {"messages": [{"from": "x", "subject": m[1], "body": m[2]} for m in self.sent if m[4] == args["thread_id"]]}
            def close(self): pass
        fake, clock = StdioFake(), Clock(TUE_11)
        data = {"ok": True, "new": [{"id": 7, "kind": "recorder_off", "room_ids": ["r1"], "room_name": "R1", "subject": "s", "body": "b"}], "late": [],
                "heartbeat": {"state": "ok", "age_s": 5}}
        with tempfile.TemporaryDirectory() as t:
            router = ar.Router(ar.SqliteStore(), lambda: fake, clock)
            relay = Cls(router, lambda cursor, lb: data, lambda: fake, state_dir=t, clock=clock)
            relay.poll_once()
            self.assertEqual(relay.state["cursor"], 7)
            self.assertEqual(router.store.get_open("r1", "recorder_off")["first_id"], 7)
            self.assertTrue(any("[page 1]" in m[1] for m in fake.sent))


if __name__ == "__main__":
    unittest.main()
