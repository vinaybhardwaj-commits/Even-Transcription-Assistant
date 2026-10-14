"""Tests for the REB track builder (refuter-3 T2, bus #4936/#4938)."""
import pytest

from track_builder import build_track
from pinned_configs import PinnedConfigMismatch, reuse_config


def test_ok_status_and_ms_conversion():
    def fake_transcribe(t0, t1):
        return [{"t0": 0.0, "t1": 2.5, "text": "hello"}]

    track = build_track(
        engine="medasr", config=reuse_config("medasr"), model="google/medasr", version="v1",
        machine="hf-l4", window_id="c_22_001", layer="terms", duration_s=10, transcribe_chunk=fake_transcribe,
    )
    assert track["status"] == "ok"
    assert track["schema"] == "reb.track.v1"
    assert track["segments"] == [{"t0_ms": 0, "t1_ms": 2500, "text": "hello"}]
    assert track["config_hash"] == "e2b69f8a"


def test_empty_status_when_no_segments_returned():
    def fake_transcribe(t0, t1):
        return []

    track = build_track(
        engine="medasr", config=reuse_config("medasr"), model="google/medasr", version="v1",
        machine="hf-l4", window_id="c_22_002", layer="terms", duration_s=10, transcribe_chunk=fake_transcribe,
    )
    assert track["status"] == "empty"
    assert track["segments"] == []
    assert "reason" not in track


def test_failed_status_when_transcribe_raises():
    def fake_transcribe(t0, t1):
        raise RuntimeError("CUDA out of memory")

    track = build_track(
        engine="medasr", config=reuse_config("medasr"), model="google/medasr", version="v1",
        machine="hf-l4", window_id="c_22_003", layer="terms", duration_s=10, transcribe_chunk=fake_transcribe,
    )
    assert track["status"] == "failed"
    assert "CUDA out of memory" in track["reason"]
    assert track["segments"] == []


def test_pinned_config_mismatch_is_never_swallowed_as_failed():
    """Config drift must stop the caller loudly, never quietly become a routine 'failed' track."""
    drifted = reuse_config("medasr")
    drifted["decoding"] = "beam_search"

    def fake_transcribe(t0, t1):
        return []

    with pytest.raises(PinnedConfigMismatch):
        build_track(
            engine="medasr", config=drifted, model="google/medasr", version="v1",
            machine="hf-l4", window_id="c_22_004", layer="terms", duration_s=10, transcribe_chunk=fake_transcribe,
        )


def test_ms_rounding_and_extra_fields_pass_through():
    def fake_transcribe(t0, t1):
        return [{"t0": 0.1234, "t1": 1.9996, "text": "x", "conf": 0.87, "lang": "en"}]

    track = build_track(
        engine="medasr", config=reuse_config("medasr"), model="google/medasr", version="v1",
        machine="hf-l4", window_id="c_22_005", layer="terms", duration_s=10, transcribe_chunk=fake_transcribe,
    )
    seg = track["segments"][0]
    assert seg["t0_ms"] == 123
    assert seg["t1_ms"] == 2000
    assert seg["conf"] == 0.87
    assert seg["lang"] == "en"


def test_multi_chunk_clip_produces_one_ok_track_with_all_segments():
    def fake_transcribe(t0, t1):
        return [{"t0": 0.0, "t1": min(t1 - t0, 5.0), "text": f"seg@{t0}"}]

    track = build_track(
        engine="whisper-med-merged", config=reuse_config("whisper-med-merged"), model="taphuynh/whisper-large-en-medical-2607.26-merged",
        version="v1", machine="hf-l4", window_id="c_22_006", layer="terms", duration_s=65,
        transcribe_chunk=fake_transcribe,
    )
    assert track["status"] == "ok"
    assert len(track["segments"]) == 3  # 65s at 30s chunks (tail=5s, not merged) -> 3 windows
