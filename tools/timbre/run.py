"""CLI: extract Timbre features for a windows CSV.

    python -m tools.timbre.run --windows windows.csv --audio-dir DIR --out results/ \\
        [--models all|list] [--device cpu|cuda]

One parquet per model, a merged ``features.parquet`` (raw columns plus baseline
deltas), and ``manifest.json``. Re-running skips windows whose status is
``ok`` or ``nan``. ``error`` rows are retried. A model that does not fit in
RAM is skipped, with the reason logged, and the other models still run.
Writes are atomic.

``--doctor-ref`` also scores the nearest doctor speech on the same clip and
writes patient-minus-doctor columns. See ``doctor_ref.py``.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

from tools.timbre import HARNESS_VERSION
from tools.timbre.audio import read_audio
from tools.timbre.baseline import add_baselines, baseline_columns
from tools.timbre.catalog import SPEC_BY_NAME, SPECS, resolve_model_names
from tools.timbre.doctor_ref import (
    DoctorRefError,
    DoctorRefSettings,
    extract_doctor_references,
    prepare_plans,
    write_relative_columns,
)
from tools.timbre.mem import InsufficientMemory, mem_available_gb
from tools.timbre.windows import Window, load_windows

log = logging.getLogger("tools.timbre.run")

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
    doctor_ref: DoctorRefSettings | None = None,
) -> dict:
    names = resolve_model_names(models)
    windows = load_windows(windows_csv, audio_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    plans = prepare_plans(windows, doctor_ref) if doctor_ref is not None else None
    manifest = {
        "harness": "timbre",
        "harness_version": HARNESS_VERSION,
        "device": device,
        "windows_file": Path(windows_csv).name,
        "n_windows": len(windows),
        "models": {},
    }
    if doctor_ref is not None:
        manifest["doctor_ref"] = {
            "budget_s": doctor_ref.budget_s,
            "horizon_s": doctor_ref.horizon_s,
            "n_windows": len(windows),
            "n_with_spans": int(sum(1 for p in plans or [] if p.spans)),
        }
    built = extractors or {}
    doctor_extracts: dict[str, dict] = {}
    for name in names:
        spec = SPEC_BY_NAME[name]
        ext = built.get(name)
        try:
            if ext is None:
                reason = _ram_skip_reason(spec)
                if reason:
                    _log_skip(name, reason)
                    manifest["models"][name] = _skipped_model(spec, reason)
                else:
                    from tools.timbre.extractors.base import build_extractor

                    ext = build_extractor(name, device)
                    manifest["models"][name] = _run_model(name, ext, windows, out)
            else:
                manifest["models"][name] = _run_model(name, ext, windows, out)
            if plans is not None and doctor_ref is not None and ext is not None and not manifest["models"][name].get("skipped"):
                by_window, stats = extract_doctor_references(ext, plans, doctor_ref)
                doctor_extracts[name] = by_window
                manifest["models"][name]["doctor_ref"] = stats
        except InsufficientMemory as e:
            _log_skip(name, str(e))
            manifest["models"][name] = _skipped_model(spec, str(e))
        finally:
            close = getattr(ext, "close", None)
            if close is not None and extractors is None:
                close()
        _write_json(out / "manifest.json", manifest)
    merged = _merge(out, names, windows)
    if len(merged):
        merged = add_baselines(merged, baseline_columns(merged.columns))
    if plans is not None and len(merged):
        merged = write_relative_columns(merged, plans, doctor_extracts)
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
        except InsufficientMemory:
            raise
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


def _ram_skip_reason(spec) -> str | None:
    have = mem_available_gb()
    if have < spec.ram_gb:
        return f"{spec.name}: need about {spec.ram_gb:.1f} GB available RAM, have {have:.1f} GB"
    return None


def _log_skip(name: str, reason: str) -> None:
    log.warning("skip %s: %s", name, reason)
    print(f"skip {name}: {reason}", file=sys.stderr)


def _skipped_model(spec, reason: str) -> dict:
    return {
        "model_id": spec.model_id,
        "extractor_version": spec.extractor_version,
        "kind": spec.kind,
        "licence": spec.licence,
        "skipped": True,
        "reason": reason,
        "completed": [],
        "errors": [],
        "infer_s_ok": 0.0,
        "audio_s_ok": 0.0,
        "s_per_audio_s": None,
    }


def _merge(out: Path, names: list[str], windows: list[Window] | None = None) -> pd.DataFrame:
    """Join model columns on ``window_id`` only.

    Metadata comes from the windows table once. Extra CSV columns are not
    taken from each per-model parquet, so a second model cannot collide with
    the first on ``outcome`` / ``doctor_uid8`` / ``source_pack`` / ``diar_src``.
    """
    meta = pd.DataFrame([_meta(w) for w in windows]) if windows else pd.DataFrame(columns=["window_id"])
    audio = None
    frames = []
    for name in names:
        path = out / f"{name}.parquet"
        if not path.is_file():
            continue
        df = pd.read_parquet(path)
        if "window_id" not in df.columns:
            continue
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
        if audio is None and "audio_s" in df.columns and "audio_s" not in meta.columns:
            audio = df.loc[:, ["window_id", "audio_s"]]
        keep = [c for c in df.columns if c == "window_id" or str(c).startswith(f"{name}__")]
        frames.append(df.loc[:, keep])
    if not len(meta) and not frames:
        return pd.DataFrame()
    merged = meta
    if audio is not None and len(merged):
        merged = merged.merge(audio, on="window_id", how="left")
    elif audio is not None:
        merged = audio
    for df in frames:
        if not len(merged):
            merged = df
            continue
        merged = merged.merge(df, on="window_id", how="left")
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
    p.add_argument(
        "--doctor-ref",
        action="store_true",
        help="score each patient window against the nearest doctor speech on the same clip",
    )
    p.add_argument("--clip-audio-dir", default=None, help="16 kHz mono clip files named <clip_id>.wav or .flac")
    p.add_argument("--segments", default=None, help="diarization segments, CSV / JSON / JSONL, times on the clip clock")
    p.add_argument("--nemotron-dir", default=None, help="directory of NLP1 probability files, one per clip")
    p.add_argument("--doctor-budget-s", type=float, default=15.0, help="max seconds of doctor speech per window")
    p.add_argument("--doctor-horizon-s", type=float, default=60.0, help="only doctor speech within this many seconds of the window")
    p.add_argument("--doctor-slot", type=int, default=None, help="doctor speaker slot when the window row does not carry one")
    p.add_argument("--doctor-thr", type=float, default=0.5, help="Nemotron probability threshold for a doctor frame")
    args = p.parse_args(argv)
    if args.models.strip() == "list":
        for spec in SPECS:
            print(f"{spec.name}\t{spec.model_id}\t{spec.kind}")
        return
    try:
        settings = doctor_settings_from_args(args)
        manifest = run(
            args.windows,
            args.audio_dir,
            args.out,
            models=args.models,
            device=args.device,
            doctor_ref=settings,
        )
    except DoctorRefError as e:
        print(f"doctor-ref: {e}", file=sys.stderr)
        sys.exit(2)
    except Exception:
        traceback.print_exc()
        raise
    print(f"wrote {args.out} models={len(manifest['models'])} windows={manifest['n_windows']}")


def doctor_settings_from_args(args) -> DoctorRefSettings | None:
    """Build settings from the CLI. ``None`` when ``--doctor-ref`` is off."""
    if not getattr(args, "doctor_ref", False):
        return None
    if not args.clip_audio_dir:
        raise DoctorRefError("--doctor-ref needs --clip-audio-dir")
    return DoctorRefSettings(
        clip_audio_dir=args.clip_audio_dir,
        segments_path=args.segments,
        nemotron_dir=args.nemotron_dir,
        budget_s=args.doctor_budget_s,
        horizon_s=args.doctor_horizon_s,
        doctor_slot=args.doctor_slot,
        doctor_thr=args.doctor_thr,
    )


if __name__ == "__main__":
    main()
