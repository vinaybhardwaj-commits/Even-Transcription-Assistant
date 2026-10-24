"""spine-sigb-r2-oref: Opus refuter tests P1-P10 for the record-only handler + poll loop (d39d7fac). Throwaway, .bc/ only. Synthetic, no data.
Adopted unchanged in what they assert; PKG is the repo copy."""
import glob, os, signal, subprocess, sys, textwrap, time, uuid
import pytest
PKG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, PKG)
import executors  # noqa: E402

HEAD = '''
    import os, signal, subprocess, sys, threading, time
    sys.path.insert(0, sys.argv[1]); import executors
    E = executors.Executors; ex = E(env=dict(os.environ)); out = sys.argv[2]
    def mark(s): open(out, "a").write(s + "\\n")
    kills = [0]; okp = os.killpg
    def kp(pid, sig): kills[0] += 1; mark("killpg"); okp(pid, sig)
    executors.os.killpg = kp
    if os.environ.get("LIVE", "1") == "1" and not hasattr(ex, "on_signal"): executors.install_signal_handlers(ex)
    elif os.environ.get("LIVE", "1") == "1":
        executors.install_signal_handlers(ex)
        o = ex.on_signal
        def inst(s):
            n = len(ex._children)
            try: o(s)
            except BaseException:
                mark("raised children=%d" % n); raise
            mark("recorded children=%d" % n)
        ex.on_signal = inst
    LONG = ["sh", "-c", "sleep 30 & exec sleep 31"]
'''


def _tagged(tag):
    out = []
    for e in glob.glob("/proc/[0-9]*/environ"):
        try:
            if ("SIGBTAG=" + tag).encode() in open(e, "rb").read().split(b"\0"):
                pid = int(e.split("/")[2])
                if open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0] != "Z":
                    out.append(pid)
        except OSError:
            pass
    return out


