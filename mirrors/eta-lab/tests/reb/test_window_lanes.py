import contextlib
import datetime
import hashlib
import json
import os

import pytest

from kit.reb import classify_windows as cw
from kit.reb import reb, window_lanes as wl, write_track
from kit.reb.writer import config_hash

T0 = 1791000000000
ROOM = "room_aaaa1111"
DATE = "2026-10-03"


def put(root, wid, layer, engine, segs, status="ok", stub=None, date=DATE):
    cfg = {"e": engine, "w": wid}
    t = {"schema": "reb.track.v1", "window_id": wid, "layer": layer, "engine": engine, "model": "m", "version": "v1", "config": cfg,
         "config_hash": config_hash(cfg), "machine": "t", "status": status, "reason": None if status == "ok" else "r", "segments": segs}
    return write_track(root, date, ROOM, wid, t, manifest_stub=stub)


class FakeGate:
    def __init__(self, log):
        self.log = log

    @contextlib.contextmanager
    def hold(self):
        self.log.append("lock")
        yield
        self.log.append("unlock")


class FakeRunner:
    def __init__(self, log, turns=((0.0, 10.0, "speaker_0"), (10.0, 20.0, "speaker_1")), fail=None):
        self.log, self.turns, self.fail, self.calls = log, list(turns), fail, 0

    def diarize(self, wav):
        self.log.append("diarize")
        self.calls += 1
        assert os.path.exists(wav)
        if self.fail:
            raise self.fail
        return self.turns


def fake_ffmpeg(cmd, capture_output=True):
    open(cmd[-1], "wb").write(b"RIFFfake")
    return type("R", (), {"returncode": 0})()


@pytest.fixture
def env(tmp_path):
    root, data, tapes = tmp_path / "reb", tmp_path / "data", tmp_path / "tapes"
    for d in (root, data, tapes):
        d.mkdir()
    (tapes / "manifest.jsonl").write_text("")
    (data / "w.webm").write_bytes(b"audio-bytes")
    sha = hashlib.sha256(b"audio-bytes").hexdigest()

    def window(hh, kind="room_tape", audio="good", wid=None):
        wid = wid or f"c-{DATE}_{ROOM}_{hh}00"
        key = {"good": "local:w.webm", "gone": "local:nope.webm"}[audio]
        t0 = T0 + int(hh) * 3600000
        stub = {"window_id": wid, "room_id": ROOM, "room_slug": ROOM, "ist_date": DATE, "t0_ms": t0, "t1_ms": t0 + 900000, "source_kind": kind,
                "audio": {"r2_key": key, "sha256": sha, "sample_rate": 1, "duration_ms": 900000}}
        put(str(root), wid, "stt", "koyal", [], stub=stub)
        return wid, t0
    return str(root), str(data), str(tapes), window, tmp_path


def run(env_, ids, **kw):
    root, data, tapes, _, tmp = env_
    log = kw.pop("log", [])
    runner = kw.pop("runner", FakeRunner(log))
    cnt = wl.run_ids(ids, root=root, is_held=kw.pop("is_held", lambda d, r: False), runner=runner, gate=FakeGate(log), tapes=tapes, data=data, log_dir=str(tmp / "logs"),
                     work_root=str(tmp / "work"), subproc=fake_ffmpeg, **kw)
    return cnt, runner, log


def tracks(root, wid):
    d = os.path.join(root, DATE, ROOM, wid, "tracks")
    return sorted(n for n in os.listdir(d) if n.startswith("diar.nemotron"))


def test_writes_a_tape_time_track_and_a_rerun_is_a_noop(env):
    root, _, _, window, tmp = env
    wid, t0 = window("01")
    cnt, runner, log = run(env, [wid], write=True)
    assert cnt["ok"] == 1 and cnt["stopped"] is None and runner.calls == 1
    (name,) = tracks(root, wid)
    assert name.startswith(f"diar.nemotron__{wl.VERSION}__")
    t = json.load(open(os.path.join(root, DATE, ROOM, wid, "tracks", name)))
    assert t["status"] == "ok" and t["window_id"] == wid and t["machine"] == wl.MACHINE
    assert [(s["t0_ms"], s["t1_ms"], s["speaker"]) for s in t["segments"]] == [(t0, t0 + 10000, "speaker_0"), (t0 + 10000, t0 + 20000, "speaker_1")]     # tape time
    assert t["config"]["audio_signature"]["source"] == "local_window" and t["extras"]["audio"]["coverage"] == 1.0 and t["extras"]["use"] == "research"
    assert t["config_hash"] == name.rsplit("__", 1)[1][:-5]
    cnt2, runner2, _ = run(env, [wid], write=True)
    assert cnt2["skipped_existing"] == 1 and runner2.calls == 0 and len(tracks(root, wid)) == 1


