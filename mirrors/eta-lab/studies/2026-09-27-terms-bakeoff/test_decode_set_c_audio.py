"""Tests for decode_set_c_audio.py. The real-data tests decode real 'ok' consults end to end (structural checks
only - duration/sha256/file existence; no audio content is inspected, printed, or committed anywhere - the
decoded wav is explicitly deleted at the end of each test, not left for pytest's tmp_path rotation)."""
import json
import os

import pytest

from decode_set_c_audio import r2_key_to_local_path, stage_consult, stage_all
from build_set_c_crop_plan import build_plan

REAL_AUDIO_PRESENT = os.path.isdir(os.path.expanduser("~/eta-data/hist-mining/audio"))


def test_r2_key_to_local_path_replaces_slashes_with_double_underscore():
    path = r2_key_to_local_path("bench/opd-7-y74w/2026-09-22/bs_m6nq7upz/chunk_00000.webm", raw_audio_root="/root")
    assert path == "/root/bench__opd-7-y74w__2026-09-22__bs_m6nq7upz__chunk_00000.webm"


@pytest.mark.skipif(not REAL_AUDIO_PRESENT, reason="real hist-mining audio cache not present on this box")
def test_stage_one_real_ok_consult_end_to_end(tmp_path):
    results, _excluded = build_plan()
    ok_results = [r for r in results if r["status"] == "ok"]
    assert ok_results, "expected at least one ok consult in the real plan"
    result = ok_results[0]

    row = stage_consult(result, str(tmp_path))
    try:
        assert row["consult_id"] == result["consult_id"]
        assert os.path.exists(row["wav_path"])
        assert row["sha256"] and len(row["sha256"]) == 64
        assert abs(row["decoded_duration_s"] - row["segment_sum_duration_s"]) <= 1.0
        assert row["n_segments"] == len(result["segments"])
        assert row["sample_rate"] == 16000

        import soundfile as sf
        info = sf.info(row["wav_path"])
        assert info.samplerate == 16000
        assert info.channels == 1
    finally:
        os.remove(row["wav_path"])


@pytest.mark.skipif(not REAL_AUDIO_PRESENT, reason="real hist-mining audio cache not present on this box")
def test_stage_one_real_multi_segment_consult(tmp_path):
    """A consult whose crop spans >1 chunk - exercises the concatenation path, not just single-segment decode."""
    results, _excluded = build_plan()
    multi = [r for r in results if r["status"] == "ok" and len(r["segments"]) > 1]
    assert multi, "expected at least one multi-segment ok consult in the real plan"
    result = multi[0]

    row = stage_consult(result, str(tmp_path))
    try:
        assert row["n_segments"] > 1
        assert abs(row["decoded_duration_s"] - row["segment_sum_duration_s"]) <= 1.0
    finally:
        os.remove(row["wav_path"])


# --- D1 (refuter-3 #5208): a real consult with a tolerated tape gap must not be wrongly refused ---

@pytest.mark.skipif(not REAL_AUDIO_PRESENT, reason="real hist-mining audio cache not present on this box")
def test_stage_consult_with_tolerated_gap_is_not_wrongly_refused(tmp_path):
    """The exact real bug refuter-3 found: consult GQlym1Pu... has a 1.26s tolerated (<=2s, ADDENDUM-2 G1) gap
    inside its span - span_duration_s=815.0 vs segment_sum_duration_s=813.739. Comparing decoded duration
    against the full SPAN (the old, wrong check) would refuse this real consult; comparing against the
    segment-sum (the fix) must not."""
    results, _excluded = build_plan()
    gapped = next((r for r in results if r["status"] == "ok" and r["consult_id"].startswith("GQlym1Pu")), None)
    assert gapped is not None, "expected the known tolerated-gap consult to still be present and ok"
    assert abs(gapped["duration_s"] - sum(s["local_end_s"] - s["local_start_s"] for s in gapped["segments"])) > 1.0

    row = stage_consult(gapped, str(tmp_path))
    try:
        assert abs(row["decoded_duration_s"] - row["segment_sum_duration_s"]) <= 1.0
        assert row["span_duration_s"] > row["segment_sum_duration_s"]  # the tolerated gap is visible in the record
    finally:
        os.remove(row["wav_path"])


# --- D2 (refuter-3 #5208): a failed consult must never leave a file in audio/ ---

