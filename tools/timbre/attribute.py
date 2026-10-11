"""Assign a window's transcript to the patient, and keep only that text.

Long mixed-speaker rows are why batch 2 had patient text on 41 of 120 windows.
This module cuts those rows with a speaker timeline:

* Nemotron per-frame probabilities, at the hop ``resolve_frame_step`` adopts
  (10 ms on a production 90,003-frame file) and the doctor/patient columns from
  ``slots.map_slots``
* diarization segments (``start_ms`` / ``end_ms`` / ``speaker_idx`` plus a
  speaker ``type``)

Word timestamps win. A segment timestamp that sits inside one role is kept
whole. Otherwise the line is split by character-proportional time, and that
path is scored at half the confidence of a timestamp. A turn whose role or
speaker type is ``clinician`` is dropped whole: the voiceprint wins, the same
rule as ``stt_text``.

Native text is the primary string (``transcript_native``, ``transcript_original``,
or an ``stt_turn`` ``payload.text``). An English gloss is kept only for the
patient spans. The database is not opened. Times are milliseconds from the
same origin as the timeline; a text span that starts far after the timeline
is rebased by its own earliest start.

``coverage_pct`` is the share of considered transcript time (or characters,
when a row has no times) that was kept as the patient. ``attribution_confidence``
is the duration-weighted purity of those patient pieces, times a method factor
(word 1, segment 0.9, turn label 0.85, proportional 0.5) and, when Nemotron
named the columns, the slot-mapping confidence.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from tools.timbre.lang import detect_language
from tools.timbre.nemotron_probs import resolve_frame_step
from tools.timbre.phi_mask import MaskResult, mask_phi
from tools.timbre.slots import SlotError, map_slots
from tools.timbre.stt_text import _window_id

_DOCTOR = frozenset({"clinician", "doctor", "physician"})
_PATIENT = frozenset({"patient"})
_OTHER = frozenset({"attender", "nurse", "other", "staff"})
_TEXT_LIST_KEYS = ("turns", "transcript_segments", "segments")
_TIMELINE_KEYS = ("diarization", "diarize_segments", "speaker_timeline")
_NATIVE_KEYS = ("text_native", "transcript_native", "native", "text_original", "original", "text")
_GLOSS_KEYS = ("gloss", "text_english", "transcript_english", "english", "translation")
_METHOD_FACTOR = {
    "word_timestamps": 1.0,
    "segment_timestamps": 0.9,
    "turn_label": 0.85,
    "proportional": 0.5,
}
_MIN_SHARE = 0.5
# A span is one speaker only when that role owns almost all of it. Anything
# more mixed is split. 0.9 leaves room for a timestamp that lands on a boundary.
_WHOLE_SHARE = 0.9


class AttributionError(ValueError):
    pass


@dataclass
class Piece:
    unit: int
    text: str
    gloss: str
    start_ms: int
    end_ms: int
    role: str
    purity: float
    method: str


@dataclass
class Attribution:
    window_id: str
    status: str
    text: str
    gloss: str | None
    coverage_pct: float
    attribution_confidence: float
    method: str
    language: str
    code_mixed: bool
    basis_language: str
    n_patient_tokens: int
    mask: MaskResult | None = None
    pieces: list[Piece] = field(default_factory=list)

    def as_row(self) -> dict:
        """Operator JSON. Masked text only. No raw transcript."""
        return {
            "window_id": self.window_id,
            "status": self.status,
            "text": self.text,
            "gloss": self.gloss,
            "coverage_pct": round(self.coverage_pct, 2),
            "attribution_confidence": round(self.attribution_confidence, 4),
            "method": self.method,
            "language": self.language,
            "code_mixed": self.code_mixed,
            "basis_language": self.basis_language,
            "n_patient_tokens": self.n_patient_tokens,
            "residual": list(self.mask.residual) if self.mask is not None else [],
        }


@dataclass(frozen=True)
class _Iv:
    start_ms: int
    end_ms: int
    role: str


def attribute_window(window: dict) -> Attribution:
    """One operator window. ``text`` is masked patient-only native (or gloss)."""
    if not isinstance(window, dict):
        raise AttributionError("window must be an object")
    window_id = _window_id(window)
    by_idx = _speaker_types(window)
    nemo, slot_conf = _nemotron_timeline(window)
    diar = _diarize_timeline(window, by_idx)
    units = _text_units(window, by_idx)
    _rebase(units, _timeline_end(nemo, diar))
    pieces = _pieces(units, nemo, diar)
    return _assemble(window_id, pieces, slot_conf, had_timeline=bool(nemo or diar), had_units=bool(units))


def _pieces(units: list[dict], nemo: list[_Iv], diar: list[_Iv]) -> list[Piece]:
    timeline = bool(nemo or diar)
    out: list[Piece] = []
    for unit in units:
        forced = unit["role"]
        if forced == "doctor":
            out.append(_piece(unit, unit["native"], unit["gloss"], "doctor", 1.0, "turn_label"))
            continue
        words = unit["words"]
        if words and timeline:
            out.extend(_words(unit, words, nemo, diar))
            continue
        if not timeline:
            if forced == "patient" and (unit["native"] or unit["gloss"]):
                out.append(_piece(unit, unit["native"], unit["gloss"], "patient", 1.0, "turn_label"))
            elif unit["native"] or unit["gloss"]:
                out.append(_piece(unit, unit["native"], unit["gloss"], "unknown", 0.0, "turn_label"))
            continue
        out.extend(_span(unit, unit["native"], unit["gloss"], unit["start_ms"], unit["end_ms"], nemo, diar))
    return out


def _words(unit: dict, words: list[dict], nemo: list[_Iv], diar: list[_Iv]) -> list[Piece]:
    out: list[Piece] = []
    for word in words:
        text = _native_text(word) or ""
        gloss = _gloss_text(word) or ""
        if not text and not gloss:
            continue
        start, end = _span_ms(word, default=None)
        if start is None or end is None or end <= start:
            start, end = unit["start_ms"], unit["end_ms"]
        role, purity = _assign(start, end, nemo, diar)
        out.append(Piece(unit["id"], text, gloss, start, end, role, purity, "word_timestamps"))
    if unit["gloss"] and out and not any(p.gloss for p in out) and all(p.role == "patient" for p in out):
        out[0].gloss = unit["gloss"]
    return out


def _span(unit, native: str, gloss: str, start: int, end: int, nemo, diar) -> list[Piece]:
    if not (native or gloss) or end <= start:
        if (native or gloss or "").strip():
            return [Piece(unit["id"], native, gloss, start, end, "unknown", 0.0, "segment_timestamps")]
        return []
    role, purity = _assign(start, end, nemo, diar)
    if purity >= _WHOLE_SHARE and role in ("patient", "doctor", "other"):
        return [Piece(unit["id"], native, gloss, start, end, role, purity, "segment_timestamps")]
    return _proportional(unit, native, gloss, start, end, nemo, diar)


def _proportional(unit, native: str, gloss: str, start: int, end: int, nemo, diar) -> list[Piece]:
    """Split a mixed span. Gloss tokens are paired only when the counts match."""
    gloss_only = not (native or "").strip()
    native_toks = _tokens(gloss if gloss_only else native)
    gloss_toks = [] if gloss_only else _tokens(gloss)
    if not native_toks:
        return []
    weights = [max(len(tok), 1) for tok in native_toks]
    total = sum(weights)
    span = end - start
    cursor = float(start)
    paired = gloss_toks if gloss_toks and len(gloss_toks) == len(native_toks) else None
    out: list[Piece] = []
    for i, tok in enumerate(native_toks):
        nxt = float(end) if i == len(native_toks) - 1 else cursor + span * (weights[i] / total)
        a, b = int(round(cursor)), int(round(nxt))
        if b <= a:
            b = a + 1
        role, purity = _assign(a, b, nemo, diar)
        if gloss_only:
            text, g = "", tok
        else:
            text, g = tok, (paired[i] if paired else "")
        out.append(Piece(unit["id"], text, g, a, b, role, purity, "proportional"))
        cursor = nxt
    if not gloss_only and not paired and gloss and all(p.role == "patient" for p in out):
        out[0].gloss = gloss
    return out


def _piece(unit, text, gloss, role, purity, method) -> Piece:
    return Piece(unit["id"], text, gloss or "", unit["start_ms"], unit["end_ms"], role, purity, method)


def _assign(start: int, end: int, nemo: list[_Iv], diar: list[_Iv]) -> tuple[str, float]:
    dur = end - start
    if dur <= 0:
        return "unknown", 0.0
    totals = _overlap(start, end, nemo, diar)
    best = max(totals.values()) if totals else 0
    winners = [role for role, ms in totals.items() if ms == best and ms > 0]
    if len(winners) != 1:
        return "unknown", 0.0
    purity = best / dur
    if purity < _MIN_SHARE or winners[0] == "unknown":
        return "unknown", purity
    return winners[0], purity


def _overlap(start: int, end: int, nemo: list[_Iv], diar: list[_Iv]) -> dict[str, int]:
    cuts = {start, end}
    for iv in nemo + diar:
        if iv.end_ms <= start or iv.start_ms >= end:
            continue
        cuts.add(max(start, iv.start_ms))
        cuts.add(min(end, iv.end_ms))
    points = sorted(cuts)
    totals = {"patient": 0, "doctor": 0, "other": 0, "unknown": 0}
    for a, b in zip(points, points[1:]):
        if b <= a:
            continue
        totals[_role_at(a, nemo, diar)] += b - a
    return totals


def _role_at(t: int, nemo: list[_Iv], diar: list[_Iv]) -> str:
    named = _one(nemo, t)
    if named is not None:
        return named
    named = _one(diar, t)
    if named is not None:
        return named
    return "unknown"


def _one(intervals: list[_Iv], t: int) -> str | None:
    hits = [iv.role for iv in intervals if iv.start_ms <= t < iv.end_ms]
    if not hits:
        return None
    if len(set(hits)) == 1:
        return hits[0]
    return "unknown"


def _assemble(window_id, pieces, slot_conf, *, had_timeline: bool, had_units: bool) -> Attribution:
    patient = [p for p in pieces if p.role == "patient" and ((p.text or "").strip() or (p.gloss or "").strip())]
    if not had_units:
        status = "no_turns"
    elif patient:
        status = "ok"
    elif had_timeline or any(p.role == "doctor" for p in pieces):
        status = "no_patient_speaker"
    else:
        status = "not_patient_attributed"
    native_bits, gloss_bits = _join(patient)
    detected = detect_language(native_bits or "\n".join(gloss_bits))
    masked_native = mask_phi(native_bits) if native_bits else None
    masked_gloss = mask_phi("\n".join(gloss_bits)) if gloss_bits else None
    if native_bits and gloss_bits:
        basis = "native+gloss"
        shown = masked_native.text if masked_native else ""
        gloss_out = masked_gloss.text if masked_gloss else None
    elif native_bits:
        basis = "native"
        shown = masked_native.text if masked_native else ""
        gloss_out = None
    elif gloss_bits:
        basis = "gloss"
        shown = masked_gloss.text if masked_gloss else ""
        gloss_out = None
    else:
        basis = "none"
        shown = ""
        gloss_out = None
    residual = tuple(dict.fromkeys((masked_native.residual if masked_native else ()) + (masked_gloss.residual if masked_gloss else ())))
    mask = MaskResult(text=shown, counts={}, residual=residual) if status == "ok" else None
    coverage = _coverage(pieces)
    confidence = _confidence(patient, slot_conf if had_timeline else 1.0)
    return Attribution(
        window_id=window_id,
        status=status,
        text=shown if status == "ok" else "",
        gloss=gloss_out if status == "ok" else None,
        coverage_pct=coverage if status == "ok" else 0.0,
        attribution_confidence=confidence if status == "ok" else 0.0,
        method=_dominant_method(patient) if patient else "",
        language=detected.language if status == "ok" else "unknown",
        code_mixed=detected.code_mixed if status == "ok" else False,
        basis_language=basis if status == "ok" else "none",
        n_patient_tokens=len(patient) if status == "ok" else 0,
        mask=mask,
        pieces=pieces,
    )


def _join(patient: list[Piece]) -> tuple[str, list[str]]:
    """Native lines per unit, and gloss lines that belong to those units."""
    by_unit: dict[int, list[Piece]] = {}
    for piece in sorted(patient, key=lambda p: (p.unit, p.start_ms)):
        by_unit.setdefault(piece.unit, []).append(piece)
    natives: list[str] = []
    glosses: list[str] = []
    for unit_pieces in by_unit.values():
        words = [p.text.strip() for p in unit_pieces if p.text.strip()]
        if words:
            natives.append(" ".join(words))
        g = [p.gloss.strip() for p in unit_pieces if p.gloss.strip()]
        if g:
            glosses.append(" ".join(g))
    return "\n".join(natives), glosses


def _coverage(pieces: list[Piece]) -> float:
    weights = [_weight(p) for p in pieces]
    total = sum(weights)
    if total <= 0:
        return 0.0
    kept = sum(w for p, w in zip(pieces, weights) if p.role == "patient")
    return 100.0 * kept / total


def _confidence(patient: list[Piece], slot_conf: float) -> float:
    if not patient:
        return 0.0
    weights = [_weight(p) for p in patient]
    total = sum(weights)
    if total <= 0:
        return 0.0
    acc = 0.0
    for piece, weight in zip(patient, weights):
        factor = _METHOD_FACTOR.get(piece.method, 0.5)
        acc += weight * max(0.0, min(1.0, piece.purity)) * factor
    return max(0.0, min(1.0, (acc / total) * max(0.0, min(1.0, slot_conf))))


def _weight(piece: Piece) -> int:
    dur = piece.end_ms - piece.start_ms
    if dur > 0:
        return dur
    return max(len(piece.text), 1)


def _dominant_method(patient: list[Piece]) -> str:
    scores: dict[str, int] = {}
    for piece in patient:
        scores[piece.method] = scores.get(piece.method, 0) + _weight(piece)
    return max(scores, key=lambda m: (scores[m], m))


def _timeline_end(nemo: list[_Iv], diar: list[_Iv]) -> int:
    ends = [iv.end_ms for iv in nemo + diar]
    return max(ends) if ends else 0


def _rebase(units: list[dict], timeline_end: int) -> None:
    starts = [u["start_ms"] for u in units if u["start_ms"] is not None]
    if not starts or timeline_end <= 0:
        return
    origin = min(starts)
    if origin > timeline_end + 1000:
        for unit in units:
            unit["start_ms"] -= origin
            unit["end_ms"] -= origin
            for word in unit["words"]:
                start, end = word.get("_start"), word.get("_end")
                if start is None:
                    start, end = _span_ms(word, default=None)
                if start is None or end is None:
                    continue
                word["_start"] = start - origin
                word["_end"] = end - origin


def _text_units(window: dict, by_idx: dict[int, str]) -> list[dict]:
    rows = _text_list(window)
    units = []
    if rows is not None:
        for i, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            native = _native_text(row) or ""
            gloss = _gloss_text(row) or ""
            words = _word_list(row)
            if not native and not gloss and not words:
                continue
            start, end = _span_ms(row, default=(0, 0))
            units.append(
                {
                    "id": i,
                    "native": native,
                    "gloss": gloss,
                    "start_ms": start,
                    "end_ms": end if end > start else start,
                    "role": _forced_role(row, by_idx),
                    "words": words,
                }
            )
        return units
    native = _first_str(window, ("transcript_native", "transcript_original", "text_native", "text"))
    gloss = _first_str(window, ("transcript_english", "text_english", "gloss", "english"))
    if not native and not gloss:
        return []
    start, end = _window_bounds(window)
    return [
        {
            "id": 0,
            "native": native or "",
            "gloss": gloss or "",
            "start_ms": start,
            "end_ms": end,
            "role": None,
            "words": _word_list(window),
        }
    ]


def _text_list(window: dict) -> list | None:
    for key in _TEXT_LIST_KEYS:
        val = window.get(key)
        if not isinstance(val, list):
            continue
        if any(isinstance(item, dict) and (_native_text(item) or _gloss_text(item) or _word_list(item)) for item in val):
            return val
    return None


def _window_bounds(window: dict) -> tuple[int, int]:
    if _is_num(window.get("duration_ms")):
        return 0, int(window["duration_ms"])
    start = window.get("start_ms")
    end = window.get("end_ms")
    if _is_num(start) and _is_num(end) and int(end) > int(start):
        return 0, int(end) - int(start)
    if _is_num(window.get("duration_s")):
        return 0, int(float(window["duration_s"]) * 1000)
    return 0, 0


def _nemotron_timeline(window: dict) -> tuple[list[_Iv], float]:
    block = window.get("nemotron") if isinstance(window.get("nemotron"), dict) else {}
    raw = block.get("probs", window.get("nemotron_probs"))
    if raw is None:
        return [], 1.0
    arr = np.asarray(raw, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[0] < 1 or arr.shape[1] < 1 or not np.isfinite(arr).all():
        raise AttributionError("nemotron probs must be a finite (frames, speakers) matrix")
    header = float(block.get("frame_ms", window.get("frame_ms", 80)))
    duration = block.get("duration_s", window.get("duration_s"))
    tol = float(block.get("tol_s", window.get("tol_s", 5.0)))
    if duration is not None:
        frame_ms = float(resolve_frame_step(arr.shape[0], header, float(duration), tol_s=tol)["frame_ms"])
    else:
        frame_ms = header
    if frame_ms <= 0:
        raise AttributionError("frame_ms must be > 0")
    try:
        decision = _slots(arr, frame_ms, block, window)
    except SlotError as exc:
        raise AttributionError(str(exc)) from exc
    if decision is None or not decision.accepted:
        return [], 1.0
    roles = [_frame_role(arr[i], decision.doctor_slot, decision.patient_slot) for i in range(arr.shape[0])]
    return _run_length(roles, frame_ms), float(decision.confidence)


def _slots(arr, frame_ms: float, block: dict, window: dict):
    doctor = block.get("doctor_slot", window.get("doctor_slot"))
    patient = block.get("patient_slot", window.get("patient_slot"))
    if doctor is not None and patient is not None:
        return map_slots(arr, frame_ms=frame_ms, doctor_slot=int(doctor), patient_slot=int(patient))
    eta = block.get("eta_doctor", window.get("eta_doctor"))
    if doctor is not None and eta is None:
        eta = {"slot": int(doctor), "cosine": float(block.get("doctor_cosine", window.get("doctor_cosine", 1.0)))}
    embeddings = block.get("slot_embeddings", window.get("slot_embeddings"))
    centroid = block.get("doctor_centroid", window.get("doctor_centroid"))
    turns = block.get("turns", window.get("slot_turns"))
    if eta is None and embeddings is None:
        return None
    kwargs = {"frame_ms": frame_ms}
    if eta is not None:
        kwargs["eta_doctor"] = eta
    if embeddings is not None:
        if centroid is None:
            raise AttributionError("doctor_centroid is required with slot_embeddings")
        kwargs["slot_embeddings"] = np.asarray(embeddings, dtype=np.float64)
        kwargs["doctor_centroid"] = np.asarray(centroid, dtype=np.float64)
    if turns is not None:
        kwargs["turns"] = turns
    return map_slots(arr, **kwargs)


def _frame_role(row: np.ndarray, doctor_slot: int, patient_slot: int, thr: float = 0.5) -> str:
    above = row >= thr
    if int(above.sum()) != 1:
        return "unknown"
    winner = int(np.argmax(row))
    if winner == int(doctor_slot):
        return "doctor"
    if winner == int(patient_slot):
        return "patient"
    return "other"


def _run_length(roles: list[str], frame_ms: float) -> list[_Iv]:
    if not roles:
        return []
    out: list[_Iv] = []
    cur = roles[0]
    start = 0
    for i, role in enumerate(roles[1:], start=1):
        if role != cur:
            out.append(_Iv(int(round(start * frame_ms)), int(round(i * frame_ms)), cur))
            cur = role
            start = i
    out.append(_Iv(int(round(start * frame_ms)), int(round(len(roles) * frame_ms)), cur))
    return out


def _diarize_timeline(window: dict, by_idx: dict[int, str]) -> list[_Iv]:
    raw = None
    for key in _TIMELINE_KEYS:
        if isinstance(window.get(key), list):
            raw = window[key]
            break
    if raw is None:
        return []
    out: list[_Iv] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        start, end = _span_ms(item, default=None)
        if start is None or end is None or end <= start:
            continue
        role = _segment_role(item, by_idx)
        if role is None:
            continue
        out.append(_Iv(start, end, role))
    return out


def _segment_role(item: dict, by_idx: dict[int, str]) -> str | None:
    explicit = _norm(item.get("type")) or _norm(item.get("speaker_type")) or _norm(item.get("role"))
    if explicit is None:
        idx = _idx(item)
        if idx is not None and idx in by_idx:
            explicit = by_idx[idx]
    if explicit in _DOCTOR:
        return "doctor"
    if explicit in _PATIENT:
        return "patient"
    if explicit in _OTHER:
        return "other"
    speaker = item.get("speaker")
    if isinstance(speaker, str):
        return _segment_role({"type": speaker}, by_idx)
    return None


def _speaker_types(window: dict) -> dict[int, str]:
    out: dict[int, str] = {}
    speakers = window.get("speakers")
    if not isinstance(speakers, list):
        return out
    for sp in speakers:
        if not isinstance(sp, dict):
            continue
        idx = sp.get("idx", sp.get("speaker_idx"))
        typ = sp.get("type", sp.get("role"))
        if not isinstance(typ, str):
            continue
        try:
            out[int(idx)] = typ.strip().lower()
        except (TypeError, ValueError):
            continue
    return out


def _forced_role(unit: dict, by_idx: dict[int, str]) -> str | None:
    """``doctor`` if a clinician label is present, else ``patient``, else None.

    A clinician label wins over a patient type on the same row.
    """
    role = _norm(unit.get("role"))
    typ = _norm(unit.get("speaker_type")) or _norm(unit.get("type"))
    idx = _idx(unit)
    if typ is None and idx is not None and idx in by_idx:
        typ = by_idx[idx]
    if role in _DOCTOR or typ in _DOCTOR:
        return "doctor"
    if role in _PATIENT or typ in _PATIENT:
        return "patient"
    return None


def _word_list(obj: dict) -> list[dict]:
    for key in ("words",):
        val = obj.get(key)
        if isinstance(val, list):
            return [w for w in val if isinstance(w, dict)]
    payload = obj.get("payload")
    if isinstance(payload, dict) and isinstance(payload.get("words"), list):
        return [w for w in payload["words"] if isinstance(w, dict)]
    return []


def _native_text(obj: dict) -> str | None:
    for key in _NATIVE_KEYS:
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    payload = obj.get("payload")
    if isinstance(payload, dict):
        for key in ("text_native", "text"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return None


def _gloss_text(obj: dict) -> str | None:
    for key in _GLOSS_KEYS:
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    payload = obj.get("payload")
    if isinstance(payload, dict):
        for key in ("english", "gloss", "translation"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return None


def _first_str(obj: dict, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _span_ms(obj: dict, default):
    if obj.get("_start") is not None and obj.get("_end") is not None:
        return int(obj["_start"]), int(obj["_end"])
    for a, b in (("start_ms", "end_ms"), ("t0_ms", "t1_ms")):
        if _is_num(obj.get(a)) and _is_num(obj.get(b)):
            return int(float(obj[a])), int(float(obj[b]))
    payload = obj.get("payload")
    if isinstance(payload, dict) and payload is not obj:
        found = _span_ms(payload, None)
        if found != (None, None) and found is not None:
            return found
    if _is_num(obj.get("start")) and _is_num(obj.get("end")):
        return int(round(float(obj["start"]) * 1000)), int(round(float(obj["end"]) * 1000))
    return default if default is not None else (None, None)


def _idx(obj: dict) -> int | None:
    raw = obj.get("speaker_idx", obj.get("idx"))
    if raw is None and isinstance(obj.get("speaker"), dict):
        raw = obj["speaker"].get("idx", obj["speaker"].get("speaker_idx"))
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _tokens(text: str) -> list[str]:
    return text.split()


def _norm(val: object) -> str | None:
    if isinstance(val, str) and val.strip():
        return val.strip().lower()
    return None


def _is_num(val: object) -> bool:
    if isinstance(val, bool) or val is None:
        return False
    if isinstance(val, (int, float)):
        return val == val
    if isinstance(val, str):
        try:
            float(val)
        except ValueError:
            return False
        return True
    return False