def test_dry_run_runs_nothing_and_writes_nothing(env):
    root, _, _, window, _ = env
    wid, _ = window("01")
    cnt, runner, log = run(env, [wid], write=False)
    assert cnt["would_write"] == 1 and runner.calls == 0 and log == [] and tracks(root, wid) == []


def test_guards_run_before_any_audio_or_model(env):
    root, data, tapes, window, tmp = env
    sealed, _ = window("01", wid="L041")
    blind, _ = window("02")
    gone, _ = window("03", audio="gone")
    other, _ = window("04")
    mp = os.path.join(root, DATE, ROOM, other, "manifest.json")                                                       # the writer takes only valid kinds: mark it dev_clip on disk
    m = json.load(open(mp))
    m["source_kind"] = "dev_clip"
    json.dump(m, open(mp, "w"))
    cnt, runner, _ = run(env, [sealed, blind, gone, "nope"], write=True, is_held=lambda d, r: True)
    assert cnt["sealed"] == 1 and cnt["blind_refused"] == 2 and cnt["not_found"] == 1 and runner.calls == 0           # blind wins over a missing file; the model never loads
    cnt, runner, _ = run(env, [other], write=True)
    assert cnt["not_found"] == 1 and runner.calls == 0                                                                  # a dev_clip is not a room window
    cnt, runner, _ = run(env, [gone], write=True)
    assert cnt["audio_missing"] == 1 and runner.calls == 0


def test_the_gpu_is_held_for_one_window_at_a_time(env):
    _, _, _, window, _ = env
    ids = [window("01")[0], window("02")[0], window("03")[0]]
    cnt, runner, log = run(env, ids, write=True)
    assert cnt["ok"] == 3 and log == ["lock", "diarize", "unlock"] * 3                                              # lock around the inference only, released between windows


NOW = 1_791_650_000.0


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Seq(wl.WorkerStatus):
    """Status dicts in order (the last repeats); a None entry = unreadable."""

    def __init__(self, *seq):
        self.seq, self.i = list(seq), 0

    def status(self):
        v = self.seq[min(self.i, len(self.seq) - 1)]
        self.i += 1
        return v


def st(state="idle", in_flight=0, age=10):
    return {"state": state, "in_flight": in_flight, "counts": {"stored": 1}, "last_ok_at": iso(NOW - age), "updated_at": iso(NOW - age)}


def yielder(*seq, **kw):
    return wl.Yield(Seq(*seq), poll_s=60, stop_s=kw.pop("stop_s", 1800), sleep=kw.pop("sleep", lambda s: None), wall=lambda: NOW, **kw)


@pytest.mark.parametrize("status,expect", [
    (st("rate_capped", 0), "go"), (st("idle", []), "go"), (st("idle", None), "go"), (st("idle", {}), "go"),
    (st("running", 0), "wait"), (st("working", 0), "wait"), (st("rate_capped", 1), "wait"), (st("idle", ["job"]), "wait"), (st("idle", {"w": 1}), "wait"),
    (None, "wait")])
def test_yield_rule_for_each_status(status, expect):
    assert yielder(status).decide() == expect


@pytest.mark.parametrize("status", [
    {"state": "idle", "in_flight": 0},                                                                     # no updated_at at all
    {"state": "rate_capped", "in_flight": 0, "updated_at": None, "sleep_s": 3000},
    {"state": "idle", "in_flight": 0, "updated_at": ""},
    {**st("idle", 0), "running": False},                                                                   # line 1 said "not running"
    {**st("rate_capped", 0, age=100), "running": False, "sleep_s": 3000}])
def test_a_missing_updated_at_or_a_dead_worker_fails_closed(status):
    with pytest.raises(wl.WorkerStalled):
        yielder(status, excuse_rate_cap_sleep=True).decide()


