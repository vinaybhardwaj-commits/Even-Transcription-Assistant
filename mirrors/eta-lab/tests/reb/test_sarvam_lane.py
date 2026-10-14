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

    def run(self, gw, held=lambda d, r: False, write=True, sink=None, recut=frozenset(), splitter=None, **kw):
        a = types.SimpleNamespace(**{"consult": None, "date": None, "since": None, "write": write, "workers": 2, "limit": 0,
                                     "min_minutes": 0, "identified": False, **kw})
        return sl.run(a, gw=gw, root=self.root, is_held=held, index_path=self.index, clips_root=self.clips, log_dir=None, sleep=lambda s: None, sink=sink, recut_pending=recut, splitter=splitter)


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


# ---------------------------------------------------------------- 6S4 split
class FakeSplitter:
    def __init__(self, tmp, cuts=(100.0,)):
        self.cuts, self.tmp, self.retired = list(cuts), tmp, []

    def find_cuts(self, path, dur_s):
        return self.cuts

    def make_parts(self, path, cuts, dur_s, uid):
        wd = os.path.join(str(self.tmp), "work-" + uid)
        os.makedirs(wd, exist_ok=True)
        bounds = [0.0] + list(cuts) + [dur_s]
        out = []
        for i in range(len(bounds) - 1):
            p = os.path.join(wd, f"part{i + 1}.flac")
            open(p, "wb").write(b"fLaC")
            out.append({"idx": i + 1, "path": p, "start_s": bounds[i], "end_s": bounds[i + 1]})
        return wd, out

    def retire(self, wd):
        self.retired.append(wd)


class SplitGW(FakeGW):
    """Different entries per part so namespacing is visible."""
    def transcribe(self, path, params, sleep=None, on_start=None):
        self.calls.append((os.path.basename(path), params["mode"]))
        n = len(self.calls)
        if on_start:
            on_start(f"job-{n}")
        if self.fail and n == self.fail_on:
            raise self.fail
        raw = {"0.json": {"language_code": "hi-IN" if n == 1 else "en-IN", "language_probability": 0.9, "request_id": f"req{n}",
                          "transcript": "t", "timestamps": {},
                          "diarized_transcript": {"entries": [{"speaker_id": "0", "start": 1.0, "end": 2.0, "transcript": f"part {n}"}]}}}
        return raw, {"job_id": f"job-{n}", "states": ["completed"], "wall_s": 1.0, "throttled": False}


def split_env(tmp, monkeypatch):
    monkeypatch.setattr(sl, "MAX_AUDIO_S", 200)       # the 5-minute test clip (300 s) is "over the limit"
    return Env(tmp, [make_row()])


def test_plan_split_property():
    assert sl.plan_split(7200) == [] and sl.plan_split(100) == []
    for dur in (7201, 7338, 9000, 13820, 13821, 20000, 40000):
        bounds = sl.plan_split(dur)
        assert bounds == sorted(bounds) and bounds[0] == sl.SPLIT_NOMINAL_S
        for jitter in (-sl.SPLIT_RADIUS_S, 0, sl.SPLIT_RADIUS_S):
            cuts = [b + jitter for b in bounds]                       # worst case: every cut at the edge of its +-60 s window
            pts = [0] + cuts + [dur]
            assert all(0 < b - a <= sl.SPLIT_MAX_PART_S for a, b in zip(pts, pts[1:])), (dur, jitter)


def test_energy_cut_picks_the_quietest_2s():
    sr = 100
    loud = [1000, -1000] * 50                                         # 1 s of loud
    samples = []
    for sec in range(60):
        samples += ([1, -1] * 50) if 31 <= sec < 33 else loud         # quiet 2 s at 31..33
    assert abs(sl.energy_cut(samples, sr, 0.0) - 32.0) < 0.3
    assert abs(sl.energy_cut(samples, sr, 500.0) - 532.0) < 0.3       # offset is carried


