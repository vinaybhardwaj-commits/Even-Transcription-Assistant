import json
import os
import stat

import pytest

from kit.reb import calibrate_nemo as cn
from kit.reb import reb, write_track
from kit.reb.writer import config_hash

ROOM = "room_aaaa1111"
DATE = "2026-09-26"
T0 = 1790400000000


def put(root, wid, layer, engine, segs, status="ok", stub=None):
    cfg = {"e": engine, "w": wid}
    t = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1", "config": cfg,
         "config_hash": config_hash(cfg), "machine": "t", "status": status, "reason": None if status == "ok" else "r", "segments": segs}
    return write_track(root, DATE, ROOM, wid, t, manifest_stub=stub)


def alt(n, step=20, span=18):                      # n alternating two-speaker turns: a chain of about n*step seconds
    return [(i * step, i * step + span, f"s{i % 2}") for i in range(n)]


def make(root, hh, py, nem):
    """py / nem: list of (a, b, speaker) window-relative seconds, [] = an empty track, None = no track."""
    wid = f"c-{DATE}_{ROOM}_{hh}00"
    t0 = T0 + int(hh) * 3600000
    stub = {"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": DATE, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": "room_tape",
            "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 900000}}
    put(root, wid, "stt", "koyal", [], stub=stub)
    if py is not None:
        put(root, wid, "diar", "pyannote-local-twin", [{"t0_ms": a * 1000, "t1_ms": b * 1000, "speaker": s} for a, b, s in py], status="ok" if py else "empty")      # window-relative ms
    if nem is not None:
        put(root, wid, "diar", "nemotron", [{"t0_ms": t0 + a * 1000, "t1_ms": t0 + b * 1000, "speaker": s} for a, b, s in nem], status="ok" if nem else "empty")  # tape ms
    return wid


@pytest.fixture
def store(tmp_path):
    root = str(tmp_path / "reb")
    os.makedirs(root)
    ids = {
        "both_cl": make(root, "01", alt(10), alt(10)),                 # 190 s chain under both: CONSULT-LIKE x CONSULT-LIKE
        "nem_hot": make(root, "02", alt(3), alt(8)),                    # pyannote chain 58 s (speech 6%: QUIET), nemotron chain 158 s (CONSULT-LIKE at T <= 150, not at 165)
        "quiet": make(root, "03", [], []),                              # both empty: a measured zero, QUIET x QUIET
        "py_only": make(root, "04", alt(10), alt(2)),                   # pyannote CL, nemotron short
        "no_nem": make(root, "05", alt(10), None),                      # nemotron track missing: counted, not guessed
        "no_py": make(root, "06", None, alt(10)),
    }
    return root, ids


def collect(store, scores=None):
    root, ids = store
    return cn.collect(root, list(ids.values()) + ["nope"], lambda d, r: False, scores)


def test_turns_are_window_relative_for_both_sources_and_missing_ones_are_counted(store):
    root, ids = store
    w = reb.load_window(ids["both_cl"], root=root)
    assert cn.engine_turns(w, cn.PY)[0] == (0.0, 18.0, "s0") and cn.engine_turns(w, cn.NEM)[0] == (0.0, 18.0, "s0")          # nemotron's tape ms had t0 taken off
    assert cn.engine_turns(reb.load_window(ids["quiet"], root=root), cn.NEM) == []
    assert cn.engine_turns(reb.load_window(ids["no_nem"], root=root), cn.NEM) is None
    rows, c = collect(store)
    assert len(rows) == 4 and c == {"ids": 7, "not_found": 1, "missing_nemotron": 1, "missing_pyannote": 1, "both": 4}


def test_confusion_counts_hours_hot_and_distributions(store):
    res = cn.calibrate(*collect(store))
    conf = res["confusion_pyannote90_x_nemotron90"]
    assert conf["CONSULT-LIKE"]["CONSULT-LIKE"] == 1 and conf["QUIET"]["CONSULT-LIKE"] == 1 and conf["QUIET"]["QUIET"] == 1 and conf["CONSULT-LIKE"]["QUIET"] == 1
    assert conf["STAFF/OTHER"] == {"CONSULT-LIKE": 0, "STAFF/OTHER": 0, "QUIET": 0}
    assert sum(sum(v.values()) for v in conf.values()) == 4
    c = res["consult_like_at_90"]
    assert c["pyannote"] == {"count": 2, "hours": 0.5} and c["nemotron"] == {"count": 2, "hours": 0.5} and res["hot"] is False                # 2 vs 2: not hot
    assert res["distributions"]["pyannote"]["longest_turn_taking_s"]["n"] == 4 and res["distributions"]["nemotron"]["n_speakers_10s"]["histogram"]["2"] == 3


def test_hot_and_the_threshold_table(store):
    root, ids = store
    for hh in ("07", "08", "09"):                                      # three more windows where nemotron is long and pyannote short: nemotron runs hot
        make(root, hh, alt(3), alt(8))
    rows, c = cn.collect(root, [reb.load_window(w, root=root).window_id for w in [ids[k] for k in ("both_cl", "nem_hot", "quiet", "py_only")]] +
                         [f"c-{DATE}_{ROOM}_{h}00" for h in ("07", "08", "09")], lambda d, r: False)
    res = cn.calibrate(rows, c)
    assert res["consult_like_at_90"]["pyannote"]["count"] == 2 and res["consult_like_at_90"]["nemotron"]["count"] == 5 and res["hot"] is True
    t = {x["T"]: x for x in res["thresholds_nemotron"]}
    assert list(t) == list(range(90, 301, 15)) and t[90]["consult_like"] == 5
    assert t[150]["consult_like"] == 5 and t[165]["consult_like"] == 1 and t[195]["consult_like"] == 1 and t[210]["consult_like"] == 0 and t[300]["consult_like"] == 0   # the 158 s chains drop out between T 150 and 165, the 198 s chain at T 210
    assert t[165]["vs_pyannote90"] == {"both": 1, "only_nemotron": 0, "only_pyannote": 1, "neither": 5, "precision": 1.0, "recall": 0.5, "f1": 0.6667, "kappa": 0.5882}
    assert t[90]["vs_pyannote90"]["both"] == 1 and t[90]["vs_pyannote90"]["only_nemotron"] == 4 and t[90]["vs_pyannote90"]["f1"] == 0.2857
    assert res["count_match_T"] == 165 and res["best_T"] == 165                                                          # |1-2| < |5-2|; F1 ties from 165 up and the smallest T wins


def test_cue_numbers_use_only_windows_with_a_score(store):
    root, ids = store
    scores = {ids["both_cl"]: 3.0, ids["nem_hot"]: 0.0, ids["quiet"]: 1.2, ids["py_only"]: 2.5}
    rows, c = cn.collect(root, [ids[k] for k in ("both_cl", "nem_hot", "quiet", "py_only")], lambda d, r: False, scores)
    cues = cn.calibrate(rows, c)["cues"]
    # cue >= 1.0: both_cl (3.0), quiet (1.2), py_only (2.5) -> pyannote labels CL for both_cl and py_only = 2 of 3; nemotron CL for both_cl only = 1 of 3
    assert cues["pyannote@90"]["catch_1.0"] == round(2 / 3, 4) and cues["nemotron@90"]["catch_1.0"] == round(1 / 3, 4)
    assert cues["pyannote@90"]["cue_windows_2.0"] == 2 and cues["nemotron@90"]["no_cue_share"] == 0.5          # nemotron CL: both_cl (3.0) and nem_hot (0.0)
    assert cues["pyannote@90"]["scored_windows"] == 4
    none, _ = cn.collect(root, [ids["both_cl"]], lambda d, r: False, None)                                     # no scores: the cue numbers are None, not zero
    assert cn.calibrate(none)["cues"]["pyannote@90"]["catch_1.0"] is None


def test_outputs_are_private_and_nothing_is_written_to_the_store(store, tmp_path, monkeypatch):
    root, ids = store
    snap = lambda: sorted((dp, f, os.path.getsize(os.path.join(dp, f)), os.path.getmtime(os.path.join(dp, f))) for dp, _, fs in os.walk(root) for f in fs)
    before = snap()
    idf = tmp_path / "ids.json"
    idf.write_text(json.dumps(list(ids.values())))
    monkeypatch.setattr(cn, "load_heldout", lambda: (lambda d, r: False))
    monkeypatch.setattr(cn.cw, "run", lambda *a, **k: ([{"window_id": ids["both_cl"], "clinical_score": 4.0}], {}))
    out = tmp_path / "out"
    assert cn.main(["--ids", str(idf), "--root", root, "--out", str(out)]) == 0
    assert snap() == before
    assert sorted(os.listdir(out)) == ["CALIBRATE-NEMO-90S-ROWS.jsonl", "CALIBRATE-NEMO-90S.json", "CALIBRATE-NEMO-90S.md"]
    assert all(stat.S_IMODE(os.stat(out / f).st_mode) == 0o600 for f in os.listdir(out))
    res = json.load(open(out / "CALIBRATE-NEMO-90S.json"))
    assert res["windows"] == 4 and res["cues"]["pyannote@90"]["scored_windows"] == 1
    assert "text" not in open(out / "CALIBRATE-NEMO-90S-ROWS.jsonl").read()
