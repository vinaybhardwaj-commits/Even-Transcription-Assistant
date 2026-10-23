"""Pre-live B (S6 refute): the SIGTERM/SIGINT handler must not do the kill/wait itself, and a second signal must not re-enter it."""
import os, signal, subprocess, sys, textwrap, time
TESTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTS); sys.path.insert(0, os.path.join(TESTS, ".."))
import pytest
import executors  # noqa: F401
from test_executors import _alive  # noqa: F401

# The wrapper around _kill_group records the nesting depth, fires a SECOND signal on first entry (sync, so the re-entry is deterministic), and writes "reaped" only after the real kill returned.
DRIVER = textwrap.dedent('''
    import os, signal, sys
    sys.path.insert(0, sys.argv[1]); import executors
    second, out = int(sys.argv[2]), sys.argv[3]
    ex = executors.Executors(env=dict(os.environ))
    executors.install_signal_handlers(ex)
    real = executors.Executors._kill_group
    st = {"depth": 0, "max": 0, "calls": 0}
    def wrapped(p):
        st["depth"] += 1; st["calls"] += 1; st["max"] = max(st["max"], st["depth"])
        if st["calls"] == 1 and second:
            os.kill(os.getpid(), second)
        try: real(p)
        finally:
            st["depth"] -= 1
            open(out, "a").write("reaped depth_max=%d calls=%d\\n" % (st["max"], st["calls"]))
    executors.Executors._kill_group = staticmethod(wrapped)
    print("ready", flush=True)
    code = "import os,time; open(os.environ['PF'],'w').write(str(os.getpid())); time.sleep(60)"
    ex._run_group([sys.executable, "-c", code])
    print("NOT KILLED", flush=True)
''')


def _go(tmp_path, first, second):
    pf, out = tmp_path / "pid", tmp_path / "out"
    drv = subprocess.Popen([sys.executable, "-c", DRIVER, os.path.join(TESTS, ".."), str(int(second)), str(out)], env=dict(os.environ, PF=str(pf)),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    for _ in range(200):
        if pf.exists() and pf.read_text():
            break
        time.sleep(0.02)
    child = int(pf.read_text())
    drv.send_signal(first)
    rc = drv.wait(timeout=15)
    time.sleep(0.2)
    try:
        return rc, child, out.read_text() if out.exists() else "", drv.stdout.read(), drv.stderr.read()
    finally:
        try: os.killpg(child, 9)
        except OSError: pass


@pytest.mark.parametrize("first,second,want", [(signal.SIGTERM, signal.SIGTERM, 143), (signal.SIGTERM, signal.SIGINT, 143), (signal.SIGINT, signal.SIGTERM, 130), (signal.SIGINT, signal.SIGINT, 130)])
def test_second_signal_does_not_reenter_the_kill_and_the_first_signal_sets_the_exit_code(tmp_path, first, second, want):
    rc, child, out, so, se = _go(tmp_path, first, second)
    assert rc == want, (rc, se[-300:])
    assert "depth_max=1 calls=1" in out and out.count("reaped") == 1, out   # one kill, never nested
    assert "NOT KILLED" not in so
    assert not _alive(child)


def test_single_signal_still_exits_143_with_the_child_reaped_first(tmp_path):
    rc, child, out, so, se = _go(tmp_path, signal.SIGTERM, 0)
    assert rc == 143 and "reaped" in out and not _alive(child)


# R2 B-1: the first Terminated can be swallowed inside a finaliser ("Exception ignored"); the runner must still die on the NEXT signal.
SWALLOW = textwrap.dedent('''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ))
    executors.install_signal_handlers(ex)
    class D:
        def __del__(self): os.kill(os.getpid(), signal.SIGTERM)
    d = D(); del d   # the handler raises Terminated inside __del__: CPython prints it and drops it
    print("survived", flush=True)
    time.sleep(30)
    print("deaf-to-second", flush=True)
''')


@pytest.mark.parametrize("second,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_a_swallowed_first_signal_does_not_make_the_runner_deaf(second, want):
    drv = subprocess.Popen([sys.executable, "-c", SWALLOW, os.path.join(TESTS, "..")], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "survived"
    drv.send_signal(second)
    rc = drv.wait(timeout=15)
    assert rc == want, (rc, drv.stdout.read())
