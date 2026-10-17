"""S3 Mini side (plan gap G1), FIX ROUND: SENTINEL-CONSULT-OPEN-SPEC-17OCT.md is BINDING (fable). Spec §5 cases 1-13, including mutants (a) a stale
heartbeat returning false instead of absent, (b) a prefix machine match, (c) a medium confidence allowing a heal. Rule (spec §2): true = post_open
(high) or url_open (MEDIUM); false = post_close / url_close (high) or no_event (medium — an open older than OPEN_UNCLOSED_MAX_S with no close, a future
open, or no event at all is FALSE, not absent); absent (never true) = unmapped / presence_stale (with several machines ALL must be fresh) / db_error
(any DB error takes the WHOLE map) / snapshot_stale (a snapshot older than 60 s). The WIRE map is bools only (form 3); the status record (source and
confidence per the spec table) is bench/audit only at <home>/state/consult_live.jsonl, written before the wire flag is ever on. heal_eligible(): a
medium-confidence entry NEVER may drive a heal."""
import json, os, re, sys, tempfile, unittest
from datetime import datetime, timezone
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "subscriber")); sys.path.insert(0, os.path.join(HERE, "..", "router"))
import subscriber as sb
import consult_hold as ch
import ubus_bus
from test_subscriber import Clock
from test_dprime import Src, Sink, MAP, ROOMS, T, KIOSK_RE_OLD, KIOSK_RE_V2, mk

KIOSK_RE_V3 = (r'^\{"consult_live": \{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}, '
                r'"consult_open": \{("[a-z0-9_-]{1,64}": (true|false)(, "[a-z0-9_-]{1,64}": (true|false)){0,63})?\}, '
                r'"kill": (true|false), "modes": \{("[a-z0-9_-]{1,64}": "(shadow|heal)"(, "[a-z0-9_-]{1,64}": "(shadow|heal)"){0,63})?\}, "ts": [1-9][0-9]{0,14}\}$')


