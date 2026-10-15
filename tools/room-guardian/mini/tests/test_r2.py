"""Phase 0 fix round (R2): MF1 case stored before any bus, MF2 one send per tick + failure isolation, SF1 restart survival over a long silence."""
import os, sys, tempfile, unittest
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "router"))
from test_router import ar, sb, FakeBus, Clock, row, TUE_11, ist


def mini(tmp, clock, bus_factory, rooms=("r1",)):
    router = ar.Router(ar.SqliteStore(os.path.join(tmp, "cases.sqlite")), bus_factory, clock)
    return router, sb.Subscriber(os.path.join(tmp, "d"), tmp, list(rooms), sb.RouterSink(router, bus_factory), clock)


class MF1CaseBeforeBus(unittest.TestCase):
    def test_bus_construction_fails_case_is_still_stored_then_paged_later(self):
        def dead_bus():
            raise RuntimeError("ubus shim cannot start")                 # the refuter's offline probe: bus construction fails
        with tempfile.TemporaryDirectory() as t:
            clock = Clock(TUE_11)
            router, subr = mini(t, clock, dead_bus)
            clock.adv(121)
            self.assertEqual(subr.check_quiet(), ["r1"])                 # no exception out of the subscriber
            self.assertEqual(len(router.store.list_open()), 1)           # the case is durable
            self.assertEqual(subr.check_quiet(), [])
            with self.assertRaises(RuntimeError):                        # the failure surfaces where the bus is needed
                router.tick()
            self.assertEqual(router.store.get_open("r1", "guardian_quiet")["page_count"], 0)
            bus = FakeBus(); clock.adv(30); router.bus_factory = lambda: bus
            router.tick(bus); self.assertEqual(len(bus.pages()), 1)       # ubus back: the stored case is paged
            self.assertEqual(router.store.get_open("r1", "guardian_quiet")["page_count"], 1)

    def test_recovery_with_dead_bus_still_closes_and_queues_the_note(self):
        with tempfile.TemporaryDirectory() as t:
            clock = Clock(TUE_11)
            def dead_bus(): raise RuntimeError("down")
            router, subr = mini(t, clock, dead_bus)
            clock.adv(121); subr.check_quiet(); clock.adv(5)
            subr.on_line("kiosk/r1/health", "{}")
            self.assertIsNone(router.store.get_open("r1", "guardian_quiet"))
            self.assertEqual(len(router.store.list_notes()), 1)
            bus = FakeBus(); router.tick(bus)
            self.assertEqual(router.store.list_notes(), [])
            self.assertEqual(len([m for m in bus.msgs if "CLOSED" in m["body"]]), 1)


