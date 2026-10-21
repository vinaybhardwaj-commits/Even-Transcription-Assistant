"""Opus refute R3 adversarial tests (synthetic ids only). Run from a copy of tools/eta-spine/tests."""
import os, signal, subprocess, sys, textwrap, time
TESTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTS); sys.path.insert(0, os.path.join(TESTS, ".."))
import pytest
import executors, runner  # noqa
from test_executors import box, at, UID, _alive  # noqa: F401

SIGBIT = lambda s: 1 << (s - 1)

def _sigblk(text):
    return int([l for l in text.splitlines() if l.startswith("SigBlk")][0].split()[1], 16)

# ---- (3) the child gets the OLD mask, exactly; the parent's mask is restored exactly
def test_child_gets_exactly_the_old_mask_and_parent_is_restored(box):
    old = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR1})
    try:
        ex = executors.Executors(env=box.env)
        p = ex._run_group([sys.executable, "-c", "print(open('/proc/self/status').read())"])
        blk = _sigblk(p.stdout)
        assert blk & SIGBIT(signal.SIGUSR1), "the child lost the caller's old mask"
        assert blk & (SIGBIT(signal.SIGTERM) | SIGBIT(signal.SIGINT)) == 0
        assert signal.pthread_sigmask(signal.SIG_BLOCK, set()) == {signal.SIGUSR1}
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, old)

def test_mask_restored_when_popen_raises(box):
    ex = executors.Executors(env=box.env)
    with pytest.raises(OSError):
        ex._run_group(["/nonexistent/spine-oref-binary"])
    assert signal.SIGTERM not in signal.pthread_sigmask(signal.SIG_BLOCK, set())
    assert len(ex._children) == 0

# A SIGTERM that lands right after Popen() returns, before _children.add(): must be held until registered, then kill the child.
RACE = textwrap.dedent('''
    import os, signal, subprocess, sys
    sys.path.insert(0, sys.argv[1]); import executors
    real = subprocess.Popen
    class P(real):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            open(os.environ["PF"], "w").write(str(self.pid))
            os.kill(os.getpid(), signal.SIGTERM)
    executors.subprocess.Popen = P
    ex = executors.Executors(env=dict(os.environ))
    executors.install_signal_handlers(ex)
    ex._run_group([sys.executable, "-c", "import time; time.sleep(30)"])
    print("NOT KILLED", flush=True)
''')

def test_sigterm_between_popen_and_register_never_orphans(box, tmp_path):
    pf = tmp_path / "pid"
    d = subprocess.run([sys.executable, "-c", RACE, os.path.join(TESTS, "..")], env=dict(os.environ, PF=str(pf)), capture_output=True, text=True, timeout=20)
    child = int(pf.read_text())
    try:
        time.sleep(0.1)
        assert d.returncode == 143, d.stderr[-400:]
        assert not _alive(child), "orphan: child alive after the runner exited"
    finally:
        try: os.killpg(child, 9)
        except OSError: pass

# SIGTERM storm while children are spawned back to back (each times out fast): every child ever started is dead after exit.
STORM = textwrap.dedent('''
    import os, sys
    sys.path.insert(0, sys.argv[1]); import executors, subprocess
    ex = executors.Executors(env=dict(os.environ))
    executors.install_signal_handlers(ex)
    print("ready", flush=True)
    code = "import os,time; open(os.environ['PF'],'a').write('%d\\\\n' % os.getpid()); time.sleep(30)"
    while True:
        try: ex._run_group([sys.executable, "-c", code], timeout=0.03)
        except subprocess.TimeoutExpired: pass
''')

