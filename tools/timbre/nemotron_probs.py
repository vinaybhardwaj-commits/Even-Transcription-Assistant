"""Reader for Nemotron per-frame speaker probabilities (NLP1).

Container, matching tools/nemotron-worker/lab.py and lib/diarize-nemotron/lab.ts:

    gzip( b"NLP1" | uint32le header_length | JSON header | payload )

The worker's packer sets ``rows`` to the frame count and writes ``rows * cols``
payload bytes (``cols`` = speaker slots). u8 values are ``round(p * scale)`` with
``scale`` 255.

Open question (architecture issue #70, Designer comment, 10 Oct 2026): every
object under ``eta-audio/lab/nemotron-probs/bw_<room>_<window_start_ms>_primary.nlp``
decompresses to 720,197 bytes with header ``rows=90003, cols=8, frame_ms=80``.
That length is a canonical (90003 × 8) matrix plus a short JSON header, so
``rows`` = frames is the payload-valid reading and the duration is 7200.24 s,
not the 900 s of a 15-minute window.

Two timebases both land on 900.03 s, and they are the same number when cols is 8:

* treat header ``rows`` as frames × cols: ``(90003 / 8) * 80 ms``
* treat header ``rows`` as frames at a 10 ms hop: ``90003 * 10 ms``

90003 is not divisible by 8, so the product reading cannot reshape this payload
without dropping a 3-frame remainder. A 10 ms hop fits the stored shape exactly.
The worker hardcodes ``frame_ms: 80`` in ``pack_nlp`` regardless of the tensor
hop, which is why a wrong timebase is plausible. This module does not guess a
reshape. It decodes whichever layout the byte length supports, returns a
``(frames, speakers)`` float array, and sets ``duration_ok`` from the selected
timebase against the expected window (default 900 s).

R2 fetch is optional and read-only (GetObject on ``lab/nemotron-probs/*.nlp``).
"""

from __future__ import annotations

import gzip
import json
import os
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

NLP_MAGIC = b"NLP1"
BUCKET = "eta-audio"
KEY_PREFIX = "lab/nemotron-probs/"
EXPECTED_WINDOW_S = 900.0
DEFAULT_TOL_S = 5.0
MAX_HEADER_BYTES = 1_000_000

OPEN_QUESTION = (
    "Production NLP1 objects are payload-valid as rows=frames (90003 x 8 u8, "
    "frame_ms 80 -> 7200.24 s), which fails a 900 s check. (rows/cols)*80 ms and "
    "rows*10 ms are both 900.03 s when cols=8, but 90003 % 8 == 3 so the product "
    "reading cannot reshape the measured payload. A 10 ms hop fits the stored shape. "
    "The reader reports both and does not drop samples."
)


class NlpError(ValueError):
    pass


@dataclass
class NlpLoad:
    probs: np.ndarray  # float64, shape (frames, speakers), approximately in [0, 1]
    header: dict
    interpretation: str
    frames: int
    speakers: int
    frame_ms: float
    duration_s: float
    duration_ok: bool
    expected_duration_s: float
    tol_s: float
    candidates: list[dict] = field(default_factory=list)
    sanity: dict = field(default_factory=dict)


def nlp_object_key(room_token: str, window_start_ms: int) -> str:
    """``lab/nemotron-probs/bw_<room>_<window_start_ms>_primary.nlp``.

    ``room_token`` is the token in the object key, not necessarily the CSV room label.
    """
    token = str(room_token)
    if not token or any(c in token for c in "/\\\n\r"):
        raise NlpError("room token is empty or contains a path separator")
    ms = int(window_start_ms)
    if ms < 0:
        raise NlpError("window_start_ms must be >= 0")
    return f"{KEY_PREFIX}bw_{token}_{ms}_primary.nlp"


def pack_nlp(
    probs: np.ndarray,
    *,
    frame_ms: float = 80,
    interpretation: str = "rows_are_frames",
    scale: int = 255,
    extra: dict | None = None,
) -> bytes:
    """Gzip an NLP1 blob. ``probs`` is float ``(frames, speakers)`` in [0, 1].

    ``rows_are_frames`` matches the worker: header rows = frames, payload = rows*cols bytes.
    ``rows_are_frames_times_cols`` sets header rows = frames*cols and writes that many
    payload bytes (a flat vector), which is the other layout this reader accepts.
    """
    arr = np.asarray(probs, dtype=np.float64)
    if arr.ndim != 2:
        raise NlpError("probs must be (frames, speakers)")
    frames, cols = int(arr.shape[0]), int(arr.shape[1])
    if cols <= 0 or frames < 0:
        raise NlpError("empty speaker axis")
    if interpretation not in ("rows_are_frames", "rows_are_frames_times_cols"):
        raise NlpError(f"unknown interpretation {interpretation}")
    if not (1 <= int(scale) <= 255):
        raise NlpError("scale must be in 1..255")
    u8 = np.clip(np.rint(arr * int(scale)), 0, 255).astype(np.uint8)
    if interpretation == "rows_are_frames":
        header_rows = frames
        payload = np.ascontiguousarray(u8).tobytes()
    else:
        header_rows = frames * cols
        payload = np.ascontiguousarray(u8).reshape(-1).tobytes()
    header = {
        "dtype": "u8",
        "rows": header_rows,
        "cols": cols,
        "scale": int(scale),
        "frame_ms": frame_ms,
        **(extra or {}),
    }
    return _wrap(header, payload)


