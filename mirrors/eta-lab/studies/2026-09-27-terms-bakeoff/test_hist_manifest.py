"""Tests for hist_manifest.py against the frozen local inventory snapshot (~/eta-data/terms/inventory/,
ADDENDUM-23 amendment - see hist_manifest.py's docstring for why the live ~/eta-data/hist/ files aren't used
directly). Structural checks only."""
import json
import os

import pytest

from hist_manifest import load_chunks_for_job, HistManifestConflict

MANIFEST_PRESENT = os.path.exists(os.path.expanduser("~/eta-data/terms/inventory/manifest.json"))
TIERC_PRESENT = os.path.exists(os.path.expanduser("~/eta-data/terms/inventory/manifest_tierC.json"))

CONFLICTED_ROOM_DAYS = [  # refuter-2 #5198 / refuter-3 #5199: verified complementary, not conflicting
    ("room_qyzghzaf", "2026-09-24"), ("room_87frpus9", "2026-09-24"), ("room_pnyc9u49", "2026-09-24"),
    ("room_4ggnkg5x", "2026-09-24"), ("room_yh3etjpf", "2026-09-24"), ("room_jwyrr4dc", "2026-09-24"),
    ("room_ymch4bxu", "2026-09-24"),
]


@pytest.mark.skipif(not MANIFEST_PRESENT, reason="real hist manifest not present on this box")
def test_loads_real_job_sorted_chronologically():
    chunks = load_chunks_for_job("room_qyzghzaf", "2026-08-19")  # not one of the 7 complementary room-days
    assert len(chunks) == 86
    for a, b in zip(chunks, chunks[1:]):
        assert a["started_at"] <= b["started_at"]


@pytest.mark.skipif(not MANIFEST_PRESENT, reason="real hist manifest not present on this box")
def test_unknown_job_raises_keyerror():
    with pytest.raises(KeyError):
        load_chunks_for_job("room_does_not_exist_xyz", "2026-09-22")


@pytest.mark.skipif(not MANIFEST_PRESENT, reason="real hist manifest not present on this box")
def test_every_chunk_has_started_before_ended():
    chunks = load_chunks_for_job("room_qyzghzaf", "2026-08-19")
    assert all(c["started_at"] < c["ended_at"] for c in chunks)


@pytest.mark.skipif(not TIERC_PRESENT, reason="manifest_tierC.json not present on this box")
def test_finds_job_only_present_in_tierc_with_different_job_id_prefix():
    """refuter-3 #5193: room_ux92qpws/2026-09-24 is only in manifest_tierC.json, whose job_id uses a "c-" prefix
    ("c-2026-09-24_room_ux92qpws") unlike manifest.json's "<day>_<room_id>" - this must match by (day, room_id)
    fields, not by re-deriving a job_id string."""
    chunks = load_chunks_for_job("room_ux92qpws", "2026-09-24")
    assert len(chunks) == 105


@pytest.mark.skipif(not (MANIFEST_PRESENT and TIERC_PRESENT), reason="both manifests needed on this box")
@pytest.mark.parametrize("room_id,day", CONFLICTED_ROOM_DAYS)
def test_real_complementary_room_days_union_without_raising(room_id, day):
    """refuter-2 #5198 / refuter-3 #5199: these 7 room-days appear in both manifests as complementary partial
    windows (not conflicting) - must union cleanly, never raise."""
    chunks = load_chunks_for_job(room_id, day)
    assert len(chunks) > 0
    for a, b in zip(chunks, chunks[1:]):
        assert a["started_at"] <= b["started_at"]


@pytest.mark.skipif(not (MANIFEST_PRESENT and TIERC_PRESENT), reason="both manifests needed on this box")
def test_real_union_is_at_least_as_large_as_either_manifest_alone():
    chunks = load_chunks_for_job("room_87frpus9", "2026-09-24")
    assert len(chunks) >= 102  # tierC alone has 102; manifest.json alone has 32; union must be >= the larger


