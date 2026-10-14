"""Read one consult from a local folder and join the REB role.llm-roles track onto its turns.

Folder contract (one directory per consult uid; nothing here is ever committed for a real consult):

  <data>/<uid>/transcript.json   Sarvam consult_result: {consult_uid, clip:{t0_ms,t1_ms[,room_slug]}, language_code,
                                 [model_translate], english_segments:[{t0_ms,t1_ms,speaker_id,text}],
                                 [native_segments:[{t0_ms,t1_ms,speaker_id,text,lang}]]}
  <data>/<uid>/stt.json          optional palimpsest stt track {status, segments:[{t0_ms,t1_ms,speaker,lang,text}]},
                                 used as the native segments when transcript.json has none
  <data>/<uid>/role.json         optional REB role.llm-roles track {layer:"role", engine:"llm-roles", status:"ok",
                                 config_hash, segments:[{t0_ms,t1_ms,speaker,role}], extras:{map, attender_present,
                                 two_consults:{flag,gap_at_s} | bool, diar_partial}}
  <data>/<uid>/meta.json         optional {room, specialty, consult_uid, prescription_uid, link_status, link_basis}
  <data>/<uid>/signed.json       optional, eval only: the signed Pulse note, normalised (see eval/judge.py)

The role join mirrors lib/room-access/readers/reb-consult.ts: exact (t0_ms, t1_ms, speaker) key first. English segments
come from a second Sarvam job whose times often miss the stt-aligned role segments, so they then fall back to the role
segment of the same speaker with the largest time overlap, then to extras.map (speaker -> role), then unknown.
The role track's text is never read (it has none).
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

# "attendant" is how the CAA role labels spell attender (kit_reb_export_consult_audit.py ROLE_NAME).
REB_ROLES = ("doctor", "patient", "attender", "attendant", "staff", "other", "unknown")
ROLE_ENGINES = ("llm-roles", "text-judge", "caa-labels")
ROLE_SLOTS = ("role_llm", "role_judge", "role_caa")
# REB role -> artifact speaker (v0.2). v0.1 had no staff/other and spelt attender "attendant".
ARTIFACT_SPEAKER = {"doctor": "doctor", "patient": "patient", "attender": "attendant", "attendant": "attendant",
                    "staff": "staff", "other": "other", "outsider": "other", "unknown": "unknown"}


@dataclass
class Turn:
    idx: int
    t0_ms: int
    t1_ms: int
    speaker: str  # Sarvam diarisation label, e.g. "0"
    text: str
    lang: str = "en"
    native_text: str | None = None
    native_lang: str | None = None
    role: str = "unknown"  # artifact speaker vocabulary (ARTIFACT_SPEAKER values)
    role_source: str = "none"  # role_track | model_inferred | none


@dataclass
class RoleFlags:
    attender_present: bool | None = None
    two_consults: bool | None = None
    gap_at_s: float | None = None
    diar_partial: bool | None = None
    config_hash: str | None = None


@dataclass
class Consult:
    uid: str
    turns: list[Turn]
    clip_t0_ms: int
    clip_t1_ms: int
    language_code: str
    english_source: str
    diarised: bool
    room: str
    meta: dict = field(default_factory=dict)
    role_track: bool = False
    role_flags: RoleFlags | None = None
    signed: dict | None = None
    # Bundle mode only: one {layer, track_path, sha256} per bundle slot that fed this consult. Nothing emits it yet.
    inputs: list[dict] = field(default_factory=list)
    # Bundle mode only: counts-only segment clock tally over every shifted track (see _shift). No text.
    clock_counts: dict = field(default_factory=dict)

    @property
    def speaker_source(self) -> str:
        return "role_track" if self.role_track else "model_inferred"

    @property
    def lang(self) -> str:
        return (self.language_code or "und").split("-")[0]


def _read(p: Path) -> dict | None:
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _segments(raw: dict, stt: dict | None, english: str) -> tuple[list[dict], str]:
    eng = raw.get("english_segments") or []
    native = raw.get("native_segments") or (stt or {}).get("segments") or []
    lang = (raw.get("language_code") or "und").split("-")[0]
    if english in ("auto", "on") and eng:
        src = "native" if lang == "en" else f"mt:{raw.get('model_translate') or 'sarvam'}"
        return eng, src
    if english == "on":
        raise ValueError(f"{raw.get('consult_uid')}: --english on but the transcript has no english_segments")
    if not native:
        if eng:
            return eng, "native" if lang == "en" else f"mt:{raw.get('model_translate') or 'sarvam'}"
        raise ValueError(f"{raw.get('consult_uid')}: transcript has no segments")
    return native, "native" if lang == "en" else f"none:native-{lang}"


def _native_span(g: dict, native: list[dict], default_lang: str) -> tuple[str | None, str | None]:
    """Join overlapping native segments for one English segment. Prefer the same diarisation speaker."""
    try:
        a, b = int(g["t0_ms"]), int(g["t1_ms"])
    except (KeyError, TypeError, ValueError):
        return None, None
    sp = _label(g.get("speaker_id", g.get("speaker")))
    hits = []
    for n in native:
        try:
            na, nb = int(n["t0_ms"]), int(n["t1_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        overlap = min(b, nb) - max(a, na)
        if overlap <= 0:
            continue
        nsp = _label(n.get("speaker_id", n.get("speaker")))
        native_share = overlap / max(1, nb - na)
        hits.append((nsp == sp, overlap, native_share, na, n))
    if not hits:
        return None, None
    same = [h for h in hits if h[0]]
    pool = same or hits
    use = [h for h in pool if h[2] >= 0.5] or [max(pool, key=lambda h: h[1])]
    use.sort(key=lambda h: h[3])
    text = ". ".join(str(h[4].get("text") or "").strip() for h in use if str(h[4].get("text") or "").strip())
    langs = [str(h[4].get("lang") or default_lang).split("-")[0] for h in use]
    return (text or None), (langs[0] if text and langs else None)


MAX_LABEL_CHARS = 128


def _label(v) -> str | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        out = str(int(v))
    elif isinstance(v, str):
        import unicodedata
        out = "".join(" " if unicodedata.category(c) in ("Cc", "Zl", "Zp") else c for c in v)
    else:
        return None
    return out[:MAX_LABEL_CHARS]


def parse_role_flags(doc: dict) -> RoleFlags:
    e = doc.get("extras") if isinstance(doc.get("extras"), dict) else {}
    tc = e.get("two_consults")
    two, gap = (tc, None) if isinstance(tc, bool) else ((tc or {}).get("flag"), (tc or {}).get("gap_at_s")) if isinstance(tc, dict) else (None, None)
    b = lambda v: v if isinstance(v, bool) else None
    return RoleFlags(attender_present=b(e.get("attender_present")), two_consults=b(two),
                     gap_at_s=float(gap) if isinstance(gap, (int, float)) and not isinstance(gap, bool) else None,
                     diar_partial=b(e.get("diar_partial")), config_hash=doc.get("config_hash"))


def valid_role_doc(doc: dict | None) -> bool:
    return bool(doc) and doc.get("status") == "ok" and isinstance(doc.get("segments"), list) \
        and doc.get("layer", "role") == "role" and doc.get("engine", "llm-roles") in ROLE_ENGINES


def join_roles(turns: list[Turn], doc: dict) -> None:
    """Set turn.role / role_source from a role.llm-roles track, in place."""
    exact, by_speaker_segs = {}, {}
    for g in doc.get("segments") or []:
        if not isinstance(g, dict):
            continue
        sp = _label(g.get("speaker"))
        try:
            t0, t1 = int(g["t0_ms"]), int(g["t1_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        if sp is None:
            continue
        role = g.get("role") if g.get("role") in REB_ROLES else "unknown"
        exact.setdefault((t0, t1, sp), role)
        by_speaker_segs.setdefault(sp, []).append((t0, t1, role))
    extras = doc.get("extras") if isinstance(doc.get("extras"), dict) else {}
    smap = {_label(str(k)): (v if v in REB_ROLES else "unknown") for k, v in (extras.get("map") or {}).items()} if isinstance(extras.get("map"), dict) else {}
    for t in turns:
        role = exact.get((t.t0_ms, t.t1_ms, t.speaker))
        if role is None:
            best, best_ov = None, 0
            for a, b, r in by_speaker_segs.get(t.speaker, []):
                ov = min(b, t.t1_ms) - max(a, t.t0_ms)
                if ov > best_ov:
                    best, best_ov = r, ov
            role = best
        if role is None:
            role = smap.get(t.speaker, "unknown")
        t.role, t.role_source = ARTIFACT_SPEAKER.get(role, "unknown"), "role_track"


def apply_inferred_roles(turns: list[Turn], speaker_roles: list[dict]) -> None:
    """Fallback when there is no role track: Stage A's speaker_roles (S<label> -> role). Never overrides a track role."""
    m = {}
    for r in speaker_roles or []:
        lab = str(r.get("speaker", "")).lstrip("Ss")
        m[lab] = (ARTIFACT_SPEAKER.get(str(r.get("role")), "unknown"), float(r.get("confidence") or 0))
    for t in turns:
        if t.role_source == "role_track":
            continue
        role, conf = m.get(t.speaker, ("unknown", 0.0))
        t.role, t.role_source = (role if conf >= 0.5 else "unknown"), "model_inferred"


