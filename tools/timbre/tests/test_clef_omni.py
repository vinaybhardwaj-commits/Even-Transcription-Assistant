"""Clef-omni client. No network and no real audio."""

from __future__ import annotations

import base64
import io
import json
import logging
import threading
import urllib.error
import urllib.request

import numpy as np
import pandas as pd
import pytest

from tools.timbre.audio import synth_silence, synth_speech, write_wav
from tools.timbre.catalog import SPEC_BY_NAME, resolve_model_names
from tools.timbre.extractors.base import build_extractor
from tools.timbre.extractors.clef_omni import (
    DEFAULT_CONCURRENCY,
    FEATURE_NAMES,
    MAX_CLIP_S,
    MAX_CLIPS,
    MAX_WAV_BYTES,
    MODEL_ID,
    QUESTION_SET_VERSION,
    USD_PER_MILLION_INPUT_TOKENS,
    ClefClient,
    ClefConfigError,
    ClefDisabled,
    ClefHTTPError,
    ClefLimitError,
    ClefOmniExtractor,
    HttpResult,
    build_body,
    check_clip_bounds,
    encode_wav,
    expected_level,
    input_cost_usd,
    mock_payload,
    ordered_score_probs,
    parse_features,
    questions_payload,
    resolve_account_id,
    run_clef,
    urllib_transport,
    wav_data_uri,
)
from tools.timbre.extractors.clef_omni import VALENCE_CRITERIA

TOKEN = "test-token-ZZZZ-not-real"


def _env(monkeypatch, *, mock=False, token=TOKEN, account="abc123"):
    monkeypatch.setenv("TIMBRE_CLEF", "1")
    if mock:
        monkeypatch.setenv("TIMBRE_CLEF_MOCK", "1")
    else:
        monkeypatch.delenv("TIMBRE_CLEF_MOCK", raising=False)
    if token is None:
        monkeypatch.delenv("CF_WORKERS_AI_TOKEN", raising=False)
    else:
        monkeypatch.setenv("CF_WORKERS_AI_TOKEN", token)
    if account is None:
        monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    else:
        monkeypatch.setenv("CF_ACCOUNT_ID", account)
    monkeypatch.delenv("R2_ENDPOINT", raising=False)


def _client(tmp_path, transport, **kwargs):
    return ClefClient(
        transport=transport,
        sleep=kwargs.pop("sleep", lambda _s: None),
        cache_dir=tmp_path / "cache",
        cost_log=tmp_path / "cost.jsonl",
        **kwargs,
    )


def _point_mass(index: int) -> dict:
    probs = {str(i): (1.0 if i == index else 0.0) for i in range(5)}
    return {
        "success": True,
        "result": {
            "model": "clef-omni",
            "answers": {
                "valence": {"type": "score", "score": -999, "probabilities": probs},
                "arousal": {"type": "score", "score": -999, "probabilities": dict(probs)},
                "anxious": {"type": "noul", "noul": 0.25},
                "engaged": {"type": "noul", "noul": 0.5},
                "one_patient": {"type": "noul", "noul": 0.75},
            },
            "usage": {"input_tokens": 1000, "output_tokens": 3},
        },
    }


def _http(payload: dict, status: int = 200, headers: dict | None = None) -> HttpResult:
    return HttpResult(status, headers or {}, json.dumps(payload).encode("utf-8"))


def test_question_set_and_caps():
    questions = questions_payload()
    assert set(questions) == {"valence", "arousal", "anxious", "engaged", "one_patient"}
    assert questions["valence"]["type"] == "score"
    assert questions["valence"]["criteria"][0] == "very negative"
    assert questions["valence"]["criteria"][-1] == "very positive"
    assert len(questions["valence"]["criteria"]) == 5
    assert questions["arousal"]["type"] == "score"
    assert questions["one_patient"]["instructions"] == "Is this clip mainly one patient speaking?"
    assert questions["anxious"]["type"] == "noul"
    assert QUESTION_SET_VERSION == "timbre-clef-v1"
    assert MAX_CLIPS == 4
    assert MAX_CLIP_S == 300
    assert MAX_WAV_BYTES == 8 * 1024 * 1024
    assert USD_PER_MILLION_INPUT_TOKENS == 0.15
    assert DEFAULT_CONCURRENCY == 4
    assert MODEL_ID == "@cf/cloudflare/clef-omni"