def test_real_ffmpeg_splitter_finds_the_gap_and_cuts_parts(tmp_path, monkeypatch):
    import shutil
    import subprocess
    if not shutil.which("ffmpeg"):
        pytest.skip("no ffmpeg")
    monkeypatch.setattr(sl, "MAX_AUDIO_S", 20); monkeypatch.setattr(sl, "SPLIT_NOMINAL_S", 14)
    monkeypatch.setattr(sl, "SPLIT_RADIUS_S", 4); monkeypatch.setattr(sl, "SPLIT_MAX_PART_S", 22)
    src = str(tmp_path / "t.flac")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=30", "-af", "volume=0:enable='between(t,12,14)'",
                    "-ar", "16000", "-ac", "1", src], check=True)
    sp = sl.FfmpegSplitter(str(tmp_path / "w"))
    cuts = sp.find_cuts(src, 30.0)
    assert len(cuts) == 1 and 12.0 <= cuts[0] <= 14.1                # inside the silent gap
    wd, parts = sp.make_parts(src, cuts, 30.0, "uidX")
    assert [p["idx"] for p in parts] == [1, 2] and all(os.path.getsize(p["path"]) > 100 for p in parts)
    sp.retire(wd)
    assert not os.path.exists(wd) and os.path.isdir(str(tmp_path / "w" / "_to_delete"))


def test_split_consult_makes_one_stt_and_one_diar_track(tmp_path, monkeypatch):
    env = split_env(tmp_path, monkeypatch)
    sp = FakeSplitter(tmp_path / "sp", cuts=(100.0,))
    gw = SplitGW()
    sink = sl.UsageSink(local_dir=str(tmp_path / "led"), put=None, heartbeat_s=3600)
    cnt = env.run(gw, sink=sink, splitter=sp)
    assert len(gw.calls) == 2 and cnt["split_consults"] == 1 and cnt["jobs"] == 2 and cnt["written"] == 2
    names = sorted(os.listdir(tdir(env)))
    assert [n.split(".")[0] for n in names] == ["diar", "stt"]                  # ONE of each for the consult
    stt = json.load(open(os.path.join(tdir(env), [n for n in names if n.startswith("stt")][0])))
    diar = json.load(open(os.path.join(tdir(env), [n for n in names if n.startswith("diar")][0])))
    s = stt["segments"]
    assert [x["speaker"] for x in s] == ["p1:0", "p2:0"] and [x["text"] for x in s] == ["part 1", "part 2"]
    assert s[0]["t0_ms"] == SPAN_START_MS + 1000                                 # part 1 starts at clip 0
    assert s[1]["t0_ms"] == SPAN_START_MS + 101000                               # part 2 starts at the cut (100 s) + 1 s
    assert [x["lang"] for x in s] == ["hi-IN", "en-IN"] and s[1]["extras"]["clip_t0_s"] == 101.0
    assert [p["job_id"] for p in stt["extras"]["parts"]] == ["job-1", "job-2"] and stt["extras"]["job_ids"] == ["job-1", "job-2"]
    assert [(p["start_s"], p["end_s"]) for p in stt["extras"]["parts"]] == [(0.0, 100.0), (100.0, 300.0)]
    assert stt["extras"]["split_points_s"] == [100.0] and set(stt["extras"]["raw"]) == {"p1", "p2"}
    assert "text" not in diar["segments"][0] and [x["speaker"] for x in diar["segments"]] == ["p1:0", "p2:0"] and "raw" not in diar["extras"]
    assert stt["config_hash"] == sl.cfg8_of(sl.job_params("transcribe"), SIG, [100.0]) != sl.cfg8_of(sl.job_params("transcribe"), SIG)
    assert sp.retired                                                          # work dir moved, not deleted
    led = [f for f in os.listdir(sink.dir) if f.endswith(".jsonl")][0]
    lines = [json.loads(l) for l in open(os.path.join(sink.dir, led))]
    assert len(lines) == 2 and sorted(l["audio_s"] for l in lines) == [100.0, 200.0]      # one ledger line per part job


def test_split_cfg8_includes_split_points_and_rerun_is_idempotent(tmp_path, monkeypatch):
    env = split_env(tmp_path, monkeypatch)
    env.run(SplitGW(), splitter=FakeSplitter(tmp_path / "sp", cuts=(100.0,)))
    gw = SplitGW()
    cnt = env.run(gw, splitter=FakeSplitter(tmp_path / "sp", cuts=(100.0,)))
    assert gw.calls == [] and cnt["skipped_existing"] == 1
    gw2 = SplitGW()                                                              # other cut points = a new track beside the old one
    env.run(gw2, splitter=FakeSplitter(tmp_path / "sp", cuts=(120.0,)))
    assert len(gw2.calls) == 2 and len(os.listdir(tdir(env))) == 4


