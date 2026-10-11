"""Scale runner: shards, purity, mocked R2, mocked models, aggregates."""

from __future__ import annotations

import hashlib
import json
import os

import numpy as np
import pandas as pd
import pytest

from tools.timbre.audio import synth_silence, synth_speech, write_wav
from tools.timbre.catalog import SPEC_BY_NAME
from tools.timbre.entrypoint import argv_from_environ, prepare_argv
from tools.timbre.extractors.base import Extractor
from tools.timbre.mem import InsufficientMemory
from tools.timbre.population import population_report
from tools.timbre.purity import PurityRule
from tools.timbre.r2audio import R2AudioError, allowed_audio_key, fetch_audio, resolve_prefixes
from tools.timbre.scale import (
    BATCH1_MODELS,
    acquire_shard_lock,
    apply_purity,
    estimate_compute,
    load_dtype,
    load_purity_table,
    main,
    release_shard_lock,
    resolve_device,
    run_scale,
    slice_audio,
)
from tools.timbre.windows import Window, window_id_at
from tools.timbre.workqueue import group_by_shard, shard_index


class _Body:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self):
        return self._payload


class _R2:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = objects
        self.gets: list[dict] = []

    def get_object(self, **kwargs):
        self.gets.append(kwargs)
        key = kwargs["Key"]
        if key not in self.objects:
            raise RuntimeError(f"missing {key}")
        return {"Body": _Body(self.objects[key])}

    def put_object(self, **kwargs):
        raise AssertionError("write")


class _Mean(Extractor):
    scalar_names = ("loud_med",)

    def __init__(self, name="egemaps_v02.v1"):
        super().__init__(SPEC_BY_NAME[name], "cpu")
        self.calls = 0
        self.batches: list[int] = []

    def extract(self, audio, sr):
        self.calls += 1
        return super().extract(audio, sr)

    def _extract(self, audio, sr):
        return {"loud_med": float(np.mean(np.abs(audio)))}, None, "rev-test"


class _BatchMean(_Mean):
    def extract_batch(self, audios, sr):
        self.batches.append(len(audios))
        return [self.extract(audio, sr) for audio in audios]


class _Flaky(Extractor):
    scalar_names = ("loud_med",)

    def __init__(self):
        super().__init__(SPEC_BY_NAME["egemaps_v02.v1"], "cpu")
        self.calls = 0

    def _extract(self, audio, sr):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("boom")
        return {"loud_med": 0.2}, None, "rev-test"


class _Hungry(Extractor):
    def __init__(self):
        super().__init__(SPEC_BY_NAME["egemaps_v02.v1"], "cpu")
        self.calls = 0

    def _extract(self, audio, sr):
        self.calls += 1
        raise InsufficientMemory(self.spec.name, 99.0, 0.1)


def _wav_bytes(tmp_path, seconds: float) -> bytes:
    path = tmp_path / "clip.wav"
    write_wav(path, synth_speech(seconds=seconds))
    return path.read_bytes()


def _clips(path, rows: list[str]) -> None:
    path.write_text(
        "clip_id,room,date,lang,phase,doctor_uid8,r2_key,duration_s,role\n" + "\n".join(rows) + "\n",
        encoding="utf-8",
    )