def test_a_status_older_than_three_minutes_is_a_stalled_worker():
    assert yielder(st("idle", 0, age=179)).decide() == "go"
    with pytest.raises(wl.WorkerStalled):
        yielder(st("idle", 0, age=181)).decide()
    with pytest.raises(wl.WorkerStalled):                                                       # stale beats everything, a busy state included
        yielder(st("running", 1, age=600)).decide()
    with pytest.raises(wl.WorkerStalled):
        yielder({"state": "idle", "in_flight": 0, "updated_at": "garbage"}).decide()


def test_rate_cap_sleep_is_excused_only_when_asked():
    asleep = {**st("rate_capped", 0, age=2874), "sleep_s": 2930.9}
    with pytest.raises(wl.WorkerStalled):
        yielder(asleep).decide()                                                                # the rule as ordered
    assert yielder(asleep, excuse_rate_cap_sleep=True).decide() == "go"                            # asleep for its own sleep_s: not stalled
    with pytest.raises(wl.WorkerStalled):
        yielder({**asleep, "sleep_s": 100}, excuse_rate_cap_sleep=True).decide()                    # overdue beyond sleep_s + 3 min
    with pytest.raises(wl.WorkerStalled):
        yielder({**asleep, "state": "idle"}, excuse_rate_cap_sleep=True).decide()                   # only the rate_capped state is excused


def test_the_lane_waits_then_goes_and_counts_the_waits(env):
    _, _, _, window, _ = env
    wid, _ = window("01")
    sleeps = []
    cnt, runner, _ = run(env, [wid], write=True, yielder=yielder(st("running", 1), st("idle", 1), st("rate_capped", 0), sleep=sleeps.append))
    assert cnt["ok"] == 1 and cnt["behind_waits"] == 2 and sleeps == [60, 60] and cnt["stopped"] is None


def test_thirty_minutes_of_waiting_stops_the_run_and_writes_nothing(env):
    root, _, _, window, _ = env
    wid, _ = window("01")
    clock = [0.0]
    y = wl.Yield(Seq(st("running", 1)), poll_s=600, stop_s=1800, sleep=lambda s: clock.__setitem__(0, clock[0] + s), now=lambda: clock[0], wall=lambda: NOW)
    cnt, runner, _ = run(env, [wid], write=True, yielder=y)
    assert cnt["stopped"] == "production_behind" and runner.calls == 0 and tracks(root, wid) == []


def test_a_stalled_worker_stops_the_run_before_any_window(env):
    root, _, _, window, _ = env
    ids = [window("01")[0], window("02")[0]]
    cnt, runner, _ = run(env, ids, write=True, yielder=yielder(st("idle", 0, age=900)))
    assert cnt["stopped"] == "worker_stalled" and runner.calls == 0 and all(tracks(root, w) == [] for w in ids)


def test_the_check_is_between_windows_a_running_window_is_finished(env):
    root, _, _, window, _ = env
    ids = [window("01")[0], window("02")[0]]
    log = []
    src = Seq(st("idle", 0), st("running", 1))                                                  # ok for window 1, busy at window 2's check, for ever
    clock = [0.0]
    y = wl.Yield(src, poll_s=600, stop_s=1800, sleep=lambda s: clock.__setitem__(0, clock[0] + s), now=lambda: clock[0], wall=lambda: NOW)
    cnt, runner, _ = run(env, ids, write=True, yielder=y, log=log)
    assert len(tracks(root, ids[0])) == 1 and tracks(root, ids[1]) == [] and cnt["ok"] == 1 and cnt["stopped"] == "production_behind"


