"""Production batch runner for Timbre.

Scores every kept window of a sessions list. Audio is fetched read-only from
the ``eta-audio`` bucket, cut with :func:`tools.timbre.windows.generate_windows`,
and kept only when :class:`tools.timbre.purity.PurityRule` passes. Work is
sharded by clip, resumed from parquet, and written as one parquet per shard
per model. Rows are keyed by ``window_id`` and ``model_version`` (the catalog
name, which already includes the extractor version).

Device ``auto`` selects CUDA when it is available. Whisper-family models stay
on the float32 load in ``extractors/whisper_encoder.py`` and
``extractors/voxprofile_dim.py``; this runner never asks for a half dtype.

``--dry-run`` writes ``plan.json`` only: counts, the dtype policy, and a
cost/time estimate. It does not fetch audio or load weights. The population
report is aggregates by room, doctor_uid8, and day. It has no window ids and
no audio. Queue files and shard parquets are private operational output and
must not be committed.

The earlier GPU pass wrapped ``run.main`` (``run_wrapped_gpu.py``). This
runner calls the same extractors directly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path

import numpy as np
import pandas as pd

from tools.timbre import HARNESS_VERSION
from tools.timbre.audio import read_audio
from tools.timbre.baseline import add_baselines, baseline_columns
from tools.timbre.catalog import SPEC_BY_NAME, resolve_model_names
from tools.timbre.mem import InsufficientMemory, mem_available_gb
from tools.timbre.population import population_report
from tools.timbre.purity import PurityRule, embedding_purity, probs_purity
from tools.timbre.r2audio import allowed_audio_key, fetch_audio, resolve_prefixes
from tools.timbre.run import _failed, _flatten, _json_default, _merge, _write_json, _write_parquet
from tools.timbre.windows import generate_windows, load_clips, load_windows
from tools.timbre.workqueue import (
    build_work_items,
    group_by_shard,
    load_queue,
    merge_status,
    queue_path,
    reconcile_with_parquet,
    save_queue,
    shard_parquet_path,
    work_key,
)

log = logging.getLogger("tools.timbre.scale")

SCALE_SCHEMA = "timbre.scale.v1"
# Provisional arousal models from the locked 2026-10-11 baseline, plus the two
# secondaries named for the scale run (Vox-Profile Whisper-dim and eGeMAPS).
BATCH1_MODELS = (
    "odyssey_wavlm_dim.v1",
    "audeering_msp_dim.v1",
    "voxprofile_whisper_dim.v1",
    "egemaps_v02.v1",
)
# These checkpoints are fp16 in their Hugging Face config. The extractors
# force float32. Do not add a half load here.
WHISPER_FP32_MODELS = frozenset(
    {
        "voxprofile_whisper_dim.v1",
        "whisper_large_v3_encoder.v1",
    }
)
# CPU smoke figures from the harness README (seconds of compute per second of
# audio). They are not GPU measurements. Vox-Profile and the Whisper encoder
# were skipped on that box, so they have no published rate.
PUBLISHED_CPU_RATES = {
    "egemaps_v02.v1": 0.012,
    "compare2016.v1": 0.013,
    "audeering_msp_dim.v1": 0.048,
    "odyssey_wavlm_dim.v1": 0.080,
    "emotion2vec_plus_large.v1": 0.046,
    "wavlm_aniemore.v1": 0.076,
}
_STRIP_COLUMNS = ("r2_key", "audio_path", "transcript", "note")
_SECRET_ENV = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID")


class ScaleError(ValueError):
    pass


def resolve_scale_models(text: str) -> list[str]:
    """``batch1`` is the provisional set. Anything else uses the catalog resolver."""
    raw = (text or "").strip()
    if raw in ("", "batch1", "provisional"):
        return list(BATCH1_MODELS)
    return resolve_model_names(raw)


def load_dtype(model_name: str) -> str:
    """Whisper-family loads are float32. Other models keep the extractor default."""
    if model_name in WHISPER_FP32_MODELS:
        return "float32"
    return "model_default"


def resolve_device(choice: str) -> tuple[str, str]:
    """``auto`` is CUDA when ``torch.cuda.is_available()``, else CPU."""
    name = (choice or "auto").strip().lower()
    if name == "cpu":
        return "cpu", "requested cpu"
    if name == "cuda":
        return "cuda", "requested cuda"
    if name != "auto":
        raise ScaleError("device must be auto, cpu, or cuda")
    if _cuda_available():
        return "cuda", "auto: cuda available"
    return "cpu", "auto: cuda not available"


def _cuda_available() -> bool:
    try:
        import torch
    except ImportError:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def estimate_compute(
    audio_s: float,
    model_names: list[str],
    rates_override: dict[str, float] | None = None,
    gpu_usd_per_hour: float | None = None,
) -> dict:
    """``compute_hours = audio_hours * s_per_audio_s`` for each selected model.

    ``cost_usd`` is set only when every selected model has a rate and a GPU
    price was supplied. A missing rate stays null and is marked UNVERIFIED.
    """
    override = rates_override or {}
    audio_s = float(audio_s)
    audio_hours = audio_s / 3600.0
    per_model = []
    missing = False
    measured = 0.0
    for name in model_names:
        if name in override:
            rate = float(override[name])
            source = "override"
            kind = "supplied"
            note = None
        elif name in PUBLISHED_CPU_RATES:
            rate = float(PUBLISHED_CPU_RATES[name])
            source = "published_cpu_smoke"
            kind = "cpu_smoke"
            note = "CPU smoke rate, not a GPU measurement"
        else:
            rate = None
            source = "unmeasured"
            kind = None
            note = "UNVERIFIED: no measured s/audio-s"
        if rate is None:
            missing = True
            per_model.append(
                {
                    "model": name,
                    "s_per_audio_s": None,
                    "rate_source": source,
                    "rate_kind": kind,
                    "compute_hours": None,
                    "note": note,
                }
            )
            continue
        hours = audio_hours * rate
        measured += hours
        per_model.append(
            {
                "model": name,
                "s_per_audio_s": rate,
                "rate_source": source,
                "rate_kind": kind,
                "compute_hours": hours,
                "note": note,
            }
        )
    complete = not missing
    price = None if gpu_usd_per_hour is None else float(gpu_usd_per_hour)
    cost = measured * price if complete and price is not None else None
    return {
        "formula": "compute_hours = audio_hours * s_per_audio_s",
        "audio_s": audio_s,
        "audio_hours": audio_hours,
        "per_model": per_model,
        "compute_hours": measured if complete else None,
        "compute_hours_measured": measured,
        "complete": complete,
        "gpu_usd_per_hour": price,
        "cost_usd": cost,
        "cost_note": (
            "cost_usd = compute_hours * gpu_usd_per_hour. "
            "Published rates are CPU smoke figures. Pass --rates measured on the "
            "target GPU before treating cost_usd as a GPU quote."
        ),
    }


def load_rates(path: Path | str | None) -> dict[str, float]:
    if not path:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ScaleError("rates file must be a JSON object of model name to s/audio-s")
    out: dict[str, float] = {}
    for key, value in payload.items():
        name = str(key)
        if name.startswith("_"):
            continue
        rate = float(value)
        if rate < 0 or rate != rate:
            raise ScaleError("s/audio-s must be a finite number >= 0")
        out[name] = rate
    return out


def load_purity_table(path: Path | str) -> dict[str, dict]:
    """One score dict per window id. Frame evidence is reduced with the purity module."""
    file = Path(path)
    if not file.is_file():
        raise ScaleError(f"purity CSV not found: {file.name}")
    frame = pd.read_csv(file, dtype=str, keep_default_na=False)
    if "window_id" not in frame.columns:
        raise ScaleError("purity CSV missing window_id")
    scores: dict[str, dict] = {}
    for rec in frame.to_dict(orient="records"):
        wid = str(rec.get("window_id", "")).strip()
        if not wid or wid in scores:
            raise ScaleError("purity CSV has an empty or duplicate window_id")
        scores[wid] = purity_score_from_row(rec)
    return scores


def purity_score_from_row(rec: dict) -> dict:
    if _filled(rec, "cos_patient"):
        hop = float(rec["hop_s"]) if _filled(rec, "hop_s") else 0.5
        other = _json_vec(rec["cos_other"]) if _filled(rec, "cos_other") else None
        return embedding_purity(_json_vec(rec["cos_patient"]), other, hop_s=hop)
    if _filled(rec, "probs"):
        probs = np.asarray(json.loads(rec["probs"]), dtype=np.float64)
        slot = int(rec["patient_slot"]) if _filled(rec, "patient_slot") else 0
        frame_s = float(rec["frame_s"]) if _filled(rec, "frame_s") else 0.010
        kwargs = {"frame_s": frame_s}
        if _filled(rec, "doctor_slot"):
            kwargs["doctor_slot"] = int(rec["doctor_slot"])
        return probs_purity(probs, slot, **kwargs)
    if not _filled(rec, "purity") or not _filled(rec, "pure_patient_s"):
        raise ScaleError("purity row needs purity and pure_patient_s, or frame evidence")
    score = {"purity": float(rec["purity"]), "pure_patient_s": float(rec["pure_patient_s"])}
    if _filled(rec, "cos_patient_mean"):
        score["cos_patient_mean"] = float(rec["cos_patient_mean"])
    return score


def apply_purity(windows, scores: dict[str, dict], rule: PurityRule | None = None):
    """Fail closed: a window with no score, or a score the rule rejects, is dropped.

    Kept windows take ``patient_speech_s`` from ``pure_patient_s`` when that
    value is present. Dropped windows are absent from the queue. Rows already
    written for them stay in the shard parquet and are filtered out at merge.
    """
    rule = rule or PurityRule()
    kept = []
    dropped_rule = 0
    dropped_missing = 0
    for window in windows:
        score = scores.get(window.window_id)
        if score is None:
            dropped_missing += 1
            continue
        if not rule.passes(score):
            dropped_rule += 1
            continue
        pure = score.get("pure_patient_s")
        if pure is not None and np.isfinite(pure):
            window.patient_speech_s = float(pure)
        kept.append(window)
    counts = {
        "rule": rule.to_dict(),
        "n_in": len(windows),
        "n_kept": len(kept),
        "n_dropped_rule": dropped_rule,
        "n_dropped_missing": dropped_missing,
    }
    return kept, counts


def load_scale_windows(
    path: Path | str,
    *,
    window_s: float,
    hop_s: float,
    min_window_s: float | None,
) -> tuple[str, list]:
    """Clips are cut by the windows generator. A CSV that already has ``window_id`` is used as-is."""
    file = Path(path)
    if not file.is_file():
        raise ScaleError(f"sessions CSV not found: {file.name}")
    header = pd.read_csv(file, nrows=0)
    if "window_id" in header.columns:
        windows = load_windows(file, audio_dir=None)
        missing = 0
        for window in windows:
            key = str(window.meta.get("r2_key") or "").strip()
            if not key:
                missing += 1
            else:
                window.meta["r2_key"] = key
            window.meta["doctor_uid8"] = str(window.meta.get("doctor_uid8") or "")
        if missing:
            raise ScaleError("windows table is missing r2_key")
        return "table", windows
    windows = []
    for clip in load_clips(file):
        windows.extend(
            generate_windows(
                clip,
                window_s=window_s,
                hop_s=hop_s,
                min_window_s=min_window_s,
            )
        )
    return "generated", windows


def slice_audio(audio: np.ndarray, sr: int, start_s: float, end_s: float) -> np.ndarray:
    if sr <= 0:
        raise ScaleError("sample rate must be > 0")
    start = max(0, int(round(float(start_s) * sr)))
    end = max(0, int(round(float(end_s) * sr)))
    start = min(start, int(audio.size))
    end = min(end, int(audio.size))
    if end <= start:
        raise ScaleError("empty slice")
    return np.asarray(audio[start:end], dtype=np.float32)


def cache_path(cache_dir: Path, key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    suffix = ".flac" if key.endswith(".flac") else ".wav"
    return cache_dir / f"{digest}{suffix}"


def acquire_shard_lock(path: Path):
    """Exclusive lock. A lock whose pid is not running is removed and taken."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        if not _steal_stale_lock(path):
            raise ScaleError("shard is already locked")
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise ScaleError("shard is already locked") from None
    os.write(fd, str(os.getpid()).encode())
    return fd