def _purity(path, window_ids: list[str], *, purity=0.9, pure_s=3.5, cos=0.55) -> None:
    lines = ["window_id,purity,pure_patient_s,cos_patient_mean"]
    for wid in window_ids:
        lines.append(f"{wid},{purity},{pure_s},{cos}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _scan(root) -> bytes:
    blob = b""
    for path in root.rglob("*"):
        if path.is_file():
            blob += path.read_bytes()
    return blob


def test_slice_and_shard_follow_the_clip():
    audio = np.arange(32_000, dtype=np.float32)
    cut = slice_audio(audio, 16_000, 1.0, 2.0)
    assert cut.size == 16_000
    assert cut[0] == pytest.approx(16_000)
    windows = [
        Window("a_p0000000", "R", "2026-01-01", "en", "open", 0, 1, 1, "patient", "same", None, {}),
        Window("a_p0001000", "R", "2026-01-01", "en", "open", 1, 2, 1, "patient", "same", None, {}),
        Window("b_p0000000", "R", "2026-01-01", "en", "open", 0, 1, 1, "patient", "other", None, {}),
    ]
    grouped = group_by_shard(
        [
            {"clip_id": w.clip_id, "window_id": w.window_id, "model_name": "m", "model_version": "m"}
            for w in windows
        ],
        8,
    )
    homes = {item["window_id"]: shard for shard, items in grouped.items() for item in items}
    assert homes["a_p0000000"] == homes["a_p0001000"]
    assert shard_index("same", 8) == homes["a_p0000000"]


def test_purity_rule_keeps_the_batch1_threshold_and_frame_evidence(tmp_path):
    keep = Window("s_p0000000", "R", "2026-01-01", "", "", 0, 10, 10, "patient", "s", None, {})
    drop = Window("s_p0010000", "R", "2026-01-01", "", "", 10, 20, 10, "patient", "s", None, {})
    scores = {
        keep.window_id: {"purity": 0.6, "pure_patient_s": 3.0, "cos_patient_mean": 0.30},
        drop.window_id: {"purity": 0.59, "pure_patient_s": 3.0, "cos_patient_mean": 0.90},
    }
    kept, counts = apply_purity([keep, drop], scores, PurityRule())
    assert [w.window_id for w in kept] == [keep.window_id]
    assert counts["n_dropped_rule"] == 1
    assert kept[0].patient_speech_s == 3.0

    path = tmp_path / "purity.csv"
    cos = json.dumps([0.8, 0.8, 0.8, 0.8, 0.8, 0.8])
    other = json.dumps([0.1, 0.1, 0.1, 0.1, 0.1, 0.1])
    probs = json.dumps([[0.0, 1.0], [0.0, 1.0], [0.0, 1.0]])
    path.write_text(
        "window_id,cos_patient,cos_other,hop_s\n"
        f"good_p0000000,\"{cos}\",\"{other}\",0.5\n",
        encoding="utf-8",
    )
    loaded = load_purity_table(path)
    assert PurityRule().passes(loaded["good_p0000000"])
    probs_path = tmp_path / "probs.csv"
    probs_path.write_text(
        "window_id,probs,patient_slot,frame_s\n"
        f"prob_p0000000,\"{probs}\",1,1\n",
        encoding="utf-8",
    )
    loaded = load_purity_table(probs_path)
    assert PurityRule().passes(loaded["prob_p0000000"])


def test_estimate_uses_audio_hours_times_rate_and_leaves_unmeasured_null():
    est = estimate_compute(3600.0, ["odyssey_wavlm_dim.v1", "voxprofile_whisper_dim.v1"], None, 1.5)
    assert est["formula"] == "compute_hours = audio_hours * s_per_audio_s"
    by = {row["model"]: row for row in est["per_model"]}
    assert by["odyssey_wavlm_dim.v1"]["s_per_audio_s"] == pytest.approx(0.08)
    assert by["odyssey_wavlm_dim.v1"]["compute_hours"] == pytest.approx(0.08)
    assert by["voxprofile_whisper_dim.v1"]["s_per_audio_s"] is None
    assert "UNVERIFIED" in by["voxprofile_whisper_dim.v1"]["note"]
    assert est["complete"] is False
    assert est["cost_usd"] is None
    assert est["compute_hours_measured"] == pytest.approx(0.08)
    done = estimate_compute(3600.0, ["odyssey_wavlm_dim.v1"], {"odyssey_wavlm_dim.v1": 2.0}, 1.5)
    assert done["complete"] is True
    assert done["compute_hours"] == pytest.approx(2.0)
    assert done["cost_usd"] == pytest.approx(3.0)
    assert done["per_model"][0]["rate_source"] == "override"


def test_whisper_dtype_policy_is_float32_and_device_auto_is_explicit():
    assert load_dtype("voxprofile_whisper_dim.v1") == "float32"
    assert load_dtype("whisper_large_v3_encoder.v1") == "float32"
    assert load_dtype("odyssey_wavlm_dim.v1") == "model_default"
    assert resolve_device("cpu") == ("cpu", "requested cpu")
    assert resolve_device("cuda")[0] == "cuda"
    assert set(BATCH1_MODELS) == {
        "odyssey_wavlm_dim.v1",
        "audeering_msp_dim.v1",
        "voxprofile_whisper_dim.v1",
        "egemaps_v02.v1",
    }


def test_r2_is_read_only_and_refuses_non_audio(monkeypatch):
    with pytest.raises(R2AudioError, match="refusing"):
        allowed_audio_key("consult-clips/a/timeline.json")
    with pytest.raises(R2AudioError, match="refusing"):
        allowed_audio_key("consult-clips/../secret.wav")
    with pytest.raises(R2AudioError, match="refusing"):
        allowed_audio_key("other/a.wav")
    assert resolve_prefixes("lab-audio") == ("lab-audio/",)
    monkeypatch.delenv("R2_ENDPOINT", raising=False)
    monkeypatch.delenv("R2_ACCESS_KEY_ID", raising=False)
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "super-secret-value")
    with pytest.raises(R2AudioError, match="R2_ENDPOINT") as caught:
        fetch_audio("consult-clips/a.wav")
    assert "super-secret-value" not in str(caught.value)
    client = _R2({"consult-clips/a.wav": b"wav"})
    assert fetch_audio("consult-clips/a.wav", client=client) == b"wav"
    assert client.gets[0]["Bucket"] == "eta-audio"
    with pytest.raises(AssertionError):
        client.put_object(Bucket="eta-audio", Key="consult-clips/a.wav")


