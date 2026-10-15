"""FR1 2.4 d' Round 6: the kiosk's USB lines (no `kind`: layer usb + action + reason + result) routed to specific cases, the F2 Mini verify, the token-wise body_ match, the
F9 control-payload size test and S2 duplicate JSON keys. Field names are INFERRED from guardian-lead's FR1-USB-POWEROFF-REPORT until its d2 report confirms them."""
import json, os, re, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
import consult_hold as ch
import start_day as sd
import usb_verify as uv
from test_router import ar, FakeBus
from test_subscriber import CAEnv, Clock, T0

KIOSK_RE_V2 = (r'^\{"consult_open": \{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}, "kill": (true|false), "modes": '
               r'\{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$')


def esc(reason, **kw):
    d = {"room_id": "r1", "ts": 1, "layer": "usb", "action": "escalate", "reason": reason, "result": "escalated", "shadow": False}
    d.update(kw); return d


def reboot(result, **kw):
    d = {"room_id": "r1", "ts": 1, "layer": "usb", "action": "kiosk_reboot", "reason": "usb_power_off", "result": result, "shadow": False,
         "guards": {"usb_absent_ticks": 3, "cc_power_off_age_s": 40, "hid_idle_s": 900, "consult_hold": False, "port": "ss"}, "boot_age_s": 30, "recorder_pid": 123}
    d.update(kw); return d


def good(pieces, rms=-40.0, **kw):
    d = {"capture_open": True, "zero_ratio": 0.01, "usb_mic_present": True, "pending_piece_count": pieces, "rms_dbfs_2s": rms}
    d.update(kw); return d


class UEnv(CAEnv):
    def __init__(self, t0=T0, state=True):
        super().__init__(t0)
        self.tmp2 = tempfile.TemporaryDirectory()
        self.state_path = os.path.join(self.tmp2.name, "verify.json") if state else None
        self.audit_path = os.path.join(self.tmp2.name, "audit.jsonl")
        self.verify = uv.UsbVerify(self.sub.sink, self.state_path, self.clock, self.audit_path)
        self.sub.usb_verify = self.verify

    def kinds(self, room="r1"):
        return sorted(c["kind"] for c in self.router.store.list_open() if c["room_id"] == room)

    def audit(self):
        return [json.loads(l) for l in open(self.audit_path)] if os.path.exists(self.audit_path) else []


