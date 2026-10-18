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


def night_ts(night, hour=23):
    """A ts inside the given IST night (default 23:00 IST on that date)."""
    return int(datetime.strptime(night, "%Y%m%d").replace(hour=hour, tzinfo=ar.IST).timestamp())


def safe_ts(night):
    try:
        return night_ts(night)
    except ValueError:                       # an impossible date: the test passes its own ts
        return 1760000000


def line(result, night="20261016", room="r1", **kw):
    d = {"room_id": room, "install_id": "inst-1", "ts": safe_ts(night), "action": "canary", "night": night, "result": result, "mode": "heal",
         "pre_db": -60.0, "burst_db": -40.5, "rise_db": 19.5, "volume": 0.3, "output": "Built-in Output"}
    d.update(kw); return d


class Env(CAEnv):
    def __init__(self, t0=NIGHT_T, **kw):
        super().__init__(t0, **kw)

    def canary(self, obj, room="r1", raw=None, sync=True):
        """sync: the Mini clock is set to the line's own ts first, as with a kiosk whose clock agrees with the Mini's. sync=False leaves the clock alone (a skewed kiosk)."""
        if sync and isinstance(obj, dict) and isinstance(obj.get("ts"), int) and 0 < obj["ts"] < 4e9:
            self.clock.t = obj["ts"]
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

    def test_would_do_writes_one_audit_line_each(self):
        e = Env(); e.canary(line("would_do", mode="shadow")); e.canary(line("would_do", mode="shadow", night="20261017"))
        a = [json.loads(l) for dp, _d, fs in os.walk(e.sub.data) for f in fs if f == "r1.canary-audit.jsonl" for l in open(os.path.join(dp, f))]
        self.assertEqual([(x["event"], x["night"]) for x in a], [("would_do", "20261016"), ("would_do", "20261017")]); self.assertEqual(set(a[0]), {"ts", "room", "event", "night"})
        self.assertEqual(len(e.stored()), 2); self.assertEqual(e.kinds(), [])

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