def test_dry_run_plans_without_fetch_or_ids(tmp_path, monkeypatch):
    secret = "hf-secret-token-value"
    monkeypatch.setenv("HF_TOKEN", secret)
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", secret)
    sessions = tmp_path / "sessions.csv"
    _clips(
        sessions,
        ["hourclip,ROOM-A,2026-01-01,en,consult,d0000001,consult-clips/synth/hour.wav,3600,patient"],
    )
    purity = tmp_path / "purity.csv"
    _purity(purity, [window_id_at("hourclip", 0)])
    out = tmp_path / "out"
    client = _R2({})
    plan = run_scale(
        sessions,
        purity,
        out,
        models="batch1",
        device="cpu",
        dry_run=True,
        gpu_usd_per_hour=1.5,
        window_s=3600,
        hop_s=3600,
        client=client,
    )
    assert plan["dry_run"] is True
    assert plan["n_windows_kept"] == 1
    assert plan["device"] == "cpu"
    assert plan["dtypes"]["voxprofile_whisper_dim.v1"] == "float32"
    assert plan["estimate"]["cost_usd"] is None
    assert plan["estimate"]["per_model"][0]["model"] == "odyssey_wavlm_dim.v1"
    assert client.gets == []
    assert not (out / "queue").exists()
    assert not (out / "cache").exists()
    text = (out / "plan.json").read_text(encoding="utf-8")
    assert window_id_at("hourclip", 0) not in text
    assert "hourclip" not in text
    assert "d0000001" not in text
    assert "consult-clips" not in text
    assert secret not in text
    odyssey = run_scale(
        sessions,
        purity,
        tmp_path / "ody",
        models="odyssey",
        device="cpu",
        dry_run=True,
        gpu_usd_per_hour=1.5,
        window_s=3600,
        hop_s=3600,
        client=client,
    )
    assert odyssey["estimate"]["compute_hours"] == pytest.approx(0.08)
    assert odyssey["estimate"]["cost_usd"] == pytest.approx(0.12)


