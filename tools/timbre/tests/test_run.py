"""run.py writes one parquet per model, merges, and resumes without redoing finished windows."""

from __future__ import annotations

import numpy as np
import pandas as pd

from tools.timbre.audio import synth_silence, synth_speech, write_wav
from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import InsufficientMemory
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


def test_extra_csv_columns_are_merged_once(tmp_path):
    """outcome, doctor_uid8, source_pack, diar_src live on every per-model parquet.

    They must survive as one column from the windows table, not a MergeError
    and not outcome_x / outcome_y.
    """
    audio = tmp_path / "audio"
    audio.mkdir()
    write_wav(audio / "synthC_p0000000.wav", synth_speech(seconds=0.5))
    write_wav(audio / "synthC_p0000500.wav", synth_speech(seconds=0.5))
    csv = tmp_path / "windows.csv"
    csv.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role,"
        "outcome,doctor_uid8,source_pack,diar_src\n"
        "synthC_p0000000,ROOM-C,2026-01-03,en,open,0,0.5,0.4,patient,accept,d0000001,pack-a,nemotron\n"
        "synthC_p0000500,ROOM-C,2026-01-03,en,open,0.5,1.0,0.4,patient,defer,d0000001,pack-a,nemotron\n",
        encoding="utf-8",
    )
    out = tmp_path / "results"
    run(
        csv,
        audio,
        out,
        models="egemaps,compare",
        extractors={
            "egemaps_v02.v1": _Counting(),
            "compare2016.v1": _FlakyOk(),
        },
    )
    frame = pd.read_parquet(out / "features.parquet")
    assert list(frame["outcome"]) == ["accept", "defer"]
    assert list(frame["doctor_uid8"]) == ["d0000001", "d0000001"]
    assert list(frame["source_pack"]) == ["pack-a", "pack-a"]
    assert list(frame["diar_src"]) == ["nemotron", "nemotron"]
    assert "outcome_x" not in frame.columns and "outcome_y" not in frame.columns
    assert "egemaps_v02.v1__loud_med" in frame.columns
    assert "compare2016.v1__loud_med" in frame.columns
    assert list(frame.columns).count("outcome") == 1


class _FlakyOk(Extractor):
    scalar_names = ("loud_med",)

    def __init__(self):
        super().__init__(SPEC_BY_NAME["compare2016.v1"], "cpu")

    def _extract(self, audio, sr):
        return {"loud_med": 0.5}, None, "rev-b"


class _Hungry(Extractor):
    def __init__(self):
        super().__init__(SPEC_BY_NAME["compare2016.v1"], "cpu")
        self.calls = 0

    def _extract(self, audio, sr):
        self.calls += 1
        raise InsufficientMemory(self.spec.name, 99.0, 0.1)


def test_ram_gate_skips_model_and_continues(tmp_path, monkeypatch, capsys):
    audio = tmp_path / "audio"
    audio.mkdir()
    write_wav(audio / "synthD_p0000000.wav", synth_speech(seconds=0.5))
    csv = tmp_path / "windows.csv"
    _csv(csv, ["synthD_p0000000,ROOM-D,2026-01-04,en,open,0,0.5,0.4,patient"])
    monkeypatch.setattr("tools.timbre.run.mem_available_gb", lambda: 0.1)

    def _refuse_build(name, device="cpu"):
        raise AssertionError(f"should not build {name}")

    monkeypatch.setattr("tools.timbre.extractors.base.build_extractor", _refuse_build)
    counter = _Counting()
    hungry = _Hungry()
    manifest = run(
        csv,
        audio,
        tmp_path / "results",
        models="all",
        extractors={
            "egemaps_v02.v1": counter,
            "compare2016.v1": hungry,
        },
    )
    assert counter.calls == 1
    assert hungry.calls == 1
    assert manifest["models"]["egemaps_v02.v1"]["completed"] == ["synthD_p0000000"]
    skipped = manifest["models"]["compare2016.v1"]
    assert skipped["skipped"] is True
    assert "compare2016.v1" in skipped["reason"]
    for name in ("whisper_large_v3_encoder.v1", "voxprofile_whisper_dim.v1"):
        row = manifest["models"][name]
        assert row["skipped"] is True
        assert "RAM" in row["reason"]
        assert row["completed"] == []
    err = capsys.readouterr().err
    assert "skip whisper_large_v3_encoder.v1:" in err
    assert "skip voxprofile_whisper_dim.v1:" in err
    assert "skip compare2016.v1:" in err
    frame = pd.read_parquet(tmp_path / "results" / "features.parquet")
    assert "egemaps_v02.v1__loud_med" in frame.columns
    assert "compare2016.v1__loud_med" not in frame.columns