def test_identical_duplicate_across_manifests_does_not_raise(tmp_path):
    """A chunk genuinely duplicated with the SAME fields across two manifest files is harmless."""
    chunk = {"idx": 0, "r2_key": "bench/x/2026-09-22/s/chunk_00000.webm", "session_id": "s",
             "started_at": "2026-09-22T00:00:00Z", "ended_at": "2026-09-22T00:05:00Z", "duration_ms": 300000}
    job = {"job_id": "2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk]}
    p1, p2 = tmp_path / "manifest.json", tmp_path / "manifest_tierC.json"
    p1.write_text(json.dumps({"jobs": [job]}))
    p2.write_text(json.dumps({"jobs": [job]}))
    chunks = load_chunks_for_job("room_x", "2026-09-22", manifest_paths=(str(p1), str(p2)))
    assert len(chunks) == 1


def test_chunk_carries_source_manifest_basename(tmp_path):
    """ADDENDUM-23: each chunk records which inventory file it came from, for set (c)'s per-segment
    source_windows provenance."""
    chunk = {"idx": 0, "r2_key": "bench/x/2026-09-22/s/chunk_00000.webm", "session_id": "s",
             "started_at": "2026-09-22T00:00:00Z", "ended_at": "2026-09-22T00:05:00Z", "duration_ms": 300000}
    job = {"job_id": "2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk]}
    p1 = tmp_path / "manifest.json"
    p1.write_text(json.dumps({"jobs": [job]}))
    chunks = load_chunks_for_job("room_x", "2026-09-22", manifest_paths=(str(p1),))
    assert chunks[0]["source_manifest"] == "manifest.json"


def test_shared_chunk_source_manifest_is_first_path_in_order(tmp_path):
    """A chunk present identically in both manifests gets provenance from whichever is FIRST in
    manifest_paths order (manifest.json before manifest_tierC.json), deterministic."""
    chunk = {"idx": 0, "r2_key": "bench/x/2026-09-22/s/chunk_00000.webm", "session_id": "s",
             "started_at": "2026-09-22T00:00:00Z", "ended_at": "2026-09-22T00:05:00Z", "duration_ms": 300000}
    job = {"job_id": "2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk]}
    p1, p2 = tmp_path / "manifest.json", tmp_path / "manifest_tierC.json"
    p1.write_text(json.dumps({"jobs": [job]}))
    p2.write_text(json.dumps({"jobs": [job]}))
    chunks = load_chunks_for_job("room_x", "2026-09-22", manifest_paths=(str(p1), str(p2)))
    assert chunks[0]["source_manifest"] == "manifest.json"


def test_complementary_non_overlapping_ranges_union_cleanly(tmp_path):
    """The real-world shape: manifest.json has the early chunks, tierC has the later chunks, no time overlap."""
    early = {"idx": 0, "r2_key": "bench/x/2026-09-24/s/chunk_00000.webm", "session_id": "s",
              "started_at": "2026-09-24T03:00:00Z", "ended_at": "2026-09-24T03:05:00Z", "duration_ms": 300000}
    late = {"idx": 0, "r2_key": "bench/x/2026-09-24/s/chunk_00050.webm", "session_id": "s",
             "started_at": "2026-09-24T06:00:00Z", "ended_at": "2026-09-24T06:05:00Z", "duration_ms": 300000}
    job_a = {"job_id": "2026-09-24_room_x", "day": "2026-09-24", "room_id": "room_x", "chunks": [early]}
    job_c = {"job_id": "c-2026-09-24_room_x", "day": "2026-09-24", "room_id": "room_x", "chunks": [late]}
    p1, p2 = tmp_path / "manifest.json", tmp_path / "manifest_tierC.json"
    p1.write_text(json.dumps({"jobs": [job_a]}))
    p2.write_text(json.dumps({"jobs": [job_c]}))
    chunks = load_chunks_for_job("room_x", "2026-09-24", manifest_paths=(str(p1), str(p2)))
    assert [c["r2_key"] for c in chunks] == [early["r2_key"], late["r2_key"]]


def test_same_r2_key_different_fields_raises(tmp_path):
    """Condition (a): the SAME r2_key with different timing fields across manifests is a real conflict."""
    chunk_a = {"idx": 0, "r2_key": "bench/x/2026-09-22/s/chunk_00000.webm", "session_id": "s",
               "started_at": "2026-09-22T00:00:00Z", "ended_at": "2026-09-22T00:05:00Z", "duration_ms": 300000}
    chunk_b = dict(chunk_a, ended_at="2026-09-22T00:06:00Z", duration_ms=360000)  # same key, different timing
    job_a = {"job_id": "2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk_a]}
    job_b = {"job_id": "c-2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk_b]}
    p1, p2 = tmp_path / "manifest.json", tmp_path / "manifest_tierC.json"
    p1.write_text(json.dumps({"jobs": [job_a]}))
    p2.write_text(json.dumps({"jobs": [job_b]}))
    with pytest.raises(HistManifestConflict):
        load_chunks_for_job("room_x", "2026-09-22", manifest_paths=(str(p1), str(p2)))


def test_different_r2_keys_overlapping_in_time_raises(tmp_path):
    """Condition (b): two DIFFERENT r2_keys claiming overlapping time ranges is a real conflict."""
    chunk_a = {"idx": 0, "r2_key": "bench/x/2026-09-22/s/chunk_00000.webm", "session_id": "s",
               "started_at": "2026-09-22T00:00:00Z", "ended_at": "2026-09-22T00:05:00Z", "duration_ms": 300000}
    chunk_b = {"idx": 0, "r2_key": "bench/x/2026-09-22/s2/chunk_00000.webm", "session_id": "s2",
               "started_at": "2026-09-22T00:02:00Z", "ended_at": "2026-09-22T00:07:00Z", "duration_ms": 300000}
    job_a = {"job_id": "2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk_a]}
    job_b = {"job_id": "c-2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk_b]}
    p1, p2 = tmp_path / "manifest.json", tmp_path / "manifest_tierC.json"
    p1.write_text(json.dumps({"jobs": [job_a]}))
    p2.write_text(json.dumps({"jobs": [job_b]}))
    with pytest.raises(HistManifestConflict):
        load_chunks_for_job("room_x", "2026-09-22", manifest_paths=(str(p1), str(p2)))


def test_missing_manifest_path_is_skipped_not_an_error(tmp_path):
    chunk = {"idx": 0, "r2_key": "bench/x/2026-09-22/s/chunk_00000.webm", "session_id": "s",
             "started_at": "2026-09-22T00:00:00Z", "ended_at": "2026-09-22T00:05:00Z", "duration_ms": 300000}
    job = {"job_id": "2026-09-22_room_x", "day": "2026-09-22", "room_id": "room_x", "chunks": [chunk]}
    p1 = tmp_path / "manifest.json"
    p1.write_text(json.dumps({"jobs": [job]}))
    nonexistent = tmp_path / "does_not_exist.json"
    chunks = load_chunks_for_job("room_x", "2026-09-22", manifest_paths=(str(p1), str(nonexistent)))
    assert len(chunks) == 1
