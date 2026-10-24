import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import executors  # noqa: E402
import runner  # noqa: E402

JOB = {"job_id": 7, "encounter_id": "enc_testaaaaaaaaaaaa", "stage": "recut", "mode": "shadow"}


@pytest.fixture(autouse=True)
def no_subprocess(monkeypatch):
    calls = []

    def boom(*a, **k):
        calls.append((a, k))
        raise AssertionError("subprocess spawned")

    for name in ("run", "Popen", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, boom)
    monkeypatch.setattr(os, "system", boom)
    return calls


def make(live=False, jobs=(JOB,)):
    sent = []

    def post(path, body):
        sent.append((path, body))
        return (200, {"ok": True, "jobs": list(jobs)}) if path.endswith("claim") else (200, {"ok": True})

    logs = []
    return runner.Runner("https://x", "tok", "owner1", live=live, post=post, log=logs.append), sent, logs


def test_would_run_reports_shadow_logs_cli_and_spawns_nothing():
    r, sent, logs = make()
    assert r.run_once() == 0
    assert sent[0] == ("/api/spine/claim", {"owner": "owner1", "limit": 2, "live": False})
    assert sent[1] == ("/api/spine/report", {"job_id": 7, "owner": "owner1", "outcome": "shadow"})
    assert any("would_run" in m and "cutter.run --once --only enc_testaaaaaaaaaaaa --recut" in m for m in logs)


def test_would_run_unknown_stage_still_shadow():
    r, sent, logs = make(jobs=[{**JOB, "stage": "mystery"}])
    r.run_once()
    assert sent[1][1]["outcome"] == "shadow" and "cli=none" in logs[0]


def test_live_refuses_when_mode_not_live_releases_and_exits_3():
    r, sent, _ = make(live=True)
    assert r.run_once() == 3
    assert sent[0][1]["live"] is True
    assert sent[1][1]["outcome"] == "release"


def test_live_refuses_paid_stage_even_if_server_said_live():
    r, sent, _ = make(live=True, jobs=[{**JOB, "stage": "sarvam", "mode": "live"}])
    assert r.run_once() == 3 and sent[1][1]["outcome"] == "release"


class FakeExecs:
    def __init__(self, res=None, exc=None, stages=("recut", "acoustics", "nemotron")):
        self.res, self.exc, self.stages, self.calls = res, exc, stages, []

    def has(self, stage):
        return stage in self.stages

    def execute(self, stage, uid):
        self.calls.append((stage, uid))
        if self.exc:
            raise self.exc
        return self.res


def live_runner(jobs, execs):
    sent = []

    def post(p, b):
        sent.append((p, b))
        return (200, {"ok": True, "jobs": list(jobs)}) if p.endswith("claim") else (200, {"ok": True})
    logs = []
    return runner.Runner("https://x", "t", "o", live=True, post=post, log=logs.append, execs=execs), sent, logs


def test_live_runs_through_the_executor_and_reports_its_outcome_code_and_artefact():
    art = {"engine": "cutter", "version": "v1", "cfg8": "abcdef01", "store": "box", "status": "ok", "sha256": "0" * 64}
    for res, want in [(executors.Result("done", None, art), {"outcome": "done", "artefact": art}),
                      (executors.Result("transient", "lock_busy"), {"outcome": "transient", "error_code": "lock_busy"}),
                      (executors.Result("permanent", "silent_audio"), {"outcome": "permanent", "error_code": "silent_audio"}),
                      (executors.Result("blocked", "no_consult_uid"), {"outcome": "blocked", "error_code": "no_consult_uid"})]:
        ex = FakeExecs(res)
        r, sent, logs = live_runner([{**JOB, "mode": "live", "consult_uid": "uid_test_01"}], ex)
        assert r.run_once() == 0
        assert ex.calls == [("recut", "uid_test_01")]
        assert sent[0][1]["limit"] == 1 and sent[0][1]["live"] is True
        assert sent[1][1] == {"job_id": 7, "owner": "o", **want}
        assert not any("uid_test_01" in m for m in logs)   # the uid is never logged


