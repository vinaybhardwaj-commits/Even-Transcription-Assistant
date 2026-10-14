import json
import os
import types

import pytest

from kit.reb import from_hist as fh

T0 = "2026-10-06T05:30:00+00:00"   # 11:00 IST
T0_MS = 1791264600000
ROOM = "room_abcd1234"


def hist(wid="c-2026-10-06_room_abcd1234_1100", ok=True, state="done", nseg=2, router=":c4s1", run="run-A", start=T0,
         end="2026-10-06T05:45:00+00:00", covered=1.0):
    segs = [{"start_s": 1.0 + 10 * i, "end_s": 5.0 + 10 * i, "lang": "hi", "engine": "sravaani", "text": f"synthetic text {i}",
             "score": 12.5} for i in range(nseg)]
    return {"schema": "eta-lab-result/1", "run_id": run, "window_id": wid, "room_id": ROOM, "start": start, "end": end,
            "router": router, "node": "e2e-c4", "ok": ok, "state": state, "error": None if ok else "boom",
            "router_status": "ok", "dominant_language": "hi", "indic_script_share": 0.4, "english_dominant": False,
            "english_span_share": 0.1, "language_timeline": [{"start_s": 0, "end_s": 9, "lang": "hi", "engine": "sravaani", "chars": 5}],
            "segments": segs, "versions": {"pinned_prod_sha": "5970852"},
            "cut": {"duration_s": 900.0, "covered_fraction": covered, "gap_s": 0.0, "n_chunks": 1, "chunk_keys": ["bench/x/chunk_1.webm"],
                    "chunks_used": [{"r2_key": "bench/x/chunk_1.webm"}], "chunks_dropped": []},
            "provenance": {"stack": {"whisper": {"model": "m"}}, "guards": {"g": "x"}, "not_run": ["diarizer"],
                           "served_by": {"node": "e2e-c4", "router_port": router}, "created_at": "2026-10-06T07:00:00Z"}}


@pytest.fixture
def env(tmp_path):
    runs, root = tmp_path / "runs", tmp_path / "reb"
    runs.mkdir(); root.mkdir()
    return types.SimpleNamespace(runs=str(runs), root=str(root), outbox=str(tmp_path / "ob.jsonl"), tmp=tmp_path)


def put(env, h, run="run-A", date="2026-10-06"):
    d = os.path.join(env.runs, run, ROOM, date)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, h["window_id"] + ".json"), "w") as f:
        json.dump(h, f)


def go(env, write=True, held=lambda d, r: False, aliases=(), run="run-A", limit=0):
    a = types.SimpleNamespace(run=run, since=None, all=False, write=write, limit=limit)
    return fh.run(a, runs_dir=env.runs, root=env.root, is_held=held, aliases=list(aliases), outbox=env.outbox, log_dir=None)


def tracks(env):
    out = []
    for dp, _, fs in os.walk(env.root):
        out += [os.path.join(dp, f) for f in fs if dp.endswith("tracks")]
    return sorted(out)


def test_dry_run_writes_nothing(env):
    put(env, hist())
    c = go(env, write=False)
    assert c["would_write"] == 1 and c["written"] == 0 and tracks(env) == [] and not os.path.exists(env.outbox)


def test_ok_run(env):
    put(env, hist())
    c = go(env)
    assert c["written"] == 1 and c["ok"] == 1 and c["degraded"] == 0
    (p,) = tracks(env)
    assert os.path.basename(p).startswith("stt.router-twin-c4s1__5970852__")
    t = json.load(open(p))
    assert t["schema"] == "reb.track.v1" and t["status"] == "ok" and t["version"] == "5970852"
    assert t["segments"][0]["t0_ms"] == T0_MS + 1000 and t["segments"][0]["t1_ms"] == T0_MS + 5000
    assert t["segments"][1]["t0_ms"] == T0_MS + 11000 and t["segments"][0]["conf"] == 12.5
    assert t["segments"][0]["extras"] == {"engine": "sravaani"} and t["segments"][0]["lang"] == "hi"
    ex = t["extras"]
    assert ex["run_id"] == "run-A" and ex["language_timeline"] and ex["guards"] == {"g": "x"} and ex["not_run"] == ["diarizer"]
    assert ex["cut"]["chunk_r2_keys"] == ["bench/x/chunk_1.webm"] and ex["degraded"] is False
    # manifest + index + outbox
    m = json.load(open(os.path.join(env.root, "2026-10-06", ROOM, "c-2026-10-06_room_abcd1234_1100", "manifest.json")))
    assert m["t0_ms"] == T0_MS and m["t1_ms"] == T0_MS + 900000 and len(m["tracks"]) == 1
    idx = [json.loads(l) for l in open(os.path.join(env.root, "2026-10-06", "index.jsonl"))]
    assert idx[0]["engine"] == "router-twin-c4s1" and idx[0]["sha256"] == m["tracks"][0]["sha256"]
    ob = [json.loads(l) for l in open(env.outbox)]
    assert ob[0]["shadow"] is False and ob[0]["r2_key"] == "reb/" + idx[0]["path"] and ob[0]["bytes"] == os.path.getsize(p)