class UsbEscalations(unittest.TestCase):
    def test_reboot_failed_and_recurring_are_urgent_v_kinds_with_the_coreaudio_window(self):
        for reason in ("usb_reboot_failed", "usb_power_off_recurring"):
            with self.subTest(reason):
                self.assertTrue(reason in ar.URGENT and reason in ar.V_KINDS and reason in ar.OPEN_KINDS and reason in ar.ACK_CLOSE_KINDS and reason in ar.ACK_ONLY_KINDS)
                e = CAEnv(T0); e.heal(esc(reason)); self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), [reason])
                e.router.tick(e.bus); self.assertEqual(e.v_texts(), [])               # V only after the 30 min threshold
                e.clock.adv(1860); e.router.tick(e.bus); self.assertTrue(e.v_texts(), "clinic hours, 31 min open, unacked: V")
                self.assertEqual(e.bus.real[0]["priority"], "urgent")
        for kind in ("usb_reboot_failed", "usb_power_off_recurring"):
            for label, t0, expect_v in (("tue 06:00 (checked 06:31)", sb.datetime(2026, 10, 13, 6, 0, tzinfo=ar.IST).timestamp(), False),
                                        ("sunday noon", sb.datetime(2026, 10, 18, 12, 0, tzinfo=ar.IST).timestamp(), True),
                                        ("tue 21:00 (checked 21:31, after clinic hours, inside 21:35)", sb.datetime(2026, 10, 13, 21, 0, tzinfo=ar.IST).timestamp(), True),
                                        ("tue 21:06 (checked 21:37)", sb.datetime(2026, 10, 13, 21, 6, tzinfo=ar.IST).timestamp(), False)):
                with self.subTest(kind=kind, at=label):
                    e = CAEnv(t0); e.heal(esc(kind)); e.router.tick(e.bus); e.clock.adv(1860); e.router.tick(e.bus)
                    self.assertEqual(bool(e.v_texts()), expect_v)                    # 07:00-21:35 IST, every day, as for the coreaudio kinds

    def test_device_missing_is_urgent_not_v_and_deduped_by_room_and_kind(self):
        k = "usb_device_missing"
        self.assertTrue(k in ar.URGENT and k not in ar.V_KINDS and k in ar.ACK_CLOSE_KINDS and k not in ar.ACK_ONLY_KINDS and k in ar.RECOVERY_KEEP_KINDS)    # Round 8: an ACK closes it, a server recovered row never does
        e = CAEnv(T0)
        for _ in range(4): e.heal(esc(k))
        e.heal(esc(k), room="r2")                                                    # another room is its own case
        self.assertEqual([c["suppressed_count"] for c in e.router.store.list_open() if c["room_id"] == "r1"], [3])
        self.assertEqual(len(e.router.store.list_open()), 2)
        e.router.tick(e.bus); e.clock.adv(1860); e.router.tick(e.bus); self.assertEqual(e.v_texts(), [])

    def test_escalations_open_the_specific_case_and_not_the_generic_one(self):
        for reason in ("usb_reboot_failed", "usb_power_off_recurring", "usb_device_missing"):
            e = CAEnv(T0); e.heal(esc(reason)); self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), [reason])

    def test_a_health_line_with_the_mic_present_closes_device_missing_only(self):
        e = UEnv(); e.heal(esc("usb_device_missing")); e.heal(esc("usb_reboot_failed"))
        for h in ({"usb_mic_present": False}, {}, {"usb_mic_present": "true"}, {"usb_mic_present": 1}):
            e.health(h)
        self.assertEqual(e.kinds(), ["usb_device_missing", "usb_reboot_failed"])
        e.health({"usb_mic_present": True}); self.assertEqual(e.kinds(), ["usb_reboot_failed"])         # reboot_failed closes on ACK only

    def test_the_missing_room_set_survives_a_restart_through_the_seed(self):
        e = CAEnv(T0); e.heal(esc("usb_device_missing"))
        sub2 = sb.Subscriber(os.path.join(e.tmp.name, "d2"), e.tmp.name, ["r1", "r2"], sb.RouterSink(e.router), e.clock, usb_missing_seed=sb.RouterSink(e.router).open_rooms("usb_device_missing"))
        sub2.on_line("kiosk/r1/health", json.dumps({"usb_mic_present": True}))
        self.assertEqual(e.router.store.list_open(), [])

    def test_reboot_lines(self):
        e = UEnv(); e.heal(reboot("reboot_issued")); self.assertEqual(e.kinds(), [])                  # stored only
        e.heal(reboot("reboot_failed")); self.assertEqual(e.kinds(), ["usb_reboot_failed"])
        e2 = UEnv(); e2.heal(reboot("healed_pending")); self.assertEqual(e2.kinds(), []); self.assertTrue(e2.verify.pending("r1"))    # no case, a verify starts

    def test_other_lines_keep_the_generic_path(self):
        e = CAEnv(T0); e.heal(esc("something_else")); self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["heal_escalated"])      # unknown usb reason
        e = CAEnv(T0); e.heal(reboot("weird_result")); self.assertEqual(e.router.store.list_open(), [])                                                   # unknown result, not escalated
        e = CAEnv(T0); e.heal(dict(esc("usb_device_missing"), layer="tcc")); self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["heal_escalated"])
        e = CAEnv(T0); e.heal(dict(esc("usb_device_missing"), layer="coreaudio")); self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["heal_escalated"])
        e = CAEnv(T0); e.heal(dict(esc("usb_device_missing"), action="would_do", result="would_do")); self.assertEqual(e.router.store.list_open(), [])        # SHADOW line
        e = CAEnv(T0); e.heal(dict(esc("usb_reboot_failed"), kind="capture_dead", result="failed")); self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["capture_dead"])   # a kind line is strict scope
        e = CAEnv(T0); e.heal({"room_id": "r1", "action": "heal", "layer": "coreaudio", "reason": "coreaudiod_wedged", "result": "escalated", "shadow": False})
        self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["heal_escalated"])                                                    # the R9 line, unchanged
        e = CAEnv(T0); e.heal({"kind": "capture_dead", "result": "failed", "mode": "heal"}); self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["capture_dead"])   # R14 shape

    def test_case_and_whitespace_in_the_words_do_not_hide_a_usb_line(self):
        e = CAEnv(T0); e.heal(esc(" USB_Reboot_Failed ", result="Escalated", action="ESCALATE", layer="USB"))
        self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["usb_reboot_failed"])

    def test_a_server_recovered_row_does_not_close_the_acked_only_usb_cases(self):
        e = CAEnv(T0); e.heal(esc("usb_reboot_failed")); e.heal(esc("usb_power_off_recurring"))
        e.router.on_row(None, {"id": 999, "kind": "recovered", "room_ids": ["r1"]})
        self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["usb_power_off_recurring", "usb_reboot_failed"])


