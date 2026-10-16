"""FR1 2.4 d' Round 8 (R7 delta refute, 1 MUST): the stuck-source case is opened and closed on the LOOP thread (the case store is a sqlite3 connection that raises from any other
thread); no store or sink call runs off the loop thread; S1 pins; the start_day worker idle-exit race; the 90 s snapshot limit; usb_device_missing closes on an ACK."""
import json, os, sys, tempfile, threading, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
import consult_hold as ch
import start_day as sd
import usb_verify as uv
from test_router import ar, FakeBus
from test_subscriber import CAEnv, Clock, T0
from test_dprime import Src, Sink, MAP, ROOMS, QUIET, T, mk, health
import test_round7 as r7
rs = r7.rs


class ThreadGuardSink:
    """Wraps a real sink and records the thread of EVERY method call, so a test can prove nothing touches the store off the loop thread."""
    def __init__(self, real): self._real, self.calls = real, []
    def __getattr__(self, name):
        attr = getattr(self._real, name)
        if not callable(attr): return attr
        def f(*a, **kw):
            self.calls.append((name, threading.current_thread().name)); return attr(*a, **kw)
        return f


def in_thread(fn):
    box = {}
    def run():
        try: box["v"] = fn()
        except BaseException as e: box["e"] = e
    t = threading.Thread(target=run, name="refresher-sim"); t.start(); t.join(10)
    if "e" in box: raise box["e"]
    return box.get("v")


class StuckCaseOnTheLoopThread(unittest.TestCase):                                             # R7-M1
    def env(self, src):
        home = tempfile.mkdtemp(); os.makedirs(os.path.join(home, "data"))
        clock = Clock(T); store = ar.default_store(home)                                      # a REAL on-disk SqliteStore, created on this (the loop) thread
        router = ar.Router(store, lambda: FakeBus(), clock); sink = ThreadGuardSink(sb.RouterSink(router))
        flags = {"consult_open_publish": True, "consult_room_map": MAP}
        s = rs.build_subscriber({}, ROOMS, flags, sink, home, clock, consult_sources=src)
        s.consult.stop(); self.addCleanup(s.consult.stop)                                    # the live refresher thread is replaced by manual rounds on another thread
        for r in ROOMS: s.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": True, "zero_ratio": 1.0, "ts": clock()}))
        return s, clock, router, sink

    def round(self, s, clock):
        h = s.consult
        def go(): h._snap = (h.compute(clock()), clock())                                      # exactly what the refresher thread does
        in_thread(go)

    def kinds(self, router): return sorted((c["room_id"], c["kind"]) for c in router.store.list_open())

    def test_the_case_opens_and_closes_through_build_subscriber_with_a_real_store(self):
        src = Src(presence=RuntimeError("down")); s, clock, router, sink = self.env(src)
        for i in range(36):                                                                   # 36 minutes of fake time, a refresher round and a loop pass each minute
            self.round(s, clock); rs.housekeeping(s)
            for r in ROOMS: s.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": True, "zero_ratio": 1.0, "ts": clock()}))
            if i < 29: self.assertEqual(self.kinds(router), [], i)                            # 29 minutes: no case yet
            clock.adv(60)
        self.assertEqual(self.kinds(router), [("mini", "consult_hold_source_down")])           # opened by the loop thread: this was dead in Round 7
        for _ in range(5):
            self.round(s, clock); rs.housekeeping(s); clock.adv(60)
            for r in ROOMS: s.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": True, "zero_ratio": 1.0, "ts": clock()}))
        self.assertEqual(self.kinds(router), [("mini", "consult_hold_source_down")])           # one case, not one per pass
        src.v["presence"] = [("M6", clock() - 1, None), ("M7", clock() - 1, None)]; clock.adv(31)
        for r in ROOMS: s.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": True, "zero_ratio": 1.0, "ts": clock()}))
        self.round(s, clock); rs.housekeeping(s)
        self.assertEqual(self.kinds(router), [])                                               # the recovery closed it
        self.assertEqual({t for _n, t in sink.calls}, {threading.current_thread().name})       # every sink call ran on the loop thread

    def test_no_store_call_runs_off_the_loop_thread_anywhere(self):
        src = Src(presence=RuntimeError("down")); s, clock, router, sink = self.env(src)
        sent = []; s.start_day = sd.StartDayAfterBoot(lambda r: sent.append(threading.current_thread().name), None, sink, clock, background=True)
        s.usb_verify = uv.UsbVerify(sink, None, clock)
        s.on_line("kiosk/opd-6/health", json.dumps(health(100)))                              # the start_day worker sends off the loop thread
        s.on_line("kiosk/opd-6/heal", json.dumps({"layer": "usb", "action": "kiosk_reboot", "reason": "usb_power_off", "result": "healed_pending"}))
        for _ in range(40):
            if sent: break
            time.sleep(0.02)
        for _ in range(40):
            self.round(s, clock); clock.adv(60)
            for r in ROOMS: s.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": True, "zero_ratio": 1.0, "ts": clock()}))
            rs.housekeeping(s)
        self.assertEqual(sent, ["start-day-sender"])                                           # the send really ran on the worker thread
        names = {n for n, _t in sink.calls}
        self.assertTrue({"consult_hold_source_down", "usb_case", "start_day_failed"} <= names)  # all three paths made their store calls ...
        self.assertEqual({t for _n, t in sink.calls}, {threading.current_thread().name})       # ... and every one of them on the loop thread


