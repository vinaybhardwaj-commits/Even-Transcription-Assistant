"""S6 executors against FAKE CLIs (real subprocesses, real flocks, a tmp data dir). No engine, no real data, no network. Synthetic ids only."""
import datetime as dt
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import textwrap
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import executors  # noqa: E402
import runner  # noqa: E402

UID = "uid_test_01"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def at(minute, second=0):
    return dt.datetime(2026, 10, 20, 11, minute, second, tzinfo=IST).timestamp()


FAKE_CUTTER = textwrap.dedent('''
    import fcntl, json, os, sys
    uid = sys.argv[sys.argv.index("--only") + 1]
    open(os.environ["FAKE_LOG"], "a").write(json.dumps(sys.argv[1:]) + "\\n")
    mode = os.environ.get("FAKE_MODE", "cut")
    data = os.environ["SPINE_DATA_DIR"]
    if mode == "lockcheck":
        fd = os.open(os.path.join(data, "consult", "cutter.lock"), os.O_RDWR | os.O_CREAT)
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError: print(json.dumps({"locked": True})); sys.exit(0)
    if mode == "locked": print(json.dumps({"locked": True})); sys.exit(0)
    if mode == "abort": print(json.dumps({"aborted": "prints_invalid"})); sys.exit(3)
    if mode == "sleep":
        import time; time.sleep(30)
    if mode == "silent":
        sys.stderr.write("2026 cutter.run re-cut of %s not done: skip silent_audio\\n" % uid)
        print(json.dumps({"eligible": 1, "cut": 0, "skipped": 1, "errors": 0, "deferred_gpu": 0})); sys.exit(0)
    if mode == "notape":
        sys.stderr.write("re-cut of %s not done: skip no_tape\\n" % uid)
        print(json.dumps({"eligible": 1, "cut": 0, "skipped": 1, "errors": 0, "deferred_gpu": 0})); sys.exit(0)
    if mode == "gpu": print(json.dumps({"eligible": 1, "cut": 0, "skipped": 0, "errors": 0, "deferred_gpu": 1})); sys.exit(0)
    if mode == "error": print(json.dumps({"eligible": 1, "cut": 0, "skipped": 0, "errors": 1, "deferred_gpu": 0})); sys.exit(0)
    if mode == "none": print(json.dumps({"eligible": 0, "cut": 0, "skipped": 0, "errors": 0, "deferred_gpu": 0})); sys.exit(0)
    clips = os.path.join(data, "consult", "clips"); rel = "2026-10-20/room_a/" + uid
    os.makedirs(os.path.join(clips, rel), exist_ok=True)
    if mode != "noflac": open(os.path.join(clips, rel, "consult.flac"), "wb").write(b"FLAC-" + uid.encode())
    open(os.path.join(clips, "index.jsonl"), "a").write(json.dumps({"consult_uid": uid, "status": "cut", "path": rel, "signature": "sig-1"}) + "\\n")
    print(json.dumps({"eligible": 1, "cut": 1, "skipped": 0, "errors": 0, "deferred_gpu": 0}))
''')

FAKE_LANES = textwrap.dedent('''
    import fcntl, json, os, sys
    a = sys.argv
    lane, uid = a[a.index("--lane") + 1], a[a.index("--consult") + 1]
    data = os.environ["SPINE_DATA_DIR"]
    # a fake hourly tries the lock WHILE the executor's child runs
    fd = os.open(os.path.join(data, "reb", "_hourly.lock"), os.O_RDWR | os.O_CREAT)
    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); held = "free"
    except OSError: held = "busy"
    open(os.environ["FAKE_LOG"], "a").write(json.dumps({"argv": a[1:], "hourly_while_running": held}) + "\\n")
    mode = os.environ.get("FAKE_MODE", "write")
    counts = {"clips": 1, "written": 0, "skipped_existing": 0, "errors": 0, "failed": 0, "blind_refused": 0, "deferred_recut": 0, "not_cut_refused": 0, "clip_mismatch": 0}
    if mode == "write":
        counts["written"] = 1
        engine = {"acoustics": "acoustics.room_profile_acoustics__v1__0a1b2c3d", "nemotron": "diar.nemotron__abcd1234__0123abcd"}[lane]
        d = os.path.join(data, "reb", "2026-10-20", "room_a", "_consults", uid, "tracks"); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, engine + ".json"), "w").write(json.dumps({"status": "ok", "segments": []}))
    elif mode == "existing":
        counts["skipped_existing"] = 1
        d = os.path.join(data, "reb", "2026-10-20", "room_a", "_consults", uid, "tracks"); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "acoustics.room_profile_acoustics__v1__0a1b2c3d.json"), "w").write(json.dumps({"status": "empty"}))
    elif mode == "blind": counts["blind_refused"] = 1
    elif mode == "noclip": counts["clips"] = 0
    elif mode == "recutpending": counts["deferred_recut"] = 1
    elif mode == "notcut": counts["not_cut_refused"] = 1
    elif mode == "failed": counts["failed"] = 1
    elif mode == "nofile": counts["written"] = 1
    out = {"lane": lane, "write": True, "counts": counts}
    if mode == "stopped": out["counts"]["stopped"] = "production_behind"
    if mode == "usage": sys.exit(2)
    if mode == "crash": sys.exit(1)
    print(json.dumps(out))
''')


