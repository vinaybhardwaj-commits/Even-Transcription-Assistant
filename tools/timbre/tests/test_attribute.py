"""Speaker attribution on synthetic multilingual windows. No real transcript."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from tools.timbre.attribute import attribute_window
from tools.timbre.stt_text import load_stt_windows
from tools.timbre.text_lane import attribute_file

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "text" / "multilingual.json"


def test_word_timestamps_keep_the_patient_and_drop_the_doctor():
    got = attribute_window(load_stt_windows(FIX)[0])
    assert got.status == "ok"
    assert got.method == "word_timestamps"
    assert "ನಿದ್ದೆ" in got.text
    assert "ಬರುತ್ತಿಲ್ಲ" in got.text
    assert "ಕೆಮ್ಮು" not in got.text
    assert "ಹೇಗಿದೆ" not in got.text
    assert got.gloss is not None
    assert "sleep" in got.gloss
    assert "cough" not in got.gloss
    assert got.language == "kn"
    assert got.code_mixed is False
    assert got.basis_language == "native+gloss"
    assert got.coverage_pct == 50
    assert got.attribution_confidence == 1
    blob = json.dumps(got.as_row())
    assert "ಕೆಮ್ಮು" not in blob


def test_proportional_split_is_less_confident_than_word_timestamps():
    window = {
        "window_id": "synth_prop",
        "turns": [
            {
                "start_ms": 0,
                "end_ms": 1000,
                "text": "aaaa bbbb cccc dddd",
                "gloss": "one two three four",
            }
        ],
        "diarization": [
            {"start_ms": 0, "end_ms": 500, "type": "clinician"},
            {"start_ms": 500, "end_ms": 1000, "type": "patient"},
        ],
    }
    got = attribute_window(window)
    assert got.status == "ok"
    assert got.method == "proportional"
    assert got.text == "cccc dddd"
    assert "aaaa" not in got.text
    assert got.coverage_pct == 50
    assert got.attribution_confidence == 0.5
    words = attribute_window(
        {
            "window_id": "synth_words",
            "turns": [
                {
                    "start_ms": 0,
                    "end_ms": 1000,
                    "text": "aaaa bbbb cccc dddd",
                    "words": [
                        {"text": "aaaa", "start_ms": 0, "end_ms": 250},
                        {"text": "bbbb", "start_ms": 250, "end_ms": 500},
                        {"text": "cccc", "start_ms": 500, "end_ms": 750},
                        {"text": "dddd", "start_ms": 750, "end_ms": 1000},
                    ],
                }
            ],
            "diarization": window["diarization"],
        }
    )
    assert words.method == "word_timestamps"
    assert words.attribution_confidence > got.attribution_confidence


def test_nemotron_10ms_hop_names_the_patient_column():
    """Header hop is 80 ms. Duration says 10 ms. The patient word sits past 100 ms."""
    frames = 20
    probs = np.zeros((frames, 2), dtype=np.float64)
    probs[:10, 0] = 0.95
    probs[10:, 1] = 0.95
    got = attribute_window(
        {
            "window_id": "synth_nlp",
            "nemotron": {
                "frame_ms": 80,
                "duration_s": 0.2,
                "tol_s": 0.05,
                "doctor_slot": 0,
                "patient_slot": 1,
                "probs": probs.tolist(),
            },
            "turns": [
                {
                    "start_ms": 0,
                    "end_ms": 200,
                    "text": "doctorword patientword",
                    "words": [
                        {"text": "doctorword", "start_ms": 0, "end_ms": 90},
                        {"text": "patientword", "start_ms": 110, "end_ms": 190},
                    ],
                }
            ],
        }
    )
    assert got.status == "ok"
    assert got.text == "patientword"
    assert "doctorword" not in got.text
    assert got.method == "word_timestamps"
    assert got.attribution_confidence == 1


def test_clinician_label_wins_over_a_patient_timeline():
    got = attribute_window(
        {
            "window_id": "synth_vp",
            "turns": [
                {
                    "role": "clinician",
                    "speaker_idx": 1,
                    "start_ms": 0,
                    "end_ms": 400,
                    "text": "I will prescribe rest",
                }
            ],
            "speakers": [{"idx": 1, "type": "patient"}],
            "diarization": [{"start_ms": 0, "end_ms": 400, "type": "patient"}],
        }
    )
    assert got.status == "no_patient_speaker"
    assert got.text == ""
    assert "prescribe" not in json.dumps(got.as_row())


def test_whole_window_native_without_a_timeline_is_not_attributed():
    got = attribute_window(
        {
            "window_id": "synth_whole",
            "transcript_native": "ನಿದ್ದೆ ಬರುತ್ತಿಲ್ಲ",
            "transcript_english": "Sleep is not coming.",
        }
    )
    assert got.status == "not_patient_attributed"
    assert got.text == ""


def test_turn_label_still_selects_the_patient_when_there_is_no_timeline():
    got = attribute_window(
        {
            "window_id": "synth_label",
            "speakers": [{"idx": 0, "type": "clinician"}, {"idx": 1, "type": "patient"}],
            "turns": [
                {"speaker_idx": 0, "role": "clinician", "start_ms": 0, "end_ms": 100, "text": "How is the cough?"},
                {"speaker_idx": 1, "start_ms": 100, "end_ms": 200, "text": "ನಿದ್ದೆ is poor"},
            ],
        }
    )
    assert got.status == "ok"
    assert got.method == "turn_label"
    assert "cough" not in got.text
    assert got.language == "code_mixed"
    assert got.code_mixed is True
    assert got.attribution_confidence == 0.85
    assert got.basis_language == "native"


def test_patient_line_is_masked_and_the_summary_has_no_text(tmp_path):
    window = {
        "window_id": "synth_phi",
        "speakers": [{"idx": 1, "type": "patient"}],
        "turns": [
            {
                "speaker_idx": 1,
                "start_ms": 0,
                "end_ms": 100,
                "text": "ರಮೇಶ ಅವರೆ ಫೋನ್ ೯೮೭೬೫೪೩೨೧೦",
            }
        ],
    }
    got = attribute_window(window)
    assert "ರಮೇಶ" not in got.text
    assert "೯೮೭೬೫೪೩೨೧೦" not in got.text
    assert "[PATIENT_NAME]" in got.text
    assert "[PHONE]" in got.text
    path = tmp_path / "in.json"
    path.write_text(json.dumps(window), encoding="utf-8")
    summary = attribute_file(path, tmp_path / "out.jsonl")
    blob = json.dumps(summary)
    assert "ರಮೇಶ" not in blob
    assert "೯೮೭" not in blob
    assert summary["ok"] == 1
    assert summary["mean_coverage_pct"] == 100


def test_absolute_turn_times_rebase_onto_the_timeline():
    got = attribute_window(
        {
            "window_id": "synth_rebase",
            "diarization": [
                {"start_ms": 0, "end_ms": 500, "type": "doctor"},
                {"start_ms": 500, "end_ms": 1000, "type": "patient"},
            ],
            "turns": [
                {
                    "start_ms": 5_000_000,
                    "end_ms": 5_001_000,
                    "text": "aaaa bbbb",
                    "words": [
                        {"text": "aaaa", "start_ms": 5_000_000, "end_ms": 5_000_400},
                        {"text": "bbbb", "start_ms": 5_000_600, "end_ms": 5_000_900},
                    ],
                }
            ],
        }
    )
    assert got.text == "bbbb"
    assert "aaaa" not in got.text
