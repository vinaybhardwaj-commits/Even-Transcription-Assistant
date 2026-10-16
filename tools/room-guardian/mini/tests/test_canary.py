"""FR1-C5 canary routing (Mini side, SHADOW: alerts only). Lines are the kiosk's canary_event shape (kiosk lib/canary.sh)."""
import json, os, sys, unittest
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
import canary_route as cr
from test_router import ar
from test_subscriber import CAEnv

NIGHT_T = datetime(2026, 10, 16, 23, 0, tzinfo=ar.IST).timestamp()          # a night run, outside the clinic and the V window


def line(result, night="20261016", room="r1", **kw):
    d = {"room_id": room, "install_id": "inst-1", "ts": 1760000000, "action": "canary", "night": night, "result": result, "mode": "heal",
         "pre_db": -60.0, "burst_db": -40.5, "rise_db": 19.5, "volume": 0.3, "output": "Built-in Output"}
    d.update(kw); return d


class Env(CAEnv):
    def __init__(self, t0=NIGHT_T, **kw):
        super().__init__(t0, **kw)

    def canary(self, obj, room="r1", raw=None):
        return self.sub.on_line(f"kiosk/{room}/canary", raw if raw is not None else json.dumps(obj))

    def kinds(self, room="r1"):
        return sorted(self.open(room))

    def invalid(self, room="r1"):
        out = []
        for dp, _d, fs in os.walk(self.sub.data):
            for f in fs:
                if f == f"{room}.canary-invalid.jsonl":
                    out += [json.loads(l) for l in open(os.path.join(dp, f))]
        return out

    def stored(self, room="r1"):
        out = []
        for dp, _d, fs in os.walk(self.sub.data):
            for f in fs:
                if f == f"{room}.canary.jsonl":
                    out += [l for l in open(os.path.join(dp, f))]
        return out


class Routing(unittest.TestCase):
    def test_the_stream_is_subscribed_and_stored_as_jsonl(self):
        self.assertIn("canary", sb.STREAMS); self.assertEqual(sb.parse_topic("kiosk/r1/canary"), ("r1", "canary"))
        e = Env(); self.assertTrue(e.canary(line("pass"))); self.assertEqual(len(e.stored()), 1); self.assertEqual(json.loads(e.stored()[0])["result"], "pass")

    def test_no_local_rise_opens_canary_failed_urgent_and_a_v_kind_like_capture_dead(self):
        self.assertIn("canary_failed", ar.URGENT); self.assertIn("canary_failed", ar.V_KINDS); self.assertIn("canary_failed", ar.OPEN_KINDS)
        e = Env(); e.canary(line("no_local_rise")); self.assertEqual(e.kinds(), ["canary_failed"])
        out = e.router.tick(e.bus); self.assertEqual(out["paged"], 1); self.assertEqual(e.bus.real[0]["priority"], "urgent")
        self.assertIn("canary_failed in r1.", e.bus.real[0]["body"]); self.assertIn("source=mini.", e.bus.real[0]["body"])
        self.assertEqual(e.v_texts(), [])                                         # 23:00: outside the V window, no V notice yet
        self.assertTrue(ar.is_v_window("canary_failed", datetime(2026, 10, 17, 8, 0, tzinfo=ar.IST).timestamp()))      # the same window as capture_dead
        self.assertFalse(ar.is_v_window("canary_failed", datetime(2026, 10, 16, 22, 0, tzinfo=ar.IST).timestamp()))
        for t in (datetime(2026, 10, 17, 8, 0, tzinfo=ar.IST), datetime(2026, 10, 17, 21, 40, tzinfo=ar.IST)):
            self.assertEqual(ar.is_v_window("canary_failed", t.timestamp()), ar.is_v_window("capture_dead", t.timestamp()))

    def test_the_v_notice_comes_in_the_morning_if_unacked(self):
        e = Env(); e.canary(line("no_local_rise")); e.router.tick(e.bus)
        e.clock.t = datetime(2026, 10, 17, 8, 0, tzinfo=ar.IST).timestamp(); e.router.tick(e.bus); e.clock.adv(60); e.router.tick(e.bus)
        self.assertTrue(e.v_texts())

    def test_every_inconclusive_reason_opens_canary_inconclusive_normal_tier_not_v(self):
        self.assertNotIn("canary_inconclusive", ar.URGENT); self.assertNotIn("canary_inconclusive", ar.V_KINDS); self.assertIn("canary_inconclusive", ar.OPEN_KINDS)
        for why in ("bad_volume", "output_absent", "tape_unreadable", "play_timeout", "afplay_error", "segment_rolled", "tape_stalled", "tape_short", "state_write", "state_corrupt"):
            with self.subTest(why):
                e = Env(); e.canary(line(f"inconclusive:{why}")); self.assertEqual(e.kinds(), ["canary_inconclusive"])
                e.router.tick(e.bus)
                for m in e.bus.real: self.assertNotEqual(m["priority"], "urgent")                              # NORMAL tier
                e.clock.adv(5 * 3600); e.router.tick(e.bus); self.assertEqual(e.v_texts(), [])

    def test_would_do_is_stored_and_never_a_case(self):
        e = Env(); self.assertTrue(e.canary(line("would_do", mode="shadow"))); self.assertEqual(e.kinds(), []); self.assertEqual(len(e.stored()), 1)
        self.assertEqual(e.router.tick(e.bus)["paged"], 0); self.assertEqual(e.invalid(), [])

    def test_pass_closes_every_open_canary_case_of_that_room_only(self):
        e = Env()
        e.canary(line("no_local_rise", night="20261015")); e.canary(line("inconclusive:output_absent", night="20261015"))
        e.canary(line("inconclusive:output_absent", night="20261016")); e.canary(line("no_local_rise", night="20261015", room="r2"), room="r2")
        self.assertEqual(e.kinds(), ["canary_failed", "canary_inconclusive", "canary_output_absent"]); self.assertEqual(e.kinds("r2"), ["canary_failed"])
        e.canary(line("pass", night="20261017")); self.assertEqual(e.kinds(), []); self.assertEqual(e.kinds("r2"), ["canary_failed"])

    def test_pass_leaves_other_cases_alone(self):
        e = Env(); e.heal({"kind": "capture_dead", "result": "escalated", "action": "coreaudiod_restart", "before_zero_ratio": 1.0})
        e.canary(line("no_local_rise")); e.canary(line("pass", night="20261017")); self.assertEqual(e.kinds(), ["capture_dead"])