def test_scores_batches_resumes_and_hides_ids(tmp_path):
    key = "consult-clips/synth/a.wav"
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, [f"synthA,ROOM-A,2026-01-01,en,consult,d0000001,{key},2,patient"])
    ids = [window_id_at("synthA", 0), window_id_at("synthA", 1000)]
    purity = tmp_path / "purity.csv"
    _purity(purity, ids)
    blob = _wav_bytes(tmp_path, 2.0)
    client = _R2({key: blob})
    model = _BatchMean()
    out = tmp_path / "out"
    manifest = run_scale(
        sessions,
        purity,
        out,
        models="egemaps",
        device="cpu",
        window_s=1,
        hop_s=1,
        min_window_s=1,
        batch_size=8,
        n_shards=4,
        min_group_n=1,
        extractors={"egemaps_v02.v1": model},
        client=client,
    )
    assert model.calls == 2
    assert model.batches == [2]
    assert len(client.gets) == 1
    assert client.gets[0]["Bucket"] == "eta-audio"
    assert client.gets[0]["Key"] == key
    cached = list((out / "cache").iterdir())
    assert len(cached) == 1
    assert cached[0].stem == hashlib.sha256(key.encode()).hexdigest()
    assert cached[0].stat().st_mode & 0o777 == 0o600
    shard = next((out / "shards").glob("shard-*/*.parquet"))
    scored = pd.read_parquet(shard)
    assert set(scored["model_version"]) == {"egemaps_v02.v1"}
    assert set(scored["window_id"]) == set(ids)
    again = run_scale(
        sessions,
        purity,
        out,
        models="egemaps",
        device="cpu",
        window_s=1,
        hop_s=1,
        min_window_s=1,
        batch_size=8,
        n_shards=4,
        min_group_n=1,
        extractors={"egemaps_v02.v1": model},
        client=client,
    )
    assert model.calls == 2
    assert len(client.gets) == 1
    assert again["per_model"]["egemaps_v02.v1"]["n_ok"] == 2
    assert again["per_model"]["egemaps_v02.v1"]["s_per_audio_s"] is not None
    features = pd.read_parquet(out / "merged" / "features.parquet")
    assert "r2_key" not in features.columns
    assert "egemaps_v02.v1__loud_med" in features.columns
    report_text = (out / "report" / "population.json").read_text(encoding="utf-8")
    report = json.loads(report_text)
    assert report["groups"][0]["room"] == "ROOM-A"
    assert report["groups"][0]["doctor_uid8"] == "d0000001"
    assert report["groups"][0]["day"] == "2026-01-01"
    assert report["groups"][0]["n"] == 2
    for wid in ids:
        assert wid not in report_text
    assert "synthA" not in report_text
    assert key not in report_text
    public = _scan(out / "report") + (out / "plan.json").read_bytes() + (out / "manifest.json").read_bytes()
    public += (out / "throughput.jsonl").read_bytes()
    for wid in ids:
        assert wid.encode() not in public
    line = json.loads((out / "throughput.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert line["batch_n"] == 2
    assert line["dtype"] == "model_default"
    assert "window_id" not in line


def test_silence_is_a_finished_nan_and_is_not_retried(tmp_path):
    key = "consult-clips/synth/quiet.wav"
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, [f"quiet,ROOM-Q,2026-01-08,en,consult,d0000008,{key},1,patient"])
    purity = tmp_path / "purity.csv"
    _purity(purity, [window_id_at("quiet", 0)])
    path = tmp_path / "quiet.wav"
    write_wav(path, synth_silence(seconds=1.0))
    client = _R2({key: path.read_bytes()})
    model = _Mean()
    out = tmp_path / "out"
    kw = dict(
        models="egemaps",
        device="cpu",
        window_s=1,
        hop_s=1,
        n_shards=1,
        min_group_n=1,
        extractors={"egemaps_v02.v1": model},
        client=client,
    )
    run_scale(sessions, purity, out, **kw)
    assert model.calls == 1
    frame = pd.read_parquet(out / "shards" / "shard-0000" / "egemaps_v02.v1.parquet")
    assert list(frame["status"]) == ["nan"]
    run_scale(sessions, purity, out, **kw)
    assert model.calls == 1


def test_error_retries_and_other_model_version_does_not_count(tmp_path):
    key = "consult-clips/synth/b.wav"
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, [f"synthB,ROOM-B,2026-01-02,en,consult,d0000002,{key},1,patient"])
    wid = window_id_at("synthB", 0)
    purity = tmp_path / "purity.csv"
    _purity(purity, [wid])
    client = _R2({key: _wav_bytes(tmp_path, 1.0)})
    flaky = _Flaky()
    out = tmp_path / "out"
    kw = dict(
        models="egemaps",
        device="cpu",
        window_s=1,
        hop_s=1,
        n_shards=1,
        min_group_n=1,
        client=client,
    )
    run_scale(sessions, purity, out, extractors={"egemaps_v02.v1": flaky}, **kw)
    assert flaky.calls == 1
    run_scale(sessions, purity, out, extractors={"egemaps_v02.v1": flaky}, **kw)
    assert flaky.calls == 2
    frame = pd.read_parquet(out / "shards" / "shard-0000" / "egemaps_v02.v1.parquet")
    assert set(frame["status"]) == {"ok"}

    other = frame.copy()
    other["model_version"] = "other.v9"
    other["status"] = "ok"
    # Replace the finished current-version row with a different version only.
    other.to_parquet(out / "shards" / "shard-0000" / "egemaps_v02.v1.parquet", index=False)
    fresh = _Mean()
    run_scale(sessions, purity, out, extractors={"egemaps_v02.v1": fresh}, **kw)
    assert fresh.calls == 1
    both = pd.read_parquet(out / "shards" / "shard-0000" / "egemaps_v02.v1.parquet")
    assert set(both["model_version"]) == {"other.v9", "egemaps_v02.v1"}
    run_scale(sessions, purity, out, extractors={"egemaps_v02.v1": fresh}, **kw)
    assert fresh.calls == 1


