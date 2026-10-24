"""(ported, signal state machine) Opus refuter (spine-prelive-r2-oref) adversarial tests for R2 B-1. Throwaway, lives in .bc/ only. Synthetic ids only."""
import os, signal, subprocess, sys, textwrap, time
TESTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTS); sys.path.insert(0, os.path.join(TESTS, ".."))
import pytest
import executors
from test_executors import _alive, box, at  # noqa: F401
PKG = os.path.join(TESTS, "..")
CHILD = "import os,subprocess,time; g=subprocess.Popen(['sleep','60']); open(os.environ['PF'],'w').write('%d %d' % (os.getpid(), g.pid)); time.sleep(60)"


def _wait_file(p, pred=lambda s: bool(s.strip()), n=400):
    for _ in range(n):
        if p.exists() and pred(p.read_text()):
            return p.read_text()
        time.sleep(0.02)
    raise AssertionError(f"timeout waiting for {p}")


def _cleanup(*pids):
    for p in pids:
        try: os.kill(p, 9)
        except OSError: pass


# Y1 (R3: changed from "swallowed first, then a SECOND signal"): a stop swallowed while idle is no longer forgotten, so a child started afterwards is killed and reaped at its first poll and the
# runner exits 143/130 with NO second signal. (Old semantics: _run_group reset the swallowed stop at entry and needed another signal.)
SWALLOW_THEN_RUN = textwrap.dedent('''
    import os, signal, sys
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    class D:
        def __del__(self): os.kill(os.getpid(), sys.argv[3] and int(sys.argv[3]))
    D()
    print("survived", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]])
    print("NOT KILLED", flush=True)
''')


@pytest.mark.parametrize("sig,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_y1_swallowed_stop_is_kept_and_kills_the_next_child(tmp_path, sig, want):
    pf = tmp_path / "pf"
    drv = subprocess.Popen([sys.executable, "-c", SWALLOW_THEN_RUN, PKG, CHILD, str(int(sig))], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "survived"
    assert drv.wait(timeout=10) == want
    time.sleep(0.2)
    if pf.exists() and pf.read_text().strip():
        child, grand = map(int, pf.read_text().split())
        try:
            assert not _alive(child) and not _alive(grand)
        finally:
            _cleanup(child, grand)
    assert "NOT KILLED" not in drv.stdout.read()


# Y2: signal lands while SIGTERM/SIGINT are blocked across spawn+register (between "claim" and the child being registered): it is delivered at unblock, the child is killed and reaped.
SPAWN_WINDOW = textwrap.dedent('''
    import os, signal, sys, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    sig = int(sys.argv[3]); real = subprocess.Popen
    class P(real):
        def __init__(self, *a, **k):
            os.kill(os.getpid(), sig)            # pending (blocked) while the child is being created
            super().__init__(*a, **k)
            import time; time.sleep(0.3)         # the child writes its pid file meanwhile
    executors.subprocess.Popen = P
    print("ready", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]])
    print("NOT KILLED", flush=True)
''')


@pytest.mark.parametrize("sig,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_y2_signal_between_claim_and_spawn_is_deferred_to_registration_then_kills(tmp_path, sig, want):
    pf = tmp_path / "pf"
    drv = subprocess.Popen([sys.executable, "-c", SPAWN_WINDOW, PKG, CHILD, str(int(sig))], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    rc = drv.wait(timeout=10)
    time.sleep(0.3)
    pids = list(map(int, _wait_file(pf).split()))
    try:
        assert rc == want, (rc, drv.stderr.read()[-300:])
        assert not any(_alive(p) for p in pids), pids
    finally:
        _cleanup(*pids)


# Y3: signal during the reap's WAIT (SIGKILL already sent, p.communicate draining): ignored, one kill, exit from the first signal.
SLOW_WAIT = textwrap.dedent('''
    import os, signal, sys, time, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    out = sys.argv[3]
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    real_comm = subprocess.Popen.communicate
    st = {"n": 0}
    def comm(self, *a, **k):
        if k.get("timeout") is None and not a:      # the reap's communicate (the run's has a timeout kwarg)
            st["n"] += 1
            open(out, "a").write("inwait %d\\n" % st["n"]); time.sleep(0.6)
        return real_comm(self, *a, **k)
    subprocess.Popen.communicate = comm
    print("ready", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]], timeout=120)
    print("NOT KILLED", flush=True)
''')


@pytest.mark.parametrize("first,second,want", [(signal.SIGTERM, signal.SIGINT, 143), (signal.SIGINT, signal.SIGTERM, 130)])
def test_y3_second_signal_during_the_reap_wait_is_ignored(tmp_path, first, second, want):
    pf, out = tmp_path / "pf", tmp_path / "out"
    drv = subprocess.Popen([sys.executable, "-c", SLOW_WAIT, PKG, CHILD, str(out)], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    child, grand = map(int, _wait_file(pf).split())
    try:
        drv.send_signal(first)
        _wait_file(out, lambda s: "inwait 1" in s)
        drv.send_signal(second); time.sleep(0.05); drv.send_signal(second)
        rc = drv.wait(timeout=10)
        assert rc == want, (rc, drv.stderr.read()[-300:])
        assert out.read_text().count("inwait") == 1
        time.sleep(0.2)
        assert not _alive(child) and not _alive(grand)
    finally:
        _cleanup(child, grand)


# Y4: signal AFTER the child exited (the run returned): exits promptly 143/130 and the runner does not go on to spawn again.
AFTER_EXIT = textwrap.dedent('''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    r = ex._run_group([sys.executable, "-c", "print('ok')"])
    print("ran", r.returncode, flush=True)
    time.sleep(10)
    ex._run_group([sys.executable, "-c", "print('second')"])
    print("SPAWNED AGAIN", flush=True)
''')


@pytest.mark.parametrize("sig,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_y4_signal_after_child_exit_exits_and_spawns_nothing(sig, want):
    drv = subprocess.Popen([sys.executable, "-c", AFTER_EXIT, PKG], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ran 0"
    drv.send_signal(sig)
    assert drv.wait(timeout=5) == want
    assert "SPAWNED AGAIN" not in drv.stdout.read()


