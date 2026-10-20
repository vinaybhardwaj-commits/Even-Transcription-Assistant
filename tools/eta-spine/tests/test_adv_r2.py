"""Opus refute R2 adversarial tests, ported in R3 (synthetic ids only) and adapted to the R3 behaviour (release, not transient; minimum budget; validated env window)."""
import os, signal, subprocess, sys, textwrap, threading, time
TESTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTS); sys.path.insert(0, os.path.join(TESTS, ".."))
import pytest
import executors, runner  # noqa
from test_executors import box, at, UID, _alive  # noqa: F401

# ---- F1 edges (R3: refusals are `release`)
@pytest.mark.parametrize("m,s,code", [(19, 59, None), (24, 59, "budget_too_small"), (25, 0, "hourly_gap"), (44, 59, "hourly_gap"), (45, 0, None), (0, 0, None), (59, 59, None)])
def test_window_edges_real_lane(box, m, s, code):
    r = executors.Executors(env=box.env, clock=lambda: at(m, s)).execute("acoustics", UID)
    assert (r.code if r.outcome == "release" else None) == code
    assert (r.outcome == "release") == (code is not None)

def test_window_edge_subsecond():
    assert not executors.in_hourly_window(at(24, 59) + 0.999)
    assert executors.in_hourly_window(at(25, 0))
    assert executors.in_hourly_window(at(44, 59) + 0.999)
    assert not executors.in_hourly_window(at(45, 0))

@pytest.mark.parametrize("m,s,exp", [(45, 0, 840), (0, 0, 840), (11, 0, 840), (11, 1, 839), (24, 0, 60), (24, 59, 1), (59, 59, 840)])
def test_cap(m, s, exp):
    assert executors.lane_timeout_s(at(m, s)) == pytest.approx(exp)

def test_start_at_45_ends_before_next_25():
    for m in range(45, 60):
        assert (at(m) + executors.lane_timeout_s(at(m))) <= at(25) + 3600
    for m in range(0, 25):
        assert at(m) + executors.lane_timeout_s(at(m)) <= at(25)

def test_doomed_start_at_24_59_is_released_not_spawned(box):
    (box.tmp / "lab" / "kit" / "reb" / "clip_lanes.py").write_text("import time; time.sleep(30)\n")
    r = executors.Executors(env=box.env, clock=lambda: at(24, 59) + 0.5).execute("acoustics", UID)
    assert (r.outcome, r.code) == ("release", "budget_too_small") and box.calls() == []

@pytest.mark.parametrize("frm,to", [("45", "25"), ("30", "30"), ("0", "0")])
def test_inverted_or_empty_env_window_falls_back_to_defaults(box, capsys, frm, to):
    env = dict(box.env, SPINE_HOURLY_FROM_MIN=frm, SPINE_HOURLY_TO_MIN=to)
    ex = executors.Executors(env=env, clock=lambda: at(40))
    assert (ex.hourly_from, ex.hourly_to) == (25, 45)
    assert ex.execute("acoustics", UID).code == "hourly_gap"
    assert capsys.readouterr().err.count("spine-executors:") == 1

def test_hourly_gap_through_the_runner_reports_release(box):
    sent = []
    job = {"job_id": 1, "stage": "acoustics", "mode": "live", "encounter_id": "enc_testaaaaaaaaaaaa", "cut_version": "c", "input_key": "k", "attempts": 1, "consult_uid": UID}
    r = runner.Runner("http://x", "t", "o", live=True, post=lambda p, b: (sent.append(b), (200, {"jobs": [job]} if p.endswith("claim") else {"ok": True}))[1], log=lambda m: None,
                      execs=executors.Executors(env=box.env, clock=lambda: at(40)))
    r.run_once()
    assert [b["outcome"] for b in sent if "outcome" in b] == ["release"] and all("artefact" not in b for b in sent)

def test_child_registered_before_a_signal_and_gets_a_clean_mask(box, tmp_path):
    """The spawn blocks SIGTERM/SIGINT until the child is registered; the child itself must not inherit the blocked mask."""
    ex = executors.Executors(env=box.env)
    seen = {}
    real_add = ex._children.add
    class Spy(set):
        def add(self, p):
            seen["blk_in_parent"] = signal.pthread_sigmask(signal.SIG_BLOCK, set())
            super().add(p)
    ex._children = Spy()
    p = ex._run_group([sys.executable, "-c", "print(open('/proc/self/status').read())"])
    assert {signal.SIGTERM, signal.SIGINT} <= seen["blk_in_parent"]            # still blocked while registering
    assert signal.SIGTERM not in signal.pthread_sigmask(signal.SIG_BLOCK, set())   # restored afterwards
    sigblk = [l for l in p.stdout.splitlines() if l.startswith("SigBlk")][0].split()[1]
    assert int(sigblk, 16) & ((1 << 14) | (1 << 1)) == 0                        # SIGTERM (15) and SIGINT (2) are not blocked in the child

