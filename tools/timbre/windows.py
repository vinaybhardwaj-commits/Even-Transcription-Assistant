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


def _float_field(wid: str, name: str, raw: str) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError) as e:
        raise WindowsError(f"{wid}: {name} is not a number") from e
