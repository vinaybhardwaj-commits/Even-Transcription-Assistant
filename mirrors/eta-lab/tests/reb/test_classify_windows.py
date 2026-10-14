import json
import os

import pytest

from kit.reb import classify_windows as cw
from kit.reb import write_track
from kit.reb.from_hist import GuardUnavailable
from kit.reb.writer import config_hash

DATE = "2026-09-26"
T0 = 1790400000000                                       # any tape-UTC ms; only differences matter
ROOMS = ("room_aaaa1111", "room_bbbb2222")


def test_union_speakers_and_speech_fraction():
    turns = [(0, 10, "A"), (5, 20, "A"), (30, 40, "B"), (35, 38, "C")]
    f = cw.diar_features(turns, 100.0)
    assert f["speech_s"] == 30.0 and f["speech_frac"] == 0.3        # union 0..20 + 30..40
    assert f["n_speakers"] == 3 and f["n_speakers_10s"] == 2        # A 20 s, B 10 s (exactly 10 counts), C 3 s


def test_turn_taking_rule_edges():
    # A B A B alternating with 4 s gaps and 20 s turns: one stretch from the first start to the last end
    alt = [(0, 20, "A"), (24, 44, "B"), (48, 68, "A"), (72, 92, "B")]
    assert cw.longest_turn_taking(alt) == 92.0
    # a gap of exactly 5 s links, 5.5 s breaks
    assert cw.longest_turn_taking([(0, 10, "A"), (15, 25, "B")]) == 25.0
    assert cw.longest_turn_taking([(0, 10, "A"), (15.5, 25, "B")]) == 0.0
    # speaker change interval (start to start) must be <= 60 s: exactly 60 links, 61 does not
    assert cw.longest_turn_taking([(0, 59, "A"), (60, 70, "B")]) == 70.0
    assert cw.longest_turn_taking([(0, 59, "A"), (61, 70, "B")]) == 0.0
    # one speaker only: no turn-taking, even over a long time with small gaps (same-speaker turns merge)
    assert cw.longest_turn_taking([(0, 100, "A"), (103, 300, "A")]) == 0.0
    # a long run can END a chain (its start is within 60 s of the previous start) but the next change is 100 s later, so the chain breaks there
    chain = [(0, 20, "A"), (22, 40, "B"), (42, 140, "A"), (142, 160, "B"), (162, 180, "A")]
    assert cw.longest_turn_taking(chain) == 102.0           # 0..42+60: the last run (A 42..140) is capped at 60 s from its start; the later chain 142..180 is shorter
    # the cap on the last run: a short exchange then a long monologue
    assert cw.longest_turn_taking([(0, 20, "A"), (22, 300, "B")]) == 82.0        # 22 + 60 - 0, not 300
    assert cw.longest_turn_taking([(0, 20, "A"), (22, 50, "B")]) == 50.0         # a last run shorter than 60 s counts in full
    # same-speaker turns with gap <= 5 s merge into one run, so a 3 s pause does not end a speaker run
    assert cw.longest_turn_taking([(0, 10, "A"), (13, 20, "A"), (22, 30, "B")]) == 30.0


def test_labels_with_and_without_overlap():
    assert cw.label_of(0.5, 200, 3) == "CONSULT-LIKE"
    assert cw.label_of(0.5, 200, 0) == "STAFF/OTHER"                  # turn-taking but no clinic consult in progress
    assert cw.label_of(0.5, 89.9, 3) == "STAFF/OTHER" and cw.label_of(0.5, 90.0, 3) == "CONSULT-LIKE"       # threshold 90 s
    assert cw.label_of(0.5, 119.9, 3, 120.0) == "STAFF/OTHER" and cw.label_of(0.5, 120.0, 3, 120.0) == "CONSULT-LIKE"
    assert cw.label_of(0.2, 0, 3) == "STAFF/OTHER" and cw.label_of(0.199, 0, 3) == "QUIET"
    assert cw.label_of(0.5, 200, None) == "CONSULT-LIKE"               # overlap NOT AVAILABLE: turn-taking only
    assert cw.label_of(None, 0, 1) == "NO_DIAR"