class NightRules(unittest.TestCase):
    """MUST-1 (calendar), SHOULD-2 (night bound to ts), SHOULD-1 (overflow), the stale pass."""
    def refused(self, e, obj, why="night", room="r1"):
        e.canary(obj, room=room); self.assertEqual(e.kinds(room), [], obj["night"])
        inv = e.invalid(room); self.assertEqual(inv[-1]["why"], why, obj["night"]); return inv

    def test_impossible_calendar_dates_are_refused_with_an_audit_line_and_no_case(self):
        for n in ("20260231", "20260230", "20260431", "20250229", "20261301", "20260100", "20260001"):
            for res in ("no_local_rise", "inconclusive:output_absent", "inconclusive:tape_short", "pass"):
                with self.subTest(f'{n} {res}'):
                    e = Env(); self.refused(e, line(res, night=n, ts=night_ts("20261016")))
                    self.assertEqual(len(e.invalid()), 1)
        e = Env(); e.canary(line("no_local_rise", night="20260231", ts=night_ts("20261016"))); e.canary(line("inconclusive:output_absent", night="20260231", ts=night_ts("20261016")))
        self.assertFalse(os.path.exists(os.path.join(e.sub.data, "canary-state.json")))                    # nothing was recorded for a refused line

    def test_a_real_leap_day_is_accepted(self):
        e = Env(); e.canary(line("no_local_rise", night="20240229", ts=night_ts("20240229"))); self.assertEqual(e.kinds(), ["canary_failed"])

    def test_a_poisoned_state_file_is_cleaned_on_load_and_real_nights_still_escalate(self):
        e = Env()
        json.dump({"r1": {"absent_night": "20260231", "opened": {"canary_inconclusive": "20260231", "canary_failed": "20261015", "bogus_kind": "20261015"}}, "r2": "junk", "r3": {"opened": 5}},
                  open(os.path.join(e.sub.data, "canary-state.json"), "w"))
        sub2 = sb.Subscriber(e.sub.data, e.tmp.name, ["r1", "r2"], sb.RouterSink(e.router), e.clock)          # never raises
        self.assertEqual(sub2.canary.state["r1"], {"opened": {"canary_failed": "20261015"}, "absent_night": None})
        audit = [json.loads(l) for l in open(os.path.join(e.sub.data, "canary-state-audit.jsonl"))]
        self.assertEqual({(a["field"], a["room"]) for a in audit}, {("opened", "r1"), ("absent_night", "r1"), ("entry", "r2"), ("opened", "r3")}); self.assertGreaterEqual(len(audit), 5)
        for n in ("20261016", "20261017"): sub2.on_line("kiosk/r1/canary", json.dumps(line("inconclusive:output_absent", night=n)))
        self.assertEqual(e.kinds(), ["canary_inconclusive", "canary_output_absent"])

    def test_an_unreadable_state_file_never_raises(self):
        e = Env(); open(os.path.join(e.sub.data, "canary-state.json"), "w").write("{not json")
        sub2 = sb.Subscriber(e.sub.data, e.tmp.name, ["r1"], sb.RouterSink(e.router), e.clock); self.assertEqual(sub2.canary.state, {})

    def test_night_is_the_ist_night_of_ts_give_or_take_a_day(self):
        self.assertEqual(cr.ist_night_of(night_ts("20261016", 23)), "20261016"); self.assertEqual(cr.ist_night_of(night_ts("20261017", 2)), "20261016")
        self.assertEqual(cr.ist_night_of(night_ts("20261017", 11)), "20261016"); self.assertEqual(cr.ist_night_of(night_ts("20261017", 12)), "20261017")
        e = Env(); self.refused(e, line("no_local_rise", night="20991231", ts=night_ts("20261016")), "night_ts"); self.refused(e, line("no_local_rise", night="20200101", ts=night_ts("20261016")), "night_ts")
        self.refused(e, line("no_local_rise", night="20261018", ts=night_ts("20261016")), "night_ts"); self.refused(e, line("no_local_rise", night="20261013", ts=night_ts("20261016")), "night_ts")

    def test_cross_midnight_runs_are_right(self):
        for hour_date, night, ok in (("20261016", "20261016", True),            # 23:00 on the 16th is the night of the 16th
                                      ("20261017", "20261016", True),            # 02:00 on the 17th is still the night of the 16th
                                      ("20261017", "20261017", True),            # 02:00 on the 17th with the next night: +1 day is allowed
                                      ("20261016", "20261015", True),            # -1 day is allowed
                                      ("20261017", "20261014", False), ("20261016", "20261018", False)):
            with self.subTest(f'{hour_date} {night}'):
                e = Env(); hour = 23 if hour_date == "20261016" else 2
                e.canary(line("no_local_rise", night=night, ts=night_ts(hour_date, hour))); self.assertEqual(e.kinds(), ["canary_failed"] if ok else [])

    def test_a_far_future_night_cannot_freeze_the_streak(self):
        e = Env(); e.canary(line("inconclusive:output_absent", night="20991231", ts=night_ts("20261016")))
        for n in ("20261016", "20261017", "20261018"): e.canary(line("inconclusive:output_absent", night=n))
        self.assertIn("canary_output_absent", e.kinds())

    def test_huge_numbers_are_refused_with_an_audit_line_and_no_raise(self):
        for field in ("ts", "pre_db", "burst_db", "rise_db", "volume"):
            raw = json.dumps(line("no_local_rise")).replace(f'"{field}": {json.dumps(line("no_local_rise")[field])}', f'"{field}": 1' + "0" * 400)
            self.assertIn("0" * 400, raw)
            e = Env(); self.assertTrue(e.canary(None, raw=raw)); self.assertEqual(e.kinds(), [])
            self.assertEqual(e.invalid()[-1]["why"], "ts" if field == "ts" else "number_field", field)
        self.assertFalse(cr._num(10 ** 400)); self.assertFalse(cr._num(-(10 ** 400))); self.assertFalse(cr._num(2 ** 63)); self.assertTrue(cr._num(2 ** 63 - 1)); self.assertFalse(cr._num(float("inf")))

    def test_a_pass_closes_a_case_only_if_its_night_is_not_older(self):
        e = Env(); e.canary(line("no_local_rise", night="20261016")); e.canary(line("inconclusive:tape_short", night="20261016"))
        e.canary(line("pass", night="20261015")); self.assertEqual(e.kinds(), ["canary_failed", "canary_inconclusive"])       # a stale pass closes nothing
        e.canary(line("pass", night="20261016")); self.assertEqual(e.kinds(), [])                                           # the same night closes
        e.canary(line("no_local_rise", night="20261017")); e.canary(line("pass", night="20261018")); self.assertEqual(e.kinds(), [])   # a later night closes

    def test_a_stale_pass_does_not_break_the_streak(self):
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261016")); e.canary(line("pass", night="20261015"))
        e.canary(line("inconclusive:output_absent", night="20261017")); self.assertIn("canary_output_absent", e.kinds())