def test_catalog_registration():
    assert resolve_model_names("clef") == ["clef_omni_valence.v1"]
    spec = SPEC_BY_NAME["clef_omni_valence.v1"]
    assert spec.kind == "api"
    assert spec.model_id == MODEL_ID
    ext = build_extractor("clef_omni_valence.v1", "cpu")
    assert isinstance(ext, ClefOmniExtractor)
    assert ext.scalar_names == FEATURE_NAMES


def test_limits_and_wav_uri():
    check_clip_bounds(16000 * 300, 16000, MAX_WAV_BYTES)
    with pytest.raises(ClefLimitError):
        check_clip_bounds(16000 * 301, 16000, 10)
    with pytest.raises(ClefLimitError):
        check_clip_bounds(16000, 16000, MAX_WAV_BYTES + 1)
    wav = encode_wav(synth_speech(seconds=0.3), 16000)
    assert wav[:4] == b"RIFF"
    uri = wav_data_uri(wav)
    assert uri[:22] == "data:audio/wav;base64,"
    assert base64.b64decode(uri.split(",", 1)[1])[:4] == b"RIFF"
    with pytest.raises(ClefLimitError):
        encode_wav(np.zeros((16, 2), dtype=np.float32), 16000)
    with pytest.raises(ClefLimitError):
        encode_wav(np.zeros(0, dtype=np.float32), 16000)
    with pytest.raises(ClefLimitError):
        encode_wav(np.zeros(1600, dtype=np.float32), 8000)
    bad = synth_speech(seconds=0.3)
    bad[0] = np.nan
    with pytest.raises(ClefLimitError):
        encode_wav(bad, 16000)
    with pytest.raises(ClefLimitError):
        build_body([b"x"] * 5)
    body = build_body([wav])
    assert body["model"] == "clef-omni"
    assert body["state"]
    assert "transcript" not in body["state"].lower()
    assert len(body["audio"]) == 1
    assert set(body["questions"]) == set(questions_payload())


def test_duration_cap_is_applied(monkeypatch):
    monkeypatch.setattr("tools.timbre.extractors.clef_omni.MAX_CLIP_S", 0.01)
    with pytest.raises(ClefLimitError):
        encode_wav(synth_speech(seconds=0.05), 16000)


def test_account_id_env_and_r2(monkeypatch):
    monkeypatch.setenv("CF_ACCOUNT_ID", "explicit-acct")
    monkeypatch.setenv("R2_ENDPOINT", "https://fromr2endpoint.r2.cloudflarestorage.com/eta-audio")
    assert resolve_account_id() == "explicit-acct"
    monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    assert resolve_account_id() == "fromr2endpoint"
    monkeypatch.setenv("R2_ENDPOINT", "https://fromr2endpoint.r2.cloudflarestorage.com")
    assert resolve_account_id() == "fromr2endpoint"
    monkeypatch.delenv("R2_ENDPOINT", raising=False)
    with pytest.raises(ClefConfigError):
        resolve_account_id()


def test_expected_value_ignores_zero_based_score():
    features = parse_features(_point_mass(2))
    assert features["valence"] == pytest.approx(3.0)
    assert features["arousal_ev"] == pytest.approx(3.0)
    assert features["valence_p3"] == pytest.approx(1.0)
    assert features["valence_p1"] == pytest.approx(0.0)
    assert features["anxious"] == pytest.approx(0.25)
    assert features["engaged"] == pytest.approx(0.5)
    assert features["one_patient"] == pytest.approx(0.75)
    assert features["input_tokens"] == pytest.approx(1000)
    assert features["cost_usd"] == pytest.approx(input_cost_usd(1000))
    assert features["cost_usd"] == pytest.approx(1000 * 0.15 / 1_000_000)
    named = {text: 0.0 for text in VALENCE_CRITERIA}
    named["very positive"] = 1.0
    probs = ordered_score_probs({"probabilities": named}, VALENCE_CRITERIA)
    assert expected_level(probs) == pytest.approx(5.0)
    one_to_five = {str(i): (1.0 if i == 4 else 0.0) for i in range(1, 6)}
    assert expected_level(ordered_score_probs({"probabilities": one_to_five}, VALENCE_CRITERIA)) == pytest.approx(4.0)


