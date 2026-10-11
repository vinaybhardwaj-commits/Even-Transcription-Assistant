"""Reader for Nemotron per-frame speaker probabilities (NLP1).

Container, matching tools/nemotron-worker/lab.py and lib/diarize-nemotron/lab.ts:

    gzip( b"NLP1" | uint32le header_length | JSON header | payload )

The worker's packer sets ``rows`` to the frame count and writes ``rows * cols``
payload bytes (``cols`` = speaker slots). u8 values are ``round(p * scale)`` with
``scale`` 255. Column ``i`` is NeMo ``speaker_i`` (the tensor from
``diarize_with_probs``). That is not ETA ``spk{i}``: ``to_turns`` renames labels
to ``spk0``, ``spk1``, … in first-speech order. ``slots.align_labels`` joins the
two when turns are available.

Frame step. The worker hardcodes ``frame_ms: 80`` in ``pack_nlp`` regardless of
the tensor hop (``tools/nemotron-worker/worker.py``). Production objects are
``rows=90003``, ``cols=8``, so the stored matrix is 90,003 frames, not
``90003/8``. ``90003 * 10 ms = 900.03 s``, the 15-minute bench window;
``90003 * 80 ms = 7200.24 s``. ``resolve_frame_step`` infers the hop from the
known duration and the frame count, snaps to a whole millisecond in 1..100 ms
when the ratio is within 2%, and uses that hop when it explains the duration
better than the header. The header value is kept when it already fits, and when
the ratio is not a sane hop (a 100-frame file is not assigned a 9 s step just
because the caller passed 900 s). A disagreement is a ``FrameStepWarning`` and
is copied onto ``NlpLoad.frame_step_warning``. This reader still does not
reshape the payload.

R2 fetch is optional and read-only (GetObject on ``lab/nemotron-probs/*.nlp``).
Credentials, when ``client`` is omitted: ``R2_ENDPOINT``, ``R2_ACCESS_KEY_ID``,
``R2_SECRET_ACCESS_KEY``. Tests pass a fake client and do not read those.
"""

from __future__ import annotations

import gzip
import json
import os
import struct
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

NLP_MAGIC = b"NLP1"
BUCKET = "eta-audio"
KEY_PREFIX = "lab/nemotron-probs/"
EXPECTED_WINDOW_S = 900.0
DEFAULT_TOL_S = 5.0
MAX_HEADER_BYTES = 1_000_000

# Whole-millisecond hops this container has meant. 100 ms is an upper bound,
# not a third production hop: it rejects a ratio such as 9 s/frame when the
# caller passes a 900 s duration for a short file.
_MAX_SANE_HOP_MS = 100
_SNAP_REL = 0.02
_DISAGREE_MS = 0.5

FRAME_STEP_NOTE = (
    "The packer writes frame_ms 80. Production objects are 90003 x 8 frames; "
    "90003 * 10 ms = 900.03 s (the bench window) and 90003 * 80 ms = 7200.24 s. "
    "resolve_frame_step infers the hop from the known duration and the frame count. "
    "The header hop is kept when it already fits, or when the ratio is not a "
    "whole-millisecond hop in 1..100 ms. Samples are not dropped and the matrix "
    "is not reshaped."
)


class NlpError(ValueError):
    pass


class FrameStepWarning(UserWarning):
    """The header ``frame_ms`` does not match duration / frame count."""


@dataclass
class NlpLoad:
    probs: np.ndarray  # float64, shape (frames, speakers), approximately in [0, 1]
    header: dict
    interpretation: str
    frames: int
    speakers: int
    frame_ms: float  # hop to use, in milliseconds. Not always the header value.
    duration_s: float  # frames * frame_ms. The header clock stays on candidates.
    duration_ok: bool
    expected_duration_s: float
    tol_s: float
    candidates: list[dict] = field(default_factory=list)
    sanity: dict = field(default_factory=dict)
    header_frame_ms: float = 0.0
    inferred_frame_ms: float | None = None  # raw duration/frames ratio, before snapping
    frame_step_warning: str | None = None


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
    """Decode an NLP1 gzip blob or a path to one.

    ``expected_duration_s`` is the audio length the caller already knows (a bench
    window is 900 s). It is the duration ``resolve_frame_step`` divides by the
    frame count. A header hop that disagrees with that ratio warns.
    """
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
    loaded = _decode(header, payload, expected_duration_s=expected_duration_s, tol_s=tol_s)
    if loaded.frame_step_warning:
        warnings.warn(loaded.frame_step_warning, FrameStepWarning, stacklevel=2)
    return loaded


def load_probs_source(
    source: bytes | Path | str,
    *,
    client=None,
    expected_duration_s: float = EXPECTED_WINDOW_S,
    tol_s: float = DEFAULT_TOL_S,
) -> NlpLoad:
    """Load NLP1 bytes, a filesystem path, or an ``lab/nemotron-probs/*.nlp`` key.

    A key is fetched with ``fetch_nlp_object`` (GetObject only). Pass ``client``
    in tests. A real run with ``client=None`` reads ``R2_ENDPOINT``,
    ``R2_ACCESS_KEY_ID`` and ``R2_SECRET_ACCESS_KEY`` and never prints them.
    """
    if isinstance(source, str) and source.startswith(KEY_PREFIX):
        blob = fetch_nlp_object(source, client=client)
        return load_nlp(blob, expected_duration_s=expected_duration_s, tol_s=tol_s)
    return load_nlp(source, expected_duration_s=expected_duration_s, tol_s=tol_s)


