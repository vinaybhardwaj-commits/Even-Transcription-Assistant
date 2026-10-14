#!/usr/bin/env python3
"""Regression tests for router-fix/lid-debug's #4751/#4752: Window.tracks(latest_ok=True) (the
default) must never silently omit a failed/skipped run, and must not lose good "ok" evidence just
because a later re-run of the same engine failed."""
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import reb as reb_pkg
from reb.writer import config_hash, write_track

ROOT = tempfile.mkdtemp(prefix="reb-trackstatus-")
DATE, ROOM = "2026-09-26", "room_jwyrr4dc"


def stub(win):
    return {
        "window_id": win, "room_id": ROOM, "room_slug": "orb3-29ac", "ist_date": DATE,
        "t0_ms": 0, "t1_ms": 300000,
        "audio": {"r2_key": "bench/orb3/x.webm", "sha256": "ab" * 32, "sample_rate": 16000, "duration_ms": 300000},
    }


def track(win, engine, attempt, status="ok", text="hi"):
    cfg = {"attempt": attempt}
    body = {
        "schema": "reb.track.v1", "window_id": win, "layer": "stt", "engine": engine,
        "model": "m", "version": "v1", "config": cfg, "config_hash": config_hash(cfg),
        "machine": "box", "status": status,
    }
    if status == "ok":
        body["segments"] = [{"t0_ms": 0, "t1_ms": 1000, "text": text}]
    else:
        body["reason"] = "simulated failure"
    return body


def write(win, engine, attempt, status, text="hi", finished_at=None):
    write_track(ROOT, DATE, ROOM, win, track(win, engine, attempt, status, text),
                manifest_stub=stub(win), finished_at=finished_at)


# --- ok-then-failed: the ok evidence must still be returned, failure attached, not lost ------------
win = "w_ok_then_failed"
write(win, "whisper-auto", 1, "ok", text="first pass", finished_at="2026-09-27T10:00:00Z")
write(win, "whisper-auto", 2, "failed", finished_at="2026-09-27T11:00:00Z")
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
ts = w.tracks(layer="stt")
assert len(ts) == 1, [t.entry for t in ts]
t = ts[0]
assert t.status == "ok" and t.segments[0]["text"] == "first pass", "the earlier ok run must still be the evidence"
assert t.superseded_by is not None and t.superseded_by["status"] == "failed", "the later failure must be attached, not hidden"
print("ok-then-failed OK: ok evidence returned, later failure attached as superseded_by")

# --- failed-then-ok: no superseded_by, the ok run (which is also latest) is just returned normally -
win = "w_failed_then_ok"
write(win, "whisper-auto", 1, "failed", finished_at="2026-09-27T10:00:00Z")
write(win, "whisper-auto", 2, "ok", text="second pass", finished_at="2026-09-27T11:00:00Z")
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
ts = w.tracks(layer="stt")
assert len(ts) == 1
t = ts[0]
assert t.status == "ok" and t.segments[0]["text"] == "second pass"
assert t.superseded_by is None, "an ok run that IS the latest must not show a phantom supersession"
print("failed-then-ok OK: latest ok run returned cleanly, no false superseded_by")

# --- failed-only: never silently omitted (the #4751 bug) -------------------------------------------
win = "w_failed_only"
write(win, "whisper-auto", 1, "failed", finished_at="2026-09-27T10:00:00Z")
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
ts = w.tracks(layer="stt")
assert len(ts) == 1, "a failed-only engine must still appear (distinguishable from never-written)"
t = ts[0]
assert t.status == "failed" and t.reason == "simulated failure"
assert t.superseded_by is None
print("failed-only OK: a failed track with no ok run is visible, not dropped")

# --- never-written stays genuinely absent (distinct from failed) -----------------------------------
w = reb_pkg.load_window("w_failed_only", ist_date=DATE, root=ROOT)
assert w.tracks(layer="stt", engine="does-not-exist") == [], "an engine that never ran must return []"
print("never-written OK: an engine that never ran returns [], distinct from a visible failure")

# --- latest_ok=False is untouched: full history, every status ---------------------------------------
win = "w_ok_then_failed"
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
allts = w.tracks(layer="stt", latest_ok=False)
assert sorted(t.status for t in allts) == ["failed", "ok"], [t.status for t in allts]
print("latest_ok=False OK: full history unaffected")

shutil.rmtree(ROOT, ignore_errors=True)
print("ALL OK: tracks(latest_ok=True) never silently drops a failed/skipped run (#4751/#4752)")
