"""Voice-only vs text-only vs late fusion on a synthetic cohort."""

from __future__ import annotations

import json

import pandas as pd
import pytest

from tools.timbre.evaluate import evaluate, fusion_comparison, load_labels, load_text_scores, main


def _labels_csv(tmp_path, n=32):
    header = (
        "window_id,is_repeat,arousal,valence,engaged,anxious,resistant,"
        "words_ne_tone,not_patient,unusable,room,date"
    )
    lines = [header]
    for i in range(n):
        arousal = (i % 5) + 1
        valence = 6 - arousal
        engaged = i % 2
        resistant = 1 if i % 4 == 0 else 0
        room = f"R{i // 8}"
        lines.append(
            f"w{i},0,{arousal},{valence},{engaged},0,{resistant},0,0,0,{room},2026-01-01"
        )
    path = tmp_path / "labels.csv"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return load_labels(path)


def _frames(n=32):
    voice_rows = []
    text_rows = []
    for i in range(n):
        arousal = (i % 5) + 1
        valence = 6 - arousal
        voice_rows.append(
            {
                "window_id": f"w{i}",
                "demo__arousal": float((i * 3) % 5),
                "demo__valence": float((i * 2) % 7),
            }
        )
        text_rows.append(
            {
                "window_id": f"w{i}",
                "valence": valence,
                "arousal": arousal,
                "engaged": bool(i % 2),
                "resistant": bool(i % 4 == 0),
                "unresolved_doubt": {"value": False, "reason": "none"},
                "confidence": 0.8,
                "status": "ok",
                "text": "this field must not be required or echoed",
            }
        )
    return pd.DataFrame(voice_rows), pd.DataFrame(text_rows)


def test_three_conditions_share_a_room_day_fold(tmp_path):
    labels = _labels_csv(tmp_path)
    voice, text = _frames()
    bare = evaluate(labels, voice)
    assert "fusion" not in bare
    score_path = tmp_path / "scores.jsonl"
    with score_path.open("w", encoding="utf-8") as fh:
        for rec in text.to_dict(orient="records"):
            fh.write(json.dumps(rec) + "\n")
    loaded = load_text_scores(score_path)
    assert "text" not in loaded.columns
    report = fusion_comparison(labels, voice, loaded)
    assert report["n"] == 32
    assert report["n_groups"] == 4
    assert report["group"] == "room_day"
    cond = report["conditions"]
    assert cond["voice_only"]["n_features"] == 2
    assert cond["text_only"]["n_features"] == 6
    assert cond["late_fused"]["n_features"] == 8
    assert cond["text_only"]["valence_spearman"] > 0.95
    assert cond["text_only"]["arousal_ccc"] > 0.95
    assert cond["text_only"]["valence_spearman"] > cond["voice_only"]["valence_spearman"]
    assert cond["late_fused"]["valence_spearman"] > 0.9
    assert cond["text_only"]["flag_macro_f1"] > 0.9
    assert "this field" not in json.dumps(report)
    assert "echoed" not in json.dumps(report)


def test_fusion_cli_is_opt_in(tmp_path):
    _labels_csv(tmp_path)
    voice, text = _frames()
    # load_text_scores path: write JSONL without relying on the in-memory frame's extra column
    score_path = tmp_path / "scores.jsonl"
    with score_path.open("w", encoding="utf-8") as fh:
        for rec in text.to_dict(orient="records"):
            rec = {k: v for k, v in rec.items() if k != "text"}
            fh.write(json.dumps(rec) + "\n")
    feat_path = tmp_path / "features.parquet"
    voice.to_parquet(feat_path)
    out = tmp_path / "eval.json"
    with pytest.raises(SystemExit):
        main(["--labels", str(tmp_path / "labels.csv"), "--features", str(feat_path), "--out", str(out), "--fusion"])
    main(
        [
            "--labels",
            str(tmp_path / "labels.csv"),
            "--features",
            str(feat_path),
            "--out",
            str(out),
            "--fusion",
            "--text-scores",
            str(score_path),
            "--voice-model",
            "demo",
        ]
    )
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert set(saved["fusion"]["conditions"]) == {"voice_only", "text_only", "late_fused"}
    assert saved["fusion"]["conditions"]["late_fused"]["n_features"] == 8
    # The ordinary model table is still there; fusion did not replace it.
    assert saved["models"]
