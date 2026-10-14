"""Tests for run_setc_baselines.py's pure/mockable logic. The real end-to-end path (writing real tracks against
the real whisper-server/sravaani-twin services into a scratch REB root) was verified manually before this file
was written - config hashes matched the pinned values exactly (whisper-auto 4b67551a, whisper-cap2 c7bd317b,
sravaani b3584dd6), validate_manifest passed, and the scratch output (which briefly held real patient transcript
text from a real set (c) consult) was deleted immediately after inspection. These tests cover the write-outcome,
K2 conflict-detection, and config-pin-check logic in isolation, without needing the real services or touching
real patient audio."""
import json
import os

import pytest

from pinned_configs import PinnedConfigMismatch, config_hash as real_config_hash

pytestmark = pytest.mark.skipif(
    not os.environ.get("KIT_ROOT"), reason="KIT_ROOT must be set (an explicit a5def748 worktree) to import "
                                            "run_setc_baselines.py at all - it refuses at import time otherwise"
)

if os.environ.get("KIT_ROOT"):
    import run_setc_baselines as m
    from reb import ValidationError, PathComponentError

STUB = {"ist_date": "2026-09-22", "room_id": "room_x", "window_id": "w1"}


def test_write_ok_or_empty_reports_written_status(monkeypatch):
    written = {}

    def fake_write_track(root, ist_date, room_id, window_id, track, manifest_stub=None):
        written["track"] = track
        return "/fake/path"

    monkeypatch.setattr(m, "write_track", fake_write_track)
    track = {"status": "ok", "engine": "whisper-auto"}
    outcome = m._write_ok_or_empty("/fake/reb", track, STUB, "whisper-auto")
    assert outcome == "written_ok"
    assert written["track"] is track


# --- G1/R1: TrackExistsError is no longer blindly "already_present" ---

def test_write_ok_or_empty_genuine_match_is_already_present(monkeypatch):
    track = {"layer": "stt", "engine": "whisper-auto", "version": "v1", "config": {}, "status": "ok"}
    track["config_hash"] = real_config_hash(track["config"])
    matching_sha = m._track_body_sha256(track)

    def fake_write_track(*a, **kw):
        raise m.TrackExistsError("already there")

    def fake_existing_entry(reb_root, ist_date, room_id, window_id, t):
        return {"layer": "stt", "engine": "whisper-auto", "version": "v1",
                "config_hash": track["config_hash"], "sha256": matching_sha}

    monkeypatch.setattr(m, "write_track", fake_write_track)
    monkeypatch.setattr(m, "_existing_manifest_entry", fake_existing_entry)
    outcome = m._write_ok_or_empty("/fake/reb", track, STUB, "whisper-auto")
    assert outcome == "already_present"


def test_write_ok_or_empty_orphan_is_a_conflict(monkeypatch):
    """A track file exists on disk but the manifest has no matching entry - must be reported as a conflict, not
    silently treated as already_present (writer.py's B1 orphan class)."""
    track = {"layer": "stt", "engine": "whisper-auto", "version": "v1", "config": {}, "status": "ok",
             "config_hash": "abc"}

    def fake_write_track(*a, **kw):
        raise m.TrackExistsError("already there")

    monkeypatch.setattr(m, "write_track", fake_write_track)
    monkeypatch.setattr(m, "_existing_manifest_entry", lambda *a: None)
    outcome = m._write_ok_or_empty("/fake/reb", track, STUB, "whisper-auto")
    assert isinstance(outcome, dict)
    assert outcome["kind"] == "orphan"


def test_write_ok_or_empty_sha_mismatch_is_a_conflict(monkeypatch):
    track = {"layer": "stt", "engine": "whisper-auto", "version": "v1", "config": {}, "status": "ok",
             "config_hash": "abc"}

    def fake_write_track(*a, **kw):
        raise m.TrackExistsError("already there")

    def fake_existing_entry(*a):
        return {"layer": "stt", "engine": "whisper-auto", "version": "v1", "config_hash": "abc",
                "sha256": "0" * 64}  # deliberately wrong vs. the track's own re-serialization

    monkeypatch.setattr(m, "write_track", fake_write_track)
    monkeypatch.setattr(m, "_existing_manifest_entry", fake_existing_entry)
    outcome = m._write_ok_or_empty("/fake/reb", track, STUB, "whisper-auto")
    assert isinstance(outcome, dict)
    assert outcome["kind"] == "sha256_mismatch"