def iso(v):
    return datetime.fromtimestamp(v, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def presence(hb=(("M6", T - 5, 0), ("M7", T - 5, 1)), post=(), enc=()):
    """A full presence source value (all three PRESENCE_KEYS), one newest row per machine per query, each row carrying the server id:
    hb (machine, ts_epoch, id), enc/post (machine, event, ts_epoch, id). The id — not the doctor-clock ts — is the newest across machines (refute I-2)."""
    return {"hb": list(hb), "enc": list(enc), "post": list(post)}


def open_at(ts, m="M6", i=10):
    return [(m, "encounter_open", ts, i)]


def close_at(ts, m="M6", i=10):
    return [(m, "encounter_close", ts, i)]


def eopen_at(ts, m="M6", i=10):
    return [(m, "encounter_open", ts, i)]


def eclose_at(ts, m="M6", i=10):
    return [(m, "encounter_close", ts, i)]


def live3(src, **kw):
    h, _, _ = mk(src, **kw)
    return h.live(), h.hold(), h._live_records, h


class SpecRuleTable(unittest.TestCase):
    """Spec §5 cases 1-11, one test per case (numbered in the name). consult_open is asserted alongside to pin that it is UNCHANGED."""

    def test_case_01_fresh_post_open_is_true_high(self):
        lv, hold, rec, _ = live3(Src(presence=presence(post=open_at(T - 30))))
        self.assertEqual(lv, {"opd-6": True, "opd-7": False})                          # opd-7: fresh heartbeat, no open in the window: false, never absent
        self.assertEqual(hold, {"opd-6": True, "opd-7": False})
        self.assertEqual((rec["opd-6"]["consult_live"], rec["opd-6"]["source"], rec["opd-6"]["confidence"], rec["opd-6"]["event_ts"], rec["opd-6"]["room_id"]),
                         (True, "post_open", "high", T - 30, "b6"))
        self.assertEqual(rec["opd-6"]["hb_age_s"], T - (T - 5))
        self.assertEqual((rec["opd-7"]["consult_live"], rec["opd-7"]["source"], rec["opd-7"]["confidence"], rec["opd-7"]["event_ts"]),
                         (False, "no_event", "medium", None))

    def test_case_02_a_url_open_only_is_true_medium(self):
        lv, hold, rec, _ = live3(Src(presence=presence(post=(), enc=eopen_at(T - 30))))
        self.assertEqual(lv, {"opd-6": True, "opd-7": False})
        self.assertEqual(hold, {"opd-6": True, "opd-7": False})                        # the hold also reads the enc open: unchanged
        self.assertEqual((rec["opd-6"]["consult_live"], rec["opd-6"]["source"], rec["opd-6"]["confidence"], rec["opd-6"]["event_ts"]),
                         (True, "url_open", "medium", T - 30))

    def test_case_03_fresh_closes_are_false_high(self):
        lv, hold, rec, _ = live3(Src(presence=presence(post=close_at(T - 30, "M6", 10) + close_at(T - 30, "M7", 11))))
        self.assertEqual(lv, {"opd-6": False, "opd-7": False})
        self.assertEqual(hold, {"opd-6": False, "opd-7": False})
        for r in ROOMS:
            self.assertEqual((rec[r]["consult_live"], rec[r]["source"], rec[r]["confidence"], rec[r]["event_ts"]), (False, "post_close", "high", T - 30))
        lv, _, rec, _ = live3(Src(presence=presence(post=(), enc=eclose_at(T - 30, "M6", 10) + eclose_at(T - 30, "M7", 11))))
        self.assertEqual(lv, {"opd-6": False, "opd-7": False})
        for r in ROOMS:
            self.assertEqual((rec[r]["consult_live"], rec[r]["source"], rec[r]["confidence"]), (False, "url_close", "high"))

    def test_case_04_a_post_open_survives_a_later_url_close(self):
        lv, hold, rec, _ = live3(Src(presence=presence(post=open_at(T - 3 * 3600), enc=eclose_at(T - 3600))))
        self.assertEqual(lv, {"opd-6": True, "opd-7": False})
        self.assertEqual(hold, {"opd-6": True, "opd-7": False})
        self.assertEqual((rec["opd-6"]["consult_live"], rec["opd-6"]["source"], rec["opd-6"]["confidence"], rec["opd-6"]["event_ts"]),
                         (True, "post_open", "high", T - 3 * 3600))                    # the later URL close does not end the consult

    def test_case_05_stale_121s_is_absent_and_120s_is_fresh(self):
        """MUTANT (a): a stale heartbeat returning false instead of absent must fail this test."""
        lv, _, rec, _ = live3(Src(presence=presence(hb=(("M6", T - 121, 0), ("M7", T - 5, 1)), post=open_at(T - 30, "M6", 10) + close_at(T - 30, "M7", 11))))
        self.assertEqual(lv, {"opd-7": False})                                          # opd-6 (hb 121 s old > 120 s) is ABSENT, not false
        self.assertEqual((rec["opd-6"]["consult_live"], rec["opd-6"]["source"], rec["opd-6"]["confidence"], rec["opd-6"]["hb_age_s"]),
                         (None, "presence_stale", None, T - (T - 121)))
        lv, _, _, _ = live3(Src(presence=presence(hb=(("M6", T - 120, 0), ("M7", T - 5, 1)), post=open_at(T - 30))))
        self.assertEqual(lv, {"opd-6": True, "opd-7": False})                           # exactly 120 s old: still fresh

    def test_case_06_two_machine_room_one_stale_is_absent(self):
        rmap = {"opd-7": {"machine": ["M7", "M7b"], "room_id": "b7", "slug": "s7"}}
        lv, _, rec, _ = live3(Src(presence=presence(hb=(("M7", T - 5, 0), ("M7b", T - 121, 1)), post=open_at(T - 30, "M7"))), rooms=["opd-7"], rmap=rmap)
        self.assertEqual(lv, {})                                                        # ALL machines must be fresh, else absent
        self.assertEqual((rec["opd-7"]["consult_live"], rec["opd-7"]["source"]), (None, "presence_stale"))
        lv, _, rec, _ = live3(Src(presence=presence(hb=(("M7", T - 5, 0), ("M7b", T - 5, 1)), post=[("M7", "encounter_close", T - 100, 0), ("M7b", "encounter_open", T - 50, 1)])),
                              rooms=["opd-7"], rmap=rmap)
        self.assertEqual(lv, {"opd-7": True})                                           # the newest POST row across the machines decides
        self.assertEqual((rec["opd-7"]["source"], rec["opd-7"]["confidence"]), ("post_open", "high"))

    def test_case_06b_newest_across_machines_is_by_server_id_not_ts(self):
        """Spec review (3): with several machines the newest deciding row is the highest p.id (server insert order, refute I-2), NOT the max ts — a machine
        whose clock runs fast must not read as the newest. A ts-based selection (the R2 code) must fail this test, on the POST side and the URL (enc) side."""
        rmap = {"opd-7": {"machine": ["M7", "M6"], "room_id": "b7", "slug": "s7"}}
        # M6's clock runs 50 s fast: its open (ts T-60) is OLDER than M7's close (ts T-10), but it was inserted later (id 200 > 100)
        lv, _, rec, _ = live3(Src(presence=presence(hb=(("M7", T - 5, 0), ("M6", T - 5, 1)),
                                                       post=[("M7", "encounter_close", T - 10, 100), ("M6", "encounter_open", T - 60, 200)])),
                              rooms=["opd-7"], rmap=rmap)
        self.assertEqual(lv, {"opd-7": True})
        self.assertEqual((rec["opd-7"]["source"], rec["opd-7"]["event_ts"]), ("post_open", T - 60))
        lv, _, rec, _ = live3(Src(presence=presence(hb=(("M7", T - 5, 0), ("M6", T - 5, 1)),
                                                       enc=[("M7", "encounter_close", T - 10, 100), ("M6", "encounter_open", T - 60, 200)])),
                              rooms=["opd-7"], rmap=rmap)
        self.assertEqual(lv, {"opd-7": True})
        self.assertEqual((rec["opd-7"]["source"], rec["opd-7"]["confidence"]), ("url_open", "medium"))

    def test_case_07_a_db_error_takes_the_whole_map(self):
        lv, hold, rec, _ = live3(Src(presence=RuntimeError("neon down")))
        self.assertEqual(lv, {})
        self.assertEqual(hold, {"opd-6": True, "opd-7": True})                          # consult_open unchanged: fail closed
        for r, rid in (("opd-6", "b6"), ("opd-7", "b7")):
            self.assertEqual((rec[r]["consult_live"], rec[r]["source"], rec[r]["room_id"]), (None, "db_error", rid))
        lv, hold, rec, _ = live3(Src(presence=presence(post=open_at(T - 30)), session=RuntimeError("session down")))
        self.assertEqual(lv, {})                                                        # ANY DB source, not just presence
        self.assertEqual(hold, {"opd-6": True, "opd-7": True})
        self.assertEqual(rec["opd-6"]["source"], "db_error")                            # presence alone would have said post_open true

    def test_case_08_a_snapshot_61s_old_makes_the_whole_map_absent(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        p = os.path.join(t.name, "state", "consult_live.jsonl")
        h, clock, _ = mk(Src(presence=presence(post=open_at(T - 30))), background=True, live_state_path=p)
        h._stop.set()                                                                   # no refresher thread: the test owns the snapshot
        self.assertEqual(h.live(clock()), {})                                           # none yet: absent, not false
        lines = open(p).read().splitlines()
        self.assertEqual(len(lines), 2)                                                 # a snapshot_stale record per room
        for l in lines:
            self.assertEqual(json.loads(l)["source"], "snapshot_stale")
            self.assertIsNone(json.loads(l)["consult_live"])
        h._snap_live = ({"opd-6": True}, {"opd-6": {"source": "post_open"}}, clock())
        self.assertEqual(h.live(clock()), {"opd-6": True})
        self.assertEqual(h.live(clock() + 60), {"opd-6": True})                         # exactly at the 60 s limit: still usable
        self.assertEqual(h.live(clock() + 61), {})                                      # 61 s: the WHOLE map absent (spec §2)
        self.assertEqual(len(open(p).read().splitlines()), 2)                           #ale still snapshot_stale: no new line (no change)

    def test_case_09_unmapped_and_malformed_are_absent_and_the_rest_still_works(self):
        lv, _, rec, _ = live3(Src(presence=presence(post=open_at(T - 30, "M6", 10) + open_at(T - 30, "M7", 11))), rmap={"opd-6": MAP["opd-6"]})
        self.assertEqual(lv, {"opd-6": True})
        self.assertEqual((rec["opd-7"]["consult_live"], rec["opd-7"]["source"], rec["opd-7"]["room_id"]), (None, "unmapped", None))
        lv, _, rec, _ = live3(Src(presence=presence(post=open_at(T - 30))),
                              rmap={"opd-6": MAP["opd-6"], "opd-7": {"machine": 123, "room_id": "b7", "slug": "s7"}})
        self.assertEqual(lv, {"opd-6": True})                                           # a malformed entry is absent; the rest of the map still works
        self.assertEqual(rec["opd-7"]["source"], "unmapped")

    def test_case_09b_a_machine_entry_without_a_room_id_or_a_wellformed_machine_is_unmapped(self):
        """Spec review (2): an entry with a machine but no room_id is unmapped (as in the hold's no_mapping) — never a decision — and a machine list with a
        non-string, an empty or a duplicate element is malformed. The R2 code decided post_open TRUE on the first three; the rest of the map still works."""
        base = presence(post=open_at(T - 30, "M6", 10))
        for name, entry in (("no room_id", {"machine": "M6"}),
                            ("empty room_id", {"machine": "M6", "room_id": ""}),
                            ("non-string machine element", {"machine": ["M6", 123], "room_id": "b7", "slug": "s7"}),
                            ("empty-string machine element", {"machine": ["M6", ""], "room_id": "b7", "slug": "s7"}),
                            ("duplicate machine element", {"machine": ["M6", "M6"], "room_id": "b7", "slug": "s7"}),
                            ("machine not a string or list", {"machine": None, "room_id": "b7", "slug": "s7"})):
            with self.subTest(name=name):
                lv, _, rec, _ = live3(Src(presence=base), rmap={"opd-6": MAP["opd-6"], "opd-7": entry})
                self.assertEqual(lv, {"opd-6": True})
                self.assertEqual((rec["opd-7"]["consult_live"], rec["opd-7"]["source"]), (None, "unmapped"))
        self.assertEqual(rec["opd-7"]["room_id"], "b7")                                 # the room_id is still named in the record when it has one

    def test_case_10_consul4_vs_consul4_2_is_exact_string_match(self):
        """MUTANT (b): a prefix (or normalised-loose) machine match must fail this test — it would cross-wire OPD 3 onto OPD 4's machine (the two differ
        only by the '-2' suffix)."""
        M, M2 = "EHRC-CONSUL4s-Mac-mini", "EHRC-CONSUL4s-Mac-mini-2"
        rmap = {"opd-3": {"machine": M, "room_id": "b3", "slug": "s3"}, "opd-4-ortho": {"machine": M2, "room_id": "b4", "slug": "s4"}}
        lv, _, rec, _ = live3(Src(presence=presence(hb=((M, T - 5, 0),), post=open_at(T - 30, M))), rooms=["opd-3", "opd-4-ortho"], rmap=rmap)
        self.assertEqual(lv, {"opd-3": True})                                           # M's fresh heartbeat and open decide opd-3 only
        self.assertEqual((rec["opd-3"]["source"], rec["opd-3"]["confidence"]), ("post_open", "high"))
        self.assertEqual((rec["opd-4-ortho"]["consult_live"], rec["opd-4-ortho"]["source"], rec["opd-4-ortho"]["hb_age_s"]),
                         (None, "presence_stale", None))                                # M2 itself has no fresh heartbeat: absent, never true

    def test_case_13b_the_event_side_rows_also_match_the_machine_exactly(self):
        """MUTANT (b, event side): a prefix machine match on the POST/ENC rows must fail this test — with BOTH machines fresh and only CONSUL4-2 open, a
        prefix matcher wires OPD 3 onto OPD 4's open. Case 10 pins the heartbeat side; this pins the post/enc rows, where the cross-wiring actually lands."""
        M, M2 = "EHRC-CONSUL4s-Mac-mini", "EHRC-CONSUL4s-Mac-mini-2"
        rmap = {"opd-3": {"machine": M, "room_id": "b3", "slug": "s3"}, "opd-4-ortho": {"machine": M2, "room_id": "b4", "slug": "s4"}}
        lv, _, rec, _ = live3(Src(presence=presence(hb=((M, T - 5, 0), (M2, T - 5, 1)), post=open_at(T - 30, M2))),
                              rooms=["opd-3", "opd-4-ortho"], rmap=rmap)
        self.assertEqual(lv, {"opd-3": False, "opd-4-ortho": True})                     # opd-3: both machines' hb fresh, but its own machine has NO event
        self.assertEqual((rec["opd-3"]["consult_live"], rec["opd-3"]["source"], rec["opd-3"]["confidence"]), (False, "no_event", "medium"))
        self.assertEqual(rec["opd-4-ortho"]["source"], "post_open")

    def test_case_11_an_open_4h_plus_1s_old_with_no_close_is_false_no_event(self):
        old = T - ch.OPEN_UNCLOSED_MAX_S - 1
        lv, _, rec, _ = live3(Src(presence=presence(post=open_at(old, "M6", 10) + open_at(old, "M7", 11),
                                                      enc=[("M6", "encounter_open", old, 10), ("M7", "encounter_open", old, 11)])))
        self.assertEqual(lv, {"opd-6": False, "opd-7": False})                          # FALSE with source=no_event, not absent (fable fix (a))
        self.assertEqual((rec["opd-6"]["consult_live"], rec["opd-6"]["source"], rec["opd-6"]["confidence"], rec["opd-6"]["event_ts"]),
                         (False, "no_event", "medium", None))
        self.assertEqual((rec["opd-7"]["consult_live"], rec["opd-7"]["source"]), (False, "no_event"))

    def test_a_future_open_is_never_affirmed_and_is_no_event_false(self):
        lv, _, rec, _ = live3(Src(presence=presence(post=open_at(T + 100), enc=eopen_at(T + 100))))
        self.assertEqual(lv, {"opd-6": False, "opd-7": False})
        self.assertEqual(rec["opd-6"]["source"], "no_event")

    def test_the_exactly_4h_edge_is_within_the_decision(self):
        """The real SQL window is strict (ts > now - 4 h), so a row exactly 4 h old never arrives; the decision keeps the boundary inclusive, as the hold's
        window rule does. Pinned so a change to either side is deliberate."""
        lv, _, rec, _ = live3(Src(presence=presence(post=open_at(T - ch.OPEN_UNCLOSED_MAX_S))))
        self.assertEqual(lv, {"opd-6": True, "opd-7": False})
        self.assertEqual(rec["opd-6"]["source"], "post_open")


class HealEligibilityGate(unittest.TestCase):
    """Spec consumer rule + fable (e): a status entry may drive a MIC_DEAD_WEBCAM heal ONLY as a high-confidence post_open true. MUTANT (c) — a
    medium-confidence entry allowed to heal — must fail this class."""

    def _rec(self, v, source, conf):
        return {"room_id": "b6", "consult_live": v, "source": source, "event_ts": T - 30 if v is True else None, "hb_age_s": 5.0, "confidence": conf}

    def test_a_high_post_open_true_is_heal_eligible(self):
        self.assertTrue(ch.heal_eligible(self._rec(True, "post_open", "high")))

    def test_case_13c_a_medium_confidence_entry_never_heals(self):
        self.assertFalse(ch.heal_eligible(self._rec(True, "url_open", "medium")))       # the medium-confidence TRUE: never a heal
        self.assertFalse(ch.heal_eligible(self._rec(False, "no_event", "medium")))
        self.assertFalse(ch.heal_eligible(self._rec(False, "post_close", "high")))
        self.assertFalse(ch.heal_eligible(self._rec(False, "url_close", "high")))
        for src, conf in (("presence_stale", None), ("db_error", None), ("snapshot_stale", None), ("unmapped", None)):
            self.assertFalse(ch.heal_eligible(self._rec(None, src, conf)), src)
        self.assertFalse(ch.heal_eligible(None))
        self.assertFalse(ch.heal_eligible("junk"))


class StatusRecordFile(unittest.TestCase):
    """Spec §1: the status record at <home>/state/consult_live.jsonl — one line per room per CHANGE, metadata only, UTC ISO 8601 ts."""

    def test_one_line_per_room_per_change_and_the_line_shape(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        p = os.path.join(t.name, "state", "consult_live.jsonl")
        src = Src(presence=presence(post=open_at(T - 30, "M6", 10) + open_at(T - 30, "M7", 11)))
        clock = Clock(T)
        h = ch.ConsultHold(ROOMS, MAP, src, clock, live_state_path=p)
        h.compute(clock())
        lines = open(p).read().splitlines()
        self.assertEqual(len(lines), 2)                                                 # one per room, on change
        by_room = {json.loads(l)["room_id"]: json.loads(l) for l in lines}
        self.assertEqual(by_room["b6"], {"room_id": "b6", "consult_live": True, "source": "post_open", "confidence": "high",
                                         "event_ts": iso(T - 30), "hb_age_s": 5.0, "ts": iso(T)})
        self.assertEqual(sorted(by_room["b6"]), sorted(["room_id", "consult_live", "source", "ts", "event_ts", "hb_age_s", "confidence"]))
        clock.adv(30); h.compute(clock())                                               # a refresh with the same status: no new line
        self.assertEqual(len(open(p).read().splitlines()), 2)
        src.v["presence"] = presence(post=close_at(T + 20, "M6", 12) + close_at(T + 20, "M7", 13))
        clock.adv(30); h.compute(clock())
        lines = open(p).read().splitlines()
        self.assertEqual(len(lines), 4)                                                 # the change: one new line per room
        new = {json.loads(l)["room_id"]: json.loads(l) for l in lines[2:]}
        self.assertEqual((new["b6"]["consult_live"], new["b6"]["source"], new["b6"]["confidence"], new["b6"]["event_ts"]),
                         (False, "post_close", "high", iso(T + 20)))
        self.assertEqual(new["b6"]["hb_age_s"], (T + 60) - (T - 5))

    def test_no_file_is_written_when_the_path_is_none(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        src = Src(presence=presence(post=open_at(T - 30, "M6")))
        h = ch.ConsultHold(ROOMS, MAP, src, Clock(T), live_state_path=None)
        h.compute(Clock(T)())
        self.assertFalse(os.path.exists(os.path.join(t.name, "state")))


class ControlLineFlags(unittest.TestCase):
    FORM1 = '{"kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'
    FORM2 = '{"consult_open": {"opd-6": false, "opd-7": false}, "kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'
    FORM3 = '{"consult_live": {"opd-6": true, "opd-7": false}, "consult_open": {"opd-6": true, "opd-7": false}, "kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'
    FORM3_EMPTY = '{"consult_live": {}, "consult_open": {"opd-6": true, "opd-7": true}, "kill": false, "modes": {"opd-6": "shadow", "opd-7": "shadow"}, "ts": 1760000000}'

    def sub(self, hold=None, consult_live=False):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        open(os.path.join(t.name, "kill-switch"), "w").write("off\n")
        return sb.Subscriber(os.path.join(t.name, "d"), t.name, list(ROOMS), Sink(), Clock(T), consult=hold, consult_live=consult_live)

    def test_flag_off_is_the_base_bytes(self):
        self.assertEqual(self.sub().control_message(), self.FORM1)               # no hold at all (both flags off): today's line, byte for byte
        hold, _, _ = mk()                                                        # hold on, consult_live_publish off (default)
        msg = self.sub(hold).control_message()
        self.assertEqual(msg, self.FORM2)                                        # byte-identical to the base form-2 line
        self.assertNotIn("consult_live", msg)
        self.assertEqual(self.sub(None, consult_live=True).control_message(), self.FORM1)   # live flag alone (hold never built): today's line

    def test_flag_on_publishes_form_3_in_sort_keys_order(self):
        hold, _, _ = mk(Src(presence=presence(post=open_at(T - 30))))
        msg = self.sub(hold, consult_live=True).control_message()
        self.assertEqual(msg, self.FORM3)
        self.assertTrue(re.fullmatch(KIOSK_RE_V3, msg))
        self.assertFalse(re.fullmatch(KIOSK_RE_V2, msg))
        self.assertFalse(re.fullmatch(KIOSK_RE_OLD, msg))
        self.assertEqual(list(json.loads(msg)), ["consult_live", "consult_open", "kill", "modes", "ts"])

    def test_flag_on_with_a_db_error_publishes_an_empty_map_and_consult_open_all_true(self):
        hold, _, _ = mk(Src(presence=RuntimeError("neon down")))
        msg = self.sub(hold, consult_live=True).control_message()
        self.assertEqual(msg, self.FORM3_EMPTY)                                  # the whole map absent, the key itself stays (fixed form-3 shape)
        o = json.loads(msg)
        self.assertEqual(o["consult_live"], {}); self.assertEqual(o["consult_open"], {"opd-6": True, "opd-7": True})

    def test_false_values_reach_the_line_next_to_false_hold_values(self):
        hold, _, _ = mk(Src(presence=presence(post=close_at(T - 30, "M6", 10) + close_at(T - 30, "M7", 11))))
        o = json.loads(self.sub(hold, consult_live=True).control_message())
        self.assertEqual(o["consult_live"], {"opd-6": False, "opd-7": False})
        self.assertEqual(o["consult_open"], {"opd-6": False, "opd-7": False})

    def test_canonical_control_refuses_consult_live_without_consult_open(self):
        with self.assertRaises(ValueError):
            sb.canonical_control({"consult_live": {"r1": True}, "kill": False, "modes": {"r1": "shadow"}, "ts": 1760000000})
        ok = {"consult_live": {"r1": True}, "consult_open": {"r1": True}, "kill": False, "modes": {"r1": "shadow"}, "ts": 1760000000}
        self.assertEqual(sb.canonical_control(ok), json.dumps(ok, sort_keys=True))


class LiveSnapshot(unittest.TestCase):
    """Background mode: live() READS the refresher's snapshot (never computes on the publish thread); a malformed snapshot is an empty map, never a raise."""

    def test_background_live_reads_not_computes_and_never_raises(self):
        h, clock, src = mk(Src(presence=presence(post=open_at(T - 30))), background=True)
        h._stop.set()
        self.assertEqual(src.calls["presence"], 0)
        self.assertEqual(h.live(clock()), {})
        self.assertEqual(src.calls["presence"], 0)                                # never computed on the publish path
        h._snap_live = ({"opd-6": True}, {}, clock())
        self.assertEqual(h.live(clock()), {"opd-6": True})                        # read, not computed
        h._snap_live = ("garbage", {}, clock())
        self.assertEqual(h.live(clock()), {})
        h._snap_live = ({"opd-6": True}, {}, float("nan"))
        self.assertEqual(h.live(clock()), {})


class ConsultOpenByteIdentity(unittest.TestCase):
    """Spec case 12: consult_open is byte-identical before and after the change, over 20 snapshots. No recorded snapshot corpus exists in the repo, so 20
    synthetic snapshots span room count 1-5, kill on/off and mixed hold values; the flag-off line must equal the base serialisation byte for byte, and the
    flag-on line must carry the SAME consult_open substring (form 3 otherwise)."""
    CON_RE = re.compile(r'"consult_open": \{[^}]*\}')

    def test_case_12_consult_open_bytes_unchanged_over_20_snapshots(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup)
        killp = os.path.join(t.name, "kill-switch")
        for i in range(20):
            n = (i % 5) + 1
            rooms = [f"r{i}_{j}" for j in range(n)]
            hold = {r: ((i + k) % 3 == 0) for k, r in enumerate(rooms)}
            kill = (i % 2) == 1
            open(killp, "w").write("on\n" if kill else "off\n")

            class FH:
                def hold(self, now=None):
                    return hold

                def live(self, now=None):
                    return {}
            mksub = lambda live: sb.Subscriber(os.path.join(t.name, f"d{i}"), t.name, rooms, Sink(), Clock(T), consult=FH(), consult_live=live)
            off = mksub(False).control_message()
            expected = json.dumps({"consult_open": hold, "kill": kill, "modes": {r: "shadow" for r in rooms}, "ts": int(T)}, sort_keys=True)
            self.assertEqual(off, expected, i)
            on = mksub(True).control_message()
            self.assertEqual(self.CON_RE.search(off).group(0), self.CON_RE.search(on).group(0), i)
            self.assertTrue(re.fullmatch(KIOSK_RE_V3, on), (i, on[:90]))


class RoomBudgetAndWiring(unittest.TestCase):
    def test_validate_rooms_counts_the_consult_live_map_too(self):
        short = [f"r{i}" for i in range(64)]
        self.assertIsNone(sb.validate_rooms(short))
        self.assertIsNone(sb.validate_rooms(short, consult_live=True))           # both maps still fit with 2-3 char slugs
        long = [("r%02d" % i).ljust(18, "x") for i in range(64)]
        self.assertIsNone(sb.validate_rooms(long, consult_open=True))            # form 2 fits at 18 (measured, test_dprime)
        err = sb.validate_rooms(long, consult_live=True)
        self.assertIsNotNone(err); self.assertIn("4000", err)                    # form 3 counts BOTH maps: refused at 18

    def test_load_cfg_consult_live_publish_defaults_off_and_only_a_literal_true_turns_it_on(self):
        t = tempfile.TemporaryDirectory(); self.addCleanup(t.cleanup); p = os.path.join(t.name, "router.json")

        def cfg(extra):
            d = {"to": ["a"], "ackers": ["a"]}; d.update(extra); json.dump(d, open(p, "w")); return ubus_bus.load_cfg(p)
        self.assertIs(cfg({})["consult_live_publish"], False)
        for v in ("true", 1, "yes", None, [True], False):
            self.assertIs(cfg({"consult_live_publish": v})["consult_live_publish"], False, v)
        self.assertIs(cfg({"consult_live_publish": True})["consult_live_publish"], True)


class BuildSubscriberWiring(unittest.TestCase):
    """run_subscriber passes the flag end to end: check_rooms counts form 3, build_subscriber hands consult_live to the Subscriber, the published line is
    form 3, and the status record lands at the spec path <home>/state/consult_live.jsonl."""
    _HOME = tempfile.mkdtemp(prefix="ctl-home-")
    os.makedirs(os.path.join(_HOME, "logs"), exist_ok=True)
    _old = os.environ.get("GUARDIAN_HOME"); os.environ["GUARDIAN_HOME"] = _HOME
    import run_subscriber as rs
    if _old is None:
        os.environ.pop("GUARDIAN_HOME", None)
    else:
        os.environ["GUARDIAN_HOME"] = _old

    def sink(self):
        from test_router import ar, FakeBus
        return sb.RouterSink(ar.Router(ar.SqliteStore(), lambda: FakeBus(), Clock(T)))

    def build(self, flags, src):
        home = tempfile.mkdtemp(); os.makedirs(os.path.join(home, "etc"))
        open(os.path.join(home, "etc", "kill-switch"), "w").write("off\n")
        s = self.rs.build_subscriber({}, ROOMS, flags, self.sink(), home, Clock(T), consult_sources=src)
        if s.consult is not None:
            s.consult.stop()
            if s.consult._thread is not None:
                s.consult._thread.join(2)                                        # the refresher owns the snapshots until here; the test owns them after
        for r in ROOMS:
            s.on_line(f"kiosk/{r}/health", json.dumps({"capture_open": True, "zero_ratio": 1.0, "ts": T}))
        if s.consult is not None:
            now = s.consult.clock()
            s.consult._snap = (s.consult.compute(now), now)                      # exactly what the refresher would have written, without racing it
            s.consult._snap_live = (dict(s.consult._live), dict(s.consult._live_records), now)
        return s, home

    def test_both_flags_reach_the_control_line_and_the_line_is_form_3(self):
        flags = {"consult_open_publish": True, "consult_live_publish": True, "consult_room_map": MAP}
        s, home = self.build(flags, Src())
        self.assertTrue(s.consult_live); self.assertIsNotNone(s.consult)
        msg = s.control_message()
        self.assertTrue(msg.startswith('{"consult_live": '))
        self.assertTrue(re.fullmatch(KIOSK_RE_V3, msg))
        self.assertEqual(list(json.loads(msg)), ["consult_live", "consult_open", "kill", "modes", "ts"])
        o = json.loads(msg)
        self.assertEqual(o["consult_live"], {"opd-6": False, "opd-7": False})    # no events in the stub: no_event false for every room, never absent
        self.assertEqual(o["consult_open"], {"opd-6": False, "opd-7": False})    # health fed, everything clear
        state = os.path.join(home, "state", "consult_live.jsonl")
        self.assertTrue(os.path.exists(state))                                   # the status record is written (spec path), wire flag independent
        recs = [json.loads(l) for l in open(state).read().splitlines()]
        self.assertTrue(any(x["source"] == "no_event" for x in recs))

    def test_the_live_flag_alone_publishes_the_base_line(self):
        s, _ = self.build({"consult_live_publish": True}, Src())
        self.assertIsNone(s.consult)
        self.assertEqual(s.control_message(), ControlLineFlags.FORM1)            # without consult_open_publish nothing is built: today's bytes

    def test_check_rooms_counts_the_hold_map_and_the_live_map_separately(self):
        long = [("r%02d" % i).ljust(18, "x") for i in range(64)]
        self.assertIsNone(self.rs.check_rooms(long, {"consult_open_publish": True}))
        self.assertIn("4000", self.rs.check_rooms(long, {"consult_open_publish": True, "consult_live_publish": True}))
        self.assertIsNone(self.rs.check_rooms(long, {"consult_live_publish": True}))   # live alone: today's payload
        self.assertIsNone(self.rs.check_rooms(long, {"consult_open_publish": "true", "consult_live_publish": True}))


if __name__ == "__main__":
    unittest.main()