class MF2Batching(unittest.TestCase):
    def setUp(self):
        self.clock, self.bus, self.store = Clock(TUE_11), FakeBus(), ar.SqliteStore()
        self.r = ar.Router(self.store, lambda: self.bus, self.clock)

    def test_ten_cases_one_send_with_all_markers(self):
        for i in range(10):
            self.r.on_row(self.bus, row(100 + i, "offline", f"r{i}"))
        out = self.r.tick(self.bus)
        self.assertEqual((self.bus.sends, out["paged"], out["errors"]), (1, 10, 0))
        body = self.bus.real[0]["body"]
        for i in range(10):
            self.assertIn(f"room-alert-{100 + i} offline in r{i}", body); self.assertIn("[page 1]", body)
        self.assertTrue(self.bus.real[0]["thread"].startswith(ar.BATCH_PREFIX))
        self.clock.adv(600); self.r.tick(self.bus)
        self.assertEqual(self.bus.sends, 2)                                # re-page of all ten is one more send

    def test_pages_notes_and_v_share_one_send(self):
        self.r.on_row(self.bus, row(100, "recorder_off")); self.r.on_row(self.bus, row(200, "offline", "r2")); self.r.tick(self.bus)
        self.clock.adv(1860)
        self.r.on_row(self.bus, row(300, "recovered", "r2"))
        before = self.bus.sends; self.r.tick(self.bus)
        self.assertEqual(self.bus.sends, before + 1)
        body = self.bus.real[-1]["body"]
        self.assertIn("[page 2]", body); self.assertIn("V: patient-impacting", body); self.assertIn("CLOSED", body)

    def test_failed_send_leaves_state_and_next_tick_delivers_once(self):
        self.r.on_row(self.bus, row(100)); self.r.on_row(self.bus, row(200, "offline", "r2"))
        self.bus.fail = True
        out = self.r.tick(self.bus)
        self.assertEqual(out["errors"], 1); self.assertEqual(out["paged"], 0)
        self.assertEqual([c["page_count"] for c in self.store.list_open()], [0, 0])
        self.bus.fail = False; self.clock.adv(30); out = self.r.tick(self.bus)
        self.assertEqual((out["paged"], self.bus.sends), (2, 1))
        self.clock.adv(30); self.r.tick(self.bus); self.assertEqual(self.bus.sends, 1)      # nothing due: no send

    def test_failed_send_does_not_block_acks_digest_or_prune(self):
        self.clock.t = ist(2026, 10, 13, 20, 50)
        self.r.on_row(self.bus, row(100)); self.r.on_row(self.bus, row(200, "offline", "r2")); self.r.tick(self.bus)
        self.store.mark_routed(1, self.clock() - 9 * 86400)                # old routed id: prune target
        self.bus.human("fleet", "ACK room-alert-200", "room-alert-200")
        self.clock.t = ist(2026, 10, 13, 21, 1)
        real_post = self.bus.post
        def post(subject, body, priority, thread_id):
            if thread_id.startswith(ar.BATCH_PREFIX):
                raise RuntimeError("rate_limited")                         # only the batch send fails
            return real_post(subject, body, priority, thread_id)
        self.bus.post = post
        self.r.on_row(self.bus, row(400, "offline", "r4"))                 # something due, so a batch send is attempted and fails
        out = self.r.tick(self.bus)
        self.assertEqual(out["errors"], 1)
        self.assertEqual(out["acked"], 1)                                  # ack read ran
        self.assertEqual(out["digest"], 0)                                 # SF2: the digest rides in the failed batch, so it stays due
        self.assertFalse(self.store.is_routed(1))                          # prune ran
        self.bus.post = real_post; self.clock.adv(30); out = self.r.tick(self.bus)
        self.assertEqual(out["digest"], 1)                                 # delivered with the next batch

    def test_ack_read_from_the_batch_thread(self):
        self.r.on_row(self.bus, row(100)); self.r.tick(self.bus)
        tid = ar.batch_tid(self.clock())
        self.bus.real.append({"from": "gating-lead", "subject": "ACK room-alert-100", "body": "", "thread": tid})
        self.clock.adv(30); out = self.r.tick(self.bus)
        self.assertEqual(out["acked"], 1)
        self.assertEqual(self.store.get_open("r1", "recorder_off")["acked_by"], "gating-lead")

    def test_crash_after_batch_post_before_state_write_does_not_double_page(self):
        self.r.on_row(self.bus, row(100)); self.r.on_row(self.bus, row(200, "offline", "r2"))
        orig = self.store.update; self.store.update = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("crash"))
        self.r.tick(self.bus); self.store.update = orig                     # posted, state not written
        self.assertEqual(self.bus.sends, 1)
        self.clock.adv(30); r2 = ar.Router(self.store, lambda: self.bus, self.clock); r2.tick(self.bus)
        self.assertEqual(self.bus.sends, 1)                                 # markers found: no second page
        self.assertEqual([c["page_count"] for c in self.store.list_open()], [1, 1])