# --- reb #5279: write_track exceptions OTHER than TrackExistsError must not crash the whole batch ---

def test_write_ok_or_empty_mirror_pending_is_reported_not_raised(monkeypatch):
    """local write IS durable and correct when only the R2 mirror fails - must not be treated as a per-window
    failure, matching commit_scored_tracks.py's own MirrorPendingError handling."""
    def fake_write_track(*a, **kw):
        raise m.MirrorPendingError("R2 mirror failed, local write durable")

    monkeypatch.setattr(m, "write_track", fake_write_track)
    track = {"status": "ok", "engine": "whisper-auto"}
    outcome = m._write_ok_or_empty("/fake/reb", track, STUB, "whisper-auto")
    assert outcome == "written_ok_mirror_pending"


def test_write_ok_or_empty_validation_error_is_a_write_error_conflict(monkeypatch):
    """reb #5279: a ValidationError from write_track's own manifest validation (e.g. a bad source_windows
    field - the exact shape that crashed dev-ingest tonight at window 193/222) must be caught and recorded as
    a per-window conflict, not propagate out and crash the rest of the batch."""
    def fake_write_track(*a, **kw):
        raise ValidationError(["source_windows entry missing window_id"])

    monkeypatch.setattr(m, "write_track", fake_write_track)
    track = {"status": "ok", "engine": "whisper-auto"}
    outcome = m._write_ok_or_empty("/fake/reb", track, STUB, "whisper-auto")
    assert isinstance(outcome, dict)
    assert outcome["kind"] == "write_error"
    assert "source_windows" in outcome["error"]


def test_write_ok_or_empty_path_component_error_is_a_write_error_conflict(monkeypatch):
    def fake_write_track(*a, **kw):
        raise PathComponentError("window_id='../evil' is not a safe path component")

    monkeypatch.setattr(m, "write_track", fake_write_track)
    track = {"status": "ok", "engine": "whisper-auto"}
    outcome = m._write_ok_or_empty("/fake/reb", track, STUB, "whisper-auto")
    assert isinstance(outcome, dict)
    assert outcome["kind"] == "write_error"


def test_write_failed_writes_a_visible_failed_track(monkeypatch):
    written = {}

    def fake_write_track(root, ist_date, room_id, window_id, track, manifest_stub=None):
        written["track"] = track

    monkeypatch.setattr(m, "write_track", fake_write_track)
    template = {"schema": "reb.track.v1", "window_id": "w1", "layer": "stt", "engine": "whisper-auto",
                "model": "x", "version": "v1", "config": {}, "config_hash": "abc", "machine": "box"}
    outcome = m._write_failed("/fake/reb", template, ValueError("boom"), STUB, "whisper-auto")
    assert outcome == "failed"
    assert written["track"]["status"] == "failed"
    assert "boom" in written["track"]["reason"]
    assert written["track"]["segments"] == []


def test_write_failed_swallows_track_exists_but_still_reports_failed(monkeypatch):
    """A failure that was already recorded by an earlier attempt at the same config_hash - not a NEW failure to
    write, but still correctly reported to the caller as this attempt's outcome (a genuine match, not a
    conflict)."""
    template = {"schema": "reb.track.v1", "window_id": "w1", "layer": "stt", "engine": "whisper-auto",
                "model": "x", "version": "v1", "config": {}, "config_hash": "abc", "machine": "box"}
    failed_track = {**template, "status": "failed", "reason": "ValueError: boom", "segments": []}
    matching_sha = m._track_body_sha256(failed_track)

    def fake_write_track(*a, **kw):
        raise m.TrackExistsError("already recorded")

    def fake_existing_entry(*a):
        return {"layer": "stt", "engine": "whisper-auto", "version": "v1", "config_hash": "abc",
                "sha256": matching_sha}

    monkeypatch.setattr(m, "write_track", fake_write_track)
    monkeypatch.setattr(m, "_existing_manifest_entry", fake_existing_entry)
    outcome = m._write_failed("/fake/reb", template, ValueError("boom"), STUB, "whisper-auto")
    assert outcome == "failed"


