"""S2b voiceprint re-enrolment: the pure parts. No numpy, no network, no database.

Everything here is a function of its arguments, so it can be tested without the Mini and without
Postgres. The three things that must not drift from production live here and are pinned by
tests/unit/s2b-reenrol.test.ts:

  * the wire format of an embedding (float32, little-endian, 192 values, 768 bytes, base64, RAW, not
    L2-normalised) -- what ~/eta-diarize/server.py /enroll returns;
  * how a centroid is built from samples -- lib/enroll.ts averageEmbeddings: an arithmetic mean
    accumulated in float32;
  * the watchdog gate for heavy Mini work.

Nothing here prints or stores transcript text, patient labels or room labels. Ids, counts, seconds.
"""
from __future__ import annotations

import base64
import json
import math
import struct
from statistics import median

DIM = 192
ROOM_THRESHOLD = 0.65  # V's number. Reported against, never changed here.
STOP_DIARIZE_MS = 400


def _f32(x: float) -> float:
    """Round a Python float to float32, as a Float32Array store would."""
    return struct.unpack("<f", struct.pack("<f", x))[0]


def encode_emb(vec) -> str:
    """192 floats -> base64 of little-endian float32. Same bytes as numpy '<f4' .tobytes()."""
    vec = list(vec)
    if len(vec) != DIM:
        raise ValueError(f"unexpected_dim_{len(vec)}")
    return base64.b64encode(struct.pack(f"<{DIM}f", *vec)).decode("ascii")


def decode_emb(b64: str) -> list[float]:
    raw = base64.b64decode(b64)
    if len(raw) != DIM * 4:
        raise ValueError(f"unexpected_bytes_{len(raw)}")
    return list(struct.unpack(f"<{DIM}f", raw))


def mean_raw(b64s: list[str]) -> str:
    """lib/enroll.ts averageEmbeddings, reproduced: sum in float32 element by element, then divide
    by n, still in float32. Raw vectors, no normalisation. Byte-identical output."""
    if not b64s:
        raise ValueError("no_valid_embeddings")
    acc = [0.0] * DIM
    for b in b64s:
        v = decode_emb(b)
        for i in range(DIM):
            acc[i] = _f32(acc[i] + v[i])
    n = len(b64s)
    return encode_emb([_f32(a / n) for a in acc])


def cosine(a_b64: str, b_b64: str) -> float | None:
    a, b = decode_emb(a_b64), decode_emb(b_b64)
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return None
    return dot / (na * nb)


def distribution(scores: list[float], threshold: float = ROOM_THRESHOLD) -> dict:
    """n, median, worst, and how many clear the threshold. Empty input reports n=0 and nulls."""
    s = [x for x in scores if x is not None]
    if not s:
        return {"n": 0, "median": None, "worst": None, "n_clearing": 0, "threshold": threshold}
    return {
        "n": len(s),
        "median": round(median(s), 3),
        "worst": round(min(s), 3),
        "n_clearing": sum(1 for x in s if x >= threshold),
        "threshold": threshold,
    }


def select_segments(segments: list[dict], speaker_idx: int, min_ms: int = 1500,
                    budget_ms: int = 60_000, clip_ms: int = 20_000) -> list[list[dict]]:
    """Strongest segments for one speaker, grouped into clips.

    "Strongest" = longest first (the diarizer's own choice for its embedding, server.py:169-173),
    overlap-flagged segments excluded because two voices are in them. Take segments until budget_ms
    of speech is chosen, then re-order chronologically and pack into clips of at most clip_ms so no
    single /enroll call is large. A segment is never split. Returns a list of clips, each a list of
    {start_ms, end_ms}. Deterministic: ties break on start_ms.
    """
    mine = [
        {"start_ms": s["start_ms"], "end_ms": s["end_ms"]}
        for s in segments
        if s.get("speaker_idx") == speaker_idx
        and not s.get("overlap")
        and (s["end_ms"] - s["start_ms"]) >= min_ms
    ]
    mine.sort(key=lambda s: (-(s["end_ms"] - s["start_ms"]), s["start_ms"]))
    chosen, total = [], 0
    for s in mine:
        dur = s["end_ms"] - s["start_ms"]
        if total + dur > budget_ms:
            continue
        chosen.append(s)
        total += dur
    chosen.sort(key=lambda s: s["start_ms"])
    clips, cur, cur_ms = [], [], 0
    for s in chosen:
        dur = s["end_ms"] - s["start_ms"]
        if cur and cur_ms + dur > clip_ms:
            clips.append(cur)
            cur, cur_ms = [], 0
        cur.append(s)
        cur_ms += dur
    if cur:
        clips.append(cur)
    return clips


def gate(last_line: str) -> tuple[bool, str]:
    """The watchdog gate for heavy Mini work. GO unless the last verdict starts with STOP_ or
    diarize_ms >= 400. free_pct is ignored on purpose. An unreadable line is NO-GO: an unknown
    machine state is not a green light."""
    try:
        row = json.loads(last_line)
    except (ValueError, TypeError):
        return False, "unreadable_watchdog_line"
    verdict = str(row.get("verdict", ""))
    if verdict.startswith("STOP_"):
        return False, verdict
    ms = row.get("diarize_ms")
    if not isinstance(ms, (int, float)):
        return False, "diarize_ms_missing"
    if ms >= STOP_DIARIZE_MS:
        return False, f"diarize_ms_{int(ms)}"
    return True, verdict or "ok"


def _q(s: str) -> str:
    """SQL string literal. Inputs here are ids, base64 and JSON built from ids and numbers, but the
    quoting is still done properly rather than trusted."""
    return "'" + s.replace("'", "''") + "'"


def generation_insert_sql(clinician_id: str, generation: int, samples_b64: list[str],
                          provenance: dict) -> str:
    """One INSERT for a room_audio generation. Insert-only: a second run collides on
    (clinician_id, generation) and does nothing. No UPDATE, no DELETE, voice_print untouched."""
    if generation < 2:
        raise ValueError("generation 1 is the enrolment_clip backfill; room_audio starts at 2")
    centroid_b64 = mean_raw(samples_b64)
    return (
        "INSERT INTO voice_print_generation "
        "(id, clinician_id, generation, origin, centroid, sample_count, samples_json, provenance_json) VALUES ("
        f"{_q(f'vpg_{clinician_id}_g{generation}')}, {_q(clinician_id)}, {generation}, 'room_audio', "
        f"decode({_q(centroid_b64)}, 'base64'), {len(samples_b64)}, "
        f"{_q(json.dumps(samples_b64))}::jsonb, {_q(json.dumps(provenance, sort_keys=True))}::jsonb"
        ") ON CONFLICT DO NOTHING;"
    )