def release_shard_lock(fd: int, path: Path) -> None:
    try:
        os.close(fd)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def run_scale(
    sessions: Path | str,
    purity: Path | str,
    out_dir: Path | str,
    *,
    window_s: float = 10.0,
    hop_s: float = 10.0,
    min_window_s: float | None = None,
    models: str = "batch1",
    device: str = "auto",
    batch_size: int = 4,
    n_shards: int = 16,
    shard: int | None = None,
    dry_run: bool = False,
    gpu_usd_per_hour: float | None = None,
    rates_path: Path | str | None = None,
    min_group_n: int = 5,
    audio_prefixes: str | tuple[str, ...] | None = None,
    extractors: dict | None = None,
    client=None,
    rescore: bool = False,
    cache_dir: Path | str | None = None,
) -> dict:
    if batch_size < 1:
        raise ScaleError("batch-size must be >= 1")
    if n_shards < 1:
        raise ScaleError("shards must be >= 1")
    if shard is not None and not 0 <= int(shard) < n_shards:
        raise ScaleError("shard index is out of range")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    prefixes = resolve_prefixes(audio_prefixes)
    kind, generated = load_scale_windows(
        sessions,
        window_s=window_s,
        hop_s=hop_s,
        min_window_s=min_window_s,
    )
    for window in generated:
        allowed_audio_key(str(window.meta.get("r2_key") or ""), prefixes)
    scores = load_purity_table(purity)
    kept, purity_counts = apply_purity(generated, scores, PurityRule())
    names = resolve_scale_models(models)
    specs = [SPEC_BY_NAME[name] for name in names]
    device_name, device_reason = resolve_device(device)
    rates = load_rates(rates_path)
    audio_s = float(sum(window.duration_s for window in kept))
    estimate = estimate_compute(audio_s, names, rates, gpu_usd_per_hour)
    items = build_work_items(kept, specs)
    grouped = group_by_shard(items, n_shards)
    done = {} if rescore else _done_index(out, names)
    n_done = sum(1 for item in items if work_key(item) in done)
    plan = _plan(
        kind=kind,
        generated=generated,
        kept=kept,
        purity_counts=purity_counts,
        names=names,
        device_name=device_name,
        device_reason=device_reason,
        n_shards=n_shards,
        shard=shard,
        grouped=grouped,
        estimate=estimate,
        dry_run=dry_run,
        n_done=n_done,
        batch_size=batch_size,
        rescore=rescore,
    )
    _write_json(out / "plan.json", plan)
    if dry_run:
        return plan

    cache = Path(cache_dir) if cache_dir else out / "cache"
    banned = _secret_values()
    touched: list[int] = []
    for index in range(n_shards):
        desired = grouped[index]
        do_rescore = bool(rescore) and (shard is None or index == int(shard))
        synced = _sync_shard(out, index, desired, n_shards, names, rescore=do_rescore)
        if shard is not None and index != int(shard):
            continue
        touched.append(index)
        if any(item["status"] == "pending" for item in synced):
            _score_shard(
                out,
                index,
                n_shards,
                synced,
                names,
                device_name,
                batch_size,
                prefixes,
                cache,
                extractors or {},
                client,
                banned,
            )
    merged = _merge_outputs(out, names, kept)
    scored = _scored_rows(merged, names)
    report = population_report(scored, min_group_n=min_group_n)
    _write_json(out / "report" / "population.json", report)
    totals = _status_totals(out, names, {window.window_id for window in kept})
    measured = {
        name: totals[name]["s_per_audio_s"]
        for name in names
        if totals[name]["s_per_audio_s"] is not None
    }
    measured["_note"] = "measured s per audio second from this output; no window ids"
    _write_json(out / "rates_measured.json", measured)
    manifest = dict(plan)
    manifest["dry_run"] = False
    manifest["shards_scored"] = touched
    queued = _queue_counts(out, names)
    manifest["per_model"] = {
        name: {
            "model_id": SPEC_BY_NAME[name].model_id,
            "dtype": load_dtype(name),
            **totals[name],
            "n_pending": queued[name]["n_pending"],
            "n_skipped": queued[name]["n_skipped"],
        }
        for name in names
    }
    manifest["merged_rows"] = int(len(merged))
    manifest["merged_cols"] = int(len(merged.columns))
    manifest["report_n"] = int(report["n"])
    manifest["n_groups_suppressed"] = int(report["n_groups_suppressed"])
    _write_json(out / "manifest.json", manifest)
    return manifest