class R2MF1AckForms(unittest.TestCase):
    """The page tells ackers to reply with one line per case in the batch thread; ubus_reply makes the subject 'Re: <batch subject>'."""
    def setUp(self):
        self.clock, self.bus, self.store = Clock(TUE_11), FakeBus(), ar.SqliteStore()
        self.r = ar.Router(self.store, lambda: self.bus, self.clock)
        for i, room in enumerate(("r1", "r2", "r3")):
            self.r.on_row(self.bus, row(100 + i, "offline", room))
        self.r.tick(self.bus); self.tid = ar.batch_tid(self.clock())

    def acked(self):
        return sorted(c["first_id"] for c in self.store.list_open() if c["acked_at"])

    def say(self, sender, subject, body):
        self.bus.real.append({"from": sender, "subject": subject, "body": body, "thread": self.tid})

    def test_single_id_ack_in_subject_still_works(self):
        self.say("gating-lead", "ACK room-alert-101", ""); self.clock.adv(30)
        self.assertEqual(self.r.tick(self.bus)["acked"], 1); self.assertEqual(self.acked(), [101])

    def test_one_reply_listing_several_ids_acks_all_of_them(self):
        self.say("fleet", "ACK room-alert-100", "ACK room-alert-101\nack room-alert-102\n"); self.clock.adv(30)
        self.assertEqual(self.r.tick(self.bus)["acked"], 3); self.assertEqual(self.acked(), [100, 101, 102])

    def test_ubus_reply_shape_re_subject_and_body_lines_acks_all_listed(self):
        self.say("gating-lead", "Re: ROOM ALERT: 3 page(s), 0 V, 0 note(s)", "ACK room-alert-100\nACK room-alert-102"); self.clock.adv(30)
        self.assertEqual(self.r.tick(self.bus)["acked"], 2); self.assertEqual(self.acked(), [100, 102])

    def test_nested_re_prefix_and_ack_in_subject_after_re(self):
        self.say("fleet", "Re: Re: ACK room-alert-101", ""); self.clock.adv(30)
        self.r.tick(self.bus); self.assertEqual(self.acked(), [101])

    def test_non_ackers_and_the_page_text_itself_ack_nothing(self):
        self.say("someone", "Re: ROOM ALERT", "ACK room-alert-100\nACK room-alert-101")
        self.say("fleet", "ROOM ALERT", "Reply 'ACK room-alert-<id>' (one line per case) in this thread to stop re-pages.\nmaybe ACK room-alert-100 later")
        self.clock.adv(30); self.assertEqual(self.r.tick(self.bus)["acked"], 0); self.assertEqual(self.acked(), [])

    def test_ack_ids_are_exact_not_prefixes(self):
        self.say("fleet", "Re: x", "ACK room-alert-1000"); self.clock.adv(30)
        self.r.tick(self.bus); self.assertEqual(self.acked(), [])


    def test_c1_one_line_list_acks_every_id_on_it(self):
        self.say("gating-lead", "Re: ROOM ALERT: 3 page(s), 0 V, 0 note(s)", "ACK room-alert-100, room-alert-101, room-alert-102"); self.clock.adv(30)
        self.assertEqual(self.r.tick(self.bus)["acked"], 3); self.assertEqual(self.acked(), [100, 101, 102])

    def test_c1_ids_on_a_line_that_does_not_start_with_ack_are_ignored(self):
        self.say("fleet", "Re: x", "please do not ack room-alert-100, room-alert-101\nthanks room-alert-102"); self.clock.adv(30)
        self.assertEqual(self.r.tick(self.bus)["acked"], 0)


class C2AckersSubsetOfRecipients(unittest.TestCase):
    def cfg(self, to, ackers):
        import json, ubus_bus
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "router.json")
            json.dump({"to": to, "ackers": ackers, "subject_prefix": "", "wake": True}, open(p, "w"))
            return ubus_bus.load_cfg(p)

    def test_production_shape_loads(self):
        self.assertEqual(self.cfg(["gating-lead", "fleet"], ["gating-lead", "fleet"])["ackers"], ["gating-lead", "fleet"])

    def test_acker_subset_of_to_loads(self):
        self.cfg(["gating-lead", "fleet"], ["fleet"])

    def test_acker_not_in_to_is_refused(self):
        with self.assertRaises(ValueError) as cm:
            self.cfg(["herdr-lead"], ["herdr-lead", "pico-p0-build"])
        self.assertIn("pico-p0-build", str(cm.exception))


class SF1RestartSurvivesLongSilence(unittest.TestCase):
    def test_silence_longer_than_two_windows_after_restart_keeps_one_case(self):
        with tempfile.TemporaryDirectory() as t:
            clock, bus = Clock(TUE_11), FakeBus()
            router, subr = mini(t, clock, lambda: bus)
            clock.adv(121); subr.check_quiet(); router.tick(bus)
            router2, _ = mini(t, clock, lambda: bus)                         # process restart: same SQLite file
            sink2 = sb.RouterSink(router2, lambda: bus)
            sub2 = sb.Subscriber(os.path.join(t, "d"), t, ["r1"], sink2, clock, quiet_seed=sink2.open_quiet_rooms())
            for _ in range(10):                                              # 300 s of silence after the restart (> 2 x 120 s)
                clock.adv(30); self.assertEqual(sub2.check_quiet(), [])
            self.assertEqual(len(router2.store.list_open()), 1)
            self.assertEqual(router2.store.get_open("r1", "guardian_quiet")["page_count"], 1)
            sub2.on_line("kiosk/r1/health", "{}"); self.assertEqual(router2.store.list_open(), [])