@pytest.mark.parametrize("rep", range(10))
def test_sigterm_storm_no_orphan(box, tmp_path, rep):
    pf = tmp_path / "pids"
    drv = subprocess.Popen([sys.executable, "-c", STORM, os.path.join(TESTS, "..")], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    time.sleep(0.4 + 0.07 * rep)
    for _ in range(60):
        try: drv.send_signal(signal.SIGTERM)
        except ProcessLookupError: break
        time.sleep(0.0005)
    rc = drv.wait(timeout=15)
    time.sleep(0.5)
    pids = [int(x) for x in pf.read_text().split()] if pf.exists() else []
    alive = [p for p in pids if _alive(p)]
    for p in alive:
        try: os.kill(p, 9)
        except OSError: pass
    assert len(pids) > 3 and alive == [], f"{len(alive)} orphans of {len(pids)} rc={rc}"
    assert rc in (143, -15), rc   # -15: a later SIGTERM of the storm lands after finalisation restored SIG_DFL

# ---- (2) F1b: budget edge and release semantics
def test_budget_edge_exactly_300s_spawns_and_299_releases(box):
    r = executors.Executors(env=box.env, clock=lambda: at(20, 0)).execute("acoustics", UID)
    assert r.outcome != "release"
    r = executors.Executors(env=box.env, clock=lambda: at(20, 1)).execute("acoustics", UID)
    assert (r.outcome, r.code) == ("release", "budget_too_small")

@pytest.mark.parametrize("stage", ["acoustics", "nemotron"])
def test_whole_window_every_second_is_release_and_spawns_nothing(box, stage):
    ex = executors.Executors(env=box.env, clock=lambda: 0.0)
    for s in range(20 * 60 + 1, 45 * 60, 7):
        ex.clock = lambda s=s: at(0) + s
        r = ex.execute(stage, UID)
        assert r.outcome == "release", s
    assert box.calls() == []

def test_runner_window_refusal_never_reports_transient(box):
    sent = []
    job = {"job_id": 1, "stage": "nemotron", "mode": "live", "encounter_id": "enc_testaaaaaaaaaaaa", "cut_version": "c", "input_key": "k", "attempts": 1, "consult_uid": UID}
    for m, s in [(20, 30), (24, 59), (25, 0), (44, 59)]:
        r = runner.Runner("http://x", "t", "o", live=True, post=lambda p, b: (sent.append(b), (200, {"jobs": [job]} if p.endswith("claim") else {"ok": True}))[1], log=lambda m: None,
                          execs=executors.Executors(env=box.env, clock=lambda m=m, s=s: at(m, s)))
        assert r.run_once() == 0
    outs = [(b["outcome"], b.get("error_code")) for b in sent if "outcome" in b]
    assert outs == [("release", "budget_too_small"), ("release", "budget_too_small"), ("release", "hourly_gap"), ("release", "hourly_gap")]

# ---- (2) box env differs from the server's fixed :20-:45: the box releases what the server hands out (bounce), never a tick
def test_box_env_window_10_30_releases_inside_server_open_time(box):
    env = dict(box.env, SPINE_HOURLY_FROM_MIN="10", SPINE_HOURLY_TO_MIN="30")
    for m, code in [(5, None), (6, "budget_too_small"), (15, "hourly_gap"), (29, "hourly_gap")]:
        r = executors.Executors(env=env, clock=lambda m=m: at(m, 0 if m == 5 else 1)).execute("acoustics", UID)
        assert (r.code if r.outcome == "release" else None) == code, m
    # at :45 the cap is to the next :10 (25 min) -> CHILD_TIMEOUT_S
    assert executors.lane_timeout_s(at(45), 10) == executors.CHILD_TIMEOUT_S

# ---- (4) env window validation
@pytest.mark.parametrize("frm,to,exp", [("10", "30", (10, 30)), ("0", "60", (0, 60)), ("abc", "30", (25, 30)), ("-5", "40", (25, 40)), ("25", "61", (25, 45)),
                                         ("50", "61", (25, 45)), ("46", None, (25, 45)), (None, "20", (25, 45)), ("44", "45", (44, 45)), ("45", "45", (25, 45))])
def test_env_window(frm, to, exp, capsys):
    env = {k: v for k, v in (("SPINE_HOURLY_FROM_MIN", frm), ("SPINE_HOURLY_TO_MIN", to)) if v is not None}
    assert executors._env_window(env) == exp
    err = capsys.readouterr().err
    resolved_f = executors._env_min(frm, 25); resolved_t = executors._env_min(to, 45)
    assert err.count("spine-executors:") == (1 if resolved_f >= resolved_t else 0)

def test_default_env_unchanged():
    assert executors._env_window({}) == (25, 45)
