"""spine-sigb-r3-oref: Opus refuter tests Q1-Q9 for F-E and F-B' (b0c307e6). Throwaway, .bc/ only. Synthetic, no data. Copy into tools/eta-spine/tests to run."""
import os, signal, subprocess, sys, time, uuid
import pytest
TESTS = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, TESTS); sys.path.insert(0, os.path.join(TESTS, ".."))
import executors, runner  # noqa: E402
from test_signals_oref_r2 import _run, _tagged  # noqa: E402

ENV = {"SPINE_BASE_URL": "http://x", "SPINE_BEARER_TOKEN": "t", "SPINE_POLL_SECONDS": "0.01"}


def _main(ex, argv, monkeypatch, jobs=()):
    """runner.main with a REAL Executors (ex) and a fake HTTP post; returns (rc or SystemExit code, claim paths)."""
    calls = []
    def post(self, path, body):
        calls.append(path)
        if calls.count("/api/spine/claim") > 3: raise AssertionError("loop never stopped: %d claims" % calls.count("/api/spine/claim"))
        if path == "/api/spine/claim":
            return 200, {"jobs": list(jobs) if calls.count(path) == 1 else []}
        return 200, {}
    for k, v in ENV.items(): monkeypatch.setenv(k, v)
    monkeypatch.setattr(runner.Runner, "_http_post", post)
    monkeypatch.setattr(runner.executors, "Executors", lambda *a, **k: ex)
    monkeypatch.setattr(runner.executors, "install_signal_handlers", lambda e: None)
    try:
        rc = runner.main(argv)
    except SystemExit as e:
        rc = e.code
    return rc, calls


# Q1 F-B': a recorded (swallowed) stop on a REAL Executors ends the --live loop before the FIRST claim, with 128+signum, for both signals.
@pytest.mark.parametrize("sig,want", [(signal.SIGTERM, 143), (signal.SIGINT, 130)])
def test_q1_recorded_stop_exits_before_any_claim(monkeypatch, sig, want):
    ex = executors.Executors(env={}); ex.stop_signum = sig
    rc, calls = _main(ex, ["--live"], monkeypatch)
    assert (rc, calls) == (want, [])


# Q2 F-B': a stop recorded during a pass (here: inside the report post) stops the loop before the NEXT claim; exactly one claim was made.
def test_q2_stop_recorded_mid_pass_blocks_the_next_claim(monkeypatch):
    ex = executors.Executors(env={})
    calls = []
    def post(self, path, body):
        calls.append(path)
        if path == "/api/spine/claim" and calls.count(path) > 1: raise AssertionError("claimed after stop")
        if path == "/api/spine/claim": return 200, {"jobs": []}
        return 200, {}
    for k, v in ENV.items(): monkeypatch.setenv(k, v)
    monkeypatch.setattr(runner.Runner, "_http_post", post)
    monkeypatch.setattr(runner.executors, "Executors", lambda *a, **k: ex)
    monkeypatch.setattr(runner.executors, "install_signal_handlers", lambda e: None)
    monkeypatch.setattr(runner.time, "sleep", lambda s: setattr(ex, "stop_signum", signal.SIGTERM))   # the stop is recorded and swallowed while idle
    with pytest.raises(SystemExit) as ei:
        runner.main(["--live"])
    assert (ei.value.code, calls.count("/api/spine/claim")) == (143, 1)


# Q3 default path unchanged: without --live and with no stop the loop claims normally (would_run, shadow report) and --once returns 0.
def test_q3_flag_off_once_unchanged(monkeypatch):
    ex = executors.Executors(env={})
    rc, calls = _main(ex, ["--once"], monkeypatch, jobs=[{"job_id": "j", "stage": "recut", "encounter_id": "e"}])
    assert (rc, calls) == (0, ["/api/spine/claim", "/api/spine/report"])


