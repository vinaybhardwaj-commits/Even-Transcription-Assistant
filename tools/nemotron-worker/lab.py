"""tools/nemotron-worker/lab.py — pure helpers for the LAB lane and the probability files. Standard library only.

LAB ONLY: nothing here touches production windows' turns. The server validates every override against an allow-list
(lib/diarize-nemotron/lab.ts); this module validates AGAIN before anything reaches ffmpeg or NeMo (a worker does not trust the
body it was handed), and builds the ffmpeg filter string from NUMBERS ONLY: no caller string is ever interpolated.

NLP1 (the probability / embedding file): gzip( "NLP1" | u32le header length | header JSON | payload ).
  dtype "u8"  - a probability quantised to 0..255 (round(p*255)); error at most 1/510.   Frame-major rows x speakers.
  dtype "f16" - IEEE half floats (embeddings).                                            Speaker-major rows x dims.
lib/diarize-nemotron/lab.ts decodeNlp reads exactly this; tests/fixtures/nlp1-golden.nlp is the shared golden file.
"""
from __future__ import annotations

import gzip
import json
import math
import struct
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

PRESETS = ("offline_30.4s", "latency_10s", "latency_1.04s")
EMBEDDERS = ("ecapa", "titanet")
PP_RANGES = {"onset": (0, 1), "offset": (0, 1), "pad_onset": (0, 5), "pad_offset": (0, 5),
             "min_duration_on": (0, 10), "min_duration_off": (0, 10)}
MAX_FRONTEND_OPS = 6
NLP_MAGIC = b"NLP1"


class EmbedderUnavailable(Exception):
    """The requested embedder is not installed / configured on this box. Terminal for the item (`embedder_unavailable`)."""


class SpecError(Exception):
    """A spec the allow-list refuses. Terminal for the item (`bad_spec`): another attempt cannot help."""


