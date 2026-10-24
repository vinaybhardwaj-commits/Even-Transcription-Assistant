"""(ported, signal state machine) Opus refuter (spine-prelive-r1-oref) adversarial tests for pre-live B. Throwaway; synthetic ids only."""
import os, signal, subprocess, sys, textwrap, time
TESTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTS); sys.path.insert(0, os.path.join(TESTS, ".."))
import pytest
import executors
from test_executors import _alive, box, at, UID  # noqa: F401

# The kill is slowed (0.6 s before the real SIGKILL) and announced, so the parent can land a REAL second signal from outside while the kill runs.
SLOWKILL = textwrap.dedent('''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    out = sys.argv[2]
    ex = executors.Executors(env=dict(os.environ))
    executors.install_signal_handlers(ex)
    real = executors.Executors._kill_group
    n = {"calls": 0}
    def slow(p):
        n["calls"] += 1
        open(out, "a").write("inkill %d\\n" % n["calls"])
        time.sleep(0.6)
        real(p)
        open(out, "a").write("reaped %d\\n" % n["calls"])
    executors.Executors._kill_group = staticmethod(slow)
    print("ready", flush=True)
    code = "import os,subprocess,time; g=subprocess.Popen(['sleep','60']); open(os.environ['PF'],'w').write('%d %d' % (os.getpid(), g.pid)); time.sleep(60)"
    ex._run_group([sys.executable, "-c", code])
    print("NOT KILLED", flush=True)
''')


def _wait_file(p, pred=lambda s: bool(s), n=300):
    for _ in range(n):
        if p.exists() and pred(p.read_text()):
            return p.read_text()
        time.sleep(0.02)
    raise AssertionError(f"timeout waiting for {p}")


@pytest.mark.parametrize("first,second,want", [(signal.SIGTERM, signal.SIGTERM, 143), (signal.SIGTERM, signal.SIGINT, 143), (signal.SIGINT, signal.SIGTERM, 130)])
def test_x1_real_second_signal_during_the_kill_is_not_reentered_child_and_grandchild_die(tmp_path, first, second, want):
    pf, out = tmp_path / "pid", tmp_path / "out"
    drv = subprocess.Popen([sys.executable, "-c", SLOWKILL, os.path.join(TESTS, ".."), str(out)], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    child, grand = map(int, _wait_file(pf).split())
    try:
        drv.send_signal(first)
        _wait_file(out, lambda s: "inkill 1" in s)
        drv.send_signal(second); time.sleep(0.05); drv.send_signal(second)
        rc = drv.wait(timeout=15)
        time.sleep(0.2)
        o = out.read_text()
        assert rc == want, (rc, drv.stderr.read()[-300:])
        assert o.count("inkill") == 1 and "reaped 1" in o, o
        assert "NOT KILLED" not in drv.stdout.read()
        assert not _alive(child) and not _alive(grand)
    finally:
        for p in (child, grand):
            try: os.kill(p, 9)
            except OSError: pass


IDLE = textwrap.dedent('''
    import os, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    executors.install_signal_handlers(executors.Executors(env=dict(os.environ)))
    print("ready", flush=True)
    time.sleep(30)
''')


@pytest.mark.parametrize("sig,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_x2_signal_between_jobs_no_child_exits_promptly(sig, want):
    drv = subprocess.Popen([sys.executable, "-c", IDLE, os.path.join(TESTS, "..")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    drv.send_signal(sig)
    assert drv.wait(timeout=5) == want


LANE_GRAND = textwrap.dedent('''
    import os, subprocess, time
    g = subprocess.Popen(["sleep", "60"])
    open(os.environ["FAKE_PIDFILE"], "w").write("%d %d" % (os.getpid(), g.pid))
    time.sleep(60)
''')
DRV = textwrap.dedent('''
    import os, sys
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ), clock=lambda: float(sys.argv[2]))
    executors.install_signal_handlers(ex)
    print("ready", flush=True)
    ex.execute("acoustics", "uid_test_01")
''')


def test_x3_real_lane_double_sigterm_hourly_lock_held_until_child_and_grandchild_dead(box, tmp_path):
    (box.tmp / "lab" / "kit" / "reb" / "clip_lanes.py").write_text(LANE_GRAND)
    pf = tmp_path / "pids"
    lock = str(box.data / "reb" / "_hourly.lock")
    drv = subprocess.Popen([sys.executable, "-c", DRV, os.path.join(TESTS, ".."), str(at(10))], env=dict(os.environ, FAKE_PIDFILE=str(pf)), stdout=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    child, grand = map(int, _wait_file(pf).split())
    try:
        assert not executors.probe_flock(lock)
        drv.terminate(); time.sleep(0.1); drv.terminate(); drv.send_signal(signal.SIGINT)   # 0.1 s apart: signals pending together are run in signal-number order (INT before TERM) by CPython
        assert drv.wait(timeout=10) == 143
        assert not _alive(child) and not _alive(grand)
        assert executors.probe_flock(lock)
    finally:
        for p in (child, grand):
            try: os.kill(p, 9)
            except OSError: pass


