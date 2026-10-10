"""CLI: extract Timbre features for a windows CSV.

    python -m tools.timbre.run --windows windows.csv --audio-dir DIR --out results/ \\
        [--models all|list] [--device cpu|cuda]

One parquet per model, a merged ``features.parquet`` (raw columns plus baseline
deltas), and ``manifest.json``. Re-running skips windows whose status is
``ok`` or ``nan``. ``error`` rows are retried. Writes are atomic.
"""

from __future__ import annotations

import json
import os
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

from tools.timbre import HARNESS_VERSION
from tools.timbre.audio import read_audio
from tools.timbre.baseline import add_baselines, baseline_columns
from tools.timbre.catalog import SPECS, resolve_model_names
from tools.timbre.windows import Window, load_windows

DONE = {"ok", "nan"}
META_COLS = (
    "window_id",
    "clip_id",
    "room",
    "date",
    "lang",
    "phase",
    "start_s",
    "end_s",
    "patient_speech_s",
    "role",
)


def run(
    windows_csv: Path | str,
    audio_dir: Path | str,
    out_dir: Path | str,
    models: str = "all",
    device: str = "cpu",
    extractors: dict | None = None,
) -> dict:
    names = resolve_model_names(models)
    windows = load_windows(windows_csv, audio_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "harness": "timbre",
        "harness_version": HARNESS_VERSION,
        "device": device,
        "windows_file": Path(windows_csv).name,
        "n_windows": len(windows),
        "models": {},
    }
    built = extractors or {}
    for name in names:
        ext = built.get(name)
        if ext is None:
            from tools.timbre.extractors.base import build_extractor

            ext = build_extractor(name, device)
        try:
            manifest["models"][name] = _run_model(name, ext, windows, out)
        finally:
            close = getattr(ext, "close", None)
            if close is not None and extractors is None:
                close()
        _write_json(out / "manifest.json", manifest)
    merged = _merge(out, names)
    if len(merged):
        merged = add_baselines(merged, baseline_columns(merged.columns))
    _write_parquet(merged, out / "features.parquet")
    manifest["merged_rows"] = int(len(merged))
    manifest["merged_cols"] = int(len(merged.columns))
    _write_json(out / "manifest.json", manifest)
    return manifest


def _run_model(name: str, extractor, windows: list[Window], out: Path) -> dict:
    path = out / f"{name}.parquet"
    done, previous = _completed(path)
    records = list(previous)
    infer_s = 0.0
    audio_s = 0.0
    errors = []
    for window in windows:
        if window.window_id in done:
            continue
        row = _one_window(extractor, window)
        records = [r for r in records if r.get("window_id") != window.window_id]
        records.append(row)
        status = row.get("status")
        if status in DONE:
            done.add(window.window_id)
        else:
            errors.append({"window_id": window.window_id, "reason": row.get("reason")})
        _write_parquet(pd.DataFrame(records), path)
    for row in records:
        if row.get("status") == "ok":
            infer_s += float(row.get("infer_s") or 0.0)
            audio_s += float(row.get("audio_s") or 0.0)
    spec = extractor.spec
    return {
        "model_id": spec.model_id,
        "extractor_version": spec.extractor_version,
        "kind": spec.kind,
        "licence": spec.licence,
        "revision": getattr(extractor, "revision", None),
        "completed": sorted(done),
        "errors": errors,
        "infer_s_ok": infer_s,
        "audio_s_ok": audio_s,
        "s_per_audio_s": (infer_s / audio_s) if audio_s else None,
    }


def _one_window(extractor, window: Window) -> dict:
    base = _meta(window)
    if window.audio_path is None:
        result = _failed(extractor, "audio_missing", 0.0)
    else:
        try:
            audio, sr = read_audio(window.audio_path)
            result = extractor.extract(audio, sr)
        except Exception as e:
            result = _failed(extractor, f"{type(e).__name__}: {e}"[:240], 0.0)
    return {**base, **_flatten(result)}