def test_status_sources(tmp_path):
    f = tmp_path / "s.json"
    f.write_text(json.dumps(st("idle", 0)))
    assert wl.FileStatus(str(f)).status()["state"] == "idle" and wl.FileStatus(str(tmp_path / "none")).status() is None
    out = "running pid=1\n" + json.dumps(st("rate_capped", 0)) + "\nTesla T4, 1 MiB, 2 MiB\n"
    R = lambda rc, o: (lambda *a, **k: type("R", (), {"returncode": rc, "stdout": o})())
    assert wl.CmdStatus("x", runner=R(0, out)).status()["state"] == "rate_capped"
    assert wl.CmdStatus("x", runner=R(1, out)).status() is None and wl.CmdStatus("x", runner=R(0, "only one line")).status() is None
    assert wl.CmdStatus("x", runner=R(0, "a\nnot json")).status() is None
    assert "running" not in wl.FileStatus(str(f)).status()
    # liveness = the status JSON's own pid is a live process whose cmdline holds tools/nemotron-worker/worker.py; line 1 of `status` (pidfile based) is ignored
    proc = tmp_path / "proc"
    for pid, cmd in ((101, b"/venv/bin/python\0/x/tools/nemotron-worker/worker.py\0"), (102, b"/usr/bin/python3\0/lab/other.py\0")):
        (proc / str(pid)).mkdir(parents=True)
        (proc / str(pid) / "cmdline").write_bytes(cmd)
    def alive(pid_field, line1="not running"):
        s = {**st("idle", 0), **({} if pid_field is None else {"pid": pid_field})}
        return wl.CmdStatus("x", runner=R(0, line1 + "\n" + json.dumps(s) + "\n"), proc_root=str(proc)).status()["running"]
    assert alive(101) is True and alive(101, "running pid=1") is True              # alive even though line 1 says "not running" (the pidfile is gone)
    assert alive(103) is False                                                       # pid not in /proc: dead
    assert alive(None) is False and alive("101") is False and alive(0) is False and alive(True) is False          # missing / not an int / not positive / a bool
    assert alive(102) is False and alive(102, "running pid=102") is False           # a live process that is not the worker (recycled pid, other program)
    assert wl.worker_alive(None) is False and wl.worker_alive({"pid": 101}, str(proc)) is True
    seen = []
    wl.CmdStatus(runner=lambda cmd, **k: (seen.append(cmd), type("R", (), {"returncode": 0, "stdout": "a\n{}"})())[1]).status()
    assert seen[0][:2] == ["bash", "-lc"] and "nemotron-worker-main-79fc614/tools/nemotron-worker" in seen[0][2] and seen[0][2].endswith("./nemotron-worker.sh status")
    assert isinstance(wl.status_from_spec("worker"), wl.CmdStatus) and isinstance(wl.status_from_spec("none"), wl.NoWorker) and isinstance(wl.status_from_spec("file:/x"), wl.FileStatus)
    with pytest.raises(SystemExit):
        wl.status_from_spec("bogus")


def test_errors_are_counted_without_message_text_and_stop_after_five(env):
    root, _, _, window, tmp = env
    ids = [window(f"{i:02d}")[0] for i in range(1, 9)]
    runner = FakeRunner([], fail=RuntimeError("the patient said hello doctor"))
    cnt, _, _ = run(env, ids, write=True, runner=runner)
    assert cnt["errors"] == 6 and cnt["stopped"] == "errors" and runner.calls == 6 and all(tracks(root, w) == [] for w in ids)      # >5 stops the run
    log = open([os.path.join(tmp, "logs", f) for f in os.listdir(tmp / "logs")][0]).read()
    assert "hello" not in log and "unclassified" in log and '"error": "RuntimeError"' in log


def test_empty_result_is_an_empty_track_and_scratch_is_moved_not_deleted(env):
    root, _, _, window, tmp = env
    wid, _ = window("01")
    cnt, _, _ = run(env, [wid], write=True, runner=FakeRunner([], turns=[]))
    assert cnt["empty"] == 1
    t = json.load(open(os.path.join(root, DATE, ROOM, wid, "tracks", tracks(root, wid)[0])))
    assert t["status"] == "empty" and t["segments"] == []
    work = tmp / "work"
    assert [n for n in os.listdir(work) if n.startswith("scratch-")] == [] and len(os.listdir(work / "_to_delete")) == 1


def test_cfg8_changes_with_the_audio_signature(env):
    root, data, tapes, window, tmp = env
    wid, _ = window("01")
    run(env, [wid], write=True)
    open(os.path.join(data, "w.webm"), "wb").write(b"other-bytes")              # the manifest sha no longer matches: sha_mismatch, nothing new written
    cnt, runner, _ = run(env, [wid], write=True)
    assert cnt["sha_mismatch"] == 1 and runner.calls == 0 and len(tracks(root, wid)) == 1


