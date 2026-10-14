"""Tests for tape_crop.plan_crop - pure planning logic, no real audio/network."""
from datetime import datetime, timedelta, timezone

import pytest

from tape_crop import plan_crop

T0 = datetime(2026, 9, 22, 3, 45, 0, tzinfo=timezone.utc)


def _chunk(key, start_offset_s, duration_s=300.0, source_manifest="manifest.json"):
    start = T0 + timedelta(seconds=start_offset_s)
    return {"r2_key": key, "started_at": start, "ended_at": start + timedelta(seconds=duration_s),
            "source_manifest": source_manifest}


def test_single_chunk_fully_covers_span():
    chunks = [_chunk("c0", 0, 300)]
    span_start, span_end = T0 + timedelta(seconds=50), T0 + timedelta(seconds=100)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "ok"
    assert result["segments"] == [
        {"r2_key": "c0", "local_start_s": 50.0, "local_end_s": 100.0, "source_manifest": "manifest.json"},
    ]


def test_span_crosses_two_adjacent_chunks():
    chunks = [_chunk("c0", 0, 300), _chunk("c1", 300, 300)]
    span_start, span_end = T0 + timedelta(seconds=280), T0 + timedelta(seconds=320)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "ok"
    assert result["segments"] == [
        {"r2_key": "c0", "local_start_s": 280.0, "local_end_s": 300.0, "source_manifest": "manifest.json"},
        {"r2_key": "c1", "local_start_s": 0.0, "local_end_s": 20.0, "source_manifest": "manifest.json"},
    ]


def test_span_crosses_three_chunks():
    chunks = [_chunk("c0", 0, 300), _chunk("c1", 300, 300), _chunk("c2", 600, 300)]
    span_start, span_end = T0 + timedelta(seconds=290), T0 + timedelta(seconds=610)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "ok"
    assert [s["r2_key"] for s in result["segments"]] == ["c0", "c1", "c2"]
    assert result["segments"][0]["local_start_s"] == 290.0 and result["segments"][0]["local_end_s"] == 300.0
    assert result["segments"][1]["local_start_s"] == 0.0 and result["segments"][1]["local_end_s"] == 300.0
    assert result["segments"][2]["local_start_s"] == 0.0 and result["segments"][2]["local_end_s"] == 10.0


def test_segment_carries_source_manifest_through_from_the_chunk():
    """ADDENDUM-23: source_manifest is passed through, used to build set (c)'s per-segment source_windows."""
    chunks = [_chunk("c0", 0, 300, source_manifest="manifest_tierC.json")]
    span_start, span_end = T0 + timedelta(seconds=50), T0 + timedelta(seconds=100)
    result = plan_crop(chunks, span_start, span_end)
    assert result["segments"][0]["source_manifest"] == "manifest_tierC.json"


def test_small_chunk_boundary_gap_within_tolerance_is_ok():
    """ADDENDUM-2 G1: gaps <=2s are chunk-boundary rounding, not a real gap."""
    chunks = [_chunk("c0", 0, 300), _chunk("c1", 301.5, 300)]  # 1.5s gap between chunks
    span_start, span_end = T0 + timedelta(seconds=290), T0 + timedelta(seconds=320)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "ok"


def test_real_gap_in_the_middle_is_tape_gap():
    chunks = [_chunk("c0", 0, 300), _chunk("c1", 320, 300)]  # 20s real gap
    span_start, span_end = T0 + timedelta(seconds=290), T0 + timedelta(seconds=330)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "tape_gap"
    assert "gap" in result["reason"]


def test_trailing_gap_is_tape_gap():
    chunks = [_chunk("c0", 0, 300)]
    span_start, span_end = T0 + timedelta(seconds=100), T0 + timedelta(seconds=400)  # ends 100s past chunk end
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "tape_gap"
    assert "trailing" in result["reason"]


def test_leading_gap_is_tape_gap():
    chunks = [_chunk("c0", 100, 300)]  # doesn't start until 100s in
    span_start, span_end = T0, T0 + timedelta(seconds=150)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "tape_gap"


def test_no_overlapping_chunks_at_all_is_no_tape_in_span_not_tape_gap():
    """refuter-3 #5193: zero overlap must be its own distinct status - a possible linker error, not the same
    signal as a genuine recording dropout."""
    chunks = [_chunk("c0", 10000, 300)]  # nowhere near the span
    span_start, span_end = T0, T0 + timedelta(seconds=100)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "no_tape_in_span"
    assert "0 of 1 chunks" in result["reason"]


def test_empty_chunk_list_is_no_tape_in_span():
    result = plan_crop([], T0, T0 + timedelta(seconds=100))
    assert result["status"] == "no_tape_in_span"


def test_overlapping_duplicate_chunks_deduped_by_key():
    chunks = [_chunk("c0", 0, 300), dict(_chunk("c0", 0, 300))]  # same key, appears twice
    span_start, span_end = T0 + timedelta(seconds=50), T0 + timedelta(seconds=100)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "ok"
    assert len(result["segments"]) == 1


def test_redundant_overlapping_window_coverage_trims_without_duplication():
    """Two hist-bulk windows can both list overlapping (but not identical) chunk coverage for the same real
    tape - the union must not double-count or re-decode already-covered time."""
    chunks = [_chunk("c0", 0, 300), _chunk("c1", 150, 300)]  # c1 overlaps c0 by 150s
    span_start, span_end = T0 + timedelta(seconds=0), T0 + timedelta(seconds=400)
    result = plan_crop(chunks, span_start, span_end)
    assert result["status"] == "ok"
    # c0 covers [0,300), c1 trimmed to start where c0 left off: local_start_s = 300-150=150
    assert result["segments"][0]["local_start_s"] == 0.0 and result["segments"][0]["local_end_s"] == 300.0
    assert result["segments"][1]["local_start_s"] == 150.0 and result["segments"][1]["local_end_s"] == 250.0


def test_span_end_before_start_raises():
    chunks = [_chunk("c0", 0, 300)]
    with pytest.raises(ValueError):
        plan_crop(chunks, T0 + timedelta(seconds=100), T0)
