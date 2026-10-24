"""Signal state machine (spine-sigb): the refuter's Y5-Y9 (F-1, F-2, F-3, storm) and X4 (swallowed first signal) as permanent cases. Synthetic ids only."""
import os, signal, subprocess, sys, textwrap, time
TESTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTS); sys.path.insert(0, os.path.join(TESTS, ".."))
import pytest
import executors
from test_executors import _alive  # noqa: F401
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


# Y5: the WINDOW between the first Terminated leaving communicate and _reap's `reaping += 1`. Widened here (sleep at _reap entry, before the real _reap) so a 2nd signal lands in it.
# Spec: "no re-entry; no orphans". On R1 (first-wins) the 2nd is ignored; with the R2 counter the 2nd raises before reaping is set and the kill is skipped.
WINDOW = textwrap.dedent('''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    out = sys.argv[3]
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    real = getattr(executors.Executors, "_reap", None) or (lambda self, p: executors.Executors._kill_group(p))
    def gap(self, p):
        open(out, "a").write("gap\\n"); time.sleep(0.6)
        real(self, p); open(out, "a").write("reaped\\n")
    executors.Executors._reap = gap
    if not hasattr(executors.Executors, "kill_children_uses_reap"):
        pass
    # R1 code has no _reap: route its except-path kill through the same gap so the window is identical
    if "self._reap(" not in open(executors.__file__).read():
        rk = executors.Executors._kill_group
        executors.Executors._kill_group = staticmethod(lambda p: (open(out, "a").write("gap\\n"), time.sleep(0.6), rk(p), open(out, "a").write("reaped\\n")))
    print("ready", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]])
    print("NOT KILLED", flush=True)
''')