def test_refuses_without_flag_and_mock_does_not_call_http(monkeypatch, tmp_path):
    calls = {"n": 0}

    def transport(_prepared):
        calls["n"] += 1
        raise AssertionError("transport called")

    client = _client(tmp_path, transport)
    monkeypatch.delenv("TIMBRE_CLEF", raising=False)
    monkeypatch.setenv("TIMBRE_CLEF_MOCK", "1")
    with pytest.raises(ClefDisabled):
        client.score_clip(synth_speech(seconds=0.3), 16000)
    assert calls["n"] == 0
    _env(monkeypatch, mock=True, token=None, account=None)
    features = client.score_clip(synth_speech(seconds=0.3), 16000)
    assert calls["n"] == 0
    assert np.isfinite(features["valence"])
    again = client.score_clip(synth_speech(seconds=0.3), 16000)
    assert again["valence"] == pytest.approx(features["valence"])
    assert client.n_calls == 1
    assert client.n_cached == 1


def test_mock_is_deterministic_and_changes_with_audio():
    a = encode_wav(synth_speech(seconds=0.3, f0=120), 16000)
    b = encode_wav(synth_speech(seconds=0.3, f0=180), 16000)
    assert mock_payload(a) == mock_payload(a)
    assert parse_features(mock_payload(a))["valence"] != pytest.approx(parse_features(mock_payload(b))["valence"])


def test_request_shape_retries_cache_and_cost(monkeypatch, tmp_path, caplog):
    _env(monkeypatch, mock=False)
    caplog.set_level(logging.INFO, logger="tools.timbre.clef_omni")
    seen = []
    sleeps = []

    def transport(prepared):
        seen.append(prepared)
        if len(seen) < 3:
            return _http({"errors": [{"message": f"slow {TOKEN}"}]}, status=429, headers={"Retry-After": "0"})
        wav = base64.b64decode(prepared.body["audio"][0].split(",", 1)[1])
        return _http(mock_payload(wav))

    client = _client(tmp_path, transport, sleep=sleeps.append)
    audio = synth_speech(seconds=0.4, f0=140)
    features = client.score_clip(audio, 16000)
    assert len(seen) == 3
    assert sleeps == [0.0, 0.0]
    body = seen[0].body
    assert body["model"] == "clef-omni"
    assert len(body["audio"]) == 1
    assert body["audio"][0][:22] == "data:audio/wav;base64,"
    assert seen[0].headers["Authorization"] == f"Bearer {TOKEN}"
    assert seen[0].url == f"https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/{MODEL_ID}"
    assert "Content-Type" in seen[0].headers
    assert features["cost_usd"] == pytest.approx(features["input_tokens"] * 0.15 / 1_000_000)
    assert client.billed_usd == pytest.approx(features["cost_usd"])
    client.score_clip(audio, 16000)
    assert len(seen) == 3
    assert client.n_cached == 1
    text = (tmp_path / "cost.jsonl").read_text(encoding="utf-8")
    assert TOKEN not in text
    assert TOKEN not in caplog.text
    assert "data:audio" not in text
    assert "data:audio" not in caplog.text
    assert b"RIFF" not in text.encode()
    cache_files = list((tmp_path / "cache").glob("*.json"))
    assert len(cache_files) == 1
    cached = cache_files[0].read_text(encoding="utf-8")
    assert "data:audio" not in cached
    assert TOKEN not in cached
    assert QUESTION_SET_VERSION in cached
    lines = [json.loads(line) for line in text.splitlines() if line.strip()]
    billed = [row for row in lines if row["billed"]]
    assert len(billed) == 1
    assert billed[0]["cost_usd"] == pytest.approx(features["cost_usd"])
    assert billed[0]["n_clips"] == 1
    assert "window_id" not in billed[0]


def test_backoff_without_retry_after(monkeypatch, tmp_path):
    _env(monkeypatch)
    sleeps = []
    calls = {"n": 0}

    def transport(prepared):
        calls["n"] += 1
        if calls["n"] < 3:
            return _http({"errors": [{"message": "busy"}]}, status=503)
        return _http(mock_payload(encode_wav(synth_speech(seconds=0.3), 16000)))

    client = _client(tmp_path, transport, sleep=sleeps.append)
    client.score_clip(synth_speech(seconds=0.3), 16000)
    assert sleeps == [0.5, 1.0]
    assert calls["n"] == 3