class SnapshotAndRefresherPins(unittest.TestCase):                                             # S1, I2
    def test_computed_at_is_the_current_clock_at_the_end_of_the_round(self):                  # mutant 14
        clock = Clock(T)
        class Slow(Src):
            def __getitem__(self, name):
                inner = Src.__getitem__(self, name)
                def f(now, arg): clock.adv(3); return inner(now, arg)
                return f
        h, _, _ = mk(Slow(), clock=clock, background=True, cache_s=1000); self.addCleanup(h.stop)
        h.start()
        for _ in range(100):
            if h._snap is not None: break
            time.sleep(0.02)
        h.stop(); self.assertIsNotNone(h._snap)
        self.assertEqual(h._snap[1], clock())                                                  # not the start of the round and not a future time
        self.assertGreater(h._snap[1], T)
        self.assertEqual(h.hold(clock() + 90), {"opd-6": h._snap[0]["opd-6"], "opd-7": h._snap[0]["opd-7"]}); self.assertEqual(h.hold(clock() + 91), {"opd-6": True, "opd-7": True})

    def test_a_dead_refreshers_snapshot_goes_stale_at_90_s(self):                              # I2, DPM-6
        h, clock, _ = mk(Src(), background=True); h._stop.set()
        h._snap = (h.compute(clock()), clock())
        for age, want in ((0, False), (50, False), (60, False), (90, False), (90.5, True), (91, True), (119, True), (1e9, True)):
            self.assertEqual(h.hold(clock() + age)["opd-6"], want, age)

    def test_the_whole_refresh_with_per_item_retries_stays_inside_the_budget(self):           # mutants 6, 7
        rmap = r7.machines(9); rooms = sorted(rmap)
        class Slow(Src):
            def __getitem__(self, name):
                inner = Src.__getitem__(self, name)
                def f(now, arg):
                    if arg is not None and len(arg) > 1: raise RuntimeError("batched read failed")
                    time.sleep(0.15); return inner(now, arg)                                  # 9 single reads x 3 sources would take ~4 s
                return f
        src = Slow(presence=[(m["machine"], T - 5, None) for m in rmap.values()])
        h = ch.ConsultHold(rooms, rmap, src, Clock(T), refresh_budget_s=0.6, timeout_s=5)
        t0 = time.monotonic(); h.compute(T); dt = time.monotonic() - t0
        self.assertLess(dt, 1.0)                                                               # bounded by the whole-refresh budget, retries included
        self.assertTrue(any(h.item_bad.get(n) for n in ("presence", "session", "levels")))      # what was cut is held, not waited for

    def test_an_exception_out_of_compute_gives_an_all_true_snapshot(self):                    # mutant 13
        h, clock, _ = mk(Src(), background=True, cache_s=0.02); self.addCleanup(h.stop)
        orig, n = h.compute, [0]
        def flaky(now):
            n[0] += 1
            if n[0] == 1: return orig(now)                                                    # a good first round: every room false
            raise SystemExit("compute fault")
        h.compute = flaky; h.start()
        for _ in range(100):
            if n[0] >= 2: break
            time.sleep(0.02)
        time.sleep(0.05); h.stop()
        self.assertGreaterEqual(n[0], 2)
        self.assertEqual(h._snap[0], {"opd-6": True, "opd-7": True})                           # the old good snapshot was REPLACED, not kept