class ReplayAndAudit(unittest.TestCase):
    """R3: SHOULD-1 (a replayed older night moves nothing), the ts-far audit, N-a, N-b, N-d (M15, M17)."""
    def audit(self, e, room="r1", name="canary-audit"):
        return [json.loads(l) for dp, _d, fs in os.walk(e.sub.data) for f in fs if f == f"{room}.{name}.jsonl" for l in open(os.path.join(dp, f))]

    def test_repro1_a_replayed_older_fail_then_a_stale_pass_does_not_close_the_newer_case(self):
        e = Env(); e.canary(line("no_local_rise", night="20261016")); first = e.open()["canary_failed"]
        e.canary(line("no_local_rise", night="20261014"))                                   # a replayed older fail: audited, folds into nothing
        self.assertEqual(e.open()["canary_failed"]["suppressed_count"], first["suppressed_count"])
        self.assertEqual(e.sub.canary.state["r1"]["opened"]["canary_failed"], "20261016")   # the stored night did not move backwards
        e.canary(line("pass", night="20261015")); self.assertEqual(e.kinds(), ["canary_failed"])      # the stale pass closes nothing
        self.assertEqual([(a["event"], a["night"], a["stored"]) for a in self.audit(e) if a["event"] == "stale_night"], [("stale_night", "20261014", "20261016")])

    def test_repro2_no_reopen_after_an_ack_through_a_replayed_older_line(self):
        e = Env(); e.canary(line("no_local_rise", night="20261016")); first = e.open()["canary_failed"]["first_id"]
        e.router.close_room(None, "r1", "ACK", kind="canary_failed"); self.assertEqual(e.kinds(), [])
        e.canary(line("no_local_rise", night="20261015")); self.assertEqual(e.kinds(), [])              # the older night opens nothing
        e.canary(line("no_local_rise", night="20261016")); self.assertEqual(e.kinds(), [])              # and the same night still does not re-open
        e.canary(line("no_local_rise", night="20261017")); self.assertEqual(e.kinds(), ["canary_failed"])

    def test_an_older_inconclusive_moves_nothing_not_even_the_streak(self):
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261016")); e.canary(line("inconclusive:output_absent", night="20261014"))
        self.assertEqual(e.sub.canary.state["r1"]["absent_night"], "20261016"); self.assertEqual(e.sub.canary.state["r1"]["opened"], {"canary_inconclusive": "20261016"})
        e.canary(line("inconclusive:output_absent", night="20261017")); self.assertIn("canary_output_absent", e.kinds())

    def test_a_replayed_older_other_reason_does_not_break_the_streak(self):
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261016")); e.canary(line("inconclusive:tape_short", night="20261014"))
        self.assertEqual(e.sub.canary.state["r1"]["absent_night"], "20261016")
        e.canary(line("inconclusive:output_absent", night="20261017")); self.assertIn("canary_output_absent", e.kinds())

    def test_the_stored_night_only_moves_forward(self):
        e = Env()
        for n in ("20261014", "20261015", "20261016", "20261015", "20261014"): e.canary(line("no_local_rise", night=n))
        self.assertEqual(e.sub.canary.state["r1"]["opened"]["canary_failed"], "20261016")

    def test_na_the_loader_audits_each_dropped_entry_and_a_non_dict_file(self):
        for body, want in (('{"r1": "garbage", "r2": 5, "r3": ["x"]}', {("entry", "r1"), ("entry", "r2"), ("entry", "r3")}), ('["list"]', {("file", "-")}), ('"str"', {("file", "-")}),
                           ("null", {("file", "-")}), ('{"r1": {"opened": 5, "absent_night": "20261016"}}', {("opened", "r1")})):
            with self.subTest(body):
                e = Env(); open(os.path.join(e.sub.data, "canary-state.json"), "w").write(body)
                sub2 = sb.Subscriber(e.sub.data, e.tmp.name, ["r1"], sb.RouterSink(e.router), e.clock)
                got = [json.loads(l) for l in open(os.path.join(e.sub.data, "canary-state-audit.jsonl"))]
                self.assertEqual({(a["field"], a["room"]) for a in got}, want); self.assertEqual(len(got), len(want))
                if "absent_night" in body: self.assertEqual(sub2.canary.state["r1"], {"opened": {}, "absent_night": "20261016"})   # the valid absent_night survives

    def test_nb_a_non_json_canary_line_gets_one_audit_line_and_is_not_stored(self):
        for raw in ("not json", "{broken", ""):          # (the 5000-digit integer is now over STREAM_MAX_BYTES: an oversize audit row, see test_stream_cap)
            with self.subTest(raw[:12]):
                e = Env(); self.assertFalse(e.canary(None, raw=raw)); self.assertEqual(e.stored(), []); self.assertEqual(e.kinds(), [])
                inv = e.invalid(); self.assertEqual([i["why"] for i in inv], ["not_json"]); self.assertEqual(set(inv[0]), {"ts", "room", "why"})

    def test_nd_m15_an_exception_that_is_not_oserror_or_valueerror_in_the_loader_is_caught(self):
        e = Env(); open(os.path.join(e.sub.data, "canary-state.json"), "w").write("[" * 200000 + "]" * 200000)       # deep nesting raises RecursionError
        sub2 = sb.Subscriber(e.sub.data, e.tmp.name, ["r1"], sb.RouterSink(e.router), e.clock)                  # must not raise
        self.assertEqual(sub2.canary.state, {}); self.assertEqual([json.loads(l)["field"] for l in open(os.path.join(e.sub.data, "canary-state-audit.jsonl"))], ["file"])

    def test_nd_m17_a_ts_that_is_a_valid_int_but_out_of_datetime_range_is_refused(self):
        for ts in (10 ** 15, 2 ** 62, 10 ** 12):
            with self.subTest(ts):
                e = Env(); e.canary(line("no_local_rise", ts=ts)); self.assertEqual(e.kinds(), []); self.assertEqual(e.invalid()[-1]["why"], "ts")
        self.assertIsNone(cr.ist_night_of(10 ** 15))