@pytest.mark.parametrize("first,second", [(signal.SIGTERM, signal.SIGTERM), (signal.SIGTERM, signal.SIGINT)])
def test_y5_FINDING_window_second_signal_before_reaping_is_set_must_not_skip_the_kill(tmp_path, first, second):
    pf, out = tmp_path / "pf", tmp_path / "out"
    drv = subprocess.Popen([sys.executable, "-c", WINDOW, PKG, CHILD, str(out)], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    child, grand = map(int, _wait_file(pf).split())
    try:
        drv.send_signal(first)
        _wait_file(out, lambda s: "gap" in s)
        drv.send_signal(second)
        rc = drv.wait(timeout=10)
        time.sleep(0.2)
        facts = dict(rc=rc, reaped="reaped" in out.read_text(), child_alive=_alive(child), grand_alive=_alive(grand))
        print("Y5", facts)
        assert facts == dict(rc=143, reaped=True, child_alive=False, grand_alive=False), facts
    finally:
        _cleanup(child, grand)


# Y6: realistic storm, no widening: TERM and INT sent back-to-back (pending together) while a child with a grandchild runs; count orphans and hangs.
STORM = textwrap.dedent('''
    import os, sys
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    print("ready", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]])
''')


def test_y6_storm_back_to_back_term_int_no_orphan_no_hang(tmp_path):
    bad = []
    for i in range(int(os.environ.get("Y6_N", "60"))):
        pf = tmp_path / f"pf{i}"
        drv = subprocess.Popen([sys.executable, "-c", STORM, PKG, CHILD], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        assert drv.stdout.readline().strip() == "ready"
        child, grand = map(int, _wait_file(pf).split())
        os.kill(drv.pid, signal.SIGTERM); os.kill(drv.pid, signal.SIGINT); os.kill(drv.pid, signal.SIGTERM)
        try:
            rc = drv.wait(timeout=10)
        except subprocess.TimeoutExpired:
            drv.kill(); rc = "hang"
        time.sleep(0.05)
        if rc not in (130, 143) or _alive(child) or _alive(grand):
            bad.append((i, rc, _alive(child), _alive(grand)))
        _cleanup(child, grand)
    print("Y6 bad", len(bad), "of", os.environ.get("Y6_N", "60"), bad[:5])
    assert not bad, bad


# Y7: after a TIMEOUT reap, the runner must still hear the next signal (reaping is back to 0).
AFTER_TIMEOUT = textwrap.dedent('''
    import os, sys, time, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    try: ex._run_group([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.3)
    except subprocess.TimeoutExpired: print("timed out", ex.reaping, flush=True)
    time.sleep(10)
    print("DEAF", flush=True)
''')


@pytest.mark.parametrize("sig,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_y7_signal_after_a_timeout_reap_is_heard(sig, want):
    drv = subprocess.Popen([sys.executable, "-c", AFTER_TIMEOUT, PKG], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "timed out 0"
    drv.send_signal(sig)
    assert drv.wait(timeout=5) == want


# Y8: a signal DURING a timeout kill is not re-entered: one kill, exit 143, child dead.
TIMEOUT_KILL = textwrap.dedent('''
    import os, sys, time, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    out = sys.argv[3]
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    real = executors.Executors._kill_group
    st = {"n": 0}
    def slow(p):
        st["n"] += 1; st.setdefault("d", 0); st["d"] += 1; open(out, "a").write("inkill %d depth %d\\n" % (st["n"], st["d"])); time.sleep(0.6); real(p); st["d"] -= 1
    executors.Executors._kill_group = staticmethod(slow)
    print("ready", flush=True)
    try: ex._run_group([sys.executable, "-c", sys.argv[2]], timeout=0.5)
    except subprocess.TimeoutExpired: print("timed out", flush=True)
    time.sleep(10)
''')


def test_y8_signal_during_a_timeout_kill_is_not_reentered(tmp_path):
    pf, out = tmp_path / "pf", tmp_path / "out"
    drv = subprocess.Popen([sys.executable, "-c", TIMEOUT_KILL, PKG, CHILD, str(out)], env=dict(os.environ, PF=str(pf)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    child, grand = map(int, _wait_file(pf).split())
    try:
        _wait_file(out, lambda s: "inkill 1" in s)
        drv.send_signal(signal.SIGTERM)
        try: rc = drv.wait(timeout=15)
        except subprocess.TimeoutExpired: drv.kill(); rc = 'alive'
        assert "depth 2" not in out.read_text(), out.read_text()   # never nested
        assert not _alive(child) and not _alive(grand)
        assert rc == 143, f"FINDING: the first SIGTERM landed during a timeout reap and was dropped (rc {rc}); the runner stays up"
    finally:
        _cleanup(child, grand)


# Y9 FINDING (LOW, from 96c44347): a plain timeout (no signal) kills the group TWICE: inner except TimeoutExpired reaps, re-raises, and the outer except BaseException reaps again (killpg on a reaped pid). main: once.
ONE_TIMEOUT = textwrap.dedent('''
    import os, sys, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ))
    real = executors.Executors._kill_group; n = []
    executors.Executors._kill_group = staticmethod(lambda p: (n.append(1), real(p)))
    try: ex._run_group([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.3)
    except subprocess.TimeoutExpired: print("kills", len(n), flush=True)
''')


def test_y9_FINDING_a_timeout_kills_the_group_once():
    out = subprocess.run([sys.executable, "-c", ONE_TIMEOUT, PKG], capture_output=True, text=True, timeout=20).stdout.strip()
    assert out == "kills 1", out


SWALLOW = textwrap.dedent('''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    executors.install_signal_handlers(executors.Executors(env=dict(os.environ)))
    class D:
        def __del__(self):
            os.kill(os.getpid(), signal.SIGTERM)   # the first SIGTERM lands while a finaliser runs: Python prints "Exception ignored" and drops the raise
            x = 0
            for i in range(1000): x += i
    D()
    print("ready", flush=True)
    time.sleep(10)
''')


def test_x4_FINDING_a_first_signal_swallowed_by_a_finaliser_must_not_make_the_runner_deaf():
    drv = subprocess.Popen([sys.executable, "-c", SWALLOW, PKG], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    drv.send_signal(signal.SIGTERM)
    try:
        assert drv.wait(timeout=3) == 143, "second SIGTERM ignored"
    except subprocess.TimeoutExpired:
        drv.kill(); drv.wait()
        raise AssertionError("runner is deaf: the 2nd SIGTERM was ignored after the 1st was swallowed")