class StartDayWorkerIdleExit(unittest.TestCase):                                               # S1 (mutant 26), I1
    def test_the_worker_restarts_after_an_idle_exit(self):
        done = []; s = sd.StartDayAfterBoot(lambda r: done.append(r), None, Sink(), Clock(T), background=True, idle_s=0.05)
        s.on_health("r1", health(100))
        for _ in range(100):
            if done: break
            time.sleep(0.01)
        w = s._worker
        for _ in range(100):
            if w is None or not w.is_alive(): break
            time.sleep(0.02)
        self.assertFalse(w is not None and w.is_alive())                                      # it went idle and exited
        s.clock.adv(7200); s.on_health("r2", health(100))                                       # a later boot of another room
        for _ in range(100):
            if len(done) == 2: break
            time.sleep(0.01)
        self.assertEqual(done, ["r1", "r2"])

    def test_a_dead_worker_object_is_replaced(self):
        done = []; s = sd.StartDayAfterBoot(lambda r: done.append(r), None, Sink(), Clock(T), background=True)
        dead = threading.Thread(target=lambda: None); dead.start(); dead.join(); s._worker = dead
        s.on_health("r1", health(100))
        for _ in range(100):
            if done: break
            time.sleep(0.01)
        self.assertEqual(done, ["r1"]); self.assertIsNot(s._worker, dead)

    def test_the_idle_exit_never_leaves_an_item_behind(self):                                  # I1 (deterministic)
        s = sd.StartDayAfterBoot(lambda r: None, None, Sink(), Clock(T), background=True)
        s._q.put(("r1", 1, T)); self.assertFalse(s._try_exit())                                 # an item is waiting: the worker must not leave
        s._q.get(); s._worker = threading.current_thread(); self.assertTrue(s._try_exit()); self.assertIsNone(s._worker)
        s._enqueue("r2", 2, T); self.assertIsNotNone(s._worker)                                 # an enqueue after the exit starts a new worker

    def test_enqueue_and_the_idle_exit_exclude_each_other(self):                              # I1 (deterministic: enqueue takes the same lock the exit takes)
        s = sd.StartDayAfterBoot(lambda r: None, None, Sink(), Clock(T), background=True)
        s._wlock.acquire(); t = threading.Thread(target=lambda: s._enqueue("r1", 1, T)); t.start()
        try:
            time.sleep(0.15)
            self.assertTrue(t.is_alive()); self.assertEqual(s._q.qsize(), 0)                    # blocked while the lock is held (the worker would be deciding to leave)
        finally:
            s._wlock.release()
        t.join(2); self.assertFalse(t.is_alive()); self.assertIsNotNone(s._worker)

    def test_a_worker_whose_idle_exit_finds_an_item_keeps_running_and_sends_it(self):        # DPM-4 (mutant 12: `continue` -> `return` in _work)
        done = []; s = sd.StartDayAfterBoot(lambda r: done.append(r), None, Sink(), Clock(T), background=True, idle_s=0.05)
        s._enqueue("r1", 1, T)
        for _ in range(200):
            if done: break
            time.sleep(0.01)
        self.assertEqual(done, ["r1"]); w = s._worker; self.assertIsNotNone(w)
        s._wlock.acquire()
        try:
            time.sleep(0.3)                                  # the worker's get() has timed out and it now waits on _wlock inside _try_exit
            self.assertTrue(w.is_alive())
            s._q.put(("r2", 2, T))                           # the item arrives in that window (what a blocked _enqueue puts the moment the lock frees)
        finally:
            s._wlock.release()
        for _ in range(200):
            if len(done) == 2: break
            time.sleep(0.01)                                 # NO further _enqueue: only the same worker can send it
        self.assertEqual(done, ["r1", "r2"]); self.assertEqual(s._q.qsize(), 0); self.assertIs(s._worker, w)

    def test_a_burst_of_sends_against_a_worker_that_keeps_going_idle_loses_nothing(self):      # I1 (stress)
        done = []; lock = threading.Lock()
        def sender(room):
            with lock: done.append(room)
        s = sd.StartDayAfterBoot(sender, None, Sink(), Clock(T), background=True, idle_s=0.001)
        for i in range(150):
            s._enqueue(f"room-{i}", i, T)
            if i % 7 == 0: time.sleep(0.003)
        for _ in range(200):
            if len(done) == 150: break
            time.sleep(0.02)
        self.assertEqual(len(done), 150)


class AckClosesUsbDeviceMissing(unittest.TestCase):                                            # I3 ruling
    def test_an_ack_closes_it_a_server_recovered_row_does_not(self):
        e = CAEnv(T0); e.heal({"room_id": "r1", "layer": "usb", "action": "escalate", "reason": "usb_device_missing", "result": "escalated"})
        cid = e.open()["usb_device_missing"]["first_id"]; e.router.tick(e.bus)
        e.router.on_row(None, {"id": 951, "kind": "recovered", "room_ids": ["r1"]})
        self.assertIn("usb_device_missing", e.open())                                           # the server row never closes it
        e.bus.human("gating-lead", f"ACK room-alert-{cid}", f"room-alert-{cid}"); e.clock.adv(30); out = e.router.tick(e.bus)
        self.assertEqual(out["acked"], 1); self.assertEqual(e.open(), {})                       # an acker's ACK does
        row = e.router.store.db.execute("SELECT close_reason, acked_by FROM room_alert_case WHERE first_id=?", (cid,)).fetchone()
        self.assertEqual(row[1], "gating-lead"); self.assertIsNotNone(row[0])

    def test_the_health_line_still_closes_it_and_someone_elses_ack_does_not(self):
        e = CAEnv(T0); e.heal({"room_id": "r1", "layer": "usb", "action": "escalate", "reason": "usb_device_missing", "result": "escalated"})
        cid = e.open()["usb_device_missing"]["first_id"]; e.router.tick(e.bus)
        e.bus.human("someone-else", f"ACK room-alert-{cid}", f"room-alert-{cid}"); e.clock.adv(30); e.router.tick(e.bus)
        self.assertIn("usb_device_missing", e.open())
        e.health({"usb_mic_present": True}); self.assertEqual(e.open(), {})


if __name__ == "__main__":
    unittest.main()
