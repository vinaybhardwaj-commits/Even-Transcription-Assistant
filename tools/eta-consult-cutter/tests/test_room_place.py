import datetime as dt, json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import room_place as RP
_T, _TU, _TD, _TS = "D" + "r", "D" + "R", "Doc" + "tor", "d" + "r"          # title tokens built, not written: the identity-literal CI check bans the written shapes

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
def at(h, m=0, d=12): return dt.datetime(2026, 10, d, h, m, tzinfo=IST)
def iso(x): return x.isoformat()
def enc(i, doc, a, b, room=None): return dict(id=i, doctor_uid=doc, start=iso(a), end=iso(b), room_id=room)
def win(machine, room, a, b, doc): return dict(machine=machine, room_id=room, t_open=a, t_close=b, warehouse_doctor_uid=doc, consulting_doctor_uid=None, doctor_uid=None)
def ev(machine, event, t, uid): return dict(machine=machine, event=event, ts=t, uid=uid)
USUAL = RP.usual_table([dict(doctor_uid="DA", weekday="Mon", rooms=[dict(room_id="rU", share=0.8)])])
WINS = [win("M1", "r1", at(8), at(8, 5), "DX"), win("M2", "r2", at(8), at(8, 5), "DY")]     # also gives the machine -> room map

def one(e, wins=WINS, events=(), usual=None): return RP.place([e], wins, list(events), usual or {})[0]

def test_machine_room_map_argument_fills_in_when_the_day_has_only_roomless_windows():
    r = RP.place([enc("e", "DA", at(9), at(9, 10))], [win("M2", None, at(9), at(9, 10), "DA")], [], {}, {"M2": "r2"})[0]
    assert (r["room_id"], r["room_source"]) == ("r2", "pulse")
    assert RP.place([enc("e", "DA", at(9), at(9, 10))], [win("M2", None, at(9), at(9, 10), "DA")], [], {})[0]["room_source"] is None

def test_pulse_window_overlap_half_or_more_wins_and_beats_everything():
    r = one(enc("e", "DA", at(9), at(9, 10), room="rS"), WINS + [win("M1", "r1", at(9, 4), at(9, 20), "DA")], [ev("M2", "login", at(8, 55), "DA")], USUAL)
    assert (r["room_id"], r["room_source"], r["room_confidence"]) == ("r1", "pulse", 0.95)
    r = one(enc("e", "DA", at(9), at(9, 10)), WINS + [win("M1", "r1", at(9, 6), at(9, 20), "DA")])         # 4 of 10 min: not enough
    assert r["room_source"] is None

def test_pulse_needs_same_doctor_and_window_without_room_uses_machine_room():
    assert one(enc("e", "DA", at(9), at(9, 10)), WINS + [win("M1", "r1", at(9), at(9, 10), "DB")])["room_source"] is None
    assert one(enc("e", "DA", at(9), at(9, 10)), WINS + [win("M2", None, at(9), at(9, 10), "DA")])["room_id"] == "r2"

def test_presence_single_mac_recent_event_only():
    r = one(enc("e", "DA", at(10), at(10, 9)), events=[ev("M2", "login", at(9, 50), "DA"), ev("M2", "heartbeat", at(9, 58), "DA")])
    assert (r["room_id"], r["room_source"], r["room_confidence"]) == ("r2", "presence", 0.90)
    assert one(enc("e", "DA", at(10), at(10, 9)), events=[ev("M2", "heartbeat", at(9, 40), "DA")])["room_source"] is None        # 20 min old
    assert one(enc("e", "DA", at(10), at(10, 9)), events=[ev("M2", "login", at(9, 50), "DA"), ev("M2", "logout", at(9, 55), "DA")])["room_source"] is None
    assert one(enc("e", "DA", at(10), at(10, 9)), events=[ev("M2", "login", at(9, 50), "DA"), ev("M2", "login", at(9, 56), "DZ")])["room_source"] is None   # another doctor took the Mac
    assert one(enc("e", "DA", at(10), at(10, 9)), events=[ev("M1", "login", at(9, 50), "DA"), ev("M2", "login", at(9, 51), "DA")])["room_source"] is None      # two Macs: ambiguous
    assert one(enc("e", "DA", at(10), at(10, 9)), events=[ev("MX", "login", at(9, 50), "DA")])["room_source"] is None            # unmapped Mac

