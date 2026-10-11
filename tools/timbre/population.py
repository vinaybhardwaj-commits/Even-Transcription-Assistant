"""Aggregates-only population report.

Groups are ``room`` × ``doctor_uid8`` × day. Cells smaller than ``min_group_n``
are counted and omitted, so a single consult cannot be read back out of the
report. Window ids, clip ids, object keys, and audio are not written.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Columns that identify a window, a clip, or an object. Never aggregated as features.
_ID_COLUMNS = {
    "window_id",
    "clip_id",
    "r2_key",
    "audio_path",
    "transcript",
    "note",
    "reason",
    "model_id",
    "revision",
    "model_version",
}
_SKIP_SUFFIXES = (
    "__embedding",
    "__status",
    "__reason",
    "__revision",
    "__vad",
    "__model_id",
    "__extractor_version",
    "__infer_s",
    "__model_version",
    "__audio_s",
)


class PopulationError(ValueError):
    pass


def population_report(frame: pd.DataFrame, *, min_group_n: int = 5) -> dict:
    if min_group_n < 1:
        raise PopulationError("min_group_n must be >= 1")
    if frame is None or len(frame) == 0:
        return {
            "privacy": "aggregates only; no window ids or audio",
            "min_group_n": int(min_group_n),
            "n": 0,
            "audio_hours": None,
            "overall_suppressed": False,
            "overall": {},
            "groups": [],
            "n_groups_suppressed": 0,
            "n_rows_suppressed": 0,
        }
    work = frame.copy()
    if "room" not in work.columns or "date" not in work.columns:
        raise PopulationError("features are missing room or date")
    if "doctor_uid8" not in work.columns:
        work["doctor_uid8"] = ""
    work["room"] = work["room"].fillna("").astype(str)
    work["date"] = work["date"].fillna("").astype(str)
    work["doctor_uid8"] = work["doctor_uid8"].fillna("").astype(str)
    features = feature_columns(work)
    # A population smaller than the cell floor is itself one cell. Publish the
    # count and withhold the distribution.
    population_ok = len(work) >= min_group_n
    audio_hours = None
    if population_ok and "audio_s" in work.columns:
        audio = pd.to_numeric(work["audio_s"], errors="coerce").to_numpy(dtype=np.float64)
        audio_hours = float(np.nansum(audio) / 3600.0)
    overall = {name: _dist(work[name]) for name in features} if population_ok else {}
    groups = []
    suppressed = 0
    suppressed_rows = 0
    keys = ["room", "doctor_uid8", "date"]
    for values, sub in work.groupby(keys, dropna=False, sort=False):
        room, doctor, day = (str(v) for v in values)
        n = int(len(sub))
        if n < min_group_n:
            suppressed += 1
            suppressed_rows += n
            continue
        groups.append(
            {
                "room": room,
                "doctor_uid8": doctor,
                "day": day,
                "n": n,
                "features": {name: _dist(sub[name]) for name in features},
            }
        )
    groups.sort(key=lambda g: (g["room"], g["doctor_uid8"], g["day"]))
    return {
        "privacy": "aggregates only; no window ids or audio",
        "min_group_n": int(min_group_n),
        "n": int(len(work)),
        "audio_hours": audio_hours,
        "overall_suppressed": not population_ok,
        "overall": overall,
        "groups": groups,
        "n_groups_suppressed": suppressed,
        "n_rows_suppressed": suppressed_rows,
    }


def feature_columns(frame: pd.DataFrame) -> list[str]:
    names = []
    for column in frame.columns:
        name = str(column)
        if name in _ID_COLUMNS or "__" not in name:
            continue
        if name.endswith(_SKIP_SUFFIXES):
            continue
        series = frame[column]
        if series.map(lambda v: isinstance(v, (list, dict, tuple))).any():
            continue
        numeric = pd.to_numeric(series, errors="coerce")
        if numeric.notna().any():
            names.append(name)
    return sorted(names)


def _dist(series) -> dict:
    values = pd.to_numeric(series, errors="coerce").to_numpy(dtype=np.float64)
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {"n_finite": 0, "mean": None, "std": None, "p10": None, "p50": None, "p90": None}
    std = float(np.std(finite, ddof=1)) if finite.size >= 2 else None
    return {
        "n_finite": int(finite.size),
        "mean": float(np.mean(finite)),
        "std": std,
        "p10": float(np.percentile(finite, 10)),
        "p50": float(np.percentile(finite, 50)),
        "p90": float(np.percentile(finite, 90)),
    }
