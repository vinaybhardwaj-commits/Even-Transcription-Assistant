import datetime
import hashlib
import json
import os
import threading
import types

import pytest

from kit.reb import load_window, write_track
from kit.reb import sarvam_lane as sl
from kit.reb.writer import config_hash
from .test_sarvam_lane import FakeGW

DATE, ROOM = "2026-09-26", "room_4ggnkg5x"
T0 = 1790400600000
WID = f"c-{DATE}_{ROOM}_1100"


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class Env:
    """A tiny REB root with one room-tape window, a tape cache of 3 five-minute chunks, a fake ffmpeg and a ledger sink."""

    def __init__(self, tmp, wid=WID, t0=T0, dur_ms=900000, key="bench/x/chunk_00019.webm", local=None, n_chunks=3):
        self.tmp = tmp
        self.root, self.tapes, self.data, self.work = (str(tmp / d) for d in ("reb", "tapes", "data", "work"))
        for d in (self.root, self.tapes, self.data, self.work):
            os.makedirs(d, exist_ok=True)
        self.wid, self.t0, self.dur = wid, t0, dur_ms
        rows = []
        for i in range(n_chunks):
            rel = f"{ROOM}/{DATE}/chunk{i}.webm"
            os.makedirs(os.path.join(self.tapes, os.path.dirname(rel)), exist_ok=True)
            body = f"chunk-{i}".encode()
            open(os.path.join(self.tapes, rel), "wb").write(body)
            rows.append({"id": f"bc_{i}", "room_id": ROOM, "idx": i, "started_at": iso(t0 + i * 300000), "duration_ms": 300000,
                         "sha256": hashlib.sha256(body).hexdigest(), "source": "primary", "path": rel})
        open(os.path.join(self.tapes, "manifest.jsonl"), "w").write("\n".join(json.dumps(r) for r in rows) + "\n")
        self.rows = rows
        audio = {"r2_key": key, "sha256": "s", "sample_rate": 48000, "duration_ms": dur_ms}
        if local is not None:
            os.makedirs(os.path.join(self.data, "hist"), exist_ok=True)
            open(os.path.join(self.data, "hist", "w.webm"), "wb").write(local)
            audio = {"r2_key": "local:hist/w.webm", "sha256": hashlib.sha256(local).hexdigest(), "sample_rate": 48000, "duration_ms": dur_ms}
        stub = {"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": DATE, "t0_ms": t0, "t1_ms": t0 + dur_ms, "source_kind": "room_tape", "audio": audio}
        seed = {"schema": "reb.track.v1", "window_id": wid, "layer": "stt", "engine": "whisper-auto", "model": "m", "version": "v1", "config": {"e": 1},
                "config_hash": config_hash({"e": 1}), "machine": "t", "status": "ok", "reason": None, "segments": [{"t0_ms": 0, "t1_ms": 1, "text": "x"}]}
        write_track(self.root, DATE, ROOM, wid, seed, manifest_stub=stub)
        self.cmds = []
        self.sink = sl.UsageSink(local_dir=str(tmp / "led"), put=None, heartbeat_s=3600)

    def runner(self, cmd, capture_output=True):
        self.cmds.append(cmd)
        open(cmd[-1], "wb").write(b"RIFFwav")
        return types.SimpleNamespace(returncode=0)

    def run(self, gw, ids=None, write=True, held=lambda d, r: False, workers=1, **kw):
        a = types.SimpleNamespace(write=write, workers=workers)
        return sl.run_windows(a, ids or [self.wid], gw=gw, root=self.root, is_held=held, log_dir=None, sleep=lambda s: None, sink=self.sink if write else None,
                              tapes=self.tapes, data=self.data, work_root=self.work, runner=self.runner, **kw)

    def ledger(self):
        return [json.loads(l) for f in os.listdir(self.sink.dir) if f.endswith(".jsonl") for l in open(os.path.join(self.sink.dir, f))]

    def tracks(self, wid=None):
        d = os.path.join(self.root, DATE, ROOM, wid or self.wid, "tracks")
        return sorted(n for n in os.listdir(d) if "sarvam" in n)