def test_write_failed_orphan_is_still_reported_as_conflict(monkeypatch):
    """Even inside _write_failed's TrackExistsError handling, an orphan must surface as a conflict dict, not be
    swallowed into a bare "failed" string."""
    template = {"schema": "reb.track.v1", "window_id": "w1", "layer": "stt", "engine": "whisper-auto",
                "model": "x", "version": "v1", "config": {}, "config_hash": "abc", "machine": "box"}

    def fake_write_track(*a, **kw):
        raise m.TrackExistsError("already there")

    monkeypatch.setattr(m, "write_track", fake_write_track)
    monkeypatch.setattr(m, "_existing_manifest_entry", lambda *a: None)
    outcome = m._write_failed("/fake/reb", template, ValueError("boom"), STUB, "whisper-auto")
    assert isinstance(outcome, dict)
    assert outcome["kind"] == "orphan"


def test_run_whisper_variant_raises_on_config_drift(monkeypatch):
    """If whisper.py's live-built config ever drifted from the pre-registered hash, this must refuse loudly,
    not silently write under a mismatched config_hash."""
    class FakeWhisper:
        MODEL = "whisper-large-v3-turbo"
        VERSION = "v1"

        @staticmethod
        def expected_config(variant):
            return {"language": "auto", "response_format": "verbose_json",
                     "temperature": 0.0, "temperature_inc": 0.2, "extra_drifted_field": True}, "deadbeef"

    monkeypatch.setattr(m, "whisper", FakeWhisper)
    with pytest.raises(PinnedConfigMismatch):
        m.run_whisper_variant("/fake/reb", "whisper-auto", "w1", "/fake.wav", 1000, {})


def test_run_sravaani_raises_on_config_drift(monkeypatch):
    class FakeBoxTwin:
        pass

    monkeypatch.setattr(m, "box_twin", FakeBoxTwin)
    monkeypatch.setattr(m, "SRAVAANI_CHUNK_S", 999)  # wrong chunk_s -> wrong hash vs the pinned b3584dd6
    with pytest.raises(PinnedConfigMismatch):
        m.run_sravaani("/fake/reb", "w1", "/fake.wav", 1000, {})


def test_kit_root_required_subprocess():
    """Importing without KIT_ROOT set must fail loudly (SystemExit), never silently default to some 'main'
    checkout that could have moved past the pinned commit. Run in a real subprocess (not just inspecting the
    guard's condition) so this actually exercises the module's own top-level code."""
    import subprocess
    import sys

    env = {k: v for k, v in os.environ.items() if k != "KIT_ROOT"}
    result = subprocess.run(
        [sys.executable, "-c", "import run_setc_baselines"],
        cwd=os.path.dirname(os.path.abspath(__file__)), env=env, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "KIT_ROOT is required" in result.stderr


# --- refuter-3 #5280 item 7: GPU lock check ---

def test_refuse_if_gpu_lock_held_noop_when_no_lock_file(tmp_path):
    m._refuse_if_gpu_lock_held(lock_path=str(tmp_path / "no-such-lock"))  # no raise


def test_refuse_if_gpu_lock_held_passes_when_lock_free(tmp_path):
    lock_path = tmp_path / "gpu.lock"
    lock_path.write_text("")
    m._refuse_if_gpu_lock_held(lock_path=str(lock_path))  # no raise


def test_refuse_if_gpu_lock_held_raises_when_held(tmp_path):
    """The exact real scenario (bus #5143): diar-lab's nightly job holds this via `flock ~/gpu.lock` while
    training - simulated here with a real held flock in a child process (a lock is per-process, so holding it
    in this same process/thread wouldn't exercise the non-blocking contention path for real)."""
    import fcntl
    import multiprocessing
    import time

    lock_path = tmp_path / "gpu.lock"
    lock_path.write_text("")

    def _hold_lock(path, ready, release):
        fd = os.open(path, os.O_RDONLY)
        fcntl.flock(fd, fcntl.LOCK_EX)
        ready.set()
        release.wait(timeout=10)
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)

    ready = multiprocessing.Event()
    release = multiprocessing.Event()
    p = multiprocessing.Process(target=_hold_lock, args=(str(lock_path), ready, release))
    p.start()
    try:
        assert ready.wait(timeout=10), "child process never acquired the lock"
        with pytest.raises(RuntimeError, match="currently held"):
            m._refuse_if_gpu_lock_held(lock_path=str(lock_path))
    finally:
        release.set()
        p.join(timeout=10)


