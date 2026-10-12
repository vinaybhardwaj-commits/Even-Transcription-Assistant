"""Patient-purity scoring on synthetic frames (no audio, no models)."""

from __future__ import annotations

import numpy as np
import pytest

from tools.timbre.purity import (
    PurityError,
    PurityRule,
    auroc_low_is_positive,
    embedding_purity,
    frame_patient_scores,
    fuse_purity,
    probs_purity,
    threshold_table,
)


def test_embedding_purity_pure_and_contaminated():
    # 10 frames: 8 clearly patient, 2 where the doctor is closer.
    cp = np.array([0.6] * 8 + [0.2, 0.25])
    co = np.array([0.1] * 8 + [0.5, 0.55])
    s = embedding_purity(cp, co, hop_s=0.5)
    assert s["purity"] == pytest.approx(0.8)
    assert s["pure_patient_s"] == pytest.approx(4.0)
    assert s["other_frac"] == pytest.approx(0.2)
    assert s["cos_patient_mean"] == pytest.approx((0.6 * 8 + 0.45) / 10)


def test_embedding_purity_margin_and_active_mask():
    cp = np.array([0.40, 0.40, 0.40, 0.9])
    co = np.array([0.35, 0.10, 0.10, 0.0])
    active = np.array([True, True, True, False])  # last frame is silence
    s = embedding_purity(cp, co, active=active, margin=0.10)
    assert s["n_frames"] == 3
    assert s["purity"] == pytest.approx(2 / 3)  # first frame only beats "other" by 0.05


def test_embedding_purity_empty_and_errors():
    s = embedding_purity([0.5, 0.5], [0.1, 0.1], active=[False, False])
    assert s["purity"] is None and s["pure_patient_s"] == 0.0
    with pytest.raises(PurityError):
        embedding_purity([0.5], [0.1, 0.2])
    with pytest.raises(PurityError):
        embedding_purity([], [])


def test_probs_purity_dominance_overlap_and_doctor():
    # 100 frames at 10 ms. Slot 0 patient, slot 1 doctor.
    p = np.zeros((100, 3))
    p[:60, 0] = 0.9  # pure patient
    p[60:80, 0] = 0.8
    p[60:80, 1] = 0.6  # overlap with doctor
    p[80:100, 1] = 0.95  # doctor alone
    s = probs_purity(p, 0, doctor_slot=1)
    assert s["n_frames"] == 100
    assert s["purity"] == pytest.approx(0.6)
    assert s["pure_patient_s"] == pytest.approx(0.6)
    assert s["overlap_s"] == pytest.approx(0.2)
    assert s["doctor_s"] == pytest.approx(0.4)
    frames = frame_patient_scores(p, 0, doctor_slot=1)
    assert frames["pure"].sum() == 60
    assert frames["patient_dominance"].shape == (100,)
    assert frames["second_speaker_p"].shape == (100,)
    # 60 frames of 0.9 dominance, 20 of 0.2, 20 of -0.95.
    assert s["dominance_mean"] == pytest.approx(0.39)
    assert s["second_speaker_p_mean"] == pytest.approx(0.12)
    assert s["second_speaker_p_max"] == pytest.approx(0.6)
    # A doctor voiceprint hit on the first 10 patient frames removes them too.
    dc = np.zeros(100)
    dc[:10] = 0.7
    s2 = probs_purity(p, 0, doctor_slot=1, doctor_cos=dc)
    assert s2["purity"] == pytest.approx(0.5)


def test_probs_purity_validation():
    with pytest.raises(PurityError):
        probs_purity(np.zeros((5, 2)), 2)
    with pytest.raises(PurityError):
        probs_purity(np.full((5, 2), np.nan), 0)
    assert probs_purity(np.zeros((5, 2)), 0)["purity"] is None


