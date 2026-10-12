"""Doctor-voice reference for one patient window.

For each patient window, take the doctor speaker's own speech on the same clip:
the segments nearest the window, up to ``budget_s`` (default 15 s) and only
inside ``± horizon_s`` (default 60 s). Two evidence paths feed the same selector:

* Diarization segments (``--segments``, or a ``segments_json`` column). A segment
  counts as the doctor when its role is ``doctor`` / ``clinician``, or when its
  ``speaker_idx`` matches ``doctor_speaker_idx`` / ``doctor_slot`` on the window
  (the CLI ``--doctor-slot`` fills that in when the row is blank). Overlap
  segments are dropped. ``doctor_uid8`` is applied only when both sides carry it.
* Nemotron per-frame probabilities (``--nemotron-dir``). Used when ``diar_src``
  is ``nemotron``, or when no segments exist for the clip. Doctor frames are the
  single-speaker frames of ``doctor_frames``. Frame 0 is clip time ``nlp_origin_s``
  (default 0).

The runner extracts each model on the stitched doctor audio and caches that
result per clip and span, so two patient windows that land on the same doctor
span do not run the model twice.

Relative columns, written onto the patient row:

* ``{model}__{feature}__rel_doctor`` = patient − doctor, for arousal, valence,
  dominance, and for eGeMAPS F0, loudness and rate.
* ``{model}__{feature}__rel_doctor_ratio`` where a ratio is meaningful: linear
  loudness and rate (both sides > 0), and F0 level as an Hz ratio
  ``2 ** ((patient_semitone − doctor_semitone) / 12)``. Semitone slopes, dB, and
  the dimensional scalars get a difference only.
* ``{model}__rel_doctor_cosine`` between the two embeddings.

This overwrites the z-score ``__rel_doctor`` from ``baseline.py`` on those
columns only. Other baseline columns are left alone. No transcript text and no
window id is logged.
"""

from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tools.timbre.audio import TARGET_SR, read_spans
from tools.timbre.mem import InsufficientMemory
from tools.timbre.nemotron_probs import NlpError, doctor_frames, load_nlp

_DOCTOR_ROLES = {"doctor", "clinician"}
_OTHER_ROLES = {"patient", "attender", "translator", "other", "nurse", "family"}
_NEMO_SRC = {"nemotron", "nemotron_probs", "probs"}
_AUDIO_EXTS = (".wav", ".flac")

# eGeMAPS functionals. Level features get a ratio; the rest of each family is a difference.
_F0_LEVEL_TOKENS = ("amean", "percentile20", "percentile50", "percentile80")
_LOUD_LEVEL_TOKENS = ("amean", "percentile20", "percentile50", "percentile80")
_RATE_EXACT = {
    "voicedsegmentspersec",
    "loudnesspeakspersec",
    "meanvoicedsegmentlengthsec",
    "meanunvoicedsegmentlength",
}


class DoctorRefError(ValueError):
    pass


@dataclass(frozen=True)
class Span:
    start_s: float
    end_s: float

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s


@dataclass(frozen=True)
class Segment:
    clip_id: str
    start_s: float
    end_s: float
    speaker_idx: int | None
    role: str
    overlap: bool
    doctor_uid8: str


@dataclass
class DoctorRefSettings:
    clip_audio_dir: Path
    segments_path: Path | None = None
    nemotron_dir: Path | None = None
    budget_s: float = 15.0
    horizon_s: float = 60.0
    doctor_slot: int | None = None
    doctor_thr: float = 0.5
    min_segment_s: float = 0.0

    def __post_init__(self) -> None:
        self.clip_audio_dir = Path(self.clip_audio_dir)
        if self.segments_path is not None:
            self.segments_path = Path(self.segments_path)
        if self.nemotron_dir is not None:
            self.nemotron_dir = Path(self.nemotron_dir)
        if self.budget_s <= 0:
            raise DoctorRefError("doctor budget must be > 0")
        if self.horizon_s < 0:
            raise DoctorRefError("doctor horizon must be >= 0")
        if not 0.0 <= float(self.doctor_thr) <= 1.0:
            raise DoctorRefError("doctor thr must be in [0, 1]")
        if self.min_segment_s < 0:
            raise DoctorRefError("min segment must be >= 0")

    def as_config(self) -> DoctorRefConfig:
        return DoctorRefConfig(
            budget_s=float(self.budget_s),
            horizon_s=float(self.horizon_s),
            min_segment_s=float(self.min_segment_s),
        )