def _flatten(result: dict) -> dict:
    name = result["model_name"]
    row = {
        "status": result["status"],
        "reason": result.get("reason"),
        "infer_s": result.get("infer_s"),
        "audio_s": result.get("audio_s"),
        "revision": result.get("revision"),
        "vad": result.get("vad"),
        "model_id": result.get("model_id"),
        "extractor_version": result.get("extractor_version"),
    }
    for key, value in (result.get("features") or {}).items():
        row[f"{name}__{key}"] = value
    emb = result.get("embedding")
    row[f"{name}__embedding"] = None if emb is None else [float(v) for v in np.asarray(emb).reshape(-1)]
    return row


def _failed(extractor, reason: str, audio_s: float) -> dict:
    return {
        "model_name": extractor.spec.name,
        "model_id": extractor.spec.model_id,
        "model_version": extractor.spec.model_id,
        "extractor_version": extractor.spec.extractor_version,
        "revision": getattr(extractor, "revision", None),
        "kind": extractor.spec.kind,
        "status": "error",
        "reason": reason,
        "audio_s": audio_s,
        "infer_s": 0.0,
        "vad": None,
        "features": {},
        "embedding": None,
    }


def _meta(window: Window) -> dict:
    row = {
        "window_id": window.window_id,
        "clip_id": window.clip_id,
        "room": window.room,
        "date": window.date,
        "lang": window.lang,
        "phase": window.phase,
        "start_s": window.start_s,
        "end_s": window.end_s,
        "patient_speech_s": window.patient_speech_s,
        "role": window.role,
    }
    for key, value in window.meta.items():
        if key not in row:
            row[key] = value
    return row


def _completed(path: Path) -> tuple[set[str], list[dict]]:
    if not path.is_file():
        return set(), []
    try:
        df = pd.read_parquet(path)
    except Exception:
        bad = path.with_suffix(path.suffix + ".corrupt")
        os.replace(path, bad)
        return set(), []
    records = df.to_dict(orient="records")
    done = {str(r["window_id"]) for r in records if r.get("status") in DONE}
    kept = [r for r in records if r.get("status") in DONE]
    return done, kept


def _merge(out: Path, names: list[str]) -> pd.DataFrame:
    frames = []
    for name in names:
        path = out / f"{name}.parquet"
        if not path.is_file():
            continue
        df = pd.read_parquet(path)
        rename = {
            "status": f"{name}__status",
            "reason": f"{name}__reason",
            "infer_s": f"{name}__infer_s",
            "revision": f"{name}__revision",
            "vad": f"{name}__vad",
            "model_id": f"{name}__model_id",
            "extractor_version": f"{name}__extractor_version",
        }
        df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})
        if "audio_s" in df.columns and frames:
            df = df.drop(columns=["audio_s"])
        frames.append(df)
    if not frames:
        return pd.DataFrame()
    merged = frames[0]
    for df in frames[1:]:
        drop = [c for c in META_COLS if c != "window_id" and c in df.columns]
        merged = merged.merge(df.drop(columns=drop, errors="ignore"), on="window_id", how="outer")
    return merged


def _write_parquet(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, path)


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, default=_json_default), encoding="utf-8")
    os.replace(tmp, path)


def _json_default(obj):
    if isinstance(obj, float) and obj != obj:
        return None
    if isinstance(obj, (np.floating,)):
        val = float(obj)
        return None if val != val else val
    raise TypeError(type(obj).__name__)


def main(argv: list[str] | None = None) -> None:
    import argparse

    p = argparse.ArgumentParser(prog="python -m tools.timbre.run")
    p.add_argument("--windows", required=True)
    p.add_argument("--audio-dir", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--models", default="all", help="all, or a comma-separated list of model names")
    p.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    args = p.parse_args(argv)
    if args.models.strip() == "list":
        for spec in SPECS:
            print(f"{spec.name}\t{spec.model_id}\t{spec.kind}")
        return
    try:
        manifest = run(args.windows, args.audio_dir, args.out, models=args.models, device=args.device)
    except Exception:
        traceback.print_exc()
        raise
    print(f"wrote {args.out} models={len(manifest['models'])} windows={manifest['n_windows']}")


if __name__ == "__main__":
    main()
