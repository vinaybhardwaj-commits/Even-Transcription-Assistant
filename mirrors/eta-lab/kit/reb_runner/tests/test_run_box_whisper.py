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
print("1/5 process_window OK: all 3 whisper variants written for one claimed window")

assert task_queue.is_done(ROOT, driver.QUEUE_NAME, WIN)
print("2/5 queue OK: window marked done after a successful run")

did_work_again = driver.process_window(ROOT, window_desc, owner="test-worker-2")
assert did_work_again is False, "a done window must not be reprocessed by a second worker"
tracks_again = win_reload = load_window(WIN, ist_date="2026-09-26", root=ROOT).tracks(layer="stt", latest_ok=False)
assert len(tracks_again) == 3, "a no-op re-attempt must not create duplicate/extra track files"
print("3/5 no-op re-attempt OK: a done window is skipped, no duplicate tracks written")

# --- eta-refuter-2 #4807: a partial-completion resume must SKIP the engine call for variants already
# written and verified, not just swallow TrackExistsError after re-running them -------------------
WIN2 = "w_partial_resume"
window_desc2 = {**window_desc, "window_id": WIN2,
                "manifest_stub": {**window_desc["manifest_stub"], "window_id": WIN2}}
pre_track = w.build_track(WIN2, WAV, 10000, "whisper-auto", machine="pre-existing")
from reb.writer import write_track as _write_track
_write_track(ROOT, "2026-09-26", "room_jwyrr4dc", WIN2, pre_track, manifest_stub=window_desc2["manifest_stub"])

call_count = {"n": 0}
_real_call = w._call_whisper
def counting_call(*a, **k):
    call_count["n"] += 1
    return _real_call(*a, **k)
w._call_whisper = counting_call
did_work2 = driver.process_window(ROOT, window_desc2, owner="test-worker-3")
assert did_work2 is True
# whisper-auto needed 0 chunk calls (already written+verified, skipped entirely); forced-en + cap2 each
# need 1 chunk call for this 10s clip -> exactly 2 calls total, not 3
assert call_count["n"] == 2, f"expected the already-written variant's engine call to be skipped, got {call_count['n']} calls"
tracks2 = load_window(WIN2, ist_date="2026-09-26", root=ROOT).tracks(layer="stt")
assert sorted(t.engine for t in tracks2) == sorted(w.VARIANTS)
w._call_whisper = _real_call
print("4/5 partial-resume OK: an already-written+verified variant is never re-run through the engine")

# --- eta-refuter-3 #4799 B3: a track file on disk that the manifest does NOT list must never be
# silently treated as done -- refuse loudly instead of mark_done blind ------------------------------
WIN3 = "w_orphaned_track"
window_desc3 = {**window_desc, "window_id": WIN3,
                "manifest_stub": {**window_desc["manifest_stub"], "window_id": WIN3}}
orphan_track = w.build_track(WIN3, WAV, 10000, "whisper-auto")
_, cfg_hash = w.expected_config("whisper-auto")
from reb.writer import track_filename
window_dir = os.path.join(ROOT, "2026-09-26", "room_jwyrr4dc", WIN3)
tracks_dir = os.path.join(window_dir, "tracks")
os.makedirs(tracks_dir, exist_ok=True)
orphan_path = os.path.join(tracks_dir, track_filename("stt", "whisper-auto", w.VERSION, cfg_hash))
with open(orphan_path, "w") as f:
    json.dump(orphan_track, f)
# deliberately NOT writing a manifest.json at all -- the exact "file exists, manifest doesn't know" gap
try:
    driver.process_window(ROOT, window_desc3, owner="test-worker-4")
    raise AssertionError("expected the orphaned track to be refused, not silently marked done")
except RuntimeError as e:
    assert "orphaned track" in str(e)
assert not task_queue.is_done(ROOT, driver.QUEUE_NAME, WIN3), "an orphan-detection failure must not mark the window done"
print("5/5 orphan-detection OK: a track on disk the manifest doesn't list is refused, never silently marked done")

shutil.rmtree(ROOT, ignore_errors=True)
os.unlink(WAV)
print("ALL RUN_BOX_WHISPER DRIVER TESTS OK")
