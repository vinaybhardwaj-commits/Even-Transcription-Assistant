import os

import pytest

from kit.reb import classify_pre_2oct as cp
from kit.reb import classify_windows as cw
from kit.reb import reb, write_track
from kit.reb.writer import config_hash

ROOM = "room_aaaa1111"
DATE = "2026-09-26"
T0 = 1790400000000
CHAIN = lambda end: [(0, 50, "A"), (52, end, "B")]            # A then B: the 60 s change cap makes the chain exactly `end` seconds (52 + (end - 52) <= 60)


def put(root, wid, layer, engine, segs, status="ok", stub=None):
    cfg = {"e": engine, "w": wid}
    t = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1", "config": cfg,
         "config_hash": config_hash(cfg), "machine": "t", "status": status, "reason": None if status == "ok" else "r", "segments": segs}
    return write_track(root, DATE, ROOM, wid, t, manifest_stub=stub)


def window(root, hh, py=None, nem=None):
    wid = f"c-{DATE}_{ROOM}_{hh}00"
    t0 = T0 + int(hh) * 3600000
    stub = {"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": DATE, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": "room_tape",
            "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 900000}}
    put(root, wid, "stt", "koyal", [], stub=stub)
    if py is not None:
        put(root, wid, "diar", "pyannote-local-twin", [{"t0_ms": int(a * 1000), "t1_ms": int(b * 1000), "speaker": s} for a, b, s in py])
    if nem is not None:
        put(root, wid, "diar", "nemotron", [{"t0_ms": t0 + int(a * 1000), "t1_ms": t0 + int(b * 1000), "speaker": s} for a, b, s in nem])
    return reb.load_window(wid, root=root)


def label(w):
    return cp.classify_window(w)


def test_thresholds_are_constants_per_source():
    assert (cw.TT_MIN_PYANNOTE_S, cw.TT_MIN_NEMOTRON_S, cw.TT_MIN_S) == (90.0, 105.0, 90.0)
    assert cw.tt_min_for("nemotron") == 105.0 and cw.tt_min_for("pyannote") == 90.0 and cw.tt_min_for(None) == 90.0 and cw.tt_min_for("no_turns") == 90.0


@pytest.mark.parametrize("end,expect", [(104, "STAFF/OTHER"), (105, "CONSULT-LIKE")])
def test_nemotron_boundary_is_105_not_90(tmp_path, end, expect):
    root = str(tmp_path)
    # speech must be >= 20% of the 900 s window for a non-consult chain to read STAFF rather than QUIET: add a long second speaker block
    segs = CHAIN(end) + [(300, 450, "A")]
    w = window(root, "01", nem=segs)
    assert cw.diar_features(cw.window_turns(w)[2], 900.0)["longest_turn_taking_s"] in (104.0, 105.0)
    assert label(w) == (expect, "nemotron")
    assert cw.window_turns(w)[0] == "nemotron"


@pytest.mark.parametrize("end,expect", [(89, "STAFF/OTHER"), (90, "CONSULT-LIKE"), (104, "CONSULT-LIKE"), (105, "CONSULT-LIKE")])
def test_pyannote_boundary_stays_90(tmp_path, end, expect):
    w = window(str(tmp_path), "01", py=CHAIN(end) + [(300, 450, "A")])
    assert label(w) == (expect, "pyannote")


def test_pyannote_evidence_wins_and_keeps_its_own_threshold(tmp_path):
    w = window(str(tmp_path), "01", py=CHAIN(95) + [(300, 450, "A")], nem=CHAIN(95) + [(300, 450, "A")])     # both sources say 95 s: pyannote decides, and 95 >= 90
    assert label(w) == ("CONSULT-LIKE", "pyannote")


def test_census_rows_record_the_evidence_and_the_threshold_and_run_does_too(tmp_path):
    root, data, tapes = str(tmp_path / "reb"), tmp_path / "data", tmp_path / "tapes"
    os.makedirs(root); data.mkdir(); tapes.mkdir()
    (tapes / "manifest.jsonl").write_text("")
    import hashlib
    (data / "w.webm").write_bytes(b"a")
    sha = hashlib.sha256(b"a").hexdigest()
    for hh, kw in (("01", {"nem": CHAIN(100) + [(300, 450, "A")]}), ("02", {"py": CHAIN(100) + [(300, 450, "A")]}), ("03", {})):
        w = window(root, hh, **kw)
        mp = os.path.join(root, DATE, ROOM, w.window_id, "manifest.json")
        import json
        m = json.load(open(mp))
        m["audio"] = {"r2_key": "local:w.webm", "sha256": sha, "sample_rate": 1, "duration_ms": 900000}
        json.dump(m, open(mp, "w"))
    rows = []
    cp.census(root, cutoff="2026-10-02", is_held=lambda d, r: False, tapes=str(tapes), data=str(data), rows_out=rows)
    by = {r["window_id"].split("_")[-1]: r for r in rows}
    assert (by["0100"]["label"], by["0100"]["reason"], by["0100"]["tt_min_s"]) == ("STAFF/OTHER", "nemotron", 105.0)     # 100 s of nemotron turns: below 105
    assert (by["0200"]["label"], by["0200"]["reason"], by["0200"]["tt_min_s"]) == ("CONSULT-LIKE", "pyannote", 90.0)     # 100 s of pyannote turns: above 90
    assert (by["0300"]["label"], by["0300"]["reason"], by["0300"]["tt_min_s"]) == ("UNCLASSIFIED", "no_turns", 90.0)