class F2Verify(unittest.TestCase):
    def test_a_verified_room_opens_nothing(self):
        e = UEnv(); e.heal(reboot("healed_pending"))
        e.health(good(5)); e.clock.adv(40); e.health(good(6))
        self.assertTrue(e.verify.state["r1"]["ok"]); e.clock.adv(2000); e.sub.check_usb_verify(); self.assertEqual(e.kinds(), [])
        self.assertIn("verify_ok", [a["event"] for a in e.audit()])

    def test_not_verified_by_15_min_opens_reboot_failed_once_with_the_source_in_the_audit(self):
        e = UEnv(); e.heal(reboot("healed_pending"))
        e.clock.adv(899); e.sub.check_usb_verify(); self.assertEqual(e.kinds(), [])
        e.clock.adv(1); e.sub.check_usb_verify(); e.sub.check_usb_verify(); self.assertEqual(e.kinds(), ["usb_reboot_failed"])
        self.assertEqual([a for a in e.audit() if a["event"] == "verify_failed"][0]["source"], "mini_verify")
        self.assertEqual(len([a for a in e.audit() if a["event"] == "verify_failed"]), 1)

    def test_each_failed_condition_alone(self):
        bad = (("capture closed", good(5, capture_open=False)), ("capture_open str", good(5, capture_open="true")), ("zero_ratio 0.98", good(5, zero_ratio=0.98)),
               ("zero_ratio 1", good(5, zero_ratio=1)), ("zero_ratio NaN", good(5, zero_ratio=float("nan"))), ("zero_ratio str", good(5, zero_ratio="0")),
               ("zero_ratio missing", {k: v for k, v in good(5).items() if k != "zero_ratio"}), ("zero_ratio negative", good(5, zero_ratio=-0.1)), ("zero_ratio bool", good(5, zero_ratio=False)))
        for name, line in bad:
            with self.subTest(name):
                e = UEnv(); e.heal(reboot("healed_pending")); e.health(line); e.clock.adv(40); e.health(dict(line, pending_piece_count=6)); e.clock.adv(900)
                e.sub.check_usb_verify(); self.assertEqual(e.kinds(), ["usb_reboot_failed"], name)

    def test_the_zero_ratio_boundary_is_0_05(self):                                                  # Round 6b
        self.assertEqual(uv.ZERO_RATIO_MAX, 0.05); self.assertEqual(ch.SILENCE_ZERO_RATIO, 0.98)       # the consult-hold levels test keeps 0.98
        for zr, ok in ((0.0, True), (0.049, True), (0.0499, True), (0.05, False), (0.0501, False), (0.5, False), (0.97, False), (0.98, False), (1.0, False)):
            with self.subTest(zr=zr):
                e = UEnv(); e.heal(reboot("healed_pending")); e.health(good(5, zero_ratio=zr)); e.clock.adv(40); e.health(good(6, zero_ratio=zr))
                self.assertEqual(e.verify.state["r1"]["ok"], ok, zr)
                e.clock.adv(900); e.sub.check_usb_verify(); self.assertEqual(e.kinds(), [] if ok else ["usb_reboot_failed"], zr)
        e = UEnv(); e.heal(reboot("healed_pending")); e.health(good(5, zero_ratio=0.049)); e.clock.adv(40); e.health(good(6, zero_ratio=0.05))      # the second line fails the boundary
        self.assertFalse(e.verify.state["r1"]["ok"])

    def test_data_that_does_not_advance_does_not_verify(self):
        e = UEnv(); e.heal(reboot("healed_pending"))
        e.health(good(5)); e.clock.adv(40); e.health(good(5))                       # same pieces, same level
        self.assertFalse(e.verify.state["r1"]["ok"])
        e.clock.adv(10); e.health(good(5, rms=-41.0)); self.assertTrue(e.verify.state["r1"]["ok"])      # the level moved
        e2 = UEnv(); e2.heal(reboot("healed_pending")); e2.health(good(5)); e2.clock.adv(29); e2.health(good(9)); self.assertFalse(e2.verify.state["r1"]["ok"])    # under 30 s apart
        e3 = UEnv(); e3.heal(reboot("healed_pending")); e3.health(good(5)); e3.clock.adv(60); e3.health(good(None, rms=None)); self.assertFalse(e3.verify.state["r1"]["ok"])

    def test_lines_after_a_finished_verify_change_nothing(self):
        e = UEnv(); e.heal(reboot("healed_pending")); e.clock.adv(901); e.sub.check_usb_verify()
        e.health(good(5)); e.clock.adv(40); e.health(good(6))
        self.assertEqual((e.verify.state["r1"]["failed"], e.verify.state["r1"]["ok"]), (True, False))
        self.assertEqual(e.kinds(), ["usb_reboot_failed"])

    def test_health_lines_before_healed_pending_do_not_count(self):
        e = UEnv(); e.health(good(5)); e.clock.adv(40); e.health(good(6)); e.heal(reboot("healed_pending")); e.clock.adv(900)
        e.sub.check_usb_verify(); self.assertEqual(e.kinds(), ["usb_reboot_failed"])

    def test_a_second_healed_pending_does_not_reset_the_clock(self):
        e = UEnv(); e.heal(reboot("healed_pending")); e.clock.adv(600); e.heal(reboot("healed_pending")); e.clock.adv(300)
        e.sub.check_usb_verify(); self.assertEqual(e.kinds(), ["usb_reboot_failed"])

    def test_the_verify_state_survives_a_restart(self):
        e = UEnv(); e.heal(reboot("healed_pending")); e.clock.adv(500)
        v2 = uv.UsbVerify(e.sub.sink, e.state_path, e.clock, e.audit_path)         # a new process reads the same file
        self.assertTrue(v2.pending("r1")); e.clock.adv(401); v2.check(e.clock()); self.assertEqual(e.kinds(), ["usb_reboot_failed"])
        e2 = UEnv(); e2.heal(reboot("healed_pending")); e2.health(good(5)); e2.clock.adv(40)
        v3 = uv.UsbVerify(e2.sub.sink, e2.state_path, e2.clock, e2.audit_path); v3.on_health("r1", good(6), e2.clock()); self.assertTrue(v3.state["r1"]["ok"])    # even the first line survives

    def test_a_corrupt_state_file_is_dropped_and_a_write_fault_never_raises(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "s.json")
        json.dump({"r1": {"started_at": "x"}, "r2": 5, "r3": {"started_at": 1, "deadline": float("inf")}}, open(p, "w"))
        self.assertEqual(uv.UsbVerify(None, p, Clock(T0)).state, {})
        e = UEnv(state=False); v = uv.UsbVerify(e.sub.sink, os.path.join(t.name, "no-dir", "s.json"), e.clock); v.start("r1"); e.clock.adv(901); v.check()
        self.assertEqual(e.kinds(), ["usb_reboot_failed"])

    def test_a_failing_sink_is_retried_once_per_5_min(self):
        class Broken:
            n = 0
            def usb_case(self, room, kind, now): Broken.n += 1; raise RuntimeError("store locked")
        clock = Clock(T0); v = uv.UsbVerify(Broken(), None, clock); v.start("r1"); clock.adv(901)
        for _ in range(720):
            v.check(); clock.adv(5)
        self.assertGreaterEqual(Broken.n, 2); self.assertLessEqual(Broken.n, 13)

    def test_healed_pending_triggers_start_day_only_with_the_flag_object_and_a_qualifying_boot(self):
        sent = []
        e = UEnv(); e.health({"boot_age_s": 100, "usb_mic_present": True, "recorder_pid_age_s": 50, "capture_open": False})
        e.heal(reboot("healed_pending")); self.assertEqual(sent, [])                                 # flag off: no start_day object, nothing sent
        e2 = UEnv(); e2.sub.start_day = sd.StartDayAfterBoot(lambda r: sent.append(r), None, e2.sub.sink, e2.clock)
        e2.heal(reboot("healed_pending")); self.assertEqual(sent, [])                                # no health line seen yet: the next health line triggers it
        e2.health({"boot_age_s": 100, "usb_mic_present": True, "recorder_pid_age_s": 50, "capture_open": False}); self.assertEqual(sent, ["r1"])
        e3 = UEnv(); e3.sub.start_day = sd.StartDayAfterBoot(lambda r: sent.append(r + "-3"), None, e3.sub.sink, e3.clock)
        e3.sub.last_health["r1"] = (e3.clock(), {"boot_age_s": 100, "usb_mic_present": True, "recorder_pid_age_s": 50, "capture_open": False})
        e3.heal(reboot("healed_pending")); self.assertEqual(sent, ["r1", "r1-3"])                    # the stored qualifying line is used at once
        e3.heal(reboot("healed_pending")); self.assertEqual(sent, ["r1", "r1-3"])                    # once per boot