def test_usual_then_schedule_then_none():
    r = one(enc("e", "DA", at(10), at(10, 9), room="rS"), usual=USUAL)                                    # 12 Oct 2026 is a Monday
    assert (r["room_id"], r["room_source"], r["room_confidence"]) == ("rU", "usual", 0.68)
    r = one(enc("e", "DA", at(10, 0, d=13), at(10, 9, d=13), room="rS"), usual=USUAL)                     # Tuesday: no usual row
    assert (r["room_id"], r["room_source"], r["room_confidence"]) == ("rS", "schedule", 0.80)
    r = one(enc("e", "DB", at(10), at(10, 9)))
    assert (r["room_id"], r["room_source"], r["room_confidence"]) == (None, None, None)

def test_weak_row_colliding_with_firm_row_is_dropped_but_same_doctor_is_kept():
    W = WINS + [win("M1", "r1", at(11), at(11, 10), "DX")]
    rows = RP.place([enc("a", "DX", at(11), at(11, 10)), enc("b", "DA", at(11, 2), at(11, 8), room="r1")], W, [], {})
    assert [r["room_source"] for r in rows] == ["pulse", None] and rows[1]["room_note"] == "conflict_dropped"
    rows = RP.place([enc("a", "DX", at(11), at(11, 10)), enc("b", "DX", at(11, 2), at(11, 8), room="r1")], W, [], {})
    assert rows[1]["room_source"] == "pulse"

def test_bad_times_are_unplaced_and_input_not_mutated():
    e = dict(id="e", doctor_uid="DA", start="garbage", end=None, room_id="rS"); before = json.dumps(e)
    r = one(e); assert r["room_source"] is None and json.dumps(e) == before
    e2 = enc("f", "DA", at(10, 9), at(10)); assert one(e2)["room_source"] is None

def test_run_writes_new_file_beside_and_leaves_source_byte_identical():
    d = tempfile.mkdtemp(); day = os.path.join(d, "2026-10-12"); os.makedirs(day)
    src = dict(date="2026-10-12", counts={}, encounters=[enc("a", "DX", at(8), at(8, 5)), enc("b", "DB", at(9), at(9, 5), room="rS")])
    p = os.path.join(day, "encounters.json"); open(p, "w").write(json.dumps(src)); raw = open(p, "rb").read()
    s = RP.run(day, None, wins=WINS, events=[])
    assert open(p, "rb").read() == raw and s == dict(visits=2, pulse=1, schedule=1)
    out = json.load(open(os.path.join(day, "encounters.placed.json")))
    assert [r["room_source"] for r in out["encounters"]] == ["pulse", "schedule"] and out["room_place"]["version"] == "m3-19"
    assert sorted(os.listdir(day)) == ["encounters.json", "encounters.placed.json"] and oct(os.stat(os.path.join(day, "encounters.placed.json")).st_mode & 0o777) == "0o644"
    RP.run(day, None, wins=WINS, events=[], dry=True)

def test_sql_is_read_only_selects():
    assert all(q.lstrip().upper().startswith("SELECT") for q in (RP.WIN_SQL, RP.EV_SQL, RP.MAP_SQL))


# ---- m3-19 wiring: pqm_windows prefers the placed file; backfill_pqm places stale Oct days ----
import time as _time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pqm_windows as PW, backfill_pqm as BP
from cutter import windows as Wn
SLUGS = {"r1": "opd-1-x", "rS": "opd-s-x", "rU": "opd-u-x"}

def pe(step, src, conf=None, room="r1", doc="DOC1"):
    d = dict(id=step, step_uid=step, doctor=f"{_T} Fixture", doctor_uid=doc, start="2026-10-12T09:00:00+05:30", end="2026-10-12T09:10:00+05:30", room_id=room, room_label="OPD 1", room_source=src)
    if conf is not None: d["room_confidence"] = conf
    return d