H36 = 36 * 3600


def skew_line(result, ts, **kw):
    """A kiosk line whose ts and night agree with each other (a real producer with a skewed clock), whatever the Mini clock says."""
    return line(result, night=cr.ist_night_of(ts), ts=ts, **kw)


class ClockSkew(unittest.TestCase):
    """R4 MUST-1: a ts more than 36 h from the Mini clock (either direction) is stored and audited ONLY; it moves no state. Exactly 36 h acts, 36 h + 1 s does not."""
    def far_audits(self, e):
        return [a for dp, _d, fs in os.walk(e.sub.data) for f in fs if f == "r1.canary-audit.jsonl" for l in open(os.path.join(dp, f)) for a in [json.loads(l)] if a["event"] == "ts_far"]

    def genuine_week(self, e):
        """7 genuine nights from the Mini's own clock: every fail opens canary_failed, every pass closes it."""
        for i in range(7):
            night = (datetime.strptime("20261016", "%Y%m%d") + __import__("datetime").timedelta(days=i)).strftime("%Y%m%d")
            e.canary(line("no_local_rise", night=night)); self.assertEqual(e.kinds(), ["canary_failed"], night)
            e.canary(line("pass", night=night)); self.assertEqual(e.kinds(), [], night)

    def test_forward_dated_lines_open_nothing_move_nothing_and_do_not_mute_genuine_nights(self):
        for label, skew in (("+400 d", 400 * 86400), ("+72 h", 72 * 3600), ("+40 h", 40 * 3600)):
            for res in ("no_local_rise", "inconclusive:output_absent", "inconclusive:tape_short", "pass", "would_do"):
                with self.subTest(f"{label} {res}"):
                    e = Env(); e.clock.t = NIGHT_T
                    e.canary(skew_line(res, int(NIGHT_T) + skew), sync=False)
                    self.assertEqual(e.kinds(), []); self.assertEqual(e.sub.canary.state, {}); self.assertEqual(len(self.far_audits(e)), 1)
                    self.assertFalse(os.path.exists(os.path.join(e.sub.data, "canary-state.json")))
                    self.assertEqual(e.invalid(), []); self.assertEqual(len(e.stored()), 1)                       # stored
                    self.genuine_week(e)
                    self.assertEqual(e.sub.canary.state["r1"]["opened"]["canary_failed"], "20261022")

    def test_a_backward_dated_line_behaves_the_same(self):
        for res in ("no_local_rise", "inconclusive:output_absent", "pass"):
            with self.subTest(res):
                e = Env(); e.clock.t = NIGHT_T; e.canary(skew_line(res, int(NIGHT_T) - 40 * 3600), sync=False)
                self.assertEqual(e.kinds(), []); self.assertEqual(e.sub.canary.state, {}); self.assertEqual(len(self.far_audits(e)), 1); self.genuine_week(e)

    def test_a_far_line_cannot_touch_existing_state_or_the_streak(self):
        e = Env(); e.canary(line("inconclusive:output_absent", night="20261016")); before = json.dumps(e.sub.canary.state, sort_keys=True)
        for ts in (int(NIGHT_T) + 72 * 3600, int(NIGHT_T) - 72 * 3600):
            for res in ("pass", "no_local_rise", "inconclusive:tape_short", "inconclusive:output_absent"):
                e.clock.t = NIGHT_T; e.canary(skew_line(res, ts), sync=False)
        self.assertEqual(json.dumps(e.sub.canary.state, sort_keys=True), before); self.assertEqual(e.kinds(), ["canary_inconclusive"])
        e.canary(line("inconclusive:output_absent", night="20261017")); self.assertIn("canary_output_absent", e.kinds())      # the genuine streak still escalates

    def test_the_far_check_runs_before_the_stale_night_check(self):
        e = Env(); e.canary(line("no_local_rise", night="20261016")); e.clock.t = NIGHT_T
        e.canary(skew_line("no_local_rise", int(NIGHT_T) - 72 * 3600), sync=False)
        ev = [a["event"] for dp, _d, fs in os.walk(e.sub.data) for f in fs if f == "r1.canary-audit.jsonl" for l in open(os.path.join(dp, f)) for a in [json.loads(l)]]
        self.assertEqual(ev, ["ts_far"])                                                                          # not stale_night

    def test_the_36_h_boundary_exactly_36_h_acts_36_h_plus_1_s_is_audit_only_in_both_directions(self):
        for sign in (1, -1):
            for delta, acts in ((H36 - 1, True), (H36, True), (H36 + 1, False)):
                with self.subTest(f"{'+' if sign > 0 else '-'}{delta}"):
                    e = Env(); e.clock.t = NIGHT_T; e.canary(skew_line("no_local_rise", int(NIGHT_T) + sign * delta), sync=False)
                    self.assertEqual(e.kinds(), ["canary_failed"] if acts else []); self.assertEqual(len(self.far_audits(e)), 0 if acts else 1)

    def test_poisoned_state_a_stored_night_more_than_36_h_ahead_is_dropped_on_load(self):
        e = Env()                                                                                               # the Mini clock is 16 Oct 23:00 IST
        json.dump({"r1": {"absent_night": "20271120", "opened": {"canary_failed": "20271120", "canary_inconclusive": "20261016", "canary_output_absent": "20261019"}},
                   "r2": {"absent_night": "20261018", "opened": {"canary_failed": "20261018"}}}, open(os.path.join(e.sub.data, "canary-state.json"), "w"))
        sub2 = sb.Subscriber(e.sub.data, e.tmp.name, ["r1", "r2"], sb.RouterSink(e.router), e.clock)
        self.assertEqual(sub2.canary.state["r1"], {"opened": {"canary_inconclusive": "20261016"}, "absent_night": None})
        self.assertEqual(sub2.canary.state["r2"], {"opened": {"canary_failed": "20261018"}, "absent_night": "20261018"})     # 18 Oct is the newest night a genuine line can carry: kept
        got = sorted((a["field"], a["room"]) for a in (json.loads(l) for l in open(os.path.join(e.sub.data, "canary-state-audit.jsonl"))))
        self.assertEqual(got, [("absent_night_future", "r1"), ("opened_future", "r1"), ("opened_future", "r1")])
        sub2.on_line("kiosk/r1/canary", json.dumps(line("no_local_rise", night="20261016"))); self.assertEqual(e.kinds(), ["canary_failed"])          # the room is not silenced