class BodyReasonToken(unittest.TestCase):
    def pattern(self):
        m = re.search(r"p\.payload->>'reason' ~ '([^']*)'", ch.POST_SQL); self.assertTrue(m); return m.group(1)

    def test_a_token_that_starts_with_body_matches(self):
        rx = self.pattern(); self.assertEqual(rx, "(^|,)body_")
        for reason, want in (("body_raw_missing", True), ("absent_401,body_raw_missing", True), ("body_not_json,absent_401", True), ("a,b,body_x", True),
                             ("nobody_x", False), ("x_body_y", False), ("absent_401", False), ("", False), ("body", False), ("absent_401,nobody_raw_missing", False),
                             ("BODY_x", False), ("identity_stale", False)):
            self.assertEqual(bool(re.search(rx, reason)), want, reason)

    def test_the_post_sql_still_has_exactly_two_placeholders_and_no_like(self):
        self.assertEqual(ch.POST_SQL.count("%s"), 2); self.assertNotIn("LIKE", ch.POST_SQL); self.assertEqual(ch.POST_SQL.replace("%s", "").count("%"), 0)


class F9PayloadSize(unittest.TestCase):
    def worst(self, rooms):
        return {"consult_open": {r: False for r in rooms}, "kill": False, "modes": {r: "shadow" for r in rooms}, "ts": 10 ** 14}

    def test_the_consult_open_payload_stays_under_4096_at_the_cap_and_start_is_refused_beyond_it(self):
        self.assertLess(sb.CONTROL_MAX_BYTES, 4096); self.assertEqual(sb.CONTROL_MAX_BYTES, 4000)
        checked = 0
        for n in (1, 2, 5, 16, 32, 48, 64):
            fit = 0
            for L in range(1, 65):
                rooms = [("r%02d" % i).ljust(max(L, 3), "x")[:L] if L >= 3 else "r"[:L] + str(i) for i in range(n)]
                if len(set(rooms)) != n:
                    continue
                err = sb.validate_rooms(rooms, consult_open=True)
                if err is None:
                    fit = L
                    msg = sb.canonical_control(self.worst(rooms))
                    self.assertLessEqual(len(msg.encode("ascii")), 4000, (n, L)); self.assertLess(len(msg.encode("ascii")), 4096)
                    self.assertTrue(re.fullmatch(KIOSK_RE_V2, msg), (n, L)); checked += 1
                else:
                    self.assertIn("4000 bytes", err, (n, L))                                  # refused for the size, never for something else
                    self.assertRaises(ValueError, sb.canonical_control, self.worst(rooms))   # and the payload itself is refused beyond the cap
            self.assertGreater(fit, 0, n)
            if n == 64: self.assertEqual(fit, 18)                                             # the measured budget at the full 64 rooms
        self.assertGreater(checked, 50)

    def test_a_real_hold_payload_at_the_cap_is_no_longer_than_the_worst_case(self):
        rooms = [("r%02d" % i).ljust(18, "x") for i in range(64)]
        self.assertIsNone(sb.validate_rooms(rooms, consult_open=True))
        msg = sb.canonical_control({"consult_open": {r: i % 2 == 0 for i, r in enumerate(rooms)}, "kill": True, "modes": {r: "heal" if i % 3 else "shadow" for i, r in enumerate(rooms)},
                                    "ts": 1760000000})
        self.assertLessEqual(len(msg), len(sb.canonical_control(self.worst(rooms))))