def ist_s(y, mo, d, h, mi=0, sec=0):
    return datetime(y, mo, d, h, mi, sec, tzinfo=ar.IST).timestamp()


class SF1Midnight(unittest.TestCase):
    def test_page_posted_before_ist_midnight_is_not_repeated_after_a_crash(self):
        clock, bus, store = Clock(ist_s(2026, 10, 13, 23, 59, 40)), FakeBus(), ar.SqliteStore()
        r = ar.Router(store, lambda: bus, clock)
        r.on_row(bus, row(100)); r.on_row(bus, row(200, "offline", "r2"))
        orig = store.update; store.update = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("crash"))
        r.tick(bus); store.update = orig                                    # posted on the 13 Oct thread, state not written
        self.assertEqual(bus.sends, 1)
        clock.adv(40)                                                       # 00:00:20 on 14 Oct: today's thread is empty
        self.assertNotEqual(ar.batch_tid(clock()), bus.real[0]["thread"])
        ar.Router(store, lambda: bus, clock).tick(bus)
        self.assertEqual(bus.sends, 1)                                      # yesterday's marker found: no second page
        self.assertEqual([c["page_count"] for c in store.list_open()], [1, 1])

    def test_a_marker_two_days_old_does_not_suppress(self):
        clock, bus, store = Clock(ist_s(2026, 10, 13, 12)), FakeBus(), ar.SqliteStore()
        r = ar.Router(store, lambda: bus, clock); r.on_row(bus, row(100))
        orig = store.update; store.update = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("crash"))
        r.tick(bus); store.update = orig
        clock.adv(2 * 86400); ar.Router(store, lambda: bus, clock).tick(bus)
        self.assertEqual(bus.sends, 2)                                      # old marker is out of the window: a real re-page


class SF2DigestInBatch(unittest.TestCase):
    def setUp(self):
        self.clock, self.bus, self.store = Clock(ist_s(2026, 10, 13, 20, 50)), FakeBus(), ar.SqliteStore()
        self.r = ar.Router(self.store, lambda: self.bus, self.clock)

    def test_digest_and_due_page_are_one_send_on_the_day_thread(self):
        self.r.on_row(self.bus, row(100)); self.r.tick(self.bus)
        self.r.on_row(self.bus, row(200, "offline", "r2"))
        self.clock.t = ist_s(2026, 10, 13, 21, 1); before = self.bus.sends
        out = self.r.tick(self.bus)
        self.assertEqual((self.bus.sends - before, out["digest"], out["paged"]), (1, 1, 2))
        m = self.bus.real[-1]
        self.assertEqual(m["thread"], ar.batch_tid(self.clock())); self.assertIn("21:00 list", m["subject"])
        self.assertIn("ROOM ALERTS unacked at 21:00: 2", m["body"]); self.assertIn("[page 1]", m["body"])
        self.assertEqual([x for x in self.bus.msgs if x["thread"].startswith("room-alert-digest")], [])

    def test_digest_alone_is_one_send_once_per_day(self):
        self.r.on_row(self.bus, row(100)); self.r.tick(self.bus)
        self.clock.t = ist_s(2026, 10, 13, 21, 1); out = self.r.tick(self.bus)
        self.assertEqual((out["digest"], self.bus.sends), (1, 2))
        for _ in range(3): self.clock.adv(30); self.assertEqual(self.r.tick(self.bus)["digest"], 0)
        self.assertEqual(self.bus.sends, 2)
        self.clock.t = ist_s(2026, 10, 14, 21, 2); self.assertEqual(self.r.tick(self.bus)["digest"], 1)   # next day: again

    def test_failed_send_keeps_the_digest_due(self):
        self.r.on_row(self.bus, row(100)); self.r.tick(self.bus)
        self.clock.t = ist_s(2026, 10, 13, 21, 1); self.bus.fail = True
        out = self.r.tick(self.bus); self.assertEqual((out["digest"], out["errors"]), (0, 1))
        self.bus.fail = False; self.clock.adv(30); self.assertEqual(self.r.tick(self.bus)["digest"], 1)

    def test_digest_state_survives_restart(self):
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "local.json"); r = ar.Router(self.store, lambda: self.bus, self.clock, p)
            r.on_row(self.bus, row(100)); r.tick(self.bus)
            self.clock.t = ist_s(2026, 10, 13, 21, 1); r.tick(self.bus); n = self.bus.sends
            ar.Router(self.store, lambda: self.bus, self.clock, p).tick(self.bus); self.assertEqual(self.bus.sends, n)

    def test_long_list_is_capped_and_still_fits(self):
        self.clock.t = ist_s(2026, 10, 13, 20, 58)                          # paged just before 21:00: nothing re-pages at 21:01
        for i in range(60): self.r.on_row(self.bus, row(1000 + i, "offline", f"room-{i}"))
        self.r.tick(self.bus)
        self.clock.t = ist_s(2026, 10, 13, 21, 1); self.r.tick(self.bus)
        d = [m for m in self.bus.real if "unacked at 21:00" in m["body"]]
        self.assertEqual(len(d), 1); self.assertIn("ROOM ALERTS unacked at 21:00: 60", d[0]["body"]); self.assertIn("and 30 more", d[0]["body"])
        self.assertLessEqual(len(d[0]["body"]), ar.BODY_CAP)

    def test_digest_that_does_not_fit_stays_due(self):
        self.r.on_row(self.bus, row(100)); self.r.tick(self.bus)
        self.r.size_line_fn = None
        for i in range(60): self.r.on_row(self.bus, row(2000 + i, "offline", f"room-{i}"))
        self.clock.t = ist_s(2026, 10, 13, 21, 1)
        out = self.r.tick(self.bus)                                         # 60 fresh pages fill the body: the block waits
        self.assertEqual(out["digest"], 0); self.assertEqual(self.r.local["digest_day"], "")
        self.clock.adv(30); self.assertEqual(self.r.tick(self.bus)["digest"], 1)