# Q4 F-B': a child started after a swallowed stop is killed at its FIRST poll (no 0.5 s slice spent), the whole group dies, exit 128+signum, no TimeoutExpired.
def test_q4_swallowed_stop_kills_next_child_immediately():
    ex = executors.Executors(env={}); ex.stop_signum = signal.SIGINT
    tag = uuid.uuid4().hex
    t0 = time.monotonic()
    with pytest.raises(SystemExit) as ei:
        _env_run(ex, tag)
    el = time.monotonic() - t0
    time.sleep(0.2)
    assert (ei.value.code, _tagged(tag)) == (130, []) and el < 0.3, el


def _env_run(ex, tag):
    old = os.environ.get("SIGBTAG"); os.environ["SIGBTAG"] = tag
    try:
        return ex._run_group(["sh", "-c", "sleep 30 & exec sleep 31"], timeout=60)
    finally:
        if old is None: os.environ.pop("SIGBTAG", None)
        else: os.environ["SIGBTAG"] = old


# Q5 F-E: the except path reaps even when the direct child is already gone; killpg on a fully dead group is harmless and the ORIGINAL exception propagates.
def test_q5_except_path_with_dead_group_reraises_original(monkeypatch):
    ex = executors.Executors(env={})
    oc = subprocess.Popen.communicate
    def comm(self, *a, **k):
        if k.get("timeout") is not None:
            self.wait(); time.sleep(0.05); raise RuntimeError("boom")   # child and group fully dead, then an error out of communicate
        return oc(self, *a, **k)
    monkeypatch.setattr(subprocess.Popen, "communicate", comm)
    kills = []; okp = os.killpg
    monkeypatch.setattr(executors.os, "killpg", lambda pid, s: (kills.append(pid), okp(pid, s)))
    with pytest.raises(RuntimeError, match="boom"):
        ex._run_group(["true"], timeout=5)
    assert len(kills) == 1 and not ex._children


# Q6 F-E end to end, non-live, SIGINT: direct child exited, two grandchildren in the group: both are killed; one killpg.
def test_q6_non_live_ctrl_c_kills_every_grandchild(tmp_path):
    r = _run('''
        print("go", flush=True)
        ex._run_group(["sh", "-c", "sleep 30 & sleep 31 & exit 0"], timeout=60)
    ''', tmp_path, send=[(0.5, signal.SIGINT)], live=False)
    assert (r["rc"] in (-2, 130), r["orphans"], r["log"].count("killpg")) == (True, 0, 1), r


# Q7 F-E: the timeout path still kills once (it never enters the except branch), so the guard removal cannot double-kill.
def test_q7_timeout_one_killpg_non_live(tmp_path):
    r = _run('''
        print("go", flush=True)
        try: ex._run_group(["sh", "-c", "sleep 30 & exit 0"], timeout=0.4)
        except subprocess.TimeoutExpired: mark("TIMEOUT")
    ''', tmp_path, live=False)
    assert (r["rc"], r["orphans"], r["log"].count("killpg"), "TIMEOUT" in r["log"]) == (0, 0, 1, True), r


# Q8 live: an idle SIGTERM swallowed by a real finaliser, then the runner's next _run_group: exits 143 with NO 2nd signal, no orphan (strict Y1: the pid file is optional, the tag scan is not).
def test_q8_live_swallowed_finaliser_stop_strict(tmp_path):
    r = _run('''
        class D:
            def __del__(self): os.kill(os.getpid(), signal.SIGTERM)
        D()
        mark("survived")
        print("go", flush=True)
        ex._run_group(LONG, timeout=60); mark("RETURNED")
    ''', tmp_path, wait=5)
    assert (r["rc"], r["orphans"], "RETURNED" in r["log"], "survived" in r["log"]) == (143, 0, False, True), r


# Q9 the loop check costs nothing on a normal pass: 100k raise_pending() calls with no stop take < 0.2 s.
def test_q9_check_is_cheap():
    ex = executors.Executors(env={}); t0 = time.perf_counter()
    for _ in range(100000): ex.raise_pending()
    assert time.perf_counter() - t0 < 0.2
