import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
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


def test_live_runs_a_live_stage_and_maps_exit_codes(monkeypatch):
    for rc, outcome in [(0, "done"), (75, "transient"), (2, "permanent"), (70, "budget"), (9, "transient")]:
        r, sent, _ = make(live=True, jobs=[{**JOB, "mode": "live"}])
        monkeypatch.setattr(subprocess, "run", lambda *a, _rc=rc, **k: subprocess.CompletedProcess(a, _rc))
        assert r.run_once() == 0
        assert sent[1][1]["outcome"] == outcome


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