@dataclass(frozen=True)
class DoctorRefConfig:
    budget_s: float = 15.0
    horizon_s: float = 60.0
    min_segment_s: float = 0.0


@dataclass
class Plan:
    window_id: str
    clip_id: str
    source: str
    status: str
    reason: str | None
    spans: tuple[Span, ...] = ()
    audio_s: float = float("nan")
    n_spans: int = 0


def feature_kind(model_name: str, feature: str) -> str | None:
    """``diff``, ``f0_level`` (difference + Hz ratio), ``linear`` (difference + ratio), or None."""
    if feature in ("arousal", "valence", "dominance"):
        return "diff"
    if not str(model_name).startswith("egemaps"):
        return None
    low = str(feature).lower()
    if low.startswith("f0semitone"):
        if any(tok in low for tok in _F0_LEVEL_TOKENS):
            return "f0_level"
        return "diff"
    if low.startswith("loudness_sma3"):
        if any(tok in low for tok in _LOUD_LEVEL_TOKENS):
            return "linear"
        return "diff"
    if low in _RATE_EXACT:
        return "linear"
    if low.startswith("equivalentsoundlevel"):
        return "diff"
    return None


def relative_pair(patient, doctor, kind: str) -> tuple[float, float | None]:
    """Difference, and a ratio when ``kind`` supports one. Non-finite inputs stay NaN."""
    p = _finite(patient)
    d = _finite(doctor)
    diff = float("nan") if p is None or d is None else float(p - d)
    if kind == "diff":
        return diff, None
    if kind == "f0_level":
        if p is None or d is None:
            return diff, float("nan")
        return diff, float(2.0 ** ((p - d) / 12.0))
    if kind == "linear":
        if p is None or d is None or not (p > 0.0 and d > 0.0):
            return diff, float("nan")
        return diff, float(p / d)
    raise DoctorRefError(f"unknown feature kind {kind}")


def cosine(a, b) -> float:
    if a is None or b is None:
        return float("nan")
    try:
        av = np.asarray(a, dtype=np.float64).reshape(-1)
        bv = np.asarray(b, dtype=np.float64).reshape(-1)
    except (TypeError, ValueError):
        return float("nan")
    if av.size == 0 or av.shape != bv.shape:
        return float("nan")
    if not np.isfinite(av).all() or not np.isfinite(bv).all():
        return float("nan")
    na = float(np.linalg.norm(av))
    nb = float(np.linalg.norm(bv))
    if na == 0.0 or nb == 0.0:
        return float("nan")
    return float(np.dot(av, bv) / (na * nb))


def select_nearest(spans: list[Span], start_s: float, end_s: float, config: DoctorRefConfig) -> list[Span]:
    """Doctor spans nearest ``[start_s, end_s]``, trimmed to ``budget_s`` inside the horizon.

    Distance is the gap between the span and the window (0 when they touch or overlap).
    Nearest spans are taken first. A span that would exceed the remaining budget is
    clipped on the side closest to the window. The result is in time order.
    """
    if config.budget_s <= 0:
        raise DoctorRefError("budget_s must be > 0")
    if config.horizon_s < 0:
        raise DoctorRefError("horizon_s must be >= 0")
    if end_s < start_s:
        raise DoctorRefError("window end before start")
    ranked: list[tuple[float, float, float, Span]] = []
    for sp in spans:
        if sp.end_s - sp.start_s <= 0:
            continue
        if (sp.end_s - sp.start_s) < config.min_segment_s:
            continue
        dist = _gap(sp, start_s, end_s)
        if dist > config.horizon_s + 1e-9:
            continue
        ranked.append((dist, sp.start_s, sp.end_s, sp))
    ranked.sort()
    remaining = float(config.budget_s)
    chosen: list[Span] = []
    for _dist, _a, _b, sp in ranked:
        if remaining <= 1e-6:
            break
        dur = sp.end_s - sp.start_s
        if dur <= remaining + 1e-9:
            piece = sp
            remaining -= dur
        else:
            piece = _trim_toward(sp, start_s, end_s, remaining)
            remaining = 0.0
        if piece.end_s - piece.start_s >= 1e-3:
            chosen.append(piece)
    chosen.sort(key=lambda s: (s.start_s, s.end_s))
    return chosen


