"""Phase 0 fix round (R2): MF1 case stored before any bus, MF2 one send per tick + failure isolation, SF1 restart survival over a long silence."""
import os, sys, tempfile, unittest
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
        self.assertEqual(out["digest"], 1)                                 # digest went out despite the failed batch
        self.assertFalse(self.store.is_routed(1))                          # prune ran

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


if __name__ == "__main__":
    unittest.main()
