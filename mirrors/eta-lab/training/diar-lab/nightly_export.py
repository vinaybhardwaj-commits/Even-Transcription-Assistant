#!/usr/bin/env python3
"""Nightly teacher-label export (orders/DIAR-LAB.md Phase 2 spec, item owned by diar-lab).

For every window with a pyannote.ai teacher label (diarize_window_label, engine='pyannoteai')
not already in a dataset manifest: materialize clip audio (16kHz mono wav) + RTTM from the
teacher segments into /home/eta/eta-data/diar-train/<ist_date>/, and append it to a new
dataset manifest under eta-lab/datasets/.

Split: BY ROOM-DAY, never by window (order requirement) — 80/10/10, deterministic (sha256
of room_day_id mod 10, stable across runs so a room-day never moves splits once assigned).
V's 5 hand-checked windows and the 20 bench windows are the PERMANENT test set and are
never included here even if a matching label exists (checked by window_id against a
fixed list) — they are evaluated separately, never trained on.

No transcript text or audio content is ever printed — ids, counts, hashes only.
"""
import argparse
import hashlib
import json
import os
import sys
import time
import uuid

from lib_diar_train import neon_select, fetch_clip_via_scribe, sha256_file, segments_to_rttm

DATASETS_DIR = os.path.expanduser("~/dev/eta-lab/datasets")
EXPORT_ROOT = os.path.expanduser("~/eta-data/diar-train")

# V's 5 hand-checked bench windows + the 20-window bake-off set: permanent held-out test,
# never trained on even if a pyannoteai label exists for them.
PERMANENT_TEST_WINDOW_IDS = {
    "bw_yce79u6r_1789999200000_primary", "bw_d4t5tvg9_1789986600000_primary",
    "bw_maaacrdh_1790058600000_primary", "bw_zyjykmwa_1790057700000_primary",
    "bw_m6nq7upz_1790057700000_primary",
    "bw_6yfr8qb8_1789997400000_primary", "bw_8scgjz67_1789799400000_primary",
    "bw_8scgjz67_1789802100000_primary", "bw_9j4z2ze3_1789989300000_primary",
    "bw_d5aype5r_1790052300000_primary", "bw_gf2zntnq_1789994700000_primary",
    "bw_gf2zntnq_1789999200000_primary", "bw_j45jmzam_1789992900000_primary",
    "bw_jk5s2tfs_1790045100000_primary", "bw_kmbn52gk_1790061300000_primary",
    "bw_maaacrdh_1790058600000_primary", "bw_pjk6n3qy_1789979400000_primary",
    "bw_pwwnz89z_1789994700000_primary", "bw_wwq9p6eb_1789803000000_primary",
    "bw_yce79u6r_1789998300000_primary", "bw_zyjykmwa_1790055900000_primary",
}


def room_day_split(room_day_id: str) -> str:
    h = int(hashlib.sha256(room_day_id.encode()).hexdigest(), 16) % 10
    if h < 8:
        return "train"
    if h < 9:
        return "val"
    return "test"


def already_exported_label_ids() -> set:
    ids = set()
    if not os.path.isdir(DATASETS_DIR):
        return ids
    for fn in os.listdir(DATASETS_DIR):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(DATASETS_DIR, fn)) as f:
            m = json.load(f)
        for w in m.get("windows", []):
            ids.add(w["label_id"])
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="query and report only, no R2 fetch, no manifest written")
    args = ap.parse_args()

    seen = already_exported_label_ids()

    rows = neon_select(
        "SELECT l.id as label_id, l.window_id, l.room_day_id, l.engine, l.model, l.run_id, "
        "l.speaker_count, l.segment_count, l.created_at, "
        "d.room_id, d.ist_date, w.clip_r2_key "
        "FROM diarize_window_label l "
        "JOIN room_day d ON d.id = l.room_day_id "
        "JOIN room_diarize_window w ON w.window_id = l.window_id "
        "WHERE l.engine = 'pyannoteai' AND w.clip_r2_key IS NOT NULL "
        "ORDER BY l.created_at"
    )

    # T1 (refuter, 24 Sep): the permanent test set leaks by ROOM-DAY, not just window id -- exclude every window on a room-day that holds a test window.
    test_rds = set(json.load(open(os.path.join(DATASETS_DIR, "permanent-test-room-days.json")))["room_day_ids"])
    new_rows = [r for r in rows if r["label_id"] not in seen and r["window_id"] not in PERMANENT_TEST_WINDOW_IDS and r["room_day_id"] not in test_rds]
    print(f"# {len(rows)} total pyannoteai labels in Neon, {len(seen)} already exported, "
          f"{len(rows) - len(new_rows)} skipped (already exported or permanent-test), "
          f"{len(new_rows)} new to export", file=sys.stderr)

    if args.dry_run or not new_rows:
        print("# dry-run or nothing new — stopping before any fetch/write", file=sys.stderr)
        return

    dataset_id = f"diar-train-{time.strftime('%Y-%m-%d')}-{uuid.uuid4().hex[:8]}"
    manifest = {"dataset_id": dataset_id, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "windows": []}

    for r in new_rows:
        window_id = r["window_id"]
        ist_date = str(r["ist_date"])
        day_dir = os.path.join(EXPORT_ROOT, ist_date)
        wav_path = os.path.join(day_dir, f"{window_id}.wav")
        rttm_path = os.path.join(day_dir, f"{window_id}.rttm")

        try:
            fetch_clip_via_scribe(window_id, wav_path)
        except RuntimeError as e:
            print(f"{window_id}: SKIP ({e})", file=sys.stderr)
            continue

        segs = r["segment_count"]  # segments_json not selected here to keep the row small; re-fetch for RTTM
        seg_rows = neon_select(f"SELECT segments_json FROM diarize_window_label WHERE id = '{r['label_id']}'")
        segments = seg_rows[0]["segments_json"]
        if isinstance(segments, str):
            segments = json.loads(segments)
        segments_to_rttm(window_id, segments, rttm_path)

        entry = {
            "window_id": window_id, "room_day_id": r["room_day_id"], "room_id": r["room_id"],
            "ist_date": ist_date, "label_id": r["label_id"], "engine": r["engine"],
            "model": r["model"], "run_id": r["run_id"], "clip_r2_key": r["clip_r2_key"],
            "split": room_day_split(r["room_day_id"]),
            "audio_sha256": sha256_file(wav_path), "rttm_sha256": sha256_file(rttm_path),
        }
        manifest["windows"].append(entry)
        print(f"{window_id}: exported (split={entry['split']})", file=sys.stderr)

    if not manifest["windows"]:
        print("# nothing successfully exported, not writing a manifest", file=sys.stderr)
        return

    os.makedirs(DATASETS_DIR, exist_ok=True)
    manifest_path = os.path.join(DATASETS_DIR, f"{dataset_id}.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"# WROTE {manifest_path} ({len(manifest['windows'])} windows)", file=sys.stderr)


if __name__ == "__main__":
    main()
