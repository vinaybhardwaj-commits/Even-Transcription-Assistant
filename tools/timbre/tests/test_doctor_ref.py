"""Doctor-reference selection and patient-minus-doctor columns, on synthetic audio only."""

from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
import pytest

from tools.timbre.audio import TARGET_SR, read_spans, synth_speech, write_wav
from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.doctor_ref import (
    DoctorRefConfig,
    DoctorRefError,
    DoctorRefSettings,
    Segment,
    Span,
    cosine,
    doctor_segment_spans,
    feature_kind,
    frames_to_spans,
    prepare_plans,
    relative_pair,
    select_nearest,
)
from tools.timbre.extractors.base import Extractor
from tools.timbre.nemotron_probs import pack_nlp
from tools.timbre.run import doctor_settings_from_args, main, run
from tools.timbre.windows import Window


def test_nearest_doctor_spans_respect_budget_and_horizon():
    chosen = select_nearest(
        [Span(70, 85), Span(112, 116), Span(200, 210)],
        100,
        110,
        DoctorRefConfig(budget_s=15, horizon_s=60),
    )
    # 200–210 is 90 s away. 112–116 (4 s, gap 2) is taken whole.
    # 70–85 is before the window, so the remaining 11 s is the end of it.
    assert [(s.start_s, s.end_s) for s in chosen] == [(74.0, 85.0), (112.0, 116.0)]
    assert sum(s.duration_s for s in chosen) == pytest.approx(15.0)
    outside = select_nearest([Span(0, 5), Span(200, 210)], 100, 110, DoctorRefConfig(15, 60))
    assert outside == []


def test_overlap_is_trimmed_toward_the_window():
    chosen = select_nearest([Span(0, 30)], 10, 12, DoctorRefConfig(budget_s=4, horizon_s=60))
    assert chosen[0].start_s == pytest.approx(9.0)
    assert chosen[0].end_s == pytest.approx(13.0)
    after = select_nearest([Span(10, 40)], 0, 1, DoctorRefConfig(budget_s=5, horizon_s=60))
    assert (after[0].start_s, after[0].end_s) == (10.0, 15.0)


def test_doctor_identity_uses_role_slot_and_uid():
    segs = [
        Segment("c", 0, 1, 0, "doctor", False, "d0000001"),
        Segment("c", 1, 2, 1, "doctor", False, "d0000002"),
        Segment("c", 2, 3, 0, "doctor", True, "d0000001"),  # overlap
        Segment("c", 3, 4, 3, "", False, ""),
        Segment("c", 4, 5, 9, "patient", False, ""),
    ]
    uid = doctor_segment_spans(segs, {"doctor_uid8": "d0000001"}, None)
    assert [(s.start_s, s.end_s) for s in uid] == [(0.0, 1.0)]
    # A doctor role is kept. The slot also keeps an unlabelled speaker 3. The
    # overlap doctor segment stays out.
    slot = doctor_segment_spans(segs, {"doctor_speaker_idx": "3"}, None)
    assert [(s.start_s, s.end_s) for s in slot] == [(0.0, 1.0), (1.0, 2.0), (3.0, 4.0)]
    unlabelled = [s for s in segs if not s.role]
    assert [(s.start_s, s.end_s) for s in doctor_segment_spans(unlabelled, {}, 3)] == [(3.0, 4.0)]


def test_feature_math_difference_ratio_and_cosine():
    assert feature_kind("egemaps_v02.v1", "F0semitoneFrom27.5Hz_sma3nz_amean") == "f0_level"
    assert feature_kind("egemaps_v02.v1", "F0semitoneFrom27.5Hz_sma3nz_stddevNorm") == "diff"
    assert feature_kind("egemaps_v02.v1", "loudness_sma3_amean") == "linear"
    assert feature_kind("egemaps_v02.v1", "equivalentSoundLevel_dBp") == "diff"
    assert feature_kind("egemaps_v02.v1", "VoicedSegmentsPerSec") == "linear"
    assert feature_kind("audeering_msp_dim.v1", "arousal") == "diff"
    assert feature_kind("wavlm_aniemore.v1", "neutral") is None
    diff, ratio = relative_pair(12.0, 0.0, "f0_level")
    assert diff == pytest.approx(12.0)
    assert ratio == pytest.approx(2.0)  # one octave in Hz
    diff, ratio = relative_pair(4.0, 2.0, "linear")
    assert diff == pytest.approx(2.0) and ratio == pytest.approx(2.0)
    diff, ratio = relative_pair(4.0, 0.0, "linear")
    assert diff == pytest.approx(4.0) and math.isnan(ratio)
    diff, ratio = relative_pair(0.4, 0.1, "diff")
    assert diff == pytest.approx(0.3) and ratio is None
    assert cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert cosine([1.0, 0.0], [2.0, 0.0]) == pytest.approx(1.0)
    assert math.isnan(cosine([0.0, 0.0], [1.0, 0.0]))


