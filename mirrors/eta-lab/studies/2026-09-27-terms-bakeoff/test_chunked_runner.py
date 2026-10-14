"""Tests for the chunking/stitching code that honours chunk_s (refuter-3 M2, bus #4927)."""
import pytest

from chunked_runner import chunk_windows, run_engine_for_track
from pinned_configs import PinnedConfigMismatch, reuse_config


def test_65s_at_30s_chunks_gives_exactly_3_windows_with_correct_bounds():
    # refuter-3's own test case, verbatim.
    assert chunk_windows(65, 30) == [(0, 30), (30, 60), (60, 65)]


def test_exact_multiple_does_not_produce_a_zero_length_tail():
    assert chunk_windows(60, 30) == [(0, 30), (30, 60)]


def test_short_clip_is_a_single_window():
    assert chunk_windows(12, 30) == [(0, 12)]


def test_zero_or_negative_duration_gives_no_windows():
    assert chunk_windows(0, 30) == []
    assert chunk_windows(-5, 30) == []


def test_overlap_reduces_stride():
    # 65s at chunk_s=30, overlap_s=5 -> stride 25: [0,30], [25,55], [50,65]... verify by construction, not by eye.
    windows = chunk_windows(65, 30, overlap_s=5)
    assert windows[0] == (0, 30)
    assert windows[1][0] == 25  # stride 25
    assert windows[-1][1] == 65  # last window still ends exactly at duration


def test_overlap_not_less_than_chunk_s_raises():
    with pytest.raises(ValueError):
        chunk_windows(65, 30, overlap_s=30)


# --- refuter-2 T1 (bus #4934) / refuter-3 T1 (bus #4936): tail-merge, matching reb's audio_utils.plan_chunks ---

def test_tiny_tail_merges_into_previous_chunk_not_sent_alone():
    # refuter-2's exact probe: a 1ms tail would otherwise be sent as its own chunk.
    assert chunk_windows(60.001, 30) == [(0, 30), (30, 60.001)]


def test_slightly_larger_tiny_tail_also_merges():
    # refuter-2's other exact probe: a 0.2s tail.
    assert chunk_windows(90.2, 30) == [(0, 30), (30, 60), (60, 90.2)]


def test_clinical1_median_duration_merges_to_a_single_window():
    # refuter-3's exact probe: clinical1's median stimulus (30.45s) - a 0.45s tail would otherwise be its own chunk.
    assert chunk_windows(30.45, 30) == [(0, 30.45)]


def test_a_real_second_chunk_is_not_merged_away():
    # a tail >= min_tail_s is a legitimate second chunk, not merged (clinical1's longest stimulus, 41.16s).
    windows = chunk_windows(41.16, 30)
    assert len(windows) == 2
    assert windows[1][1] - windows[1][0] == pytest.approx(11.16)


def test_single_chunk_case_is_untouched_even_if_short():
    # duration <= chunk_s: only one window ever exists, so there's nothing to merge, even if it's very short.
    assert chunk_windows(0.5, 30) == [(0, 0.5)]


def test_run_engine_for_track_shifts_local_segments_to_global_time():
    calls = []

    def fake_transcribe(t0, t1):
        calls.append((t0, t1))
        return [{"t0": 0.0, "t1": min(t1 - t0, 5.0), "text": f"chunk starting at {t0}"}]

    config = reuse_config("medasr")  # has chunk_s=30
    windows, segments = run_engine_for_track("medasr", config, duration_s=65, transcribe_chunk=fake_transcribe)

    assert windows == [(0, 30), (30, 60), (60, 65)]
    assert len(calls) == 3
    # each returned segment's t0 should be shifted by its chunk's global start
    assert [round(s["t0"], 3) for s in segments] == [0.0, 30.0, 60.0]
    assert [round(s["t1"], 3) for s in segments] == [5.0, 35.0, 65.0]


def test_run_engine_for_track_native_long_form_calls_once_on_full_clip():
    calls = []

    def fake_transcribe(t0, t1):
        calls.append((t0, t1))
        return [{"t0": 0.0, "t1": t1 - t0, "text": "whole clip"}]

    config = reuse_config("parakeet-med")  # has long_form="native", no chunk_s
    windows, segments = run_engine_for_track("parakeet-med", config, duration_s=781, transcribe_chunk=fake_transcribe)

    assert windows == [(0, 781)]
    assert calls == [(0, 781)]
    assert segments == [{"t0": 0.0, "t1": 781.0, "text": "whole clip"}]


def test_run_engine_for_track_refuses_a_drifted_config_before_transcribing():
    """refuter-3's other M2 ask: assert_pinned must run on the config the runner ACTUALLY received, before any
    transcription happens - a caller can't accidentally skip the guard."""
    calls = []

    def fake_transcribe(t0, t1):
        calls.append((t0, t1))
        return []

    drifted = reuse_config("medasr")
    drifted["decoding"] = "beam_search"  # not the pre-registered value -> different hash
    with pytest.raises(PinnedConfigMismatch):
        run_engine_for_track("medasr", drifted, duration_s=65, transcribe_chunk=fake_transcribe)
    assert calls == []  # transcribe_chunk must never be called once the config guard refuses


def test_run_engine_for_track_clamps_a_segment_that_overruns_its_own_chunk():
    """refuter-3's other note: segment ends must be clamped to the chunk they came from (reb clamps whisper the
    same way) - a model that over/undershoots its own window must not leak time into a neighbouring chunk."""
    def fake_transcribe(t0, t1):
        chunk_dur = t1 - t0
        # this segment claims to run 5s past the end of its own chunk, and 1s before its own start.
        return [{"t0": -1.0, "t1": chunk_dur + 5.0, "text": "overrun"}]

    config = reuse_config("medasr")
    windows, segments = run_engine_for_track("medasr", config, duration_s=65, transcribe_chunk=fake_transcribe)

    # first chunk is (0,30): clamped local [0,30] -> global [0,30]
    assert segments[0]["t0"] == pytest.approx(0.0)
    assert segments[0]["t1"] == pytest.approx(30.0)
    # second chunk is (30,60): clamped local [0,30] -> global [30,60]
    assert segments[1]["t0"] == pytest.approx(30.0)
    assert segments[1]["t1"] == pytest.approx(60.0)


def test_run_engine_for_track_sravaani_requires_dataset_set():
    def fake_transcribe(t0, t1):
        return [{"t0": 0.0, "t1": t1 - t0, "text": "x"}]

    config = reuse_config("sravaani", dataset_set="c")
    windows, segments = run_engine_for_track(
        "sravaani", config, duration_s=65, transcribe_chunk=fake_transcribe, dataset_set="c"
    )
    assert windows == [(0, 30), (30, 60), (60, 65)]
