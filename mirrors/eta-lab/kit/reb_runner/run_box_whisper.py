#!/usr/bin/env python3
"""Driver: claims windows for the "box-whisper" queue and runs all 3 whisper passes for each,
writing tracks via kit/reb. Fan-out is by WINDOW (Fable 15:22): one claim = one window = all 3
whisper variants for it, run sequentially by this worker, before moving to the next window. Run
several instances of this script (same or different machines that can reach box's whisper-server)
to parallelize across windows — the queue's claim-once semantics keep them from duplicating work.

Deliberately does NOT know how to enumerate "which windows need doing" (that's step 4's window
catalog / backfill logic) — it takes a list of window descriptors and processes exactly those.

    python3 run_box_whisper.py windows.json [--queue box-whisper] [--owner name]

windows.json: a list of {"window_id", "ist_date", "room_id", "wav_path", "manifest_stub"} objects
(manifest_stub is REB-SPEC-v1.md section 2's manifest shape: window_id/room_id/room_slug/ist_date/
t0_ms/t1_ms/audio).
"""
import argparse
import json
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reb.writer import TrackExistsError, write_track
from reb_runner import task_queue
from reb_runner.engines import whisper

QUEUE_NAME = "box-whisper"


def default_owner():
    return f"{socket.gethostname()}:{os.getpid()}"


def process_window(root, w, queue_name=QUEUE_NAME, owner=None):
    """Returns True if this call did the work, False if the window was already claimed/done
    elsewhere (not an error — just means another worker has it or already finished it)."""
    owner = owner or default_owner()
    window_id = w["window_id"]
    if not task_queue.claim(root, queue_name, window_id, owner):
        return False
    stub = w["manifest_stub"]
    duration_ms = stub["t1_ms"] - stub["t0_ms"]
    try:
        for variant in whisper.VARIANTS:
            track = whisper.build_track(window_id, w["wav_path"], duration_ms, variant, machine=owner)
            try:
                write_track(root, w["ist_date"], w["room_id"], window_id, track, manifest_stub=stub)
            except TrackExistsError:
                pass  # a previous attempt already wrote this exact (engine, config) — append-only, fine
        task_queue.mark_done(root, queue_name, window_id)
        return True
    except Exception as e:
        task_queue.mark_failed(root, queue_name, window_id, e)
        task_queue.release(root, queue_name, window_id)  # let another attempt retry without waiting out the lease
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("windows_json")
    ap.add_argument("--root", default=None, help="REB root (default: reb.DEFAULT_ROOT / $REB_ROOT)")
    ap.add_argument("--queue", default=QUEUE_NAME)
    ap.add_argument("--owner", default=None)
    args = ap.parse_args()

    import reb as reb_pkg
    root = args.root or reb_pkg.reb.DEFAULT_ROOT
    windows = json.load(open(args.windows_json))
    owner = args.owner or default_owner()

    done = skipped = failed = 0
    for w in windows:
        try:
            if process_window(root, w, queue_name=args.queue, owner=owner):
                done += 1
                print(f"[box-whisper] done {w['window_id']}", flush=True)
            else:
                skipped += 1
                print(f"[box-whisper] skip {w['window_id']} (claimed/done elsewhere)", flush=True)
        except Exception as e:
            failed += 1
            print(f"[box-whisper] FAILED {w['window_id']}: {type(e).__name__}: {e}", flush=True)
    print(f"[box-whisper] summary: done={done} skipped={skipped} failed={failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