def test_nemotron_frames_become_spans_on_the_clip_clock():
    mask = np.array([False, False, True, True, False])
    spans = frames_to_spans(mask, frame_s=0.5, origin_s=10.0)
    assert spans == [Span(11.0, 12.0)]
    # Gap from a window at 0–0.5 s is 10.5 s, inside a 60 s horizon and outside a 5 s one.
    assert select_nearest(spans, 0.0, 0.5, DoctorRefConfig(15, 60)) == [Span(11.0, 12.0)]
    assert select_nearest(spans, 0.0, 0.5, DoctorRefConfig(15, 5)) == []


def test_read_spans_concatenates_a_slice(tmp_path):
    tone = np.linspace(-0.2, 0.2, TARGET_SR, dtype=np.float32)
    path = tmp_path / "clip.wav"
    write_wav(path, np.concatenate([tone, tone]))
    audio = read_spans(path, [(1.0, 1.5), (0.0, 0.25)])
    assert audio.shape == (int(0.75 * TARGET_SR),)
    assert float(np.max(np.abs(audio))) > 0.05


def test_prepare_segments_and_missing_doctor(tmp_path):
    clip = tmp_path / "clips"
    clip.mkdir()
    write_wav(clip / "synthA.wav", synth_speech(seconds=4.0))
    segs = tmp_path / "segments.jsonl"
    segs.write_text(
        "\n".join(
            [
                json.dumps({"clip_id": "synthA", "start_s": 1.0, "end_s": 2.5, "role": "doctor", "speaker_idx": 0}),
                json.dumps({"clip_id": "synthA", "start_s": 0.0, "end_s": 0.4, "role": "patient", "speaker_idx": 1}),
                json.dumps({"clip_id": "synthB", "start_s": 0.0, "end_s": 1.0, "role": "patient", "speaker_idx": 1}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    settings = DoctorRefSettings(clip, segments_path=segs, budget_s=15, horizon_s=60)
    plans = {p.window_id: p for p in prepare_plans([_window("synthA_p0000000", 0, 0.5), _window("synthB_p0000000", 0, 0.5, clip_id="synthB")], settings)}
    assert plans["synthA_p0000000"].status == "ok"
    assert plans["synthA_p0000000"].spans == (Span(1.0, 2.5),)
    assert plans["synthA_p0000000"].source == "segments"
    assert plans["synthB_p0000000"].reason == "doctor_unidentified"
    assert plans["synthB_p0000000"].status == "nan"


def test_run_caches_one_doctor_span_and_writes_relative_columns(tmp_path):
    audio = tmp_path / "windows"
    clips = tmp_path / "clips"
    audio.mkdir()
    clips.mkdir()
    write_wav(audio / "synthA_p0000000.wav", synth_speech(seconds=0.5, f0=180))
    write_wav(audio / "synthA_p0002500.wav", synth_speech(seconds=0.5, f0=180))
    clip = np.concatenate([synth_speech(seconds=1.0, f0=f) for f in (100.0, 140.0, 180.0, 110.0)])
    write_wav(clips / "synthA.wav", clip)
    csv = tmp_path / "windows.csv"
    csv.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role\n"
        "synthA_p0000000,ROOM-A,2026-01-01,en,open,0,0.5,0.4,patient\n"
        "synthA_p0002500,ROOM-A,2026-01-01,en,open,2.5,3.0,0.4,patient\n",
        encoding="utf-8",
    )
    segs = tmp_path / "segments.jsonl"
    segs.write_text(
        json.dumps({"clip_id": "synthA", "start_s": 1.0, "end_s": 2.0, "speaker_idx": 0, "role": "doctor"}) + "\n",
        encoding="utf-8",
    )
    counter = _Duration()
    manifest = run(
        csv,
        audio,
        tmp_path / "out",
        models="egemaps",
        extractors={"egemaps_v02.v1": counter},
        doctor_ref=DoctorRefSettings(clips, segments_path=segs, budget_s=15, horizon_s=60),
    )
    # Two patient windows, one shared doctor span.
    assert counter.calls == 3
    stats = manifest["models"]["egemaps_v02.v1"]["doctor_ref"]
    assert stats["n_extracts"] == 1
    assert stats["n_cache_hits"] == 1
    assert stats["n_ok"] == 2
    frame = pd.read_parquet(tmp_path / "out" / "features.parquet")
    col = "egemaps_v02.v1__loudness_sma3_amean"
    f0 = "egemaps_v02.v1__F0semitoneFrom27.5Hz_sma3nz_amean"
    assert list(frame[f"{col}__rel_doctor"]) == pytest.approx([-0.5, -0.5])
    assert list(frame[f"{col}__rel_doctor_ratio"]) == pytest.approx([0.5, 0.5])
    assert list(frame[f"{f0}__rel_doctor"]) == pytest.approx([-6.0, -6.0])
    assert list(frame[f"{f0}__rel_doctor_ratio"]) == pytest.approx([2.0 ** -0.5, 2.0 ** -0.5])
    assert list(frame["egemaps_v02.v1__rel_doctor_cosine"]) == pytest.approx([1.0, 1.0])
    # Difference does not wait for two earlier patient windows. The z-score delta does.
    assert frame["egemaps_v02.v1__loudness_sma3_amean__delta_self"].isna().all()
    assert list(frame["doctor_ref_source"]) == ["segments", "segments"]
    assert list(frame["doctor_ref_status"]) == ["ok", "ok"]
    assert float(frame["doctor_ref_s"].iloc[0]) == pytest.approx(1.0)


def test_run_nemotron_path(tmp_path):
    audio = tmp_path / "windows"
    clips = tmp_path / "clips"
    nlp = tmp_path / "nlp"
    audio.mkdir()
    clips.mkdir()
    nlp.mkdir()
    write_wav(audio / "synthN_p0000000.wav", synth_speech(seconds=0.5))
    write_wav(clips / "synthN.wav", np.concatenate([synth_speech(seconds=1.0, f0=f) for f in (100.0, 140.0, 120.0, 110.0)]))
    # 0.5 s frames. Doctor slot 0 owns frames 2 and 3 → clip time [1.0, 2.0].
    probs = np.array(
        [
            [0.05, 0.90],
            [0.05, 0.90],
            [0.95, 0.02],
            [0.95, 0.02],
            [0.10, 0.80],
            [0.10, 0.80],
            [0.10, 0.80],
            [0.10, 0.80],
        ],
        dtype=np.float64,
    )
    (nlp / "synthN.nlp").write_bytes(pack_nlp(probs, frame_ms=500))
    csv = tmp_path / "windows.csv"
    csv.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role,diar_src,doctor_slot\n"
        "synthN_p0000000,ROOM-N,2026-01-01,en,open,0,0.5,0.4,patient,nemotron,0\n",
        encoding="utf-8",
    )
    counter = _Duration()
    run(
        csv,
        audio,
        tmp_path / "out",
        models="egemaps",
        extractors={"egemaps_v02.v1": counter},
        doctor_ref=DoctorRefSettings(clips, nemotron_dir=nlp, budget_s=15, horizon_s=60),
    )
    frame = pd.read_parquet(tmp_path / "out" / "features.parquet")
    assert frame.loc[0, "doctor_ref_source"] == "nemotron"
    assert frame.loc[0, "doctor_ref_status"] == "ok"
    assert float(frame.loc[0, "doctor_ref_s"]) == pytest.approx(1.0)
    assert float(frame.loc[0, "egemaps_v02.v1__loudness_sma3_amean__rel_doctor"]) == pytest.approx(-0.5)
    assert counter.calls == 2


def test_cli_doctor_ref_requires_clip_audio(tmp_path):
    from argparse import Namespace

    assert doctor_settings_from_args(Namespace(doctor_ref=False)) is None
    with pytest.raises(DoctorRefError, match="clip-audio-dir"):
        doctor_settings_from_args(Namespace(doctor_ref=True, clip_audio_dir=None))
    with pytest.raises(SystemExit) as exc:
        main(["--windows", "w.csv", "--audio-dir", "a", "--out", str(tmp_path), "--doctor-ref", "--models", "egemaps"])
    assert exc.value.code == 2


def test_no_source_is_an_error(tmp_path):
    with pytest.raises(DoctorRefError, match="no doctor-reference source"):
        prepare_plans(
            [_window("synthA_p0000000", 0, 1)],
            DoctorRefSettings(tmp_path, segments_path=None, nemotron_dir=None),
        )


class _Duration(Extractor):
    """Feature values are the audio duration, so the relative numbers do not depend on the waveform."""

    def __init__(self):
        super().__init__(SPEC_BY_NAME["egemaps_v02.v1"], "cpu")
        self.calls = 0

    def extract(self, audio, sr):
        self.calls += 1
        return super().extract(audio, sr)

    def _extract(self, audio, sr):
        dur = float(len(audio) / sr) if sr else 0.0
        return {
            "loudness_sma3_amean": dur,
            "F0semitoneFrom27.5Hz_sma3nz_amean": dur * 12.0,
        }, [dur, 0.0], "rev-doctor"


def _window(wid: str, start: float, end: float, clip_id: str = "synthA", **meta) -> Window:
    return Window(
        window_id=wid,
        room="ROOM-A",
        date="2026-01-01",
        lang="en",
        phase="open",
        start_s=start,
        end_s=end,
        patient_speech_s=0.4,
        role="patient",
        clip_id=clip_id,
        audio_path=None,
        meta=meta,
    )