def test_write_makes_stt_and_diar_on_tape_time_with_research_window_ledger(tmp_path):
    env = Env(tmp_path)
    gw = FakeGW()
    cnt = env.run(gw)
    assert len(gw.calls) == 1 and gw.calls[0][1] == "transcribe"                         # ONE transcribe job, no translate
    assert cnt["jobs"] == 1 and cnt["written"] == 2 and cnt["ok"] == 2 and cnt["audio_h"] == 0.25
    names = env.tracks()
    assert [n.split(".")[0] for n in names] == ["diar", "stt"]
    w = load_window(WID, root=env.root)
    stt = [t for t in w.tracks(layer="stt", engine="sarvam-saaras-v3")][0]
    diar = [t for t in w.tracks(layer="diar", engine="sarvam-saaras-v3")][0]
    assert stt.segments[0]["t0_ms"] == T0 + 1500 and stt.segments[1]["t1_ms"] == T0 + 9250          # manifest t0 + offset
    assert stt.segments[0]["extras"]["win_t0_s"] == 1.5 and "text" not in diar.segments[0]
    assert stt.extras["use"] == "research" and stt.extras["scope"] == "window" and "raw" in stt.extras and "raw" not in diar.extras
    assert [l["scope"] for l in env.ledger()] == ["window"] and env.ledger()[0]["use"] == "research" and env.ledger()[0]["ref"] == WID
    assert env.ledger()[0]["task"] == "transcribe" and env.ledger()[0]["audio_s"] == 900.0 and env.ledger()[0]["status"] == "ok"


def test_tape_chunks_are_laid_on_the_window_clock_and_cfg8_follows_the_chunk_shas(tmp_path):
    env = Env(tmp_path)
    env.run(FakeGW())
    cmd = env.cmds[0]
    fc = cmd[cmd.index("-filter_complex") + 1]
    assert "adelay=0:all=1" in fc and "adelay=300000:all=1" in fc and "adelay=600000:all=1" in fc and "amix=inputs=3" in fc and "atrim=end=900.000" in fc
    plan = sl.window_plan(load_window(WID, root=env.root).manifest, sl.load_tapes(os.path.join(env.tapes, "manifest.jsonl")), env.tapes, env.data)
    a = sl.window_cfg8(sl.job_params("transcribe"), WID, plan["signature"])
    b = sl.window_cfg8(sl.job_params("transcribe"), WID, {**plan["signature"], "chunks": plan["signature"]["chunks"][:2]})
    assert a != b and any(n.endswith(f"{a}.json") for n in env.tracks())


def test_blind_day_room_and_span_refused_before_any_audio_or_send(tmp_path):
    env = Env(tmp_path)
    gw = FakeGW()
    cnt = env.run(gw, held=lambda d, r: True)
    assert cnt["blind_refused"] == 1 and gw.calls == [] and env.cmds == [] and env.tracks() == [] and env.ledger() == []
    # blind only on the day AFTER the window's start: the span check (t1 - 1 s) is what catches it
    env2 = Env(tmp_path / "e2", t0=sl._ist_ms("2026-09-26 23:50:00.000"), wid=f"c-{DATE}_{ROOM}_2350")
    gw2 = FakeGW()
    cnt2 = env2.run(gw2, held=lambda d, r: d == "2026-09-27")
    assert cnt2["blind_refused"] == 1 and gw2.calls == [] and env2.cmds == []


def test_sha_mismatch_and_missing_chunk_fail_closed_counted_no_send(tmp_path):
    env = Env(tmp_path)
    open(os.path.join(env.tapes, env.rows[1]["path"]), "wb").write(b"tampered")
    gw = FakeGW()
    cnt = env.run(gw)
    assert cnt["sha_mismatch"] == 1 and gw.calls == [] and env.cmds == [] and env.tracks() == [] and env.ledger() == []
    env = Env(tmp_path / "m")
    os.remove(os.path.join(env.tapes, env.rows[2]["path"]))
    cnt = env.run(gw)
    assert cnt["audio_missing"] == 1 and gw.calls == []
    env = Env(tmp_path / "n", n_chunks=0)
    assert env.run(gw)["audio_missing"] == 1


def test_local_window_file_is_sha_checked_against_the_manifest(tmp_path):
    env = Env(tmp_path, local=b"webm-bytes")
    gw = FakeGW()
    assert env.run(gw)["jobs"] == 1 and "-i" in env.cmds[0] and env.cmds[0][env.cmds[0].index("-i") + 1].endswith("w.webm")
    env = Env(tmp_path / "b", local=b"webm-bytes")
    open(os.path.join(env.data, "hist", "w.webm"), "wb").write(b"other")
    gw2 = FakeGW()
    assert env.run(gw2)["sha_mismatch"] == 1 and gw2.calls == []
    env = Env(tmp_path / "c", local=b"webm-bytes")
    os.remove(os.path.join(env.data, "hist", "w.webm"))
    assert env.run(gw2)["audio_missing"] == 1 and gw2.calls == []


def test_dry_run_sends_nothing_and_counts(tmp_path):
    env = Env(tmp_path)
    gw = FakeGW()
    cnt = env.run(gw, write=False)
    assert cnt["would_send"] == 1 and cnt["would_write"] == 1 and cnt["audio_h"] == 0.25 and gw.calls == [] and env.cmds == [] and env.tracks() == []