def test_queue_loss_and_purity_drop_keep_the_shard_row(tmp_path):
    key = "consult-clips/synth/c.wav"
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, [f"synthC,ROOM-C,2026-01-03,en,consult,d0000003,{key},2,patient"])
    ids = [window_id_at("synthC", 0), window_id_at("synthC", 1000)]
    purity = tmp_path / "purity.csv"
    _purity(purity, ids)
    client = _R2({key: _wav_bytes(tmp_path, 2.0)})
    model = _Mean()
    out = tmp_path / "out"
    kw = dict(
        models="egemaps",
        device="cpu",
        window_s=1,
        hop_s=1,
        n_shards=1,
        min_group_n=1,
        extractors={"egemaps_v02.v1": model},
        client=client,
    )
    run_scale(sessions, purity, out, **kw)
    assert model.calls == 2
    import shutil

    shutil.rmtree(out / "queue")
    run_scale(sessions, purity, out, **kw)
    assert model.calls == 2
    _purity(purity, [ids[0]])
    run_scale(sessions, purity, out, **kw)
    assert model.calls == 2
    shard = pd.read_parquet(out / "shards" / "shard-0000" / "egemaps_v02.v1.parquet")
    assert set(shard["window_id"]) == set(ids)
    features = pd.read_parquet(out / "merged" / "features.parquet")
    assert set(features["window_id"]) == {ids[0]}


def test_one_shard_does_not_fetch_the_other(tmp_path):
    n_shards = 8
    left = right = ""
    left_shard = right_shard = 0
    for i in range(400):
        a, b = f"clipL{i}", f"clipR{i}"
        sa, sb = shard_index(a, n_shards), shard_index(b, n_shards)
        if sa != sb:
            left, right, left_shard, right_shard = a, b, sa, sb
            break
    assert left and right and left_shard != right_shard
    key_l = "consult-clips/synth/left.wav"
    key_r = "consult-clips/synth/right.wav"
    sessions = tmp_path / "sessions.csv"
    _clips(
        sessions,
        [
            f"{left},ROOM-A,2026-01-01,en,consult,d0000001,{key_l},1,patient",
            f"{right},ROOM-B,2026-01-01,en,consult,d0000002,{key_r},1,patient",
        ],
    )
    purity = tmp_path / "purity.csv"
    _purity(purity, [window_id_at(left, 0), window_id_at(right, 0)])
    blob = _wav_bytes(tmp_path, 1.0)
    client = _R2({key_l: blob, key_r: blob})
    model = _Mean()
    run_scale(
        sessions,
        purity,
        tmp_path / "out",
        models="egemaps",
        device="cpu",
        window_s=1,
        hop_s=1,
        n_shards=n_shards,
        shard=left_shard,
        min_group_n=1,
        extractors={"egemaps_v02.v1": model},
        client=client,
    )
    assert model.calls == 1
    assert [call["Key"] for call in client.gets] == [key_l]


