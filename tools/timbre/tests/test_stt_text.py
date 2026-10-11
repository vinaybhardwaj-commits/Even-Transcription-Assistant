"""Patient-speaker selection on a synthetic Scribe-shaped export."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.timbre.stt_text import load_stt_windows, patient_text_from_window
from tools.timbre.text_lane import from_stt_file

FIX = (
    {
        "window_id": "synth_w1",
        "speakers": [
            {"idx": 0, "type": "clinician"},
            {"idx": 1, "type": "patient"},
        ],
        "turns": [
            {"speaker_idx": 0, "role": "clinician", "start_ms": 0, "end_ms": 400, "text": "How is the cough?"},
            {"speaker_idx": 1, "role": "unattributed", "start_ms": 900, "end_ms": 1200, "text": "I slept badly."},
            {
                "speaker_idx": 1,
                "role": "unattributed",
                "start_ms": 400,
                "end_ms": 800,
                "text": "Mr Example Person says it is worse at night.",
            },
        ],
    }
)


def test_patient_lines_follow_speaker_type_not_unattributed_role():
    got = patient_text_from_window(FIX)
    assert got.status == "ok"
    assert got.n_turns == 2
    assert "How is the cough?" not in got.text
    assert got.text.index("worse at night") < got.text.index("slept badly")
    assert "Example" not in got.text
    assert "[PATIENT_NAME]" in got.text


def test_unattributed_without_a_patient_type_is_not_the_patient():
    window = {
        "window_id": "synth_w2",
        "turns": [
            {"speaker_idx": 3, "role": "unattributed", "start_ms": 0, "end_ms": 10, "text": "staff talk"},
        ],
    }
    got = patient_text_from_window(window)
    assert got.status == "no_patient_speaker"
    assert got.text == ""


def test_explicit_patient_role_is_kept_and_clinician_voiceprint_wins():
    kept = patient_text_from_window(
        {
            "window_id": "synth_w3",
            "turns": [{"role": "patient", "start_ms": 0, "end_ms": 5, "text": "the fever started yesterday"}],
        }
    )
    assert kept.status == "ok"
    assert "fever" in kept.text
    conflict = patient_text_from_window(
        {
            "window_id": "synth_w4",
            "speakers": [{"idx": 1, "type": "patient"}],
            "turns": [{"speaker_idx": 1, "role": "clinician", "text": "I will prescribe rest", "start_ms": 0, "end_ms": 5}],
        }
    )
    assert conflict.status == "no_patient_speaker"


def test_whole_window_transcript_is_not_patient_text():
    got = patient_text_from_window(
        {"window_id": "synth_w5", "transcript_english": "doctor and patient mixed together"}
    )
    assert got.status == "not_patient_attributed"
    assert got.text == ""


def test_cue_payload_shape_and_summary_omits_text(tmp_path):
    window = {
        "window_id": "synth_w6",
        "speakers": [{"idx": 2, "type": "patient"}],
        "transcript_segments": [
            {"speaker_idx": 2, "start_ms": 0, "end_ms": 20, "payload": {"text": "the pain is in the knee"}},
        ],
    }
    path = tmp_path / "stt.json"
    path.write_text(json.dumps(window), encoding="utf-8")
    loaded = load_stt_windows(path)
    assert patient_text_from_window(loaded[0]).text == "the pain is in the knee"
    summary = from_stt_file(path, tmp_path / "out.jsonl")
    blob = json.dumps(summary)
    assert "knee" not in blob
    assert summary["ok"] == 1
    assert summary["patient_turns"] == 1
    out = (tmp_path / "out.jsonl").read_text(encoding="utf-8")
    assert "knee" in out


def test_committed_fixture_is_synthetic_and_patient_only():
    path = Path(__file__).resolve().parents[1] / "fixtures" / "text" / "stt_window.json"
    got = patient_text_from_window(load_stt_windows(path)[0])
    assert got.status == "ok"
    assert got.text == "It is worse at night."
    assert "How is the cough" not in got.text


def test_unsafe_window_id_is_rejected():
    with pytest.raises(ValueError, match="safe id"):
        patient_text_from_window({"window_id": "this is a sentence not an id", "turns": []})