def test_visits_overlap_and_time_parsing(tmp_path):
    p = tmp_path / "v.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in [
        {"called_at": "2026-09-26T09:00:00+05:30", "completed_at": "2026-09-26T09:10:00+05:30", "doctor_uid": "D1"},
        {"called_at": "2026-09-26 09:20:00", "completed_at": "2026-09-26 09:40:00", "doctor_uid": "D2"},     # naive = IST
        {"called_at": "bad", "completed_at": "x"}, {"called_at": "2026-09-26T09:00:00+05:30", "completed_at": "2026-09-26T08:00:00+05:30"}]))
    v, dropped = cw.load_visits(str(p))
    assert len(v) == 2 and dropped == 2
    ist0 = cw._parse_time("2026-09-26T09:05:00+05:30")
    n, mins = cw.visit_overlap(v, ist0, ist0 + 900000)                  # 09:05..09:20 sees visit 1 for 5 min and visit 2 not at all
    assert n == 1 and mins == 5.0
    assert cw.visit_overlap(v, ist0 + 3600000, ist0 + 4500000) == (0, 0.0)
    assert cw.load_visits.__doc__ and "doctor_uid" in cw.load_visits.__doc__


def test_clinical_score_counts_keywords_and_question_marks():
    assert cw.clinical_score("any Pain? fever, tablets and the cold. hello", 60.0) == 5.0    # pain fever tablets cold + one '?'
    assert cw.clinical_score("nothing here", 120.0) == 0.0 and cw.clinical_score("pain", 0) is None


def test_sample_is_seeded_stratified_and_consult_like_only():
    rows = [{"window_id": f"w{i}", "room_id": ROOMS[i % 2], "ist_date": DATE, "hour_ist": 9 + i % 3, "label_turn_only": "CONSULT-LIKE" if i % 4 else "QUIET"}
            for i in range(120)]
    a = cw.sample_stratified(rows, 30, 7, "label_turn_only")
    assert a == cw.sample_stratified(rows, 30, 7, "label_turn_only") and a != cw.sample_stratified(rows, 30, 8, "label_turn_only")
    by = {r["window_id"]: r for r in rows}
    assert len(a) == 30 and len(set(a)) == 30 and all(by[w]["label_turn_only"] == "CONSULT-LIKE" for w in a)
    assert {by[w]["room_id"] for w in a} == set(ROOMS) and {by[w]["hour_ist"] for w in a} == {9, 10, 11}
    assert len(cw.sample_stratified(rows, 500, 7, "label_turn_only")) == 90      # fewer candidates than asked: all of them


# ------------------------------------------------------------------ a tiny store
def put(root, wid, room, layer, engine, segs, cfg=None, status="ok", stub=None):
    cfg = cfg or {"e": engine}
    t = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1", "config": cfg,
         "config_hash": config_hash(cfg), "machine": "t", "status": status, "reason": None if status == "ok" else "r", "segments": segs}
    return write_track(root, DATE, room, wid, t, manifest_stub=stub)


ALT = tuple((i * 20, i * 20 + 18, str(i % 2)) for i in range(15))     # 15 alternating 18 s turns every 20 s: one chain of 298 s


