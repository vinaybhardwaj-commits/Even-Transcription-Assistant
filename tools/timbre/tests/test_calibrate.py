"""Room/doctor calibration. Synthetic ids only."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from tools.timbre.calibrate import (
    CALIB_VERSION,
    CLEF_VALENCE_COL,
    ODYSSEY_AROUSAL_COL,
    CalibError,
    apply_calibration,
    centre_value,
    fit_calibration,
    load_calibration,
    main,
    save_calibration,
)


def _frames():
    """Six usable gold rows plus a batch-3 row and a not_patient row.

    R1/D1 has n=4. R2/D1 has n=1 so it falls back to the doctor. R3/D9 has n=1
    and that doctor is below min_n, so it falls back to the global centre.
    """
    rows = [
        ("synth-win-KEEPMEOUT-1", "R1", "d00000aa", 1, 1.0, 1.0),
        ("synth-win-KEEPMEOUT-2", "R1", "d00000aa", 1, 2.0, 2.0),
        ("synth-win-KEEPMEOUT-3", "R1", "d00000aa", 1, 3.0, 3.0),
        ("synth-win-KEEPMEOUT-4", "R1", "d00000aa", 1, 4.0, 4.0),
        ("synth-win-KEEPMEOUT-5", "R2", "d00000aa", 1, 10.0, 5.0),
        ("synth-win-KEEPMEOUT-6", "R3", "d00000bb", 1, 10.0, 5.0),
        ("synth-win-KEEPMEOUT-7", "R1", "d00000aa", 3, 100.0, 5.0),
        ("synth-win-KEEPMEOUT-8", "R1", "d00000aa", 1, 100.0, 1.0),
    ]
    labels = pd.DataFrame(
        [
            {
                "window_id": wid,
                "room": room,
                "doctor_uid8": doctor,
                "batch": batch,
                "arousal": gold,
                "valence": gold,
                "not_patient": "1" if wid.endswith("-8") else "0",
                "unusable": "0",
                "is_repeat": "0",
            }
            for wid, room, doctor, batch, _raw, gold in rows
        ]
    )
    scores = pd.DataFrame(
        [
            {
                "window_id": wid,
                "room": room,
                "doctor_uid8": doctor,
                ODYSSEY_AROUSAL_COL: raw,
                CLEF_VALENCE_COL: raw,
            }
            for wid, room, doctor, _batch, raw, _gold in rows
        ]
    )
    return scores, labels


def test_room_doctor_global_and_batch_filter():
    scores, labels = _frames()
    calib = fit_calibration(
        scores,
        labels,
        score_col=CLEF_VALENCE_COL,
        gold_col="valence",
        min_n=4,
    )
    assert calib["version"] == CALIB_VERSION
    assert calib["n_fit"] == 6
    assert calib["batches"] == [1, 2]
    assert calib["global"]["median"] == pytest.approx(3.5)
    assert calib["rooms"]["R1"]["n"] == 4
    assert calib["rooms"]["R1"]["median"] == pytest.approx(2.5)
    assert calib["rooms"]["R2"]["n"] == 1
    assert calib["doctors"]["d00000aa"]["n"] == 5
    assert calib["doctors"]["d00000aa"]["median"] == pytest.approx(3.0)
    assert calib["doctors"]["d00000bb"]["n"] == 1
    assert calib["rooms"]["R1"]["median"] != pytest.approx(calib["doctors"]["d00000aa"]["median"])
    assert calib["doctors"]["d00000aa"]["median"] != pytest.approx(calib["global"]["median"])

    applied = apply_calibration(scores, calib)
    col = CLEF_VALENCE_COL
    levels = dict(zip(applied["window_id"], applied[f"{col}__calibration_level"]))
    centred = dict(zip(applied["window_id"], applied[f"{col}__centred"]))
    calibrated = dict(zip(applied["window_id"], applied[f"{col}__calibrated"]))
    assert levels["synth-win-KEEPMEOUT-1"] == "room"
    assert levels["synth-win-KEEPMEOUT-5"] == "doctor"
    assert levels["synth-win-KEEPMEOUT-6"] == "global"
    assert centred["synth-win-KEEPMEOUT-4"] == pytest.approx(
        centre_value(4.0, calib["rooms"]["R1"], calib["iqr_floor"])
    )
    assert centred["synth-win-KEEPMEOUT-5"] == pytest.approx(
        centre_value(10.0, calib["doctors"]["d00000aa"], calib["iqr_floor"])
    )
    assert centred["synth-win-KEEPMEOUT-6"] == pytest.approx(
        centre_value(10.0, calib["global"], calib["iqr_floor"])
    )
    for value in calibrated.values():
        assert 1.0 <= float(value) <= 5.0
    assert applied[col].tolist() == scores[col].tolist()
    assert float(calibrated["synth-win-KEEPMEOUT-5"]) != pytest.approx(10.0)


def test_isotonic_off_keeps_centred_values():
    scores, labels = _frames()
    calib = fit_calibration(
        scores, labels, score_col=ODYSSEY_AROUSAL_COL, gold_col="arousal", min_n=4, isotonic=False
    )
    assert calib["isotonic"] is None
    applied = apply_calibration(scores, calib, score_col=ODYSSEY_AROUSAL_COL)
    centred = applied[f"{ODYSSEY_AROUSAL_COL}__centred"].to_numpy()
    mapped = applied[f"{ODYSSEY_AROUSAL_COL}__calibrated"].to_numpy()
    assert np.allclose(centred, mapped, equal_nan=True)


def test_both_targets_and_json_has_no_window_ids(tmp_path):
    scores, labels = _frames()
    out = {}
    for score_col, gold_col in ((ODYSSEY_AROUSAL_COL, "arousal"), (CLEF_VALENCE_COL, "valence")):
        payload = fit_calibration(scores, labels, score_col=score_col, gold_col=gold_col, min_n=4)
        path = tmp_path / f"{gold_col}.json"
        save_calibration(payload, path)
        text = path.read_text(encoding="utf-8")
        assert "synth-win-KEEPMEOUT" not in text
        assert "window_id" not in json.loads(text)
        loaded = load_calibration(path)
        applied = apply_calibration(scores, loaded)
        assert f"{score_col}__calibrated" in applied.columns
        assert f"{score_col}__calibration_level" in applied.columns
        out[gold_col] = applied
    assert len(out) == 2


def test_iqr_floor_when_a_room_has_no_spread():
    scores = pd.DataFrame(
        {
            "window_id": [f"w{i}" for i in range(4)],
            "room": ["R1"] * 4,
            "doctor_uid8": ["d00000aa"] * 4,
            "score": [3.0, 3.0, 3.0, 3.0],
        }
    )
    labels = pd.DataFrame(
        {
            "window_id": scores["window_id"],
            "room": scores["room"],
            "doctor_uid8": scores["doctor_uid8"],
            "batch": [1, 1, 1, 2],
            "valence": [2.0, 2.0, 2.0, 2.0],
        }
    )
    calib = fit_calibration(scores, labels, score_col="score", gold_col="valence", min_n=4)
    assert calib["rooms"]["R1"]["iqr"] == pytest.approx(0.0)
    fresh = pd.DataFrame(
        {"window_id": ["new"], "room": ["R1"], "doctor_uid8": ["d00000aa"], "score": [5.0]}
    )
    applied = apply_calibration(fresh, calib, score_col="score")
    assert applied["score__calibration_level"].iloc[0] == "room"
    assert applied["score__centred"].iloc[0] == pytest.approx((5.0 - 3.0) / calib["iqr_floor"])
    assert np.isfinite(applied["score__calibrated"].iloc[0])


def test_refuses_rows_outside_batches_1_and_2():
    scores = pd.DataFrame({"window_id": ["w1"], "room": ["R"], "score": [1.0]})
    labels = pd.DataFrame({"window_id": ["w1"], "room": ["R"], "batch": [3], "valence": [1.0]})
    with pytest.raises(CalibError):
        fit_calibration(scores, labels, score_col="score", gold_col="valence", min_n=1)
    labels = labels.drop(columns=["batch"])
    with pytest.raises(CalibError):
        fit_calibration(scores, labels, score_col="score", gold_col="valence", min_n=1)


def test_cli_fit_and_apply(tmp_path, capsys):
    scores, labels = _frames()
    score_path = tmp_path / "scores.parquet"
    label_path = tmp_path / "labels.csv"
    calib_path = tmp_path / "clef.json"
    out_path = tmp_path / "applied.parquet"
    scores.to_parquet(score_path, index=False)
    labels.to_csv(label_path, index=False)
    main(
        [
            "fit",
            "--scores",
            str(score_path),
            "--labels",
            str(label_path),
            "--score-col",
            CLEF_VALENCE_COL,
            "--gold-col",
            "valence",
            "--min-n",
            "4",
            "--out",
            str(calib_path),
        ]
    )
    text = capsys.readouterr().out
    assert "synth-win-KEEPMEOUT" not in text
    assert "n_fit=6" in text
    main(
        [
            "apply",
            "--scores",
            str(score_path),
            "--calibration",
            str(calib_path),
            "--out",
            str(out_path),
        ]
    )
    frame = pd.read_parquet(out_path)
    assert set(frame[f"{CLEF_VALENCE_COL}__calibration_level"]) >= {"room", "doctor", "global"}