def r16d(result, day, slot, hhmm, plays=2, over=None):
    """A kiosk R16d line: ts inside the slot (pm 21:40 or am 07:20 IST on `day`), `night` = the IST date of the slot (as the kiosk's ist_date()), the four new fields appended."""
    from datetime import timedelta
    t = datetime.strptime(day, "%Y%m%d").replace(hour=int(hhmm[:2]), minute=int(hhmm[2:]), tzinfo=ar.IST)
    play = {"pre_db": -60.0, "burst_db": -40.5, "rise_db": 19.5, "pre_db_band": -70.2, "burst_db_band": -45.1, "rise_db_band": 25.1, "pass_broadband": True}
    d = line(result, night=day, ts=int(t.timestamp()), slot=slot, pass_db=6.0, plays=[dict(play) for _ in range(plays)], pass_db_band=10.0)
    d.update(over or {}); return d


def nxt(day, n=1):
    from datetime import timedelta
    return (datetime.strptime(day, "%Y%m%d") + timedelta(days=n)).strftime("%Y%m%d")


class R16dLine(unittest.TestCase):
    """R5: the R16d line (slot, pass_db, plays, pass_db_band) is accepted beside the R15c one; one clinical night per 21:40 + 07:20 pair."""
    def test_both_shapes_are_accepted_and_the_plays_are_stored_as_sent(self):
        e = Env(); old = line("no_local_rise", night="20261016"); new = r16d("no_local_rise", "20261017", "am", "0720")
        self.assertTrue(e.canary(old)); self.assertTrue(e.canary(new)); self.assertEqual(e.invalid(), [])
        stored = [json.loads(l) for l in e.stored()]; self.assertEqual(len(stored), 2); self.assertEqual(stored[1]["plays"], new["plays"]); self.assertEqual(len(stored[1]["plays"]), 2)
        self.assertEqual(stored[1]["slot"], "am"); self.assertEqual(stored[1]["pass_db_band"], 10.0)

    def test_every_result_and_the_field_variants_are_accepted(self):
        for res in ("pass", "no_local_rise", "would_do", "inconclusive:output_absent", "inconclusive:tape_unreadable", "inconclusive:play_timeout", "inconclusive:state_corrupt"):
            for n_plays in (0, 1, 2):
                for kw in ({}, {"slot": None}, {"pass_db": None}, {"pass_db_band": None}, {"install_id": None, "volume": None, "pre_db": None, "burst_db": None, "rise_db": None}):
                    with self.subTest(f"{res} {n_plays} {sorted(kw)}"):
                        e = Env(); e.canary(r16d(res, "20261016", "pm", "2140", plays=n_plays, over=kw)); self.assertEqual(e.invalid(), [])
        e = Env(); d = r16d("pass", "20261016", "pm", "2140"); d["plays"][0].update(pre_db=None, burst_db=None, rise_db=None, pre_db_band=None, burst_db_band=None, rise_db_band=None, pass_broadband=None)
        e.canary(d); self.assertEqual(e.invalid(), [])

    def test_a_malformed_r16d_line_gets_an_audit_line_and_no_case(self):
        base = r16d("no_local_rise", "20261016", "pm", "2140")
        def without(k):
            d = dict(base); d.pop(k); return d
        def play(**kw):
            d = dict(base); p = dict(base["plays"][0]); p.update(kw); d["plays"] = [p]; return d
        cases = [("keys", dict(base, extra=1)), ("keys", without("slot")), ("keys", without("plays")), ("keys", without("pass_db")), ("keys", without("pass_db_band")),
                 ("slot", dict(base, slot="noon")), ("slot", dict(base, slot="PM")), ("slot", dict(base, slot=5)), ("slot", dict(base, slot="")),
                 ("number_field", dict(base, pass_db="x")), ("number_field", dict(base, pass_db=True)), ("number_field", dict(base, pass_db_band=[1])),
                 ("plays", dict(base, plays="x")), ("plays", dict(base, plays=None)), ("plays", dict(base, plays=base["plays"] * 2 + base["plays"])), ("plays", dict(base, plays=[1])),
                 ("plays", dict(base, plays=[{"pre_db": 1}])), ("plays", play(extra=1)), ("plays", play(pre_db="1")), ("plays", play(rise_db_band=True)),
                 ("plays", play(pass_broadband="true")), ("plays", play(pass_broadband=1)), ("plays", play(burst_db=10 ** 400))]
        for why, obj in cases:
            with self.subTest(f"{why} {str(obj)[-40:]}"):
                e = Env()
                e.canary(obj); self.assertEqual(e.kinds(), [], why); self.assertEqual(e.invalid()[-1]["why"], why)
        raw = json.dumps(base); e = Env(); e.canary(None, raw=raw.replace('"pre_db": -60.0', '"pre_db": NaN', 1)); self.assertEqual(e.kinds(), []); self.assertEqual(e.invalid()[-1]["why"], "number_field")
        i = raw.index('"pre_db": -60.0', raw.index('"plays"')); e = Env(); e.canary(None, raw=raw[:i] + '"pre_db": NaN' + raw[i + len('"pre_db": -60.0'):]); self.assertEqual(e.kinds(), []); self.assertEqual(e.invalid()[-1]["why"], "plays")

    def test_the_two_slots_of_one_night_are_one_night_for_the_output_absent_streak(self):
        e = Env()
        e.canary(r16d("inconclusive:output_absent", "20261016", "pm", "2140")); e.canary(r16d("inconclusive:output_absent", "20261017", "am", "0720"))
        self.assertEqual(e.kinds(), ["canary_inconclusive"])                                    # 21:40 on the 16th and 07:20 on the 17th: the SAME night, no escalation
        self.assertEqual(e.sub.canary.state["r1"]["absent_night"], "20261016"); self.assertEqual(e.sub.canary.state["r1"]["opened"], {"canary_inconclusive": "20261016"})

    def test_two_consecutive_real_nights_escalate(self):
        for seq in ((("20261016", "pm", "2140"), ("20261017", "pm", "2140")),                    # pm then pm
                    (("20261016", "pm", "2140"), ("20261017", "am", "0720"), ("20261017", "pm", "2140")),     # the second night's first slot is its pm
                    (("20261016", "am", "0720"), ("20261016", "pm", "2140"))):                  # am of the 16th is the night of the 15th, pm of the 16th is the night of the 16th
            with self.subTest(str(seq)):
                e = Env()
                for day, slot, hhmm in seq: e.canary(r16d("inconclusive:output_absent", day, slot, hhmm))
                self.assertEqual(e.kinds(), ["canary_inconclusive", "canary_output_absent"])

    def test_a_skipped_night_does_not_escalate(self):
        e = Env(); e.canary(r16d("inconclusive:output_absent", "20261016", "pm", "2140")); e.canary(r16d("inconclusive:output_absent", "20261018", "pm", "2140"))
        self.assertEqual(e.kinds(), ["canary_inconclusive"])

    def test_a_pass_in_the_am_slot_closes_a_pm_fail_of_the_same_night(self):
        e = Env(); e.canary(r16d("no_local_rise", "20261016", "pm", "2140")); self.assertEqual(e.kinds(), ["canary_failed"])
        e.canary(r16d("pass", "20261017", "am", "0720")); self.assertEqual(e.kinds(), [])
        e = Env(); e.canary(r16d("no_local_rise", "20261016", "pm", "2140")); e.canary(r16d("pass", "20261016", "am", "0720"))     # the am slot of the 16th is the PREVIOUS night: a stale pass
        self.assertEqual(e.kinds(), ["canary_failed"])

    def test_one_case_per_night_across_both_slots_even_after_an_ack(self):
        e = Env(); e.canary(r16d("no_local_rise", "20261016", "pm", "2140")); first = e.open()["canary_failed"]["first_id"]
        e.canary(r16d("no_local_rise", "20261017", "am", "0720")); self.assertEqual(e.open()["canary_failed"]["first_id"], first); self.assertEqual(e.open()["canary_failed"]["suppressed_count"], 0)
        e.router.close_room(None, "r1", "ACK", kind="canary_failed"); e.canary(r16d("no_local_rise", "20261017", "am", "0720")); self.assertEqual(e.kinds(), [])      # not re-opened this night
        e.canary(r16d("no_local_rise", "20261017", "pm", "2140")); self.assertEqual(e.kinds(), ["canary_failed"])                                                  # the next night opens

    def test_the_replay_and_clock_skew_guards_hold_with_slot_lines(self):
        e = Env(); e.canary(r16d("no_local_rise", "20261016", "pm", "2140"))
        e.canary(r16d("no_local_rise", "20261014", "pm", "2140"), sync=False)                    # a replayed older slot line (far from the clock: audit only)
        e.canary(r16d("pass", "20261015", "pm", "2140"), sync=False); self.assertEqual(e.kinds(), ["canary_failed"])
        e2 = Env(); e2.clock.t = r16d("pass", "20261016", "pm", "2140")["ts"]
        e2.canary(r16d("no_local_rise", "20261018", "pm", "2140"), sync=False)                   # forward-dated by more than 36 h: audit only
        self.assertEqual(e2.kinds(), []); self.assertEqual(e2.sub.canary.state, {})
        e2.canary(r16d("no_local_rise", "20261016", "pm", "2140")); self.assertEqual(e2.kinds(), ["canary_failed"])
        e3 = Env(); e3.canary(r16d("no_local_rise", "20261016", "pm", "2140")); e3.canary(r16d("no_local_rise", "20261016", "pm", "2140"))    # the same slot line twice: one case
        self.assertEqual(e3.open()["canary_failed"]["suppressed_count"], 0)

    def test_the_verdict_is_the_kiosks_the_mini_does_not_recompute_it(self):
        e = Env(); d = r16d("pass", "20261016", "pm", "2140"); d["plays"][0]["pass_broadband"] = False; d["plays"][0]["rise_db_band"] = -5.0
        e.canary(d); self.assertEqual(e.kinds(), [])                                             # result pass stays a pass whatever the plays say
        e = Env(); d = r16d("no_local_rise", "20261016", "pm", "2140"); e.canary(d); self.assertEqual(e.kinds(), ["canary_failed"])