def test_reb_root_is_a_required_cli_argument():
    """G1/R1: --reb-root must be required (no default), so this can never run against production by a forgotten
    flag - matching commit_scored_tracks.py's own --reb-root pattern."""
    import subprocess
    import sys

    result = subprocess.run(
        [sys.executable, "run_setc_baselines.py", "--limit", "0"],
        cwd=os.path.dirname(os.path.abspath(__file__)), env=os.environ, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "--reb-root" in result.stderr


def _write_manifest(root, entries):
    d = os.path.join(root, STUB["ist_date"], STUB["room_id"], STUB["window_id"])
    os.makedirs(d)
    with open(os.path.join(d, "manifest.json"), "w") as f:
        json.dump({"tracks": entries}, f)


def _entry(engine, cfg_hash, version):
    return {"layer": "stt", "engine": engine, "version": version, "config_hash": cfg_hash}


def test_pending_engines_no_manifest_means_all_pending(tmp_path):
    assert m._pending_engines(str(tmp_path), STUB) == ["whisper-auto", "whisper-cap2", "sravaani"]


def test_pending_engines_skips_recorded_and_ignores_wrong_config_hash(tmp_path):
    _write_manifest(str(tmp_path), [
        _entry("whisper-auto", m.whisper.expected_config("whisper-auto")[1], m.whisper.VERSION),
        _entry("sravaani", "deadbeef", m.SRAVAANI_VERSION),  # a different config must NOT count as done
    ])
    assert m._pending_engines(str(tmp_path), STUB) == ["whisper-cap2", "sravaani"]


def test_excluded_r3_room_days_are_flagged_and_others_are_not():
    assert m._is_excluded({"ist_date": "2026-09-23", "room_id": "room_4ggnkg5x"})
    assert m._is_excluded({"ist_date": "2026-09-23", "room_id": "room_qyzghzaf"})
    assert not m._is_excluded({"ist_date": "2026-09-22", "room_id": "room_4ggnkg5x"})
    assert not m._is_excluded({"ist_date": "2026-09-23", "room_id": "room_other"})


def test_excluded_union_has_all_14_room_days():
    assert len(__import__('r3_exclusion').EXCLUDED_ROOM_DAYS) == 14
    assert m._is_excluded({"ist_date": "2026-09-28", "room_id": "room_ux92qpws"})


def test_filter_excluded_refuses_if_set_c_changes():
    import r3_exclusion as r3
    with pytest.raises(RuntimeError):
        r3.filter_excluded([{"manifest_stub": {"room_id": "x", "ist_date": "2026-09-22"}}])


# ---- --retry-sravaani-window (eta-refuter-2 #7070) ----
from track_select import select_latest_ok  # noqa: E402

SR_HASH = "b3584dd6"


def _win(stub):
    return {"window_id": stub["window_id"], "manifest_stub": stub}


def _full_stub():
    return {"window_id": "w1", "room_id": "room_abcd1234", "room_slug": "x", "ist_date": "2026-09-22",
            "t0_ms": 0, "t1_ms": 60000,
            "audio": {"r2_key": "synthetic/w1.wav", "sha256": "0" * 64, "sample_rate": 16000, "duration_ms": 60000}}


def _sr_track(version, status, text="synthetic"):
    cfg = {"backend": "box-twin-cpu", "chunk_s": 30}
    return {"schema": "reb.track.v1", "window_id": "w1", "layer": "stt", "engine": "sravaani",
            "model": "ARTPARK-IISc/SraVaani-1.0", "version": version, "config": cfg,
            "config_hash": SR_HASH, "machine": "box-twin", "status": status,
            "reason": None if status == "ok" else "boom",
            "segments": [{"t0_ms": 0, "t1_ms": 1000, "text": text}] if status == "ok" else []}


def _seed(root, stub, version, status):
    from reb import write_track
    write_track(root, stub["ist_date"], stub["room_id"], stub["window_id"], _sr_track(version, status),
                manifest_stub=stub)


def test_retry_refuses_unknown_or_excluded_window(tmp_path):
    stub = _full_stub()
    with pytest.raises(RuntimeError, match="not in the set"):
        m._retry_windows(str(tmp_path), [_win(stub)], "nope")


def test_retry_refuses_ok_and_empty_v1(tmp_path):
    for status in ("ok", "empty"):
        root = str(tmp_path / status)
        stub = _full_stub()
        _seed(root, stub, "v1", status)
        with pytest.raises(RuntimeError, match="not failed"):
            m._retry_windows(root, [_win(stub)], "w1")


def test_retry_allowed_for_failed_and_for_absent_v1(tmp_path):
    stub = _full_stub()
    assert m._retry_windows(str(tmp_path / "absent"), [_win(stub)], "w1")[0]["window_id"] == "w1"
    root = str(tmp_path / "failed")
    _seed(root, stub, "v1", "failed")
    assert m._retry_windows(root, [_win(stub)], "w1")


def test_retry_refuses_if_v2_already_recorded(tmp_path):
    root, stub = str(tmp_path), _full_stub()
    _seed(root, stub, "v1", "failed")
    _seed(root, stub, "v2", "failed")
    with pytest.raises(RuntimeError, match="already exists"):
        m._retry_windows(root, [_win(stub)], "w1")


def test_retry_writes_v2_ok_same_hash_keeps_v1_failed_and_normal_run_still_skips(tmp_path, monkeypatch):
    root, stub = str(tmp_path), _full_stub()
    _seed(root, stub, "v1", "failed")
    monkeypatch.setattr(m.box_twin, "build_sravaani_track",
                        lambda wid, wav, machine=None, chunk_s=None: {**_sr_track("v1", "ok"), "window_id": wid})
    out = m.run_sravaani(root, "w1", "unused.wav", 60000, stub, version=m.SRAVAANI_RETRY_VERSION)
    assert out == "written_ok"
    with open(os.path.join(root, stub["ist_date"], stub["room_id"], "w1", "manifest.json")) as f:
        tracks = json.load(f)["tracks"]
    sr = sorted((t["version"], t["status"], t["config_hash"]) for t in tracks if t["engine"] == "sravaani")
    assert sr == [("v1", "failed", SR_HASH), ("v2", "ok", SR_HASH)]
    # normal (non-retry) mode: sravaani at v1 is still "recorded", so no window is re-run at v1
    assert "sravaani" not in m._pending_engines(root, stub)
    # STEP 3 selection reads v2 by (engine, config_hash), not by version
    with open(os.path.join(root, stub["ist_date"], stub["room_id"], "w1", "manifest.json")) as f:
        sel = select_latest_ok(json.load(f), "stt", "sravaani", SR_HASH)
    assert sel["version"] == "v2" and sel["status"] == "ok"


def test_select_latest_ok_ignores_failed_and_prefers_latest():
    man = {"tracks": [
        {"layer": "stt", "engine": "sravaani", "config_hash": "h", "status": "failed", "version": "v1", "finished_at": "2"},
        {"layer": "stt", "engine": "sravaani", "config_hash": "h", "status": "ok", "version": "v1", "finished_at": "1"},
        {"layer": "stt", "engine": "sravaani", "config_hash": "h", "status": "ok", "version": "v2", "finished_at": "3"},
        {"layer": "stt", "engine": "sravaani", "config_hash": "other", "status": "ok", "version": "v9", "finished_at": "9"},
    ]}
    assert select_latest_ok(man, "stt", "sravaani", "h")["version"] == "v2"
    assert select_latest_ok({"tracks": []}, "stt", "sravaani", "h") is None