def frames_to_spans(mask: np.ndarray, frame_s: float, origin_s: float = 0.0) -> list[Span]:
    """Merge a boolean frame mask into half-open time spans."""
    flags = np.asarray(mask, dtype=bool).reshape(-1)
    if frame_s <= 0:
        raise DoctorRefError("frame_s must be > 0")
    spans: list[Span] = []
    start: int | None = None
    for i, bit in enumerate(flags.tolist()):
        if bit and start is None:
            start = i
        elif not bit and start is not None:
            spans.append(Span(origin_s + start * frame_s, origin_s + i * frame_s))
            start = None
    if start is not None:
        spans.append(Span(origin_s + start * frame_s, origin_s + len(flags) * frame_s))
    return spans


def load_segment_table(path: Path | str) -> dict[str, list[Segment]]:
    """Group a CSV, JSON list, or JSONL segment file by ``clip_id``."""
    file = Path(path)
    if not file.is_file():
        raise DoctorRefError("segments file not found")
    suffix = file.suffix.lower()
    try:
        if suffix == ".csv":
            records = _read_csv(file)
        elif suffix == ".json":
            payload = json.loads(file.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("segments"), list):
                payload = payload["segments"]
            if not isinstance(payload, list):
                raise DoctorRefError("segments JSON must be a list")
            records = payload
        else:
            records = _read_jsonl(file)
        parsed = parse_segment_records(records, default_clip=None)
    except DoctorRefError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, csv.Error) as e:
        raise DoctorRefError(f"segments file is not readable ({type(e).__name__})") from e
    grouped: dict[str, list[Segment]] = {}
    for seg in parsed:
        grouped.setdefault(seg.clip_id, []).append(seg)
    return grouped


def parse_segment_records(records, default_clip: str | None) -> list[Segment]:
    out: list[Segment] = []
    for rec in records:
        if not isinstance(rec, dict):
            raise DoctorRefError("segment row is not an object")
        clip = _clean(rec.get("clip_id", rec.get("clip", default_clip)))
        if not clip:
            raise DoctorRefError("segment missing clip_id")
        start_s, end_s = _times(rec)
        if end_s <= start_s:
            raise DoctorRefError("segment end must be greater than start")
        speaker = _optional_int(rec.get("speaker_idx", rec.get("speaker")))
        role = _clean(rec.get("role")).lower()
        uid = _clean(rec.get("doctor_uid8"))
        out.append(
            Segment(
                clip_id=clip,
                start_s=start_s,
                end_s=end_s,
                speaker_idx=speaker,
                role=role,
                overlap=_as_bool(rec.get("overlap")),
                doctor_uid8=uid,
            )
        )
    return out


def doctor_segment_spans(segments: list[Segment], meta: dict, default_slot: int | None) -> list[Span]:
    """Spans whose speaker is the window's doctor. Overlap segments are excluded."""
    spans = []
    for seg in segments:
        if _is_doctor_segment(seg, meta, default_slot):
            spans.append(Span(seg.start_s, seg.end_s))
    return spans


def prepare_plans(windows, settings: DoctorRefSettings) -> list[Plan]:
    """One plan per window. Raises when the operator passed no source at all."""
    if not settings.clip_audio_dir.is_dir():
        raise DoctorRefError("clip audio directory not found")
    if settings.segments_path is not None and not settings.segments_path.is_file():
        raise DoctorRefError("segments file not found")
    if settings.nemotron_dir is not None and not settings.nemotron_dir.is_dir():
        raise DoctorRefError("nemotron directory not found")
    table: dict[str, list[Segment]] = {}
    if settings.segments_path is not None:
        table = load_segment_table(settings.segments_path)
    has_inline = any(_clean(getattr(w, "meta", {}).get("segments_json")) for w in windows)
    if settings.segments_path is None and settings.nemotron_dir is None and not has_inline:
        raise DoctorRefError(
            "no doctor-reference source: pass --segments, --nemotron-dir, or a segments_json column"
        )
    config = settings.as_config()
    plans: list[Plan] = []
    for window in windows:
        plans.append(_plan_one(window, settings, table, config))
    return plans