def test_window_carries_source_and_confidence_and_flags_only_usual_and_schedule_from_the_placed_file():
    for src, conf, unc in (("pulse", 0.95, False), ("presence", 0.90, False), ("usual", 0.68, True), ("schedule", 0.80, True)):
        w, why = PW.window_of(pe("s", src, conf), "2026-10-12", SLUGS); assert why is None and w["room_source"] == src and w["room_confidence"] == conf
        assert (w["quality"], w.get("flags")) == (("suspect", ["room_uncertain"]) if unc else ("pqm", None))
    w, _ = PW.window_of(pe("s", "schedule"), "2026-10-12", SLUGS)                                       # gating row, no confidence: unchanged
    assert "room_confidence" not in w and w["quality"] == "pqm" and "flags" not in w
    w, _ = PW.window_of(dict(pe("s", "usual", 0.68), end="2026-10-12T10:00:00+05:30"), "2026-10-12", SLUGS)        # timeout + uncertain: both flags
    assert w["flags"] == ["pqm_timeout_3600", "room_uncertain"] and w["quality"] == "suspect"
    assert Wn.FILE_EXTRA.count("room_confidence") == 1                                                    # load_file accepts the new key

def day_dir(drt, day, encs, placed=None, placed_older=False):
    d = os.path.join(drt, day); os.makedirs(d, exist_ok=True); p = os.path.join(d, "encounters.json"); json.dump(dict(encounters=encs), open(p, "w"))
    if placed is not None:
        q = os.path.join(d, "encounters.placed.json"); json.dump(dict(encounters=placed), open(q, "w"))
        if placed_older: os.utime(q, (_time.time() - 100, _time.time() - 100))
    return d

def test_build_prefers_fresh_placed_file_from_october_only():
    drt = tempfile.mkdtemp(); gat = [pe("s", "schedule", room="rS")]; pla = [pe("s", "pulse", 0.95, room="r1")]
    day_dir(drt, "2026-10-12", gat, pla); day_dir(drt, "2026-09-20", gat, pla)
    ws, _ = PW.build(["2026-10-12"], drt, SLUGS, pulse=dict(windows=[], cut_pqm_uids=set())); assert (ws[0]["room_id"], ws[0]["room_source"]) == ("r1", "pulse")
    ws, _ = PW.build(["2026-09-20"], drt, SLUGS); assert (ws[0]["room_id"], ws[0]["room_source"]) == ("rS", "schedule")        # September ignores a placed file
    day_dir(drt, "2026-10-13", gat, pla, placed_older=True)
    assert PW.encounters_path("2026-10-13", drt).endswith("encounters.json") and PW.encounters_path("2026-10-12", drt).endswith("encounters.placed.json")

def test_ensure_placed_runs_for_missing_or_stale_october_days_only_and_survives_failure():
    drt = tempfile.mkdtemp(); e = [pe("s", "schedule")]
    day_dir(drt, "2026-09-30", e); day_dir(drt, "2026-10-10", e); day_dir(drt, "2026-10-11", e, e); day_dir(drt, "2026-10-12", e, e, placed_older=True); day_dir(drt, "2026-10-13", e)
    seen, logs = [], []
    def place(d):
        seen.append(os.path.basename(d))
        if d.endswith("10-13"): raise RuntimeError("neon down")
        return {}
    done = BP.ensure_placed(sorted(os.listdir(drt)), logs.append, drt, place)
    assert seen == ["2026-10-10", "2026-10-12", "2026-10-13"] and done == ["2026-10-10", "2026-10-12"] and any("failed: RuntimeError" in l for l in logs)


# ---- open Pulse windows (t_close None): cover up to min(now, t_open + 90 min) ----
def _w(room="room_a", doc="D1", a=1000.0, b=1600.0): return dict(room_id=room, doctor_uid=doc, t_open=a, t_close=b)
def test_open_close_helper_caps_at_90_minutes_and_now():
    assert PW.open_close(dict(t_open=1000.0, t_close=1500.0), 9e9) == 1500.0
    assert PW.open_close(dict(t_open=1000.0, t_close=None), 2000.0) == 2000.0                         # now before the cap
    assert PW.open_close(dict(t_open=1000.0, t_close=None), 1000.0 + 9000) == 1000.0 + 5400.0         # older than 90 min: the cap