def rebuild_report(out_dir: Path | str, min_group_n: int = 5) -> dict:
    out = Path(out_dir)
    path = out / "merged" / "features.parquet"
    if not path.is_file():
        raise ScaleError("merged features are not written yet")
    frame = pd.read_parquet(path)
    report = population_report(frame, min_group_n=min_group_n)
    _write_json(out / "report" / "population.json", report)
    return {"schema": SCALE_SCHEMA, "report_only": True, "dry_run": False, "device": None, "n": report["n"]}


def score_many(extractor, pairs: list[tuple[np.ndarray, int]]) -> list[dict]:
    """Use ``extract_batch`` when the extractor implements it and the batch shares a sample rate.

    Catalog extractors score one window per call. The batch is still one queue
    checkpoint and one throughput line. A GPU ``extract_batch`` must return one
    result dict per window, the same shape as ``extract``, and must keep the
    Whisper float32 load.
    """
    if not pairs:
        return []
    batch_fn = getattr(extractor, "extract_batch", None)
    rates = {sr for _, sr in pairs}
    if batch_fn is not None and len(pairs) > 1 and len(rates) == 1:
        audios = [audio for audio, _ in pairs]
        return list(batch_fn(audios, pairs[0][1]))
    return [extractor.extract(audio, sr) for audio, sr in pairs]