def load_consult(data_dir: Path, uid: str, english: str = "auto", use_role_track: bool = True) -> Consult:
    d = Path(data_dir) / uid
    raw = _read(d / "transcript.json")
    if raw is None:
        raise FileNotFoundError(f"{d}/transcript.json not found")
    segs, english_source = _segments(raw, _read(d / "stt.json"), english)
    native = raw.get("native_segments") or (_read(d / "stt.json") or {}).get("segments") or []
    clip = raw.get("clip") or {}
    lang = (raw.get("language_code") or "und")
    turns = []
    for g in segs:
        text = (g.get("text") or "").strip()
        if not text:
            continue
        sp = _label(g.get("speaker_id", g.get("speaker")))
        nt, nl = (None, None)
        if english_source.startswith("mt:"):
            nt, nl = _native_span(g, native, lang)
        turns.append(Turn(idx=len(turns), t0_ms=int(g["t0_ms"]), t1_ms=int(g["t1_ms"]), speaker=sp if sp is not None else "?",
                          text=text, lang=(g.get("lang") or lang).split("-")[0], native_text=nt, native_lang=nl))
    if not turns:
        raise ValueError(f"{uid}: transcript has no non-empty segments")
    t0 = int(clip.get("t0_ms") or turns[0].t0_ms)
    t1 = int(clip.get("t1_ms") or turns[-1].t1_ms)
    meta = _read(d / "meta.json") or {}
    role_doc = _read(d / "role.json") if use_role_track else None
    c = Consult(uid=uid, turns=turns, clip_t0_ms=t0, clip_t1_ms=t1, language_code=lang, english_source=english_source,
                diarised=any(t.speaker != "?" for t in turns), room=meta.get("room") or clip.get("room_slug") or "unknown",
                meta=meta, signed=_read(d / "signed.json"))
    if valid_role_doc(role_doc):
        join_roles(turns, role_doc)
        c.role_track, c.role_flags = True, parse_role_flags(role_doc)
    return c


