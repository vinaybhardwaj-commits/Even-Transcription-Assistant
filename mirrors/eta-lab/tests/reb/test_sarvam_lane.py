import copy
import json
import os
import types

import pytest

from kit.reb import consult, consults, windows_for, writer
from kit.reb import sarvam_lane as sl

ROOM, DATE, UID = "room_abcd1234", "2026-10-06", "uid123abc"
SPAN_START_UTC = "2026-10-06T04:12:22.522000+00:00"
SPAN_START_MS = sl._utc_ms(SPAN_START_UTC)
SIG = [1791347601.726, "url_clear", "DOC1"]


def make_row(uid=UID, date=DATE, status="cut", sig=None, minutes=5.0):
    return {"consult_uid": uid, "ist_date": date, "room_slug": "opd-x", "room_id": ROOM, "doctor_uid": "DOC1", "doctor_identified": True,
            "t_open": f"{date} 09:43:22.522", "t_close": f"{date} 09:47:22.522", "close_reason": "url_clear", "quality": "clean",
            "resolver_version": "encounter-windows/2", "signature": sig or list(SIG), "code_commit": "abc", "status": status, "rule": "r",
            "flags": [], "span_start": f"{date} 09:42:22.522", "span_end": f"{date} 09:47:22.522", "minutes": minutes,
            "path": f"{date}/opd-x/{uid}", "bytes": {"consult.flac": 2000}, "r2": {"status": "pending", "prefix": f"consult-clips/{date}/opd-x/{uid}"}}


def make_clip(root, row, flac=b"fLaC" + b"\0" * 1996, tl_uid=None):
    d = os.path.join(root, row["path"])
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "consult.flac"), "wb").write(flac)
    start = sl._ist_ms(row["span_start"]); end = sl._ist_ms(row["span_end"])
    tl = {"consult_uid": tl_uid or row["consult_uid"], "window": {"t_open": row["t_open"], "t_close": row["t_close"]},
          "span": {"start_utc": sl.datetime.datetime.fromtimestamp(start / 1000, sl.datetime.timezone.utc).isoformat(),
                   "end_utc": sl.datetime.datetime.fromtimestamp(end / 1000, sl.datetime.timezone.utc).isoformat()}}
    json.dump(tl, open(os.path.join(d, "timeline.json"), "w"))


class FakeGW:
    def __init__(self, entries=None, fail=None):
        self.calls, self.throttled = [], 0
        self.entries = entries if entries is not None else [{"speaker_id": "0", "start": 1.5, "end": 4.0, "transcript": "synthetic one"},
                                                            {"speaker_id": "1", "start": 4.5, "end": 9.25, "transcript": "synthetic two"}]
        self.fail = fail

    def transcribe(self, path, params, sleep=None, on_start=None):
        self.calls.append((os.path.basename(path), params["mode"]))
        if on_start:
            on_start("job-" + str(len(self.calls)))
        if self.fail:
            raise self.fail
        raw = {"0.json": {"language_code": "hi-IN", "language_probability": 0.9, "request_id": "req1", "transcript": "t", "timestamps": {},
                          "diarized_transcript": {"entries": self.entries}}}
        return raw, {"job_id": "job1", "states": ["pending", "running", "completed"], "wall_s": 1.5, "request_ids": ["req1"], "throttled": False}