def _plan(**kwargs) -> dict:
    generated = kwargs["generated"]
    kept = kwargs["kept"]
    grouped = kwargs["grouped"]
    n_shards = kwargs["n_shards"]
    names = kwargs["names"]
    return {
        "schema": SCALE_SCHEMA,
        "harness": "timbre",
        "harness_version": HARNESS_VERSION,
        "dry_run": bool(kwargs["dry_run"]),
        "rescore": bool(kwargs["rescore"]),
        "window_source": kwargs["kind"],
        "device": kwargs["device_name"],
        "device_reason": kwargs["device_reason"],
        "batch_size": int(kwargs["batch_size"]),
        "models": list(names),
        "dtypes": {name: load_dtype(name) for name in names},
        "whisper_fp32": sorted(WHISPER_FP32_MODELS),
        "n_clips": len({window.clip_id for window in generated}),
        "n_windows_generated": len(generated),
        "n_windows_kept": len(kept),
        "n_windows_dropped": len(generated) - len(kept),
        "purity": kwargs["purity_counts"],
        "n_shards": n_shards,
        "shard": kwargs["shard"],
        "shard_counts": [len({item["window_id"] for item in grouped[i]}) for i in range(n_shards)],
        "n_work_items": sum(len(grouped[i]) for i in range(n_shards)),
        "n_already_done": int(kwargs["n_done"]),
        "n_pending": sum(len(grouped[i]) for i in range(n_shards)) - int(kwargs["n_done"]),
        "estimate": kwargs["estimate"],
    }


