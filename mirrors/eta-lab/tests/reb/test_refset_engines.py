import json

import pytest

from kit.reb import refset as rs
from kit.reb import refset_engines as re_
from .test_refset import make_env, records_for
from .test_refset_b import FakeJev


def seg(text, t0=1000, t1=9000):
    return {"t0_ms": t0, "t1_ms": t1, "text": text}


def fake_tracks(medasr=None, koyal=None):
    return lambda root, row, engine: {"medasr": medasr, "koyal": koyal}[engine]


def run(env, uid, jev, monkeypatch, medasr=None, koyal=None, held=lambda d, r: False):
    monkeypatch.setattr(re_, "live_engine", fake_tracks(medasr, koyal))
    return re_.run_engines([uid], records_for(uid), jev, root=env.root, is_held=held, index_path=env.index, clips_root=env.clips)


def test_each_engine_is_judged_separately_in_its_own_marked_state(tmp_path, monkeypatch):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    med = {"segments": [seg("warfarin and metformin tablets")], "extras": {}}
    koy = {"segments": [seg("हिंदी metformin")], "extras": {"sarvam_language_code": "hi-IN"}}
    jev = FakeJev({"warfarin": "mentioned", "metformin": "mentioned"})
    R, names = run(env, uid, jev, monkeypatch, med, koy)
    assert len(jev.requests) == 3                                                                                        # sarvam, medasr, koyal: one request each
    states = [r[0] for r in jev.requests]
    assert states[0].startswith("Source: English translation (Sarvam)") and states[1].startswith("Source: MedASR transcript") and states[2].startswith("Source: Koyal transcript in its native script (hi-IN)")
    assert "warfarin and metformin tablets" in states[1] and "metformin" not in states[1].split("\n")[0].lower()
    p = R["per_consult"][0]
    a = [t["a"] for t in p["terms"]]
    assert [x["medasr"] for x in a] == [True, False, False, True] and [x["koyal"] for x in a] == [True, False, False, False] and [x["sarvam"] for x in a] == [True, True, True, False]
    cross = R["aggregates"]["cross_a"]["medasr"]["drug"]
    assert cross == {"terms": 2, "both": 1, "sarvam_only": 0, "engine_only": 1, "neither": 0}                              # warfarin: only MedASR; metformin: both
    assert R["aggregates"]["recall"]["all"]["medasr"]["consults_with_text"] == 1
    assert "names" in json.dumps(names) and "Warfarin" not in json.dumps(R)                                               # names only in the box-only structure


def test_engine_without_a_track_or_with_empty_text_is_not_judged_and_not_counted(tmp_path, monkeypatch):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]
    jev = FakeJev()
    R, _ = run(env, uid, jev, monkeypatch, medasr={"segments": [seg("  ")], "extras": {}}, koyal=None)
    assert len(jev.requests) == 1                                                                                         # sarvam only
    p = R["per_consult"][0]
    assert p["engine_available"] == {"sarvam": True, "medasr": True, "koyal": False} and p["engine_empty"] == {"medasr": True, "koyal": False}
    assert R["aggregates"]["consults_with_text"] == {"sarvam": 1, "medasr": 0, "koyal": 0}
    assert R["aggregates"]["cross_a"]["medasr"]["drug"]["terms"] == 0


def test_blind_consult_is_refused_before_any_text_and_any_request(tmp_path, monkeypatch):
    env, row = make_env(tmp_path)
    jev = FakeJev()
    R, _ = run(env, row["consult_uid"], jev, monkeypatch, held=lambda d, r: True)
    assert jev.requests == [] and R["counts"] == {"asked": 1, "blind_refused": 1}


def test_cannot_tell_is_kept_apart_in_the_b_cross_table(tmp_path, monkeypatch):
    env, row = make_env(tmp_path)
    uid = row["consult_uid"]

    class Unsure(FakeJev):
        def choose_many(self, state, questions):
            out = super().choose_many(state, questions)
            if "MedASR" in state:
                out = {k: {"mentioned": 0.5, "not_mentioned": 0.3, "cannot_tell": 0.2} for k in out}
            return out
    R, _ = run(env, uid, Unsure({"metformin": "mentioned"}), monkeypatch, {"segments": [seg("something")], "extras": {}})
    c = R["aggregates"]["cross_b"]["medasr"]["drug"]
    assert c["cannot_tell_either"] == 2 and c["terms"] == 2


def test_stability_counts_same_flip_and_cannot_tell_moves_per_category():
    b1 = {"per_consult": [{"consult_uid": "u", "terms": [{"idx": 0, "category": "drug", "b": "mentioned"}, {"idx": 1, "category": "drug", "b": "not_mentioned"},
                                                         {"idx": 2, "category": "diagnosis", "b": "cannot_tell"}, {"idx": 3, "category": "investigation", "b": "mentioned"}]}]}
    b2 = {"per_consult": [{"consult_uid": "u", "terms": [{"idx": 0, "b": {"sarvam": "mentioned"}}, {"idx": 1, "b": {"sarvam": "mentioned"}},
                                                         {"idx": 2, "b": {"sarvam": "mentioned"}}, {"idx": 3, "b": {"sarvam": "cannot_tell"}}, {"idx": 9, "b": {"sarvam": "mentioned"}}]}]}
    for i, c in enumerate(("drug", "drug", "diagnosis", "investigation", "drug")):
        b2["per_consult"][0]["terms"][i]["category"] = c
    assert re_.stability(b1, b2) == {"drug": {"terms": 2, "same": 1, "flip": 1}, "diagnosis": {"terms": 1, "from_cannot_tell": 1}, "investigation": {"terms": 1, "to_cannot_tell": 1}, "_unmatched": {"terms": 1}}


def test_stability_flag_needs_no_record_and_prints_the_same_counts(tmp_path, capsys):
    b1 = {"per_consult": [{"consult_uid": "u", "terms": [{"idx": 0, "category": "drug", "b": "mentioned"}]}]}
    b2 = {"per_consult": [{"consult_uid": "u", "terms": [{"idx": 0, "category": "drug", "b": {"sarvam": "mentioned"}}]}]}
    f1, f2 = tmp_path / "b1.json", tmp_path / "b2.json"
    f1.write_text(json.dumps(b1))
    f2.write_text(json.dumps(b2))
    assert re_.main(["--stability", str(f1), str(f2)]) == 0
    assert json.loads(capsys.readouterr().out) == {"drug": {"terms": 1, "same": 1}}
    with pytest.raises(SystemExit):
        re_.main([])                                                                                            # without --stability the record is still required
