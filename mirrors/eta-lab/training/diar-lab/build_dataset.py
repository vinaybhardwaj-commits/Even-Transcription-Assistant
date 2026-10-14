#!/usr/bin/env python3
"""Rebuild a diar-lab training dataset from its manifest, per
orders/DIAR-LAB.md "Durability + repeatability" item 2: the manifest is the
source of truth (window_ids, label ids, split, sha256s); the wav/RTTM files
are derived and rebuildable from R2 (audio) + Neon (labels), never stored
only on this box.

Usage:
    python build_dataset.py datasets/<id>.json --out-dir /home/eta/eta-data/diar-train/<id>/

For each window in the manifest:
  1. Re-fetch the label row from Neon by label_id, verify it still matches
     (window_id, engine, run_id) recorded in the manifest.
  2. Download the clip from R2 by clip_r2_key.
  3. Write <window_id>.wav and <window_id>.rttm under out-dir/<ist_date>/.
  4. Compare sha256 of both against the manifest. Report every mismatch;
     exit nonzero if any.

No transcript text or audio content is ever printed — file paths, ids and
hash-match/mismatch status only.
"""
import argparse
import json
import os
import sys

from lib_diar_train import neon_select, fetch_clip_via_scribe, sha256_file, segments_to_rttm


def rebuild_window(entry: dict, out_dir: str) -> dict:
    window_id = entry["window_id"]
    label_id = entry["label_id"]

    rows = neon_select(
        f"SELECT window_id, engine, run_id, segments_json, speaker_count "
        f"FROM diarize_window_label WHERE id = '{label_id}'"
    )
    if not rows:
        return {"window_id": window_id, "ok": False, "reason": "label_id not found in Neon"}
    row = rows[0]
    if row["window_id"] != window_id or row["engine"] != entry["engine"] or row["run_id"] != entry["run_id"]:
        return {"window_id": window_id, "ok": False, "reason": "label row no longer matches manifest (window_id/engine/run_id)"}

    day_dir = os.path.join(out_dir, entry["ist_date"])
    wav_path = os.path.join(day_dir, f"{window_id}.wav")
    rttm_path = os.path.join(day_dir, f"{window_id}.rttm")

    try:
        fetch_clip_via_scribe(window_id, wav_path)
    except RuntimeError as e:
        return {"window_id": window_id, "ok": False, "reason": str(e)}

    segments = row["segments_json"] if isinstance(row["segments_json"], list) else json.loads(row["segments_json"])
    segments_to_rttm(window_id, segments, rttm_path)

    audio_sha = sha256_file(wav_path)
    rttm_sha = sha256_file(rttm_path)
    ok = audio_sha == entry["audio_sha256"] and rttm_sha == entry["rttm_sha256"]
    return {
        "window_id": window_id, "ok": ok,
        "audio_sha_match": audio_sha == entry["audio_sha256"],
        "rttm_sha_match": rttm_sha == entry["rttm_sha256"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest", help="path to datasets/<id>.json")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    with open(args.manifest) as f:
        manifest = json.load(f)

    results = []
    for entry in manifest["windows"]:
        r = rebuild_window(entry, args.out_dir)
        results.append(r)
        status = "OK" if r["ok"] else f"MISMATCH/FAIL ({r.get('reason', 'hash mismatch')})"
        print(f"{r['window_id']}: {status}", file=sys.stderr)

    n_ok = sum(1 for r in results if r["ok"])
    print(f"# rebuilt {n_ok}/{len(results)} windows OK, dataset_id={manifest['dataset_id']}", file=sys.stderr)
    if n_ok != len(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