def extract_doctor_references(extractor, plans: list[Plan], settings: DoctorRefSettings) -> tuple[dict, dict]:
    """Run ``extractor`` on each distinct doctor span. Cache key is clip id + spans."""
    cache: dict[tuple, dict] = {}
    out: dict[str, dict] = {}
    extracts = hits = oks = 0
    for plan in plans:
        if plan.status != "ok" or not plan.spans:
            continue
        key = (plan.clip_id, tuple((round(s.start_s, 6), round(s.end_s, 6)) for s in plan.spans))
        if key in cache:
            hits += 1
            result = cache[key]
        else:
            result = _extract_spans(extractor, settings.clip_audio_dir, plan)
            cache[key] = result
            extracts += 1
        if result.get("status") == "ok":
            oks += 1
        out[plan.window_id] = result
        audio_s = result.get("audio_s")
        if audio_s is not None:
            plan.audio_s = float(audio_s)
    stats = {
        "n_with_spans": int(sum(1 for p in plans if p.spans)),
        "n_extracts": int(extracts),
        "n_cache_hits": int(hits),
        "n_ok": int(oks),
    }
    return out, stats


def write_relative_columns(df, plans: list[Plan], extracts: dict[str, dict[str, dict]]):
    """Append doctor-relative columns. ``extracts`` is model → window_id → extractor row."""
    import pandas as pd

    out = df.copy().reset_index(drop=True)
    n = len(out)
    plan_by = {p.window_id: p for p in plans}
    ids = [str(v) for v in out["window_id"]] if "window_id" in out.columns else []
    pos = {wid: i for i, wid in enumerate(ids)}
    source = [""] * n
    status = ["nan"] * n
    reason: list[str | None] = [None] * n
    ref_s = np.full(n, np.nan)
    n_spans = np.zeros(n, dtype=np.int64)
    for i, wid in enumerate(ids):
        plan = plan_by.get(wid)
        if plan is None:
            reason[i] = "no_source"
            continue
        source[i] = plan.source
        n_spans[i] = int(plan.n_spans)
        ref_s[i] = plan.audio_s
        status[i] = plan.status
        reason[i] = plan.reason
    updates: dict[str, np.ndarray] = {}

    def column(name: str) -> np.ndarray:
        arr = updates.get(name)
        if arr is None:
            arr = np.full(n, np.nan)
            updates[name] = arr
        return arr

    # None means at least one model scored the doctor audio. A string is the
    # first failure, kept only when every model failed.
    extract_fail: dict[str, str | None] = {}
    for model, by_window in extracts.items():
        emb_col = f"{model}__embedding"
        has_emb_col = emb_col in out.columns
        for wid, result in by_window.items():
            i = pos.get(wid, -1)
            if i < 0 or result is None:
                continue
            ok = result.get("status") == "ok"
            if ok:
                extract_fail[wid] = None
            elif wid not in extract_fail:
                extract_fail[wid] = str(result.get("reason") or "extract_failed")
            feats = result.get("features") or {}
            for feat, dval in feats.items():
                kind = feature_kind(model, feat)
                if kind is None:
                    continue
                pcol = f"{model}__{feat}"
                pval = _frame_cell(out, i, pcol) if ok else float("nan")
                diff, ratio = relative_pair(pval, dval if ok else float("nan"), kind)
                column(f"{pcol}__rel_doctor")[i] = diff
                if ratio is not None:
                    column(f"{pcol}__rel_doctor_ratio")[i] = ratio
            if has_emb_col or result.get("embedding") is not None:
                patient_emb = out.at[i, emb_col] if has_emb_col else None
                doctor_emb = result.get("embedding") if ok else None
                column(f"{model}__rel_doctor_cosine")[i] = cosine(patient_emb, doctor_emb)
            audio_s = result.get("audio_s")
            if audio_s is not None and ok:
                ref_s[i] = float(audio_s)
    for i, wid in enumerate(ids):
        plan = plan_by.get(wid)
        if plan is None or plan.reason is not None or wid not in extract_fail:
            continue
        if extract_fail[wid]:
            status[i] = "nan"
            reason[i] = extract_fail[wid]
        else:
            status[i] = "ok"
            reason[i] = None
    for name, arr in updates.items():
        out[name] = arr
    out["doctor_ref_source"] = source
    out["doctor_ref_status"] = status
    out["doctor_ref_reason"] = reason
    out["doctor_ref_s"] = ref_s
    out["doctor_ref_n_spans"] = n_spans
    return out


