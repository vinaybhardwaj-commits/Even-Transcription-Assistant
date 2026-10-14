import json
import os
import types

import pytest

from kit.reb import role_map as rm
from kit.reb import sarvam_lane as sl
from kit.reb.from_hist import GuardUnavailable
from .test_sarvam_lane import DATE, ROOM, SPAN_START_MS, UID, Env, FakeGW, make_row, tdir

ENTRIES = [{"speaker_id": "0", "start": 0.0, "end": 60.0, "transcript": "synthetic a"},
           {"speaker_id": "1", "start": 60.0, "end": 100.0, "transcript": "synthetic b"},
           {"speaker_id": "2", "start": 100.0, "end": 105.0, "transcript": "synthetic c"}]


def set_timeline(env, row, doctor=((0.0, 50.0),), identified=True):
    p = os.path.join(env.clips, row["path"], "timeline.json")
    tl = json.load(open(p))
    tl["doctor_identified"] = identified
    tl["turns"] = [{"start_s": a, "end_s": b, "speaker": "doctor"} for a, b in doctor] + [{"start_s": 50.0, "end_s": 60.0, "speaker": "S1"}]
    json.dump(tl, open(p, "w"))


def sarvam_env(tmp, row=None, entries=ENTRIES, doctor=((0.0, 50.0),)):
    row = row or make_row()
    env = Env(tmp, [row])
    env.run(FakeGW(entries=entries), date=row["ist_date"])
    set_timeline(env, row, doctor, bool(row.get("doctor_identified")))
    return env, row


def roles(env, since=DATE, write=True, held=lambda d, r: False, consult=None):
    a = types.SimpleNamespace(consult=consult, date=None, since=None if consult else since, write=write, min_minutes=0, identified=False)
    return rm.run(a, root=env.root, is_held=held, index_path=env.index, clips_root=env.clips)


def role_track(env):
    names = [n for n in os.listdir(tdir(env)) if n.startswith("role.")]
    assert len(names) == 1
    return json.load(open(os.path.join(tdir(env), names[0])))


def mp(turns, doc):
    return rm.map_roles(turns, doc)


def test_rule_edges_thresholds_and_ties():
    # clean: speaker A is 90% doctor, B none
    r = mp([(0, 100, "A"), (100, 140, "B")], [(0, 90)])
    assert r["A"]["role"] == "doctor" and r["A"]["share"] == 0.9 and r["B"]["role"] == "other" and r["B"]["talk_s"] == 40.0
    # share exactly 0.5 with talk exactly 10 s is a doctor; 0.49 is not
    assert mp([(0, 10, "A")], [(0, 5)])["A"]["role"] == "doctor"
    assert mp([(0, 100, "A")], [(0, 49)])["A"]["role"] == "unknown"
    # talk under 10 s: never a doctor, never "other"
    assert mp([(0, 9.9, "A")], [(0, 9.9)])["A"]["role"] == "unknown" and mp([(0, 9.9, "A")], [])["A"]["role"] == "unknown"
    # "other" needs share < 0.2 (0.2 is unknown, 0.19 is other)
    assert mp([(0, 100, "A")], [(0, 20)])["A"]["role"] == "unknown" and mp([(0, 100, "A")], [(0, 19)])["A"]["role"] == "other"
    # two candidates over the thresholds: the higher share is the doctor, the other one is unknown (never two doctors)
    r = mp([(0, 20, "A"), (20, 40, "B")], [(0, 18), (20, 32)])
    assert r["A"]["role"] == "doctor" and r["B"]["role"] == "unknown"
    # tie on share: the larger doctor_overlap_s wins
    r = mp([(0, 20, "A"), (20, 60, "B")], [(0, 20), (20, 60)])
    assert r["A"]["share"] == r["B"]["share"] == 1.0 and r["B"]["role"] == "doctor" and r["A"]["role"] == "unknown"
    # tie on both: no doctor, both unknown
    r = mp([(0, 20, "A"), (30, 50, "B")], [(0, 20), (30, 50)])
    assert r["A"]["role"] == r["B"]["role"] == "unknown"


def test_overlapping_turns_are_not_double_counted():
    r = mp([(0, 10, "A"), (5, 15, "A")], [(0, 8), (6, 12)])      # union A = 0..15 (15 s), union doctor = 0..12 -> 12 s overlap
    assert r["A"]["talk_s"] == 15.0 and r["A"]["doctor_overlap_s"] == 12.0 and r["A"]["share"] == 0.8


def test_split_ids_get_one_doctor_per_part():
    turns = [(0, 100, "p1:0"), (100, 140, "p1:1"), (200, 300, "p2:0"), (300, 340, "p2:1")]
    r = mp(turns, [(0, 90), (200, 290)])
    assert [r[k]["role"] for k in ("p1:0", "p1:1", "p2:0", "p2:1")] == ["doctor", "other", "doctor", "other"]
    # a part where nobody overlaps the doctor has no doctor, even though another part does
    r = mp(turns, [(0, 90)])
    assert [r[k]["role"] for k in ("p1:0", "p2:0", "p2:1")] == ["doctor", "other", "other"]


