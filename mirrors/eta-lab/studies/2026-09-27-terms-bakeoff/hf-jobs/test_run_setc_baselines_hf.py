"""Tests for run_setc_baselines_hf.py's pure/mockable logic (config verification, per-window write-error
handling, sravaani device-check refusal, WINDOWS/env parsing). The infra functions (build_whisper_server,
download_whisper_model, start_whisper_server, start_sravaani_server) need a real GPU/network/cmake toolchain and
are NOT covered here - see the module's own docstring: only a real HF Job smoke-test run can prove those work,
matching this bake-off's standing smoke-before-scored gate. Never run any real `hf jobs`/`uv run` command from
these tests."""
import json
import os
import sys

import pytest

os.environ.setdefault("REB_OUT_PREFIX", "test-w50-setc-baselines-hf")  # read at module import time

pytestmark = pytest.mark.skipif(
    not os.environ.get("KIT_ROOT"), reason="KIT_ROOT must be set (an explicit a5def748 worktree) to import "
                                            "run_setc_baselines_hf.py - it needs reb/reb_runner on sys.path"
)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # studies/.../ for pinned_configs

if os.environ.get("KIT_ROOT"):
    import run_setc_baselines_hf as m
    from pinned_configs import PinnedConfigMismatch

STUB = {"ist_date": "2026-09-22", "room_id": "room_12345678", "room_slug": "room_12345678", "window_id": "w1",
        "audio": {"r2_key": "local:w1.wav", "sha256": "a" * 64, "sample_rate": 16000, "duration_ms": 1000},
        "t0_ms": 0, "t1_ms": 1000, "source_kind": "dev_clip", "clock": "tape_utc",
        "source_windows": [{"run_id": "hist-inventory@test", "window_id": "chunk-1"}]}


def test_claim_windows_parses_env_json(monkeypatch):
    windows = [{"window_id": "w1", "audio_file": "w1.wav", "room_id": "room_a", "ist_date": "2026-09-22",
                "manifest_stub": STUB}]
    monkeypatch.setenv("WINDOWS", json.dumps(windows))
    assert m.claim_windows() == windows


def test_run_whisper_variant_raises_on_config_drift(monkeypatch):
    class FakeWhisper:
        MODEL = "whisper-large-v3-turbo"
        VERSION = "v1"

        @staticmethod
        def expected_config(variant):
            return {"language": "auto", "response_format": "verbose_json", "temperature": 0.0,
                     "temperature_inc": 0.2, "extra_drifted_field": True}, "deadbeef"

    monkeypatch.setattr(m, "whisper", FakeWhisper)
    with pytest.raises(PinnedConfigMismatch):
        m.run_whisper_variant("whisper-auto", "w1", "/fake.wav", 1000, STUB)


def test_run_sravaani_raises_on_config_drift(monkeypatch):
    monkeypatch.setattr(m, "SRAVAANI_CHUNK_S", 999)  # wrong chunk_s -> wrong hash vs the pinned b3584dd6
    with pytest.raises(PinnedConfigMismatch):
        m.run_sravaani("w1", "/fake.wav", 1000, STUB)


def test_run_whisper_variant_writes_a_visible_failed_track_on_engine_exception(monkeypatch, tmp_path):
    def fake_build_track(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(m.whisper, "build_track", fake_build_track)
    monkeypatch.setattr(m, "LOCAL_ROOT", str(tmp_path))

    track, err = m.run_whisper_variant("whisper-auto", "w1", "/fake.wav", 1000, STUB)

    assert track["status"] == "failed"
    assert "boom" in track["reason"]
    assert err is None  # write itself succeeded (this is a fresh scratch root, not a real collision)
    manifest_path = tmp_path / STUB["ist_date"] / STUB["room_id"] / STUB["window_id"] / "manifest.json"
    assert manifest_path.exists()


def test_write_track_or_error_catches_value_error_without_crashing(monkeypatch):
    def fake_write_track(*a, **kw):
        raise ValueError("manifest_stub missing required fields: ['t1_ms']")

    monkeypatch.setattr(m, "write_track", fake_write_track)
    err = m._write_track_or_error("w1", STUB, {"engine": "whisper-auto", "status": "ok"})

    assert err is not None
    assert err["kind"] == "write_error"
    assert err["window_id"] == "w1"


def test_write_track_or_error_returns_none_on_success(monkeypatch):
    monkeypatch.setattr(m, "write_track", lambda *a, **kw: "/fake/path")
    err = m._write_track_or_error("w1", STUB, {"engine": "whisper-auto", "status": "ok"})
    assert err is None


def test_main_refuses_if_sravaani_reports_non_cpu_device(monkeypatch):
    """The exact real correctness gap this script exists to close: a GPU HF Job's sravaani instance auto-picking
    CUDA would silently invalidate the pinned "backend":"box-twin-cpu" config claim - must refuse loudly, not
    proceed and write tracks under a hash that misrepresents what actually ran."""
    monkeypatch.setenv("WINDOWS", json.dumps([]))

    class FakeProc:
        pid = 12345

        def terminate(self):
            pass

    monkeypatch.setattr(m, "build_whisper_server", lambda: "/fake/whisper-server")
    monkeypatch.setattr(m, "download_whisper_model", lambda: "/fake/model.bin")
    monkeypatch.setattr(m, "start_whisper_server", lambda *a: FakeProc())
    monkeypatch.setattr(m, "start_sravaani_server", lambda: FakeProc())
    monkeypatch.setattr(m, "_sravaani_device", lambda: "cuda")

    with pytest.raises(RuntimeError, match="expected 'cpu'"):
        m.main()


def test_upload_window_copies_scratch_dir_to_bucket_prefix(tmp_path, monkeypatch):
    src = tmp_path / "local" / "2026-09-22" / "room_a" / "w1"
    src.mkdir(parents=True)
    (src / "track.json").write_text("{}")
    monkeypatch.setattr(m, "LOCAL_ROOT", str(tmp_path / "local"))
    monkeypatch.setattr(m, "BUCKET_ROOT", str(tmp_path / "bucket"))
    monkeypatch.setattr(m, "OUT_PREFIX", "out-prefix")

    dst = m.upload_window("2026-09-22", "room_a", "w1")

    assert os.path.exists(os.path.join(dst, "track.json"))
    assert dst == str(tmp_path / "bucket" / "out-prefix" / "2026-09-22" / "room_a" / "w1")


def test_reb_out_prefix_required_subprocess():
    """No smoke-specific default, matching the candidate launchers' own REB_OUT_PREFIX pattern - a scored run
    must never silently inherit a leftover/smoke value."""
    import subprocess

    env = {k: v for k, v in os.environ.items() if k != "REB_OUT_PREFIX"}
    env["KIT_ROOT"] = os.environ.get("KIT_ROOT", "")
    # pinned_configs.py lives one directory up (studies/2026-09-27-terms-bakeoff/), not vendored into this
    # KIT_ROOT test worktree's terms/ subdir - PYTHONPATH stands in for that here, matching how this test
    # file's own top-level sys.path.insert already makes it importable for the in-process tests above.
    env["PYTHONPATH"] = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run(
        [sys.executable, "-c", "import run_setc_baselines_hf"],
        cwd=os.path.dirname(os.path.abspath(__file__)), env=env, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "REB_OUT_PREFIX" in result.stderr
