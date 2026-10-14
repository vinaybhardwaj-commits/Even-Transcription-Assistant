import hashlib
import json
import os

import pytest

from kit.reb import classify_pre_2oct as cp
from kit.reb import write_track
from kit.reb.writer import config_hash

T0 = 1790400000000                                       # 2026-09-26 UTC; the IST date/week are derived from it
ROOM = "room_aaaa1111"
ALT = tuple((i * 20, i * 20 + 18, str(i % 2)) for i in range(15))     # one 298 s turn-taking chain


def put(root, date, wid, layer, engine, segs, status="ok", stub=None):
    cfg = {"e": engine}
    t = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1", "config": cfg,
         "config_hash": config_hash(cfg), "machine": "t", "status": status, "reason": None if status == "ok" else "r", "segments": segs}
    return write_track(root, date, ROOM, wid, t, manifest_stub=stub)


@pytest.fixture
def env(tmp_path):
    root, data, tapes = tmp_path / "reb", tmp_path / "data", tmp_path / "tapes"
    for d in (root, data, tapes):
        d.mkdir()
    (tapes / "manifest.jsonl").write_text("")
    (data / "w.webm").write_bytes(b"audio-bytes")
    sha = hashlib.sha256(b"audio-bytes").hexdigest()

    def window(hh, date="2026-09-26", kind="room_tape", audio="good", wid=None):
        wid = wid or f"c-{date}_{ROOM}_{hh}00"
        key = {"good": "local:w.webm", "gone": "local:nope.webm"}[audio]
        t0 = T0 + int(hh) * 3600000
        stub = {"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": date, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": kind,
                "audio": {"r2_key": key, "sha256": sha, "sample_rate": 1, "duration_ms": 900000}}
        return wid, stub
    return str(root), str(data), str(tapes), window


def run(env_):
    root, data, tapes, _ = env_
    rows = []
    weeks, tot, reasons = cp.census(root, is_held=lambda d, r: False, tapes=tapes, data=data, rows_out=rows)
    return weeks, tot, reasons, rows


def test_labels_audio_missing_and_exclusions(env):
    root, _, _, window = env
    a, sa = window("01")
    put(root, "2026-09-26", a, "diar", "pyannote-local-twin", [{"t0_ms": x * 1000, "t1_ms": y * 1000, "speaker": s} for x, y, s in ALT], stub=sa)
    q, sq = window("02")
    put(root, "2026-09-26", q, "diar", "pyannote-local-twin", [], status="empty", stub=sq)
    u, su = window("03")
    put(root, "2026-09-26", u, "stt", "koyal", [{"t0_ms": 0, "t1_ms": 1000, "text": "x"}], stub=su)           # a window with no diar of any kind
    g, sg = window("04", audio="gone")
    put(root, "2026-09-26", g, "diar", "pyannote-local-twin", [], status="empty", stub=sg)                   # has turns but no audio: not classified
    d, sd = window("05")
    put(root, "2026-09-26", d, "stt", "koyal", [], stub=sd)
    mp = os.path.join(root, "2026-09-26", ROOM, d, "manifest.json")                  # the writer only takes room_tape here; mark it dev_clip on disk
    m = json.load(open(mp))
    m["source_kind"] = "dev_clip"
    json.dump(m, open(mp, "w"))
    late, sl_ = window("06", date="2026-10-02")
    put(root, "2026-10-02", late, "stt", "koyal", [], stub=sl_)
    weeks, tot, reasons, rows = run(env)
    assert list(weeks) == ["2026-W39"]                                       # 26 Sep 2026 is a Saturday of ISO week 39
    w = weeks["2026-W39"]
    assert {k: v["windows"] for k, v in w.items()} == {"CONSULT-LIKE": 1, "QUIET": 1, "UNCLASSIFIED": 1, "audio_missing": 1}
    assert w["CONSULT-LIKE"]["audio_s"] == 900.0
    assert tot["manifests"] == 5 and tot["not_room_window"] == 1 and tot["room_windows"] == 4 and tot["audio_ok"] == 3      # the 2 Oct window is past the cutoff
    assert reasons[("UNCLASSIFIED", "no_turns")] == 1 and {r["label"] for r in rows} == {"CONSULT-LIKE", "QUIET", "UNCLASSIFIED"}


def test_sealed_and_blind_counted_before_audio_is_touched(env):
    root, data, tapes, window = env
    s, ss = window("01", wid="L041")
    put(root, "2026-09-26", s, "stt", "koyal", [], stub=ss)
    b, sb = window("02")
    put(root, "2026-09-26", b, "stt", "koyal", [], stub=sb)
    os.remove(os.path.join(data, "w.webm"))                                    # audio gone: sealed/blind must not reach window_plan
    weeks, tot, _ = cp.census(root, is_held=lambda d, r: False, tapes=tapes, data=data)
    assert weeks["2026-W39"]["sealed"]["windows"] == 1 and weeks["2026-W39"]["audio_missing"]["windows"] == 1
    weeks, tot, _ = cp.census(root, is_held=lambda d, r: True, tapes=tapes, data=data)
    assert weeks["2026-W39"]["blind"]["windows"] == 1 and "audio_missing" not in weeks["2026-W39"]