class SF4SizeLine(unittest.TestCase):
    def mk(self, fn, t=None):
        self.clock, self.bus, self.store = Clock(t or ist_s(2026, 10, 13, 21, 1)), FakeBus(), ar.SqliteStore()
        self.r = ar.Router(self.store, lambda: self.bus, self.clock, size_line_fn=fn)

    def test_size_line_once_per_calendar_month_even_with_nothing_unacked(self):
        self.mk(lambda: "backup/_to_delete: 3 file(s), 1.0 MB. Reviewer: fleet / herdr-lead.")
        self.assertEqual(self.r.tick(self.bus)["digest"], 1)
        self.assertIn("backup/_to_delete: 3 file(s)", self.bus.real[-1]["body"]); self.assertNotIn("unacked", self.bus.real[-1]["body"])
        self.clock.t = ist_s(2026, 10, 14, 21, 1); self.assertEqual(self.r.tick(self.bus)["digest"], 0)    # same month: no line, nothing unacked
        self.clock.t = ist_s(2026, 11, 1, 21, 1); self.assertEqual(self.r.tick(self.bus)["digest"], 1)      # new month: again

    def test_size_line_rides_with_the_unacked_list(self):
        self.mk(lambda: "SIZE-LINE"); self.r.on_row(self.bus, row(100)); self.r.tick(self.bus)
        self.assertEqual(self.bus.sends, 1)
        self.assertIn("unacked at 21:00: 1", self.bus.real[-1]["body"]); self.assertIn("SIZE-LINE", self.bus.real[-1]["body"])

    def test_size_line_is_not_marked_sent_when_the_send_fails(self):
        self.mk(lambda: "SIZE-LINE"); self.bus.fail = True
        self.assertEqual(self.r.tick(self.bus)["digest"], 0); self.bus.fail = False; self.clock.adv(30)
        self.assertEqual(self.r.tick(self.bus)["digest"], 1)

    def test_a_failing_size_function_never_blocks_the_list(self):
        def boom(): raise OSError("disk")
        self.mk(boom); self.r.on_row(self.bus, row(100)); self.r.tick(self.bus)
        self.assertIn("unacked at 21:00: 1", self.bus.real[-1]["body"])
        self.assertEqual(self.r.local["size_month"], "")

    def test_no_size_function_no_line_nothing_unacked_no_send(self):
        self.mk(None); self.assertEqual(self.r.tick(self.bus)["digest"], 0); self.assertEqual(self.bus.sends, 0)

    def test_folder_size_line(self):
        with tempfile.TemporaryDirectory() as t:
            d = os.path.join(t, "_to_delete"); self.assertIsNone(ar.folder_size_line(d))
            os.makedirs(d); open(os.path.join(d, "a"), "wb").write(b"x" * 1048576); open(os.path.join(d, "b"), "wb").write(b"")
            line = ar.folder_size_line(d)
            self.assertIn("backup/_to_delete: 2 file(s), 1.0 MB", line); self.assertIn("fleet / herdr-lead", line)


