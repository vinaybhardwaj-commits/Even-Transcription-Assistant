"""NLP1 reader: both layouts, the 900 s check, patient frames, read-only R2 key."""

from __future__ import annotations

import gzip
import json
import struct

import numpy as np
import pytest

from tools.timbre.nemotron_probs import (
    NlpError,
    fetch_nlp_object,
    load_nlp,
    nlp_object_key,
    pack_nlp,
    patient_frames,
)

FIX = __import__("pathlib").Path(__file__).resolve().parents[1] / "fixtures"


def _pack_independent(matrix: np.ndarray, frame_ms: float = 80, scale: int = 255) -> bytes:
    """The documented layout, written without pack_nlp."""
    frames, cols = matrix.shape
    header = {"cols": cols, "dtype": "u8", "frame_ms": frame_ms, "rows": frames, "scale": scale}
    head = json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    u8 = np.clip(np.rint(matrix * scale), 0, 255).astype(np.uint8)
    payload = np.ascontiguousarray(u8).tobytes()
    raw = b"NLP1" + struct.pack("<I", len(head)) + head + payload
    return gzip.compress(raw, compresslevel=9, mtime=0)


def test_independent_bytes_round_trip():
    matrix = np.array([[0.0, 128 / 255, 1.0], [51 / 255, 0.0, 1.0]], dtype=np.float64)
    loaded = load_nlp(_pack_independent(matrix), expected_duration_s=2 * 0.08, tol_s=0.01)
    assert loaded.interpretation == "rows_are_frames"
    assert loaded.probs.shape == (2, 3)
    assert loaded.duration_ok
    np.testing.assert_allclose(loaded.probs, matrix, atol=1 / 510)


def test_pack_nlp_matches_independent_bytes():
    matrix = np.array([[0.0, 0.5, 1.0], [0.2, 0.0, 0.0]], dtype=np.float64)
    assert pack_nlp(matrix, frame_ms=80) == _pack_independent(np.array([[0.0, 128 / 255, 1.0], [51 / 255, 0.0, 0.0]]))


def test_rows_are_frames_times_cols_layout_hits_900s():
    frames, cols = 11250, 8
    probs = np.zeros((frames, cols), dtype=np.float64)
    probs[3, 2] = 128 / 255
    blob = pack_nlp(probs, frame_ms=80, interpretation="rows_are_frames_times_cols")
    loaded = load_nlp(blob, expected_duration_s=900.0)
    assert loaded.interpretation == "rows_are_frames_times_cols"
    assert loaded.probs.shape == (11250, 8)
    assert loaded.duration_s == pytest.approx(900.0)
    assert loaded.duration_ok
    assert loaded.probs[3, 2] == pytest.approx(128 / 255, abs=1e-9)


def test_production_shaped_header_fails_900s_check():
    """rows=90003, cols=8, frame_ms=80 is the shape reported for the R2 objects."""
    probs = np.zeros((90003, 8), dtype=np.float64)
    probs[0, 1] = 1.0
    blob = pack_nlp(probs, frame_ms=80, interpretation="rows_are_frames", extra={"model_rev": "test"})
    loaded = load_nlp(blob)  # default expected duration is 900 s
    assert loaded.interpretation == "rows_are_frames"
    assert loaded.probs.shape == (90003, 8)
    assert loaded.duration_s == pytest.approx(7200.24)
    assert loaded.duration_ok is False
    assert loaded.sanity["hypotheses_s"]["rows_over_cols_s"] == pytest.approx(900.03)
    assert loaded.sanity["hypotheses_s"]["ten_ms_if_rows_are_frames_s"] == pytest.approx(900.03)
    assert loaded.probs[0, 1] == pytest.approx(1.0, abs=1 / 255)
    assert "open_question" in loaded.sanity


def test_payload_length_must_match_a_layout():
    raw = gzip.compress(b"NLP1" + struct.pack("<I", 2) + b"{}" + b"\x00\x00", mtime=0)
    with pytest.raises(NlpError):
        load_nlp(raw)


def test_rejects_bad_magic_and_truncated():
    with pytest.raises(NlpError):
        load_nlp(b"not gzip")
    with pytest.raises(NlpError):
        load_nlp(gzip.compress(b"XXXX\x00\x00\x00\x00", mtime=0))


def test_committed_fixture_nlp():
    loaded = load_nlp(FIX / "tiny.nlp", expected_duration_s=0.16, tol_s=0.01)
    assert loaded.probs.shape == (2, 2)
    assert loaded.duration_ok
    assert loaded.probs[0, 0] == pytest.approx(0.0, abs=1e-9)
    assert loaded.probs[1, 1] == pytest.approx(1.0, abs=1 / 255)


def test_doctor_frames_keeps_only_the_doctor():
    from tools.timbre.nemotron_probs import doctor_frames

    probs = np.array(
        [
            [0.90, 0.05, 0.02, 0.01],  # doctor
            [0.05, 0.80, 0.05, 0.05],  # patient
            [0.05, 0.70, 0.60, 0.00],  # overlap
            [0.10, 0.20, 0.20, 0.10],  # nobody
            [0.00, 0.50, 0.49, 0.00],  # patient, other just under thr
        ],
        dtype=np.float64,
    )
    mask = doctor_frames(probs, doctor_slot=0, thr=0.5)
    assert mask.tolist() == [True, False, False, False, False]


def test_patient_frames_drops_doctor_and_overlap():
    probs = np.array(
        [
            [0.90, 0.05, 0.02, 0.01],  # doctor
            [0.05, 0.80, 0.05, 0.05],  # patient 1
            [0.05, 0.70, 0.60, 0.00],  # overlap
            [0.10, 0.20, 0.20, 0.10],  # nobody
            [0.00, 0.50, 0.49, 0.00],  # patient 1, other just under thr
        ],
        dtype=np.float64,
    )
    mask = patient_frames(probs, doctor_slot=0, thr=0.5)
    assert mask.tolist() == [False, True, False, False, True]


def test_patient_frames_rejects_a_bad_slot():
    with pytest.raises(NlpError):
        patient_frames(np.zeros((3, 2)), doctor_slot=4, thr=0.5)


def test_object_key_and_fetch_allow_list(monkeypatch):
    assert nlp_object_key("OPD3", 1725) == "lab/nemotron-probs/bw_OPD3_1725_primary.nlp"
    with pytest.raises(NlpError):
        nlp_object_key("a/b", 1)
    for key in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(NlpError, match="R2_ENDPOINT"):
        fetch_nlp_object("lab/nemotron-probs/bw_x_1_primary.nlp")
    with pytest.raises(NlpError, match="refusing"):
        fetch_nlp_object("other/prefix/file.nlp", client=object())

    calls = {}

    class _Body:
        def read(self):
            return b"nlp-bytes"

    class _Client:
        def get_object(self, **kwargs):
            calls["get"] = kwargs
            return {"Body": _Body()}

        def put_object(self, **kwargs):
            raise AssertionError("write")

    monkeypatch.setenv("R2_ENDPOINT", "https://example.invalid")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "test-key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "test-secret")
    blob = fetch_nlp_object("lab/nemotron-probs/bw_x_1_primary.nlp", client=_Client())
    assert blob == b"nlp-bytes"
    assert calls["get"]["Bucket"] == "eta-audio"
    assert calls["get"]["Key"].endswith(".nlp")
