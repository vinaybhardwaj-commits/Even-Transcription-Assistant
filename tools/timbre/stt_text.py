"""Patient-speaker text from an operator export of Scribe STT.

This does not open the database. Production stores a window's words on `stt_turn`
cues (`payload.text`, `payload.start_ms`, `payload.end_ms`; see
`lib/room-access/readers/turns.ts`) and the diarizer's speaker type on
`DiarizeSpeaker.type` (`clinician|patient|attender|nurse|other`; see `lib/diarize.ts`).
`room_turn_speaker.role` is only `clinician` or `unattributed`. Unattributed is not
the patient. A row is patient text only when the diarize speaker type is `patient`,
or the turn's own role/type is `patient`, and neither source says `clinician`.

A whole-window `transcript_english` / `transcript_original` with no speaker split is
refused (`not_patient_attributed`). That string mixes every voice in the room.

Accepted file shapes, one window or many (JSON object, JSON array, or JSONL):

    {
      "window_id": "bw_example",
      "speakers": [{"idx": 0, "type": "clinician"}, {"idx": 1, "type": "patient"}],
      "turns": [
        {"speaker_idx": 1, "role": "unattributed", "start_ms": 0, "end_ms": 800,
         "text": "..."}
      ]
    }

`transcript_segments` and `segments` are accepted as the turn list. A cue-shaped
turn (`payload.text`) is accepted. Output text is the patient lines in start order,
joined by newlines, then PHI-masked.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from tools.timbre.phi_mask import MaskResult, mask_phi

_TURN_KEYS = ("turns", "transcript_segments", "segments")
_WHOLE_WINDOW_KEYS = ("transcript_english", "transcript_original", "english")


@dataclass(frozen=True)
class PatientText:
    window_id: str
    status: str
    text: str
    n_turns: int
    mask: MaskResult | None


def load_stt_windows(path: Path | str) -> list[dict]:
    """JSON object, JSON array, or JSONL. Does not interpret the contents."""
    raw = Path(path).read_text(encoding="utf-8")
    stripped = raw.strip()
    if not stripped:
        return []
    if stripped[0] in "[{":
        data = json.loads(stripped)
        if isinstance(data, dict):
            return [data]
        if isinstance(data, list):
            return [row for row in data if isinstance(row, dict)]
        raise ValueError("STT file must be an object, an array, or JSONL")
    rows = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        if isinstance(item, dict):
            rows.append(item)
    return rows


def patient_text_from_window(window: dict) -> PatientText:
    """One window object. `text` is masked when status is `ok`, and empty otherwise."""
    window_id = _window_id(window)
    turns = _turn_list(window)
    if turns is None:
        if _has_whole_window_text(window):
            return PatientText(window_id, "not_patient_attributed", "", 0, None)
        return PatientText(window_id, "no_turns", "", 0, None)
    by_idx = _speaker_types(window)
    chosen: list[tuple[int, str]] = []
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        if not _is_patient(turn, by_idx):
            continue
        text = _turn_text(turn)
        if not text or not text.strip():
            continue
        chosen.append((_start_ms(turn), text.strip()))
    if not chosen:
        return PatientText(window_id, "no_patient_speaker", "", 0, None)
    chosen.sort(key=lambda item: item[0])
    joined = "\n".join(text for _, text in chosen)
    masked = mask_phi(joined)
    return PatientText(window_id, "ok", masked.text, len(chosen), masked)


_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:|\-]{1,80}$")


def _window_id(window: dict) -> str:
    raw = None
    for key in ("window_id", "id"):
        val = window.get(key)
        if isinstance(val, str) and val.strip():
            raw = val.strip()
            break
    if raw is None and window.get("subject_type") == "bench_window" and isinstance(window.get("subject_id"), str):
        raw = window["subject_id"].strip()
    if raw is None:
        raise ValueError("STT window is missing window_id")
    if _SAFE_ID.fullmatch(raw) is None:
        raise ValueError("window_id is not a safe id")
    return raw


def _turn_list(window: dict) -> list | None:
    for key in _TURN_KEYS:
        val = window.get(key)
        if isinstance(val, list):
            return val
    return None


def _has_whole_window_text(window: dict) -> bool:
    for key in _WHOLE_WINDOW_KEYS:
        val = window.get(key)
        if isinstance(val, str) and val.strip():
            return True
    return False


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


def _is_patient(turn: dict, by_idx: dict[int, str]) -> bool:
    typ = _explicit_type(turn)
    idx = _speaker_idx(turn)
    if typ is None and idx is not None and idx in by_idx:
        typ = by_idx[idx]
    role = _norm(turn.get("role"))
    if role == "clinician" or typ == "clinician":
        return False
    return typ == "patient" or role == "patient"


def _explicit_type(turn: dict) -> str | None:
    for key in ("speaker_type", "type"):
        val = turn.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip().lower()
    return None


def _speaker_idx(turn: dict) -> int | None:
    raw = turn.get("speaker_idx")
    if raw is None and isinstance(turn.get("speaker"), dict):
        raw = turn["speaker"].get("idx", turn["speaker"].get("speaker_idx"))
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _turn_text(turn: dict) -> str | None:
    val = turn.get("text")
    if isinstance(val, str):
        return val
    payload = turn.get("payload")
    if isinstance(payload, dict) and isinstance(payload.get("text"), str):
        return payload["text"]
    return None


def _start_ms(turn: dict) -> int:
    raw = turn.get("start_ms")
    if raw is None and isinstance(turn.get("payload"), dict):
        raw = turn["payload"].get("start_ms")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 2**62


def _norm(val: object) -> str | None:
    if isinstance(val, str) and val.strip():
        return val.strip().lower()
    return None