def _num(v, lo, hi, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < lo or v > hi:
        raise SpecError(what)
    return float(v)


def validate_spec(spec) -> dict:
    """The spec as the server sent it, re-checked. Returns a normalised copy or raises SpecError."""
    if not isinstance(spec, dict):
        raise SpecError("spec")
    allowed = {"preset", "postprocessing", "frontend", "max_speakers", "min_speech_ms", "return_probs", "return_embeddings"}
    if set(spec) - allowed:
        raise SpecError("unknown_key")
    preset = spec.get("preset", "offline_30.4s")
    if preset not in PRESETS:
        raise SpecError("preset")
    pp = spec.get("postprocessing") or {}
    if not isinstance(pp, dict):
        raise SpecError("postprocessing")
    clean_pp = {}
    for k in sorted(pp):
        if k not in PP_RANGES:
            raise SpecError("postprocessing_key")
        lo, hi = PP_RANGES[k]
        clean_pp[k] = _num(pp[k], lo, hi, "postprocessing_value")
    fe = spec.get("frontend") or []
    if not isinstance(fe, list) or len(fe) > MAX_FRONTEND_OPS:
        raise SpecError("frontend")
    clean_fe = []
    for step in fe:
        if not isinstance(step, dict) or not isinstance(step.get("op"), str):
            raise SpecError("frontend_step")
        op = step["op"]
        extra = set(step) - {"op"}
        if op == "highpass" and extra == {"hz"}:
            clean_fe.append({"op": op, "hz": _num(step["hz"], 20, 1000, "highpass")})
        elif op == "lowpass" and extra == {"hz"}:
            clean_fe.append({"op": op, "hz": _num(step["hz"], 2000, 7900, "lowpass")})
        elif op == "gain" and extra == {"db"}:
            clean_fe.append({"op": op, "db": _num(step["db"], -30, 30, "gain")})
        elif op == "loudnorm" and not extra:
            clean_fe.append({"op": op})
        elif op == "afftdn" and extra == {"nr"}:
            clean_fe.append({"op": op, "nr": _num(step["nr"], 0.01, 40, "afftdn")})
        else:
            raise SpecError("frontend_op")
    ms = spec.get("max_speakers")
    if ms is not None and (isinstance(ms, bool) or not isinstance(ms, int) or ms < 1 or ms > 8):
        raise SpecError("max_speakers")
    mn = spec.get("min_speech_ms")
    if mn is not None and (isinstance(mn, bool) or not isinstance(mn, int) or mn < 0 or mn > 600_000):
        raise SpecError("min_speech_ms")
    emb = spec.get("return_embeddings")
    if emb is not None and emb not in EMBEDDERS:
        raise SpecError("return_embeddings")
    return {"preset": preset, "postprocessing": clean_pp, "frontend": clean_fe, "max_speakers": ms, "min_speech_ms": mn,
            "return_probs": spec.get("return_probs") is True, "return_embeddings": emb}


def _g(x: float) -> str:
    """A number as ffmpeg takes it: plain decimal, no exponent, from a float we already range-checked."""
    return format(x, ".6f").rstrip("0").rstrip(".") or "0"


def build_af(frontend: list) -> Optional[str]:
    """One ffmpeg -af string from a VALIDATED front-end chain (numbers only), or None for an empty chain."""
    parts = []
    for s in frontend:
        op = s["op"]
        if op == "highpass":
            parts.append(f"highpass=f={_g(s['hz'])}")
        elif op == "lowpass":
            parts.append(f"lowpass=f={_g(s['hz'])}")
        elif op == "gain":
            parts.append(f"volume={_g(s['db'])}dB")
        elif op == "loudnorm":
            parts.append("loudnorm=I=-23:LRA=7:TP=-2")
        elif op == "afftdn":
            parts.append(f"afftdn=nr={_g(s['nr'])}")
        else:  # unreachable after validate_spec; never build a filter from an unknown op
            raise SpecError("frontend_op")
    return ",".join(parts) or None


def filter_speakers(segments, max_speakers: Optional[int], min_speech_ms: Optional[int]):
    """Drop speakers with less speech than min_speech_ms, then keep the max_speakers with the most speech. `segments` are
    (start_s, end_s, label). Speech is summed per label (overlap counted per speaker). Pure and deterministic: ties break on label."""
    totals: dict = {}
    for a, b, label in segments:
        totals[label] = totals.get(label, 0.0) + max(0.0, float(b) - float(a))
    keep = {k for k, v in totals.items() if min_speech_ms is None or v * 1000.0 >= min_speech_ms}
    if max_speakers is not None and len(keep) > max_speakers:
        ranked = sorted(keep, key=lambda k: (-totals[k], str(k)))
        keep = set(ranked[:max_speakers])
    return [(a, b, label) for a, b, label in segments if label in keep]


def postprocessing_yaml(pp: dict) -> Optional[str]:
    """The NeMo post-processing file, written by the worker from validated numbers (never from caller text)."""
    if not pp:
        return None
    return "parameters:\n" + "".join(f"  {k}: {_g(pp[k])}\n" for k in sorted(pp))


# ---------------------------------------------------------------------------------------------------------------
# NLP1
# ---------------------------------------------------------------------------------------------------------------

def _to_half(x: float) -> int:
    return struct.unpack("<H", struct.pack("<e", x))[0]


def pack_nlp(rows, dtype: str, extra: Optional[dict] = None) -> bytes:
    """Encode a rows x cols matrix (lists of floats). Deterministic bytes (gzip mtime fixed at 0)."""
    r = len(rows)
    c = len(rows[0]) if r else 0
    header = {"dtype": dtype, "rows": r, "cols": c, **({"scale": 255} if dtype == "u8" else {}), **(extra or {})}
    buf = bytearray()
    for row in rows:
        if len(row) != c:
            raise ValueError("ragged matrix")
        if dtype == "u8":
            buf += bytes(max(0, min(255, int(round(v * 255)))) for v in row)
        elif dtype == "f16":
            buf += b"".join(struct.pack("<e", v) for v in row)
        else:
            raise ValueError("dtype")
    head = json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return gzip.compress(NLP_MAGIC + struct.pack("<I", len(head)) + head + bytes(buf), compresslevel=9, mtime=0)


def unpack_nlp(blob: bytes):
    """(header, rows). Raises ValueError on anything malformed."""
    raw = gzip.decompress(blob)
    if raw[:4] != NLP_MAGIC:
        raise ValueError("not NLP1")
    (hlen,) = struct.unpack("<I", raw[4:8])
    header = json.loads(raw[8:8 + hlen].decode("utf-8"))
    payload = raw[8 + hlen:]
    r, c, dtype = header["rows"], header["cols"], header["dtype"]
    size = 1 if dtype == "u8" else 2
    if dtype not in ("u8", "f16") or len(payload) != r * c * size:
        raise ValueError("NLP1 payload")
    rows = []
    for i in range(r):
        chunk = payload[i * c * size:(i + 1) * c * size]
        rows.append([b / 255 for b in chunk] if dtype == "u8" else [struct.unpack("<e", chunk[j:j + 2])[0] for j in range(0, len(chunk), 2)])
    return header, rows


# ---------------------------------------------------------------------------------------------------------------
# Upload: a presigned PUT, https only (plus a test override), no redirect followed, no URL in any message.
# ---------------------------------------------------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def put_object(url: str, data: bytes, timeout_s: float = 120.0, schemes: tuple = ("https",)) -> bool:
    """True when the PUT answered 2xx. Never raises; never logs or returns the URL."""
    try:
        if urllib.parse.urlsplit(str(url)).scheme.lower() not in schemes:
            return False
        req = urllib.request.Request(url, data=data, method="PUT")
        req.add_header("content-type", "application/octet-stream")
        with _OPENER.open(req, timeout=timeout_s) as r:
            return 200 <= r.status < 300
    except Exception:
        return False
