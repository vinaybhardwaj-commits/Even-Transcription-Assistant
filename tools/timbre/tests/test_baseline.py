"""Z-scores against earlier patient windows, and against the doctor on the same tape."""

from __future__ import annotations

import math

import pandas as pd
import pytest

from tools.timbre.baseline import add_baselines


def test_delta_self_and_doctor_relative():
    df = pd.DataFrame(
        {
            "window_id": ["c_p0000000", "c_p0001000", "c_p0002000", "other_p0000000"],
            "clip_id": ["c", "c", "c", "other"],
            "start_s": [0.0, 1.0, 2.0, 0.0],
            "role": ["patient", "patient", "patient", "patient"],
            "audeering_msp_dim.v1__arousal": [1.0, 2.0, 3.0, 100.0],
            "egemaps_v02.v1__loud_med": [1.0, 2.0, 3.0, 100.0],
        }
    )
    doctor = pd.DataFrame(
        {
            "window_id": ["c_doc"],
            "clip_id": ["c"],
            "start_s": [0.0],
            "role": ["doctor"],
            "audeering_msp_dim.v1__arousal": [10.0],
            "egemaps_v02.v1__loud_med": [10.0],
        }
    )
    out = add_baselines(df, doctor=doctor)
    col = "audeering_msp_dim.v1__arousal"
    # First two patient windows have fewer than two earlier values.
    assert math.isnan(out.loc[0, f"{col}__delta_self"])
    assert math.isnan(out.loc[1, f"{col}__delta_self"])
    sd = math.sqrt(0.5)  # sample std of [1, 2]
    assert out.loc[2, f"{col}__delta_self"] == pytest.approx((3.0 - 1.5) / sd)
    assert out.loc[2, f"{col}__rel_doctor"] == pytest.approx((3.0 - 10.0) / sd)
    # The other consult is not mixed in, and has no doctor.
    assert math.isnan(out.loc[3, f"{col}__delta_self"])
    assert math.isnan(out.loc[3, f"{col}__rel_doctor"])
    # Prosodic column is treated the same way.
    assert out.loc[2, "egemaps_v02.v1__loud_med__delta_self"] == pytest.approx((3.0 - 1.5) / sd)


def test_zero_variance_and_doctor_rows_inside_the_frame():
    df = pd.DataFrame(
        {
            "window_id": ["c_p0000000", "c_p0001000", "c_p0002000", "c_doc"],
            "clip_id": ["c", "c", "c", "c"],
            "start_s": [0.0, 1.0, 2.0, 0.5],
            "role": ["patient", "patient", "patient", "doctor"],
            "audeering_msp_dim.v1__valence": [5.0, 5.0, 5.0, 1.0],
        }
    )
    out = add_baselines(df)
    # std of [5, 5] is 0 and the current value equals the mean -> 0
    assert out.loc[2, "audeering_msp_dim.v1__valence__delta_self"] == 0.0
    # doctor gap cannot be scaled by a zero std
    assert math.isnan(out.loc[2, "audeering_msp_dim.v1__valence__rel_doctor"])
    # the doctor row itself is not z-scored
    assert math.isnan(out.loc[3, "audeering_msp_dim.v1__valence__delta_self"])


def test_categorical_columns_are_not_baselined():
    df = pd.DataFrame(
        {
            "window_id": ["c_p0000000", "c_p0001000", "c_p0002000"],
            "clip_id": ["c", "c", "c"],
            "start_s": [0.0, 1.0, 2.0],
            "role": ["patient", "patient", "patient"],
            "wavlm_aniemore.v1__neutral": [0.2, 0.4, 0.9],
        }
    )
    out = add_baselines(df)
    assert "wavlm_aniemore.v1__neutral__delta_self" not in out.columns