def test_nothing_is_written_to_the_store(env):
    root, _, _, window = env
    a, sa = window("01")
    put(root, "2026-09-26", a, "diar", "pyannote-local-twin", [], status="empty", stub=sa)
    snap = lambda: sorted((os.path.join(dp, f), os.path.getsize(os.path.join(dp, f)), os.path.getmtime(os.path.join(dp, f)))
                          for dp, _, fs in os.walk(root) for f in fs if not f.endswith(".lock"))
    before = snap()
    run(env)
    assert snap() == before


def test_estimates_arithmetic_and_rtf(tmp_path):
    log = tmp_path / "n.jsonl"
    log.write_text("\n".join(json.dumps(r) for r in [{"status": "ok", "audio_s": 1000, "wall_s": 12}, {"status": "ok", "audio_s": 3000, "wall_s": 36},
                                                     {"status": "failed", "audio_s": 500, "wall_s": 99}, {"deferred": "recut"}]))
    r = cp.rtf_from_lane_log(str(log))
    assert r["rtf"] == 0.012 and r["rows"] == 2
    assert cp.pool_rtf([str(log), str(log)])["rtf"] == 0.012 and cp.pool_rtf([str(log), str(log)])["rows"] == 4
    weeks = {"W1": {"CONSULT-LIKE": {"windows": 2, "audio_s": 7200.0}, "QUIET": {"windows": 2, "audio_s": 7200.0}, "UNCLASSIFIED": {"windows": 4, "audio_s": 14400.0},
                    "audio_missing": {"windows": 1, "audio_s": 3600.0}},
             "W2": {"UNCLASSIFIED": {"windows": 4, "audio_s": 14400.0}}}                       # W2 has no classified window: the pooled share still covers it
    e = cp.estimates(weeks, {"best": 0.012}, 360.0, 14_000_000.0, {"calls": 10, "throttled": 0})
    n = e["nemotron"]
    assert n["unclassified_h_windows"] == 8.0 and n["nemotron_runs"]["best"]["gpu_h"] == 0.1 and n["nemotron_runs"]["best"]["build_h"] == 0.8
    assert n["nemotron_runs"]["best"]["wall_h_at_share"] == {"0.25": 3.58, "0.5": 1.79, "1.0": 0.9}
    assert n["audio_missing_h_windows"] == 1.0 and n["tape_fetch_gb_for_uncovered"] == 0.01
    sar = e["sarvam"]
    assert sar["consult_like_h_windows"] == 2.0 and sar["jobs"] == 2
    assert sar["projection_b_assumption"]["share"] == 0.5 and sar["projection_b_assumption"]["consult_like_h_in_unclassified"] == 4.0   # 50% of 8 h, W2 included
    assert sar["projection_b_assumption"]["total_audio_h"] == 6.0 and "ASSUMPTION" in sar["projection_b_assumption"]["basis"]
    assert sar["projection_a_w39_only"]["consult_like_h_in_unclassified"] == 2.0 and sar["projection_a_w39_only"]["total_audio_h"] == 4.0   # W1 only: 50% of its 4 h
    assert sar["observed_x_realtime"] == 61.8


def test_distinct_hours_union_and_uncovered_missing():
    h = 3600.0
    ivs = {("r1", "W1", "UNCLASSIFIED"): [(0, h), (0.5 * h, 1.5 * h)],                 # two overlapping windows: 1.5 distinct hours, 2 window-hours
           ("r1", "W1", "audio_missing"): [(h, 2.5 * h)],                              # 1.5 h missing, of which 0.5 h (1..1.5) is inside an audio-ok window
           ("r2", "W1", "QUIET"): [(0, h)]}
    d = cp.distinct_hours(ivs)["W1"]
    assert d["UNCLASSIFIED"] == 1.5 and d["QUIET"] == 1.0 and d["audio_ok"] == 2.5 and d["all"] == 3.5 and d["missing_uncovered"] == 1.0


def test_audio_problems_are_listed_and_the_day_range(env, tmp_path):
    root, data, tapes, window = env
    g, sg = window("04", audio="gone")
    put(root, "2026-09-26", g, "diar", "pyannote-local-twin", [], status="empty", stub=sg)
    problems = []
    cp.census(root, is_held=lambda d, r: False, tapes=tapes, data=data, problems_out=problems)
    assert len(problems) == 1 and problems[0]["kind"] == "audio_missing" and problems[0]["window_id"] == g and "text" not in problems[0]
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    a.write_text(json.dumps({"status": "ok", "audio_s": 100, "wall_s": 1}))
    b.write_text(json.dumps({"status": "ok", "audio_s": 100, "wall_s": 3}))
    assert cp.day_range([str(a), str(b)]) == {"min": 0.01, "max": 0.03, "logs": 2}


def test_census_restores_the_sha_function(env):
    import kit.reb.sarvam_lane as sl
    real = sl._file_sha
    root, data, tapes, window = env
    a, sa = window("01")
    put(root, "2026-09-26", a, "diar", "pyannote-local-twin", [], status="empty", stub=sa)
    cp.census(root, is_held=lambda d, r: False, tapes=tapes, data=data, sha=lambda p: "x")
    assert sl._file_sha is real


def test_iso_week_uses_the_ist_date():
    assert cp.iso_week(1790372400000) == cp.iso_week(1790372400000 + 1000)
    assert cp.iso_week(1790400000000) == "2026-W39"
