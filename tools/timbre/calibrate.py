"""Per-room and per-doctor robust centring, then an optional isotonic map.

Fit on gold batches 1 and 2 only. The displayed score is the calibrated column.
The raw model column is left in place.

For each row the centre is the room median and IQR when that room has at least
``min_n`` finite gold scores, else the doctor's, else the global (pooled)
centre. The level that was applied is written beside the score (``room``,
``doctor``, or ``global``). A coarser level means the finer cell was below
``min_n``.

Centred value is ``(x - median) / max(iqr, iqr_floor)``. When ``isotonic`` is
present it maps that centred value onto the 1–5 rater scale. The JSON stores
aggregates only: no window ids, no audio, no label rows.

Timbre v1 targets:

* Odyssey arousal: ``odyssey_wavlm_dim.v1__arousal`` against gold ``arousal``
* Clef valence: ``clef_omni_valence.v1__valence`` against gold ``valence``

::

    python -m tools.timbre.calibrate fit \\
        --scores results/features.parquet \\
        --labels gold.csv \\
        --score-col odyssey_wavlm_dim.v1__arousal \\
        --gold-col arousal \\
        --out results/odyssey_arousal.calib.json

    python -m tools.timbre.calibrate fit \\
        --scores results/features.parquet \\
        --labels gold.csv \\
        --score-col clef_omni_valence.v1__valence \\
        --gold-col valence \\
        --out results/clef_valence.calib.json

    python -m tools.timbre.calibrate apply \\
        --scores results/features.parquet \\
        --calibration results/clef_valence.calib.json \\
        --out results/features.calibrated.parquet

Gold CSV columns: ``window_id``, ``batch`` (1 or 2), ``room``, ``doctor_uid8``,
and the rater column. ``not_patient``, ``unusable``, and ``is_repeat`` rows are
dropped when those columns exist. Do not commit the gold file or the fitted JSON
if it would leave this machine.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

CALIB_VERSION = "timbre-calib-v1"
DEFAULT_MIN_N = 8
IQR_FLOOR = 1e-3
GOLD_BATCHES = (1, 2)

ODYSSEY_AROUSAL_COL = "odyssey_wavlm_dim.v1__arousal"
CLEF_VALENCE_COL = "clef_omni_valence.v1__valence"
TARGETS = (
    (ODYSSEY_AROUSAL_COL, "arousal"),
    (CLEF_VALENCE_COL, "valence"),
)

_TRUE = {"1", "true", "yes", "y", "t"}


class CalibError(ValueError):
    pass


def robust_stats(values) -> dict:
    v = np.asarray(values, dtype=np.float64).reshape(-1)
    v = v[np.isfinite(v)]
    if v.size == 0:
        raise CalibError("no finite scores")
    q1, q3 = np.percentile(v, [25, 75])
    return {
        "median": float(np.median(v)),
        "iqr": float(q3 - q1),
        "n": int(v.size),
        "q1": float(q1),
        "q3": float(q3),
    }


def centre_value(raw: float, stats: dict, iqr_floor: float) -> float:
    iqr = float(stats["iqr"])
    scale = iqr if iqr > float(iqr_floor) else float(iqr_floor)
    return (float(raw) - float(stats["median"])) / scale


def select_centre(room: str, doctor: str, calib: dict) -> tuple[dict, str]:
    """Room, else doctor, else global. The returned level is the map applied."""
    min_n = int(calib["min_n"])
    room_stats = calib["rooms"].get(room) if room else None
    if room_stats and int(room_stats["n"]) >= min_n:
        return room_stats, "room"
    doc_stats = calib["doctors"].get(doctor) if doctor else None
    if doc_stats and int(doc_stats["n"]) >= min_n:
        return doc_stats, "doctor"
    return calib["global"], "global"


def _clean_id(value) -> str:
    if value is None:
        return ""
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    if text.lower() in {"", "nan", "none"}:
        return ""
    return text


def _truthy(value) -> bool:
    return str(value).strip().lower() in _TRUE


def _as_frame(obj) -> pd.DataFrame:
    if isinstance(obj, pd.DataFrame):
        return obj.copy()
    path = Path(obj)
    if not path.is_file():
        raise CalibError(f"file not found: {path.name}")
    if path.suffix == ".parquet":
        return pd.read_parquet(path)
    return pd.read_csv(path)


def _prefer_label(df: pd.DataFrame, name: str) -> None:
    alt = f"{name}_label"
    if alt in df.columns:
        df[name] = df[alt]


def _join(scores: pd.DataFrame, labels: pd.DataFrame) -> pd.DataFrame:
    if "window_id" not in scores.columns or "window_id" not in labels.columns:
        raise CalibError("scores and labels need window_id")
    left = scores.copy()
    right = labels.copy()
    left["window_id"] = left["window_id"].map(_clean_id)
    right["window_id"] = right["window_id"].map(_clean_id)
    left = left.loc[left["window_id"] != ""]
    right = right.loc[right["window_id"] != ""]
    merged = left.merge(right, on="window_id", how="inner", suffixes=("", "_label"))
    if merged.empty:
        raise CalibError("no rows matched on window_id")
    for name in ("batch", "room", "doctor_uid8", "arousal", "valence", "is_repeat", "not_patient", "unusable"):
        _prefer_label(merged, name)
    return merged


def _drop_unusable(df: pd.DataFrame) -> pd.DataFrame:
    out = df
    for col in ("not_patient", "unusable", "is_repeat"):
        if col in out.columns:
            out = out.loc[~out[col].map(_truthy)]
    return out


def _fit_isotonic(x: np.ndarray, y: np.ndarray) -> dict:
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    y = np.asarray(y, dtype=np.float64).reshape(-1)
    if np.unique(np.round(x, 8)).size < 2 or np.unique(np.round(y, 8)).size < 2:
        level = float(np.median(y))
        level = min(5.0, max(1.0, level))
        x0 = float(np.min(x))
        return {"x": [x0, x0 + 1.0], "y": [level, level], "increasing": True}
    from sklearn.isotonic import IsotonicRegression

    iso = IsotonicRegression(y_min=1.0, y_max=5.0, increasing="auto", out_of_bounds="clip")
    iso.fit(x, y)
    xs = np.asarray(iso.X_thresholds_, dtype=np.float64).reshape(-1)
    ys = np.asarray(iso.y_thresholds_, dtype=np.float64).reshape(-1)
    order = np.argsort(xs, kind="mergesort")
    xs = xs[order]
    ys = ys[order]
    keep = np.ones(xs.shape, dtype=bool)
    keep[1:] = xs[1:] > xs[:-1]
    return {
        "x": [float(v) for v in xs[keep]],
        "y": [float(v) for v in ys[keep]],
        "increasing": bool(iso.increasing_),
    }


def apply_isotonic(values, blob: dict | None) -> np.ndarray:
    arr = np.asarray(values, dtype=np.float64).reshape(-1)
    if not blob:
        return arr
    xs = np.asarray(blob["x"], dtype=np.float64)
    ys = np.asarray(blob["y"], dtype=np.float64)
    return np.interp(arr, xs, ys)


def _group_stats(df: pd.DataFrame, column: str) -> dict:
    if column not in df.columns:
        return {}
    ids = df[column].map(_clean_id)
    out = {}
    for key in sorted(set(ids)):
        if not key:
            continue
        out[key] = robust_stats(df.loc[ids.eq(key), "_raw"].to_numpy())
    return out


def fit_calibration(
    scores,
    labels,
    *,
    score_col: str,
    gold_col: str,
    min_n: int = DEFAULT_MIN_N,
    isotonic: bool = True,
    batches: tuple[int, ...] = GOLD_BATCHES,
    iqr_floor: float = IQR_FLOOR,
) -> dict:
    """Fit centres and an optional isotonic map on gold batches 1 and 2."""
    if int(min_n) < 1:
        raise CalibError("min_n must be >= 1")
    merged = _drop_unusable(_join(_as_frame(scores), _as_frame(labels)))
    merged = merged.drop_duplicates("window_id", keep="first")
    if "batch" not in merged.columns:
        raise CalibError("labels need a batch column; calibration is fit on batches 1 and 2 only")
    if "room" not in merged.columns:
        raise CalibError("calibration needs a room column")
    if score_col not in merged.columns:
        raise CalibError(f"missing score column {score_col}")
    if gold_col not in merged.columns:
        raise CalibError(f"missing gold column {gold_col}")
    batch = pd.to_numeric(merged["batch"], errors="coerce")
    merged = merged.loc[batch.isin(list(batches))].copy()
    if merged.empty:
        raise CalibError("no rows in gold batches 1 and 2")
    raw_v = pd.to_numeric(merged[score_col], errors="coerce").to_numpy(dtype=np.float64)
    gold_v = pd.to_numeric(merged[gold_col], errors="coerce").to_numpy(dtype=np.float64)
    ok = np.isfinite(raw_v) & np.isfinite(gold_v)
    merged = merged.iloc[np.flatnonzero(ok)].copy()
    merged["_raw"] = raw_v[ok]
    merged["_gold"] = gold_v[ok]
    if len(merged) < 2:
        raise CalibError("need at least two finite gold rows in batches 1 and 2")
    rooms = _group_stats(merged, "room")
    doctors = _group_stats(merged, "doctor_uid8")
    global_stats = robust_stats(merged["_raw"].to_numpy())
    draft = {
        "min_n": int(min_n),
        "rooms": rooms,
        "doctors": doctors,
        "global": global_stats,
    }
    centred = np.empty(len(merged), dtype=np.float64)
    for i, (raw_v, room, doctor) in enumerate(
        zip(
            merged["_raw"].to_numpy(),
            merged["room"].map(_clean_id),
            merged["doctor_uid8"].map(_clean_id) if "doctor_uid8" in merged.columns else [""] * len(merged),
        )
    ):
        stats, _level = select_centre(room, doctor, draft)
        centred[i] = centre_value(float(raw_v), stats, iqr_floor)
    iso_blob = _fit_isotonic(centred, merged["_gold"].to_numpy()) if isotonic else None
    return {
        "version": CALIB_VERSION,
        "score_col": score_col,
        "gold_col": gold_col,
        "batches": [int(b) for b in batches],
        "min_n": int(min_n),
        "iqr_floor": float(iqr_floor),
        "centre": "(x - median) / max(iqr, iqr_floor)",
        "selection": "room if n>=min_n, else doctor_uid8 if n>=min_n, else global",
        "n_fit": int(len(merged)),
        "global": global_stats,
        "rooms": rooms,
        "doctors": doctors,
        "isotonic": iso_blob,
    }


def apply_calibration(scores, calib: dict, *, score_col: str | None = None) -> pd.DataFrame:
    """Add centred, calibrated, and calibration_level columns. Raw scores stay."""
    if calib.get("version") != CALIB_VERSION:
        raise CalibError("unsupported calibration version")
    frame = _as_frame(scores).reset_index(drop=True)
    col = score_col or calib.get("score_col")
    if not col or col not in frame.columns:
        raise CalibError(f"missing score column {col}")
    raw = pd.to_numeric(frame[col], errors="coerce").to_numpy(dtype=np.float64)
    centred = np.full(raw.shape, np.nan, dtype=np.float64)
    levels: list[str] = []
    floor = float(calib["iqr_floor"])
    rooms = frame["room"].map(_clean_id) if "room" in frame.columns else pd.Series([""] * len(frame))
    if "doctor_uid8" in frame.columns:
        doctors = frame["doctor_uid8"].map(_clean_id)
    else:
        doctors = pd.Series([""] * len(frame))
    for i, (room, doctor) in enumerate(zip(rooms, doctors)):
        stats, level = select_centre(room, doctor, calib)
        levels.append(level)
        if np.isfinite(raw[i]):
            centred[i] = centre_value(float(raw[i]), stats, floor)
    if calib.get("isotonic"):
        mapped = np.full(raw.shape, np.nan, dtype=np.float64)
        finite = np.isfinite(centred)
        if finite.any():
            mapped[finite] = apply_isotonic(centred[finite], calib["isotonic"])
    else:
        mapped = centred.copy()
    out = frame.copy()
    out[f"{col}__centred"] = centred
    out[f"{col}__calibrated"] = mapped
    out[f"{col}__calibration_level"] = levels
    return out


def save_calibration(payload: dict, path: Path | str) -> None:
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, dest)


def load_calibration(path: Path | str) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != CALIB_VERSION:
        raise CalibError("unsupported calibration version")
    return payload


def _write_table(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    if path.suffix == ".csv":
        df.to_csv(tmp, index=False)
    else:
        df.to_parquet(tmp, index=False)
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m tools.timbre.calibrate")
    sub = parser.add_subparsers(dest="cmd", required=True)
    fit = sub.add_parser("fit", help="fit a room/doctor map on gold batches 1 and 2")
    fit.add_argument("--scores", required=True)
    fit.add_argument("--labels", required=True)
    fit.add_argument("--score-col", required=True)
    fit.add_argument("--gold-col", required=True)
    fit.add_argument("--out", required=True)
    fit.add_argument("--min-n", type=int, default=DEFAULT_MIN_N)
    fit.add_argument("--no-isotonic", action="store_true")
    fit.add_argument("--batches", default="1,2")
    apply_p = sub.add_parser("apply", help="apply a saved map; raw scores are kept")
    apply_p.add_argument("--scores", required=True)
    apply_p.add_argument("--calibration", required=True)
    apply_p.add_argument("--out", required=True)
    apply_p.add_argument("--score-col", default=None)
    args = parser.parse_args(argv)
    try:
        if args.cmd == "fit":
            batches = tuple(int(part) for part in str(args.batches).split(",") if part.strip())
            payload = fit_calibration(
                args.scores,
                args.labels,
                score_col=args.score_col,
                gold_col=args.gold_col,
                min_n=args.min_n,
                isotonic=not args.no_isotonic,
                batches=batches or GOLD_BATCHES,
            )
            save_calibration(payload, args.out)
            iso = "yes" if payload.get("isotonic") else "no"
            print(
                f"wrote {args.out} n_fit={payload['n_fit']} rooms={len(payload['rooms'])} "
                f"doctors={len(payload['doctors'])} isotonic={iso}"
            )
            return
        calib = load_calibration(args.calibration)
        frame = apply_calibration(args.scores, calib, score_col=args.score_col)
        _write_table(frame, Path(args.out))
        print(f"wrote {args.out} rows={len(frame)} score_col={calib['score_col']}")
    except CalibError as exc:
        raise SystemExit(f"calibrate: {exc}") from None


if __name__ == "__main__":
    main()
