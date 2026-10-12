"""Per-speaker baseline deltas.

For each prosodic and dimensional feature:

* ``delta_self`` is a z-score against that patient's own earlier windows in the
  same consult (same ``clip_id``, strictly smaller ``start_s``). Needs at least
  two earlier finite values. Sample standard deviation (ddof=1).
* ``rel_doctor`` is ``(x - doctor_mean) / std_earlier`` when doctor rows for the
  same tape are present. The doctor mean is every doctor window on that clip,
  not only the earlier ones. Without a patient std the column is NaN.

``doctor_ref.py`` (``--doctor-ref``) is a different feature. It overwrites
``__rel_doctor`` on arousal, valence, dominance and on eGeMAPS F0, loudness and
rate with patient minus that window's doctor reference, and adds a ratio column
where the scale supports one. Every other ``__rel_doctor`` column stays the
z-score defined here. With ``--doctor-ref`` off, nothing in this module changes.

Doctor rows themselves are the reference and are not z-scored. Embeddings and
categorical probabilities are not z-scored.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

PROSODY_PREFIXES = ("egemaps_v02.v1__", "compare2016.v1__")
DIM_SUFFIXES = ("__arousal", "__valence", "__dominance")
MIN_EARLIER = 2
# Merger metadata and already-computed deltas share the model prefix. They are not features.
_SKIP_SUFFIXES = (
    "__embedding",
    "__status",
    "__reason",
    "__revision",
    "__vad",
    "__model_id",
    "__extractor_version",
    "__infer_s",
    "__audio_s",
    "__delta_self",
    "__rel_doctor",
    "__rel_doctor_ratio",
    "__rel_doctor_cosine",
)


def baseline_columns(columns) -> list[str]:
    out = []
    for c in columns:
        name = str(c)
        if name.endswith(_SKIP_SUFFIXES):
            continue
        if name.endswith(DIM_SUFFIXES) or name.startswith(PROSODY_PREFIXES):
            out.append(name)
    return out


def add_baselines(
    df: pd.DataFrame,
    feature_cols: list[str] | None = None,
    *,
    group_col: str = "clip_id",
    time_col: str = "start_s",
    role_col: str = "role",
    doctor: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Return a copy with ``{col}__delta_self`` and ``{col}__rel_doctor`` appended."""
    if df.empty:
        out = df.copy()
        cols = feature_cols if feature_cols is not None else []
        for c in cols:
            out[f"{c}__delta_self"] = []
            out[f"{c}__rel_doctor"] = []
        return out
    work = df.copy().reset_index(drop=True)
    if group_col not in work.columns:
        raise ValueError(f"missing {group_col}")
    if time_col not in work.columns:
        raise ValueError(f"missing {time_col}")
    if role_col not in work.columns:
        work[role_col] = "patient"
    cols = list(feature_cols) if feature_cols is not None else baseline_columns(work.columns)
    for c in cols:
        if c not in work.columns:
            work[c] = np.nan
    delta = {c: np.full(len(work), np.nan) for c in cols}
    rel = {c: np.full(len(work), np.nan) for c in cols}
    doctor_values = _doctor_means(work, doctor, cols, group_col, role_col)
    positions = {idx: i for i, idx in enumerate(work.index)}
    for clip, sub in work.groupby(group_col, sort=False):
        sub = sub.sort_values([time_col, "window_id"] if "window_id" in sub.columns else [time_col])
        patient = sub[sub[role_col].astype(str).str.lower() != "doctor"]
        p_index = list(patient.index)
        if cols:
            numeric = patient[cols].apply(lambda s: pd.to_numeric(s, errors="coerce"))
            values = numeric.to_numpy(dtype=np.float64)
        else:
            values = np.zeros((len(patient), 0))
        times = patient[time_col].to_numpy(dtype=np.float64)
        dmean = doctor_values.get(clip, {})
        for i, idx in enumerate(p_index):
            earlier = values[:i][times[:i] < times[i]] if i else values[:0]
            loc = positions[idx]
            for j, c in enumerate(cols):
                hist = earlier[:, j] if earlier.size else np.array([])
                hist = hist[np.isfinite(hist)]
                current = values[i, j]
                mu, sd, n = _mean_std(hist)
                if n >= MIN_EARLIER and math.isfinite(current) and sd is not None:
                    if sd == 0.0:
                        delta[c][loc] = 0.0 if current == mu else np.nan
                    else:
                        delta[c][loc] = (current - mu) / sd
                if c in dmean and n >= MIN_EARLIER and sd not in (None, 0.0) and math.isfinite(current):
                    rel[c][loc] = (current - dmean[c]) / sd
    for c in cols:
        work[f"{c}__delta_self"] = delta[c]
        work[f"{c}__rel_doctor"] = rel[c]
    return work


def _mean_std(hist: np.ndarray) -> tuple[float, float | None, int]:
    n = int(hist.size)
    if n == 0:
        return float("nan"), None, 0
    mu = float(np.mean(hist))
    if n < 2:
        return mu, None, n
    sd = float(np.std(hist, ddof=1))
    return mu, sd, n


def _doctor_means(work, doctor, cols, group_col, role_col) -> dict:
    frames = []
    if doctor is not None and len(doctor):
        d = doctor.copy()
        if role_col not in d.columns:
            d[role_col] = "doctor"
        frames.append(d)
    internal = work[work[role_col].astype(str).str.lower() == "doctor"]
    if len(internal):
        frames.append(internal)
    if not frames:
        return {}
    all_d = pd.concat(frames, ignore_index=True)
    out: dict = {}
    for clip, sub in all_d.groupby(group_col, sort=False):
        means = {}
        for c in cols:
            if c not in sub.columns:
                continue
            v = pd.to_numeric(sub[c], errors="coerce").to_numpy(dtype=np.float64)
            v = v[np.isfinite(v)]
            if v.size:
                means[c] = float(np.mean(v))
        out[clip] = means
    return out
