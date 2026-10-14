#!/usr/bin/env python3
"""Build the 222-window catalog for the clinical1/label200 DEV ingest (Fable ruling 27 Sep 16:20;
design: lid-debug #4780/#4784). Read-only: writes only the catalog JSON, touches no REB data.

    python3 build_catalog.py > catalog.json

Each entry: {window_id, ist_date, room_id, wav_path, manifest_stub}, consumed by run_dev_ingest.py.
"""
import glob
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone

DIAG_RIG_CLINICAL1 = os.path.expanduser("~/eta-data/diag-rig/stimuli/clinical1")
LABEL200_AUDIO = os.path.expanduser("~/eta-data/readability/label200-audio")
DEV30_IDS = os.path.expanduser("~/oc/lid-debug/FUSER-DEV30.json")
LABEL200_CLIP_MAP = os.path.expanduser("~/eta-data/readability/r1/label-page-seed/maps200/label200.clip.json")
HIST_RUNS_ROOT = os.path.expanduser("~/eta-data/hist/runs")

INGEST_DATE = "2026-09-27"  # ist_date bucket for clinical1 (synthetic: no real recording date applies)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def probe(path):
    """(duration_ms, sample_rate) via ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=sample_rate",
         "-of", "json", path], capture_output=True, text=True, check=True,
    ).stdout
    d = json.loads(out)
    duration_ms = round(float(d["format"]["duration"]) * 1000)
    sample_rate = int(d["streams"][0]["sample_rate"]) if d.get("streams") else None
    return duration_ms, sample_rate


def build_clinical1():
    suite = json.load(open(os.path.join(DIAG_RIG_CLINICAL1, "suite.json")))
    entries = []
    for item in suite["items"]:
        sid = item["stimulus_id"]
        wav_path = os.path.join(DIAG_RIG_CLINICAL1, f"{sid}.wav")
        duration_ms, sample_rate = probe(wav_path)
        entries.append({
            "window_id": sid, "ist_date": INGEST_DATE, "room_id": "suite-clinical1", "wav_path": wav_path,
            "manifest_stub": {
                "window_id": sid, "room_id": "suite-clinical1", "room_slug": "suite-clinical1",
                "ist_date": INGEST_DATE, "t0_ms": 0, "t1_ms": duration_ms,
                "audio": {"r2_key": f"local:diag-rig/stimuli/clinical1/{sid}.wav",
                          "sha256": sha256_file(wav_path), "sample_rate": sample_rate, "duration_ms": duration_ms},
                "source_kind": "suite_synthetic", "clock": "clip_local",
            },
        })
    return entries


def build_dev30():
    dev30 = json.load(open(DEV30_IDS))
    all_ids = [i for group in dev30["ids"].values() for i in group]
    clip_map = json.load(open(LABEL200_CLIP_MAP))
    entries = []
    for lid in all_ids:
        clip = clip_map[lid]
        run_id, room_id, date, window_id = clip["k"].split("/")
        run_path = os.path.join(HIST_RUNS_ROOT, run_id, room_id, date, f"{window_id}.json")
        run = json.load(open(run_path))
        window_start = datetime.fromisoformat(run["start"]).astimezone(timezone.utc)
        window_start_ms = window_start.timestamp() * 1000
        t0_ms = round(window_start_ms + clip["t0"] * 1000)
        t1_ms = round(window_start_ms + clip["t1"] * 1000)
        gap_s = (run.get("cut") or {}).get("gap_s") or 0.0
        clock = "tape_utc" if gap_s == 0.0 else "approx"

        wav_path = os.path.join(LABEL200_AUDIO, f"{lid}.wav")
        duration_ms, sample_rate = probe(wav_path)
        entries.append({
            "window_id": lid, "ist_date": date, "room_id": room_id, "wav_path": wav_path,
            "manifest_stub": {
                "window_id": lid, "room_id": room_id, "room_slug": room_id, "ist_date": date,
                "t0_ms": t0_ms, "t1_ms": t1_ms,
                "audio": {"r2_key": f"local:readability/label200-audio/{lid}.wav",
                          "sha256": sha256_file(wav_path), "sample_rate": sample_rate, "duration_ms": duration_ms},
                "source_kind": "dev_clip", "clock": clock,
                "source_windows": [{"run_id": run_id, "window_id": window_id}],
            },
        })
    return entries


def main():
    import sys
    clinical1, dev30 = build_clinical1(), build_dev30()
    print(json.dumps(clinical1 + dev30, indent=1))
    print(f"# {len(clinical1)} clinical1 + {len(dev30)} dev30 = {len(clinical1) + len(dev30)} windows", file=sys.stderr)


if __name__ == "__main__":
    main()