def test_main_live_installs_the_signal_handlers(monkeypatch):
    monkeypatch.setenv("SPINE_BASE_URL", "https://x")
    monkeypatch.setenv("SPINE_BEARER_TOKEN", "t")
    seen = []
    monkeypatch.setattr(executors, "install_signal_handlers", lambda ex: seen.append(ex))
    monkeypatch.setattr(runner.Runner, "run_once", lambda self: 0)
    assert runner.main(["--live", "--once"]) == 0 and len(seen) == 1
    assert runner.main(["--once"]) == 0 and len(seen) == 1   # would_run installs nothing


def test_live_unconfigured_executor_releases_and_exits_3():
    r, sent, _ = live_runner([{**JOB, "mode": "live"}], FakeExecs(exc=executors.ExecutorUnconfigured("SPINE_CUTTER_DIR")))
    assert r.run_once() == 3 and sent[1][1]["outcome"] == "release"


def test_live_stage_without_executor_is_refused_released():
    ex = FakeExecs(stages=("recut",))
    r, sent, _ = live_runner([{**JOB, "mode": "live", "stage": "collector"}], ex)
    assert r.run_once() == 3 and sent[1][1]["outcome"] == "release" and ex.calls == []


def test_n4_refusal_releases_the_rest_of_the_claim_and_runs_none_of_them():
    ex = FakeExecs(executors.Result("done"))
    jobs = [{**JOB, "job_id": 1, "mode": "shadow"}, {**JOB, "job_id": 2, "mode": "live"}, {**JOB, "job_id": 3, "mode": "live"}]
    r, sent, _ = live_runner(jobs, ex)
    assert r.run_once() == 3
    assert [(b["job_id"], b["outcome"]) for p, b in sent[1:]] == [(1, "release"), (2, "release"), (3, "release")]
    assert ex.calls == []


def test_n4_job_that_ran_is_not_released_but_the_unstarted_one_after_a_refusal_is():
    ex = FakeExecs(executors.Result("done"))
    jobs = [{**JOB, "job_id": 1, "mode": "live"}, {**JOB, "job_id": 2, "mode": "shadow"}, {**JOB, "job_id": 3, "mode": "live"}]
    r, sent, _ = live_runner(jobs, ex)
    assert r.run_once() == 3
    assert [(b["job_id"], b["outcome"]) for p, b in sent[1:]] == [(1, "done"), (2, "release"), (3, "release")]
    assert len(ex.calls) == 1


def test_n4_would_run_path_is_unchanged_every_job_shadow():
    r, sent = mk([{**JOB, "job_id": i} for i in (1, 2)])
    assert r.run_once() == 0 and [b["outcome"] for p, b in sent[1:]] == ["shadow", "shadow"]


def test_failed_claim_does_nothing():
    r = runner.Runner("https://x", "t", "o", post=lambda p, b: (503, {}), log=lambda m: None)
    assert r.run_once() == 0


def test_main_requires_config(monkeypatch):
    monkeypatch.delenv("SPINE_BASE_URL", raising=False)
    monkeypatch.delenv("SPINE_BEARER_TOKEN", raising=False)
    assert runner.main(["--once"]) == 2


def test_default_is_would_run(monkeypatch):
    monkeypatch.setenv("SPINE_BASE_URL", "https://x")
    monkeypatch.setenv("SPINE_BEARER_TOKEN", "t")
    seen = {}

    def fake(self):
        seen["live"] = self.live
        return 0

    monkeypatch.setattr(runner.Runner, "run_once", fake)
    assert runner.main(["--once"]) == 0
    assert seen == {"live": False}


# --- ported from the Opus refute (spine-s5-oref) + R2 fixes ---
def mk(jobs, live=False, report_status=200):
    sent = []

    def post(p, b):
        sent.append((p, b))
        if p.endswith("claim"):
            return 200, {"ok": True, "jobs": jobs}
        return report_status() if callable(report_status) else report_status, {}
    return runner.Runner("https://x", "t", "o", live=live, post=post, log=lambda m: None), sent