def _sync_shard(out, index, desired, n_shards, names, *, rescore: bool) -> list[dict]:
    path = queue_path(out, index)
    previous = load_queue(path)
    items = merge_status(desired, previous, rescore=rescore)
    done: dict[tuple[str, str], str] = {}
    if not rescore:
        for name in names:
            done.update(_done_in_file(shard_parquet_path(out, index, name)))
    reconcile_with_parquet(items, done, rescore=rescore)
    save_queue(path, index, n_shards, items)
    return items


def _score_shard(out, index, n_shards, items, names, device, batch_size, prefixes, cache, injected, client, banned):
    lock_path = out / "shards" / f"shard-{index:04d}.lock"
    fd = acquire_shard_lock(lock_path)
    holder: dict = {}
    try:
        for name in names:
            pending = [item for item in items if item["model_name"] == name and item["status"] == "pending"]
            if not pending:
                continue
            try:
                extractor, skip = _prepare_extractor(name, device, injected)
            except InsufficientMemory as exc:
                extractor, skip = None, "insufficient_memory"
                log.warning("skip %s: %s", name, type(exc).__name__)
            if extractor is None:
                reason = "insufficient_memory" if skip is None else _redact(str(skip), banned)
                for item in pending:
                    item["status"] = "skipped"
                    item["reason"] = "insufficient_memory" if "RAM" in reason or reason == "insufficient_memory" else "skipped"
                save_queue(queue_path(out, index), index, n_shards, items)
                log.warning("skip %s: %s", name, reason)
                continue
            try:
                _score_model(
                    out,
                    index,
                    n_shards,
                    items,
                    pending,
                    extractor,
                    batch_size,
                    prefixes,
                    cache,
                    holder,
                    client,
                    banned,
                    device,
                )
            finally:
                if name not in injected:
                    close = getattr(extractor, "close", None)
                    if close is not None:
                        close()
    finally:
        release_shard_lock(fd, lock_path)


def _prepare_extractor(name: str, device: str, injected: dict):
    if name in injected:
        return injected[name], None
    spec = SPEC_BY_NAME[name]
    have = mem_available_gb()
    if have < spec.ram_gb:
        return None, f"need about {spec.ram_gb:.1f} GB available RAM, have {have:.1f} GB"
    from tools.timbre.extractors.base import build_extractor

    return build_extractor(name, device), None