class Aborted(unittest.TestCase):
    """R5 addendum (R16d-3): result aborted:<why>, eight fixed reasons; NORMAL-tier canary_inconclusive, never canary_failed, neutral for the output_absent streak."""
    WHY = ("outside_window", "consult_not_clear", "hid_unreadable", "hid_active", "recorder_failed", "recorder_busy", "not_recording", "tape_not_advancing")

    def test_each_of_the_eight_reasons_opens_a_normal_tier_canary_inconclusive_and_never_canary_failed(self):
        self.assertEqual(cr.ABORT_WHY, self.WHY)
        for why in self.WHY:
            for plays in (0, 1):
                with self.subTest(f"{why} {plays}"):
                    e = Env(); e.canary(r16d(f"aborted:{why}", "20261016", "pm", "2140", plays=plays)); self.assertEqual(e.invalid(), [])
                    self.assertEqual(e.kinds(), ["canary_inconclusive"]); self.assertNotIn("canary_failed", e.kinds())
                    e.router.tick(e.bus)
                    for m in e.bus.real: self.assertNotEqual(m["priority"], "urgent")
                    e.clock.adv(5 * 3600); e.router.tick(e.bus); self.assertEqual(e.v_texts(), [])

    def test_anything_else_is_invalid(self):
        for res in ("aborted:", "aborted", "aborted:window", "aborted:consult", "aborted:hid", "aborted:speech", "aborted:tape", "aborted:recorder", "aborted:Outside_Window",
                    "aborted:outside_window2", "aborted: outside_window", "aborted:outside_window ", "ABORTED:outside_window", "aborted:outside_window:x", "aborted:heal_rate", "aborted:already_tonight"):
            with self.subTest(res):
                e = Env(); e.canary(r16d(res, "20261016", "pm", "2140")); self.assertEqual(e.kinds(), []); self.assertEqual(e.invalid()[-1]["why"], "result")

    def test_an_aborted_line_must_be_r16d_and_name_its_slot(self):
        e = Env(); e.canary(r16d("aborted:hid_active", "20261016", "pm", "2140", over={"slot": None})); self.assertEqual(e.kinds(), []); self.assertEqual(e.invalid()[-1]["why"], "slot")
        e = Env(); e.canary(line("aborted:hid_active", night="20261016")); self.assertEqual(e.kinds(), []); self.assertEqual(e.invalid()[-1]["why"], "slot")        # the R15c shape has no slot
        for slot in ("noon", "AM"):
            e = Env(); e.canary(r16d("aborted:hid_active", "20261016", "pm", "2140", over={"slot": slot})); self.assertEqual(e.kinds(), [])
        e = Env(); e.canary(r16d("aborted:hid_active", "20261016", "am", "0720")); self.assertEqual(e.kinds(), ["canary_inconclusive"])

    def test_an_aborted_slot_does_not_count_toward_the_output_absent_streak(self):
        e = Env(); e.canary(r16d("aborted:hid_active", "20261016", "pm", "2140")); e.canary(r16d("aborted:recorder_busy", "20261017", "pm", "2140"))
        self.assertEqual(e.kinds(), ["canary_inconclusive"]); self.assertIsNone(e.sub.canary.state["r1"]["absent_night"])                                       # two aborted nights: no streak, no escalation
        e = Env(); e.canary(r16d("inconclusive:output_absent", "20261016", "pm", "2140")); e.canary(r16d("aborted:hid_active", "20261017", "pm", "2140"))
        self.assertNotIn("canary_output_absent", e.kinds()); e.canary(r16d("inconclusive:output_absent", "20261018", "pm", "2140"))
        self.assertNotIn("canary_output_absent", e.kinds())                                    # absent on the 16th, absent on the 18th: not consecutive nights

    def test_an_aborted_slot_does_not_break_a_streak_either(self):
        e = Env(); e.canary(r16d("inconclusive:output_absent", "20261016", "pm", "2140")); e.canary(r16d("aborted:hid_active", "20261017", "am", "0720"))     # the same night as the pm slot
        self.assertEqual(e.sub.canary.state["r1"]["absent_night"], "20261016")
        e.canary(r16d("inconclusive:output_absent", "20261017", "pm", "2140")); self.assertIn("canary_output_absent", e.kinds())

    def test_aborted_then_a_pass_closes_the_case_and_the_guards_hold(self):
        e = Env(); e.canary(r16d("aborted:tape_not_advancing", "20261016", "pm", "2140")); e.canary(r16d("pass", "20261017", "am", "0720")); self.assertEqual(e.kinds(), [])
        e = Env(); e.canary(r16d("aborted:tape_not_advancing", "20261016", "pm", "2140")); e.canary(r16d("aborted:tape_not_advancing", "20261014", "pm", "2140"), sync=False)
        e.canary(r16d("pass", "20261015", "pm", "2140"), sync=False); self.assertEqual(e.kinds(), ["canary_inconclusive"])                                      # replayed older lines move nothing
        e = Env(); e.clock.t = r16d("pass", "20261016", "pm", "2140")["ts"]; e.canary(r16d("aborted:hid_active", "20261019", "pm", "2140"), sync=False)    # far forward: audit only
        self.assertEqual(e.kinds(), []); self.assertEqual(e.sub.canary.state, {})

    def test_a_kill_or_mode_change_between_plays_still_gives_would_do(self):
        e = Env(); e.canary(r16d("would_do", "20261016", "pm", "2140", plays=1, over={"mode": "shadow"})); self.assertEqual(e.kinds(), []); self.assertEqual(e.invalid(), [])


