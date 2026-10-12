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
    assert "by_language" not in saved["fusion"]
    # The ordinary model table is still there; fusion did not replace it.
    assert saved["models"]


def test_language_buckets_and_v1_versus_v2(tmp_path):
    """Kannada is large enough to cite. Tamil and code-mixed are marked, not cited.

    The label language wins over the score's language. A code-mixed flag wins over both.
    v2 text valence tracks gold; v1 does not, so the v2 minus v1 delta is positive.
    """
    from tools.timbre.evaluate import _clean_lang

    assert _clean_lang("kn") == "kn"
    assert _clean_lang("The cough is worse at night") == "other"

    n_kn, n_ta, n_mix = 24, 8, 8
    n = n_kn + n_ta + n_mix
    header = (
        "window_id,is_repeat,arousal,valence,engaged,anxious,resistant,"
        "words_ne_tone,not_patient,unusable,room,date,lang"
    )
    lines = [header]
    voice_rows = []
    v2_rows = []
    v1_rows = []
    for i in range(n):
        if i < n_kn:
            room, label = f"R{i // 6}", "kn"
            mixed = False
            score_lang = "en"
        elif i < n_kn + n_ta:
            room, label = f"T{(i - n_kn) // 4}", "ta"
            mixed = False
            score_lang = "kn"
        else:
            room, label = f"M{(i - n_kn - n_ta) // 4}", "kn"
            mixed = True
            score_lang = "kn"
        arousal = (i % 5) + 1
        valence = 6 - arousal
        engaged = i % 2
        resistant = 1 if i % 4 == 0 else 0
        lines.append(
            f"w{i},0,{arousal},{valence},{engaged},0,{resistant},0,0,0,{room},2026-01-01,{label}"
        )
        voice_rows.append(
            {"window_id": f"w{i}", "demo__arousal": float((i * 3) % 5), "demo__valence": float((i * 2) % 7)}
        )
        common = {
            "window_id": f"w{i}",
            "engaged": bool(engaged),
            "resistant": bool(resistant),
            "unresolved_doubt": {"value": False, "reason": "none"},
            "confidence": 0.8,
            "status": "ok",
        }
        v2_rows.append(
            {
                **common,
                "valence": valence,
                "arousal": arousal,
                "language": score_lang,
                "code_mixed": mixed,
            }
        )
        v1_rows.append({**common, "valence": (i % 2) + 1, "arousal": (i % 2) + 1, "confidence": 0.4})
    labels_path = tmp_path / "labels.csv"
    labels_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    labels = load_labels(labels_path)
    voice = pd.DataFrame(voice_rows)
    # load_text_scores is what copies language; build frames the same way the CLI does.
    v2_path = tmp_path / "scores-v2.jsonl"
    v1_path = tmp_path / "scores-v1.jsonl"
    for path, rows in ((v2_path, v2_rows), (v1_path, v1_rows)):
        with path.open("w", encoding="utf-8") as fh:
            for rec in rows:
                fh.write(json.dumps(rec) + "\n")
    loaded_v2 = load_text_scores(v2_path)
    loaded_v1 = load_text_scores(v1_path)
    assert "language" in loaded_v2.columns
    assert "language" not in loaded_v1.columns
    report = fusion_comparison(labels, voice, loaded_v2, voice_model="demo", text_scores_v1=loaded_v1)
    buckets = report["by_language"]
    assert report["language_min_n"] == 20
    assert buckets["kn"]["n"] == 24
    assert buckets["kn"]["validation"] == "ok"
    assert buckets["kn"]["conditions"]["text_only"]["valence_spearman"] > 0.9
    assert buckets["ta"]["n"] == 8
    assert buckets["ta"]["validation"] == "not validated"
    assert buckets["code_mixed"]["n"] == 8
    assert buckets["code_mixed"]["validation"] == "not validated"
    assert "en" not in buckets
    delta = report["versions"]["delta_v2_minus_v1"]["text_only_valence_spearman"]
    assert delta is not None and delta > 0
    assert report["versions"]["v2"]["question_set"] == "timbre-text-v2"
    assert report["versions"]["v1"]["question_set"] == "timbre-text-v1"
    blob = json.dumps(report)
    assert "cough" not in blob
    assert "worse at night" not in blob

    feat_path = tmp_path / "features.parquet"
    voice.to_parquet(feat_path)
    out = tmp_path / "eval.json"
    main(
        [
            "--labels",
            str(labels_path),
            "--features",
            str(feat_path),
            "--out",
            str(out),
            "--fusion",
            "--text-scores",
            str(v2_path),
            "--text-scores-v1",
            str(v1_path),
            "--voice-model",
            "demo",
        ]
    )
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["fusion"]["by_language"]["kn"]["validation"] == "ok"
    assert saved["fusion"]["by_language"]["ta"]["validation"] == "not validated"
    assert saved["fusion"]["versions"]["delta_v2_minus_v1"]["text_only_valence_spearman"] > 0