def test_split_part_failure_permanent_records_failed_transient_does_not(tmp_path, monkeypatch):
    env = split_env(tmp_path, monkeypatch)
    gw = SplitGW(); gw.fail, gw.fail_on = sl.GatewayError("file failed: nope", 400), 2
    cnt = env.run(gw, splitter=FakeSplitter(tmp_path / "sp"))
    assert cnt["failed"] == 1 and len(gw.calls) == 2
    t = json.load(open(os.path.join(tdir(env), sorted(os.listdir(tdir(env)))[0])))
    assert t["status"] == "failed" and t["reason"].startswith("part 2:") and t["segments"] == []
    env2 = Env(tmp_path / "b", [make_row()])
    gw2 = SplitGW(); gw2.fail, gw2.fail_on = sl.GatewayError("http 503", 503), 2
    cnt = env2.run(gw2, splitter=FakeSplitter(tmp_path / "sp2"))
    assert cnt["transient_errors"] == 1 and not os.path.exists(os.path.join(env2.root, DATE))


def test_split_uses_the_guards_blind_and_dry_run(tmp_path, monkeypatch):
    env = split_env(tmp_path, monkeypatch)
    gw = SplitGW()
    assert env.run(gw, held=lambda d, r: True, splitter=FakeSplitter(tmp_path / "s"))["blind_refused"] == 1 and gw.calls == []
    cnt = env.run(gw, write=False, splitter=FakeSplitter(tmp_path / "s"))
    assert cnt["would_write"] == 1 and gw.calls == []


def test_no_translate_flag_skips_the_translate_job(tmp_path):
    env = Env(tmp_path, [make_row(uid="u_new", date="2026-10-08")])
    gw = FakeGW()
    cnt = env.run(gw, no_translate=True)
    assert [c[1] for c in gw.calls] == ["transcribe"] and cnt["written"] == 2
    assert not [n for n in os.listdir(tdir(env, "u_new", "2026-10-08")) if n.startswith("translate")]
    gw2 = FakeGW()
    env.run(gw2)                                                    # without the flag the translate job still runs, later, for the same clip
    assert [c[1] for c in gw2.calls] == ["translate"]
    assert sl.lanes_for("2026-10-08", translate=False) == [("transcribe", ("stt", "diar"))]


def test_no_translate_applies_to_split_consults_too(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "MAX_AUDIO_S", 200)
    env = Env(tmp_path, [make_row(uid="u_big", date="2026-10-08")])
    gw = SplitGW()
    env.run(gw, no_translate=True, splitter=FakeSplitter(tmp_path / "sp", cuts=(100.0,)))
    assert {c[1] for c in gw.calls} == {"transcribe"} and len(gw.calls) == 2


def test_limit_counts_clips_actually_sent_and_never_stalls(tmp_path):
    rows = [make_row(uid=f"u{i}") for i in range(1, 6)]            # sorted u1..u5
    env = Env(tmp_path, rows)
    gw = FakeGW()
    cnt = env.run(gw, recut={"u1", "u2"}, limit=1, workers=1)                   # u1,u2 deferred (re-cut): they must not use the budget
    assert len(gw.calls) == 1 and cnt["deferred_recut"] == 2 and os.path.isdir(tdir(env, "u3")) and cnt["limit_reached"] >= 1
    gw2 = FakeGW()                                                    # the next hourly pass: u3 exists -> skipped, u4 sent. Same command, new clip.
    cnt = env.run(gw2, recut={"u1", "u2"}, limit=1, workers=1)
    assert len(gw2.calls) == 1 and os.path.isdir(tdir(env, "u4")) and cnt["skipped_existing"] == 1
    gw3 = FakeGW()
    env.run(gw3, recut={"u1", "u2"}, limit=1, workers=1); env.run(FakeGW(), recut={"u1", "u2"}, limit=1, workers=1)
    assert os.path.isdir(tdir(env, "u5")) and len(gw3.calls) == 1


