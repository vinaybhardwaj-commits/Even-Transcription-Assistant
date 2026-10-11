"""Cut patient windows from a Nemotron probability timeline.

A window is a pure-patient span: the patient column dominates every kept frame
(the same mask as ``frame_patient_scores``). Spans are sliced to 3–15 s, and a
slice shorter than 3 s or with fewer than 3 pure seconds is dropped. The CSV
columns match the harness candidate windows
(``window_id,room,date,lang,phase,start_s,end_s,patient_speech_s,role``) plus
``diar_src=nemotron``.

Nothing is written when ``SlotDecision.status`` is not ``ok``. That is the
guard against a doctor or translator column being exported as the patient.

R2 is optional. ``--r2-key`` calls ``fetch_nlp_object`` (GetObject only) and
reads ``R2_ENDPOINT``, ``R2_ACCESS_KEY_ID``, ``R2_SECRET_ACCESS_KEY``. Tests
pass a fake client to ``load_probs_source`` and do not set those variables.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tools.timbre.nemotron_probs import (
    EXPECTED_WINDOW_S,
    NlpError,
    NlpLoad,
    fetch_nlp_object,
    load_nlp,
    load_probs_source,
)
from tools.timbre.purity import PurityError, frame_patient_scores
from tools.timbre.slots import SlotDecision, SlotError, map_slots
from tools.timbre.windows import WindowsError

# Same floors as PurityRule.min_pure_s and the batch-1 keep rule.
MIN_WINDOW_S = 3.0
MAX_WINDOW_S = 15.0
MIN_PURE_S = 3.0

WINDOWS_COLUMNS = (
    "window_id",
    "room",
    "date",
    "lang",
    "phase",
    "start_s",
    "end_s",
    "patient_speech_s",
    "role",
    "diar_src",
)


@dataclass(frozen=True)
class WindowBuild:
    rows: list[dict]
    decision: SlotDecision
    frame_ms: float
    n_windows: int
    pure_patient_s: float


def pure_spans(mask, max_gap_frames: int = 0) -> list[tuple[int, int]]:
    """Half-open runs of pure frames. ``max_gap_frames`` bridges that many non-pure frames (default: none)."""
    flag = np.asarray(mask, dtype=bool).reshape(-1)
    n = int(flag.size)
    gap = int(max_gap_frames)
    if gap < 0:
        raise WindowsError("max_gap_frames must be >= 0")
    spans: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if not flag[i]:
            i += 1
            continue
        j = i + 1
        while j < n:
            if flag[j]:
                j += 1
                continue
            if gap <= 0:
                break
            k = j
            while k < n and not flag[k] and (k - j) < gap:
                k += 1
            if k < n and flag[k] and (k - j) <= gap:
                j = k
                continue
            break
        spans.append((i, j))
        i = j
    return spans


def windows_from_mask(
    mask,
    *,
    frame_ms: float,
    clip_id: str,
    room: str,
    date: str,
    lang: str,
    phase: str,
    origin_s: float = 0.0,
    min_window_s: float = MIN_WINDOW_S,
    max_window_s: float = MAX_WINDOW_S,
    min_pure_s: float = MIN_PURE_S,
    max_gap_s: float = 0.0,
) -> list[dict]:
    """Turn a pure-patient mask into candidate-window rows. Times are seconds from ``origin_s``."""
    hop = float(frame_ms)
    if hop <= 0:
        raise WindowsError("frame_ms must be > 0")
    _check_bounds(min_window_s, max_window_s, min_pure_s)
    flag = np.asarray(mask, dtype=bool).reshape(-1)
    gap_frames = int(np.floor(float(max_gap_s) * 1000.0 / hop + 1e-9)) if max_gap_s > 0 else 0
    origin_ms = int(round(float(origin_s) * 1000.0))
    if origin_ms < 0:
        raise WindowsError("origin_s must be >= 0")
    rows: list[dict] = []
    seen: set[str] = set()
    max_frames = max(1, int(np.floor(float(max_window_s) * 1000.0 / hop + 1e-9)))
    for start, end in pure_spans(flag, gap_frames):
        cursor = start
        while cursor < end:
            stop = min(end, cursor + max_frames)
            dur_s = (stop - cursor) * hop / 1000.0
            pure_s = float(flag[cursor:stop].sum() * hop / 1000.0)
            if dur_s + 1e-6 < float(min_window_s) or pure_s + 1e-6 < float(min_pure_s):
                break
            start_ms = origin_ms + int(round(cursor * hop))
            end_ms = origin_ms + int(round(stop * hop))
            wid = _window_id(clip_id, start_ms)
            if wid in seen:
                raise WindowsError(f"duplicate window_id {wid}")
            seen.add(wid)
            rows.append(
                {
                    "window_id": wid,
                    "room": str(room),
                    "date": str(date),
                    "lang": str(lang),
                    "phase": str(phase),
                    "start_s": start_ms / 1000.0,
                    "end_s": end_ms / 1000.0,
                    "patient_speech_s": pure_s,
                    "role": "patient",
                    "diar_src": "nemotron",
                }
            )
            cursor = stop
    return rows


def build_patient_windows(
    probs,
    *,
    frame_ms: float,
    clip_id: str,
    room: str,
    date: str,
    lang: str,
    phase: str,
    decision: SlotDecision | None = None,
    origin_s: float = 0.0,
    min_window_s: float = MIN_WINDOW_S,
    max_window_s: float = MAX_WINDOW_S,
    min_pure_s: float = MIN_PURE_S,
    max_gap_s: float = 0.0,
    **slot_kwargs,
) -> WindowBuild:
    """Map slots (unless ``decision`` is passed) and cut windows. Ambiguous maps yield no rows."""
    if decision is None:
        decision = map_slots(probs, frame_ms=frame_ms, **slot_kwargs)
    if not decision.accepted:
        return WindowBuild(
            rows=[],
            decision=decision,
            frame_ms=float(frame_ms),
            n_windows=0,
            pure_patient_s=0.0,
        )
    scores = frame_patient_scores(probs, int(decision.patient_slot), doctor_slot=int(decision.doctor_slot))
    rows = windows_from_mask(
        scores["pure"],
        frame_ms=frame_ms,
        clip_id=clip_id,
        room=room,
        date=date,
        lang=lang,
        phase=phase,
        origin_s=origin_s,
        min_window_s=min_window_s,
        max_window_s=max_window_s,
        min_pure_s=min_pure_s,
        max_gap_s=max_gap_s,
    )
    pure_s = float(scores["pure"].sum() * float(frame_ms) / 1000.0)
    return WindowBuild(
        rows=rows,
        decision=decision,
        frame_ms=float(frame_ms),
        n_windows=len(rows),
        pure_patient_s=pure_s,
    )


def build_from_nlp(
    loaded: NlpLoad,
    *,
    clip_id: str,
    room: str,
    date: str,
    lang: str,
    phase: str,
    **kwargs,
) -> WindowBuild:
    """Cut windows using the resolved hop on ``loaded`` (10 ms when the header's 80 ms was wrong)."""
    return build_patient_windows(
        loaded.probs,
        frame_ms=loaded.frame_ms,
        clip_id=clip_id,
        room=room,
        date=date,
        lang=lang,
        phase=phase,
        **kwargs,
    )


def write_windows_csv(path: Path | str, rows: list[dict]) -> None:
    """Write the candidate-window CSV. The replace is atomic (``name.tmp`` then rename)."""
    dest = Path(path)
    tmp = dest.parent / (dest.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(WINDOWS_COLUMNS), lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _cell(key, row[key]) for key in WINDOWS_COLUMNS})
    os.replace(tmp, dest)


