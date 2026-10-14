#!/usr/bin/env python3
"""orders/VAD-V3.md "Scale the test set" (herdr-kit). Export every pyannote.ai-
labelled window (diarize_window_label, engine=pyannoteai) that has clip audio,
stratified by room, to gcp-l4 and orbox3 under ~/eta-lab-night/vad-v3/data/.
Manifest (ids only, no audio, no transcript text) written to eta-lab git.

Audio comes via kit/clip-fetch.py (Scribe MCP, read-scope) not direct R2 --
real R2 keys exist only in Vercel prod (confirmed 23 Sep, .env.local's values
are placeholders). Fetched here, pushed onward to gcp-l4/orbox3 over the
box's own SSH keys via scp, never kept on the Mini past the relay hop.

Run from an Even-Transcription-Assistant checkout on the Mini.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clip_fetch_core import fetch_window_clip, ClipFetchError, neon_select  # noqa: E402


def sha256_file(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

STAGING = os.path.expanduser("~/dev/eta-lab/scratch/vad-v3-staging")
MANIFEST_PATH = os.path.expanduser("~/dev/eta-lab/datasets/vad-v3-test-set.json")
TARGETS = ["gcp-l4", "orbox3"]  # ssh aliases, both already reachable from the Mini
REMOTE_DIR = "eta-lab-night/vad-v3/data"

# Same permanent-test list nightly_export.py uses (V's 5 hand-checked + the 20
# bake windows) -- never re-exported here, they're the ORIGINAL small set this
# order is trying to scale past, not part of the new 200(-target).
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


def main():
    rows = neon_select(
        "SELECT l.id as label_id, l.window_id, l.room_day_id, l.engine, l.model, "
        "d.room_id, d.ist_date, w.clip_r2_key "
        "FROM diarize_window_label l "
        "JOIN room_day d ON d.id = l.room_day_id "
        "JOIN room_diarize_window w ON w.window_id = l.window_id "
        "WHERE l.engine = 'pyannoteai' AND w.clip_r2_key IS NOT NULL "
        "ORDER BY d.room_id, l.created_at"
    )
    rows = [r for r in rows if r["window_id"] not in PERMANENT_TEST_WINDOW_IDS]

    by_room = {}
    for r in rows:
        by_room.setdefault(r["room_id"], []).append(r)

    print(f"# available (new, non-permanent-test): {len(rows)} windows across {len(by_room)} rooms",
          file=sys.stderr)
    short_rooms = {rm: len(ws) for rm, ws in by_room.items() if len(ws) < 10}
    if short_rooms:
        print(f"# SHORTFALL vs order (>=10/room, 200 total): only {len(rows)} windows exist "
              f"in the DB with a pyannoteai label + clip audio at all, across {len(by_room)} "
              f"rooms -- {len(short_rooms)} of them under 10: {short_rooms}. Exporting everything "
              f"available rather than stretching to a target the data can't support.",
              file=sys.stderr)

    os.makedirs(STAGING, exist_ok=True)
    manifest = {"dataset_id": f"vad-v3-test-set-{time.strftime('%Y-%m-%d')}",
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "requested": {"count": 200, "min_per_room": 10},
                "available": {"count": len(rows), "rooms": len(by_room)},
                "windows": []}

    for r in rows:
        window_id = r["window_id"]
        ext = os.path.splitext(r["clip_r2_key"])[1] or ".webm"
        local_path = os.path.join(STAGING, f"{window_id}{ext}")
        try:
            fetch_window_clip(window_id, local_path)
        except ClipFetchError as e:
            print(f"{window_id}: SKIP ({e})", file=sys.stderr)
            continue

        sha = sha256_file(local_path)
        for target in TARGETS:
            subprocess.run(
                ["ssh", target, f"mkdir -p {REMOTE_DIR}/{r['ist_date']}"],
                check=True, capture_output=True, timeout=20,
            )
            subprocess.run(
                ["scp", "-q", local_path, f"{target}:{REMOTE_DIR}/{r['ist_date']}/{window_id}{ext}"],
                check=True, capture_output=True, timeout=60,
            )
        os.remove(local_path)  # never keep clip audio on the Mini beyond the relay hop

        manifest["windows"].append({
            "window_id": window_id, "room_day_id": r["room_day_id"], "room_id": r["room_id"],
            "ist_date": str(r["ist_date"]), "label_id": r["label_id"], "engine": r["engine"],
            "model": r["model"], "clip_r2_key": r["clip_r2_key"], "audio_sha256": sha,
        })
        print(f"{window_id}: exported to {TARGETS} (room={r['room_id']})", file=sys.stderr)

    os.makedirs(os.path.dirname(MANIFEST_PATH), exist_ok=True)
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"# WROTE {MANIFEST_PATH} ({len(manifest['windows'])} windows)", file=sys.stderr)


if __name__ == "__main__":
    main()