def _plan_one(window, settings: DoctorRefSettings, table: dict[str, list[Segment]], config: DoctorRefConfig) -> Plan:
    meta = dict(getattr(window, "meta", {}) or {})
    base = Plan(window_id=window.window_id, clip_id=window.clip_id, source="", status="nan", reason=None)
    if str(getattr(window, "role", "patient")).lower() == "doctor":
        base.reason = "skipped_role"
        return base
    inline = _inline_segments(meta, window.clip_id)
    segs = list(table.get(window.clip_id, [])) or inline
    src_name = _clean(meta.get("diar_src")).lower()
    nemo_on = settings.nemotron_dir is not None
    if src_name in _NEMO_SRC or (nemo_on and not segs):
        return _plan_nemotron(window, settings, config, base)
    if not segs:
        base.reason = "no_source"
        return base
    doctor = doctor_segment_spans(segs, meta, settings.doctor_slot)
    if not doctor:
        base.source = "segments"
        # A doctor-shaped segment that was dropped (overlap) is different from a
        # clip whose segments never name this doctor.
        matched = any(s.role in _DOCTOR_ROLES or _slot_match(s, meta, settings.doctor_slot) for s in segs)
        base.reason = "no_doctor_speech" if matched else "doctor_unidentified"
        return base
    chosen = select_nearest(doctor, float(window.start_s), float(window.end_s), config)
    base.source = "segments"
    if not chosen:
        base.reason = "no_doctor_speech"
        base.audio_s = 0.0
        return base
    return _finish_audio_plan(base, chosen, settings)


def _slot_match(seg: Segment, meta: dict, default_slot: int | None) -> bool:
    slot = _slot_of(meta, default_slot)
    return slot is not None and seg.speaker_idx is not None and seg.speaker_idx == slot


def _plan_nemotron(window, settings: DoctorRefSettings, config: DoctorRefConfig, base: Plan) -> Plan:
    base.source = "nemotron"
    if settings.nemotron_dir is None:
        base.reason = "nlp_missing"
        return base
    slot = _slot_of(dict(getattr(window, "meta", {}) or {}), settings.doctor_slot)
    if slot is None:
        base.reason = "doctor_slot_missing"
        return base
    path = find_nlp(window, settings.nemotron_dir)
    if path is None:
        base.reason = "nlp_missing"
        return base
    try:
        loaded = load_nlp(path)
    except (NlpError, OSError):
        base.reason = "nlp_invalid"
        return base
    try:
        mask = doctor_frames(loaded.probs, slot, settings.doctor_thr)
    except NlpError:
        base.reason = "doctor_slot_missing"
        return base
    origin = _origin(getattr(window, "meta", {}) or {})
    spans = frames_to_spans(mask, loaded.frame_ms / 1000.0, origin)
    chosen = select_nearest(spans, float(window.start_s), float(window.end_s), config)
    if not chosen:
        base.reason = "no_doctor_speech"
        base.audio_s = 0.0
        return base
    return _finish_audio_plan(base, chosen, settings)


def _finish_audio_plan(base: Plan, chosen: list[Span], settings: DoctorRefSettings) -> Plan:
    path = find_clip_audio(settings.clip_audio_dir, base.clip_id)
    if path is None:
        base.reason = "clip_audio_missing"
        base.spans = tuple(chosen)
        base.n_spans = len(chosen)
        return base
    base.status = "ok"
    base.reason = None
    base.spans = tuple(chosen)
    base.n_spans = len(chosen)
    base.audio_s = float(sum(s.duration_s for s in chosen))
    return base


def _extract_spans(extractor, clip_dir: Path, plan: Plan) -> dict:
    path = find_clip_audio(clip_dir, plan.clip_id)
    if path is None:
        return _empty_extract("clip_audio_missing")
    try:
        audio = read_spans(path, [(s.start_s, s.end_s) for s in plan.spans])
    except ValueError:
        return _empty_extract("clip_audio_format")
    except OSError:
        return _empty_extract("clip_audio_unreadable")
    if audio.size == 0:
        return _empty_extract("doctor_audio_empty")
    try:
        return extractor.extract(audio, TARGET_SR)
    except InsufficientMemory:
        raise


def _empty_extract(reason: str) -> dict:
    return {"status": "nan", "reason": reason, "features": {}, "embedding": None, "audio_s": 0.0}


def find_clip_audio(audio_dir: Path | str, clip_id: str) -> Path | None:
    root = Path(audio_dir)
    if not clip_id or "/" in clip_id or "\\" in clip_id or clip_id in (".", ".."):
        return None
    for ext in _AUDIO_EXTS:
        path = root / f"{clip_id}{ext}"
        if path.is_file():
            return path
    return None