def _pgdump_script():
    here = os.path.dirname(os.path.abspath(__file__))
    for rel in ("../ops/pgdump.sh", "../../scripts/pgdump.sh"):
        p = os.path.join(here, rel)
        if os.path.exists(p):
            return os.path.dirname(p)
    return None


class FUDigestPagesCount(unittest.TestCase):
    def test_pages_in_the_digest_is_not_one_behind_when_the_same_batch_pages_the_case(self):
        clock, bus, store = Clock(ist_s(2026, 10, 13, 20, 50)), FakeBus(), ar.SqliteStore()
        r = ar.Router(store, lambda: bus, clock); r.on_row(bus, row(100)); r.tick(bus)                     # page 1 at 20:50
        clock.t = ist_s(2026, 10, 13, 21, 1); r.on_row(bus, row(200, "offline", "r2"))                      # 100 is due again (page 2); 200 is new (page 1)
        r.tick(bus); body = bus.real[-1]["body"]
        self.assertIn("room-alert-100 recorder_off in r1.", body); self.assertIn("[page 2]", body)
        self.assertIn("room-alert-100 recorder_off r1 open 11 min, pages 2", body)
        self.assertIn("room-alert-200 offline r2 open 0 min, pages 1", body)

    def test_digest_alone_shows_the_stored_count(self):
        clock, bus, store = Clock(ist_s(2026, 10, 13, 20, 58)), FakeBus(), ar.SqliteStore()
        r = ar.Router(store, lambda: bus, clock); r.on_row(bus, row(100)); r.tick(bus)
        clock.t = ist_s(2026, 10, 13, 21, 1); r.tick(bus)
        self.assertIn("pages 1", bus.real[-1]["body"]); self.assertNotIn("[page 2]", bus.real[-1]["body"])

    def test_a_page_found_already_posted_counts_too(self):
        clock, bus, store = Clock(ist_s(2026, 10, 13, 20, 58)), FakeBus(), ar.SqliteStore()
        r = ar.Router(store, lambda: bus, clock); r.on_row(bus, row(100))
        orig = store.update; store.update = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("crash"))
        r.tick(bus); store.update = orig                                    # posted page 1 but the state write was lost (page_count still 0)
        clock.t = ist_s(2026, 10, 13, 21, 1); ar.Router(store, lambda: bus, clock).tick(bus)
        self.assertIn("pages 1", bus.real[-1]["body"])                      # marker found: counted as page 1, not "pages 0"


class FUSizeLines(unittest.TestCase):
    def test_three_folders_and_a_list_from_the_size_function(self):
        with tempfile.TemporaryDirectory() as t:
            for sub, n in (("backup", 1), ("data", 2)):
                os.makedirs(os.path.join(t, sub, "_to_delete"))
                for i in range(n): open(os.path.join(t, sub, "_to_delete", f"f{i}"), "wb").write(b"x")
            lines = ar.guardian_size_lines(t)                                # logs/_to_delete is absent: left out
            self.assertEqual([l.split(":")[0] for l in lines], ["backup/_to_delete", "data/_to_delete"]); self.assertIn("2 file(s)", lines[1])
            os.makedirs(os.path.join(t, "logs", "_to_delete")); self.assertEqual(len(ar.guardian_size_lines(t)), 3)
            clock, bus = Clock(ist_s(2026, 10, 13, 21, 1)), FakeBus()
            r = ar.Router(ar.SqliteStore(), lambda: bus, clock, size_line_fn=lambda: ar.guardian_size_lines(t))
            self.assertEqual(r.tick(bus)["digest"], 1)
            body = bus.real[-1]["body"]
            for label in ("backup/_to_delete", "data/_to_delete", "logs/_to_delete"): self.assertIn(label + ":", body)
            self.assertEqual(r.local["size_month"], "2026-10")

    def test_a_string_from_the_size_function_still_works(self):
        clock, bus = Clock(ist_s(2026, 10, 13, 21, 1)), FakeBus()
        r = ar.Router(ar.SqliteStore(), lambda: bus, clock, size_line_fn=lambda: "ONE-LINE"); r.tick(bus)
        self.assertIn("ONE-LINE", bus.real[-1]["body"])


