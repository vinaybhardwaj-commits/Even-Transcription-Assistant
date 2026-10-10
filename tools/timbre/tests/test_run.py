"""run.py writes one parquet per model, merges, and resumes without redoing finished windows."""

from __future__ import annotations

import numpy as np

from tools.timbre.audio import synth_silence, synth_speech, write_wav
from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.extractors.base import Extractor
from tools.timbre.run import run


class _Counting(Extractor):
    scalar_names = ("loud_med",)

    def __init__(self):
        super().__init__(SPEC_BY_NAME["egemaps_v02.v1"], "cpu")
        self.calls = 0

    def extract(self, audio, sr):
        self.calls += 1
        return super().extract(audio, sr)

    def _extract(self, audio, sr):
        return {"loud_med": float(np.mean(np.abs(audio)))}, None, "rev-test"


class _Flaky(Extractor):
    scalar_names = ("loud_med",)

    def __init__(self):
        super().__init__(SPEC_BY_NAME["compare2016.v1"], "cpu")
        self.calls = 0

    def _extract(self, audio, sr):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("boom")
        return {"loud_med": 1.0}, None, "rev-test"


def _csv(path, rows):
    path.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role\n" + "\n".join(rows) + "\n",
        encoding="utf-8",
    )


def test_resume_skips_finished_windows_and_retries_errors(tmp_path):
    audio = tmp_path / "audio"
    audio.mkdir()
    write_wav(audio / "synthA_p0000000.wav", synth_speech(seconds=0.5))
    write_wav(audio / "synthA_p0000500.wav", synth_silence(seconds=0.5))
    csv = tmp_path / "windows.csv"
    _csv(
        csv,
        [
            "synthA_p0000000,ROOM-A,2026-01-01,en,open,0,0.5,0.4,patient",
            "synthA_p0000500,ROOM-A,2026-01-01,en,open,0.5,1.0,0.0,patient",
        ],
    )
    out = tmp_path / "results"
    counter = _Counting()
    manifest = run(csv, audio, out, models="egemaps", extractors={"egemaps_v02.v1": counter})
    assert counter.calls == 2
    assert manifest["models"]["egemaps_v02.v1"]["revision"] == "rev-test"
    again = run(csv, audio, out, models="egemaps", extractors={"egemaps_v02.v1": counter})
    assert counter.calls == 2
    assert again["models"]["egemaps_v02.v1"]["s_per_audio_s"] is not None
    merged = out / "features.parquet"
    assert merged.is_file()
    import pandas as pd

    frame = pd.read_parquet(merged)
    assert set(frame.window_id) == {"synthA_p0000000", "synthA_p0000500"}
    assert "egemaps_v02.v1__loud_med__delta_self" in frame.columns
    # silence is a finished nan row, not an error
    assert set(frame["egemaps_v02.v1__status"]) == {"ok", "nan"}

    flaky = _Flaky()
    run(csv, audio, out, models="compare", extractors={"compare2016.v1": flaky})
    assert flaky.calls == 1  # speech window raises; silence never reaches _extract
    run(csv, audio, out, models="compare", extractors={"compare2016.v1": flaky})
    assert flaky.calls == 2


def test_missing_audio_is_retried_when_the_file_appears(tmp_path):
    audio = tmp_path / "audio"
    audio.mkdir()
    csv = tmp_path / "windows.csv"
    _csv(csv, ["synthB_p0000000,ROOM-B,2026-01-02,en,open,0,1,0.5,patient"])
    out = tmp_path / "out"
    counter = _Counting()
    first = run(csv, audio, out, models="egemaps", extractors={"egemaps_v02.v1": counter})
    assert counter.calls == 0
    assert first["models"]["egemaps_v02.v1"]["errors"][0]["reason"] == "audio_missing"
    write_wav(audio / "synthB_p0000000.wav", synth_speech())
    second = run(csv, audio, out, models="egemaps", extractors={"egemaps_v02.v1": counter})
    assert counter.calls == 1
    assert second["models"]["egemaps_v02.v1"]["errors"] == []
