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


def default_wreb(env):
    """A worklist dir with one unrelated row (an empty/missing worklist now fails closed)."""
    d = env.tmp / "wreb-default"
    d.mkdir(exist_ok=True)
    (d / "manifest-2000-01-01.jsonl").write_text(json.dumps({"win_id": "x", "room": "room_zzzzzzzz", "ist_date": "2000-01-01",
                                                              "start": "2000-01-01T00:00:00+00:00"}) + "\n")
    return str(d)


def go(env, write=True, held=lambda d, r: False, aliases=(), run="run-A", limit=0, wreb=None):
    a = types.SimpleNamespace(run=run, since=None, all=False, write=write, limit=limit)
    return fh.run(a, runs_dir=env.runs, root=env.root, is_held=held, aliases=list(aliases), outbox=env.outbox, log_dir=None, wreb=wreb or default_wreb(env))


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
    import glob
    tdir = os.path.dirname(p)
    assert glob.glob(os.path.join(tdir, "*.json")) == [p]   # only the original directly in tracks/ (R4)
    conflicts = glob.glob(os.path.join(tdir, "_conflicts", "*.conflict-*.json"))
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


def test_only_the_swapped_heldout_file_loads_and_the_old_one_fails_closed(tmp_path):
    import hashlib
    assert fh.HELDOUT_PY_SHA16S == ("880404e36fd6b650",)
    old = tmp_path / "old.py"
    old.write_text("def load_union(): return {'2026-09-26 OPD4'}, 'x'\ndef is_held_out(u, d, r): return f'{d} OPD4' in u\n")
    assert hashlib.sha256(old.read_bytes()).hexdigest()[:16] != "880404e36fd6b650"
    with pytest.raises(SystemExit):   # any file that is not the pinned one, the pre-swap f672c1ef included, fails closed
        fh.load_heldout(str(old))


def test_pinned_heldout_loads_and_holds_nothing(tmp_path, monkeypatch):
    import hashlib
    new = tmp_path / "new.py"
    new.write_text("def load_union(): return set(), 'y'\ndef is_held_out(u, d, r): return f'{d} OPD4' in u\n")
    monkeypatch.setattr(fh, "HELDOUT_PY_SHA16S", (hashlib.sha256(new.read_bytes()).hexdigest()[:16],))
    assert fh.load_heldout(str(new))("2026-09-26", "room_ux92qpws") is False


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
    put(env, hist(wid="c-2026-10-06_room_abcd1234_1115", start="2026-10-06T05:45:00+00:00", end="2026-10-06T06:00:00+00:00"))
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


def test_mining_only_carried_as_is_or_omitted(env):
    h = hist(); h["mining_only"] = True
    put(env, h)
    go(env)
    assert json.load(open(tracks(env)[0]))["extras"]["mining_only"] is True


def test_mining_only_absent_is_not_invented(env):
    put(env, hist())   # fixture has no mining_only key
    go(env)
    assert "mining_only" not in json.load(open(tracks(env)[0]))["extras"]


def test_null_conf_when_source_gave_no_score(env):
    h = hist(nseg=0)
    h["segments"] = [{"start_s": 1.0, "end_s": 2.0, "lang": "hi", "engine": "x", "text": "synthetic"}]
    put(env, h)
    go(env)
    seg = json.load(open(tracks(env)[0]))["segments"][0]
    assert seg["conf"] is None and "refused" not in seg["extras"]


def wreb_with(env, win_id, room=ROOM, start=T0):
    d = env.tmp / "wreb"
    d.mkdir(exist_ok=True)
    (d / "manifest-2026-10-06.jsonl").write_text(json.dumps({"win_id": win_id, "room": room, "ist_date": "2026-10-06", "start": start}) + "\n")
    return str(d)


def test_backfill_window_without_manifest_is_deferred(env):
    put(env, hist())   # hist id has the "c-" prefix, the worklist does not
    c = go(env, wreb=wreb_with(env, "2026-10-06_room_abcd1234_1100"))
    assert c["deferred_backfill_window"] == 1 and c["written"] == 0 and c["new_manifest"] == 0
    assert tracks(env) == [] and not os.path.exists(os.path.join(env.root, "2026-10-06")) and not os.path.exists(env.outbox)


def test_deferred_matches_by_start_time_too(env):
    put(env, hist())
    c = go(env, wreb=wreb_with(env, "some-other-id", start=T0))
    assert c["deferred_backfill_window"] == 1


def test_unlisted_no_manifest_window_still_gets_placeholder_manifest(env):
    put(env, hist())
    c = go(env, wreb=wreb_with(env, "2026-10-06_room_abcd1234_2000", start="2026-10-06T14:30:00+00:00"))
    assert c["deferred_backfill_window"] == 0 and c["written"] == 1 and c["new_manifest"] == 1