def test_empty_run_is_degraded_evidence(env):
    put(env, hist(nseg=0, covered=1.0))
    c = go(env)
    assert c["empty"] == 1 and c["written"] == 1 and c["degraded"] == 1
    t = json.load(open(tracks(env)[0]))
    assert t["status"] == "empty" and t["extras"]["degraded"] is True and "zero segments" in t["extras"]["degraded_reason"]


def test_failed_run_never_skipped(env):
    put(env, hist(ok=False, state="failed", nseg=0))
    c = go(env)
    assert c["failed"] == 1 and c["written"] == 1 and c["degraded"] == 1
    t = json.load(open(tracks(env)[0]))
    assert t["status"] == "failed" and t["reason"] == "boom" and t["extras"]["error"] == "boom"


def test_idempotent_and_conflict(env):
    put(env, hist())
    go(env)
    c = go(env)
    assert c["skipped_existing"] == 1 and c["written"] == 0 and len(tracks(env)) == 1
    (p,) = tracks(env)
    original = open(p, "rb").read()
    with open(p, "w") as f:
        f.write(original.decode().replace("synthetic text 0", "tampered"))
    tampered = open(p, "rb").read()
    c = go(env)
    assert c["conflicts"] == 1 and c["written"] == 0
    assert open(p, "rb").read() == tampered   # never overwritten
    conflicts = [t for t in tracks(env) if ".conflict-" in t]
    assert len(conflicts) == 1 and open(conflicts[0], "rb").read() == original
    assert len(open(os.path.join(env.root, "2026-10-06", "index.jsonl")).readlines()) == 1


def test_blind_day_refused(env):
    put(env, hist())
    c = go(env, held=lambda d, r: (d, r) == ("2026-10-06", ROOM))
    assert c["blind_refused"] == 1 and c["written"] == 0 and tracks(env) == []
    assert not os.path.exists(os.path.join(env.root, "2026-10-06"))


def test_blind_day_on_window_end_refused(env):
    # window 23:45-00:00 IST: t1-1s is still the first day, but a window ending after midnight touches the next day
    put(env, hist(wid="c-2026-10-06_room_abcd1234_2345", start="2026-10-06T18:15:00+00:00", end="2026-10-06T18:45:00+00:00"))
    c = go(env, held=lambda d, r: d == "2026-10-07")   # 18:45Z = 00:15 IST on the 7th (t1-1s)
    assert c["blind_refused"] == 1 and tracks(env) == []


def test_guard_fails_closed(tmp_path):
    with pytest.raises(SystemExit):
        fh.load_heldout(str(tmp_path / "missing.py"))
    bad = tmp_path / "heldout.py"
    bad.write_text("def load_union(): return set(), 'x'\n")
    with pytest.raises(SystemExit):   # wrong sha16
        fh.load_heldout(str(bad))


