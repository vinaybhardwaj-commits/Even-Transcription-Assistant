"""Tests for service_identity.py. Includes real checks against the actual running whisper-server/sravaani-twin
(skipped if not present) plus mocked unit tests for the pure comparison logic."""
import os
from datetime import datetime, timedelta

import pytest

import service_identity as m
from service_identity import (
    assert_predates, assert_unchanged, assert_files_predate_process, ServiceIdentityError,
    _parse_model_path_from_cmdline,
)

WHISPER_SERVICE_UP = os.path.exists("/proc/net/tcp")  # cheap proxy; real check happens inside the test itself


@pytest.mark.skipif(not WHISPER_SERVICE_UP, reason="not a Linux box with /proc")
def test_real_whisper_server_identity():
    try:
        identity = m.whisper_server_identity()
    except ServiceIdentityError:
        pytest.skip("whisper-server not listening on this box")
    assert identity["pid"] > 0
    assert "whisper-server" in identity["cmdline"]
    assert identity["health"] == '{"status":"ok"}'
    assert len(identity["model_sha256"]) == 64
    assert len(identity["exe_sha256"]) == 64
    assert identity["model_mtime"] < identity["started_at"]
    assert identity["exe_mtime"] < identity["started_at"]


@pytest.mark.skipif(not os.path.exists(m.SRAVAANI_SERVER_SCRIPT), reason="sravaani server script not present")
def test_real_sravaani_server_identity():
    try:
        identity = m.sravaani_server_identity()
    except ServiceIdentityError:
        pytest.skip("sravaani-twin not listening on this box")
    assert identity["pid"] > 0
    assert "sravaani_server.py" in identity["cmdline"]
    assert len(identity["script_sha256"]) == 64
    assert identity["script_mtime"] < identity["started_at"]


def test_parse_model_path_from_cmdline():
    cmdline = "/x/whisper-server -m /home/eta/services/whisper/models/ggml-large-v3-turbo.bin --port 8080"
    assert _parse_model_path_from_cmdline(cmdline) == "/home/eta/services/whisper/models/ggml-large-v3-turbo.bin"


def test_parse_model_path_from_cmdline_missing_flag_raises():
    with pytest.raises(ServiceIdentityError, match="couldn't find"):
        _parse_model_path_from_cmdline("/x/whisper-server --port 8080")


def test_assert_files_predate_process_passes_when_all_before_start():
    identity = {"started_at": datetime(2026, 9, 24, 6, 10, 17),
                "model_mtime": datetime(2026, 9, 24, 6, 7, 46), "exe_mtime": datetime(2026, 9, 24, 6, 10, 10)}
    assert_files_predate_process(identity, "whisper-server", ["model_mtime", "exe_mtime"])  # no raise


def test_assert_files_predate_process_raises_when_file_modified_after_start():
    """The exact scenario both checkers flagged: a file changed AFTER the process using it started - hashing it
    would measure code/a model the running process never actually loaded."""
    identity = {"started_at": datetime(2026, 9, 24, 6, 10, 17),
                "model_mtime": datetime(2026, 9, 25, 0, 0, 0)}  # modified a day AFTER the process started
    with pytest.raises(ServiceIdentityError, match="NOT before"):
        assert_files_predate_process(identity, "whisper-server", ["model_mtime"])


def test_assert_files_predate_process_raises_on_unknown_mtime():
    identity = {"started_at": datetime(2026, 9, 24, 6, 10, 17), "model_mtime": None}
    with pytest.raises(ServiceIdentityError, match="unknown"):
        assert_files_predate_process(identity, "whisper-server", ["model_mtime"])


def test_assert_predates_passes_when_started_before_cutoff():
    identity = {"pid": 1, "started_at": datetime(2026, 9, 24, 6, 0, 0)}
    assert_predates(identity, datetime(2026, 9, 27, 16, 35, 0), "whisper-server")  # no raise


def test_assert_predates_raises_when_started_after_cutoff():
    identity = {"pid": 1, "started_at": datetime(2026, 9, 28, 0, 0, 0)}
    with pytest.raises(ServiceIdentityError, match="NOT before"):
        assert_predates(identity, datetime(2026, 9, 27, 16, 35, 0), "whisper-server")


def test_assert_predates_raises_when_started_exactly_at_cutoff():
    """>= cutoff is refused, not just >: a service starting in the same instant as the cutoff is not verifiably
    the pre-existing instance."""
    t = datetime(2026, 9, 27, 16, 35, 0)
    identity = {"pid": 1, "started_at": t}
    with pytest.raises(ServiceIdentityError):
        assert_predates(identity, t, "whisper-server")


def test_assert_unchanged_passes_on_identical_snapshots():
    a = {"pid": 1, "started_at": datetime(2026, 9, 24, 6, 0, 0), "model_sha256": "abc"}
    b = dict(a)
    assert_unchanged(a, b, "whisper-server", ["pid", "started_at", "model_sha256"])  # no raise


def test_assert_unchanged_raises_on_pid_change():
    a = {"pid": 1, "started_at": datetime(2026, 9, 24, 6, 0, 0), "model_sha256": "abc"}
    b = dict(a, pid=2)
    with pytest.raises(ServiceIdentityError, match="changed mid-run"):
        assert_unchanged(a, b, "whisper-server", ["pid", "started_at", "model_sha256"])


def test_assert_unchanged_raises_on_model_sha_change():
    """The exact scenario both checkers flagged: same PID, but the underlying model file changed."""
    a = {"pid": 1, "started_at": datetime(2026, 9, 24, 6, 0, 0), "model_sha256": "abc"}
    b = dict(a, model_sha256="def")
    with pytest.raises(ServiceIdentityError, match="changed mid-run"):
        assert_unchanged(a, b, "whisper-server", ["pid", "started_at", "model_sha256"])


def test_assert_unchanged_ignores_keys_not_in_compare_keys():
    a = {"pid": 1, "health": "ok"}
    b = {"pid": 1, "health": "different-but-not-compared"}
    assert_unchanged(a, b, "whisper-server", ["pid"])  # no raise - health isn't in compare_keys