def test_would_run_live_mode_paid_and_many_jobs_never_spawn():
    jobs = [{"job_id": i, "encounter_id": "enc_testaaaaaaaaaaaa", "stage": s, "mode": "live"} for i, s in enumerate(["recut", "sarvam", "freescript", "x"])]
    r, sent = mk(jobs)
    assert r.run_once() == 0
    assert [b["outcome"] for p, b in sent[1:]] == ["shadow"] * 4


def test_live_with_empty_claim_spawns_nothing():
    r, sent = mk([], live=True)
    assert r.run_once() == 0 and len(sent) == 1


def test_live_mode_missing_key_refused():
    r, sent = mk([{"job_id": 1, "encounter_id": "e", "stage": "recut"}], live=True)
    assert r.run_once() == 3 and sent[1][1]["outcome"] == "release"


def test_unit_has_no_live_flag():
    u = open(os.path.join(os.path.dirname(__file__), "..", "units", "spine-runner.service")).read()
    ex = [line for line in u.splitlines() if line.startswith("ExecStart")]
    assert ex and all("--live" not in line for line in ex)


def test_owner_is_host_pid_token_per_process_and_fits_the_server_pattern():
    import re
    a, b = runner.make_owner("box"), runner.make_owner("box")
    assert a != b and a.startswith(f"box:{os.getpid()}:") and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", a)
    long = runner.make_owner("h" * 200 + " weird/host!")
    assert re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", long)
    assert re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", runner.make_owner("!!!"))


def test_failed_report_is_retried_once_then_logged_and_dropped():
    r, sent = mk([JOB], report_status=503)
    logs = []
    r.log = logs.append
    assert r.run_once() == 0
    reports = [b for p, b in sent if p.endswith("report")]
    assert len(reports) == 2 and reports[0] == reports[1]            # exactly one retry, no more
    assert any("report failed" in m for m in logs)


def test_report_retry_stops_after_a_success_and_409_is_final():
    seq = iter([0, 200])
    r, sent = mk([JOB], report_status=lambda: next(seq))
    r.run_once()
    assert len([1 for p, _ in sent if p.endswith("report")]) == 2
    r, sent = mk([JOB], report_status=409)
    r.run_once()
    assert len([1 for p, _ in sent if p.endswith("report")]) == 1


def test_malformed_poll_seconds_falls_back_with_one_error_line(monkeypatch, capsys):
    monkeypatch.setenv("SPINE_BASE_URL", "https://x")
    monkeypatch.setenv("SPINE_BEARER_TOKEN", "t")
    monkeypatch.setattr(runner.Runner, "run_once", lambda self: 0)
    slept = []
    monkeypatch.setattr(runner.time, "sleep", lambda s: (slept.append(s), (_ for _ in ()).throw(KeyboardInterrupt))[0])
    for bad in ("abc", "", "-5", "0", "nan", "inf"):
        monkeypatch.setenv("SPINE_POLL_SECONDS", bad)
        with pytest.raises(KeyboardInterrupt):
            runner.main([])
        assert slept[-1] == runner.DEFAULT_POLL
    err = capsys.readouterr().err
    assert err.count("bad SPINE_POLL_SECONDS") == 6
    assert runner.poll_seconds("15") == 15.0 and runner.poll_seconds(None) == 60.0


def test_r3_loop_exits_on_a_recorded_idle_stop_before_claiming():
    """F-B': a stop recorded (and swallowed) while idle ends the runner loop at the next pass, 128+signum, without a claim."""
    import runner
    class Ex:
        def __init__(self): self.n = 0
        def raise_pending(self): raise SystemExit(143)
    r = runner.Runner("http://x", "t", "o", live=True, post=lambda *a, **k: (_ for _ in ()).throw(AssertionError("claimed")), execs=Ex())
    import os, pytest
    env = {"SPINE_BASE_URL": "http://x", "SPINE_BEARER_TOKEN": "t"}
    orig = runner.Runner
    runner.Runner = lambda *a, **k: r
    try:
        with pytest.MonkeyPatch.context() as m:
            for k, v in env.items(): m.setenv(k, v)
            m.setattr(runner.executors, "install_signal_handlers", lambda e: None)
            with pytest.raises(SystemExit) as ei:
                runner.main(["--live"])
    finally:
        runner.Runner = orig
    assert ei.value.code == 143
