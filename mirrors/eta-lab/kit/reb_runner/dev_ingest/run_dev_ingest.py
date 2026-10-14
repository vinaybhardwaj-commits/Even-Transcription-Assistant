#!/usr/bin/env python3
"""Run the clinical1/label200 DEV ingest (Fable ruling 27 Sep 16:20): whisper (box, 3 variants) +
SraVaani + IndicConformer-CTC kn/hi/ta/te/ml (box twins) for each of the 222 catalog windows.
diar/acoustics are deliberately not written for these windows (Fable's instruction: "not_present") —
a reader doing tracks(layer="diar") on a DEV window correctly gets [] (never-attempted), which is a
distinct, honest signal from a written "failed" track.

    python3 run_dev_ingest.py /tmp/dev_ingest_catalog.json [--limit N] [--start-at IDX]

Known limitation (disclosed, not silently accepted): if an individual engine call raises (network
error, decode failure), this driver logs it and moves on to the next engine for that window WITHOUT
writing a "failed" status track for the one that raised — unlike a clean empty/ok result, which
always gets written. A window whose whisper call succeeded but whose sravaani call raised will show
sravaani as absent (tracks(layer="stt", engine="sravaani") == []), not as a visible failure. This is
an acceptable gap for a one-off DEV ingest of already-known-good local audio; it would not be
acceptable for the real backfill, where run_box_whisper.py's own per-window queue failure handling
(and its TrackExistsError-swallowing partial-retry) is the pattern to follow instead.
"""
import argparse
import json
import os
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from reb.writer import TrackExistsError, write_track
from reb_runner import task_queue
from reb_runner.engines import box_twin, whisper

QUEUE_NAME = "dev-ingest"


def default_owner():
    return f"{socket.gethostname()}:{os.getpid()}"


def _write(root, w, track, stub, label):
    try:
        write_track(root, w["ist_date"], w["room_id"], w["window_id"], track, manifest_stub=stub)
        print(f"    [{label}] {track['status']}", flush=True)
    except TrackExistsError:
        print(f"    [{label}] already written, skipped", flush=True)


def process_window(root, w, owner=None):
    owner = owner or default_owner()
    window_id = w["window_id"]
    if not task_queue.claim(root, QUEUE_NAME, window_id, owner):
        return False
    stub = w["manifest_stub"]
    duration_ms = stub["t1_ms"] - stub["t0_ms"]
    wav_path = w["wav_path"]
    print(f"[{window_id}] room={w['room_id']} dur={duration_ms}ms source_kind={stub['source_kind']}", flush=True)

    for variant in whisper.VARIANTS:
        try:
            track = whisper.build_track(window_id, wav_path, duration_ms, variant, machine="box")
            _write(root, w, track, stub, variant)
        except Exception as e:
            print(f"    [{variant}] FAILED (no track written): {type(e).__name__}: {e}", flush=True)

    try:
        track = box_twin.finalize_single_span(box_twin.build_sravaani_track(window_id, wav_path), duration_ms)
        _write(root, w, track, stub, "sravaani")
    except Exception as e:
        print(f"    [sravaani] FAILED (no track written): {type(e).__name__}: {e}", flush=True)

    for lang in box_twin.INDIC_LANGS:
        try:
            track = box_twin.finalize_single_span(box_twin.build_indic_ctc_track(window_id, wav_path, lang), duration_ms)
            _write(root, w, track, stub, f"indic-ctc-{lang}")
        except Exception as e:
            print(f"    [indic-ctc-{lang}] FAILED (no track written): {type(e).__name__}: {e}", flush=True)

    task_queue.mark_done(root, QUEUE_NAME, window_id)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("catalog_json")
    ap.add_argument("--root", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--start-at", type=int, default=0)
    args = ap.parse_args()

    import reb as reb_pkg
    root = args.root or reb_pkg.reb.DEFAULT_ROOT
    windows = json.load(open(args.catalog_json))[args.start_at:]
    if args.limit:
        windows = windows[: args.limit]
    owner = default_owner()

    t0 = time.time()
    done = skipped = 0
    for i, w in enumerate(windows):
        did = process_window(root, w, owner=owner)
        done += did
        skipped += not did
        elapsed = time.time() - t0
        print(f"=== {i+1}/{len(windows)} done={done} skipped={skipped} elapsed={elapsed:.0f}s ===", flush=True)
    print(f"INGEST COMPLETE: {done} processed, {skipped} skipped (already claimed/done), {time.time()-t0:.0f}s total", flush=True)


if __name__ == "__main__":
    main()