class Dedupe(unittest.TestCase):
    def test_one_case_per_room_per_night_even_after_an_ack(self):
        e = Env(); e.canary(line("no_local_rise")); first = e.open()["canary_failed"]["first_id"]; e.router.tick(e.bus)
        e.canary(line("no_local_rise")); self.assertEqual(e.open()["canary_failed"]["first_id"], first)         # open: folded
        e.bus.human("gating-lead", f"ACK room-alert-{first}", f"room-alert-{first}"); e.clock.adv(30); e.router.tick(e.bus); self.assertEqual(e.kinds(), [])
        e.canary(line("no_local_rise")); self.assertEqual(e.kinds(), [])                                         # same night: not re-opened after the ACK
        e.canary(line("no_local_rise", night="20261017")); self.assertEqual(e.kinds(), ["canary_failed"])        # the next night opens again

    def test_each_room_has_its_own_night(self):
        e = Env(); e.canary(line("no_local_rise")); e.canary(line("no_local_rise", room="r2"), room="r2")
        self.assertEqual((e.kinds("r1"), e.kinds("r2")), (["canary_failed"], ["canary_failed"]))

    def test_the_night_state_survives_a_restart(self):
        e = Env(); e.canary(line("no_local_rise")); first = e.open()["canary_failed"]["first_id"]
        e.bus.human("gating-lead", f"ACK room-alert-{first}", f"room-alert-{first}"); e.router.tick(e.bus); e.clock.adv(30); e.router.tick(e.bus)
        sub2 = sb.Subscriber(e.sub.data, e.tmp.name, ["r1", "r2"], sb.RouterSink(e.router), e.clock)
        sub2.on_line("kiosk/r1/canary", json.dumps(line("no_local_rise"))); self.assertEqual(e.kinds(), [])