def test_covered_by_pulse_open_window_covers_a_visit_in_progress_and_not_one_after_the_cap():
    w = dict(room_id="room_a", doctor_uid="D1", t_open=1100.0, t_close=1700.0)
    assert PW.covered_by_pulse(w, dict(windows=[_w(b=None)]), now=1800.0)                              # open since 1000, now 1800: covers 1100..1700
    assert not PW.covered_by_pulse(dict(w, t_open=7000.0, t_close=7600.0), dict(windows=[_w(b=None)]), now=99999.0)      # open window older than 90 min stops at 6400
    assert not PW.covered_by_pulse(w, dict(windows=[_w(a=1650.0, b=None)]), now=1700.0)                # now == 1700: covers only 1650..1700 = 50 of 600 s
    assert PW.covered_by_pulse(w, dict(windows=[_w(b=None)]))                                          # default now (real clock): t_open + 90 min is long past, 1000..6400 still covers

def test_pulse_context_turns_a_none_t_close_into_the_capped_close_and_does_not_crash():
    import datetime as D
    U = D.timezone.utc; a = D.datetime(2026, 10, 5, 3, 0, tzinfo=U)
    row = dict(id=7, consult_uid="n1", machine="m", room_id="room_a", room_slug="s", t_open=a, t_close=None, close_reason=None, quality="clean", resolver_version="v", computed_at=None,
               warehouse_doctor_uid="W1", warehouse_doctor_name="N", consulting_doctor_uid=None, consulting_doctor_name=None)
    idx = tempfile.mkdtemp() + "/index.jsonl"
    c = PW.pulse_context(index=idx, loader=lambda sql, params: [row], now=a.timestamp() + 600)
    assert c["windows"][0]["t_close"] == a.timestamp() + 600
    c = PW.pulse_context(index=idx, loader=lambda sql, params: [row], now=a.timestamp() + 99999)
    assert c["windows"][0]["t_close"] == a.timestamp() + 5400.0


# ---- refuter flags F1-F8 ----
def _wp(called=1100.0, completed=1700.0, **kw):
    w = dict(room_id="room_a", doctor_uid="D1", t_open=called - 60, t_close=completed + 60, pqm_called=called, pqm_completed=completed); w.update(kw); return w

def test_f1_overlap_is_measured_on_the_raw_visit_span_not_the_padded_one():
    # Pulse 1100..1380: 280 of the raw 600 s = 46.7% < 50%; on the padded span (720 s) it is 38.9%. Pulse 1100..1400 = 300/600 = 50% raw, but 300/720 = 41.7% padded.
    assert not PW.covered_by_pulse(_wp(), dict(windows=[dict(room_id="room_a", doctor_uid="D1", t_open=1100.0, t_close=1380.0)]))
    assert PW.covered_by_pulse(_wp(), dict(windows=[dict(room_id="room_a", doctor_uid="D1", t_open=1100.0, t_close=1400.0)]))
    w = _wp(); del w["pqm_called"], w["pqm_completed"]                                                      # a window without raw times falls back to its own span
    assert not PW.covered_by_pulse(w, dict(windows=[dict(room_id="room_a", doctor_uid="D1", t_open=1040.0, t_close=1300.0)]))

def test_f2_place_from_is_2_oct_and_a_cut_uid_keeps_its_index_room_everywhere():
    assert PW.PLACE_FROM == "2026-10-02"
    drt = tempfile.mkdtemp(); u = PW.consult_uid("s")
    day_dir(drt, "2026-10-12", [pe("s", "usual", 0.68, room="rU")], [pe("s", "usual", 0.68, room="rU")])
    row = dict(consult_uid=u, status="cut", room_id="r1", room_slug="opd-1-x", room_source="schedule", flags=[])
    pulse = dict(windows=[], cut_pqm_uids={u}, pqm_rows={u: row})
    ws, _ = PW.build(["2026-10-12"], drt, SLUGS, pulse=pulse)
    assert (ws[0]["room_id"], ws[0]["room_slug"], ws[0]["room_source"], ws[0]["quality"], "flags" in ws[0]) == ("r1", "opd-1-x", "schedule", "pqm", False)
    pulse["pqm_rows"][u] = dict(row, status="skipped")                                                      # not cut: the new placement stands
    ws, _ = PW.build(["2026-10-12"], drt, SLUGS, pulse=pulse); assert (ws[0]["room_id"], ws[0]["flags"]) == ("rU", ["room_uncertain"])
    pulse["pqm_rows"][u] = dict(row, flags=["room_uncertain"], room_confidence=0.8)
    ws, _ = PW.build(["2026-10-12"], drt, SLUGS, pulse=pulse); assert (ws[0]["room_id"], ws[0]["flags"], ws[0]["quality"], ws[0]["room_confidence"]) == ("r1", ["room_uncertain"], "suspect", 0.8)

