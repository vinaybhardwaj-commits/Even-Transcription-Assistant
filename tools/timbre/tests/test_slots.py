"""Speaker-slot mapping on synthetic probabilities and embeddings. No audio."""

from __future__ import annotations

import numpy as np
import pytest

from tools.timbre.slots import SlotError, align_labels, cosine, map_slots


def _at(cos: float, dim: int = 4) -> np.ndarray:
    v = np.zeros(dim, dtype=np.float64)
    v[0] = cos
    v[1] = np.sqrt(max(0.0, 1.0 - cos * cos))
    return v


def _centroid(dim: int = 4) -> np.ndarray:
    v = np.zeros(dim, dtype=np.float64)
    v[0] = 1.0
    return v


def _timeline(n_frames: int, segments: list[tuple[int, int, int]], n_speakers: int = 3) -> np.ndarray:
    """segments are (start_frame, end_frame, slot) at probability 0.95."""
    probs = np.zeros((n_frames, n_speakers), dtype=np.float64)
    for a, b, slot in segments:
        probs[a:b, slot] = 0.95
    return probs


def test_cosine_matches_a_zero_norm_and_a_unit_vector():
    assert cosine([2.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert cosine([0.0, 0.0], [1.0, 0.0]) == 0.0
    with pytest.raises(SlotError):
        cosine([1.0, 0.0], [1.0, 0.0, 0.0])


def test_centroid_names_the_doctor_and_the_longest_other_voice_is_the_patient():
    # 2 s doctor (slot 0), 8 s patient (slot 1), at 10 ms.
    probs = _timeline(1000, [(0, 200, 0), (200, 1000, 1)], n_speakers=2)
    emb = np.stack([_at(0.9), _at(0.0)])
    decision = map_slots(probs, frame_ms=10, slot_embeddings=emb, doctor_centroid=_centroid())
    assert decision.status == "ok"
    assert decision.doctor_source == "centroid"
    assert decision.doctor_slot == 0
    assert decision.patient_slot == 1
    assert decision.doctor_cosine == pytest.approx(0.9)
    assert decision.confidence == pytest.approx(0.9)
    assert decision.patient_talk_s == pytest.approx(8.0)
    assert decision.accepted


def test_frame_embeddings_are_pooled_on_dominant_frames():
    probs = _timeline(200, [(0, 50, 0), (50, 200, 1)], n_speakers=2)
    frames = np.zeros((200, 4), dtype=np.float64)
    frames[:50] = _at(1.0)
    frames[50:] = _at(0.0)
    decision = map_slots(probs, frame_ms=10, frame_embeddings=frames, doctor_centroid=_centroid())
    assert decision.status == "ok"
    assert decision.doctor_slot == 0
    assert decision.patient_slot == 1
    assert decision.doctor_cosine == pytest.approx(1.0)


def test_centroid_margin_and_floor_are_ambiguous():
    probs = _timeline(400, [(0, 200, 0), (200, 400, 1)], n_speakers=2)
    close = np.stack([_at(0.80), _at(0.78)])
    margin = map_slots(probs, frame_ms=10, slot_embeddings=close, doctor_centroid=_centroid())
    assert margin.status == "ambiguous"
    assert margin.reason == "centroid_margin"
    assert margin.doctor_slot is None
    assert margin.candidate_doctor_slot == 0
    assert margin.confidence == 0.0

    weak = np.stack([_at(0.40), _at(0.10)])
    low = map_slots(probs, frame_ms=10, slot_embeddings=weak, doctor_centroid=_centroid())
    assert low.reason == "centroid_below_threshold"
    assert low.doctor_cosine == pytest.approx(0.40)


def test_a_close_second_voice_is_not_named_the_patient():
    # Doctor 2 s, patient 10 s, translator 8 s. 8/10 >= 0.75.
    probs = _timeline(2000, [(0, 200, 0), (200, 1200, 1), (1200, 2000, 2)])
    emb = np.stack([_at(0.9), _at(0.0), _at(0.05)])
    decision = map_slots(probs, frame_ms=10, slot_embeddings=emb, doctor_centroid=_centroid())
    assert decision.status == "ambiguous"
    assert decision.reason == "patient_rival"
    assert decision.doctor_slot == 0
    assert decision.patient_slot is None
    assert decision.candidate_patient_slot == 1
    assert not decision.accepted


def test_eta_signal_wins_and_a_low_cosine_does_not_fall_through():
    probs = _timeline(1000, [(0, 200, 0), (200, 1000, 1)], n_speakers=2)
    eta = map_slots(probs, frame_ms=10, eta_doctor={"slot": 0, "cosine": 0.82, "clinician_id": "doctor-example"})
    assert eta.status == "ok"
    assert eta.doctor_source == "eta"
    assert eta.doctor_slot == 0
    assert eta.patient_slot == 1
    assert eta.confidence == pytest.approx(0.82)

    emb = np.stack([_at(1.0), _at(0.0)])
    blocked = map_slots(
        probs,
        frame_ms=10,
        eta_doctor={"slot": 1, "cosine": 0.40},
        slot_embeddings=emb,
        doctor_centroid=_centroid(),
    )
    assert blocked.reason == "eta_below_threshold"
    assert blocked.doctor_slot is None
    assert blocked.candidate_doctor_slot == 1
    assert blocked.centroid_slot is None


def test_eta_and_centroid_disagreement_is_ambiguous():
    probs = _timeline(400, [(0, 200, 0), (200, 400, 1)], n_speakers=2)
    emb = np.stack([_at(1.0), _at(0.0)])
    decision = map_slots(
        probs,
        frame_ms=10,
        eta_doctor={"slot": 1, "cosine": 0.90},
        slot_embeddings=emb,
        doctor_centroid=_centroid(),
    )
    assert decision.reason == "eta_centroid_disagree"
    assert decision.doctor_slot is None
    assert decision.candidate_doctor_slot == 1
    assert decision.centroid_slot == 0


def test_spk_label_is_not_the_probability_column():
    """First speech is model column 2, so ETA spk0 is column 2 and spk1 is column 0."""
    probs = np.zeros((100, 3), dtype=np.float64)
    probs[:40, 2] = 0.95
    probs[40:, 0] = 0.95
    turns = [(0, 400, "spk0"), (400, 1000, "spk1")]
    mapping = align_labels(probs, turns, frame_ms=10)
    assert mapping == {"spk0": 2, "spk1": 0}
    decision = map_slots(
        probs,
        frame_ms=10,
        turns=turns,
        eta_doctor={"speaker_label": "spk1", "cosine": 0.90, "clinician_id": "doctor-example"},
    )
    assert decision.label_to_slot["spk1"] == 0
    assert decision.doctor_slot == 0
    assert decision.patient_slot == 2
    assert decision.status == "ok"

    unaligned = map_slots(probs, frame_ms=10, eta_doctor={"speaker_label": "spk1", "cosine": 0.90})
    assert unaligned.reason == "eta_label_unaligned"


def test_two_eta_clinicians_and_explicit_slots():
    probs = _timeline(200, [(0, 100, 0), (100, 200, 1)], n_speakers=2)
    rows = [
        {"speaker_label": "spk0", "clinician_id": "a", "cosine": 0.8},
        {"speaker_label": "spk1", "clinician_id": "b", "cosine": 0.8},
    ]
    two = map_slots(probs, frame_ms=10, eta_doctor=rows)
    assert two.reason == "eta_two_clinicians"

    given = map_slots(probs, frame_ms=10, doctor_slot=0, patient_slot=1)
    assert given.status == "ok" and given.doctor_source == "given" and given.confidence == 1.0
    with pytest.raises(SlotError):
        map_slots(probs, frame_ms=10, doctor_slot=0, patient_slot=0)
    with pytest.raises(SlotError):
        map_slots(probs, frame_ms=10, doctor_slot=0)


def test_no_evidence_is_ambiguous():
    probs = _timeline(50, [(0, 50, 0)], n_speakers=2)
    decision = map_slots(probs, frame_ms=10)
    assert decision.reason == "no_doctor_evidence"
    assert decision.accepted is False