def test_ram_gate_skips_without_building_or_fetching(tmp_path, monkeypatch):
    key = "consult-clips/synth/d.wav"
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, [f"synthD,ROOM-D,2026-01-04,en,consult,d0000004,{key},1,patient"])
    purity = tmp_path / "purity.csv"
    _purity(purity, [window_id_at("synthD", 0)])
    client = _R2({key: _wav_bytes(tmp_path, 1.0)})
    monkeypatch.setattr("tools.timbre.scale.mem_available_gb", lambda: 0.01)

    def _refuse(name, device="cpu"):
        raise AssertionError(f"built {name} on {device}")

    monkeypatch.setattr("tools.timbre.extractors.base.build_extractor", _refuse)
    manifest = run_scale(
        sessions,
        purity,
        tmp_path / "out",
        models="egemaps",
        device="cpu",
        window_s=1,
        hop_s=1,
        n_shards=1,
        client=client,
    )
    assert client.gets == []
    assert manifest["per_model"]["egemaps_v02.v1"]["n_skipped"] == 1
    assert manifest["per_model"]["egemaps_v02.v1"]["n_ok"] == 0


def test_cuda_auto_passes_the_device_and_not_a_dtype(tmp_path, monkeypatch):
    key = "consult-clips/synth/e.wav"
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, [f"synthE,ROOM-E,2026-01-05,en,consult,d0000005,{key},1,patient"])
    purity = tmp_path / "purity.csv"
    _purity(purity, [window_id_at("synthE", 0)])
    seen = []

    def _spy(name, device="cpu"):
        seen.append((name, device))
        ext = _Mean(name)
        return ext

    monkeypatch.setattr("tools.timbre.scale.mem_available_gb", lambda: 64.0)
    monkeypatch.setattr("tools.timbre.scale._cuda_available", lambda: True)
    monkeypatch.setattr("tools.timbre.extractors.base.build_extractor", _spy)
    manifest = run_scale(
        sessions,
        purity,
        tmp_path / "out",
        models="whisper",
        device="auto",
        window_s=1,
        hop_s=1,
        n_shards=1,
        min_group_n=1,
        client=_R2({key: _wav_bytes(tmp_path, 1.0)}),
    )
    assert seen == [("whisper_large_v3_encoder.v1", "cuda")]
    assert manifest["dtypes"]["whisper_large_v3_encoder.v1"] == "float32"
    assert manifest["device"] == "cuda"


def test_table_input_is_not_recut_and_secrets_are_redacted(tmp_path, monkeypatch):
    secret = "super-secret-value"
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", secret)
    key = "consult-clips/synth/table.wav"
    sessions = tmp_path / "windows.csv"
    sessions.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role,doctor_uid8,r2_key\n"
        f"synthT_p0000000,ROOM-T,2026-01-06,en,open,0,1,0.4,patient,d0000006,{key}\n",
        encoding="utf-8",
    )
    purity = tmp_path / "purity.csv"
    _purity(purity, ["synthT_p0000000"])

    class _Boom(_R2):
        def get_object(self, **kwargs):
            raise RuntimeError(f"denied {secret} for {kwargs['Key']}")

    out = tmp_path / "out"
    run_scale(
        sessions,
        purity,
        out,
        models="egemaps",
        device="cpu",
        n_shards=1,
        min_group_n=1,
        extractors={"egemaps_v02.v1": _Mean()},
        client=_Boom({}),
    )
    assert secret.encode() not in _scan(out)
    assert b"synthT_p0000000" not in (out / "report" / "population.json").read_bytes()
    missing = tmp_path / "missing.csv"
    missing.write_text(
        "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s\n"
        "synthT_p0000000,ROOM-T,2026-01-06,en,open,0,1,0.4\n",
        encoding="utf-8",
    )
    with pytest.raises(Exception, match="r2_key"):
        run_scale(missing, purity, tmp_path / "bad", models="egemaps", device="cpu", dry_run=True)