class FUBackupRotationNeverDeletes(unittest.TestCase):
    def test_a_name_clash_in_to_delete_gets_a_suffix_and_nothing_is_removed(self):
        with tempfile.TemporaryDirectory() as t:
            st = ar.SqliteStore(os.path.join(t, "cases.sqlite")); dest = os.path.join(t, "backup")
            os.makedirs(os.path.join(dest, "_to_delete")); open(os.path.join(dest, "_to_delete", "cases-20261001-020000.sqlite"), "w").write("older")
            for i in range(16): st.backup_to(dest, keep=14, stamp=f"202610{i + 1:02d}-020000")
            moved = sorted(os.listdir(os.path.join(dest, "_to_delete")))
            self.assertEqual(moved, ["cases-20261001-020000.sqlite", "cases-20261001-020000.sqlite.1", "cases-20261002-020000.sqlite"])
            self.assertEqual(open(os.path.join(dest, "_to_delete", "cases-20261001-020000.sqlite")).read(), "older")     # the clash did not overwrite it

    def test_no_file_delete_calls_in_the_router_tools(self):
        import re
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
        for sub in ("router", "subscriber"):
            d = os.path.join(here, sub)
            if not os.path.isdir(d): continue
            for f in os.listdir(d):
                if f.endswith(".py"):
                    src = open(os.path.join(d, f)).read()
                    self.assertIsNone(re.search(r"os\.remove\(|os\.unlink\(|shutil\.rmtree\(|\.unlink\(", src), f)


@unittest.skipUnless(_pgdump_script() and os.path.exists("/opt/homebrew/bin/python3"), "pgdump.sh or the Mini python is not here")
class SF3PgdumpSignals(unittest.TestCase):
    """pgdump.sh against a temp GUARDIAN_HOME and a fake pg_dump / pg_restore (PG_BIN). Never touches the real database."""
    def setUp(self):
        import shutil, stat
        self.tmp = tempfile.TemporaryDirectory(); gh = self.gh = self.tmp.name
        src = _pgdump_script(); here = os.path.dirname(os.path.abspath(__file__))
        os.makedirs(os.path.join(gh, "scripts")); os.makedirs(os.path.join(gh, "etc")); os.makedirs(os.path.join(gh, "data"))
        shutil.copy(os.path.join(src, "pgdump.sh"), os.path.join(gh, "scripts", "pgdump.sh"))
        shutil.copy(os.path.join(src, "backup-case.py"), os.path.join(gh, "scripts", "backup-case.py"))
        shutil.copytree(os.path.join(here, "..", "router"), os.path.join(gh, "app", "router"), ignore=shutil.ignore_patterns("__pycache__"))
        open(os.path.join(gh, "etc", "pg.env"), "w").close()
        self.bin = os.path.join(gh, "fakebin"); os.makedirs(self.bin)
        with open(os.path.join(self.bin, "pg_dump"), "w") as f:
            f.write('#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = -f ] && out="$2"; shift; done\necho partial > "$out"\nsleep "${FAKE_PGDUMP_SLEEP:-0}"\n')
        with open(os.path.join(self.bin, "pg_restore"), "w") as f:
            f.write("#!/bin/sh\nexit 0\n")
        for n in ("pg_dump", "pg_restore"):
            os.chmod(os.path.join(self.bin, n), 0o755)
        self.env = dict(os.environ, GUARDIAN_HOME=gh, PG_BIN=self.bin)

    def tearDown(self): self.tmp.cleanup()

    def files(self, sub=""):
        return sorted(os.listdir(os.path.join(self.gh, "backup", sub) if sub else os.path.join(self.gh, "backup")))

    def start(self, sleep):
        import subprocess
        return subprocess.Popen(["/bin/bash", os.path.join(self.gh, "scripts", "pgdump.sh")], env=dict(self.env, FAKE_PGDUMP_SLEEP=str(sleep)),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)

    def wait_part(self):
        import time
        for _ in range(100):
            if os.path.isdir(os.path.join(self.gh, "backup")) and any(f.endswith(".part") for f in self.files()): return
            time.sleep(0.1)
        self.fail("pg_dump never started")

    def case_open(self):
        st = ar.SqliteStore(os.path.join(self.gh, "data", "cases.sqlite")); return [c["kind"] for c in st.list_open()]

    def test_success_leaves_one_dump_and_no_part(self):
        p = self.start(0); p.communicate(timeout=30)
        self.assertEqual(p.returncode, 0)
        f = self.files(); self.assertEqual([x for x in f if x.endswith(".part")], []); self.assertEqual(len([x for x in f if x.startswith("pipe-")]), 1)

    def test_term_to_the_script_leaves_no_part_and_opens_the_case(self):
        import signal
        p = self.start(3); self.wait_part(); p.send_signal(signal.SIGTERM)       # to bash only: the trap runs when the child ends
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 143)
        self.assertEqual([x for x in self.files() if x.endswith(".part")], [])
        self.assertEqual([x for x in self.files() if x.startswith("pipe-")], [])
        self.assertTrue(any(x.endswith(".bad") for x in self.files("_to_delete")))
        self.assertEqual(self.case_open(), ["backup_failed"])

    def test_int_to_the_script_leaves_no_part(self):
        import signal
        p = self.start(3); self.wait_part(); p.send_signal(signal.SIGINT); p.communicate(timeout=30)
        self.assertEqual(p.returncode, 130); self.assertEqual([x for x in self.files() if x.endswith(".part")], [])

    def test_repeated_term_during_the_clean_up_still_finishes_it(self):
        import signal, time
        bc = os.path.join(self.gh, "scripts", "backup-case.py")
        orig = open(bc).read()
        open(bc, "w").write("import time; time.sleep(1.5)\n" + orig)                    # a slow case-open step: the clean-up takes > 1.5 s, so there is a window to hit
        p = self.start(1); self.wait_part(); p.send_signal(signal.SIGTERM)
        for _ in range(200):                                                          # wait until the clean-up has begun (the .part was moved aside)
            if any(x.endswith(".bad") for x in self.files("_to_delete")) or p.poll() is not None: break
            time.sleep(0.05)
        for _ in range(4):
            if p.poll() is None: p.send_signal(signal.SIGTERM); time.sleep(0.1)       # more TERMs land in the clean-up
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 143)                                          # not -15: the clean-up was not killed halfway
        self.assertEqual([x for x in self.files() if x.endswith(".part")], [])
        self.assertTrue(any(x.endswith(".bad") for x in self.files("_to_delete"))); self.assertEqual(self.case_open(), ["backup_failed"])

    def test_term_to_the_whole_process_group_leaves_no_part(self):
        import signal
        p = self.start(30); self.wait_part(); os.killpg(p.pid, signal.SIGTERM); p.communicate(timeout=30)   # what launchd does on unload
        self.assertIn(p.returncode, (1, 143))
        self.assertEqual([x for x in self.files() if x.endswith(".part")], [])
        self.assertEqual([x for x in self.files() if x.startswith("pipe-")], [])