def test_fuse_takes_the_worse_source_and_one_rule_decides():
    fused = fuse_purity(
        embedding={
            "source": "embedding",
            "purity": 0.9,
            "pure_patient_s": 5.0,
            "other_frac": 0.1,
            "cos_patient_mean": 0.4,
            "n_frames": 10,
            "dominance_mean": 0.5,
        },
        probs={
            "source": "probs",
            "purity": 0.7,
            "pure_patient_s": 4.0,
            "other_frac": 0.4,
            "n_frames": 20,
            "dominance_mean": 0.3,
            "second_speaker_p_mean": 0.2,
            "second_speaker_p_max": 0.55,
            "overlap_s": 1.0,
        },
    )
    assert fused["source"] == "fused"
    assert fused["purity"] == pytest.approx(0.7)
    assert fused["pure_patient_s"] == pytest.approx(4.0)
    assert fused["other_frac"] == pytest.approx(0.4)
    assert fused["cos_patient_mean"] == pytest.approx(0.4)
    assert fused["second_speaker_p_mean"] == pytest.approx(0.2)
    assert fused["dominance_mean"] is None
    assert fused["dominance_probs"] == pytest.approx(0.3)
    judged = PurityRule().judge(
        embedding={
            "source": "embedding",
            "purity": 0.9,
            "pure_patient_s": 5.0,
            "other_frac": 0.1,
            "cos_patient_mean": 0.4,
            "n_frames": 10,
            "dominance_mean": 0.5,
        },
        probs={
            "source": "probs",
            "purity": 0.7,
            "pure_patient_s": 4.0,
            "other_frac": 0.4,
            "n_frames": 20,
            "dominance_mean": 0.3,
            "cos_patient_mean": None,
        },
    )
    assert judged["keep"] is True
    assert judged["rule"]["min_purity"] == 0.6

    low_cos = {
        "source": "embedding",
        "purity": 0.9,
        "pure_patient_s": 5.0,
        "cos_patient_mean": 0.2,
        "n_frames": 10,
    }
    high_probs = {"source": "probs", "purity": 1.0, "pure_patient_s": 6.0, "n_frames": 12, "cos_patient_mean": None}
    assert PurityRule().judge(embedding=low_cos, probs=high_probs)["keep"] is False

    missing = fuse_purity(
        embedding={"purity": None, "pure_patient_s": 0.0, "n_frames": 0},
        probs={"purity": 0.9, "pure_patient_s": 5.0, "n_frames": 10},
    )
    assert missing["purity"] is None
    assert PurityRule().passes(missing) is False
    with pytest.raises(PurityError):
        fuse_purity()


def test_rule_defaults():
    rule = PurityRule()
    assert rule.passes({"purity": 0.7, "pure_patient_s": 4.0, "cos_patient_mean": 0.4})
    assert not rule.passes({"purity": 0.5, "pure_patient_s": 4.0, "cos_patient_mean": 0.4})
    assert not rule.passes({"purity": 0.9, "pure_patient_s": 2.0, "cos_patient_mean": 0.4})
    assert not rule.passes({"purity": 0.9, "pure_patient_s": 5.0, "cos_patient_mean": 0.2})
    assert rule.passes({"purity": 0.9, "pure_patient_s": 5.0, "cos_patient_mean": None})
    assert not rule.passes({"purity": None, "pure_patient_s": 0.0})
    assert rule.to_dict()["min_purity"] == 0.6


def test_auroc_and_threshold_table():
    score = np.array([0.1, 0.2, 0.8, 0.9, 0.7, 0.3])
    positive = np.array([1, 1, 0, 0, 0, 1], dtype=bool)
    assert auroc_low_is_positive(score, positive) == pytest.approx(1.0)
    assert auroc_low_is_positive(score, ~positive) == pytest.approx(0.0)
    assert auroc_low_is_positive([0.5, 0.5], [True, False]) == pytest.approx(0.5)
    assert auroc_low_is_positive([0.5, 0.6], [False, False]) is None
    rows = threshold_table(score, positive, [0.5])
    assert rows[0]["kept"] == 3 and rows[0]["positives_dropped"] == 3 and rows[0]["negatives_dropped"] == 0