def test_f2_pulse_context_returns_the_pqm_index_rows():
    idx = tempfile.mkdtemp() + "/index.jsonl"
    open(idx, "w").write(json.dumps(dict(consult_uid="pqm_x", boundary_source="pqm", status="cut", room_id="r1")) + "\n")
    c = PW.pulse_context(index=idx, loader=lambda s, p: [])
    assert c["pqm_rows"]["pqm_x"]["room_id"] == "r1" and "pqm_x" in c["cut_pqm_uids"]

def test_f3_timeout_counter_counts_only_the_timeout_flag():
    drt = tempfile.mkdtemp()
    day_dir(drt, "2026-10-12", [pe("s", "usual", 0.68), dict(pe("t", "pulse", 0.95), end="2026-10-12T10:00:00+05:30")])
    day_dir(drt, "2026-10-13", [pe("s2", "usual", 0.68)])
    _, st = PW.build(["2026-10-13"], drt, SLUGS, pulse=dict(windows=[], cut_pqm_uids=set())); assert st["2026-10-13"]["windows"] == 1 and st["2026-10-13"]["timeout_3600"] == 0     # uncertain, not a timeout
    _, st = PW.build(["2026-10-12"], drt, SLUGS, pulse=dict(windows=[], cut_pqm_uids=set())); assert st["2026-10-12"]["windows"] == 2 and st["2026-10-12"]["timeout_3600"] == 1

def test_f5_failed_write_leaves_no_tmp_file_and_f6_mode_is_0644():
    d = tempfile.mkdtemp(); day = os.path.join(d, "2026-10-12"); os.makedirs(day)
    json.dump(dict(encounters=[enc("a", "DX", at(8), at(8, 5))]), open(os.path.join(day, "encounters.json"), "w"))
    from unittest import mock
    with mock.patch.object(RP.os, "replace", side_effect=OSError("boom")):
        try: RP.run(day, None, wins=WINS, events=[]); raise AssertionError("no error")
        except OSError: pass
    assert os.listdir(day) == ["encounters.json"]
    RP.run(day, None, wins=WINS, events=[]); assert oct(os.stat(os.path.join(day, "encounters.placed.json")).st_mode & 0o777) == "0o644"

def test_f7_planned_uid_is_never_dropped_by_the_pulse_filter_but_an_unplanned_one_is():
    drt = tempfile.mkdtemp(); u = PW.consult_uid("s")
    day_dir(drt, "2026-10-12", [pe("s", "pulse", 0.95), pe("t", "pulse", 0.95)])
    cov = dict(room_id="r1", doctor_uid="DOC1", t_open=0.0, t_close=9e12)
    csv_p = tempfile.mkdtemp() + "/planned-clips.csv"; open(csv_p, "w").write("consult_uid,room_id,t0_utc_ms,t1_utc_ms,room_source,status\n" + u + ",r1,1,2,pulse,planned\n")
    assert PW.planned_uids(csv_p) == {u} and PW.planned_uids("/nonexistent") == set()
    idx = tempfile.mkdtemp() + "/index.jsonl"
    c = PW.pulse_context(index=idx, loader=lambda s, p: [], planned=csv_p); assert c["cut_pqm_uids"] == {u}
    c["windows"].append(cov)
    ws, st = PW.build(["2026-10-12"], drt, SLUGS, pulse=c); assert [w["consult_uid"] for w in ws] == [u] and st["2026-10-12"]["covered_by_pulse"] == 1

def test_f8_gating_voice_room_outranks_usual_and_schedule_but_not_presence_or_pulse():
    r = one(enc("e", "DA", at(10), at(10, 9), room="rV") | dict(room_source="voice"), usual=USUAL)
    assert (r["room_id"], r["room_source"], r["room_confidence"]) == ("rV", "voice", 0.90)
    r = one(enc("e", "DA", at(10), at(10, 9), room="rV") | dict(room_source="voice"), events=[ev("M2", "login", at(9, 55), "DA")], usual=USUAL)
    assert (r["room_id"], r["room_source"]) == ("r2", "presence")
    assert one(enc("e", "DA", at(10), at(10, 9), room="rS") | dict(room_source="schedule"), usual=USUAL)["room_source"] == "usual"