def _score_model(out, index, n_shards, items, pending, extractor, batch_size, prefixes, cache, holder, client, banned, device):
    rest = list(pending)
    name = extractor.spec.name
    while rest:
        batch = rest[:batch_size]
        rest = rest[batch_size:]
        for item in batch:
            item["status"] = "running"
            item["reason"] = None
        save_queue(queue_path(out, index), index, n_shards, items)
        try:
            results = _score_batch(extractor, batch, prefixes, cache, holder, client, banned)
        except InsufficientMemory:
            for item in batch + rest:
                item["status"] = "skipped"
                item["reason"] = "insufficient_memory"
            save_queue(queue_path(out, index), index, n_shards, items)
            log.warning("skip %s: insufficient_memory", name)
            return
        except Exception as exc:
            reason = _safe_exc(exc, banned, "")
            results = [_failed(extractor, reason, 0.0) for _ in batch]
        rows = []
        infer_s = 0.0
        audio_s = 0.0
        for item, result in zip(batch, results):
            status = result.get("status")
            if status not in ("ok", "nan", "error"):
                status = "error"
            item["status"] = status
            item["reason"] = None if status in ("ok", "nan") else _redact(str(result.get("reason") or ""), banned + [item["r2_key"]])
            rows.append(_score_row(item, result))
            if status == "ok":
                infer_s += float(result.get("infer_s") or 0.0)
                audio_s += float(result.get("audio_s") or 0.0)
        _upsert(shard_parquet_path(out, index, item_model(batch)), rows)
        save_queue(queue_path(out, index), index, n_shards, items)
        _throughput(
            out,
            {
                "model": item_model(batch),
                "model_version": item_model(batch),
                "device": device,
                "dtype": load_dtype(item_model(batch)),
                "shard": index,
                "batch_n": len(batch),
                "audio_s": audio_s,
                "infer_s": infer_s,
                "s_per_audio_s": (infer_s / audio_s) if audio_s else None,
            },
        )


def item_model(batch: list[dict]) -> str:
    return str(batch[0]["model_name"])


def _score_batch(extractor, batch, prefixes, cache, holder, client, banned) -> list[dict]:
    results: list[dict | None] = [None] * len(batch)
    good: list[tuple[int, np.ndarray, int]] = []
    for index, item in enumerate(batch):
        banned_item = banned + [str(item.get("r2_key") or "")]
        try:
            audio, sr = _clip_audio(item["r2_key"], cache=cache, holder=holder, client=client, prefixes=prefixes)
            good.append((index, slice_audio(audio, sr, item["start_s"], item["end_s"]), sr))
        except InsufficientMemory:
            raise
        except Exception as exc:
            results[index] = _failed(extractor, _safe_exc(exc, banned_item, item.get("r2_key") or ""), 0.0)
    if good:
        try:
            scored = score_many(extractor, [(audio, sr) for _, audio, sr in good])
        except InsufficientMemory:
            raise
        if len(scored) != len(good):
            raise ScaleError("extract_batch returned the wrong number of rows")
        for (index, _, _), result in zip(good, scored):
            results[index] = result
    return [row if row is not None else _failed(extractor, "empty", 0.0) for row in results]


def _clip_audio(key: str, *, cache: Path, holder: dict, client, prefixes):
    if holder.get("key") != key:
        audio, sr = _load_cached(key, cache=cache, client=client, prefixes=prefixes)
        holder.clear()
        holder["key"] = key
        holder["audio"] = audio
        holder["sr"] = sr
    return holder["audio"], holder["sr"]


def _load_cached(key: str, *, cache: Path, client, prefixes):
    path = cache_path(cache, key)
    if path.is_file():
        try:
            return read_audio(path)
        except Exception:
            path.unlink(missing_ok=True)
    blob = fetch_audio(key, client=client, prefixes=prefixes)
    _write_private(path, blob)
    return read_audio(path)