class Env:
    def __init__(self, tmp, rows):
        self.clips, self.root = str(tmp / "clips"), str(tmp / "reb")
        os.makedirs(self.clips); os.makedirs(self.root)
        self.index = str(tmp / "clips" / "index.jsonl")
        with open(self.index, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        for r in rows:
            if r["status"] == "cut":
                make_clip(self.clips, r)

    def run(self, gw, held=lambda d, r: False, write=True, sink=None, recut=frozenset(), **kw):
        a = types.SimpleNamespace(**{"consult": None, "date": None, "since": None, "write": write, "workers": 2, "limit": 0,
                                     "min_minutes": 0, "identified": False, **kw})
        return sl.run(a, gw=gw, root=self.root, is_held=held, index_path=self.index, clips_root=self.clips, log_dir=None, sleep=lambda s: None, sink=sink, recut_pending=recut)


def tdir(env, uid=UID, date=DATE):
    return os.path.join(env.root, date, ROOM, "_consults", uid, "tracks")


def test_stt_and_diar_from_one_job_with_tape_time(tmp_path):
    env = Env(tmp_path, [make_row()])
    gw = FakeGW()
    cnt = env.run(gw, date=DATE)
    assert gw.calls == [("consult.flac", "transcribe")]            # ONE call; diar is derived
    assert cnt["written"] == 2 and cnt["ok"] == 2
    names = sorted(os.listdir(tdir(env)))
    assert [n.split(".")[0] for n in names] == ["diar", "stt"] and all("sarvam-saaras-v3__saaras-v3__" in n for n in names)
    stt = json.load(open(os.path.join(tdir(env), [n for n in names if n.startswith("stt")][0])))
    diar = json.load(open(os.path.join(tdir(env), [n for n in names if n.startswith("diar")][0])))
    s0 = stt["segments"][0]
    assert s0["t0_ms"] == SPAN_START_MS + 1500 and s0["t1_ms"] == SPAN_START_MS + 4000     # tape time = span start + clip offset
    assert s0["extras"]["clip_t0_s"] == 1.5 and s0["lang"] == "hi-IN" and s0["text"] == "synthetic one"
    assert "text" not in diar["segments"][0] and diar["segments"][1]["speaker"] == "1"
    assert stt["extras"]["raw"]["0.json"]["diarized_transcript"]["entries"] == gw.entries and "raw" not in diar["extras"]   # raw job JSON kept once
    assert stt["extras"]["raw_sha256"] and stt["extras"]["raw_bytes"] > 0
    assert stt["extras"]["job_id"] == "job1" and stt["extras"]["request_id"] == "req1" and stt["extras"]["gateway"]
    assert stt["config"]["job_parameters"]["mode"] == "transcribe" and stt["config_hash"] == sl.cfg8_of(sl.job_params("transcribe"), SIG)


def test_guard_refuses_non_cut_row_and_window_file(tmp_path):
    skipped = make_row(uid="u_skip", status="skipped")
    env = Env(tmp_path, [skipped])
    gw = FakeGW()
    cnt = env.run(gw, consult="u_skip")
    assert gw.calls == [] and cnt["not_cut_refused"] == 1 and not os.path.exists(os.path.join(env.root, DATE))
    with pytest.raises(sl.ClipRefused):
        sl.open_clip(skipped, env.clips)
    # a "cut" row whose path points at a window webm (not a FLAC clip) is refused as well
    row = make_row(uid="u_win")
    env2 = Env(tmp_path / "w", [])
    os.makedirs(os.path.join(env2.clips, row["path"]))
    open(os.path.join(env2.clips, row["path"], "consult.flac"), "wb").write(b"\x1aE\xdf\xa3" + b"\0" * 1996)   # webm/EBML magic
    json.dump({}, open(os.path.join(env2.clips, row["path"], "timeline.json"), "w"))
    with pytest.raises(sl.ClipRefused):
        sl.open_clip(row, env2.clips)
    with pytest.raises(sl.ClipRefused):
        sl.open_clip({"status": "cut", "consult_uid": "x", "path": "../../etc", "room_id": ROOM, "ist_date": DATE, "span_start": "a",
                      "span_end": "b", "t_open": "a", "t_close": "b", "signature": [1], "bytes": {"consult.flac": 1}}, env2.clips)


def test_bytes_and_timeline_mismatch_fail_closed(tmp_path):
    row = make_row()
    env = Env(tmp_path, [row])
    bad = copy.deepcopy(row); bad["bytes"]["consult.flac"] = 1999
    with pytest.raises(sl.ClipRefused):
        sl.open_clip(bad, env.clips)
    make_clip(env.clips, row, tl_uid="someone-else")
    gw = FakeGW()
    cnt = env.run(gw)
    assert gw.calls == [] and cnt["clip_mismatch"] == 1 and cnt["written"] == 0


def test_latest_row_wins_a_later_skip_is_never_sent(tmp_path):
    env = Env(tmp_path, [make_row(), make_row(status="skipped")])
    gw = FakeGW()
    cnt = env.run(gw, date=DATE)
    assert gw.calls == [] and cnt["clips"] == 0


def test_blind_room_day_refused_before_any_send(tmp_path):
    env = Env(tmp_path, [make_row()])
    gw = FakeGW()
    cnt = env.run(gw, held=lambda d, r: True)
    assert gw.calls == [] and cnt["blind_refused"] == 1 and cnt["written"] == 0


def test_dry_run_sends_nothing_and_writes_nothing(tmp_path):
    env = Env(tmp_path, [make_row()])
    gw = FakeGW()
    cnt = env.run(gw, write=False)
    assert gw.calls == [] and cnt["would_write"] == 1 and not os.listdir(env.root)


def test_translate_only_from_oct8_separate_job(tmp_path):
    old = make_row(uid="u_old", date="2026-10-07")
    new = make_row(uid="u_new", date="2026-10-08")
    env = Env(tmp_path, [old, new])
    gw = FakeGW()
    env.run(gw)
    modes = sorted((c[1]) for c in gw.calls)
    assert modes == ["transcribe", "transcribe", "translate"]
    assert not [n for n in os.listdir(tdir(env, "u_old", "2026-10-07")) if n.startswith("translate")]
    assert [n for n in os.listdir(tdir(env, "u_new", "2026-10-08")) if n.startswith("translate")]


def test_recut_clip_new_signature_new_track_old_stays(tmp_path):
    env = Env(tmp_path, [make_row()])
    env.run(FakeGW())
    r2 = make_row(sig=[1791347700.0, "url_clear", "DOC1"])
    env2_rows = [r2]
    with open(env.index, "a") as f:
        f.write(json.dumps(r2) + "\n")
    gw = FakeGW()
    env.run(gw)
    assert len(gw.calls) == 1 and len(os.listdir(tdir(env))) == 4


def test_idempotent_rerun_makes_no_calls(tmp_path):
    env = Env(tmp_path, [make_row()])
    env.run(FakeGW())
    gw = FakeGW()
    cnt = env.run(gw)
    assert gw.calls == [] and cnt["written"] == 0 and cnt["skipped_existing"] == 1


def test_permanent_failure_recorded_transient_not(tmp_path):
    env = Env(tmp_path, [make_row()])
    cnt = env.run(FakeGW(fail=sl.GatewayError("job failed: bad audio")))
    assert cnt["failed"] == 1 and cnt["written"] == 2
    t = json.load(open(os.path.join(tdir(env), sorted(os.listdir(tdir(env)))[0])))
    assert t["status"] == "failed" and "bad audio" in t["reason"]
    env2 = Env(tmp_path / "b", [make_row()])
    cnt = env2.run(FakeGW(fail=sl.GatewayError("http 503", 503)))
    assert cnt["transient_errors"] == 1 and cnt["written"] == 0 and not os.path.exists(os.path.join(env2.root, DATE))


def test_empty_job_is_status_empty(tmp_path):
    env = Env(tmp_path, [make_row()])
    cnt = env.run(FakeGW(entries=[]))
    assert cnt["empty"] == 2


def test_readers_and_manifest_provenance(tmp_path):
    env = Env(tmp_path, [make_row()])
    # a REB window overlapping the span
    wid = "c-2026-10-06_room_abcd1234_0930"
    t0 = sl._ist_ms("2026-10-06 09:30:00.000"); t1 = t0 + 900000
    wdir = os.path.join(env.root, DATE, ROOM, wid); os.makedirs(wdir)
    json.dump({"window_id": wid, "room_id": ROOM, "ist_date": DATE, "t0_ms": t0, "t1_ms": t1, "tracks": []}, open(os.path.join(wdir, "manifest.json"), "w"))
    env.run(FakeGW())
    c = consult(UID, root=env.root)
    assert c.manifest["source_kind"] == "consult_clip" and c.manifest["consult"]["signature"] == SIG
    assert c.manifest["consult"]["close_reason"] == "url_clear" and c.manifest["consult"]["resolver_version"]
    assert windows_for(UID, root=env.root) == [wid]
    assert [w.window_id for w in consults(DATE, ROOM, root=env.root)] == ["consult-" + UID]
    assert sorted(t.layer for t in c.tracks()) == ["diar", "stt"]
    from kit.reb import real_room_windows
    assert real_room_windows(consults(DATE, root=env.root)) == []          # never counted as a day-record window


def test_collector_contract_path_and_index(tmp_path):
    """The collector (kit/reb/collector.py, frozen) derives rel_dir = dirname(dirname(track path)) and reads manifest.json there."""
    env = Env(tmp_path, [make_row()])
    env.run(FakeGW())
    lines = [json.loads(l) for l in open(os.path.join(env.root, DATE, "index.jsonl"))]
    assert len(lines) == 2
    for ln in lines:
        rel = ln["path"]
        assert rel.split("/")[0] == DATE and ".." not in rel.split("/")
        rel_dir = os.path.dirname(os.path.dirname(rel))
        assert rel_dir == f"{DATE}/{ROOM}/_consults/{UID}"
        m = json.load(open(os.path.join(env.root, rel_dir, "manifest.json")))
        assert isinstance(m["t0_ms"], int) and isinstance(m["t1_ms"], int)
        assert ln["window_id"] == "consult-" + UID and ln["room_id"] == ROOM and isinstance(ln["sha256"], str)
        assert ln["source_kind"] == "consult_clip"


def test_window_enumerators_skip_consults_dir(tmp_path):
    from kit.reb import encounter as en
    env = Env(tmp_path, [make_row()])
    env.run(FakeGW())
    assert list(en.iter_windows(env.root, [DATE])) == []


def test_workers_cap(tmp_path):
    env = Env(tmp_path, [make_row()])
    with pytest.raises(SystemExit):
        env.run(FakeGW(), workers=5)


def test_sigv4_is_deterministic_and_secret_free():
    now = sl.datetime.datetime(2026, 10, 8, 12, 0, 0, tzinfo=sl.datetime.timezone.utc)
    h1 = sl.sigv4_headers("POST", sl.BASE + "/x", b"{}", {"key": "AK", "secret": "SK", "token": "TK"}, now)
    h2 = sl.sigv4_headers("POST", sl.BASE + "/x", b"{}", {"key": "AK", "secret": "SK", "token": "TK"}, now)
    assert h1 == h2 and h1["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=AK/20261008/ap-south-1/execute-api/aws4_request")
    assert "SK" not in json.dumps(h1)


class FakeR2:
    def __init__(self, fail=False):
        self.objs, self.fail = {}, fail

    def put(self, key, body):
        if self.fail:
            raise sl.GatewayError("r2 down", 500)
        self.objs[key] = body


def test_usage_contract_ledger_and_lane(tmp_path):
    env = Env(tmp_path, [make_row(), make_row(uid="u2", date="2026-10-08")])
    r2 = FakeR2()
    sink = sl.UsageSink(local_dir=str(tmp_path / "led"), put=r2, heartbeat_s=3600)
    cnt = env.run(FakeGW(), sink=sink)
    assert cnt["usage_sink_errors"] == 0
    led = {k: v for k, v in r2.objs.items() if k.startswith("sarvam/ledger/palimpsest/")}
    lines = [json.loads(l) for v in led.values() for l in v.decode().splitlines()]
    assert len(lines) == 3 and {l["task"] for l in lines} == {"transcribe", "translate"}            # one line per finished job
    for l in lines:
        assert set(l) == {"caller", "machine", "job_id", "request_id", "route", "mode", "task", "model", "audio_s", "chars", "started_at",
                          "finished_at", "status", "http_status", "throttled", "scope", "ref"}
        assert l["caller"] == "palimpsest" and l["route"] == "gateway" and l["mode"] == "batch" and l["scope"] == "consult_clip"
        assert l["status"] == "ok" and l["audio_s"] == 300.0 and l["ref"] in (UID, "u2") and l["finished_at"].endswith("Z")
    lane = json.loads(r2.objs["lanes/sarvam-palimpsest.json"])
    assert lane["schema"] == "sarvam.lane.v1" and lane["active"] == [] and lane["all_time"] == {"jobs": 3, "audio_min": 15.0}
    assert lane["today"]["jobs"] >= 0 and set(lane["today"]) == {"jobs", "audio_min", "failed", "throttled"}
    blob = json.dumps(lane) + "".join(v.decode() for v in led.values())
    assert "synthetic one" not in blob and "transcript" not in blob           # no text in either file


def test_lane_file_shows_active_job_and_heartbeat(tmp_path):
    t = [1791470000.0]
    sink = sl.UsageSink(local_dir=str(tmp_path / "led"), put=FakeR2(), now=lambda: t[0], heartbeat_s=0.05)
    sink.begin("jobA", "transcribe", 600, "consult_clip")
    sink.start_heartbeat()
    import time as _t
    _t.sleep(0.2)
    doc = json.loads(sink.put.objs["lanes/sarvam-palimpsest.json"])
    assert [a["job_id"] for a in doc["active"]] == ["jobA"] and doc["active"][0]["scope"] == "consult_clip"
    sink.end("jobA"); sink.close()
    assert json.loads(sink.put.objs["lanes/sarvam-palimpsest.json"])["active"] == []


def test_sink_failure_never_fails_a_job_and_local_truth_stays(tmp_path):
    env = Env(tmp_path, [make_row()])
    sink = sl.UsageSink(local_dir=str(tmp_path / "led"), put=FakeR2(fail=True), heartbeat_s=3600)
    cnt = env.run(FakeGW(), sink=sink)
    assert cnt["written"] == 2 and cnt["usage_sink_errors"] > 0
    assert len(open(str(tmp_path / "led" / "palimpsest" / (sl.datetime.datetime.now(sl.IST).strftime("%Y-%m-%d") + ".jsonl"))).read().splitlines()) == 1


def test_failed_job_is_ledgered_and_seed_is_idempotent(tmp_path):
    env = Env(tmp_path, [make_row()])
    sink = sl.UsageSink(local_dir=str(tmp_path / "led"), put=FakeR2(), heartbeat_s=3600)
    env.run(FakeGW(fail=sl.GatewayError("job failed: x")), sink=sink)
    lane = sink.lane_doc()
    assert lane["today"]["failed"] == 1 and lane["all_time"]["audio_min"] == 0.0          # only ok jobs count as minutes
    assert sl.seed_pilot(sink, pilot_dir=str(tmp_path / "none"), clip_dir=str(tmp_path / "none")) == 2
    assert sl.seed_pilot(sink, pilot_dir=str(tmp_path / "none"), clip_dir=str(tmp_path / "none")) == 0   # idempotent by job_id
    lane = sink.lane_doc()
    assert lane["all_time"] == {"jobs": 3, "audio_min": 25.09}      # 1 failed job (0 min) + 900 s + 605.238 s


def test_ledger_failure_never_loses_tracks_and_tracks_come_first(tmp_path):
    env = Env(tmp_path, [make_row()])
    led = tmp_path / "led"
    sink = sl.UsageSink(local_dir=str(led), put=None, heartbeat_s=3600)
    os.chmod(sink.dir, 0o500)             # read-only ledger dir, like a full disk
    try:
        cnt = env.run(FakeGW(), sink=sink)
    finally:
        os.chmod(sink.dir, 0o700)
    assert cnt["written"] == 2 and cnt["ok"] == 2 and cnt["errors"] == 0 and cnt["usage_sink_errors"] > 0   # tracks on disk, error counted
    assert len(os.listdir(tdir(env))) == 2
    # order: the ledger line is appended only after the tracks exist
    env3 = Env(tmp_path / "e3", [make_row(uid="u3")])
    sink2 = sl.UsageSink(local_dir=str(tmp_path / "led2"), put=None, heartbeat_s=3600)
    seen = []
    orig = sink2.record

    def rec(line):
        seen.append(len(os.listdir(tdir(env3, "u3"))))
        return orig(line)
    sink2.record = rec
    env3.run(FakeGW(), sink=sink2)
    assert seen == [2]                      # both tracks already on disk when the ledger line was written


def test_track_write_failure_still_ledgers_the_paid_job(tmp_path):
    env = Env(tmp_path, [make_row()])
    sink = sl.UsageSink(local_dir=str(tmp_path / "led"), put=None, heartbeat_s=3600)
    orig = sl.build_tracks
    sl.build_tracks = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        cnt = env.run(FakeGW(), sink=sink)
    finally:
        sl.build_tracks = orig
    assert cnt["errors"] == 1 and sink.lane_doc()["all_time"]["jobs"] == 1       # the spend is still on the ledger


def test_recut_pending_clip_is_deferred_not_sent(tmp_path):
    env = Env(tmp_path, [make_row(), make_row(uid="u_ok")])
    gw = FakeGW()
    cnt = env.run(gw, recut={UID})
    assert cnt["deferred_recut"] == 1 and [c[1] for c in gw.calls] == ["transcribe"] and cnt["written"] == 2
    assert not os.path.exists(tdir(env, UID)) and os.path.isdir(tdir(env, "u_ok"))


def test_recut_queue_loader_uses_queue_function_and_fails_closed(tmp_path):
    q = tmp_path / "rq.py"
    q.write_text("import json\ndef read_index(p):\n    return {'a': {}, 'b': {}}\ndef queue(index, tl):\n    return ['b']\n")
    assert sl.load_recut_pending(str(q), "x", "y") == {"b"}
    with pytest.raises(sl.GuardUnavailable):
        sl.load_recut_pending(str(tmp_path / "missing.py"))


def test_gateway_retries_a_4xx_then_gives_a_url_free_reason(monkeypatch):
    class Resp:
        def __init__(self, code): self.status_code, self.content = code, b"x"
        def json(self): return {"message": "bad thing at https://secret.example/x?sig=ABC"} if self.status_code == 400 else {"ok": 1}
    seq = iter([Resp(400), Resp(200)])
    gw = sl.Gateway.__new__(sl.Gateway)
    gw.rq = types.SimpleNamespace(request=lambda *a, **k: next(seq))
    gw._lock, gw.throttled, gw.statuses, gw.log = sl.threading.Lock(), 0, {}, lambda **k: None
    gw._tl = sl.threading.local()
    gw.creds = lambda: {"key": "a", "secret": "b", "token": None}
    assert gw.call("POST", "/x", {}, sleep=lambda s: None) == {"ok": 1}            # a 400 that clears on retry is not an error
    always = types.SimpleNamespace(request=lambda *a, **k: Resp(400))
    gw.rq = always
    with pytest.raises(sl.GatewayError) as e:
        gw.call("POST", "/speech-to-text/job/v1/20261008_986beabf-55e9-4219-86a5", {}, sleep=lambda s: None)
    assert e.value.status == 400 and "<url>" in str(e.value) and "secret.example" not in str(e.value) and "{id}" in str(e.value)


def test_over_7200s_clip_is_not_sent(tmp_path):
    row = make_row(minutes=122)
    row["span_end"] = "2026-10-06 11:50:00.000"
    env = Env(tmp_path, [row])
    gw = FakeGW()
    cnt = env.run(gw)
    assert gw.calls == [] and cnt["too_long"] == 1 and cnt["written"] == 0
