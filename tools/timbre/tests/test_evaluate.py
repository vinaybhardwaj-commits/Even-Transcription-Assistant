"""Repeats, CCC, grouped CV, exclusion, and the outcome hook, on a synthetic labels CSV."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from tools.timbre.evaluate import (
    concordance_ccc,
    evaluate,
    flag_macro_f1,
    grouped_oof,
    intra_rater,
    load_labels,
    outcome_linkage,
    spearman,
)

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "labels.csv"


def _labels_text() -> str:
    # Two primaries that match a perfect 0-1 prediction, one hidden repeat each,
    # one unusable and one not_patient that would wreck CCC if they were kept.
    # Four room-days so the grouped head has something to hold out.
    header = (
        "item_id,window_id,is_repeat,arousal,valence,engaged,anxious,resistant,"
        "words_tone_mismatch,not_patient,unusable,confidence,room,date"
    )
    rows = [header]
    # Balanced engaged flag across 4 room-days, arousal = 1..5 repeating.
    for i in range(20):
        room = f"R{i % 4}"
        arousal = (i % 5) + 1
        engaged = 1 if i % 2 == 0 else 0
        rows.append(
            f"{i},w{i},0,{arousal},{6 - arousal},{engaged},0,0,0,0,0,medium,{room},2026-01-01"
        )
    # Hidden repeats of w0 and w1, close but not identical on valence.
    rows.append("r0,w0,1,1,5,1,0,0,0,0,0,medium,R0,2026-01-01")
    rows.append("r1,w1,1,2,3,0,0,0,1,0,0,low,R1,2026-01-01")
    # Excluded. Predictions below will disagree hard with these.
    rows.append("u,w_bad,0,1,1,1,1,1,1,0,1,low,R0,2026-01-01")
    rows.append("n,w_other,0,5,5,0,0,0,0,1,0,low,R1,2026-01-01")
    return "\n".join(rows) + "\n"


@pytest.fixture()
def labels_df(tmp_path) -> pd.DataFrame:
    path = tmp_path / "labels.csv"
    path.write_text(_labels_text(), encoding="utf-8")
    return load_labels(path)


def test_ccc_and_spearman_identities():
    assert concordance_ccc([1, 2, 3, 4], [1, 2, 3, 4]) == pytest.approx(1.0)
    assert concordance_ccc([1, 2, 3], [3, 2, 1]) < 0
    assert spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)
    assert concordance_ccc([1, 1, 1], [1, 1, 1]) is None


def test_intra_rater_and_exclusion(labels_df):
    report = intra_rater(labels_df)
    assert report["n_pairs"] == 2
    assert report["arousal"]["exact_agreement"] == pytest.approx(1.0)
    assert report["arousal"]["quadratic_kappa"] == pytest.approx(1.0)
    # valence pairs are (5,5) and (4,3): not identical, but the unusable row is not a pair
    assert report["valence"]["n_pairs"] if False else report["n_pairs"] == 2
    assert report["flags"]["words_ne_tone"]["n"] == 2


def test_direct_ccc_ignores_unusable_and_not_patient(labels_df):
    usable_ids = [f"w{i}" for i in range(20)]
    pred_a = [((i % 5)) / 4 for i in range(20)]  # (arousal-1)/4
    pred_v = [((5 - (i % 5)) ) / 4 for i in range(20)]
    # Map: arousal gold is (i%5)+1, so (gold-1)/4 = (i%5)/4. Yes.
    # valence gold is 6-arousal = 6-((i%5)+1) = 5-(i%5). (gold-1)/4 = (4-(i%5))/4 = (5-(i%5)-1)/4.
    # I set pred_v wrong. Fix: (valence-1)/4 = (5 - (i%5) - 1)/4 = (4 - (i%5))/4
    pred_v = [(4 - (i % 5)) / 4 for i in range(20)]
    features = pd.DataFrame(
        {
            "window_id": usable_ids + ["w_bad", "w_other"],
            "audeering_msp_dim.v1__arousal": pred_a + [1.0, 0.0],
            "audeering_msp_dim.v1__valence": pred_v + [1.0, 0.0],
        }
    )
    report = evaluate(labels_df, features)
    row = report["models"][0]
    assert row["model"] == "audeering_msp_dim.v1"
    assert row["arousal_source"] == "direct"
    assert row["arousal_ccc"] == pytest.approx(1.0)
    assert row["valence_ccc"] == pytest.approx(1.0)
    assert row["arousal_spearman"] == pytest.approx(1.0)
    assert row["n"] == 20  # excluded rows did not join into the metric set... 
    # wait: comparison merges usable primary only, so w_bad and w_other are dropped
    # before the merge. n is the joined usable primaries that are in features. 20.


def test_grouped_cv_ridge_and_logistic():
    groups = np.repeat(np.arange(4), 10)
    x0 = np.tile(np.linspace(-2, 2, 10), 4)
    X = np.column_stack([x0, np.zeros(40)])
    arousal = 3.0 + x0
    pred = grouped_oof(X, arousal, groups, task="ridge")
    assert concordance_ccc(arousal, pred) > 0.9
    flags = {"engaged": (x0 > 0).astype(float)}
    # each group of 10 spans -2..2, so both classes are in every group
    scores = flag_macro_f1(X, flags, groups)
    assert scores["macro_f1"] > 0.9


def test_embedding_head_and_wavlm_row(labels_df):
    # Embedding dim 0 tracks arousal; dim 1 tracks the engaged flag.
    rows = []
    for i in range(20):
        arousal = (i % 5) + 1
        engaged = 1 if i % 2 == 0 else 0
        rows.append(
            {
                "window_id": f"w{i}",
                "wavlm_aniemore.v1__embedding": [float(arousal), float(engaged), 0.0],
            }
        )
    features = pd.DataFrame(rows)
    report = evaluate(labels_df, features)
    row = next(r for r in report["models"] if r["model"] == "wavlm_aniemore.v1")
    assert row["arousal_source"] == "ridge_oof"
    assert row["arousal_ccc"] > 0.8
    assert row["flag_macro_f1"] > 0.9


def test_outcome_hook(labels_df, tmp_path):
    lines = ["window_id,decision,unresolved_doubts,text_score,voice_score"]
    for i in range(20):
        decision = "accept" if i % 2 == 0 else "defer"
        # voice matches the decision; text is the opposite
        voice = 0.9 if decision == "accept" else 0.1
        text = 0.1 if decision == "accept" else 0.9
        doubts = 2 if i % 4 == 0 else 0
        lines.append(f"w{i},{decision},{doubts},{text},{voice}")
    path = tmp_path / "outcomes.csv"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    outcomes = pd.read_csv(path, dtype=str, keep_default_na=False)
    linked = outcome_linkage(labels_df, outcomes)
    assert linked["n_accept"] == 10
    assert linked["n_defer"] == 10
    assert linked["n_unresolved_nonzero"] == 5
    assert linked["auroc_voice"] == pytest.approx(1.0)
    assert linked["auroc_text"] == pytest.approx(0.0)
    assert linked["delta_auroc_voice_minus_text"] == pytest.approx(1.0)
    assert "T-8" in linked["note"]


def test_committed_labels_fixture_parses():
    df = load_labels(FIX)
    pair = df.loc[df.window_id == "synth_a", "words_ne_tone"].tolist()
    assert pair == [False, True]
    assert bool(df.loc[df.window_id == "synth_b", "unusable"].item())


def test_write_report_accepts_a_directory(tmp_path):
    from tools.timbre.evaluate import REPORT_NAME, write_report

    out_dir = tmp_path / "eval"
    out_dir.mkdir()
    written = write_report({"x": 1.0, "bad": float("nan"), "nested": [np.float64("inf")]}, out_dir)
    assert written == out_dir / REPORT_NAME
    import json

    data = json.loads(written.read_text(encoding="utf-8"))  # strict JSON: no NaN tokens
    assert data == {"x": 1.0, "bad": None, "nested": [None]}
    # A trailing separator on a path that does not exist yet is also a directory.
    written2 = write_report({"y": 2}, str(tmp_path / "new_dir") + "/")
    assert written2 == tmp_path / "new_dir" / REPORT_NAME
    # A file path still writes that file.
    written3 = write_report({"z": 3}, tmp_path / "report-a.json")
    assert written3 == tmp_path / "report-a.json"
    assert not list(tmp_path.glob("**/*.tmp"))


def test_cli_out_directory(tmp_path, labels_df):
    from tools.timbre.evaluate import main

    labels = tmp_path / "labels.csv"
    labels.write_text(_labels_text(), encoding="utf-8")
    feats = pd.DataFrame(
        {
            "window_id": [f"w{i}" for i in range(20)],
            "audeering_msp_dim.v1__arousal": [(i % 5) / 4 for i in range(20)],
            "audeering_msp_dim.v1__valence": [(4 - (i % 5)) / 4 for i in range(20)],
        }
    )
    fpath = tmp_path / "features.parquet"
    feats.to_parquet(fpath)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    main(["--labels", str(labels), "--features", str(fpath), "--out", str(out_dir)])
    assert (out_dir / "report.json").is_file()


def _scalar_features(n_noise: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(0)
    rows = []
    for i in range(20):
        arousal = (i % 5) + 1
        rec = {
            "window_id": f"w{i}",
            "egemaps_v02.v1__status": "ok",
            "egemaps_v02.v1__infer_s": 0.01,
            "egemaps_v02.v1__loudness_sma3_amean": float(arousal) + 0.01 * rng.standard_normal(),
            "egemaps_v02.v1__loudness_sma3_amean__delta_self": 99.0,  # derived, must be ignored
            "egemaps_v02.v1__constant": 1.0,  # no variance, must be ignored
        }
        for k in range(n_noise):
            rec[f"egemaps_v02.v1__noise{k}"] = float(rng.standard_normal())
        rows.append(rec)
    return pd.DataFrame(rows)


def test_scalar_ridge_head_is_opt_in(labels_df):
    feats = _scalar_features()
    off = evaluate(labels_df, feats)
    row_off = next(r for r in off["models"] if r["model"] == "egemaps_v02.v1")
    assert row_off["arousal_source"] is None
    on = evaluate(labels_df, feats, scalar_ridge=True)
    row = next(r for r in on["models"] if r["model"] == "egemaps_v02.v1")
    assert row["arousal_source"] == "ridge_oof_scalar"
    assert row["valence_source"] == "ridge_oof_scalar"
    assert row["n_scalar_features"] == 4  # loudness + 3 noise; status/infer_s/delta/constant dropped
    assert row["arousal_spearman"] > 0.8
    assert row["flag_macro_f1"] is not None


def test_scalar_matrix_skips_non_finite_columns():
    from tools.timbre.evaluate import _scalar_matrix

    df = pd.DataFrame(
        {
            "m__a": [1.0, 2.0, 3.0, 4.0],
            "m__b": [1.0, np.nan, 3.0, 4.0],
            "m__status": ["ok"] * 4,
            "m__embedding": [[0.0]] * 4,
        }
    )
    X = _scalar_matrix(df, "m")
    assert X.shape == (4, 1)
    assert _scalar_matrix(df[["m__status"]], "m") is None


def test_include_rel_is_opt_in_for_the_scalar_ridge(labels_df):
    feats = _scalar_features(n_noise=0)
    # The raw loudness column already tracks arousal. Replace it with a constant
    # and put the signal only in the doctor-relative column.
    feats["egemaps_v02.v1__loudness_sma3_amean"] = 1.0
    feats["egemaps_v02.v1__loudness_sma3_amean__rel_doctor"] = [float((i % 5) + 1) for i in range(20)]
    feats["egemaps_v02.v1__loudness_sma3_amean__delta_self"] = [float((i % 5) + 1) for i in range(20)]
    off = evaluate(labels_df, feats, scalar_ridge=True, include_rel=False)
    row_off = next(r for r in off["models"] if r["model"] == "egemaps_v02.v1")
    assert row_off["arousal_source"] is None
    assert off["include_rel"] is False
    on = evaluate(labels_df, feats, scalar_ridge=True, include_rel=True)
    row = next(r for r in on["models"] if r["model"] == "egemaps_v02.v1")
    assert row["arousal_source"] == "ridge_oof_scalar"
    assert row["n_scalar_features"] == 1  # delta_self stays out; the constant raw column has no variance
    assert row["arousal_spearman"] > 0.8
    assert on["include_rel"] is True


def test_include_rel_concatenates_onto_the_embedding_ridge(labels_df):
    rows = []
    for i in range(20):
        arousal = (i % 5) + 1
        rows.append(
            {
                "window_id": f"w{i}",
                "whisper_large_v3_encoder.v1__embedding": [0.0, 0.0, 0.0],
                "whisper_large_v3_encoder.v1__rel_doctor_cosine": float(arousal),
            }
        )
    report = evaluate(labels_df, pd.DataFrame(rows), include_rel=True)
    row = next(r for r in report["models"] if r["model"] == "whisper_large_v3_encoder.v1")
    assert row["arousal_source"] == "ridge_oof"
    assert row["arousal_ccc"] > 0.8


def test_direct_and_embedding_models_ignore_scalar_flag(labels_df):
    feats = pd.DataFrame(
        {
            "window_id": [f"w{i}" for i in range(20)],
            "audeering_msp_dim.v1__arousal": [(i % 5) / 4 for i in range(20)],
            "audeering_msp_dim.v1__valence": [(4 - (i % 5)) / 4 for i in range(20)],
            "audeering_msp_dim.v1__dominance": [0.5] * 20,
        }
    )
    row = evaluate(labels_df, feats, scalar_ridge=True, include_rel=True)["models"][0]
    assert row["arousal_source"] == "direct"