def test_idempotent_rerun_and_unknown_id(tmp_path):
    env = Env(tmp_path)
    gw = FakeGW()
    env.run(gw)
    cnt = env.run(gw, ids=[WID, "c-2026-09-26_room_nope_0900"])
    assert len(gw.calls) == 1 and cnt["skipped_existing"] == 1 and cnt["not_found"] == 1


def test_window_mode_cannot_be_reached_from_the_clip_selectors(tmp_path):
    p = tmp_path / "ids.json"
    p.write_text(json.dumps([WID]))
    for flag in (["--since", "2026-10-02"], ["--date", "2026-10-06"], ["--consult", "uid1"]):
        with pytest.raises(SystemExit):
            sl.main(["--research-windows", str(p), *flag])
    with pytest.raises(SystemExit):
        sl.main(["--research-windows", str(p), "--limit", "3"])                          # clip-path options are refused here too
    with pytest.raises(SystemExit):
        sl.main([])                                                                     # and one selector is still required
    # the clip path selects only status-cut consult rows: a window id given as --consult selects nothing
    idx = tmp_path / "index.jsonl"
    idx.write_text("")
    a = types.SimpleNamespace(consult=WID, date=None, since=None, min_minutes=0, identified=False)
    assert sl.select(a, str(idx)) == []


def test_window_id_file_formats(tmp_path):
    p = tmp_path / "a.json"
    p.write_text(json.dumps([WID, WID, "w2"]))
    assert sl.load_window_ids(str(p)) == [WID, "w2"]                                    # duplicates dropped, order kept
    p.write_text(json.dumps({"sample_window_ids": ["w1"], "windows": []}))
    assert sl.load_window_ids(str(p)) == ["w1"]
    for bad in ([], {}, ["../x"], [1], "x"):
        p.write_text(json.dumps(bad))
        with pytest.raises(SystemExit):
            sl.load_window_ids(str(p))


def test_over_length_window_is_refused_even_though_it_cannot_happen(tmp_path):
    env = Env(tmp_path, dur_ms=7201 * 1000)
    gw = FakeGW()
    cnt = env.run(gw)
    assert cnt["over_limit"] == 1 and gw.calls == [] and env.cmds == []


def test_work_dir_is_moved_not_deleted_and_audio_not_kept_in_place(tmp_path):
    env = Env(tmp_path)
    env.run(FakeGW())
    assert not os.path.exists(os.path.join(env.work, WID))
    moved = os.listdir(os.path.join(env.work, "_to_delete"))
    assert len(moved) == 1 and moved[0].startswith(WID) and os.path.exists(os.path.join(env.work, "_to_delete", moved[0], "audio.wav"))


def test_permanent_failure_writes_failed_tracks_and_ledgers_the_job(tmp_path):
    env = Env(tmp_path)
    cnt = env.run(FakeGW(fail=sl.GatewayError("bad request", 400)))
    assert cnt["failed"] == 1 and len(env.tracks()) == 2
    t = load_window(WID, root=env.root).tracks(layer="stt", engine="sarvam-saaras-v3")[0]
    assert t.status == "failed" and [l["status"] for l in env.ledger()] == ["failed"] and env.ledger()[0]["use"] == "research"


def test_a_throttle_stops_new_windows(tmp_path):
    env = Env(tmp_path)
    w2 = f"c-{DATE}_{ROOM}_1115"
    env2 = Env(tmp_path / "x", wid=w2, t0=T0 + 900000)                                  # a second window in its own tree
    gw = FakeGW(fail=sl.GatewayError("slow down", 429))
    stop = threading.Event()
    cnt = {k: 0 for k in sl.WINDOW_COUNTERS}
    by_room = sl.load_tapes(os.path.join(env.tapes, "manifest.jsonl"))
    lock = threading.Lock()
    sl.process_window(WID, gw, env.root, lambda d, r: False, True, cnt, lock, lambda **k: None, by_room, env.sink, lambda s: None, stop, env.tapes, env.data, env.work, env.runner)
    assert stop.is_set() and cnt["transient_errors"] == 1
    sl.process_window(WID, gw, env.root, lambda d, r: False, True, cnt, lock, lambda **k: None, by_room, env.sink, lambda s: None, stop, env.tapes, env.data, env.work, env.runner)
    assert cnt["stopped"] == 1 and len(gw.calls) == 1                                    # the second window was never started


def test_clip_path_ledger_lines_carry_no_use_field():
    line = sl.UsageSink.call_line(types.SimpleNamespace(caller="c", machine="m"), "j", "r", "transcribe", 10, 1.0, 2.0, "ok", 200, False, "consult_clip", "uid")
    assert "use" not in line and line["scope"] == "consult_clip"
    line2 = sl.UsageSink.call_line(types.SimpleNamespace(caller="c", machine="m"), "j", "r", "transcribe", 10, 1.0, 2.0, "ok", 200, False, "window", WID, use="research")
    assert line2["use"] == "research" and line2["scope"] == "window"
