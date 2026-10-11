"""Load a Timbre windows CSV and resolve ``<window_id>.wav`` / ``.flac``."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

REQUIRED = (
    "window_id",
    "room",
    "date",
    "lang",
    "phase",
    "start_s",
    "end_s",
    "patient_speech_s",
)
_CLIP = re.compile(r"^(?P<clip>.+)_p(?P<ms>\d{7})$")
_AUDIO_EXTS = (".wav", ".flac")


class WindowsError(ValueError):
    pass


@dataclass
class Window:
    window_id: str
    room: str
    date: str
    lang: str
    phase: str
    start_s: float
    end_s: float
    patient_speech_s: float
    role: str
    clip_id: str
    audio_path: Path | None
    meta: dict = field(default_factory=dict)

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s


def clip_id_of(window_id: str) -> str:
    """``window_id = <clip_id>_p<start_ms 7-digit>`` (PRD §5.3). Otherwise the id itself."""
    m = _CLIP.match(window_id)
    return m.group("clip") if m else window_id


def window_id_at(clip_id: str, start_ms: int) -> str:
    """``<clip_id>_p<start_ms zero-padded to 7 digits>``. The start must fit that width."""
    _check_clip_id(clip_id)
    if isinstance(start_ms, bool) or not isinstance(start_ms, int):
        raise WindowsError("start_ms must be an int")
    if start_ms < 0 or start_ms > 9_999_999:
        raise WindowsError("window start does not fit the 7-digit window id")
    wid = f"{clip_id}_p{start_ms:07d}"
    if clip_id_of(wid) != clip_id:
        raise WindowsError("clip_id does not round-trip through window_id")
    return wid


@dataclass
class Clip:
    """One consult (or other session) whose audio lives in R2, not on disk."""

    clip_id: str
    room: str
    date: str
    duration_s: float
    r2_key: str
    lang: str = ""
    phase: str = ""
    role: str = "patient"
    doctor_uid8: str = ""
    meta: dict = field(default_factory=dict)


def generate_windows(
    clip: Clip,
    *,
    window_s: float,
    hop_s: float,
    min_window_s: float | None = None,
    max_windows: int = 100_000,
) -> list[Window]:
    """Cut ``clip`` into windows on the harness id scheme.

    Starts and ends are whole milliseconds so a later load of the same clip
    produces the same ids. A tail shorter than ``min_window_s`` is left out.
    ``patient_speech_s`` is the window length until a purity score replaces it.
    """
    if window_s <= 0 or hop_s <= 0:
        raise WindowsError("window_s and hop_s must be > 0")
    min_s = window_s if min_window_s is None else min_window_s
    if min_s <= 0:
        raise WindowsError("min_window_s must be > 0")
    if max_windows < 1:
        raise WindowsError("max_windows must be >= 1")
    window_ms = _millis(window_s, "window_s")
    hop_ms = _millis(hop_s, "hop_s")
    min_ms = _millis(min_s, "min_window_s")
    if hop_ms < 1 or window_ms < 1 or min_ms < 1:
        raise WindowsError("window, hop, and min length must be at least 1 ms")
    duration_ms = _millis(clip.duration_s, "duration_s")
    rows: list[Window] = []
    start_ms = 0
    while start_ms + min_ms <= duration_ms:
        end_ms = min(start_ms + window_ms, duration_ms)
        if end_ms - start_ms < min_ms:
            break
        if len(rows) >= max_windows:
            raise WindowsError("window cap exceeded; increase the hop or the cap")
        start_s = start_ms / 1000.0
        end_s = end_ms / 1000.0
        meta = dict(clip.meta)
        meta["r2_key"] = clip.r2_key
        meta["doctor_uid8"] = clip.doctor_uid8
        rows.append(
            Window(
                window_id=window_id_at(clip.clip_id, start_ms),
                room=clip.room,
                date=clip.date,
                lang=clip.lang,
                phase=clip.phase,
                start_s=start_s,
                end_s=end_s,
                patient_speech_s=end_s - start_s,
                role=clip.role or "patient",
                clip_id=clip.clip_id,
                audio_path=None,
                meta=meta,
            )
        )
        start_ms += hop_ms
    return rows


CLIP_REQUIRED = ("clip_id", "room", "date", "r2_key", "duration_s")


def load_clips(csv_path: Path | str) -> list[Clip]:
    """Read a sessions/clips CSV. Audio is not opened here."""
    path = Path(csv_path)
    if not path.is_file():
        raise WindowsError(f"clips CSV not found: {path.name}")
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    missing = [c for c in CLIP_REQUIRED if c not in df.columns]
    if missing:
        raise WindowsError("clips CSV missing columns: " + ", ".join(missing))
    seen: set[str] = set()
    rows: list[Clip] = []
    known = set(CLIP_REQUIRED) | {"lang", "phase", "role", "doctor_uid8"}
    for rec in df.to_dict(orient="records"):
        clip_id = str(rec["clip_id"]).strip()
        _check_clip_id(clip_id)
        if clip_id in seen:
            raise WindowsError("duplicate clip_id")
        seen.add(clip_id)
        duration_s = _float_field(clip_id, "duration_s", rec["duration_s"])
        if duration_s <= 0:
            raise WindowsError("duration_s must be > 0")
        key = str(rec["r2_key"]).strip()
        if not key:
            raise WindowsError("r2_key is empty")
        role = str(rec["role"]).strip().lower() if str(rec.get("role", "")).strip() else "patient"
        meta = {k: rec[k] for k in rec if k not in known}
        rows.append(
            Clip(
                clip_id=clip_id,
                room=str(rec["room"]),
                date=str(rec["date"]),
                duration_s=duration_s,
                r2_key=key,
                lang=str(rec["lang"]) if "lang" in rec else "",
                phase=str(rec["phase"]) if "phase" in rec else "",
                role=role,
                doctor_uid8=str(rec["doctor_uid8"]).strip() if "doctor_uid8" in rec else "",
                meta=meta,
            )
        )
    return rows


def find_audio(audio_dir: Path | str, window_id: str) -> Path | None:
    root = Path(audio_dir)
    for ext in _AUDIO_EXTS:
        path = root / f"{window_id}{ext}"
        if path.is_file():
            return path
    return None


def load_windows(csv_path: Path | str, audio_dir: Path | str | None = None) -> list[Window]:
    """Read the windows CSV. Missing audio is recorded as ``audio_path is None``, not dropped.

    Extra columns are kept on ``Window.meta`` (and ``role`` is promoted when present).
    """
    path = Path(csv_path)
    if not path.is_file():
        raise WindowsError(f"windows CSV not found: {path.name}")
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise WindowsError("windows CSV missing columns: " + ", ".join(missing))
    seen: set[str] = set()
    rows: list[Window] = []
    for rec in df.to_dict(orient="records"):
        wid = str(rec["window_id"]).strip()
        _check_window_id(wid)
        if wid in seen:
            raise WindowsError(f"duplicate window_id {wid}")
        seen.add(wid)
        start_s = _float_field(wid, "start_s", rec["start_s"])
        end_s = _float_field(wid, "end_s", rec["end_s"])
        speech_s = _float_field(wid, "patient_speech_s", rec["patient_speech_s"])
        if end_s <= start_s:
            raise WindowsError(f"{wid}: end_s must be greater than start_s")
        if speech_s < 0:
            raise WindowsError(f"{wid}: patient_speech_s must be >= 0")
        role = str(rec["role"]).strip().lower() if "role" in rec and str(rec["role"]).strip() else "patient"
        meta = {k: rec[k] for k in rec if k not in REQUIRED and k != "role"}
        audio = find_audio(audio_dir, wid) if audio_dir is not None else None
        rows.append(
            Window(
                window_id=wid,
                room=str(rec["room"]),
                date=str(rec["date"]),
                lang=str(rec["lang"]),
                phase=str(rec["phase"]),
                start_s=start_s,
                end_s=end_s,
                patient_speech_s=speech_s,
                role=role,
                clip_id=clip_id_of(wid),
                audio_path=audio,
                meta=meta,
            )
        )
    return rows


def _check_window_id(wid: str) -> None:
    if not wid or wid in (".", "..") or "/" in wid or "\\" in wid or "\x00" in wid:
        raise WindowsError("window_id is empty or contains a path separator")


def _check_clip_id(clip_id: str) -> None:
    if not clip_id or clip_id in (".", "..") or "/" in clip_id or "\\" in clip_id or "\x00" in clip_id:
        raise WindowsError("clip_id is empty or contains a path separator")
    if _CLIP.match(clip_id):
        raise WindowsError("clip_id must not itself be a window id")


def _millis(seconds: float, name: str) -> int:
    try:
        value = float(seconds)
    except (TypeError, ValueError) as e:
        raise WindowsError(f"{name} is not a number") from e
    if value != value or value in (float("inf"), float("-inf")):
        raise WindowsError(f"{name} is not finite")
    return int(round(value * 1000.0))


def _float_field(wid: str, name: str, raw: str) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError) as e:
        raise WindowsError(f"{wid}: {name} is not a number") from e