def test_no_retry_on_400_and_scrub(monkeypatch, tmp_path, caplog):
    _env(monkeypatch)
    caplog.set_level(logging.INFO, logger="tools.timbre.clef_omni")
    calls = {"n": 0}
    blob = "A" * 120

    def transport(_prepared):
        calls["n"] += 1
        message = f"nope {TOKEN} data:audio/wav;base64,{blob}"
        return _http({"errors": [{"message": message}]}, status=400)

    client = _client(tmp_path, transport)
    with pytest.raises(ClefHTTPError) as exc:
        client.score_clip(synth_speech(seconds=0.3), 16000)
    assert calls["n"] == 1
    assert TOKEN not in str(exc.value)
    assert "data:audio" not in str(exc.value)
    assert TOKEN not in caplog.text
    assert "data:audio" not in caplog.text
    assert not list((tmp_path / "cache").glob("*.json"))


def test_five_failures_then_raise(monkeypatch, tmp_path):
    _env(monkeypatch)
    calls = {"n": 0}

    def transport(_prepared):
        calls["n"] += 1
        return _http({"errors": [{"message": "later"}]}, status=500)

    client = _client(tmp_path, transport)
    with pytest.raises(ClefHTTPError) as exc:
        client.score_clip(synth_speech(seconds=0.3), 16000)
    assert calls["n"] == 5
    assert exc.value.status == 500
    assert exc.value.attempts == 5


def test_missing_token_does_not_call(monkeypatch, tmp_path):
    _env(monkeypatch, token=None)
    calls = {"n": 0}

    def transport(_prepared):
        calls["n"] += 1
        raise AssertionError("transport called")

    client = _client(tmp_path, transport)
    with pytest.raises(ClefConfigError):
        client.score_clip(synth_speech(seconds=0.3), 16000)
    assert calls["n"] == 0


def test_question_set_version_is_part_of_the_cache_key(monkeypatch, tmp_path):
    _env(monkeypatch)
    calls = {"n": 0}

    def transport(prepared):
        calls["n"] += 1
        wav = base64.b64decode(prepared.body["audio"][0].split(",", 1)[1])
        return _http(mock_payload(wav))

    client = _client(tmp_path, transport)
    audio = synth_speech(seconds=0.3, f0=150)
    client.score_clip(audio, 16000)
    client.question_set = "timbre-clef-v2"
    client.score_clip(audio, 16000)
    assert calls["n"] == 2


def test_concurrency_is_bounded(monkeypatch, tmp_path):
    _env(monkeypatch)
    state = {"in_flight": 0, "max": 0, "failed": False}
    lock = threading.Lock()
    barrier = threading.Barrier(2)

    def transport(prepared):
        with lock:
            state["in_flight"] += 1
            state["max"] = max(state["max"], state["in_flight"])
        try:
            barrier.wait(timeout=2)
        except threading.BrokenBarrierError:
            state["failed"] = True
        finally:
            with lock:
                state["in_flight"] -= 1
        wav = base64.b64decode(prepared.body["audio"][0].split(",", 1)[1])
        return _http(mock_payload(wav))

    client = _client(tmp_path, transport, concurrency=2)
    clips = [(synth_speech(seconds=0.3, f0=100 + 15 * i), 16000) for i in range(6)]
    client.score_many(clips)
    assert state["max"] <= 2
    assert state["max"] >= 2
    assert state["failed"] is False
    assert len(client.score_many([])) == 0


def test_urllib_transport_posts_json(monkeypatch):
    captured = {}

    class _Resp:
        status = 200
        headers = {}

        def read(self):
            return b'{"success":true,"result":{"answers":{}}}'

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(req, timeout=60):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["type"] = req.get_header("Content-type")
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    wav = encode_wav(synth_speech(seconds=0.3), 16000)
    prepared = type("P", (), {})()
    prepared.url = f"https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/{MODEL_ID}"
    prepared.headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    prepared.body = build_body([wav])
    result = urllib_transport(prepared, timeout=5)
    assert result.status == 200
    assert captured["url"].endswith("/ai/run/@cf/cloudflare/clef-omni")
    assert captured["auth"] == f"Bearer {TOKEN}"
    assert captured["body"]["model"] == "clef-omni"
    assert len(captured["body"]["audio"]) == 1

    def raise_http(req, timeout=60):
        raise urllib.error.HTTPError(
            req.full_url,
            429,
            "rate",
            hdrs={"Retry-After": "1"},
            fp=io.BytesIO(b'{"errors":[{"message":"rate"}]}'),
        )

    monkeypatch.setattr(urllib.request, "urlopen", raise_http)
    result = urllib_transport(prepared, timeout=5)
    assert result.status == 429
    assert result.headers["Retry-After"] == "1"


