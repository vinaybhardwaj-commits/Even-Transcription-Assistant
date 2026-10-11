"""tools/timbre/nightly_prepare.py — parts at Nemotron window edges, voiceprints, slot embeddings, prepare() with fakes."""
from __future__ import annotations

import base64
import io
import json

import numpy as np
import pytest

from tools.timbre import nightly_prepare as npp
from tools.timbre import store
from tools.timbre.nemotron_probs import load_nlp, pack_nlp


def test_parts_for_cuts_at_window_edges():
    w = npp.WINDOW_MS
    assert npp.parts_for(10 * w + 1000, 10 * w + 5000) == [(10 * w, 10 * w + 1000, 10 * w + 5000)]
    assert npp.parts_for(10 * w - 60_000, 11 * w + 30_000) == [(9 * w, 10 * w - 60_000, 10 * w), (10 * w, 10 * w, 11 * w), (11 * w, 11 * w, 11 * w + 30_000)]


def test_session_token():
    assert npp.session_token("bs_ab12cd34") == "ab12cd34"
    for bad in (None, "", "ab12", "bs_", "bs_../x", "bs_a/b"):
        assert npp.session_token(bad) is None


def test_voiceprints_from_centroids(tmp_path):
    vec = np.arange(1, 193, dtype=np.float32)
    src = tmp_path / "c.json"
    src.write_text(json.dumps([{"pulse_doctor_uid": "docFAKE1xyz", "b64": base64.b64encode(vec.tobytes()).decode()}, {"pulse_doctor_uid": None, "b64": "x"},
                               {"pulse_doctor_uid": "short", "b64": base64.b64encode(np.ones(10, dtype=np.float32).tobytes()).decode()}]))
    out = json.loads(npp.voiceprints_from_centroids(str(src), tmp_path / "vp.json").read_text())
    assert list(out["doctors"]) == ["docFAKE1"]
    assert np.linalg.norm(out["doctors"]["docFAKE1"]) == pytest.approx(1.0, abs=1e-5)


def test_slot_embeddings_zero_for_silent_columns():
    fm = 80.0
    frames = int(60_000 / fm)
    probs = np.zeros((frames, 3))
    probs[: frames // 2, 0] = 0.9  # speaker 0 talks for 30 s, speaker 1 for 30 s, speaker 2 never
    probs[frames // 2:, 1] = 0.9
    wav = np.random.default_rng(0).standard_normal(60 * npp.SR).astype(np.float32) * 0.1
    calls = []

    def embed(chunks):
        calls.append(len(chunks))
        return np.tile(np.eye(192)[len(calls)], (len(chunks), 1))

    emb = npp.slot_embeddings(probs, fm, wav, embed)
    assert emb.shape == (3, 192) and len(calls) == 2
    assert np.linalg.norm(emb[0]) == pytest.approx(1.0) and np.linalg.norm(emb[2]) == 0.0


def test_prepare_end_to_end_with_fakes(tmp_path):
    import soundfile as sf

    w = npp.WINDOW_MS
    ws = 2_000 * w
    t0, t1 = ws + w - 120_000, ws + w + 60_000  # 2 min in window A, 1 min in window B (B has no .nlp)
    buf = io.BytesIO()
    sf.write(buf, (np.random.default_rng(1).standard_normal(180 * npp.SR) * 0.1).astype(np.float32), npp.SR, format="FLAC")
    fm = 10.0
    probs = np.zeros((int(900_000 / fm), 2))
    probs[:, 0] = 0.9
    probs[::3, 0], probs[::3, 1] = 0.0, 0.9
    blob = pack_nlp(probs, frame_ms=fm)
    c = {"consult_uid": "cu_fake_1", "cut_version": "sig:x", "t0_ms": t0, "t1_ms": t1, "clip_r2_key": "consult-clips/x.flac", "session_id": "bs_tokfake1"}
    nope = {**c, "consult_uid": "cu_fake_2", "session_id": "bs_toknone"}
    out = npp.prepare([c, nope], tmp_path, embed=lambda ch: np.ones((len(ch), 192)) / np.sqrt(192),
                      fetch_audio=lambda key: buf.getvalue(), fetch_nlp=lambda key: blob,
                      list_windows=lambda tok: {ws} if tok == "tokfake1" else set())
    assert [p["clip_id"] for p in out.clips] == ["cu_fake_1-s0"]
    part = out.clips[0]
    assert part["offset_ms"] == 0 and part["duration_s"] == pytest.approx(120.0, abs=0.1) and part["nemotron_ref"] == f"bw_tokfake1_{ws}_primary.nlp"
    assert out.no_diarization == ["cu_fake_2"] and out.parts_no_nlp == 3  # 1 (window B) + 2 (cu_fake_2)
    audio, sr = sf.read(tmp_path / "audio" / "cu_fake_1-s0.wav")
    assert sr == npp.SR and len(audio) == pytest.approx(120 * npp.SR, abs=npp.SR // 10)
    ld = load_nlp(tmp_path / "nlp" / "cu_fake_1-s0.nlp", expected_duration_s=part["duration_s"], tol_s=6.0)
    assert ld.probs.shape[0] == int(120_000 / fm) and ld.probs.shape[1] == 2
    assert np.load(tmp_path / "slots" / "cu_fake_1-s0.npy").shape == (2, 192)


def test_store_offset_ms_makes_times_consult_relative():
    clip = {"consult_uid": "cu_fake_1", "cut_version": "sig:x", "t0_ms": 1_000_000, "offset_ms": 900_000, "diarize_engine": "nemotron"}
    row = {"start_s": 10.0, "end_s": 20.0, "scorable": False, "reason": "no_voiceprint"}
    w = store.map_window(row, clip, text_lane_on=False)
    assert (w["start_ms"], w["end_ms"], w["abs_start_ms"]) == (910_000, 920_000, 1_910_000)
    assert w["window_key"] == store.window_key("cu_fake_1", 910_000)
    with pytest.raises(store.StoreError):
        store.map_window(row, {**clip, "offset_ms": -1}, text_lane_on=False)
