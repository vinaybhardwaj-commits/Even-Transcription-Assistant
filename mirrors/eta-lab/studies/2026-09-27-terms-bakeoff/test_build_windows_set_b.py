"""Tests for the set (b) window-list builder (ADDENDUM-21 scored-launcher work)."""
import os

import pytest

from build_windows_set_b import list_set_b_windows, ROOM_ID, IST_DATE


def test_lists_only_wav_files_sorted(tmp_path):
    (tmp_path / "clin_en_2.wav").write_bytes(b"")
    (tmp_path / "clin_en_1.wav").write_bytes(b"")
    (tmp_path / "clin_en_1.truth.json").write_bytes(b"{}")  # must be ignored, not a wav
    windows = list_set_b_windows(str(tmp_path))
    assert [w["window_id"] for w in windows] == ["clin_en_1", "clin_en_2"]


def test_window_id_strips_only_the_wav_extension(tmp_path):
    (tmp_path / "clin_en_1__babble_snr5.wav").write_bytes(b"")
    windows = list_set_b_windows(str(tmp_path))
    assert windows[0] == {
        "window_id": "clin_en_1__babble_snr5", "audio_file": "clin_en_1__babble_snr5.wav",
        "room_id": ROOM_ID, "ist_date": IST_DATE,
    }


def test_missing_dir_raises_not_silently_empty(tmp_path):
    with pytest.raises(FileNotFoundError):
        list_set_b_windows(str(tmp_path / "does-not-exist"))


def test_real_clinical1_matches_rebs_live_suite_clinical1_room_exactly():
    """Structural check only (window_ids, no audio/text content) - same convention as test_span_cap.py's real-data
    check. Confirms the builder's window_ids are byte-identical to reb's actual REB room dir listing (ADDENDUM-20's
    finding), which is what makes it safe to append a new track into those same windows."""
    stimuli_dir = "/home/eta/eta-data/diag-rig/stimuli/clinical1"
    real_room_dir = "/home/eta/eta-data/reb/2026-09-27/suite-clinical1"
    if not (os.path.isdir(stimuli_dir) and os.path.isdir(real_room_dir)):
        pytest.skip("real clinical1/reb data not present on this box")
    mine = {w["window_id"] for w in list_set_b_windows(stimuli_dir)}
    real = set(os.listdir(real_room_dir))
    assert mine == real
    assert len(mine) == 192