def _run(body, tmp_path, send=None, wait=10, live=True):
    tag, out = uuid.uuid4().hex, tmp_path / "out"
    out.write_text("")
    p = subprocess.Popen([sys.executable, "-c", textwrap.dedent(HEAD) + textwrap.dedent(body), PKG, str(out)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         env=dict(os.environ, SIGBTAG=tag, LIVE="1" if live else "0"))
    assert p.stdout.readline().strip() == "go"
    t0 = time.monotonic()
    for d, s in (send or ()):
        time.sleep(d); p.send_signal(s)
    try:
        rc = p.wait(timeout=wait)
    except subprocess.TimeoutExpired:
        p.kill(); rc = "HANG"
    el = time.monotonic() - t0
    time.sleep(0.2)
    orph = _tagged(tag)
    for q in orph:
        os.kill(q, 9)
    return dict(rc=rc, el=el, orphans=len(orph), log=out.read_text(), stdout=p.stdout.read())


# P1 F-C forced: a signal delivered to a NON-main thread never interrupts the main thread's select; the poll slice must still bound the stop (target <= 1 s).
def test_p1_signal_outside_the_blocking_call_is_bounded_by_the_slice(tmp_path):
    r = _run('''
        def t(): time.sleep(0.3); mark("sent %r" % time.monotonic()); signal.pthread_kill(threading.get_ident(), signal.SIGTERM); time.sleep(60)
        threading.Thread(target=t, daemon=True).start()
        print("go", flush=True); ex._run_group(LONG, timeout=60); print("RETURNED", flush=True)
    ''', tmp_path, wait=8)
    assert (r["rc"], r["orphans"], r["log"].count("killpg")) == (143, 0, 1), r
    assert r["el"] < 0.3 + 1.0, r


# P2 F-A widened: the FINAL slice's TimeoutExpired has left communicate; a FIRST SIGTERM lands there and the gap is held open 0.3 s. One kill, 143, no orphan.
def test_p2_first_signal_in_the_widened_timeout_gap(tmp_path):
    r = _run('''
        oc = subprocess.Popen.communicate
        def comm(self, *a, **k):
            try: return oc(self, *a, **k)
            except subprocess.TimeoutExpired:
                if k.get("timeout") is not None: os.kill(os.getpid(), signal.SIGTERM); time.sleep(0.3)
                raise
        subprocess.Popen.communicate = comm
        print("go", flush=True)
        try: ex._run_group(LONG, timeout=0.3)
        except subprocess.TimeoutExpired: mark("TIMEOUT_ESCAPED")
        time.sleep(3); print("LOST", flush=True)
    ''', tmp_path)
    assert (r["rc"], r["orphans"], r["log"].count("killpg"), "raised children=1" in r["log"], "TIMEOUT_ESCAPED" in r["log"]) == (143, 0, 1, False, False), r


# P3 F-2: a FIRST signal during the timeout reap (inside _kill_group, after killpg) is honoured right after it: 143, one kill, no TimeoutExpired out.
def test_p3_first_signal_during_timeout_reap(tmp_path):
    r = _run('''
        rk = E._kill_group
        def kg(p): rk(p); os.kill(os.getpid(), signal.SIGTERM); time.sleep(0.2)
        E._kill_group = staticmethod(kg)
        print("go", flush=True)
        try: ex._run_group(LONG, timeout=0.6)
        except subprocess.TimeoutExpired: mark("TIMEOUT_ESCAPED")
        time.sleep(3)
    ''', tmp_path)
    assert (r["rc"], r["orphans"], r["log"].count("killpg"), "TIMEOUT_ESCAPED" in r["log"]) == (143, 0, 1, False), r


# P4 instrumentation: TERM, INT, TERM while a child is registered: never raised with a child, all three recorded, FIRST code, one kill.
@pytest.mark.parametrize("first,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_p4_handler_never_raises_with_a_child(tmp_path, first, want):
    other = signal.SIGINT if first == signal.SIGTERM else signal.SIGTERM
    r = _run('print("go", flush=True); ex._run_group(LONG, timeout=60)\n', tmp_path, send=[(0.2, first), (0.05, other), (0.05, first)])
    assert (r["rc"], r["orphans"], r["log"].count("killpg"), r["log"].count("recorded children=1"), "raised children=1" in r["log"]) == (want, 0, 1, 3, False), r


# P5 a stop landing as communicate returns a finished child's result (child still registered): not lost, 143, the job result is not returned.
def test_p5_signal_as_the_result_arrives_is_not_lost(tmp_path):
    r = _run('''
        oc = subprocess.Popen.communicate
        def comm(self, *a, **k):
            res = oc(self, *a, **k)
            if k.get("timeout") is not None: os.kill(os.getpid(), signal.SIGTERM)
            return res
        subprocess.Popen.communicate = comm
        print("go", flush=True); ex._run_group(["true"], timeout=60); print("RETURNED", flush=True); time.sleep(3)
    ''', tmp_path)
    assert (r["rc"], "RETURNED" in r["stdout"]) == (143, False), r


# P6 idle runner (no child): a signal stops it promptly, as main does.
@pytest.mark.parametrize("sig,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_p6_idle_runner_stops_promptly(tmp_path, sig, want):
    r = _run('print("go", flush=True)\nwhile True: time.sleep(0.05)\n', tmp_path, send=[(0.2, sig)])
    assert r["rc"] == want and r["el"] < 0.2 + 0.3, r


# P7 timeout accuracy with slicing: TimeoutExpired within [timeout, timeout+0.3], exactly one kill, group dead, state back to RUNNING.
@pytest.mark.parametrize("tmo", [0.3, 0.7, 1.2])
def test_p7_timeout_is_on_time_and_kills_once(tmp_path, tmo):
    r = _run(f'''
        print("go", flush=True); t = time.monotonic()
        try: ex._run_group(LONG, timeout={tmo})
        except subprocess.TimeoutExpired: mark("timeout %r %s" % (time.monotonic() - t, ex.state))
    ''', tmp_path)
    line = [x for x in r["log"].splitlines() if x.startswith("timeout")]
    assert line and r["rc"] == 0 and r["orphans"] == 0 and r["log"].count("killpg") == 1, r
    el, st = float(line[0].split()[1]), line[0].split()[2]
    assert tmo <= el <= tmo + 0.3 and st == "RUNNING", r


# P8 flag-off (no --live): the child exits but its grandchild keeps the pipe open; Ctrl-C (KeyboardInterrupt out of communicate) must still kill the group (the INFO change).
def test_p8_no_live_ctrl_c_with_only_the_grandchild_left(tmp_path):
    r = _run('''
        print("go", flush=True)
        ex._run_group(["sh", "-c", "sleep 30 & exit 0"], timeout=60)
    ''', tmp_path, send=[(0.5, signal.SIGINT)], live=False)
    assert r["rc"] in (-2, 130) and r["orphans"] == 0, r


# P9 a timeout that also sees a recorded stop raises the stop, never TimeoutExpired (lane would report "timeout" and claim again).
def test_p9_stop_recorded_on_the_last_slice_beats_the_timeout(tmp_path):
    r = _run('''
        print("go", flush=True)
        try: ex._run_group(LONG, timeout=0.5)
        except subprocess.TimeoutExpired: mark("TIMEOUT_ESCAPED")
        time.sleep(3)
    ''', tmp_path, send=[(0.45, signal.SIGTERM)])
    assert (r["rc"], r["orphans"], "TIMEOUT_ESCAPED" in r["log"], r["log"].count("killpg")) == (143, 0, False, 1), r


# P10 unit: on_signal with a child registered records (first kept, all counted) and returns; with none it raises 128+FIRST.
def test_p10_on_signal_unit():
    ex = executors.Executors(env={})
    ex._children.add(object())
    assert ex.on_signal(signal.SIGINT) is None and ex.on_signal(signal.SIGTERM) is None
    assert (ex.stop_signum, ex.signals_seen) == (signal.SIGINT, 2)
    ex._children.clear()
    with pytest.raises(SystemExit) as e:
        ex.on_signal(signal.SIGTERM)
    assert e.value.code == 130


# P11 the last window: a stop recorded while the finished child is still registered, right at its unregister, is still raised (143), never lost (rc 0).
def test_p11_signal_at_the_unregister_is_not_lost(tmp_path):
    r = _run('''
        class S(set):
            def discard(self, x):
                if x in self: os.kill(os.getpid(), signal.SIGTERM); time.sleep(0.01)
                set.discard(self, x)
        ex._children = S()
        print("go", flush=True); ex._run_group(["true"], timeout=60); print("RETURNED", flush=True); time.sleep(3)
    ''', tmp_path)
    assert (r["rc"], "RETURNED" in r["stdout"], "recorded children=1" in r["log"]) == (143, False, True), r