def test_listed_window_with_manifest_is_unaffected(env):
    wid = "c-2026-10-06_room_abcd1234_1100"
    d = os.path.join(env.root, "2026-10-06", ROOM, wid)
    os.makedirs(d)
    json.dump({"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": "2026-10-06", "t0_ms": T0_MS, "t1_ms": T0_MS + 900000,
               "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 1}, "tracks": []}, open(os.path.join(d, "manifest.json"), "w"))
    put(env, hist())
    c = go(env, wreb=wreb_with(env, "2026-10-06_room_abcd1234_1100"))
    assert c["deferred_backfill_window"] == 0 and c["written"] == 1


def put_attempt(env, h, n=1, run="run-A", date="2026-10-06", **over):
    a = dict(h, **over)
    d = os.path.join(env.runs, run, ROOM, date)
    with open(os.path.join(d, f"{h['window_id']}.attempt{n}.json"), "w") as f:
        json.dump(a, f)


def test_attempt_file_never_converted_alone_and_carried_as_evidence(env):
    final = hist(nseg=2)
    put(env, final)
    put_attempt(env, final, ok=False, state="failed", error="push_rc_255", segments=[], router_status=None)
    c = go(env)
    assert c["seen"] == 1 and c["written"] == 1 and c["conflicts"] == 0 and c["attempts_carried"] == 1
    (p,) = tracks(env)
    t = json.load(open(p))
    assert t["status"] == "ok" and len(t["segments"]) == 2
    (att,) = t["extras"]["attempts"]
    assert att == {"n": 1, "file": final["window_id"] + ".attempt1.json", "state": "failed", "ok": False, "error": "push_rc_255",
                   "router_status": None, "created_at": "2026-10-06T07:00:00Z", "n_segments": 0}
    assert "synthetic text" not in json.dumps(att)


def test_attempt_only_window_has_no_track(env):
    h = hist()
    d = os.path.join(env.runs, "run-A", ROOM, "2026-10-06")
    os.makedirs(d)
    put_attempt(env, h)
    assert go(env)["seen"] == 0 and tracks(env) == []


def test_no_attempts_key_when_none(env):
    put(env, hist())
    go(env)
    assert "attempts" not in json.load(open(tracks(env)[0]))["extras"]


def test_worklist_fails_closed_missing_and_empty(env, tmp_path):
    put(env, hist())
    with pytest.raises(SystemExit):
        go(env, wreb=str(tmp_path / "nope"))
    empty = tmp_path / "emptydir"
    empty.mkdir()
    with pytest.raises(SystemExit):
        go(env, wreb=str(empty))
    (empty / "manifest-1.jsonl").write_text("not json\n")
    with pytest.raises(SystemExit):
        go(env, wreb=str(empty))
    assert tracks(env) == [] and not os.path.exists(os.path.join(env.root, "2026-10-06"))


def test_worklist_rows_in_counts(env):
    put(env, hist())
    assert go(env)["worklist_rows"] == 1


def _manifest(env, wid, t0):
    d = os.path.join(env.root, "2026-10-06", ROOM, wid)
    os.makedirs(d)
    json.dump({"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": "2026-10-06", "t0_ms": t0, "t1_ms": t0 + 900000,
               "audio": {"r2_key": "real", "sha256": "realsha", "sample_rate": 48000, "duration_ms": 900000}, "tracks": []},
              open(os.path.join(d, "manifest.json"), "w"))


def test_start_only_resolves_into_existing_other_id_manifest(env):
    _manifest(env, "2026-10-06_room_abcd1234_1100", T0_MS)    # BACKFILL's id (no "c-")
    put(env, hist())   # hist id has the c- prefix; worklist lists the other id and the same start
    c = go(env, wreb=wreb_with(env, "2026-10-06_room_abcd1234_1100"))
    assert c["start_resolved"] == 1 and c["deferred_backfill_window"] == 0 and c["written"] == 1 and c["new_manifest"] == 0
    (p,) = tracks(env)
    assert "/2026-10-06_room_abcd1234_1100/tracks/" in p and json.load(open(p))["window_id"] == "2026-10-06_room_abcd1234_1100"
    m = json.load(open(os.path.join(os.path.dirname(os.path.dirname(p)), "manifest.json")))
    assert m["audio"]["sha256"] == "realsha" and len(m["tracks"]) == 1   # real audio kept, entry appended


def test_start_only_without_any_manifest_still_defers(env):
    put(env, hist())
    c = go(env, wreb=wreb_with(env, "some-other-id", start=T0))
    assert c["start_resolved"] == 0 and c["deferred_backfill_window"] == 1 and tracks(env) == []


def test_write_track_config_hash_override_is_additive():
    from kit.reb import writer
    import inspect
    assert inspect.signature(writer.write_track).parameters["config_hash"].default is None
    assert writer.config_hash({"a": 1}) == writer._default_config_hash({"a": 1})


def test_sealed_window_ids_are_never_converted(env):
    put(env, hist(wid="L041"))
    c = go(env)
    assert c["sealed"] == 1 and c["written"] == 0 and tracks(env) == []
    assert fh.SEALED_WINDOWS == {"L041", "L057", "L139", "L182"}


def test_a_start_match_into_a_sealed_window_is_refused_before_its_manifest_is_opened(env):
    d = os.path.join(env.root, "2026-10-06", ROOM, "L041")
    os.makedirs(d)
    mp = os.path.join(d, "manifest.json")
    json.dump({"window_id": "L041", "room_id": ROOM, "room_slug": ROOM, "ist_date": "2026-10-06", "t0_ms": T0_MS, "t1_ms": T0_MS + 900000,
               "audio": {"r2_key": "k", "sha256": "s", "sample_rate": 1, "duration_ms": 1}, "tracks": []}, open(mp, "w"))
    before = open(mp, "rb").read()
    put(env, hist())                                                          # an ordinary id with the same room and the same start as the sealed window
    c = go(env)
    assert c["sealed"] == 1 and c["written"] == 0 and c["start_resolved"] == 0 and c["new_manifest"] == 0
    assert tracks(env) == [] and open(mp, "rb").read() == before and sorted(os.listdir(os.path.join(env.root, "2026-10-06", ROOM))) == ["L041"]