def test_bad_key_and_lock_and_small_population(tmp_path):
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, ["synthZ,ROOM-Z,2026-01-07,en,consult,d0000007,consult-clips/x/timeline.json,10,patient"])
    purity = tmp_path / "purity.csv"
    _purity(purity, [window_id_at("synthZ", 0)])
    with pytest.raises(R2AudioError, match="refusing audio key"):
        run_scale(sessions, purity, tmp_path / "out", dry_run=True, device="cpu", window_s=10, hop_s=10)
    lock = tmp_path / "shard.lock"
    fd = acquire_shard_lock(lock)
    with pytest.raises(Exception, match="locked"):
        acquire_shard_lock(lock)
    release_shard_lock(fd, lock)
    stale = tmp_path / "stale.lock"
    stale.write_text("99999999", encoding="utf-8")
    fd = acquire_shard_lock(stale)
    release_shard_lock(fd, stale)

    frame = pd.DataFrame(
        {
            "room": ["ROOM-A"],
            "doctor_uid8": ["d0000001"],
            "date": ["2026-01-01"],
            "window_id": ["synthA_p0000000"],
            "clip_id": ["synthA"],
            "m__arousal": [0.424242],
            "m__embedding": [[1.0, 2.0]],
        }
    )
    hidden = population_report(frame, min_group_n=5)
    assert hidden["overall_suppressed"] is True
    assert hidden["groups"] == []
    dumped = json.dumps(hidden)
    assert "0.424242" not in dumped
    assert "synthA_p0000000" not in dumped
    assert "window_id" not in dumped
    big = pd.DataFrame(
        {
            "room": ["ROOM-A"] * 5 + ["ROOM-B"] * 2,
            "doctor_uid8": ["d0000001"] * 5 + ["d0000002"] * 2,
            "date": ["2026-01-01"] * 7,
            "window_id": [f"secret-window-{i}" for i in range(7)],
            "m__arousal": [1, 2, 3, 4, 5, 9, 9],
        }
    )
    shown = population_report(big, min_group_n=5)
    assert [g["room"] for g in shown["groups"]] == ["ROOM-A"]
    assert shown["n_groups_suppressed"] == 1
    assert shown["n_rows_suppressed"] == 2
    assert "secret-window-0" not in json.dumps(shown)
    assert shown["overall"]["m__arousal"]["n_finite"] == 7


def test_cli_and_entrypoint_do_not_put_secrets_on_the_argv(tmp_path, monkeypatch, capsys):
    sessions = tmp_path / "sessions.csv"
    _clips(sessions, ["hourclip,ROOM-A,2026-01-01,en,consult,d0000001,consult-clips/synth/hour.wav,10,patient"])
    purity = tmp_path / "purity.csv"
    _purity(purity, [window_id_at("hourclip", 0)])
    out = tmp_path / "out"
    main(
        [
            "--sessions",
            str(sessions),
            "--purity",
            str(purity),
            "--out",
            str(out),
            "--dry-run",
            "--device",
            "cpu",
            "--models",
            "egemaps",
            "--window-s",
            "10",
            "--hop-s",
            "10",
        ]
    )
    printed = capsys.readouterr().out
    assert "dry_run=True" in printed
    assert "hourclip_p" not in printed
    monkeypatch.setenv("TIMBRE_SESSIONS", "sessions.csv")
    monkeypatch.setenv("TIMBRE_PURITY", "purity.csv")
    monkeypatch.setenv("TIMBRE_OUT", "/data/out")
    monkeypatch.setenv("TIMBRE_DRY_RUN", "1")
    monkeypatch.setenv("HF_TOKEN", "hf-secret-token-value")
    argv = argv_from_environ()
    assert "--sessions" in argv and "--dry-run" in argv
    assert "hf-secret-token-value" not in argv
    prepared = prepare_argv(["--sessions", "s.csv", "--purity", "p.csv", "--out", "/out"])
    assert prepared[-1] == "--dry-run"


def test_dockerfile_entrypoint_has_no_secrets():
    root = os.path.join(os.path.dirname(__file__), "..")
    docker = open(os.path.join(root, "Dockerfile"), encoding="utf-8").read()
    entry = open(os.path.join(root, "entrypoint.py"), encoding="utf-8").read()
    assert "tools.timbre.entrypoint" in docker
    assert "ENTRYPOINT" in docker
    assert "BASE_IMAGE" in docker
    assert "HF_TOKEN=" not in docker
    assert "R2_SECRET" not in docker
    assert "AKIA" not in docker
    assert "HF_TOKEN=" not in entry
    assert "R2_SECRET_ACCESS_KEY=" not in entry
    assert "put_object" not in entry