class OutputAbsent(unittest.TestCase):
    def test_two_nights_in_a_row_raise_it_to_urgent(self):
        self.assertIn("canary_output_absent", ar.URGENT); self.assertNotIn("canary_output_absent", ar.V_KINDS)
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261015")); self.assertEqual(e.kinds(), ["canary_inconclusive"])
        e.canary(line("inconclusive:output_absent", night="20261016")); self.assertEqual(e.kinds(), ["canary_inconclusive", "canary_output_absent"])
        out = e.router.tick(e.bus); self.assertEqual(out["paged"], 2)
        self.assertEqual(len(e.bus.real), 1); self.assertEqual(e.bus.real[0]["priority"], "urgent")             # one batched message, urgent because of the output_absent case
        self.assertIn("canary_output_absent in r1.", e.bus.real[0]["body"]); self.assertIn("canary_inconclusive in r1.", e.bus.real[0]["body"])
        self.assertEqual(e.v_texts(), [])                                                                      # not a V kind

    def test_the_streak_crosses_a_month_end(self):
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261031")); e.canary(line("inconclusive:output_absent", night="20261101"))
        self.assertIn("canary_output_absent", e.kinds())

    def test_a_gap_a_pass_or_another_reason_breaks_the_streak(self):
        for between in (None, line("pass", night="20261016"), line("inconclusive:tape_short", night="20261016"), line("would_do", night="20261016")):
            with self.subTest(between=None if between is None else between["result"]):
                e = Env(); e.canary(line("inconclusive:output_absent", night="20261015"))
                if between: e.canary(between)
                e.canary(line("inconclusive:output_absent", night="20261017"))
                if between is None or between["result"] != "would_do":
                    self.assertNotIn("canary_output_absent", e.kinds())
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261015")); e.canary(line("inconclusive:output_absent", night="20261015"))
        self.assertNotIn("canary_output_absent", e.kinds())                                                      # the same night twice is not two nights

    def test_a_third_night_does_not_open_a_second_urgent_case_while_one_is_open(self):
        e = Env()
        for n in ("20261015", "20261016", "20261017"): e.canary(line("inconclusive:output_absent", night=n))
        self.assertEqual(e.kinds(), ["canary_inconclusive", "canary_output_absent"])

    def test_the_streak_survives_a_restart(self):
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261015"))
        sub2 = sb.Subscriber(e.sub.data, e.tmp.name, ["r1", "r2"], sb.RouterSink(e.router), e.clock)
        sub2.on_line("kiosk/r1/canary", json.dumps(line("inconclusive:output_absent", night="20261016"))); self.assertIn("canary_output_absent", e.kinds())

    def test_ack_closes_all_three_kinds_and_a_server_recovered_row_closes_none(self):
        e = Env(); e.canary(line("no_local_rise", night="20261015")); e.canary(line("inconclusive:output_absent", night="20261015")); e.canary(line("inconclusive:output_absent", night="20261016"))
        n = len(e.kinds()); e.router.on_row(None, {"id": 9001, "kind": "recovered", "room_ids": ["r1"]}); self.assertEqual(len(e.kinds()), n)
        for c in list(e.open().values()):
            e.bus.human("gating-lead", f"ACK room-alert-{c['first_id']}", f"room-alert-{c['first_id']}")
        e.clock.adv(30); e.router.tick(e.bus); self.assertEqual(e.kinds(), [])


class Validation(unittest.TestCase):
    def bad(self, obj, why, room="r1", raw=None):
        e = Env(); e.canary(obj, room=room, raw=raw)
        self.assertEqual(e.kinds(room), [], why); self.assertEqual(e.router.tick(e.bus)["paged"], 0)
        inv = e.invalid(room)
        if raw is None or raw.strip().startswith("{"):
            self.assertEqual(len(inv), 1, why); self.assertEqual(inv[0]["why"], why)
        return e

    def test_extra_and_missing_keys(self):
        self.bad(dict(line("no_local_rise"), extra=1), "keys"); d = line("no_local_rise"); d.pop("volume"); self.bad(d, "keys")

    def test_room_mismatch_between_topic_and_line(self):
        self.bad(line("no_local_rise", room="r2"), "room_mismatch")

    def test_wrong_types_and_vocabulary(self):
        for kw, why in ((dict(result="fail"), "result"), (dict(result="inconclusive:"), "result"), (dict(result="inconclusive:Bad Why"), "result"), (dict(result="PASS"), "result"),
                        (dict(result=7), "result_type"), (dict(result=None), "result_type"), (dict(action="play"), "action"), (dict(night="2026-10-16"), "night"),
                        (dict(night=20261016), "night"), (dict(night="20261332"), "night"), (dict(ts="1"), "ts"), (dict(ts=True), "ts"), (dict(ts=0), "ts"), (dict(mode="live"), "mode"),
                        (dict(pre_db="x"), "number_field"), (dict(volume=True), "number_field"), (dict(install_id=5), "string_field"), (dict(output=["a"]), "string_field"),
                        (dict(output="x" * 201), "string_field")):
            with self.subTest(kw): self.bad(dict(line("no_local_rise"), **kw), why)

    def test_nan_and_inf_numbers(self):
        for v in ("NaN", "Infinity"):
            raw = json.dumps(line("no_local_rise")).replace('"pre_db": -60.0', f'"pre_db": {v}'); self.bad(None, "number_field", raw=raw)

    def test_not_an_object_and_not_json(self):
        self.bad(["x"], "not_an_object"); e = Env(); self.assertFalse(e.canary(None, raw="not json")); self.assertEqual(e.kinds(), []); self.assertEqual(e.stored(), [])

    def test_duplicate_keys_are_invalid(self):
        raw = json.dumps(line("pass"))[:-1] + ', "result": "no_local_rise"}'; self.bad(None, "duplicate_keys", raw=raw)

    def test_a_valid_looking_failure_with_a_bad_line_never_opens_a_case(self):
        e = Env(); e.canary(dict(line("no_local_rise"), mode="live")); e.canary(dict(line("no_local_rise"), night="x")); self.assertEqual(e.kinds(), []); self.assertEqual(len(e.invalid()), 2)

    def test_the_audit_line_holds_the_reason_only(self):
        e = Env(); e.canary(dict(line("no_local_rise"), install_id="SECRET-ID", extra=1)); self.assertNotIn("SECRET-ID", json.dumps(e.invalid())); self.assertEqual(set(e.invalid()[0]), {"ts", "room", "why"})


