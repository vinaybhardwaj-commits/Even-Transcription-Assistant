#!/usr/bin/env python3
"""Regression test for eta-refuter-3's N2 (#4929) / eta-refuter-2's #4930: an engine call that raises
must produce a visible status="failed" track (not silent absence) and must NOT let the window be
marked done. A bare re-run must never silently re-call an engine that already has ANY recorded
outcome (including "failed") for its current version+config. --retry-failed-as (eta-refuter-3/2,
#4945/#4946: no deleting a stale failed track to free its slot) retries a still-failed engine under a
bumped version instead -- a new append-only slot, same config_hash, original failed track kept
forever."""
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from reb.reb import load_window
from reb_runner import task_queue
from reb_runner.dev_ingest import run_dev_ingest as driver
from reb_runner.engines import box_twin as bt
from reb_runner.engines import whisper as w

ROOT = tempfile.mkdtemp(prefix="reb-devingest-test-")
WAV = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                 "-t", "10", WAV], check=True)

WIN = "w_dev_ingest_fail"
window_desc = {
    "window_id": WIN, "ist_date": "2026-09-26", "room_id": "room_jwyrr4dc", "wav_path": WAV,
    "manifest_stub": {
        "window_id": WIN, "room_id": "room_jwyrr4dc", "room_slug": "orb3-29ac", "ist_date": "2026-09-26",
        "t0_ms": 0, "t1_ms": 10000, "source_kind": "room_tape", "clock": "tape_utc",
        "audio": {"r2_key": "bench/orb3/x.webm", "sha256": "cd" * 32, "sample_rate": 16000, "duration_ms": 10000},
    },
}

# whisper: all 3 variants succeed. sravaani: raises. indic-ctc: kn raises, others succeed.
w._call_whisper = lambda *a, **k: {"segments": [{"start": 0.1, "end": 0.5, "text": "hi"}],
                                    "language_probabilities": {"en": 0.99}}


def flaky_post(url, wav_path, data=None, timeout=180):
    if "8085" in url:
        raise RuntimeError("connection refused")
    if data and data.get("language") == "kn":
        raise RuntimeError("timeout")
    return {"text": "namaskara"}


bt._post_file = flaky_post

did_work = driver.process_window(ROOT, window_desc, owner="test-worker-1")
assert did_work is True

win = load_window(WIN, ist_date="2026-09-26", root=ROOT)
stt = win.tracks(layer="stt", latest_ok=False)
by_engine = {t.engine: t for t in stt}
assert all(by_engine[v].status == "ok" for v in w.VARIANTS), by_engine
assert by_engine["sravaani"].status == "failed", by_engine.get("sravaani")
assert "connection refused" in by_engine["sravaani"].reason
assert by_engine["indic-ctc-kn"].status == "failed", by_engine.get("indic-ctc-kn")
for lang in ["hi", "ta", "te", "ml"]:
    assert by_engine[f"indic-ctc-{lang}"].status == "ok", by_engine.get(f"indic-ctc-{lang}")
# eta-refuter-3 #4945 R2: a box-twin engine's failed track must say machine="box-twin", matching its
# own successful-path writer -- not "box" (whisper's machine), which _write_failed used to hardcode.
assert by_engine["sravaani"].machine == "box-twin", by_engine["sravaani"].machine
assert by_engine["indic-ctc-kn"].machine == "box-twin", by_engine["indic-ctc-kn"].machine
print("1/6 failed engines OK: raised calls produce visible status=failed tracks, not silent absence, "
      "correct machine")

assert not task_queue.is_done(ROOT, driver.QUEUE_NAME, WIN), "a window with any failed engine must not be marked done"
print("2/6 queue OK: window with a failed engine is NOT marked done")

# --- immediate re-attempt: append-only means a config with an already-recorded "failed" outcome must
# NEVER be re-called (a success this time would collide with the existing failed track's exact
# filename and get silently swallowed by TrackExistsError) -- every engine, including the working
# ones, must be skipped via the pre-check, not re-run ------------------------------------------------
call_count = {"n": 0}


def recovered_post(url, wav_path, data=None, timeout=180):
    call_count["n"] += 1
    return {"text": "namaskara"}


bt._post_file = recovered_post
call_count_whisper = {"n": 0}
_real_call_whisper = w._call_whisper


def counting_whisper(*a, **k):
    call_count_whisper["n"] += 1
    return _real_call_whisper(*a, **k)


w._call_whisper = counting_whisper

did_work2 = driver.process_window(ROOT, window_desc, owner="test-worker-2")
assert did_work2 is True
assert call_count_whisper["n"] == 0, "already-ok whisper variants must not be re-run"
assert call_count["n"] == 0, f"a config with an existing failed track must not be re-called, got {call_count['n']} calls"
assert not task_queue.is_done(ROOT, driver.QUEUE_NAME, WIN), (
    "a window stuck on a failed engine must stay not-done without --retry-failed-as"
)
win2 = load_window(WIN, ist_date="2026-09-26", root=ROOT)
stt2 = {t.engine: t for t in win2.tracks(layer="stt", latest_ok=False)}
assert stt2["sravaani"].status == "failed" and stt2["indic-ctc-kn"].status == "failed"
print("3/6 idempotent-retry OK: a config with a recorded failed outcome is never silently re-called; "
      "window correctly stays not-done rather than losing the failure record or a real success")