def resolve_frame_step(
    n_frames: int,
    header_frame_ms: float,
    duration_s: float,
    *,
    tol_s: float,
) -> dict:
    """Infer the hop from ``duration_s / n_frames`` and compare it to the header.

    The snapped hop replaces the header only when all of these hold: the raw
    ratio is within 2% of a whole millisecond in 1..100 ms, that hop lands
    inside ``tol_s`` of ``duration_s``, and it is strictly closer than the
    header hop. Otherwise the header hop is kept. Either disagreement is
    returned as ``warning`` (the caller raises ``FrameStepWarning``).
    """
    header = float(header_frame_ms)
    known = float(duration_s)
    tol = float(tol_s)
    n = int(n_frames)
    if n < 0:
        raise NlpError("n_frames must be >= 0")
    if header <= 0 or known <= 0 or tol < 0:
        raise NlpError("header frame_ms and duration_s must be > 0")
    if n == 0:
        return {
            "frame_ms": header,
            "header_frame_ms": header,
            "inferred_ms": None,
            "snapped": False,
            "adopted": False,
            "warning": None,
            "duration_s": 0.0,
        }
    raw = known * 1000.0 / n
    snapped_i = int(round(raw))
    snap_ok = 1 <= snapped_i <= _MAX_SANE_HOP_MS and abs(raw - snapped_i) <= _SNAP_REL * snapped_i
    inferred = float(snapped_i) if snap_ok else raw
    header_duration = n * header / 1000.0
    inferred_duration = n * inferred / 1000.0
    header_err = abs(header_duration - known)
    inferred_err = abs(inferred_duration - known)
    disagrees = abs(inferred - header) > _DISAGREE_MS
    adopted = bool(snap_ok and disagrees and inferred_err <= tol and inferred_err < header_err)
    if adopted:
        warning = (
            f"header frame_ms {header:g} disagrees with {inferred:g} ms "
            f"inferred from {known:g} s / {n} frames; using {inferred:g} ms"
        )
        step, duration = inferred, inferred_duration
    else:
        step, duration = header, header_duration
        if abs(raw - header) > _DISAGREE_MS and header_err > tol:
            warning = (
                f"header frame_ms {header:g} disagrees with {raw:.3f} ms "
                f"inferred from {known:g} s / {n} frames; header step kept"
            )
        else:
            warning = None
    return {
        "frame_ms": float(step),
        "header_frame_ms": header,
        "inferred_ms": float(raw),
        "snapped": bool(snap_ok),
        "adopted": adopted,
        "warning": warning,
        "duration_s": float(duration),
    }


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
    probs = chosen["probs"]
    resolved = resolve_frame_step(
        int(probs.shape[0]),
        frame_ms,
        float(expected_duration_s),
        tol_s=float(tol_s),
    )
    duration_s = float(resolved["duration_s"])
    duration_ok = abs(duration_s - float(expected_duration_s)) <= float(tol_s)
    hypotheses = {
        "rows_are_frames_s": rows * frame_ms / 1000.0,
        "rows_over_cols_s": (rows / cols) * frame_ms / 1000.0,
        "ten_ms_if_rows_are_frames_s": rows * 0.010,
    }
    notes: list[str] = []
    if probs.size and float(np.nanmax(probs)) > 1.01:
        notes.append("values_exceed_1_check_scale")
    if resolved["warning"]:
        notes.append(resolved["warning"])
    sanity = {
        "frame_step_note": FRAME_STEP_NOTE,
        "payload_bytes": len(payload),
        "header_rows": rows,
        "header_cols": cols,
        "frame_ms": frame_ms,
        "header_duration_s": int(probs.shape[0]) * frame_ms / 1000.0,
        "scale": scale,
        "hypotheses_s": hypotheses,
        "duration_ok": duration_ok,
        "expected_duration_s": float(expected_duration_s),
        "tol_s": float(tol_s),
        "selected": chosen["interpretation"],
        "frame_step": {
            "header_frame_ms": resolved["header_frame_ms"],
            "inferred_ms": resolved["inferred_ms"],
            "resolved_frame_ms": resolved["frame_ms"],
            "adopted": resolved["adopted"],
            "warning": resolved["warning"],
        },
        "warnings": notes,
        "tie_note": chosen.get("tie_note"),
    }
    return NlpLoad(
        probs=probs,
        header=header,
        interpretation=chosen["interpretation"],
        frames=int(probs.shape[0]),
        speakers=int(probs.shape[1]),
        frame_ms=float(resolved["frame_ms"]),
        duration_s=duration_s,
        duration_ok=bool(duration_ok),
        expected_duration_s=float(expected_duration_s),
        tol_s=float(tol_s),
        candidates=[{k: v for k, v in c.items() if k != "probs"} | {"shape": list(c["probs"].shape)} for c in candidates],
        sanity=sanity,
        header_frame_ms=float(resolved["header_frame_ms"]),
        inferred_frame_ms=None if resolved["inferred_ms"] is None else float(resolved["inferred_ms"]),
        frame_step_warning=resolved["warning"],
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