def test_failed_consult_leaves_no_file_in_audio_dir(tmp_path, monkeypatch):
    import decode_set_c_audio as m

    def _fake_decode_consult(segments, tmp_dir, raw_audio_root, sample_rate):
        return [0.0] * (sample_rate * 1), ["fake.webm"]  # 1s of silence - deliberately short vs the planned span

    monkeypatch.setattr(m, "decode_consult", _fake_decode_consult)
    fake_result = {
        "consult_id": "fake_consult", "day": "22", "room_id": "room_x",
        "span_start": "s", "span_end": "e", "duration_s": 100.0,
        "segments": [{"r2_key": "fake.webm", "local_start_s": 0.0, "local_end_s": 100.0}],
    }
    with pytest.raises(ValueError, match="refusing to stage"):
        m.stage_consult(fake_result, str(tmp_path))

    audio_dir = os.path.join(str(tmp_path), "audio")
    assert not os.path.exists(os.path.join(audio_dir, "fake_consult.wav"))
    tmp_dir = os.path.join(str(tmp_path), "_tmp")
    assert not any(f.startswith("fake_consult_") for f in os.listdir(tmp_dir)) if os.path.isdir(tmp_dir) else True


# --- D3 (refuter-3 #5208): manifest.jsonl is refused if it already exists; no silent append ---

def test_stage_all_refuses_if_manifest_already_exists(tmp_path, monkeypatch):
    import decode_set_c_audio as m
    os.makedirs(str(tmp_path), exist_ok=True)
    with open(os.path.join(str(tmp_path), "manifest.jsonl"), "w") as f:
        f.write("{}\n")
    with pytest.raises(FileExistsError):
        m.stage_all(stage_dir=str(tmp_path))


def test_stage_all_refuses_leftover_manifest_tmp_from_crashed_run(tmp_path):
    """refuter-3 #5213 nit: a crashed prior run's manifest.jsonl.tmp (no manifest.jsonl) must not be silently
    overwritten by a fresh run - it's evidence of a crash, not a normal state to plow through."""
    import decode_set_c_audio as m
    os.makedirs(str(tmp_path), exist_ok=True)
    with open(os.path.join(str(tmp_path), "manifest.jsonl.tmp"), "w") as f:
        f.write('{"consult_id": "leftover"}\n')
    with pytest.raises(FileExistsError, match="crashed prior run"):
        m.stage_all(stage_dir=str(tmp_path))


def test_stage_all_refuses_leftover_audio_dir_from_crashed_run(tmp_path):
    """refuter-3 #5213 nit: a crashed prior run's audio/*.wav (no manifest.jsonl) must not silently mix with a
    fresh run's output - a consult that fails the second time would otherwise leave a stale, unlisted file."""
    import decode_set_c_audio as m
    audio_dir = os.path.join(str(tmp_path), "audio")
    os.makedirs(audio_dir, exist_ok=True)
    with open(os.path.join(audio_dir, "leftover.wav"), "wb") as f:
        f.write(b"")
    with pytest.raises(FileExistsError, match="crashed prior run"):
        m.stage_all(stage_dir=str(tmp_path))


def test_stage_all_allows_empty_audio_dir_with_no_manifest(tmp_path, monkeypatch):
    """An empty (or absent) audio/ dir with no manifest.jsonl/.tmp is a genuinely fresh stage_dir, not a crash
    leftover - must not be refused."""
    import decode_set_c_audio as m
    os.makedirs(os.path.join(str(tmp_path), "audio"), exist_ok=True)
    monkeypatch.setattr(m, "build_plan", lambda: ([], []))
    staged, failed = m.stage_all(stage_dir=str(tmp_path))
    assert staged == [] and failed == []


def test_stage_all_writes_one_coherent_manifest(tmp_path, monkeypatch):
    import decode_set_c_audio as m

    fake_results = [
        {"consult_id": "a", "day": "22", "room_id": "room_x", "span_start": "s", "span_end": "e",
         "duration_s": 1.0, "status": "ok", "segments": []},
    ]
    monkeypatch.setattr(m, "build_plan", lambda: (fake_results, []))

    def _fake_stage_consult(result, stage_dir, raw_audio_root=None, sample_rate=16000):
        return {"consult_id": result["consult_id"], "decoded_duration_s": 1.0, "segment_sum_duration_s": 1.0}
    monkeypatch.setattr(m, "stage_consult", _fake_stage_consult)

    staged, failed = m.stage_all(stage_dir=str(tmp_path))
    assert len(staged) == 1
    assert failed == []
    manifest_path = os.path.join(str(tmp_path), "manifest.jsonl")
    assert os.path.exists(manifest_path)
    assert not os.path.exists(manifest_path + ".tmp")  # renamed away, not left behind
    with open(manifest_path) as f:
        rows = [json.loads(line) for line in f]
    assert len(rows) == 1
