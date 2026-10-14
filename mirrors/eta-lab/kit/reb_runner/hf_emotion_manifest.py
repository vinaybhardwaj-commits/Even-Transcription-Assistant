#!/usr/bin/env python3
"""Box-side manifest builder for REB's emotion layer (Fable's T-REB order, 28 Sep): for one ist_date,
lists every real-room window that doesn't already have an ok emotion.wavlm track, and for each one
resolves its speaker turns from the window's diar track (pyannote.ai, REB's layer of record per
RULINGS 13:22) — or a single whole-window turn if no diar track has landed yet for that window.

Does NOT touch audio at all: hf-fleet/reb are already uploading the real room audio for the REB
backfill (Fable's order: "no second upload"), so this only emits WHICH windows/turns need the
emotion layer — the "manifest" half of "write the script + manifest" (the other half is
hf_emotion_job.py, which runs on the HF side against that already-uploaded audio). This script never
calls write_track() (only box-side hf_emotion_collect.py does, per DESIGN.md's "box is the sole
writer") and never uploads or transmits any audio or text itself — read-only against the local REB
root.

    python3 hf_emotion_manifest.py 2026-09-26 --out windows_turns_26sep.json
    python3 hf_emotion_manifest.py 2026-09-27 --out windows_turns_27sep.json

Output: a JSON list of {"window_id", "ist_date", "room_id", "t0_ms", "t1_ms", "turns":
[[t0_ms, t1_ms, speaker_or_null], ...], "manifest_stub": {...}} objects — manifest_stub is REB-SPEC
section 2's shape (window_id/room_id/room_slug/ist_date/t0_ms/t1_ms/audio), passed straight through
to write_track() by hf_emotion_collect.py on the first write for a window. `turns` already has the
diar-vs-whole-window fallback applied (emotion_wavlm.turns_from_diar_segments) so the HF-side job
never needs REB root access to decide that.
"""
import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reb.reb import DEFAULT_ROOT, load_window
from reb.schema import DEFAULT_SOURCE_KIND
from reb_runner.engines import emotion_wavlm


def _windows_for_date(root, ist_date):
    """Every (room_id, window_id) ever indexed for this date, deduped, in index order. Reads
    index.jsonl directly (reb.py has no "list windows for a date" helper) rather than walking the
    directory tree, so a window with only a manifest.lock/partial write (no committed index line)
    is never mistaken for a real one."""
    index_path = os.path.join(root, ist_date, "index.jsonl")
    seen = {}
    if not os.path.exists(index_path):
        return []
    with open(index_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            seen[rec["window_id"]] = rec["room_id"]
    return sorted(seen.items())


def _has_ok_emotion_track(window):
    for t in window.tracks(layer="emotion", engine="wavlm"):
        if t.status == "ok":
            return True
    return False


# Fable's ruling (29 Sep): pyannote-local-twin is the diar engine of record for every layer; pyannote.ai
# prod is not on the approved patient-data vendor list. Any other engine's diar track is ignored.
DIAR_ENGINE = "pyannote-local-twin"


def _diar_segments(window):
    chosen = next((t for t in window.tracks(layer="diar") if t.entry.get("engine") == DIAR_ENGINE), None)
    if chosen is None or chosen.status != "ok":
        return None
    return chosen.segments


def build_manifest(root, ist_date, skipped=None):
    """skipped, if a list, collects window_ids dropped for diar_out_of_range."""
    out = []
    for window_id, room_id in _windows_for_date(root, ist_date):
        window = load_window(window_id, ist_date=ist_date, room_id=room_id, root=root)
        if window.source_kind != DEFAULT_SOURCE_KIND:
            continue  # suite_synthetic / dev_clip windows are out of scope for the real-room backfill
        if _has_ok_emotion_track(window):
            continue
        diar_segments = _diar_segments(window)
        try:
            turns = emotion_wavlm.turns_from_diar_segments(diar_segments, window.t0_ms, window.t1_ms)
        except ValueError:
            if skipped is not None:
                skipped.append(window.window_id)
            continue
        stub = {
            "window_id": window.window_id, "room_id": window.room_id, "room_slug": window.room_slug,
            "ist_date": window.ist_date, "t0_ms": window.t0_ms, "t1_ms": window.t1_ms,
            "audio": window.audio,
        }
        out.append({
            "window_id": window.window_id, "ist_date": window.ist_date, "room_id": window.room_id,
            "t0_ms": window.t0_ms, "t1_ms": window.t1_ms,
            "turns": [[t0, t1, sp] for t0, t1, sp in turns],
            "manifest_stub": stub,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ist_date")
    ap.add_argument("--root", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    root = args.root or DEFAULT_ROOT
    skipped = []
    manifest = build_manifest(root, args.ist_date, skipped)
    with open(args.out, "w") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    with_diar = sum(1 for w in manifest if len(w["turns"]) > 1 or (w["turns"] and w["turns"][0][2] is not None))
    print(f"[hf_emotion_manifest] {args.ist_date}: {len(manifest)} windows to do "
          f"({with_diar} with diar turns, {len(manifest) - with_diar} whole-window fallback)")
    if skipped:
        print(f"[hf_emotion_manifest] diar_out_of_range, skipped {len(skipped)}: {skipped}")


if __name__ == "__main__":
    sys.exit(main())