class DuplicateKeys(unittest.TestCase):
    def dupraw(self, **kw):
        return '{"kind": "capture_dead", "result": "healed", "result": "failed"}'

    def test_strict_scope_duplicate_keys_are_an_invalid_heal_line(self):
        e = CAEnv(T0); e.heal(None, raw=self.dupraw())
        self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["heal_message_invalid"])        # not capture_dead: the line is not trusted
        e = CAEnv(T0); e.heal(None, raw='{"kind": "recorder_disturbed", "kind": "recorder_disturbed", "result": "healed"}')
        self.assertEqual(sorted(c["kind"] for c in e.router.store.list_open()), ["heal_message_invalid", "recorder_disturbed"])   # the recorder alert is never lost (as for any invalid line)
        e = CAEnv(T0); e.heal({"kind": "capture_dead", "result": "failed"}); self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["capture_dead"])     # no duplicates: unchanged

    def test_out_of_scope_duplicate_keys_are_stored_with_one_audit_line_and_never_a_case(self):
        for raw in ('{"room_id": "r1", "layer": "coreaudio", "action": "heal", "result": "ok", "result": "escalated"}',
                    '{"layer": "usb", "action": "escalate", "reason": "usb_device_missing", "reason": "usb_device_missing", "result": "escalated"}',
                    '{"a": {"x": 1, "x": 2}, "result": "escalated"}'):
            e = CAEnv(T0); e.heal(None, raw=raw)
            self.assertEqual(e.router.store.list_open(), [], raw)
            day = os.path.join(e.tmp.name, "d", sb.datetime.fromtimestamp(T0, sb.IST).strftime("%Y-%m-%d"))
            stored = open(os.path.join(day, "r1.heal.jsonl")).read().splitlines(); self.assertEqual(stored, [raw])
            audit = open(os.path.join(day, "r1.heal-duplicate-keys.jsonl")).read().splitlines(); self.assertEqual(len(audit), 1)
            self.assertNotIn("escalated", audit[0])                                                # no line content in the audit line

    def test_lines_without_duplicates_are_unchanged(self):
        e = CAEnv(T0); e.heal({"room_id": "r1", "layer": "coreaudio", "action": "heal", "result": "escalated"}); self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["heal_escalated"])
        e = CAEnv(T0); e.heal(esc("usb_reboot_failed")); self.assertEqual([c["kind"] for c in e.router.store.list_open()], ["usb_reboot_failed"])
        obj, dup = sb.loads_dupcheck('{"a": 1, "b": {"c": 2}}'); self.assertEqual((obj, dup), ({"a": 1, "b": {"c": 2}}, False))
        self.assertEqual(sb.loads_dupcheck('{"a": 1, "a": 2}'), ({"a": 2}, True))
        self.assertEqual(sb.loads_dupcheck('[{"a": 1}, {"a": 2}]'), ([{"a": 1}, {"a": 2}], False))             # the same key in different objects is fine

    def test_health_lines_are_not_affected(self):
        e = CAEnv(T0); self.assertTrue(e.sub.on_line("kiosk/r1/health", '{"zero_ratio": 0.0, "zero_ratio": 0.0}')); self.assertEqual(e.router.store.list_open(), [])


if __name__ == "__main__":
    unittest.main()