def test_misnamed_id_resolved_by_manifest_start(env):
    new_id, old_id = "c-2026-10-05_room_abcd1234_2315", "c-2026-10-06_room_abcd1234_2315"
    d = os.path.join(env.root, "2026-10-05", ROOM, new_id)
    os.makedirs(d)
    t0 = T0_MS
    json.dump({"window_id": new_id, "room_id": ROOM, "room_slug": ROOM, "ist_date": "2026-10-05", "t0_ms": t0, "t1_ms": t0 + 900000,
               "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 1}, "tracks": []}, open(os.path.join(d, "manifest.json"), "w"))
    put(env, hist(wid=old_id), date="2026-10-06")
    alias = {"reb_window": f"2026-10-05/{ROOM}/{old_id}", "old_id": old_id, "new_id": new_id}
    c = go(env, aliases=[alias])
    assert c["alias_resolved"] == 1 and c["written"] == 1 and c["new_manifest"] == 0
    (p,) = tracks(env)
    assert f"/2026-10-05/{ROOM}/{new_id}/tracks/" in p
    assert json.load(open(p))["window_id"] == new_id


def test_alias_not_accepted_when_start_time_differs(env):
    new_id, old_id = "c-2026-10-05_room_abcd1234_2315", "c-2026-10-06_room_abcd1234_2315"
    d = os.path.join(env.root, "2026-10-05", ROOM, new_id)
    os.makedirs(d)
    json.dump({"window_id": new_id, "room_id": ROOM, "room_slug": ROOM, "ist_date": "2026-10-05", "t0_ms": T0_MS + 86400000,
               "t1_ms": T0_MS + 86400000 + 900000, "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 1}, "tracks": []},
              open(os.path.join(d, "manifest.json"), "w"))
    put(env, hist(wid=old_id))
    c = go(env, aliases=[{"reb_window": f"2026-10-05/{ROOM}/{old_id}", "old_id": old_id, "new_id": new_id}])
    assert c["alias_resolved"] == 0 and c["new_manifest"] == 1


def test_existing_manifest_t0_wins_and_numeric_port_stack(env):
    wid = "c-2026-10-06_room_abcd1234_1100"
    d = os.path.join(env.root, "2026-10-06", ROOM, wid)
    os.makedirs(d)
    json.dump({"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": "2026-10-06", "t0_ms": T0_MS + 500, "t1_ms": T0_MS + 900500,
               "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 1}, "tracks": []}, open(os.path.join(d, "manifest.json"), "w"))
    put(env, hist(router=":30203"))
    c = go(env)
    assert c["t0_from_manifest"] == 1 and c["written"] == 1
    (p,) = tracks(env)
    assert "router-twin-e2e-c4-30203" in p
    assert json.load(open(p))["segments"][0]["t0_ms"] == T0_MS + 500 + 1000


def test_cfg8_distinguishes_runs_and_is_stable():
    a, b = hist(run="r1"), hist(run="r2")
    assert fh.cfg8_of(a) == fh.cfg8_of(dict(a)) and fh.cfg8_of(a) != fh.cfg8_of(b) and len(fh.cfg8_of(a)) == 8


def test_limit_and_bad_file_counted(env):
    put(env, hist())
    put(env, hist(wid="c-2026-10-06_room_abcd1234_1115"))
    d = os.path.join(env.runs, "run-A", ROOM, "2026-10-06", "zz-broken.json")
    open(d, "w").write("{not json")
    assert go(env, limit=1)["seen"] == 1
    c = go(env)
    assert c["errors"] == 1 and c["written"] == 1 and c["skipped_existing"] == 1


def test_refused_segments_keep_verdict_and_degrade_when_all_refused(env):
    h = hist(nseg=0)
    h["segments"] = [
        {"start_s": 1.0, "end_s": 4.0, "lang": "en", "engine": "whisper", "text": "", "confidence": 0.3, "refused": True,
         "refused_reason": "english_hallucination_guard"},
        {"start_s": 5.0, "end_s": 9.0, "lang": "hi", "engine": "sravaani", "text": "synthetic kept", "score": 7.0},
    ]
    put(env, h)
    go(env)
    t = json.load(open(tracks(env)[0]))
    a, b = t["segments"]
    assert a["conf"] == 0.3 and a["extras"] == {"engine": "whisper", "confidence": 0.3, "refused": True,
                                               "refused_reason": "english_hallucination_guard"}
    assert b["conf"] == 7.0 and "refused" not in b["extras"]
    assert t["extras"]["n_refused"] == 1 and t["extras"]["n_segments"] == 2 and t["extras"]["degraded"] is False


def test_all_refused_window_is_degraded(env):
    h = hist(nseg=0)
    h["segments"] = [{"start_s": 1.0, "end_s": 4.0, "lang": "en", "engine": "whisper", "text": "", "confidence": 0.2,
                      "refused": True, "refused_reason": "english_hallucination_guard"}]
    h["assembled_collapse"] = {"units_collapsed": 0}
    put(env, h)
    c = go(env)
    t = json.load(open(tracks(env)[0]))
    assert c["degraded"] == 1 and t["status"] == "ok"
    assert t["extras"]["degraded"] is True and "all segments guard-refused" in t["extras"]["degraded_reason"]
    assert t["extras"]["n_refused"] == 1 and t["extras"]["assembled_collapse"] == {"units_collapsed": 0}