def main(argv: list[str] | None = None) -> int:
    """Operator entry. Exit 0 when the slot map is ok, 3 when it is ambiguous, 1 on a bad input.

    Ambiguous still writes a header-only CSV so the path exists and is empty of windows.
    """
    parser = argparse.ArgumentParser(description="Cut pure-patient Timbre windows from a Nemotron probability file.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--nlp", type=Path, help="local NLP1 file")
    source.add_argument("--r2-key", help="lab/nemotron-probs/*.nlp object key (GetObject only)")
    parser.add_argument("--duration-s", type=float, default=EXPECTED_WINDOW_S, help="known audio duration, default 900")
    parser.add_argument("--tol-s", type=float, default=5.0)
    parser.add_argument("--clip-id", required=True)
    parser.add_argument("--room", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--lang", default="")
    parser.add_argument("--phase", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--origin-s", type=float, default=0.0)
    parser.add_argument("--embeddings", type=Path, help="(speakers, dim) ECAPA .npy, one row per probability column")
    parser.add_argument("--frame-embeddings", type=Path, help="(frames, dim) ECAPA .npy, pooled over dominant frames")
    parser.add_argument("--centroid", type=Path, help="doctor centroid .npy")
    parser.add_argument("--eta-json", type=Path, help="ETA identity dict or list (synthetic ids only)")
    parser.add_argument("--turns-json", type=Path, help="[[start_ms, end_ms, spkN], ...] aligned onto columns")
    parser.add_argument("--doctor-slot", type=int)
    parser.add_argument("--patient-slot", type=int)
    parser.add_argument("--min-window-s", type=float, default=MIN_WINDOW_S)
    parser.add_argument("--max-window-s", type=float, default=MAX_WINDOW_S)
    parser.add_argument("--min-pure-s", type=float, default=MIN_PURE_S)
    parser.add_argument("--max-gap-s", type=float, default=0.0)
    args = parser.parse_args(argv)
    try:
        if args.r2_key:
            blob = fetch_nlp_object(args.r2_key)
            loaded = load_nlp(blob, expected_duration_s=args.duration_s, tol_s=args.tol_s)
        else:
            loaded = load_nlp(args.nlp, expected_duration_s=args.duration_s, tol_s=args.tol_s)
        kwargs = _slot_kwargs(args)
        build = build_from_nlp(
            loaded,
            clip_id=args.clip_id,
            room=args.room,
            date=args.date,
            lang=args.lang,
            phase=args.phase,
            origin_s=args.origin_s,
            min_window_s=args.min_window_s,
            max_window_s=args.max_window_s,
            min_pure_s=args.min_pure_s,
            max_gap_s=args.max_gap_s,
            **kwargs,
        )
        write_windows_csv(args.out, build.rows)
    except (NlpError, SlotError, PurityError, WindowsError, OSError, json.JSONDecodeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    dec = build.decision
    print(
        f"status={dec.status} reason={dec.reason} "
        f"doctor_slot={_fmt_slot(dec.doctor_slot)} patient_slot={_fmt_slot(dec.patient_slot)} "
        f"confidence={dec.confidence:.3f} windows={build.n_windows} "
        f"pure_patient_s={build.pure_patient_s:.3f} frame_ms={build.frame_ms:g}"
    )
    return 0 if dec.status == "ok" else 3


def _slot_kwargs(args) -> dict:
    kwargs: dict = {}
    if args.doctor_slot is not None:
        kwargs["doctor_slot"] = args.doctor_slot
    if args.patient_slot is not None:
        kwargs["patient_slot"] = args.patient_slot
    if args.embeddings is not None:
        kwargs["slot_embeddings"] = np.load(args.embeddings)
    if args.frame_embeddings is not None:
        kwargs["frame_embeddings"] = np.load(args.frame_embeddings)
    if args.centroid is not None:
        kwargs["doctor_centroid"] = np.load(args.centroid)
    if args.eta_json is not None:
        kwargs["eta_doctor"] = json.loads(args.eta_json.read_text(encoding="utf-8"))
    if args.turns_json is not None:
        kwargs["turns"] = json.loads(args.turns_json.read_text(encoding="utf-8"))
    return kwargs


def _check_bounds(min_window_s: float, max_window_s: float, min_pure_s: float) -> None:
    if float(min_window_s) <= 0 or float(max_window_s) < float(min_window_s):
        raise WindowsError("window length bounds must satisfy 0 < min <= max")
    if float(min_pure_s) <= 0 or float(min_pure_s) > float(max_window_s):
        raise WindowsError("min_pure_s must be in (0, max_window_s]")


def _window_id(clip_id: str, start_ms: int) -> str:
    clip = str(clip_id).strip()
    if not clip or clip in (".", "..") or "/" in clip or "\\" in clip or "\x00" in clip:
        raise WindowsError("clip_id is empty or contains a path separator")
    if start_ms < 0 or start_ms > 9_999_999:
        raise WindowsError("start_ms does not fit the 7-digit window id")
    wid = f"{clip}_p{start_ms:07d}"
    if "/" in wid or "\\" in wid:
        raise WindowsError("window_id contains a path separator")
    return wid


def _cell(key: str, value) -> str:
    if key in ("start_s", "end_s", "patient_speech_s"):
        return f"{float(value):.3f}"
    return "" if value is None else str(value)


def _fmt_slot(slot: int | None) -> str:
    return "" if slot is None else str(slot)


if __name__ == "__main__":
    raise SystemExit(main())


# Re-exported so a test can load a mocked R2 object and cut windows without a second import path.
__all__ = [
    "MIN_PURE_S",
    "MIN_WINDOW_S",
    "MAX_WINDOW_S",
    "WINDOWS_COLUMNS",
    "WindowBuild",
    "build_from_nlp",
    "build_patient_windows",
    "load_probs_source",
    "main",
    "pure_spans",
    "windows_from_mask",
    "write_windows_csv",
]