class Shadow(unittest.TestCase):
    def test_a_canary_line_only_opens_or_closes_cases_never_acts(self):
        class Spy:
            def __init__(self): self.calls = []
            def __getattr__(self, n): return lambda *a, **k: self.calls.append(n)
        spy = Spy(); s = sb.Subscriber(os.path.join(Env().tmp.name, "d"), "/tmp", ["r1"], spy, lambda: NIGHT_T)
        for r in ("pass", "would_do", "no_local_rise", "inconclusive:output_absent"): s.on_line("kiosk/r1/canary", json.dumps(line(r)))
        self.assertEqual(sorted(set(spy.calls)), ["canary_case", "canary_close"])


LAST_ERROR_80 = ("exec failed: code 78 (bad config) at /x/y; retry in 30s" + " " * 40)[:80]            # R16d: sanitised, up to 80 printable characters


def rec_line(reason, severity="page", shadow=False, **kw):
    """The kiosk escalate() shape (heal.sh escalate -> heal_event), as R16d emits recorder_failed: no `kind`, layer recorder, action escalate, result escalated."""
    d = {"room_id": "r1", "ts": 1760000000, "action": "escalate", "layer": "recorder", "reason": reason,
         "before": "state=failed last_error=" + LAST_ERROR_80 if reason == "recorder_failed" else "pid=none state=null", "after": "", "result": "escalated", "shadow": shadow,
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