class Shadow(unittest.TestCase):
    def test_a_canary_line_only_opens_or_closes_cases_never_acts(self):
        class Spy:
            def __init__(self): self.calls = []
            def __getattr__(self, n): return lambda *a, **k: self.calls.append(n)
        spy = Spy(); s = sb.Subscriber(os.path.join(Env().tmp.name, "d"), "/tmp", ["r1"], spy, lambda: NIGHT_T)
        for r in ("pass", "would_do", "no_local_rise", "inconclusive:output_absent"): s.on_line("kiosk/r1/canary", json.dumps(line(r)))
        self.assertEqual(set(spy.calls) - {"canary_case", "canary_pass"}, set())
        self.assertEqual(sorted(set(spy.calls)), ["canary_case", "canary_pass"])


def rec_line(reason, severity="page", shadow=False, **kw):
    """The kiosk escalate() shape (heal.sh escalate -> heal_event), as R16d emits recorder_failed: no `kind`, layer recorder, action escalate, result escalated."""
    d = {"room_id": "r1", "ts": 1760000000, "action": "escalate", "layer": "recorder", "reason": reason,
         "before": "state=failed last_error=boom" if reason == "recorder_failed" else "pid=none state=null", "after": "", "result": "escalated", "shadow": shadow,
         "target": "fleet", "severity": severity}
    d.update(kw); return d


class RecorderFailedLikeNotRunning(unittest.TestCase):
    """R16d addendum: recorder_failed is escalate-only and takes exactly the path recorder_not_running takes. The Mini keys on no allow-list of verdict names for it:
    a line with no `kind` and result "escalated" goes through the generic path (heal_escalated, URGENT, not a V kind); the reason is never read."""
    def cases(self, obj):
        e = CAEnv(NIGHT_T); e.heal(obj); out = e.router.tick(e.bus)
        return {c["kind"] for c in e.router.store.list_open() if c["room_id"] == "r1"}, out["paged"], [m["priority"] for m in e.bus.real], e

    def test_out_of_scope_the_exact_r16d_fixture_opens_the_same_case_as_recorder_not_running(self):
        want = self.cases(rec_line("recorder_not_running"))[:3]
        got = self.cases(rec_line("recorder_failed"))[:3]
        self.assertEqual(got, want); self.assertEqual(got[0], {"heal_escalated"}); self.assertEqual(got[1], 1); self.assertEqual(got[2], ["urgent"])
        self.assertIn("heal_escalated", ar.URGENT); self.assertNotIn("heal_escalated", ar.V_KINDS)

    def test_out_of_scope_nothing_is_dropped_as_invalid_for_any_variant(self):
        for kw in ({}, {"severity": "info"}, {"shadow": True}, {"last": None}, {"before": "state=failed last_error=null"}, {"target": "gating-lead"}):
            with self.subTest(kw):
                a, b = self.cases(dict(rec_line("recorder_not_running"), **kw)), self.cases(dict(rec_line("recorder_failed"), **kw))
                self.assertEqual(a[:3], b[:3]); self.assertEqual(b[0], {"heal_escalated"}); self.assertNotIn("heal_message_invalid", b[0])

    def test_the_line_is_stored_in_the_heal_stream_for_both(self):
        for reason in ("recorder_not_running", "recorder_failed"):
            e = CAEnv(NIGHT_T); e.heal(rec_line(reason)); found = []
            for dp, _d, fs in os.walk(e.sub.data):
                found += [json.loads(l)["reason"] for f in fs if f == "r1.heal.jsonl" for l in open(os.path.join(dp, f))]
            self.assertEqual(found, [reason])

    def test_strict_scope_a_kind_line_is_judged_the_same_for_both_reasons(self):
        for kind, expect in (("recorder_disturbed", {"recorder_disturbed"}), ("capture_dead", {"capture_dead"}), ("not_a_kind", {"heal_message_invalid"})):
            with self.subTest(kind):
                a, b = self.cases(dict(rec_line("recorder_not_running"), kind=kind)), self.cases(dict(rec_line("recorder_failed"), kind=kind))
                self.assertEqual(a[:3], b[:3]); self.assertEqual(b[0], expect)

    def test_a_recorder_failed_escalation_is_not_a_canary_event(self):
        e = CAEnv(NIGHT_T); e.heal(rec_line("recorder_failed")); self.assertFalse({"canary_failed", "canary_inconclusive", "canary_output_absent"} & set(e.open()))


if __name__ == "__main__":
    unittest.main()