def find_nlp(window, root: Path) -> Path | None:
    meta = getattr(window, "meta", {}) or {}
    for key in ("nlp_path", "nlp_key"):
        raw = _clean(meta.get(key))
        if not raw or ".." in raw.replace("\\", "/"):
            continue
        for candidate in (Path(raw), root / raw, root / Path(raw).name):
            if candidate.is_file():
                return candidate
    for name in (f"{window.clip_id}.nlp", f"{window.clip_id}.nlp.gz", f"{window.window_id}.nlp"):
        path = root / name
        if path.is_file():
            return path
    return None


def _inline_segments(meta: dict, clip_id: str) -> list[Segment]:
    raw = meta.get("segments_json")
    if raw is None or not str(raw).strip():
        return []
    try:
        payload = json.loads(str(raw))
    except json.JSONDecodeError as e:
        raise DoctorRefError("segments_json is not JSON") from e
    if isinstance(payload, dict) and isinstance(payload.get("segments"), list):
        payload = payload["segments"]
    if not isinstance(payload, list):
        raise DoctorRefError("segments_json must be a list")
    return parse_segment_records(payload, default_clip=clip_id)


def _is_doctor_segment(seg: Segment, meta: dict, default_slot: int | None) -> bool:
    if seg.overlap:
        return False
    uid = _clean(meta.get("doctor_uid8"))
    if uid and seg.doctor_uid8 and uid != seg.doctor_uid8:
        return False
    if seg.role in _DOCTOR_ROLES:
        return True
    if seg.role in _OTHER_ROLES:
        return False
    if _slot_match(seg, meta, default_slot):
        return True
    if uid and seg.doctor_uid8 and uid == seg.doctor_uid8:
        return True
    return False


def _slot_of(meta: dict, default_slot: int | None) -> int | None:
    slot = _optional_int(meta.get("doctor_speaker_idx"))
    if slot is None:
        slot = _optional_int(meta.get("doctor_slot"))
    if slot is None:
        slot = default_slot
    return slot


def _gap(sp: Span, w0: float, w1: float) -> float:
    if sp.end_s >= w0 and sp.start_s <= w1:
        return 0.0
    if sp.end_s <= w0:
        return w0 - sp.end_s
    return sp.start_s - w1


def _trim_toward(sp: Span, w0: float, w1: float, budget: float) -> Span:
    if sp.end_s <= w0:
        return Span(sp.end_s - budget, sp.end_s)
    if sp.start_s >= w1:
        return Span(sp.start_s, sp.start_s + budget)
    ov0 = max(sp.start_s, w0)
    ov1 = min(sp.end_s, w1)
    mid = 0.5 * (ov0 + ov1)
    a = mid - budget / 2.0
    b = a + budget
    if a < sp.start_s:
        shift = sp.start_s - a
        a += shift
        b += shift
    if b > sp.end_s:
        shift = b - sp.end_s
        a -= shift
        b -= shift
    a = max(a, sp.start_s)
    b = min(b, sp.end_s)
    return Span(a, b)


def _times(rec: dict) -> tuple[float, float]:
    if _present(rec, "start_s") or _present(rec, "end_s"):
        if not (_present(rec, "start_s") and _present(rec, "end_s")):
            raise DoctorRefError("segment needs both start_s and end_s")
        return float(rec["start_s"]), float(rec["end_s"])
    if _present(rec, "start_ms") or _present(rec, "end_ms"):
        if not (_present(rec, "start_ms") and _present(rec, "end_ms")):
            raise DoctorRefError("segment needs both start_ms and end_ms")
        return float(rec["start_ms"]) / 1000.0, float(rec["end_ms"]) / 1000.0
    raise DoctorRefError("segment missing start_s/end_s or start_ms/end_ms")


def _present(rec: dict, key: str) -> bool:
    if key not in rec or rec[key] is None:
        return False
    return str(rec[key]).strip() != ""


def _read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _read_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text:
            continue
        rows.append(json.loads(text))
    return rows


def _frame_cell(frame, i: int, col: str):
    if col not in frame.columns:
        return float("nan")
    return frame.iat[i, frame.columns.get_loc(col)]


def _origin(meta: dict) -> float:
    raw = meta.get("nlp_origin_s") if isinstance(meta, dict) else None
    if raw is None or str(raw).strip() == "":
        return 0.0
    return float(raw)


def _clean(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _optional_int(value) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none"}:
        return None
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return None


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "t"}


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number
