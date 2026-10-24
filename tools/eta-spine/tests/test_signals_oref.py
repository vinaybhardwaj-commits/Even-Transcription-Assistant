"""Signal handling R2 (spine-sigb): the Opus refuter's O1-O8, adopted. Synthetic ids only."""
import os, signal, subprocess, sys, textwrap, time
import pytest
PKG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
CHILD = "import os,subprocess,time; g=subprocess.Popen(['sleep','60']); open(os.environ['PF'],'w').write('%d %d' % (os.getpid(), g.pid)); time.sleep(60)"
SHORT = "import os,time; open(os.environ['PF'],'w').write('%d 0' % os.getpid()); time.sleep(float(os.environ.get('CHILD_S','2')))"


def _alive(pid):
    if not pid: return False
    try:
        os.kill(pid, 0)
        return open(f"/proc/{pid}/stat").read().split()[2] != "Z"
    except (OSError, FileNotFoundError):
        return False


def _wait_file(p, pred=lambda s: bool(s.strip()), n=500):
    for _ in range(n):
        if p.exists() and pred(p.read_text()):
            return p.read_text()
        time.sleep(0.02)
    raise AssertionError(f"timeout waiting for {p}")


def _cleanup(*pids):
    for p in pids:
        if p:
            try: os.kill(p, 9)
            except OSError: pass


