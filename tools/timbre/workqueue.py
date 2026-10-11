"""Sharded work queue for the Timbre scale runner.

A shard owns every window of a clip, so the clip's audio is fetched once.
The shard index is a hash of ``clip_id`` and does not change between runs.
Queue files are operational state: they hold window ids and object keys, and
they are not a population report.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


QUEUE_SCHEMA = "timbre.scale.queue.v1"


class QueueError(ValueError):
    pass


def shard_index(clip_id: str, n_shards: int) -> int:
    if n_shards < 1:
        raise QueueError("n_shards must be >= 1")
    digest = hashlib.sha256(clip_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % n_shards


def work_key(item: dict) -> tuple[str, str]:
    return (str(item["window_id"]), str(item["model_version"]))


def build_work_items(windows, specs) -> list[dict]:
    """One item per kept window and selected model. Status starts at ``pending``."""
    items: list[dict] = []
    for window in windows:
        key = str(window.meta.get("r2_key") or "")
        doctor = str(window.meta.get("doctor_uid8") or "")
        for spec in specs:
            items.append(
                {
                    "window_id": window.window_id,
                    "clip_id": window.clip_id,
                    "model_name": spec.name,
                    "model_version": spec.name,
                    "model_id": spec.model_id,
                    "extractor_version": spec.extractor_version,
                    "r2_key": key,
                    "start_s": float(window.start_s),
                    "end_s": float(window.end_s),
                    "room": window.room,
                    "date": window.date,
                    "lang": window.lang,
                    "phase": window.phase,
                    "role": window.role,
                    "doctor_uid8": doctor,
                    "patient_speech_s": float(window.patient_speech_s),
                    "status": "pending",
                    "reason": None,
                }
            )
    items.sort(key=lambda it: (it["clip_id"], it["start_s"], it["model_name"], it["window_id"]))
    return items


def group_by_shard(items: list[dict], n_shards: int) -> dict[int, list[dict]]:
    grouped = {i: [] for i in range(n_shards)}
    for item in items:
        grouped[shard_index(item["clip_id"], n_shards)].append(item)
    return grouped


def queue_path(out_dir: Path, shard: int) -> Path:
    return out_dir / "queue" / f"shard-{shard:04d}.json"


def shard_parquet_path(out_dir: Path, shard: int, model_name: str) -> Path:
    return out_dir / "shards" / f"shard-{shard:04d}" / f"{model_name}.parquet"


def save_queue(path: Path, shard: int, n_shards: int, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema": QUEUE_SCHEMA, "shard": shard, "n_shards": n_shards, "items": items}
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load_queue(path: Path) -> list[dict] | None:
    """Return items, or ``None`` when the file is missing. A corrupt file is renamed."""
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("schema") != QUEUE_SCHEMA or not isinstance(payload.get("items"), list):
            raise QueueError("schema")
        return payload["items"]
    except (OSError, json.JSONDecodeError, QueueError, TypeError):
        os.replace(path, path.with_suffix(path.suffix + ".corrupt"))
        return None


def merge_status(desired: list[dict], previous: list[dict] | None, *, rescore: bool) -> list[dict]:
    """Keep finished status from the previous queue. New keys start pending.

    Items that are no longer desired are left out of the queue. Their parquet
    rows are not deleted; the merge filters them at read time.
    """
    prior = {} if rescore or not previous else {work_key(item): item for item in previous}
    merged = []
    for item in desired:
        old = prior.get(work_key(item))
        status = (old or {}).get("status")
        if status in ("ok", "nan", "skipped"):
            item["status"] = status
            item["reason"] = old.get("reason")
        elif status == "running":
            item["status"] = "pending"
            item["reason"] = None
        merged.append(item)
    return merged


def reconcile_with_parquet(items: list[dict], done: dict[tuple[str, str], str], *, rescore: bool) -> None:
    """Parquet is the record of a finished score. A queued ``ok`` with no row is pending again.

    ``done`` maps ``(window_id, model_version)`` to ``ok`` or ``nan``. ``--rescore``
    clears finished status so the next pass rewrites the rows.
    """
    for item in items:
        if rescore:
            item["status"] = "pending"
            item["reason"] = None
            continue
        key = work_key(item)
        if key in done:
            item["status"] = done[key]
            item["reason"] = None
            continue
        if item.get("status") in ("ok", "nan", "running"):
            item["status"] = "pending"
            item["reason"] = None