def test_role_track_shares_by_hand_and_no_text(tmp_path):
    env, row = sarvam_env(tmp_path)
    before = sorted(os.listdir(tdir(env)))
    cnt = roles(env)
    assert cnt["written"] == 1 and cnt["clips_one_doctor"] == 1 and cnt["roles_doctor"] == 1 and cnt["roles_other"] == 1 and cnt["roles_unknown"] == 1
    t = role_track(env)
    assert (t["layer"], t["engine"], t["version"], t["status"], t["window_id"]) == ("role", "sarvam-doctor-map", "v1", "ok", "consult-" + UID)
    m = t["extras"]["map"]
    assert m["0"] == {"role": "doctor", "share": round(50 / 60, 4), "talk_s": 60.0, "doctor_overlap_s": 50.0}
    assert m["1"]["role"] == "other" and m["1"]["share"] == 0.0 and m["1"]["talk_s"] == 40.0
    assert m["2"]["role"] == "unknown" and m["2"]["talk_s"] == 5.0           # under 10 s
    assert t["extras"]["rule"] == "v1"
    assert [(s["speaker"], s["role"]) for s in t["segments"]] == [("0", "doctor"), ("1", "other"), ("2", "unknown")]
    assert t["segments"][0]["t0_ms"] == SPAN_START_MS and set(t["segments"][0]) == {"t0_ms", "t1_ms", "speaker", "role"}
    assert "synthetic" not in json.dumps(t)                                   # no transcript text anywhere
    d = t["extras"]["derived_from"]
    diar = [n for n in os.listdir(tdir(env)) if n.startswith("diar.")][0]
    assert d["diar_path"].endswith("tracks/" + diar) and d["diar_sha256"] == rm.sha256_file(os.path.join(tdir(env), diar))
    assert d["timeline_sha256"] == rm.sha256_file(os.path.join(env.clips, row["path"], "timeline.json"))
    assert sorted(set(os.listdir(tdir(env))) - set(before)) == [n for n in os.listdir(tdir(env)) if n.startswith("role.")]   # existing tracks untouched


def test_idempotent_rerun_and_new_timeline_is_a_new_track(tmp_path):
    env, row = sarvam_env(tmp_path)
    assert roles(env)["written"] == 1
    cnt = roles(env)
    assert cnt["written"] == 0 and cnt["skipped_existing"] == 1 and cnt["would_write"] == 0
    set_timeline(env, row, doctor=((0.0, 55.0),))                              # cutter re-cut its voiceprint turns: new cfg8, old stays
    assert roles(env)["written"] == 1
    assert len([n for n in os.listdir(tdir(env)) if n.startswith("role.")]) == 2


def test_dry_run_writes_nothing(tmp_path):
    env, row = sarvam_env(tmp_path)
    before = sorted(os.listdir(tdir(env)))
    cnt = roles(env, write=False)
    assert cnt["would_write"] == 1 and cnt["written"] == 0 and sorted(os.listdir(tdir(env))) == before


def test_doctor_not_identified_is_skipped_with_no_segments(tmp_path):
    row = make_row()
    row["doctor_identified"] = False
    env, row = sarvam_env(tmp_path, row)
    cnt = roles(env)
    assert cnt["not_identified"] == 1 and cnt["written"] == 1 and cnt["clips_one_doctor"] == cnt["clips_zero_doctor"] == 0
    t = role_track(env)
    assert t["status"] == "skipped" and t["reason"] == "doctor_not_identified" and t["segments"] == []


def test_zero_doctor_clip_is_counted(tmp_path):
    env, row = sarvam_env(tmp_path, doctor=())
    cnt = roles(env)
    assert cnt["clips_zero_doctor"] == 1 and cnt["roles_doctor"] == 0 and role_track(env)["status"] == "ok"


def test_signature_mismatch_fails_closed(tmp_path):
    env, row = sarvam_env(tmp_path)
    recut = dict(row, signature=[1.0, "url_clear", "DOC1"])                    # the cutter re-cut: the live diar names the OLD signature
    with open(env.index, "a") as f:
        f.write(json.dumps(recut) + "\n")
    cnt = roles(env)
    assert cnt["signature_mismatch"] == 1 and cnt["written"] == 0 and not [n for n in os.listdir(tdir(env)) if n.startswith("role.")]


def test_timeline_disagreeing_with_the_row_fails_closed(tmp_path):
    env, row = sarvam_env(tmp_path)
    set_timeline(env, row, identified=False)                                   # row says identified, timeline says not
    cnt = roles(env)
    assert cnt["signature_mismatch"] == 1 and cnt["written"] == 0


def test_no_diar_is_counted(tmp_path):
    row = make_row()
    env = Env(tmp_path, [row])                                                 # the lane never ran: no consult dir at all
    assert roles(env)["no_diar"] == 1


def test_blind_room_day_refused_before_any_write(tmp_path):
    env, row = sarvam_env(tmp_path)
    cnt = roles(env, held=lambda d, r: True)
    assert cnt["blind_refused"] == 1 and cnt["written"] == 0 and not [n for n in os.listdir(tdir(env)) if n.startswith("role.")]


def test_guard_unavailable_is_fatal(tmp_path, monkeypatch):
    env, row = sarvam_env(tmp_path)

    def boom():
        raise GuardUnavailable("no guard")
    monkeypatch.setattr(rm, "load_heldout", boom)
    a = types.SimpleNamespace(consult=None, date=None, since=DATE, write=True, min_minutes=0, identified=False)
    with pytest.raises(GuardUnavailable):
        rm.run(a, root=env.root, index_path=env.index, clips_root=env.clips)
    assert not [n for n in os.listdir(tdir(env)) if n.startswith("role.")]


def test_readers_see_the_role_track(tmp_path):
    from kit.reb import consult
    env, row = sarvam_env(tmp_path)
    roles(env)
    w = consult(UID, root=env.root)
    got = w.tracks(layer="role")
    assert len(got) == 1 and got[0].engine == "sarvam-doctor-map" and got[0].status == "ok"