# ---------------------------------------------------------------- B2: the classifier reads diar.nemotron when there is no pyannote
def nem_track(root, wid, t0, segs, status="ok"):
    put(root, wid, "diar", "nemotron", [{"t0_ms": t0 + a * 1000, "t1_ms": t0 + b * 1000, "speaker": s} for a, b, s in segs], status=status)


ALT = tuple((i * 20, i * 20 + 18, f"speaker_{i % 2}") for i in range(15))       # one 298 s turn-taking chain


def test_classifier_uses_nemotron_turns_on_tape_time_and_prefers_pyannote(env):
    root, _, _, window, _ = env
    a, t0a = window("01")
    nem_track(root, a, t0a, ALT)
    src, st, turns = cw.window_turns(reb.load_window(a, root=root))
    assert (src, st) == ("nemotron", "ok") and turns[0] == (0.0, 18.0, "speaker_0")                 # window-relative seconds, not tape ms
    f = cw.diar_features(turns, 900.0)
    assert cw.label_of(f["speech_frac"], f["longest_turn_taking_s"], None) == "CONSULT-LIKE"
    b, t0b = window("02")
    nem_track(root, b, t0b, ALT)
    put(root, b, "diar", "pyannote-local-twin", [], status="empty")                                  # pyannote ran and found nothing: that stays the evidence
    assert cw.window_turns(reb.load_window(b, root=root))[:2] == ("pyannote", "empty")
    c, _ = window("03")
    assert cw.window_turns(reb.load_window(c, root=root)) == (None, "absent", None)
    d, t0d = window("04")
    nem_track(root, d, t0d, [], status="empty")
    assert cw.window_turns(reb.load_window(d, root=root)) == ("nemotron", "empty", [])
    e, t0e = window("05")
    put(root, e, "diar", "nemotron", [], status="failed")
    assert cw.window_turns(reb.load_window(e, root=root))[0] is None


# ---------------------------------------------------------------- the stop-flag file (refuter #11355, architect #11358): stop without killing anything
def test_a_stop_file_before_the_run_starts_nothing(env, tmp_path):
    root, _, _, window, _ = env
    ids = [window("01")[0], window("02")[0]]
    flag = tmp_path / "STOP"
    flag.write_text("")
    cnt, runner, _ = run(env, ids, write=True, stop_file=str(flag))
    assert cnt["stopped"] == "stop_file" and runner.calls == 0 and all(tracks(root, w) == [] for w in ids)


def test_a_stop_file_made_during_a_window_lets_that_window_finish_and_starts_no_other(env, tmp_path):
    root, _, _, window, _ = env
    ids = [window("01")[0], window("02")[0], window("03")[0]]
    flag = tmp_path / "STOP"

    class Touching(FakeRunner):
        def diarize(self, wav):
            r = super().diarize(wav)
            flag.write_text("")                                                                  # the operator touches the flag while window 1 is being diarized
            return r
    cnt, runner, _ = run(env, ids, write=True, runner=Touching([]), stop_file=str(flag))
    assert cnt["ok"] == 1 and cnt["stopped"] == "stop_file" and runner.calls == 1
    assert len(tracks(root, ids[0])) == 1 and tracks(root, ids[1]) == [] and tracks(root, ids[2]) == []        # the running window was finished and written
    cnt, runner, _ = run(env, ids, write=True)                                                   # without the flag a rerun does the rest (window 1 is skip-existing)
    assert cnt["ok"] == 2 and cnt["skipped_existing"] == 1 and cnt["stopped"] is None


def test_a_stop_file_also_ends_the_wait_for_the_production_worker(env, tmp_path):
    root, _, _, window, _ = env
    wid, _ = window("01")
    flag = tmp_path / "STOP"
    polls, clock = [], [0.0]

    def sleep(s):
        polls.append(s)
        clock[0] += s                                                                            # a fake clock: even a broken stop check ends at the 30-min stop, it cannot spin
        flag.write_text("")                                                                      # raised during the first wait
    y = wl.Yield(Seq(st("running", 1)), poll_s=60, stop_s=1800, sleep=sleep, now=lambda: clock[0], wall=lambda: NOW, stop_check=lambda: flag.exists())
    cnt, runner, _ = run(env, [wid], write=True, yielder=y, stop_file=str(flag))
    assert cnt["stopped"] == "stop_file" and polls == [60] and runner.calls == 0