def _write_private(path: Path, blob: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(blob)


def _score_row(item: dict, result: dict) -> dict:
    meta = {
        "window_id": item["window_id"],
        "clip_id": item["clip_id"],
        "room": item["room"],
        "date": item["date"],
        "lang": item["lang"],
        "phase": item["phase"],
        "start_s": item["start_s"],
        "end_s": item["end_s"],
        "patient_speech_s": item["patient_speech_s"],
        "role": item["role"],
        "doctor_uid8": item["doctor_uid8"],
    }
    flat = _flatten(result)
    flat["model_version"] = item["model_version"]
    return {**meta, **flat}


def _upsert(path: Path, rows: list[dict]) -> None:
    existing = _read_records(path)
    index = {}
    for i, row in enumerate(existing):
        wid = row.get("window_id")
        version = row.get("model_version")
        if wid is None or version is None:
            continue
        index[(str(wid), str(version))] = i
    for row in rows:
        key = (str(row["window_id"]), str(row["model_version"]))
        if key in index:
            existing[index[key]] = row
        else:
            index[key] = len(existing)
            existing.append(row)
    _write_parquet(pd.DataFrame(existing), path)


def _read_records(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    try:
        frame = pd.read_parquet(path)
    except Exception:
        os.replace(path, path.with_suffix(path.suffix + ".corrupt"))
        return []
    return frame.to_dict(orient="records")


def _done_in_file(path: Path) -> dict[tuple[str, str], str]:
    done = {}
    for row in _read_records(path):
        status = row.get("status")
        if status not in ("ok", "nan"):
            continue
        wid = row.get("window_id")
        version = row.get("model_version")
        if wid is None or version is None:
            continue
        if isinstance(wid, float) and wid != wid:
            continue
        done[(str(wid), str(version))] = str(status)
    return done


def _done_index(out: Path, names: list[str]) -> dict[tuple[str, str], str]:
    done: dict[tuple[str, str], str] = {}
    root = out / "shards"
    if not root.is_dir():
        return done
    for name in names:
        for path in root.glob(f"shard-*/{name}.parquet"):
            done.update(_done_in_file(path))
    return done


def _merge_outputs(out: Path, names: list[str], windows) -> pd.DataFrame:
    """Concat shard parquets, keep the current model version, filter to windows the rule still keeps.

    Older versions and windows that no longer pass purity stay in the shard
    files. They are left out of the merged table at read time.
    """
    merged_dir = out / "merged"
    merged_dir.mkdir(parents=True, exist_ok=True)
    kept_ids = {window.window_id for window in windows}
    root = out / "shards"
    for name in names:
        frames = []
        if root.is_dir():
            for path in sorted(root.glob(f"shard-*/{name}.parquet")):
                records = _read_records(path)
                if records:
                    frames.append(pd.DataFrame(records))
        if frames:
            frame = pd.concat(frames, ignore_index=True)
            if "model_version" in frame.columns:
                frame = frame[frame["model_version"].astype(str) == name]
            if "window_id" in frame.columns:
                frame = frame[frame["window_id"].astype(str).isin(kept_ids)]
                keys = ["window_id", "model_version"] if "model_version" in frame.columns else ["window_id"]
                frame = frame.drop_duplicates(keys, keep="last")
        else:
            frame = pd.DataFrame(columns=["window_id"])
        _write_parquet(frame, merged_dir / f"{name}.parquet")
    merged = _merge(merged_dir, names, windows)
    drop = [column for column in _STRIP_COLUMNS if column in merged.columns]
    if drop:
        merged = merged.drop(columns=drop)
    if len(merged):
        merged = add_baselines(merged, baseline_columns(merged.columns))
    _write_parquet(merged, merged_dir / "features.parquet")
    return merged


def _scored_rows(frame: pd.DataFrame, names: list[str]) -> pd.DataFrame:
    if not len(frame):
        return frame
    mask = pd.Series(False, index=frame.index)
    for name in names:
        column = f"{name}__status"
        if column in frame.columns:
            mask = mask | frame[column].isin(["ok", "nan"])
    return frame.loc[mask].copy()


def _queue_counts(out: Path, names: list[str]) -> dict:
    """Status counts from the queue. Ids in those files are not copied out."""
    counts = {name: {"n_pending": 0, "n_skipped": 0} for name in names}
    root = out / "queue"
    if not root.is_dir():
        return counts
    for path in sorted(root.glob("shard-*.json")):
        for item in load_queue(path) or []:
            name = item.get("model_name")
            if name not in counts:
                continue
            status = item.get("status")
            if status == "pending":
                counts[name]["n_pending"] += 1
            elif status == "skipped":
                counts[name]["n_skipped"] += 1
    return counts


def _status_totals(out: Path, names: list[str], kept_ids: set[str]) -> dict:
    totals = {
        name: {
            "n_ok": 0,
            "n_nan": 0,
            "n_error": 0,
            "infer_s_ok": 0.0,
            "audio_s_ok": 0.0,
            "s_per_audio_s": None,
        }
        for name in names
    }
    root = out / "shards"
    if not root.is_dir():
        return totals
    for name in names:
        for path in sorted(root.glob(f"shard-*/{name}.parquet")):
            for row in _read_records(path):
                if str(row.get("window_id")) not in kept_ids:
                    continue
                if str(row.get("model_version") or name) != name:
                    continue
                status = row.get("status")
                if status == "ok":
                    totals[name]["n_ok"] += 1
                    totals[name]["infer_s_ok"] += float(row.get("infer_s") or 0.0)
                    totals[name]["audio_s_ok"] += float(row.get("audio_s") or 0.0)
                elif status == "nan":
                    totals[name]["n_nan"] += 1
                elif status == "error":
                    totals[name]["n_error"] += 1
        audio = totals[name]["audio_s_ok"]
        totals[name]["s_per_audio_s"] = (totals[name]["infer_s_ok"] / audio) if audio else None
    return totals


def _throughput(out: Path, record: dict) -> None:
    path = out / "throughput.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, default=_json_default)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
        handle.flush()
    rate = record.get("s_per_audio_s")
    log.info(
        "batch model=%s device=%s dtype=%s n=%s audio_s=%.3f s_per_audio_s=%s",
        record.get("model"),
        record.get("device"),
        record.get("dtype"),
        record.get("batch_n"),
        float(record.get("audio_s") or 0.0),
        f"{rate:.4f}" if isinstance(rate, float) else rate,
    )


def _secret_values() -> list[str]:
    found = []
    for name in _SECRET_ENV:
        value = os.environ.get(name)
        if value and len(value) >= 8:
            found.append(value)
    return found


def _redact(text: str, banned: list[str]) -> str:
    cleaned = text.replace("\n", " ")
    for item in banned:
        if item:
            cleaned = cleaned.replace(item, "[redacted]")
    return cleaned[:160]


def _safe_exc(exc: BaseException, banned: list[str], key: str) -> str:
    return _redact(f"{type(exc).__name__}: {exc}", list(banned) + ([key] if key else []))


def _steal_stale_lock(path: Path) -> bool:
    try:
        pid = int(path.read_text(encoding="utf-8").strip() or "0")
    except (OSError, ValueError):
        return False
    if _pid_alive(pid):
        return False
    try:
        path.unlink()
    except OSError:
        return False
    return True


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _filled(rec: dict, key: str) -> bool:
    if key not in rec:
        return False
    return str(rec[key]).strip() != ""


def _json_vec(text: str):
    value = json.loads(text)
    return value


def _parse(argv: list[str] | None):
    parser = argparse.ArgumentParser(prog="python -m tools.timbre.scale")
    parser.add_argument("--sessions", help="clips CSV, or a windows CSV that already has window_id and r2_key")
    parser.add_argument("--purity", help="purity CSV joined on window_id")
    parser.add_argument("--out", required=True)
    parser.add_argument("--window-s", type=float, default=10.0)
    parser.add_argument("--hop-s", type=float, default=10.0)
    parser.add_argument("--min-window-s", type=float, default=None)
    parser.add_argument("--models", default="batch1", help="batch1, all, or a comma-separated catalog list")
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--shards", type=int, default=16)
    parser.add_argument("--shard", type=int, default=None, help="score only this shard index")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rescore", action="store_true", help="ignore finished rows and score again")
    parser.add_argument("--report-only", action="store_true", help="rebuild the population report from merged features")
    parser.add_argument("--gpu-usd-per-hour", type=float, default=None)
    parser.add_argument("--rates", help="JSON object of model name to s/audio-s")
    parser.add_argument("--min-group-n", type=int, default=5)
    parser.add_argument("--audio-prefixes", help="comma-separated R2 key prefixes (default: consult-clips/, clips/)")
    parser.add_argument("--cache-dir", help="local audio cache (default: OUT/cache). Do not commit it.")
    args = parser.parse_args(argv)
    if args.report_only and args.dry_run:
        parser.error("--report-only and --dry-run together are not supported")
    if not args.report_only and (not args.sessions or not args.purity):
        parser.error("--sessions and --purity are required")
    return args


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    args = _parse(argv)
    if args.report_only:
        result = rebuild_report(args.out, args.min_group_n)
    else:
        result = run_scale(
            args.sessions,
            args.purity,
            args.out,
            window_s=args.window_s,
            hop_s=args.hop_s,
            min_window_s=args.min_window_s,
            models=args.models,
            device=args.device,
            batch_size=args.batch_size,
            n_shards=args.shards,
            shard=args.shard,
            dry_run=args.dry_run,
            gpu_usd_per_hour=args.gpu_usd_per_hour,
            rates_path=args.rates,
            min_group_n=args.min_group_n,
            audio_prefixes=args.audio_prefixes,
            rescore=args.rescore,
            cache_dir=args.cache_dir,
        )
    kept = result.get("n_windows_kept", result.get("n"))
    print(f"scale kept={kept} device={result.get('device')} dry_run={result.get('dry_run')}")


if __name__ == "__main__":
    main()
