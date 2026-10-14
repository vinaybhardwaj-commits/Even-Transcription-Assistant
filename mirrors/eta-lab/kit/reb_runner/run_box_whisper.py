#!/usr/bin/env python3
"""Driver: claims windows for the "box-whisper" queue and runs all 3 whisper passes for each,
writing tracks via kit/reb. Fan-out is by WINDOW (Fable 15:22): one claim = one window = all 3
whisper variants for it, run sequentially by this worker, before moving to the next window. Run
several instances of this script (same or different machines that can reach box's whisper-server AND
share the same REB root filesystem — see task_queue.py's module docstring on what this queue does and
doesn't coordinate across hosts) to parallelize across windows — the queue's claim-once semantics keep
them from duplicating work.

Deliberately does NOT know how to enumerate "which windows need doing" (that's step 4's window
catalog / backfill logic) — it takes a list of window descriptors and processes exactly those.

    python3 run_box_whisper.py windows.json [--queue box-whisper] [--owner name]

windows.json: a list of {"window_id", "ist_date", "room_id", "wav_path", "manifest_stub"} objects
(manifest_stub is REB-SPEC-v1.md section 2's manifest shape: window_id/room_id/room_slug/ist_date/
t0_ms/t1_ms/audio).

Long single windows: nothing here calls task_queue.renew() yet (eta-refuter-2 #4807, eta-refuter-3
#4797: noted, not wired in). 3 whisper passes over a long window on a loaded CPU could in principle
exceed the default 30-minute lease and get stolen out from under a still-alive worker; renew() exists
for whoever wires up a heartbeat once that's observed to actually happen, not preemptively guessed at.
"""
import argparse
import json
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reb.writer import MirrorPendingError, TrackExistsError, track_filename, write_track
from reb_runner import task_queue
from reb_runner.engines import whisper

QUEUE_NAME = "box-whisper"


def default_owner():
    return f"{socket.gethostname()}:{os.getpid()}"


def _already_written(root, ist_date, room_id, window_id, variant):
    """(is_done, expected_path) for one variant, checked WITHOUT running the engine (eta-refuter-2
    #4807: "check for the existing track BEFORE running the engine — saves ~10 T4 calls per variant").
    is_done is only True if the file exists on disk AND the manifest actually lists it — a file on
    disk that the manifest doesn't know about is the exact crash eta-refuter-3's B3 described (a dead
    worker between the track-file link and the manifest write), and must never be silently treated as
    "done"."""
    _, cfg_hash = whisper.expected_config(variant)
    window_dir = os.path.join(root, ist_date, room_id, window_id)
    expected_path = os.path.join(window_dir, "tracks", track_filename("stt", variant, whisper.VERSION, cfg_hash))
    if not os.path.exists(expected_path):
        return False, expected_path
    manifest_path = os.path.join(window_dir, "manifest.json")
    rel = os.path.relpath(expected_path, root)
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        if any(e.get("path") == rel for e in manifest.get("tracks", [])):
            return True, expected_path
    raise RuntimeError(
        f"{expected_path} exists on disk but is NOT listed in {manifest_path} — an orphaned track "
        "from an earlier crash (eta-refuter-3 #4799 B3). Needs manual repair (delete the orphan and "
        "retry, or add its manifest entry by hand); refusing to mark this window done blind."
    )


def process_window(root, w, queue_name=QUEUE_NAME, owner=None):
    """Returns True if this call did the work, False if the window was already claimed/done
    elsewhere (not an error — just means another worker has it or already finished it)."""
    owner = owner or default_owner()
    window_id = w["window_id"]
    token = task_queue.claim(root, queue_name, window_id, owner)
    if not token:
        return False
    stub = w["manifest_stub"]
    duration_ms = stub["t1_ms"] - stub["t0_ms"]
    mirror_pending = []
    try:
        for variant in whisper.VARIANTS:
            done, _expected_path = _already_written(root, w["ist_date"], w["room_id"], window_id, variant)
            if done:
                continue  # verified already there — never re-run a whisper pass just to hit TrackExistsError
            track = whisper.build_track(window_id, w["wav_path"], duration_ms, variant, machine=owner)
            try:
                write_track(root, w["ist_date"], w["room_id"], window_id, track, manifest_stub=stub)
            except TrackExistsError:
                pass  # someone else wrote it between our check and now (a genuine race, not a bug)
            except MirrorPendingError as e:
                # local data IS committed and correct — this is NOT a failure of the window (eta-
                # refuter-2 #4807: "treat it as done-with-mirror-pending instead").
                mirror_pending.append(str(e))
        task_queue.mark_done(root, queue_name, window_id, token,
                              mirror_pending=mirror_pending or None)
        return True
    except Exception as e:
        task_queue.mark_failed(root, queue_name, window_id, token, e)
        task_queue.release(root, queue_name, window_id, token)  # let another attempt retry without waiting out the lease
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