def test_extractor_mock_silence_and_columns(monkeypatch, tmp_path):
    _env(monkeypatch, mock=True, token=None, account=None)
    spec = SPEC_BY_NAME["clef_omni_valence.v1"]
    client = _client(tmp_path, lambda _p: (_ for _ in ()).throw(AssertionError("http")))
    ext = ClefOmniExtractor(spec, "cpu", client=client)
    silent = ext.extract(synth_silence(seconds=0.5), 16000)
    assert silent["status"] == "nan"
    assert client.n_calls == 0
    speech = ext.extract(synth_speech(seconds=0.5), 16000)
    assert speech["status"] == "ok"
    assert speech["revision"] == QUESTION_SET_VERSION
    assert speech["model_id"] == MODEL_ID
    assert speech["kind"] == "api"
    assert np.isfinite(speech["features"]["valence"])
    assert "arousal" not in speech["features"]
    assert np.isfinite(speech["features"]["arousal_ev"])
    monkeypatch.delenv("TIMBRE_CLEF", raising=False)
    refused = ext.extract(synth_speech(seconds=0.5, f0=200), 16000)
    assert refused["status"] == "error"
    assert "TIMBRE_CLEF" in refused["reason"]


def _csv(path, rows, header):
    path.write_text(header + "\n" + "\n".join(rows) + "\n", encoding="utf-8")


def test_cli_purity_gate_cache_and_summary(monkeypatch, tmp_path):
    _env(monkeypatch, mock=True, token=None, account=None)
    audio = tmp_path / "audio"
    audio.mkdir()
    write_wav(audio / "synthA_p0000000.wav", synth_speech(seconds=0.5, f0=130))
    write_wav(audio / "synthA_p0000500.wav", synth_silence(seconds=0.5))
    write_wav(audio / "synthA_p0001000.wav", synth_speech(seconds=0.5, f0=170))
    csv = tmp_path / "windows.csv"
    header = "window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role,purity,pure_patient_s,cos_patient_mean"
    _csv(
        csv,
        [
            "synthA_p0000000,ROOM-A,2026-01-01,en,open,0,0.5,0.4,patient,0.9,4.0,0.5",
            "synthA_p0000500,ROOM-A,2026-01-01,en,open,0.5,1.0,0.0,patient,0.9,4.0,0.5",
            "synthA_p0001000,ROOM-A,2026-01-01,en,open,1.0,1.5,0.4,patient,0.2,0.5,0.1",
        ],
        header,
    )
    out = tmp_path / "out"
    summary = run_clef(csv, audio, out, concurrency=2)
    assert summary["n_ok"] == 1
    assert summary["n_nan"] == 1
    assert summary["n_unscorable"] == 1
    assert summary["n_calls"] == 1
    frame = pd.read_parquet(out / "clef_omni_valence.v1.parquet")
    bad = frame.loc[frame.window_id == "synthA_p0001000"].iloc[0]
    assert bad["status"] == "unscorable"
    assert np.isnan(bad["clef_omni_valence.v1__valence"])
    good = frame.loc[frame.window_id == "synthA_p0000000"].iloc[0]
    assert good["status"] == "ok"
    assert np.isfinite(good["clef_omni_valence.v1__valence"])
    assert np.isfinite(good["clef_omni_valence.v1__arousal_ev"])
    assert np.isfinite(good["clef_omni_valence.v1__one_patient"])
    assert good["clef_omni_valence.v1__cost_usd"] == pytest.approx(
        good["clef_omni_valence.v1__input_tokens"] * 0.15 / 1_000_000
    )
    assert "synthA_p0000000" not in (out / "clef_summary.json").read_text(encoding="utf-8")
    cost = (out / "clef-cost.jsonl").read_text(encoding="utf-8")
    assert cost.count("\n") == 1
    assert "data:audio" not in cost
    again = run_clef(csv, audio, out, concurrency=2)
    assert again["n_calls"] == 0
    assert again["n_cached"] == 0
    assert again["n_unscorable"] == 1
    assert again["n_ok"] == 1


def test_cli_refuses_when_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("TIMBRE_CLEF", raising=False)
    from tools.timbre.extractors.clef_omni import main

    with pytest.raises(SystemExit) as exc:
        main(["--windows", str(tmp_path / "missing.csv"), "--audio-dir", str(tmp_path), "--out", str(tmp_path / "out")])
    assert exc.value.code == 2