def _deploy_script():
    here = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(here, "..", "ops", "deploy.sh")
    return p if os.path.exists(p) else None


@unittest.skipUnless(_deploy_script() and os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ops", "check-deployed.sh")), "ops/deploy.sh is not in this layout")
class FUDeployStep(unittest.TestCase):
    def run_deploy(self, gh):
        import subprocess
        return subprocess.run(["/bin/bash", _deploy_script()], env=dict(os.environ, GUARDIAN_HOME=gh), capture_output=True, text=True, timeout=60)

    def test_deploy_copies_writes_source_sha_and_the_result_matches_check_deployed(self):
        import re
        with tempfile.TemporaryDirectory() as gh:
            r = self.run_deploy(gh)
            self.assertEqual(r.returncode, 0, r.stderr); self.assertIn("deployed copy matches", r.stdout); self.assertIn("no job restarted", r.stdout)
            sha = open(os.path.join(gh, "app", "SOURCE-SHA")).read()
            self.assertRegex(sha, r"^([0-9a-f]{12}(\+dirty)?|unknown) tools/room-guardian/mini\n$")
            r2 = self.run_deploy(gh); self.assertIn("0 file(s) updated", r2.stdout)          # second run changes nothing
            live = os.path.join(gh, "app", "router", "alert_router.py"); open(live, "a").write("# drift\n")
            r3 = self.run_deploy(gh); self.assertIn("1 file(s) updated", r3.stdout)
            bk = [d for d in os.listdir(os.path.join(gh, "backup-src")) if d.startswith("deploy-")]
            self.assertEqual(len(bk), 1); self.assertTrue(open(os.path.join(gh, "backup-src", bk[0], "app", "router", "alert_router.py")).read().endswith("# drift\n"))   # replaced file was kept
            self.assertNotIn("# drift", open(live).read())

    def test_deploy_restarts_nothing(self):
        src = open(_deploy_script()).read()
        self.assertNotIn("launchctl", src.replace("# It restarts NOTHING", "").split("set -euo")[1])


if __name__ == "__main__":
    unittest.main()