IST = timezone(timedelta(hours=5, minutes=30))
_IST_FORMATS = ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S")


def _ist_ms(s: str) -> int:
    """Cutter index span_start / span_end (IST wall-clock string) -> UTC ms. Mirrors kit_reb_sarvam_lane.py:144-145."""
    for fmt in _IST_FORMATS:
        try:
            return int(datetime.strptime(s, fmt).replace(tzinfo=IST).timestamp() * 1000)
        except ValueError:
            continue
    raise ValueError("unparseable cutter span time")


def track_sha256(track: dict) -> str:
    return hashlib.sha256(json.dumps(track, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def bundle_window(bundle: dict) -> tuple[int, int, str | None]:
    """(clip t0 ms UTC, clip t1 ms UTC, room) from the bundle, the way kit_reb_export_consult_audit.py does.

    cutter: window_cutter(row) (lines 140-145) = _ist_ms(span_start/span_end); room = row.room_id or the scope's room dir (export() "doctor, room = ...").
    caa: the consult manifest's t0_ms/t1_ms (the CAA csv's t0_utc_ms/t1_utc_ms are matched against these in pick_caa_row); room = the scope's room dir.
    Raises ValueError when the window cannot be derived.
    """
    parts = str(bundle.get("scope_path") or "").split("/")
    room_dir = parts[1] if len(parts) >= 2 and parts[1] else None
    if bundle.get("source") == "cutter":
        row = bundle.get("cutter_row")
        if not isinstance(row, dict):
            raise ValueError("cutter bundle has no cutter_row")
        try:
            t0, t1 = _ist_ms(row["span_start"]), _ist_ms(row["span_end"])
        except (KeyError, TypeError) as e:
            raise ValueError("cutter_row has no usable span") from e
        return t0, t1, row.get("room_id") or room_dir
    m = bundle.get("manifest") if isinstance(bundle.get("manifest"), dict) else {}
    try:
        t0, t1 = int(m["t0_ms"]), int(m["t1_ms"])
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError("manifest has no usable t0_ms/t1_ms") from e
    return t0, t1, room_dir


EPOCH_MS_MIN = 10**12  # a t0_ms at or above this is epoch ms (2001-09 onwards); a clip-relative ms never gets near it
CLOCK_COUNT_KEYS = ("segments_absolute", "segments_relative", "dropped_outside_clip", "malformed_dropped")


def _manifest_window(bundle: dict) -> tuple[int, int] | None:
    """manifest t0_ms/t1_ms (consult.flac audio start/end, epoch ms); None when absent or not a forward span."""
    m = bundle.get("manifest") if isinstance(bundle.get("manifest"), dict) else {}
    try:
        a, b = int(m["t0_ms"]), int(m["t1_ms"])
    except (KeyError, TypeError, ValueError):
        return None
    return (a, b) if b >= a else None


def _shift(segs: list, t0: int, dur: int, stats: dict | None = None, window: tuple[int, int] | None = None) -> list[dict]:
    """Move track segments to the absolute UTC ms the folder reader's transcripts use, so boundary.py / format_transcript see one axis.

    Consult-scope tracks carry EPOCH ms on the manifest clock (palimpsest read contract v0.2); legacy fixtures carry ms from clip start.
    A track is EPOCH if ANY usable segment has t0_ms >= EPOCH_MS_MIN (a clip-relative ms can never reach it), else RELATIVE (legacy).
    Inside an epoch track a segment with t0_ms or t1_ms below EPOCH_MS_MIN is malformed: dropped and counted in malformed_dropped, never
    read as relative. Clocks are never mixed in a track.
    Epoch track: clamp to `window` (the manifest t0_ms/t1_ms = the consult.flac audio span; default [t0, t0 + dur]), NOT the cutter span, which
    can start up to 60 s after the audio (pre-roll). A segment wholly outside the window is dropped and counted.
    Relative track: clamp the end to the clip (Sarvam can overrun by up to 0.56 s), then add clip_t0.
    `stats`, when given, is incremented in place (CLOCK_COUNT_KEYS); counts only."""
    st = stats if stats is not None else {}
    for k in CLOCK_COUNT_KEYS:
        st.setdefault(k, 0)
    w0, w1 = window if window else (t0, t0 + dur)
    out, usable = [], []
    for g in segs or []:
        if not isinstance(g, dict):
            continue
        try:
            usable.append((g, int(g["t0_ms"]), int(g["t1_ms"])))
        except (KeyError, TypeError, ValueError):
            continue
    absolute = any(a >= EPOCH_MS_MIN for _g, a, _b in usable)
    for g, a, b in usable:
        if absolute:
            if a < EPOCH_MS_MIN or b < EPOCH_MS_MIN:
                st["malformed_dropped"] += 1
                continue
            if b < w0 or a > w1:
                st["dropped_outside_clip"] += 1
                continue
            b = min(max(b, w0), w1)
            a = min(max(a, w0), b)
            st["segments_absolute"] += 1
            out.append({**g, "t0_ms": a, "t1_ms": b})
        else:
            b = min(b, dur)
            a = min(a, b)
            st["segments_relative"] += 1
            out.append({**g, "t0_ms": t0 + a, "t1_ms": t0 + b})
    out.sort(key=lambda g: (g["t0_ms"], g["t1_ms"]))
    return out


def _slot_track(slot) -> dict | None:
    tr = slot.get("track") if isinstance(slot, dict) else None
    return tr if isinstance(tr, dict) else None


def load_bundle(bundle: dict, english: str = "auto", use_role_track: bool = True) -> Consult:
    """Build the Consult that load_consult builds from folders, from one palimpsest consult bundle (kit/reb/consult_bundle.py).

    English = tracks.translate segments, native = tracks.stt segments, joined by _segments / _native_span. Roles = the first non-null of
    role_llm, role_judge, role_caa. parts, acoustics and diar_nemotron are not read.
    """
    uid = bundle.get("consult_uid")
    if not isinstance(uid, str) or not uid:
        raise ValueError("bundle has no consult_uid")
    tracks = bundle.get("tracks") if isinstance(bundle.get("tracks"), dict) else {}
    tr, st = _slot_track(tracks.get("translate")), _slot_track(tracks.get("stt"))
    if tr is None and st is None:
        raise ValueError(f"{uid}: bundle has no text layer")
    clip_t0, clip_t1, room = bundle_window(bundle)
    dur = max(0, clip_t1 - clip_t0)
    clock = dict.fromkeys(CLOCK_COUNT_KEYS, 0)
    win = _manifest_window(bundle)
    native = _shift((st or {}).get("segments"), clip_t0, dur, clock, win)
    eng = _shift((tr or {}).get("segments"), clip_t0, dur, clock, win)
    langs = Counter(str(g.get("lang")) for g in native if g.get("lang"))
    lang = langs.most_common(1)[0][0] if langs else "und"
    raw = {"consult_uid": uid, "language_code": lang, "english_segments": eng, "native_segments": native,
           "model_translate": (tracks.get("translate") or {}).get("engine") or (tr or {}).get("engine")}
    segs, english_source = _segments(raw, None, english)
    turns = []
    for g in segs:
        text = (g.get("text") or "").strip()
        if not text:
            continue
        sp = _label(g.get("speaker_id", g.get("speaker")))
        nt, nl = (None, None)
        if english_source.startswith("mt:"):
            nt, nl = _native_span(g, native, lang)
        turns.append(Turn(idx=len(turns), t0_ms=int(g["t0_ms"]), t1_ms=int(g["t1_ms"]), speaker=sp if sp is not None else "?",
                          text=text, lang=(g.get("lang") or lang).split("-")[0], native_text=nt, native_lang=nl))
    if not turns:
        raise ValueError(f"{uid}: bundle has no non-empty segments")
    c = Consult(uid=uid, turns=turns, clip_t0_ms=clip_t0, clip_t1_ms=clip_t1, language_code=lang, english_source=english_source,
                diarised=any(t.speaker != "?" for t in turns), room=room or "unknown", meta={"room": room} if room else {})
    c.clock_counts = clock
    used = []
    for name, slot in (("translate", tracks.get("translate")), ("stt", tracks.get("stt"))):
        if _slot_track(slot) is not None:
            used.append((name, slot))
    if use_role_track:
        for name in ROLE_SLOTS:
            slot = tracks.get(name)
            doc = _slot_track(slot)
            if doc is None:
                continue
            doc = {**doc, "engine": doc.get("engine") or slot.get("engine")}
            if isinstance(doc.get("segments"), list):
                doc["segments"] = _shift(doc["segments"], clip_t0, dur, clock, win)
            if valid_role_doc(doc):
                join_roles(turns, doc)
                c.role_track, c.role_flags = True, parse_role_flags(doc)
                used.append((name, slot))
            break  # the first non-null role slot is the one used; an invalid one is not skipped for the next
    c.inputs = [{"layer": n, "track_path": s.get("path"), "sha256": track_sha256(s["track"])} for n, s in used]
    return c


def list_consults(data_dir: Path) -> list[str]:
    return sorted(p.name for p in Path(data_dir).iterdir() if p.is_dir() and (p / "transcript.json").exists())


def format_transcript(c: Consult, quarantined: set[int] = frozenset()) -> str:
    """Stage A input. `T<i> [S<spk>|<role>] (mm:ss) text`; the role is shown only when it came from the role track."""
    out = []
    for t in c.turns:
        rel = max(0, (t.t0_ms - c.clip_t0_ms) // 1000)
        who = f"S{t.speaker}" + (f"|{t.role}" if t.role_source == "role_track" else "")
        q = " [QUARANTINED: possible other consult]" if t.idx in quarantined else ""
        if t.native_text:
            out.append(f"T{t.idx} [{who}] ({rel // 60:02d}:{rel % 60:02d}){q} NATIVE[{t.native_lang or c.lang}]: {t.native_text} | ENGLISH: {t.text}")
        else:
            out.append(f"T{t.idx} [{who}] ({rel // 60:02d}:{rel % 60:02d}){q} {t.text}")
    return "\n".join(out)