def test_limit_ignores_refused_clips_and_applies_to_dry_run(tmp_path):
    rows = [make_row(uid="u1", date="2026-10-05"), make_row(uid="u2"), make_row(uid="u3")]
    env = Env(tmp_path, rows)
    gw = FakeGW()
    cnt = env.run(gw, held=lambda d, r: d == "2026-10-05", limit=1, workers=1)  # u1 is blind: refused, not counted against the limit
    assert cnt["blind_refused"] == 1 and len(gw.calls) == 1 and cnt["limit_reached"] == 1
    env2 = Env(tmp_path / "d", [make_row(uid="a1"), make_row(uid="a2"), make_row(uid="a3")])
    cnt = env2.run(FakeGW(), write=False, limit=2)
    assert cnt["would_write"] == 2 and cnt["limit_reached"] == 1


def test_limit_one_budget_unit_per_clip_for_both_modes(tmp_path):
    env = Env(tmp_path, [make_row(uid="n1", date="2026-10-08"), make_row(uid="n2", date="2026-10-08")])
    gw = FakeGW()
    env.run(gw, limit=1, workers=1)                                  # n1 transcribe + translate = 2 jobs, ONE clip
    assert sorted(c[1] for c in gw.calls) == ["transcribe", "translate"]


def test_limit_applies_to_split_consults(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "MAX_AUDIO_S", 200)
    env = Env(tmp_path, [make_row(uid="b1"), make_row(uid="b2")])
    gw = SplitGW()
    env.run(gw, limit=1, splitter=FakeSplitter(tmp_path / "sp", cuts=(100.0,)), workers=1)
    assert len(gw.calls) == 2 and os.path.isdir(tdir(env, "b1")) and not os.path.isdir(tdir(env, "b2"))


def test_translate_track_says_english_and_keeps_the_source_language(tmp_path):
    env = Env(tmp_path, [make_row(uid="t1", date="2026-10-08")])
    env.run(FakeGW())
    d = tdir(env, "t1", "2026-10-08")
    tr = json.load(open(os.path.join(d, [n for n in os.listdir(d) if n.startswith("translate")][0])))
    stt = json.load(open(os.path.join(d, [n for n in os.listdir(d) if n.startswith("stt")][0])))
    assert {s["lang"] for s in tr["segments"]} == {"en-IN"} and tr["extras"]["translated_to"] == "en-IN"
    assert tr["extras"]["source_language_code"] == "hi-IN" and tr["segments"][0]["extras"]["source_language_code"] == "hi-IN"
    assert {s["lang"] for s in stt["segments"]} == {"hi-IN"}                   # the stt lane is unchanged


def test_translate_lang_on_split_consults(tmp_path, monkeypatch):
    monkeypatch.setattr(sl, "MAX_AUDIO_S", 200)
    env = Env(tmp_path, [make_row(uid="t2", date="2026-10-08")])
    env.run(SplitGW(), splitter=FakeSplitter(tmp_path / "sp", cuts=(100.0,)))
    d = tdir(env, "t2", "2026-10-08")
    tr = json.load(open(os.path.join(d, [n for n in os.listdir(d) if n.startswith("translate")][0])))
    assert {s["lang"] for s in tr["segments"]} == {"en-IN"} and tr["extras"]["translated_to"] == "en-IN"
    assert [s["extras"]["source_language_code"] for s in tr["segments"]] == ["en-IN", "en-IN"]   # SplitGW says hi-IN only for its very first call


def test_limit_refuter_scenario_150_clips_120_done(tmp_path):
    rows = [make_row(uid=f"c{i:03d}") for i in range(150)]
    env = Env(tmp_path, rows)
    done = FakeGW()
    env.run(done, limit=120, workers=1)                                  # first 120 are done
    assert len(done.calls) == 120
    gw = FakeGW()
    cnt = env.run(gw, limit=100, workers=1)                              # same command: the remaining 30, not the same first 100
    assert len(gw.calls) == 30 and cnt["skipped_existing"] == 120 and cnt["limit_reached"] == 0
    gw2 = FakeGW()
    assert env.run(gw2, limit=100, workers=1)["skipped_existing"] == 150 and gw2.calls == []     # a further pass sends 0
