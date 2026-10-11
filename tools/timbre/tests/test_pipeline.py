"""v1 pipeline. Synthetic audio, mocked Clef / R2 / models. No network."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from tools.timbre.audio import synth_speech, write_wav
from tools.timbre.calibrate import CLEF_VALENCE_COL, ODYSSEY_AROUSAL_COL, fit_calibration, save_calibration
from tools.timbre.nemotron_probs import load_nlp, pack_nlp
from tools.timbre.pipeline import (
    PipelineConfig,
    consult_aggregates,
    cross_fit_evaluation,
    cross_fit_predictions,
    format_summary,
    judge_window,
    main,
    run_pipeline,
    unscorable_reason,
)
from tools.timbre.purity import embedding_purity, probs_purity

SENTENCE = "The cough is worse at night and sleep is poor."


class Fake:
    def __init__(self, name, arousal=0.4, valence=3.0, status="ok"):
        self.name = name
        self.arousal = arousal
        self.valence = valence
        self.status = status
        self.n = 0
        self.lengths = []

    def extract(self, audio, sr):
        self.n += 1
        self.lengths.append(int(np.asarray(audio).size))
        if self.status != "ok":
            return {"status": self.status, "features": {}}
        feats = {"arousal": float(self.arousal), "valence": float(self.valence), "dominance": 0.0}
        return {"status": "ok", "features": feats}


class Counting(Fake):
    def __init__(self):
        super().__init__("odyssey")
        self.values = []

    def extract(self, audio, sr):
        row = super().extract(audio, sr)
        row["features"]["arousal"] = float(self.n)
        row["features"]["valence"] = 3.0
        self.values.append(row["features"]["arousal"])
        return row


def _pure_embedding():
    return embedding_purity(np.full(40, 0.9), np.full(40, 0.05), hop_s=0.1)


def _record(wid, **extra):
    rec = {
        "window_id": wid,
        "clip_id": "clipA",
        "room": "room-a",
        "date": "2026-01-01",
        "doctor_uid8": "d0000001",
        "lang": "en",
        "phase": "open",
        "start_s": 0.0,
        "end_s": 4.0,
        "embedding": _pure_embedding(),
        "probs_score": probs_purity(np.tile([0.05, 0.95], (400, 1)), 1, frame_s=0.01, doctor_slot=0),
    }
    rec.update(extra)
    return rec


def _audio_pair():
    return synth_speech(seconds=4.0), 16000


def test_judge_keeps_the_worse_purity():
    high = {"purity": 0.95, "pure_patient_s": 8.0, "cos_patient_mean": 0.8, "n_frames": 10}
    low = {"purity": 0.40, "pure_patient_s": 4.0, "n_frames": 10}
    judged = judge_window(high, low)
    assert judged["purity"] == pytest.approx(0.40)
    assert judged["pure_patient_s"] == pytest.approx(4.0)
    assert judged["keep"] is False
    assert unscorable_reason(judged) == "low_purity"
    other = judge_window(
        {"purity": 0.20, "pure_patient_s": 5.0, "cos_patient_mean": 0.8},
        {"purity": 0.90, "pure_patient_s": 5.0},
    )
    assert other["purity"] == pytest.approx(0.20)
    assert other["keep"] is False


def test_impure_window_is_not_scored_and_log_has_no_ids(monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    odyssey = Fake("odyssey")
    clef = Fake("clef", valence=2.5)
    impure = _record(
        "clipA_p0000000",
        probs_score={"purity": 0.2, "pure_patient_s": 0.4, "n_frames": 10},
    )
    pure = _record("clipA_p0004000", start_s=4.0, end_s=8.0)
    result = run_pipeline(
        PipelineConfig(
            records=[impure, pure],
            audio_by_window={"clipA_p0004000": _audio_pair()},
            odyssey=odyssey,
            clef=clef,
            audeering=Fake("audeering"),
        )
    )
    assert odyssey.n == 1
    assert clef.n == 1
    reasons = dict(zip(result.windows["window_id"], result.windows["reason"]))
    assert reasons["clipA_p0000000"] == "low_purity"
    assert reasons["clipA_p0004000"] == ""
    assert bool(result.windows.loc[result.windows["window_id"] == "clipA_p0000000", "scorable"].iloc[0]) is False
    line = format_summary(result.summary)
    assert "clipA" not in line
    assert "n_windows=2" in line
    assert "n_scorable=1" in line
    assert result.summary["clef_on"] == 1
    assert result.summary["text_lane_on"] == 0
    assert "text_status" not in result.windows.columns


def test_missing_embedding_gate_is_no_voiceprint(monkeypatch):
    monkeypatch.delenv("TIMBRE_CLEF", raising=False)
    odyssey = Fake("odyssey")
    result = run_pipeline(
        PipelineConfig(
            records=[_record("clipA_p0000000", embedding=None)],
            odyssey=odyssey,
            clef=Fake("clef"),
        )
    )
    assert odyssey.n == 0
    assert result.windows.iloc[0]["reason"] == "no_voiceprint"
    assert result.summary["n_clef"] == 0
    assert result.windows.iloc[0]["valence_status"] == "skipped"


def test_audeering_runs_only_as_fallback(monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    odyssey = Fake("odyssey", status="error")
    audeering = Fake("audeering", arousal=0.77)
    clef = Fake("clef", valence=2.0)
    result = run_pipeline(
        PipelineConfig(
            records=[_record("clipA_p0000000")],
            audio_by_window={"clipA_p0000000": _audio_pair()},
            odyssey=odyssey,
            audeering=audeering,
            clef=clef,
        )
    )
    row = result.windows.iloc[0]
    assert odyssey.n == 1
    assert audeering.n == 1
    assert bool(row["audeering_fallback"]) is True
    assert row["arousal_source"] == "audeering"
    assert row["arousal_raw"] == pytest.approx(0.77)
    assert np.isnan(row[ODYSSEY_AROUSAL_COL])
    assert row["valence_raw"] == pytest.approx(2.0)


def test_consult_trajectory_and_scorable_percent():
    frame = pd.DataFrame(
        {
            "window_id": ["c_p0000000", "c_p0001000", "c_p0002000", "c_p0003000"],
            "clip_id": ["c", "c", "c", "c"],
            "room": ["room-a"] * 4,
            "doctor_uid8": ["d"] * 4,
            "start_s": [0.0, 10.0, 20.0, 30.0],
            "scorable": [True, True, True, False],
            "arousal_calibrated": [1.0, 2.0, 3.0, 99.0],
            "arousal_raw": [1.0, 2.0, 3.0, 99.0],
            "valence_calibrated": [2.0, 2.0, 4.0, 99.0],
            "valence_raw": [2.0, 2.0, 4.0, 99.0],
        }
    )
    agg = consult_aggregates(frame)[0]
    assert agg["n_windows"] == 4
    assert agg["n_scorable"] == 3
    assert agg["scorable_pct"] == pytest.approx(75.0)
    assert agg["arousal_median"] == pytest.approx(2.0)
    assert agg["trajectory"]["arousal"] == {"open": 1.0, "mid": 2.0, "close": 3.0}
    assert agg["trajectory"]["valence"]["open"] == pytest.approx(2.0)
    assert agg["trajectory"]["valence"]["close"] == pytest.approx(4.0)


def test_saved_calibration_apply_skips_unscorable(tmp_path, monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    scores = pd.DataFrame(
        {
            "window_id": ["g1", "g2"],
            "room": ["room-a", "room-a"],
            "doctor_uid8": ["d0000001", "d0000001"],
            "batch": [1, 1],
            ODYSSEY_AROUSAL_COL: [0.0, 1.0],
            CLEF_VALENCE_COL: [0.0, 1.0],
        }
    )
    labels = pd.DataFrame(
        {
            "window_id": ["g1", "g2"],
            "room": ["room-a", "room-a"],
            "doctor_uid8": ["d0000001", "d0000001"],
            "batch": [1, 1],
            "arousal": [1.0, 5.0],
            "valence": [1.0, 5.0],
        }
    )
    arousal = tmp_path / "arousal.json"
    valence = tmp_path / "valence.json"
    save_calibration(fit_calibration(scores, labels, score_col=ODYSSEY_AROUSAL_COL, gold_col="arousal", min_n=1), arousal)
    save_calibration(fit_calibration(scores, labels, score_col=CLEF_VALENCE_COL, gold_col="valence", min_n=1), valence)
    result = run_pipeline(
        PipelineConfig(
            records=[_record("clipA_p0000000"), _record("clipA_p0004000", start_s=4, end_s=8, embedding={"purity": 0.1, "pure_patient_s": 0.2})],
            audio_by_window={"clipA_p0000000": _audio_pair()},
            odyssey=Fake("odyssey", arousal=0.5),
            clef=Fake("clef", valence=0.5),
            audeering=Fake("audeering"),
            calibration_arousal=str(arousal),
            calibration_valence=str(valence),
            out=str(tmp_path / "out"),
        )
    )
    kept = result.windows.loc[result.windows["scorable"]].iloc[0]
    dropped = result.windows.loc[~result.windows["scorable"]].iloc[0]
    assert kept["arousal_calibration_level"] == "room"
    assert np.isfinite(kept["arousal_calibrated"])
    assert np.isfinite(kept["valence_calibrated"])
    assert not np.isfinite(dropped["arousal_calibrated"])
    assert (tmp_path / "out" / "windows.parquet").is_file()
    consults = json.loads((tmp_path / "out" / "consults.json").read_text(encoding="utf-8"))
    assert consults["consults"][0]["n_scorable"] == 1
    assert "window_id" not in consults["consults"][0]


def test_nemotron_sessions_r2_and_voiceprint_hole(tmp_path, monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    n = 400
    probs = np.zeros((n, 2))
    probs[:50, 0] = 0.95
    probs[:50, 1] = 0.05
    probs[50:, 0] = 0.05
    probs[50:, 1] = 0.95
    nlp = tmp_path / "nlp"
    nlp.mkdir()
    (nlp / "clipA.nlp").write_bytes(pack_nlp(probs, frame_ms=10))
    loaded = load_nlp(nlp / "clipA.nlp", expected_duration_s=4.0, tol_s=0.1)
    assert loaded.frame_ms == pytest.approx(10)
    emb = np.zeros((n, 2))
    emb[:50, 1] = 1.0
    emb[50:, 0] = 1.0
    emb_dir = tmp_path / "emb"
    emb_dir.mkdir()
    np.save(emb_dir / "clipA.npy", emb)
    (tmp_path / "voiceprints.json").write_text(json.dumps({"d0000001": [0.0, 1.0]}), encoding="utf-8")
    sessions = tmp_path / "sessions.csv"
    sessions.write_text(
        "clip_id,room,date,duration_s,doctor_uid8,lang,phase,r2_key\n"
        "clipA,room-a,2026-01-01,4.0,d0000001,en,consult,clips/clipA.wav\n"
        "clipB,room-a,2026-01-01,4.0,d0000002,en,consult,clips/clipB.wav\n",
        encoding="utf-8",
    )
    wav = tmp_path / "clipA.wav"
    write_wav(wav, synth_speech(seconds=4.0))
    blob = wav.read_bytes()

    class Body:
        def read(self):
            return blob

    class Client:
        def __init__(self):
            self.keys = []

        def get_object(self, Bucket, Key):
            self.keys.append(Key)
            return {"Body": Body()}

    client = Client()
    odyssey = Fake("odyssey", arousal=0.3)
    result = run_pipeline(
        PipelineConfig(
            sessions_csv=str(sessions),
            speaker="nemotron",
            nemotron_dir=str(nlp),
            voiceprints_path=str(tmp_path / "voiceprints.json"),
            embeddings_dir=str(emb_dir),
            use_r2=True,
            r2_client=client,
            odyssey=odyssey,
            audeering=Fake("audeering"),
            clef=Fake("clef", valence=4.0),
        )
    )
    assert client.keys == ["clips/clipA.wav"]
    assert odyssey.n == 1
    assert odyssey.lengths[0] > 16000
    by_clip = dict(zip(result.windows["clip_id"], result.windows["reason"]))
    assert by_clip["clipB"] == "no_voiceprint"
    assert by_clip["clipA"] == ""
    kept = result.windows.loc[result.windows["clip_id"] == "clipA"].iloc[0]
    assert kept["purity"] == pytest.approx(1.0)
    assert kept["pure_patient_s"] == pytest.approx(3.5, abs=0.05)
    assert kept["valence_raw"] == pytest.approx(4.0)
    assert "clipA" not in format_summary(result.summary)


def test_text_lane_v2_is_off_unless_asked(monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    called = {"n": 0}

    def transport(url, body, headers, timeout):
        called["n"] += 1
        raise AssertionError("text lane must stay off")

    run_pipeline(
        PipelineConfig(
            records=[_record("clipA_p0000000")],
            audio_by_window={"clipA_p0000000": _audio_pair()},
            odyssey=Fake("odyssey"),
            clef=Fake("clef"),
            audeering=Fake("audeering"),
            text_transport=transport,
            text_rows=[{"window_id": "clipA_p0000000", "text": SENTENCE}],
        )
    )
    assert called["n"] == 0


def test_text_lane_v2_scores_when_enabled(monkeypatch):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    from tools.timbre.jev_text import _mock_answers
    from tools.timbre.tests.test_jev_text import Script

    script = Script([200], answers=_mock_answers())
    result = run_pipeline(
        PipelineConfig(
            records=[_record("clipA_p0000000")],
            audio_by_window={"clipA_p0000000": _audio_pair()},
            odyssey=Fake("odyssey"),
            clef=Fake("clef"),
            audeering=Fake("audeering"),
            text_lane=True,
            text_rows=[{"window_id": "clipA_p0000000", "text": SENTENCE}],
            text_transport=script,
            text_env={"TIMBRE_TEXT_LANE": "1", "TYPESAFE_API_KEY": "test-key-not-real", "ETA_JEV_MODEL": "jev-1.13.0"},
        )
    )
    assert script.n == 1
    row = result.windows.iloc[0]
    assert row["text_question_set"] == "timbre-text-v2"
    assert row["text_status"] == "ok"
    assert np.isfinite(row["text_valence"])
    assert SENTENCE not in json.dumps(row.to_dict(), default=str)


def test_cross_fit_does_not_use_held_out_gold():
    raw = [0.1, 0.4, 0.7, 1.0]
    rows = []
    for batch, gold_a, gold_v in (("1", [1, 2, 3, 4], [1, 2, 3, 4]), ("2", [5, 4, 3, 2], [5, 4, 3, 2])):
        for i, (score, a, v) in enumerate(zip(raw, gold_a, gold_v)):
            rows.append(
                {
                    "window_id": f"b{batch}-{i}",
                    "clip_id": f"c{batch}",
                    "room": "room-a",
                    "date": "2026-01-01",
                    "doctor_uid8": "d0000001",
                    "batch": batch,
                    "arousal": a,
                    "valence": v,
                    ODYSSEY_AROUSAL_COL: score,
                    CLEF_VALENCE_COL: score,
                    "scorable": True,
                }
            )
    rows.append(
        {
            "window_id": "b1-extra",
            "clip_id": "c1",
            "room": "room-b",
            "date": "2026-01-02",
            "doctor_uid8": "d0000001",
            "batch": "1",
            "arousal": 3,
            "valence": 3,
            ODYSSEY_AROUSAL_COL: np.nan,
            CLEF_VALENCE_COL: np.nan,
            "scorable": False,
        }
    )
    frame = pd.DataFrame(rows)
    labels = frame[["window_id", "batch", "room", "date", "doctor_uid8", "arousal", "valence"]].copy()
    scores = frame.drop(columns=["arousal", "valence", "batch"])
    before, _meta = cross_fit_predictions(scores, labels, batch_col="batch")
    flipped = labels.copy()
    flipped.loc[flipped["batch"] == "2", "arousal"] = 1
    flipped.loc[flipped["batch"] == "2", "valence"] = 1
    after, meta = cross_fit_predictions(scores, flipped, batch_col="batch")
    assert meta["method"] == "batch-swap"
    assert meta["leakage"]["overlapping_ids"] == 0
    b2_before = before.loc[before["batch_label"] == "2"].sort_values("window_id")
    b2_after = after.loc[after["batch_label"] == "2"].sort_values("window_id")
    assert np.allclose(b2_before["arousal_calibrated"], b2_after["arousal_calibrated"])
    assert np.allclose(b2_before["valence_calibrated"], b2_after["valence_calibrated"])
    b1_before = before.loc[before["batch_label"] == "1"].sort_values("window_id")["arousal_calibrated"].to_numpy()
    b1_after = after.loc[after["batch_label"] == "1"].sort_values("window_id")["arousal_calibrated"].to_numpy()
    finite = np.isfinite(b1_before) & np.isfinite(b1_after)
    assert finite.any()
    assert not np.allclose(b1_before[finite], b1_after[finite])
    report = cross_fit_evaluation(scores, labels, batch_col="batch")
    blob = json.dumps(report)
    assert "b1-0" not in blob
    assert "b2-3" not in blob
    assert report["arousal"]["raw"]["pooled"]["n"] >= 4
    assert report["arousal"]["calibrated"]["by_batch"]["1"]["n"] >= 2
    assert report["valence"]["calibrated"]["by_batch"]["2"]["spearman"] is not None
    rates = {row["room"]: row["scorable_rate"] for row in report["scorable_rate_by_room"]}
    assert rates["room-a"] == pytest.approx(1.0)
    assert rates["room-b"] == pytest.approx(0.0)


def test_room_day_group_kfold_when_one_batch():
    rows = []
    for day, i0 in (("2026-01-01", 0), ("2026-01-02", 4)):
        for i, score in enumerate((0.1, 0.4, 0.7, 1.0)):
            rows.append(
                {
                    "window_id": f"d{day[-1]}-{i}",
                    "room": "room-a",
                    "date": day,
                    "doctor_uid8": "d0000001",
                    "batch": "1",
                    "arousal": i0 + i + 1,
                    "valence": i + 1,
                    ODYSSEY_AROUSAL_COL: score,
                    CLEF_VALENCE_COL: score,
                    "scorable": True,
                }
            )
    frame = pd.DataFrame(rows)
    labels = frame[["window_id", "batch", "room", "date", "doctor_uid8", "arousal", "valence"]]
    scores = frame.drop(columns=["arousal", "valence"])
    _oof, meta = cross_fit_predictions(scores, labels, batch_col="batch", cv="room-day")
    assert meta["method"] == "room-day"
    assert meta["leakage"]["overlapping_ids"] == 0
    assert len(meta["folds"]) == 2
    with pytest.raises(Exception):
        cross_fit_predictions(
            scores.assign(date="2026-01-01"),
            labels.assign(date="2026-01-01"),
            batch_col="batch",
            cv="batch",
        )


def test_cli_score_and_evaluate(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    monkeypatch.delenv("HF_TOKEN", raising=False)

    def fake_build(name, device="cpu"):
        if "audeering" in name:
            return Fake(name, arousal=0.2)
        if "clef" in name:
            return Fake(name, valence=3.5)
        return Fake(name, arousal=0.6)

    monkeypatch.setattr("tools.timbre.extractors.base.build_extractor", fake_build)
    wid = "clipA_p0000000"
    audio = tmp_path / "audio"
    audio.mkdir()
    write_wav(audio / f"{wid}.wav", synth_speech(seconds=4.0))
    windows = tmp_path / "windows.csv"
    windows.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role,purity,pure_patient_s,cos_patient_mean,doctor_uid8\n"
        f"{wid},room-a,2026-01-01,en,open,0,4,3.5,patient,0.91,3.6,0.62,d0000001\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"
    main(
        [
            "--windows",
            str(windows),
            "--audio-dir",
            str(audio),
            "--out",
            str(out),
        ]
    )
    logged = capsys.readouterr().out
    assert wid not in logged
    assert "n_scorable=1" in logged
    table = pd.read_parquet(out / "windows.parquet")
    assert bool(table.iloc[0]["scorable"]) is True
    assert table.iloc[0]["arousal_raw"] == pytest.approx(0.6)
    assert table.iloc[0]["valence_raw"] == pytest.approx(3.5)
    assert table.iloc[0]["audeering_fallback"] == False

    gold1 = tmp_path / "b1.csv"
    gold2 = tmp_path / "b2.csv"
    header = "window_id,batch,room,date,doctor_uid8,arousal,valence\n"
    lines = []
    score_rows = []
    for batch, path in (("1", gold1), ("2", gold2)):
        body = []
        for i, score in enumerate((0.1, 0.4, 0.7, 1.0)):
            wid_i = f"g{batch}{i}"
            body.append(f"{wid_i},{batch},room-a,2026-01-0{batch},d0000001,{i+1},{i+1}\n")
            score_rows.append(
                {
                    "window_id": wid_i,
                    "clip_id": f"g{batch}",
                    "room": "room-a",
                    "date": f"2026-01-0{batch}",
                    "doctor_uid8": "d0000001",
                    "scorable": True,
                    ODYSSEY_AROUSAL_COL: score,
                    CLEF_VALENCE_COL: score,
                    "arousal_raw": score,
                    "valence_raw": score,
                }
            )
        path.write_text(header + "".join(body), encoding="utf-8")
    scores_path = tmp_path / "scores.parquet"
    pd.DataFrame(score_rows).to_parquet(scores_path, index=False)
    eval_out = tmp_path / "eval.json"
    main(
        [
            "evaluate",
            "--scores",
            str(scores_path),
            "--gold-labels",
            str(gold1),
            str(gold2),
            "--batch-col",
            "batch",
            "--out",
            str(eval_out),
        ]
    )
    eval_log = capsys.readouterr().out
    assert "g10" not in eval_log
    assert "method=batch-swap" in eval_log
    assert "overlap=0" in eval_log
    report = json.loads(eval_out.read_text(encoding="utf-8"))
    assert report["leakage"]["overlapping_ids"] == 0
    assert "g10" not in eval_out.read_text(encoding="utf-8")
    assert {row["room"] for row in report["scorable_rate_by_room"]} == {"room-a"}