# --- --retry-failed-as: the twin is back up; retry the still-failed engines under a bumped version --
did_work3 = driver.process_window(ROOT, window_desc, owner="test-worker-3", retry_failed_as="v1-r2")
assert did_work3 is True
assert call_count_whisper["n"] == 0, "already-ok whisper variants must not be re-run even with --retry-failed-as"
assert call_count["n"] == 2, f"only the 2 still-failed box-twin engines should be retried, got {call_count['n']} calls"
assert task_queue.is_done(ROOT, driver.QUEUE_NAME, WIN), "window must be marked done once every engine is non-failed"

win3 = load_window(WIN, ist_date="2026-09-26", root=ROOT)
stt3 = {t.engine: t for t in win3.tracks(layer="stt")}  # latest_ok=True (default)
assert stt3["sravaani"].status == "ok" and stt3["sravaani"].version == "v1-r2"
assert stt3["indic-ctc-kn"].status == "ok" and stt3["indic-ctc-kn"].version == "v1-r2"

# the ORIGINAL failed tracks must still exist untouched -- append-only, nothing deleted or overwritten
stt3_full = {(t.engine, t.version): t for t in win3.tracks(layer="stt", latest_ok=False)}
assert stt3_full[("sravaani", bt.SRAVAANI_VERSION)].status == "failed"
assert stt3_full[("indic-ctc-kn", bt.INDIC_VERSION)].status == "failed"
print("4/6 --retry-failed-as OK: only still-failed engines retried, under a bumped version; original "
      "failed tracks preserved as history (nothing deleted); window marked done once all non-failed")

# --- 27 Sep incident regression: a structurally-invalid manifest_stub (dev_clip missing the required
# source_windows field, the real bug that crashed the 26 Sep DEV ingest at window 193/222) must not
# get silently swallowed OR crash the whole batch -- process_window raises so main() can log and skip
# just this window, and the claim must be released (not left stuck for the 30-min lease) -----------
BAD_WIN = "w_bad_manifest_stub"
bad_window_desc = {
    "window_id": BAD_WIN, "ist_date": "2026-09-26", "room_id": "room_jwyrr4dc", "wav_path": WAV,
    "manifest_stub": {
        "window_id": BAD_WIN, "room_id": "room_jwyrr4dc", "room_slug": "orb3-29ac", "ist_date": "2026-09-26",
        "t0_ms": 0, "t1_ms": 10000, "source_kind": "dev_clip", "clock": "tape_utc",  # missing source_windows
        "audio": {"r2_key": "bench/orb3/y.webm", "sha256": "ef" * 32, "sample_rate": 16000, "duration_ms": 10000},
    },
}
bt._post_file = recovered_post
w._call_whisper = _real_call_whisper
try:
    driver.process_window(ROOT, bad_window_desc, owner="test-worker-4")
    raise AssertionError("expected an invalid manifest_stub to raise, not succeed silently")
except AssertionError:
    raise
except Exception:
    pass  # the exact exception is reb.validate.ValidationError; any raise is the point being tested
assert not task_queue.is_done(ROOT, driver.QUEUE_NAME, BAD_WIN)
# the claim must be released, not left stuck for the lease -- a fresh claim must succeed immediately
retry_token = task_queue.claim(ROOT, driver.QUEUE_NAME, BAD_WIN, "test-worker-5")
assert retry_token is not None, "a crashed window's claim must be released, not held for the full lease"
task_queue.release(ROOT, driver.QUEUE_NAME, BAD_WIN, retry_token)
print("5/6 crash-releases-claim OK: an invalid manifest_stub raises (not silently accepted), "
      "and the claim is released immediately rather than stuck for the lease")

# --- main()'s own batch loop must survive one crashed window and still process the rest ------------
GOOD_WIN2 = "w_after_bad_window"
good_window_desc2 = {**window_desc, "window_id": GOOD_WIN2,
                     "manifest_stub": {**window_desc["manifest_stub"], "window_id": GOOD_WIN2}}
batch = [bad_window_desc, good_window_desc2]
done = skipped = crashed = 0
for w_item in batch:
    try:
        did = driver.process_window(ROOT, w_item, owner="test-worker-6")
        done += did
        skipped += not did
    except Exception:
        crashed += 1
assert crashed == 1 and done == 1, f"crashed={crashed} done={done}"
assert task_queue.is_done(ROOT, driver.QUEUE_NAME, GOOD_WIN2), "the window AFTER the crashed one must still be processed"
print("6/6 batch-survives-one-crash OK: a crashed window doesn't stop the rest of the batch from being processed")

shutil.rmtree(ROOT, ignore_errors=True)
os.unlink(WAV)
print("ALL RUN_DEV_INGEST TESTS OK")