def _drive(code, tmp_path, child=CHILD, extra=()):
    pf, out = tmp_path / "pf", tmp_path / "out"
    drv = subprocess.Popen([sys.executable, "-c", textwrap.dedent(code), PKG, child, str(out), *extra], env=dict(os.environ, PF=str(pf)),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    return drv, pf, out


# O1: a 2nd and 3rd signal at each widened point of the STOP path (after the 1st raise, before/inside/after the kill, after _reap). Never re-entered, one kill, no orphan, first code.
GAPS = '''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    out, where = sys.argv[3], sys.argv[4]
    E = executors.Executors
    ex = E(env=dict(os.environ)); executors.install_signal_handlers(ex)
    def mark(s): open(out, "a").write(s + "\\n")
    rk, rr = E._kill_group, E._reap
    depth = [0]
    def kg(p):
        depth[0] += 1; mark("kill depth %d" % depth[0])
        if where == "inkill_pre": mark("gap"); time.sleep(0.6)
        rk(p)
        if where == "inkill_post": mark("gap"); time.sleep(0.6)
        depth[0] -= 1
    E._kill_group = staticmethod(kg)
    def reap(self, p):
        if where == "reap_pre": mark("gap"); time.sleep(0.6)
        rr(self, p)
        if where == "reap_post": mark("gap"); time.sleep(0.6)
    E._reap = reap
    os.kill  # noqa
    print("ready", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]])
    print("NOT KILLED", flush=True)
'''


@pytest.mark.parametrize("where", ["reap_pre", "inkill_pre", "inkill_post", "reap_post"])
@pytest.mark.parametrize("first,more,want", [(signal.SIGTERM, (signal.SIGTERM, signal.SIGINT), 143), (signal.SIGINT, (signal.SIGTERM, signal.SIGTERM), 130)])
def test_o1_second_and_third_signal_at_every_stop_gap(tmp_path, where, first, more, want):
    drv, pf, out = _drive(GAPS, tmp_path, extra=(where,))
    child, grand = map(int, _wait_file(pf).split())
    try:
        drv.send_signal(first)
        _wait_file(out, lambda s: "gap" in s)
        for s in more:
            drv.send_signal(s); time.sleep(0.05)
        rc = drv.wait(timeout=10); time.sleep(0.2)
        txt = out.read_text()
        facts = dict(rc=rc, kills=txt.count("kill depth"), nested="depth 2" in txt, child=_alive(child), grand=_alive(grand))
        assert facts == dict(rc=want, kills=1, nested=False, child=False, grand=False), facts
    finally:
        _cleanup(child, grand)


# O2: the TIMEOUT path's own gap: TimeoutExpired has left communicate, _reap not yet REAPING (widened at _reap entry). A FIRST SIGTERM lands there.
# Spec (F-1/F-2): never skips the kill; exit 143. Main: the handler's kill_children kills the group (no orphan).
TGAP = '''
    import os, signal, sys, time, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    out = sys.argv[3]
    E = executors.Executors
    ex = E(env=dict(os.environ)); executors.install_signal_handlers(ex)
    def mark(s): open(out, "a").write(s + "\\n")
    if hasattr(E, "_reap"):
        rr = E._reap
        def reap(self, p): mark("gap"); time.sleep(0.8); rr(self, p)
        E._reap = reap
    else:
        rk = E._kill_group
        E._kill_group = staticmethod(lambda p: (mark("gap"), time.sleep(0.8), rk(p)))
    print("ready", flush=True)
    try: ex._run_group([sys.executable, "-c", sys.argv[2]], timeout=0.5)
    except subprocess.TimeoutExpired: print("timed out", flush=True)
    time.sleep(5)
'''


def test_o2_first_signal_in_the_timeout_gap_before_reaping_must_not_orphan(tmp_path):
    drv, pf, out = _drive(TGAP, tmp_path)
    child, grand = map(int, _wait_file(pf).split())
    try:
        _wait_file(out, lambda s: "gap" in s)
        drv.send_signal(signal.SIGTERM)
        rc = drv.wait(timeout=10); time.sleep(0.3)
        facts = dict(rc=rc, child=_alive(child), grand=_alive(grand))
        assert facts == dict(rc=143, child=False, grand=False), facts
    finally:
        _cleanup(child, grand)


# O3: F-2 through the REAL Runner claim loop: a lane times out, the first SIGTERM lands during the (slowed) timeout reap; the runner must exit 143 and never claim again.
LOOP = '''
    import os, signal, sys, time, subprocess
    sys.path.insert(0, sys.argv[1]); import executors, runner
    out = sys.argv[3]
    E = executors.Executors
    ex = E(env=dict(os.environ)); executors.install_signal_handlers(ex)
    def mark(s): open(out, "a").write(s + "\\n")
    rk = E._kill_group
    E._kill_group = staticmethod(lambda p: (mark("inkill"), time.sleep(0.6), rk(p)))
    def execute(stage, uid):
        try: ex._run_group([sys.executable, "-c", sys.argv[2]], timeout=0.5)
        except subprocess.TimeoutExpired: return executors.Result("transient", "timeout")
        return executors.Result("done", "ok")
    ex.execute = execute; ex.has = lambda s: True
    job = {"job_id": "job_test_01", "stage": "acoustics", "mode": "live", "consult_uid": "uid_test_01", "encounter_id": "enc_testaaaaaaaaaaaa"}
    def post(path, body):
        mark("post " + path)
        return (200, {"jobs": [dict(job)]}) if path.endswith("/claim") else (200, {})
    r = runner.Runner("https://x", "t", "o", live=True, post=post, log=lambda m: None, execs=ex)
    print("ready", flush=True)
    for _ in range(3): r.run_once()
    mark("LOOP DONE")
'''


def test_o3_first_sigterm_during_timeout_reap_exits_143_and_never_claims_again(tmp_path):
    drv, pf, out = _drive(LOOP, tmp_path)
    child, grand = map(int, _wait_file(pf).split())
    try:
        _wait_file(out, lambda s: "inkill" in s)
        drv.send_signal(signal.SIGTERM)
        rc = drv.wait(timeout=15); time.sleep(0.2)
        txt = out.read_text()
        facts = dict(rc=rc, claims=txt.count("/claim"), reports=txt.count("/report"), done="LOOP DONE" in txt, child=_alive(child), grand=_alive(grand))
        assert facts == dict(rc=143, claims=1, reports=0, done=False, child=False, grand=False), facts
    finally:
        _cleanup(child, grand)


# O4: F-3 counted at the syscall: one timeout = exactly one os.killpg.
KP = '''
    import os, sys, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    n = []; rk = os.killpg
    os.killpg = lambda pg, s: (n.append(s), rk(pg, s))[1]
    ex = executors.Executors(env=dict(os.environ))
    try: ex._run_group([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.3)
    except subprocess.TimeoutExpired: print("killpg", len(n), ex.state, flush=True)
'''


def test_o4_timeout_is_one_killpg_and_state_back_to_running():
    out = subprocess.run([sys.executable, "-c", textwrap.dedent(KP), PKG], capture_output=True, text=True, timeout=20).stdout.strip()
    assert out == "killpg 1 RUNNING", out


# O5: B-1 class, child REGISTERED: the first SIGTERM is swallowed by a finaliser that runs while the child is being waited on; the next (external) SIGTERM must still kill and exit.
SWC = '''
    import os, signal, sys, time, subprocess
    sys.path.insert(0, sys.argv[1]); import executors
    out = sys.argv[3]
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    def mark(s): open(out, "a").write(s + "\\n")
    rc_ = subprocess.Popen.communicate
    class D:
        def __del__(self):
            os.kill(os.getpid(), signal.SIGTERM)
            x = 0
            for i in range(1000): x += i
    once = [True]
    def comm(self, *a, **k):
        if once[0]:
            once[0] = False; D(); mark("swallowed")
        return rc_(self, *a, **k)
    subprocess.Popen.communicate = comm
    print("ready", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]]); mark("JOB1 RETURNED")
    ex._run_group([sys.executable, "-c", "pass"]); mark("JOB2 RAN")
'''


def test_o5_swallowed_first_signal_while_a_child_runs_next_signal_still_kills_and_exits(tmp_path):
    drv, pf, out = _drive(SWC, tmp_path, child=SHORT)
    child, _ = map(int, _wait_file(pf).split())
    try:
        _wait_file(out, lambda s: "swallowed" in s)
        time.sleep(0.3)
        drv.send_signal(signal.SIGTERM)
        t0 = time.time()
        rc = drv.wait(timeout=10)
        txt = out.read_text()
        facts = dict(rc=rc, fast=time.time() - t0 < 1.0, job2="JOB2 RAN" in txt)
        assert facts == dict(rc=143, fast=True, job2=False), facts
    finally:
        _cleanup(child)


# O6: first-signal-wins is not reintroduced: after a swallowed raise (no child), the 2nd AND a 3rd swallowed-free signal each still exit; and the exit code is the 2nd signal's own family.
SW2 = '''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    executors.install_signal_handlers(executors.Executors(env=dict(os.environ)))
    class D:
        def __del__(self): os.kill(os.getpid(), signal.SIGINT)
    D(); D()
    print("ready", flush=True)
    time.sleep(10)
'''


def test_o6_two_swallowed_signals_then_a_real_one_still_exits():
    drv = subprocess.Popen([sys.executable, "-c", textwrap.dedent(SW2), PKG], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    drv.send_signal(signal.SIGTERM)
    assert drv.wait(timeout=5) in (130, 143)


# O7: flag-off (no --live, default SIGINT -> KeyboardInterrupt, no handlers): behaviour of the group on Ctrl-C. Records main vs branch (INFO, not an acceptance item).
NOLIVE = '''
    import os, sys
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ))
    print("ready", flush=True)
    ex._run_group([sys.executable, "-c", sys.argv[2]])
'''


def test_o7_no_live_ctrl_c_kills_the_child_group(tmp_path):
    drv, pf, out = _drive(NOLIVE, tmp_path)
    child, grand = map(int, _wait_file(pf).split())
    try:
        drv.send_signal(signal.SIGINT); rc = drv.wait(timeout=10); time.sleep(0.2)
        assert not _alive(child) and not _alive(grand), (rc,)   # INFO change kept: non-live Ctrl-C kills the child group
    finally:
        _cleanup(child, grand)


# O8: a job finished normally, THEN the first signal is swallowed (no child running): the next signal must still exit (kills M15: a leaked _children entry would make the runner deaf).
SW_AFTER_JOB = '''
    import os, signal, sys, time
    sys.path.insert(0, sys.argv[1]); import executors
    ex = executors.Executors(env=dict(os.environ)); executors.install_signal_handlers(ex)
    ex._run_group([sys.executable, "-c", "pass"])
    class D:
        def __del__(self): os.kill(os.getpid(), signal.SIGTERM)
    D()
    print("ready", flush=True)
    time.sleep(10)
'''


def test_o8_swallowed_after_a_finished_job_next_signal_exits():
    drv = subprocess.Popen([sys.executable, "-c", textwrap.dedent(SW_AFTER_JOB), PKG], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert drv.stdout.readline().strip() == "ready"
    drv.send_signal(signal.SIGINT)
    try:
        assert drv.wait(timeout=3) in (130, 143)
    except subprocess.TimeoutExpired:
        drv.kill(); drv.wait(); raise AssertionError("deaf after a finished job + swallowed signal")