@pytest.fixture
def box(tmp_path, monkeypatch):
    data = tmp_path / "eta-data"
    (data / "consult").mkdir(parents=True)
    (data / "reb").mkdir()
    cut, lab = tmp_path / "cutter", tmp_path / "lab"
    (cut / "cutter").mkdir(parents=True)
    (cut / "cutter" / "__init__.py").write_text("")
    (cut / "cutter" / "run.py").write_text(FAKE_CUTTER)
    (lab / "kit" / "reb").mkdir(parents=True)
    (lab / "kit" / "__init__.py").write_text("")
    (lab / "kit" / "reb" / "__init__.py").write_text("")
    (lab / "kit" / "reb" / "clip_lanes.py").write_text(FAKE_LANES)
    log = tmp_path / "calls.log"
    env = {"SPINE_DATA_DIR": str(data), "SPINE_GPU_LOCK": str(tmp_path / "gpu.lock"), "SPINE_CUTTER_DIR": str(cut), "SPINE_CUTTER_PY": sys.executable,
           "SPINE_LAB_DIR": str(lab), "SPINE_LAB_PY": sys.executable, "FAKE_LOG": str(log)}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("FAKE_MODE", raising=False)

    class Box:
        pass
    b = Box()
    b.data, b.log, b.env, b.tmp = data, log, env, tmp_path
    b.ex = lambda minute=10: executors.Executors(env=env, clock=lambda: at(minute))
    b.calls = lambda: [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return b


def hold(path):
    """A fake hourly / timer: another process holding the flock."""
    p = subprocess.Popen([sys.executable, "-c", "import fcntl,os,sys,time\nfd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT)\nfcntl.flock(fd,fcntl.LOCK_EX)\nprint('ready',flush=True)\ntime.sleep(60)", str(path)],
                         stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == "ready"
    return p


# ---------------------------------------------------------------- --only per lane: exactly this uid, nothing broader
def test_recut_argv_is_the_per_uid_cutter_recut(box):
    r = box.ex().execute("recut", UID)
    assert r.outcome == "done"
    assert box.calls() == [["--once", "--only", UID, "--recut"]]   # argv after `-m cutter.run`


def test_acoustics_and_nemotron_argv_are_per_consult_write(box):
    box.ex().execute("acoustics", UID)
    box.ex().execute("nemotron", UID)
    a, n = [c["argv"] for c in box.calls()]
    assert a == ["--lane", "acoustics", "--consult", UID, "--write"]
    assert n == ["--lane", "nemotron", "--consult", UID, "--write", "--worker-status", "worker"]
    for argv in (a, n):
        assert "--date" not in argv and "--since" not in argv   # never a date sweep


def test_uid_that_could_be_read_as_a_flag_or_is_missing_never_spawns(box):
    ex = box.ex()
    for bad in ["--since", "-x", "a b", "a;b", "", "x" * 200]:
        r = ex.execute("recut", bad)
        assert (r.outcome, r.code) == ("permanent", "bad_consult_uid" if bad else "no_consult_uid"), bad
    assert ex.execute("nemotron", None).code == "no_consult_uid"
    assert box.calls() == []


def test_unconfigured_env_raises_and_spawns_nothing(box):
    for missing, stage in [("SPINE_CUTTER_DIR", "recut"), ("SPINE_CUTTER_PY", "recut"), ("SPINE_LAB_DIR", "acoustics"), ("SPINE_LAB_PY", "nemotron")]:
        env = {k: v for k, v in box.env.items() if k != missing}
        with pytest.raises(executors.ExecutorUnconfigured):
            executors.Executors(env=env, clock=lambda: at(10)).execute(stage, UID)
    with pytest.raises(executors.ExecutorUnconfigured):
        box.ex().execute("sarvam", UID)
    assert box.calls() == []
    assert not box.ex().has("sarvam") and not box.ex().has("collector") and box.ex().has("recut")


# ---------------------------------------------------------------- success -> artefact report with sha256
def test_recut_success_reports_artefact_sha_of_the_consult_flac(box):
    r = box.ex().execute("recut", UID)
    want = hashlib.sha256(b"FLAC-" + UID.encode()).hexdigest()
    assert r.outcome == "done" and r.code is None
    assert r.artefact == {"engine": "cutter", "version": "v1", "cfg8": hashlib.sha256(b"sig-1").hexdigest()[:8], "store": "box", "status": "ok", "sha256": want, "object_key": "consult.flac"}
    assert UID not in json.dumps(r.artefact)


@pytest.mark.parametrize("stage,engine,version,cfg8", [("acoustics", "room_profile_acoustics", "v1", "0a1b2c3d"), ("nemotron", "nemotron", "abcd1234", "0123abcd")])
def test_lane_success_reports_artefact_sha_of_the_track_file(box, stage, engine, version, cfg8):
    r = box.ex().execute(stage, UID)
    assert r.outcome == "done"
    f = next((box.data / "reb").rglob("tracks/*.json"))
    assert r.artefact == {"engine": engine, "version": version, "cfg8": cfg8, "store": "box", "status": "ok", "sha256": hashlib.sha256(f.read_bytes()).hexdigest(), "object_key": f"tracks/{f.name}"}
    assert UID not in json.dumps(r.artefact) and "2026" not in json.dumps(r.artefact)


def test_lane_skipped_existing_is_done_with_the_existing_artefact(box, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "existing")
    r = box.ex().execute("acoustics", UID)
    assert r.outcome == "done" and r.artefact["status"] == "empty" and len(r.artefact["sha256"]) == 64


def test_success_without_a_file_is_transient_artefact_missing(box, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "noflac")
    assert (box.ex().execute("recut", UID).outcome, box.ex().execute("recut", UID).code) == ("transient", "artefact_missing")
    monkeypatch.setenv("FAKE_MODE", "nofile")
    r = box.ex().execute("acoustics", UID)
    assert (r.outcome, r.code) == ("transient", "artefact_missing")


# ---------------------------------------------------------------- error-class map
@pytest.mark.parametrize("mode,outcome,code", [
    ("silent", "permanent", "silent_audio"),            # the audio will not change
    ("notape", "transient", "skip_no_tape"),            # tape may still arrive
    ("locked", "transient", "lock_busy"),
    ("gpu", "transient", "gpu_busy"),
    ("error", "transient", "cut_error"),
    ("none", "transient", "not_selected"),
    ("abort", "transient", "rc_3"),
])
def test_recut_error_map(box, monkeypatch, mode, outcome, code):
    monkeypatch.setenv("FAKE_MODE", mode)
    r = box.ex().execute("recut", UID)
    assert (r.outcome, r.code) == (outcome, code) and r.artefact is None


@pytest.mark.parametrize("mode,outcome,code", [
    ("blind", "permanent", "blind_refused"),
    ("usage", "permanent", "usage"),
    ("noclip", "transient", "no_clip"),
    ("recutpending", "transient", "recut_pending"),
    ("notcut", "transient", "not_cut"),
    ("failed", "transient", "lane_failed"),
    ("stopped", "transient", "stopped_production_behind"),
    ("crash", "transient", "rc_1"),
])
def test_lane_error_map(box, monkeypatch, mode, outcome, code):
    monkeypatch.setenv("FAKE_MODE", mode)
    r = box.ex().execute("nemotron", UID)
    assert (r.outcome, r.code) == (outcome, code) and r.artefact is None


def test_timeout_is_transient_and_the_child_is_killed(box, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "sleep")
    monkeypatch.setattr(executors, "CHILD_TIMEOUT_S", 1)
    t = time.time()
    r = box.ex().execute("recut", UID)
    assert (r.outcome, r.code) == ("transient", "timeout") and time.time() - t < 10


# ---------------------------------------------------------------- lock contention: the runner and the timers never both run
def test_recut_never_spawns_while_cutter_lock_is_held(box):
    p = hold(box.data / "consult" / "cutter.lock")
    try:
        r = box.ex().execute("recut", UID)
    finally:
        p.kill()
    assert (r.outcome, r.code) == ("transient", "lock_busy") and box.calls() == []


def test_cutter_lock_taken_between_probe_and_spawn_is_still_transient(box, monkeypatch):
    """The cutter itself is the second guard: it prints {"locked": true} and exits 0."""
    monkeypatch.setenv("FAKE_MODE", "lockcheck")
    p = hold(box.data / "consult" / "cutter.lock")
    ex = box.ex()
    monkeypatch.setattr(executors, "probe_flock", lambda path: True)   # the probe saw it free; the child then finds it busy
    try:
        r = ex.execute("recut", UID)
    finally:
        p.kill()
    assert (r.outcome, r.code) == ("transient", "lock_busy") and len(box.calls()) == 1


@pytest.mark.parametrize("minute,second", [(35, 0), (35, 59), (37, 30), (28, 0), (30, 0), (34, 59)])
def test_recut_refuses_inside_the_35_gap(box, minute, second):
    ex = executors.Executors(env=box.env, clock=lambda: at(minute, second))
    r = ex.execute("recut", UID)
    assert (r.outcome, r.code) == ("transient", "timer_gap") and box.calls() == []


def test_recut_runs_between_the_gaps(box):
    for minute in (39, 10, 22):
        assert executors.Executors(env=box.env, clock=lambda m=minute: at(m)).execute("recut", UID).outcome == "done"


@pytest.mark.parametrize("stage", ["acoustics", "nemotron"])
def test_lane_never_spawns_while_the_hourly_holds_its_lock(box, stage):
    p = hold(box.data / "reb" / "_hourly.lock")
    try:
        r = box.ex().execute(stage, UID)
    finally:
        p.kill()
    assert (r.outcome, r.code) == ("transient", "lock_busy") and box.calls() == []


@pytest.mark.parametrize("stage", ["acoustics", "nemotron"])
def test_hourly_cannot_start_while_the_runner_child_runs_and_can_after(box, stage):
    r = box.ex().execute(stage, UID)
    assert r.outcome == "done"
    assert box.calls()[0]["hourly_while_running"] == "busy"   # the fake hourly, trying mid-run, was refused
    assert executors.probe_flock(str(box.data / "reb" / "_hourly.lock"))   # released at the end, also on an error path


def test_lock_is_released_after_a_failing_child(box, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "crash")
    box.ex().execute("acoustics", UID)
    assert executors.probe_flock(str(box.data / "reb" / "_hourly.lock"))


def test_nemotron_never_spawns_while_gpu_lock_is_held_but_acoustics_does(box):
    p = hold(box.tmp / "gpu.lock")
    try:
        n = box.ex().execute("nemotron", UID)
        a = box.ex().execute("acoustics", UID)
    finally:
        p.kill()
    assert (n.outcome, n.code) == ("transient", "gpu_busy")
    assert a.outcome == "done" and [c["argv"][1] for c in box.calls()] == ["acoustics"]
    assert executors.probe_flock(str(box.data / "reb" / "_hourly.lock"))   # the gpu_busy path released the hourly lock too


def test_executor_does_not_hold_gpu_lock_while_the_child_runs(box):
    """clip_lanes takes ~/gpu.lock per inference itself: holding it here would deadlock the child."""
    seen = {}
    real = box.ex()._run

    def spy(*a, **k):
        seen["gpu_free"] = executors.probe_flock(box.env["SPINE_GPU_LOCK"])
        return real(*a, **k)
    ex = executors.Executors(env=box.env, run=spy, clock=lambda: at(10))
    ex.execute("nemotron", UID)
    assert seen["gpu_free"] is True


# ---------------------------------------------------------------- the whole path: runner --live -> executor -> report
def test_runner_live_reports_the_artefact_over_the_wire(box):
    sent = []

    def post(path, body):
        sent.append((path, body))
        job = {"job_id": 5, "encounter_id": "enc_testaaaaaaaaaaaa", "stage": "recut", "mode": "live", "consult_uid": UID}
        return (200, {"ok": True, "jobs": [job]}) if path.endswith("claim") else (200, {"ok": True})
    logs = []
    r = runner.Runner("https://x", "t", "o", live=True, post=post, log=logs.append, execs=box.ex())
    assert r.run_once() == 0
    rep = sent[1][1]
    assert rep["outcome"] == "done" and rep["artefact"]["sha256"] == hashlib.sha256(b"FLAC-" + UID.encode()).hexdigest()
    assert not any(UID in m for m in logs)


def test_runner_live_silent_audio_reports_permanent(box, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "silent")
    sent = []

    def post(path, body):
        sent.append((path, body))
        job = {"job_id": 5, "encounter_id": "enc_testaaaaaaaaaaaa", "stage": "recut", "mode": "live", "consult_uid": UID}
        return (200, {"ok": True, "jobs": [job]}) if path.endswith("claim") else (200, {"ok": True})
    runner.Runner("https://x", "t", "o", live=True, post=post, log=lambda m: None, execs=box.ex()).run_once()
    assert sent[1][1] == {"job_id": 5, "owner": "o", "outcome": "permanent", "error_code": "silent_audio"}