# ---- F2 real flock + signals, continuous probe, grandchild
SLOW = textwrap.dedent('''
    import os, subprocess, sys, time
    g = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    open(os.environ["FAKE_PIDFILE"], "w").write("%d %d" % (os.getpid(), g.pid))
    time.sleep(60)
''')
DRV = textwrap.dedent('''
    import os, sys
    sys.path.insert(0, sys.argv[1]); import executors, runner
    sent = []
    r = runner.Runner("http://x", "t", "o", live=True, post=lambda p, b: (sent.append(b), (200, {"jobs": [{"job_id": 1, "stage": "acoustics", "mode": "live", "encounter_id": "enc_testaaaaaaaaaaaa", "cut_version": "c", "input_key": "k", "attempts": 1, "consult_uid": "uid_test_01"}]} if p.endswith("claim") else {"ok": True}))[1], log=lambda m: None,
                      execs=executors.Executors(env=dict(os.environ), clock=lambda: float(sys.argv[2])))
    executors.install_signal_handlers(r.execs)
    print("ready", flush=True)
    r.run_once()
''')

def _go(box, tmp_path, sig):
    (box.tmp / "lab" / "kit" / "reb" / "clip_lanes.py").write_text(SLOW)
    pf = tmp_path / "pids"
    drv = subprocess.Popen([sys.executable, "-c", DRV, os.path.join(TESTS, ".."), str(at(10))], env=dict(os.environ, FAKE_PIDFILE=str(pf)), stdout=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    for _ in range(200):
        if pf.exists() and len(pf.read_text().split()) == 2: break
        time.sleep(0.02)
    child, grand = map(int, pf.read_text().split())
    lock = str(box.data / "reb" / "_hourly.lock")
    free_while_alive = []
    stop = threading.Event()
    def probe():
        while not stop.is_set():
            alive = _alive(child) or _alive(grand)
            if executors.probe_flock(lock) and alive and (_alive(child) or _alive(grand)):
                free_while_alive.append(time.time())
            time.sleep(0.002)
    th = threading.Thread(target=probe); th.start()
    time.sleep(0.3)
    drv.send_signal(sig)
    rc = drv.wait(timeout=10)
    time.sleep(0.2); stop.set(); th.join()
    return rc, child, grand, free_while_alive, lock

@pytest.mark.parametrize("sig,code", [(15, 143), (2, 130)])
def test_signal_runner_path_lock_never_free_no_orphan(box, tmp_path, sig, code):
    rc, child, grand, bad, lock = _go(box, tmp_path, sig)
    try:
        assert rc == code
        assert not _alive(child) and not _alive(grand), "orphan"
        assert bad == [], "hourly lock free while a child/grandchild was alive"
        assert executors.probe_flock(lock)
    finally:
        for p in (child, grand):
            try: os.kill(p, 9)
            except OSError: pass

# ---- F3 python side
@pytest.mark.parametrize("stage", ["recut", "acoustics", "nemotron"])
@pytest.mark.parametrize("uid", [None, ""])
def test_no_uid_is_blocked_and_spawns_nothing(box, stage, uid):
    r = box.ex().execute(stage, uid)
    assert (r.outcome, r.code) == ("blocked", "no_consult_uid") and box.calls() == []

# ---- F8 residual: vanish between glob and getmtime
def test_vanish_before_getmtime(box, monkeypatch):
    real = os.path.getmtime
    def gm(p):
        if p.endswith(".json"): raise FileNotFoundError(p)
        return real(p)
    monkeypatch.setattr(os.path, "getmtime", gm)
    r = box.ex().execute("acoustics", UID)
    assert r.outcome == "transient"

# ---- recreated R1 tests (the R1 harness was removed)
def test_r1_recut_runs_under_nice_10(box):
    seen = {}
    def run(argv, **kw):
        seen["argv"] = argv
        return subprocess.CompletedProcess(argv, 0, '{"eligible":0,"cut":0,"skipped":0,"errors":0,"deferred_gpu":0}', "")
    executors.Executors(env=box.env, run=run, clock=lambda: at(10)).execute("recut", UID)
    assert seen["argv"][:3] == ["nice", "-n", "10"]

@pytest.mark.parametrize("rc", [-9, 137, 1])
def test_r1_lane_killed_or_crash_rc_is_transient(box, rc):
    run = lambda argv, **kw: subprocess.CompletedProcess(argv, rc, "", "")
    r = executors.Executors(env=box.env, run=run, clock=lambda: at(10)).execute("nemotron", UID)
    assert r.outcome == "transient"