def make_window(root, room, hh, full=True, speakers=ALT):
    wid = f"c-{DATE}_{room}_{hh}00"
    t0 = T0 + int(hh) * 3600000
    stub = {"window_id": wid, "room_id": room, "room_slug": room, "ist_date": DATE, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": "room_tape",
            "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 900000}}
    for e in (cw.RETIRED_STT if full else cw.RETIRED_STT[:3]):
        put(root, wid, room, "stt", e, [{"t0_ms": 0, "t1_ms": 1000, "text": "synthetic pain? fever"}], stub=stub)
    put(root, wid, room, "diar", "pyannote-local-twin", [{"t0_ms": a * 1000, "t1_ms": b * 1000, "speaker": s} for a, b, s in speakers], stub=stub)
    return wid


def test_run_population_blind_exclusion_and_no_writes(tmp_path):
    root = str(tmp_path)
    w_ok = make_window(root, ROOMS[0], "09")
    make_window(root, ROOMS[0], "10", full=False)
    w_blind = make_window(root, ROOMS[1], "09")
    w_quiet = make_window(root, ROOMS[0], "11", speakers=((0, 30, "0"),))
    before = sorted(os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs)
    pop, c = cw.run(root=root, dates=(DATE,), is_held=lambda day, room: room == ROOMS[1])
    assert sorted(os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs) == before            # nothing written
    assert c["windows_total"] == 4 and c["blind_excluded"] == 1 and c["not_full_stack"] == 1 and c["full_stack"] == 2
    by = {r["window_id"]: r for r in pop}
    assert set(by) == {w_ok, w_quiet} and w_blind not in by
    r = by[w_ok]
    assert r["audio_s"] == 900.0 and r["speech_s"] == 270.0 and r["n_speakers_10s"] == 2
    assert r["longest_turn_taking_s"] == 298.0 and r["label"] == r["label_turn_only"] == "CONSULT-LIKE" and r["overlap_visits"] is None
    assert by[w_quiet]["label"] == "QUIET" and r["clinical_score"] == round(3 / 15.0, 4)          # pain + fever + one "?" = 3 hits in 15 min
    assert "synthetic" not in json.dumps(pop)                                                       # no text in the rows


def test_run_with_visits_changes_the_label_not_the_turn_only_label(tmp_path):
    root = str(tmp_path)
    wid = make_window(root, ROOMS[0], "09")
    pop, _ = cw.run(root=root, dates=(DATE,), is_held=lambda d, r: False, visits=[])
    assert pop[0]["label"] == "STAFF/OTHER" and pop[0]["label_turn_only"] == "CONSULT-LIKE" and pop[0]["overlap_visits"] == 0
    t0 = pop[0]["t0_ms"]
    pop, _ = cw.run(root=root, dates=(DATE,), is_held=lambda d, r: False, visits=[(t0 + 60000, t0 + 360000)])
    assert pop[0]["label"] == "CONSULT-LIKE" and pop[0]["overlap_visits"] == 1 and pop[0]["overlap_min"] == 5.0


def test_missing_diar_is_no_diar_and_guard_failure_is_fatal(tmp_path, monkeypatch):
    root = str(tmp_path)
    wid = f"c-{DATE}_{ROOMS[0]}_0900"
    stub = {"window_id": wid, "room_id": ROOMS[0], "room_slug": ROOMS[0], "ist_date": DATE, "t0_ms": T0, "t1_ms": T0 + 900000, "source_kind": "room_tape",
            "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 900000}}
    for e in cw.RETIRED_STT:
        put(root, wid, ROOMS[0], "stt", e, [{"t0_ms": 0, "t1_ms": 1, "text": "x"}], stub=stub)
    pop, c = cw.run(root=root, dates=(DATE,), is_held=lambda d, r: False)
    assert pop[0]["label"] == "NO_DIAR" and c["no_diar"] == 1

    def boom():
        raise GuardUnavailable("none")
    monkeypatch.setattr(cw, "load_heldout", boom)
    with pytest.raises(GuardUnavailable):
        cw.run(root=root, dates=(DATE,))


def test_room_labels_are_cosmetic_and_hint_is_not_available(tmp_path):
    p = tmp_path / "rl.json"
    p.write_text(json.dumps({"rooms": [{"room_id": ROOMS[0], "label": "OPD 1"}]}))
    assert cw.load_room_labels(str(p)) == {ROOMS[0]: "OPD 1"} and cw.load_room_labels(str(tmp_path / "none.json")) == {}
    pop = [{"window_id": "w", "room_id": ROOMS[0], "ist_date": DATE, "hour_ist": 9, "audio_s": 900.0, "label": "QUIET", "label_turn_only": "QUIET",
            "speech_frac": 0.0, "n_speakers_10s": 0, "longest_turn_taking_s": 0.0, "clinical_score": 0.0}]
    A = cw.aggregates(pop, {}, {"available": False}, [], "label_turn_only", cw.load_room_labels(str(p)))
    assert A["per_room"][ROOMS[0]]["label"] == "OPD 1" and A["weak_hint_usual_room"]["available"] is False


def test_empty_pyannote_track_is_quiet_but_absent_is_no_diar(tmp_path):
    root = str(tmp_path)
    mk = lambda room: (f"c-{DATE}_{room}_0900", {"window_id": f"c-{DATE}_{room}_0900", "room_id": room, "room_slug": room, "ist_date": DATE, "t0_ms": T0,
                                                  "t1_ms": T0 + 900000, "source_kind": "room_tape", "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 900000}})
    for room, mode in ((ROOMS[0], "empty"), (ROOMS[1], "absent")):
        wid, stub = mk(room)
        for e in cw.RETIRED_STT:
            put(root, wid, room, "stt", e, [{"t0_ms": 0, "t1_ms": 1, "text": "x"}], stub=stub)
        if mode == "empty":
            put(root, wid, room, "diar", "pyannote-local-twin", [], status="empty", stub=stub)
    pop, c = cw.run(root=root, dates=(DATE,), is_held=lambda d, r: False)
    by = {r["room_id"]: r for r in pop}
    assert by[ROOMS[0]]["label"] == "QUIET" and by[ROOMS[0]]["speech_s"] == 0.0 and by[ROOMS[0]]["diar_status"] == "empty" and c["diar_empty"] == 1
    assert by[ROOMS[1]]["label"] == "NO_DIAR" and by[ROOMS[1]]["diar_status"] == "absent" and c["no_diar"] == 1


def test_usual_room_hint_by_weekday_never_gates(tmp_path):
    p = tmp_path / "u.json"
    p.write_text(json.dumps({"table": [{"doctor_uid": "d1", "weekday": "Sat", "rooms": [{"room_id": ROOMS[0], "share": 0.75}]},
                                       {"doctor_uid": "d2", "weekday": "Sat", "rooms": [{"room_id": ROOMS[0], "share": 0.5}, {"room_id": ROOMS[1], "share": 0.5}]},
                                       {"doctor_uid": "d1", "weekday": "Mon", "rooms": [{"room_id": ROOMS[1], "share": 1.0}]}]}))
    tab, state = cw.load_usual_room(str(p))
    assert state == "ok"
    sat = cw._parse_time("2026-09-26T10:00:00+05:30")                         # 26 Sep 2026 is a Saturday
    assert cw.usual_room_hint(tab, sat, ROOMS[0]) == 1.25 and cw.usual_room_hint(tab, sat, ROOMS[1]) == 0.5
    assert cw.usual_room_hint(tab, sat + 86400000, ROOMS[0]) == 0.0           # Sunday: no row
    assert cw.usual_room_hint(None, sat, ROOMS[0]) is None and cw.load_usual_room(str(tmp_path / "none.json")) == (None, "not_present")
    assert cw.label_of(0.5, 10.0, None) == "STAFF/OTHER"                      # the hint is not a parameter of the label at all


def test_sensitivity_rows_and_clinical_check():
    def row(i, tt, score):
        return {"window_id": f"w{i}", "room_id": ROOMS[0], "ist_date": DATE, "hour_ist": 9, "audio_s": 900.0, "speech_frac": 0.5, "n_speakers_10s": 2,
                "longest_turn_taking_s": tt, "clinical_score": score, "label": cw.label_of(0.5, tt, None), "label_turn_only": cw.label_of(0.5, tt, None),
                "usual_room_hint": 0.0}
    pop = [row(0, 200, 5.0), row(1, 130, 4.0), row(2, 95, 3.0), row(3, 40, 0.0)]
    A = cw.aggregates(pop, {}, {"available": False}, [], "label_turn_only")
    s = A["sensitivity_turn_only"]
    assert [s[k]["label_counts"].get("CONSULT-LIKE") for k in ("90", "120", "180")] == [3, 2, 1]
    assert s["90"]["clinical_cross_check"]["share_consult_like_in_top_half"] == 1.0 and s["90"]["clinical_cross_check"]["share_consult_like_overall"] == 0.75
    assert A["turn_taking_threshold_s"] == 90.0


def test_agreement_metrics_catch_rate_and_no_cue_share():
    def row(i, tt, score):
        return {"window_id": f"w{i}", "room_id": ROOMS[0], "ist_date": DATE, "hour_ist": 9, "audio_s": 3600.0, "speech_frac": 0.5, "n_speakers_10s": 2,
                "longest_turn_taking_s": tt, "clinical_score": score}
    pop = [row(0, 200, 3.0), row(1, 100, 0.0), row(2, 10, 1.5), row(3, 10, 0.2), row(4, 95, 2.0)]
    labels = {r["window_id"]: cw.label_of(0.5, r["longest_turn_taking_s"], None, 90.0) for r in pop}      # w0, w1, w4 are CONSULT-LIKE
    m = cw.agreement_metrics(pop, labels)
    assert m["catch_rate"][">=1.0"] == {"cue_windows": 3, "labelled_consult_like": 2, "share": round(2 / 3, 4)}       # w0, w2, w4 are cue windows; w0, w4 caught
    assert m["catch_rate"][">=2.0"] == {"cue_windows": 2, "labelled_consult_like": 2, "share": 1.0}
    assert m["no_cue"] == {"consult_like_windows": 3, "with_score_0": 1, "share": round(1 / 3, 4)}                # w1 has score 0
    pop2 = [dict(r, label=labels[r["window_id"]], label_turn_only=labels[r["window_id"]], usual_room_hint=0.0) for r in pop]
    A = cw.aggregates(pop2, {}, {"available": False}, [], "label_turn_only")
    s = A["sensitivity_turn_only"]["90"]
    assert s["label_counts"]["CONSULT-LIKE"] == 3 and s["label_hours"]["CONSULT-LIKE"] == 3.0 and s["agreement"] == m
    assert A["sensitivity_turn_only"]["180"]["agreement"]["no_cue"]["consult_like_windows"] == 1
    assert cw.agreement_metrics([], {})["no_cue"]["share"] is None


def test_running_end_gap_keeps_a_chain_through_an_interjection():
    # B interjects 10-12 inside A's ongoing 0-100 turn; A's next turn starts at 20: the gap to the previous run's end (12) is 8 s, to the running end (100) it is 0
    turns = [(0, 100, "A"), (10, 12, "B"), (20, 40, "A")]
    assert cw.longest_turn_taking(turns) == 100.0
    # a real pause still breaks it: nothing running at 40 s, the next speaker starts 6 s later
    assert cw.longest_turn_taking([(0, 10, "A"), (12, 14, "B"), (20, 30, "A")]) == 14.0       # chain A-B only (A at 20 is 6 s after the running end 14)
    assert cw.longest_turn_taking([(0, 10, "A"), (16, 30, "B")]) == 0.0                           # 6 s gap, no link
    # the chain end is the running end when the last run is short: B 10-12 then nothing
    assert cw.longest_turn_taking([(0, 100, "A"), (10, 12, "B")]) == 100.0
    # the last-run cap still applies on top: a long last monologue counts 60 s from its own start
    assert cw.longest_turn_taking([(0, 20, "A"), (22, 300, "B")]) == 82.0


def test_usual_room_file_states(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    assert cw.load_usual_room(str(bad)) == (None, "unreadable")
    odd = tmp_path / "odd.json"
    odd.write_text(json.dumps({"table": 5}))
    assert cw.load_usual_room(str(odd)) == (None, "unreadable")
    assert cw.load_usual_room(str(tmp_path / "none.json")) == (None, "not_present")
    pop = [{"window_id": "w", "room_id": ROOMS[0], "ist_date": DATE, "hour_ist": 9, "audio_s": 900.0, "label": "QUIET", "label_turn_only": "QUIET", "speech_frac": 0.0,
            "n_speakers_10s": 0, "longest_turn_taking_s": 0.0, "clinical_score": 0.0}]
    a = cw.aggregates(pop, {}, {"available": False}, [], "label_turn_only", hint_available=False, hint_state="unreadable")["weak_hint_usual_room"]
    b = cw.aggregates(pop, {}, {"available": False}, [], "label_turn_only", hint_available=False, hint_state="not_present")["weak_hint_usual_room"]
    assert "UNREADABLE" in a["note"] and a["state"] == "unreadable" and "not present" in b["note"] and "UNREADABLE" not in b["note"]
