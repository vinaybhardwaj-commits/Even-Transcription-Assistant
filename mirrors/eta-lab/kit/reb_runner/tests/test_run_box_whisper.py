#!/usr/bin/env python3
"""End-to-end (still offline) test of run_box_whisper's driver: claim -> 3 whisper variants ->
write_track -> mark_done, and that a second attempt on the same window is a no-op."""
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from reb.reb import load_window
from reb_runner import run_box_whisper as driver
from reb_runner import task_queue
from reb_runner.engines import whisper as w

ROOT = tempfile.mkdtemp(prefix="reb-driver-test-")
WAV = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                 "-t", "10", WAV], check=True)

# offline: no real whisper-server call
w._call_whisper = lambda *a, **k: {"segments": [{"start": 0.1, "end": 0.5, "text": "hi"}],
                                    "language_probabilities": {"en": 0.99}}

WIN = "w_driver_test"
window_desc = {
    "window_id": WIN, "ist_date": "2026-09-26", "room_id": "room_jwyrr4dc", "wav_path": WAV,
    "manifest_stub": {
        "window_id": WIN, "room_id": "room_jwyrr4dc", "room_slug": "orb3-29ac", "ist_date": "2026-09-26",
        "t0_ms": 0, "t1_ms": 10000,
        "audio": {"r2_key": "bench/orb3/x.webm", "sha256": "ab" * 32, "sample_rate": 16000, "duration_ms": 10000},
    },
}

did_work = driver.process_window(ROOT, window_desc, owner="test-worker-1")
assert did_work is True
win = load_window(WIN, ist_date="2026-09-26", root=ROOT)
tracks = win.tracks(layer="stt")
assert sorted(t.engine for t in tracks) == sorted(w.VARIANTS), [t.engine for t in tracks]
assert all(t.status == "ok" for t in tracks)
print("1/3 process_window OK: all 3 whisper variants written for one claimed window")

assert task_queue.is_done(ROOT, driver.QUEUE_NAME, WIN)
print("2/3 queue OK: window marked done after a successful run")

did_work_again = driver.process_window(ROOT, window_desc, owner="test-worker-2")
assert did_work_again is False, "a done window must not be reprocessed by a second worker"
tracks_again = win_reload = load_window(WIN, ist_date="2026-09-26", root=ROOT).tracks(layer="stt", latest_ok=False)
assert len(tracks_again) == 3, "a no-op re-attempt must not create duplicate/extra track files"
print("3/3 no-op re-attempt OK: a done window is skipped, no duplicate tracks written")

shutil.rmtree(ROOT, ignore_errors=True)
os.unlink(WAV)
print("ALL RUN_BOX_WHISPER DRIVER TESTS OK")
