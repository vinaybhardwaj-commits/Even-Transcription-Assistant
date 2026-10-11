"""Windows CSV plus per-window wav/flac."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from tools.timbre.audio import read_audio, synth_speech, write_wav
from tools.timbre.windows import WindowsError, load_windows

FIX = Path(__file__).resolve().parents[1] / "fixtures"


def test_committed_fixture_loads_and_is_16k_mono():
    rows = load_windows(FIX / "windows.csv", FIX / "audio")
    assert [r.window_id for r in rows] == ["synth_consultA_p0000000", "synth_consultA_p0001000"]
    assert rows[0].clip_id == "synth_consultA"
    assert rows[0].audio_path is not None
    assert rows[1].audio_path is None  # listed, no file committed for it
    assert rows[0].lang == "en"
    audio, sr = read_audio(rows[0].audio_path)
    assert sr == 16000
    assert audio.ndim == 1
    assert audio.size == 16000


def test_flac_and_wav_and_rejects_bad_audio(tmp_path):
    import soundfile as sf

    csv = tmp_path / "windows.csv"
    csv.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s\n"
        "synth_b_p0002000,ROOM-B,2026-01-02,,close,2,3,0.5\n"
        "synth_b_p0003000,ROOM-B,2026-01-02,kn,close,3,4,0.5\n",
        encoding="utf-8",
    )
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    sf.write(audio_dir / "synth_b_p0002000.flac", synth_speech(seconds=0.5), 16000, format="FLAC")
    sf.write(audio_dir / "synth_b_p0003000.wav", np.zeros(8000, dtype=np.float32), 8000)
    rows = load_windows(csv, audio_dir)
    assert rows[0].audio_path.suffix == ".flac"
    assert rows[0].lang == ""
    assert rows[1].audio_path.suffix == ".wav"
    read_audio(rows[0].audio_path)
    with pytest.raises(ValueError, match="16000"):
        read_audio(rows[1].audio_path)


def test_refuses_stereo(tmp_path):
    import soundfile as sf

    path = tmp_path / "stereo.wav"
    sf.write(path, np.zeros((1600, 2), dtype=np.float32), 16000)
    with pytest.raises(ValueError, match="mono"):
        read_audio(path)


def test_missing_column_and_bad_id(tmp_path):
    bad = tmp_path / "bad.csv"
    bad.write_text("window_id,room\nonly,ROOM\n", encoding="utf-8")
    with pytest.raises(WindowsError, match="missing columns"):
        load_windows(bad)
    path_id = tmp_path / "path.csv"
    path_id.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s\n"
        "../x,R,2026-01-01,en,open,0,1,1\n",
        encoding="utf-8",
    )
    with pytest.raises(WindowsError, match="path"):
        load_windows(path_id)


def test_write_wav_round_trip(tmp_path):
    path = tmp_path / "a.wav"
    write_wav(path, synth_speech(seconds=0.25))
    audio, sr = read_audio(path)
    assert sr == 16000
    assert audio.size == 4000