def load_nlp(
    source: bytes | Path | str,
    *,
    expected_duration_s: float = EXPECTED_WINDOW_S,
    tol_s: float = DEFAULT_TOL_S,
) -> NlpLoad:
    """Decode an NLP1 gzip blob or a path to one. See the module docstring."""
    blob = source if isinstance(source, (bytes, bytearray)) else Path(source).read_bytes()
    try:
        raw = gzip.decompress(bytes(blob))
    except (OSError, EOFError, gzip.BadGzipFile) as e:
        raise NlpError("expected a gzip NLP1 file") from e
    if len(raw) < 8 or raw[:4] != NLP_MAGIC:
        raise NlpError("not NLP1")
    (hlen,) = struct.unpack("<I", raw[4:8])
    if hlen > MAX_HEADER_BYTES or 8 + hlen > len(raw):
        raise NlpError("bad NLP1 header length")
    try:
        header = json.loads(raw[8 : 8 + hlen].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise NlpError("NLP1 header is not JSON") from e
    if not isinstance(header, dict):
        raise NlpError("NLP1 header must be a JSON object")
    payload = raw[8 + hlen :]
    return _decode(header, payload, expected_duration_s=expected_duration_s, tol_s=tol_s)


def patient_frames(
    probs: np.ndarray,
    doctor_slot: int,
    thr: float,
    overlap_thr: float | None = None,
) -> np.ndarray:
    """Boolean mask of single-speaker, non-doctor frames with overlap removed.

    A frame is kept when exactly one speaker has probability ``>= thr``, that
    speaker is not ``doctor_slot``, and every other speaker is ``< overlap_thr``
    (default: ``thr``). Two speakers at or above ``thr`` is overlap and the frame
    is dropped. The doctor alone above ``thr`` is dropped.
    """
    arr = np.asarray(probs, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] < 1:
        raise NlpError("probs must be (frames, speakers)")
    if not np.isfinite(arr).all():
        raise NlpError("probs must be finite")
    slot = int(doctor_slot)
    if slot < 0 or slot >= arr.shape[1]:
        raise NlpError("doctor_slot out of range")
    if not 0.0 <= float(thr) <= 1.0:
        raise NlpError("thr must be in [0, 1]")
    ov = float(thr if overlap_thr is None else overlap_thr)
    above = arr >= float(thr)
    single = above.sum(axis=1) == 1
    winner = np.argmax(arr, axis=1)
    others = arr.copy()
    others[np.arange(arr.shape[0]), winner] = -np.inf
    max_other = others.max(axis=1) if arr.shape[1] > 1 else np.full(arr.shape[0], -np.inf)
    keep = single & (winner != slot) & (max_other < ov)
    return keep


def fetch_nlp_object(key: str, *, bucket: str = BUCKET, client=None) -> bytes:
    """Read-only GetObject. Refuses keys outside ``lab/nemotron-probs/*.nlp``.

    Credentials come from ``R2_ENDPOINT``, ``R2_ACCESS_KEY_ID``, ``R2_SECRET_ACCESS_KEY``.
    This function never prints them and never calls a write API.
    """
    if not key.startswith(KEY_PREFIX) or not key.endswith(".nlp") or ".." in key:
        raise NlpError("refusing key outside lab/nemotron-probs/*.nlp")
    if client is None:
        client = _r2_client()
    obj = client.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read()
    if not isinstance(body, (bytes, bytearray)):
        raise NlpError("R2 object body was not bytes")
    return bytes(body)


def _wrap(header: dict, payload: bytes) -> bytes:
    head = json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(head) > MAX_HEADER_BYTES:
        raise NlpError("header too large")
    return gzip.compress(NLP_MAGIC + struct.pack("<I", len(head)) + head + payload, compresslevel=9, mtime=0)


def _decode(header: dict, payload: bytes, *, expected_duration_s: float, tol_s: float) -> NlpLoad:
    for key in ("rows", "cols", "dtype"):
        if key not in header:
            raise NlpError(f"NLP1 header missing {key}")
    if header["dtype"] != "u8":
        raise NlpError(f"timbre probability reader expects dtype u8, got {header['dtype']!r}")
    try:
        rows = int(header["rows"])
        cols = int(header["cols"])
        frame_ms = float(header.get("frame_ms", 80))
        scale = float(header.get("scale", 255))
    except (TypeError, ValueError) as e:
        raise NlpError("NLP1 header has a non-numeric rows/cols/frame_ms/scale") from e
    if rows < 0 or cols <= 0 or frame_ms <= 0 or scale <= 0:
        raise NlpError("NLP1 header rows/cols/frame_ms/scale out of range")
    candidates = _candidates(rows, cols, frame_ms, scale, payload)
    if not candidates:
        raise NlpError(
            f"NLP1 payload length {len(payload)} matches neither rows=frames "
            f"({rows * cols} bytes) nor rows=frames*cols ({rows} bytes)"
        )
    chosen = _select(candidates, expected_duration_s, tol_s)
    duration_ok = abs(chosen["duration_s"] - float(expected_duration_s)) <= float(tol_s)
    hypotheses = {
        "rows_are_frames_s": rows * frame_ms / 1000.0,
        "rows_over_cols_s": (rows / cols) * frame_ms / 1000.0,
        "ten_ms_if_rows_are_frames_s": rows * 0.010,
    }
    probs = chosen["probs"]
    warnings = []
    if probs.size and float(np.nanmax(probs)) > 1.01:
        warnings.append("values_exceed_1_check_scale")
    sanity = {
        "open_question": OPEN_QUESTION,
        "payload_bytes": len(payload),
        "header_rows": rows,
        "header_cols": cols,
        "frame_ms": frame_ms,
        "scale": scale,
        "hypotheses_s": hypotheses,
        "duration_ok": duration_ok,
        "expected_duration_s": float(expected_duration_s),
        "tol_s": float(tol_s),
        "selected": chosen["interpretation"],
        "warnings": warnings,
        "tie_note": chosen.get("tie_note"),
    }
    return NlpLoad(
        probs=probs,
        header=header,
        interpretation=chosen["interpretation"],
        frames=int(probs.shape[0]),
        speakers=int(probs.shape[1]),
        frame_ms=frame_ms,
        duration_s=float(chosen["duration_s"]),
        duration_ok=bool(duration_ok),
        expected_duration_s=float(expected_duration_s),
        tol_s=float(tol_s),
        candidates=[{k: v for k, v in c.items() if k != "probs"} | {"shape": list(c["probs"].shape)} for c in candidates],
        sanity=sanity,
    )


def _candidates(rows: int, cols: int, frame_ms: float, scale: float, payload: bytes) -> list[dict]:
    out: list[dict] = []
    # Layout A: header rows is the frame count. Payload is rows * cols bytes.
    if len(payload) == rows * cols:
        arr = np.frombuffer(payload, dtype=np.uint8).reshape(rows, cols).astype(np.float64) / scale
        out.append(
            {
                "interpretation": "rows_are_frames",
                "probs": arr,
                "duration_s": rows * frame_ms / 1000.0,
            }
        )
    # Layout B: header rows is frames * cols, and the payload is that many bytes
    # (not multiplied by cols a second time). Identical to layout A when cols == 1.
    if cols != 1 and rows % cols == 0 and len(payload) == rows:
        frames = rows // cols
        arr = np.frombuffer(payload, dtype=np.uint8).reshape(frames, cols).astype(np.float64) / scale
        out.append(
            {
                "interpretation": "rows_are_frames_times_cols",
                "probs": arr,
                "duration_s": frames * frame_ms / 1000.0,
            }
        )
    if cols == 1 and out:
        out[0]["tie_note"] = "cols=1: rows=frames and rows=frames*cols are the same layout"
    return out


def _select(candidates: list[dict], expected_s: float, tol_s: float) -> dict:
    near = [c for c in candidates if abs(c["duration_s"] - expected_s) <= tol_s]
    pool = near or candidates
    # Prefer a duration that matches the window; otherwise keep the canonical layout.
    pool = sorted(
        pool,
        key=lambda c: (
            abs(c["duration_s"] - expected_s),
            0 if c["interpretation"] == "rows_are_frames" else 1,
        ),
    )
    return pool[0]


def _r2_client():
    missing = [k for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not os.environ.get(k)]
    if missing:
        raise NlpError("missing env: " + ", ".join(missing))
    try:
        import boto3
        from botocore.config import Config
    except ImportError as e:
        raise NlpError("boto3 is not installed") from e
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )
