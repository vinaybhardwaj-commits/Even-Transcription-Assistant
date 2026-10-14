#!/usr/bin/env python3
"""Regression tests for router-fix/lid-debug's #4751/#4752 (a failed-only engine must never be
silently omitted) AND eta-refuter-2's #4803 (grouping must include config_hash, not just (layer,
engine), so two different configs of one engine — e.g. a fuser's v0 and v0-noETR arms — never hide
each other) AND eta-refuter-3's #4796 (segments_between must never read a failed track's segments)."""
import json
import os
import shutil
import sys
import tempfile

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


CFG = {"n": 1}  # a FIXED config: write_track refuses a second write of the same (layer,engine,
                # version, config_hash), so simulating "a rerun of the same slot" (for superseded_by
                # to mean anything) must vary VERSION, not config -- exactly the case the append-only
                # writer actually allows to coexist: same config, a version bump.


def track(win, engine, version, status="ok", text="hi", cfg=CFG):
    body = {
        "schema": "reb.track.v1", "window_id": win, "layer": "stt", "engine": engine,
        "model": "m", "version": version, "config": cfg, "config_hash": config_hash(cfg),
        "machine": "box", "status": status,
    }
    if status == "ok":
        body["segments"] = [{"t0_ms": 0, "t1_ms": 1000, "text": text}]
    else:
        body["reason"] = "simulated failure"
    return body


def write(win, engine, version, status, text="hi", finished_at=None, cfg=CFG):
    write_track(ROOT, DATE, ROOM, win, track(win, engine, version, status, text, cfg=cfg),
                manifest_stub=stub(win), finished_at=finished_at)


# --- ok-then-failed (same config, a version bump): the ok evidence must still be returned -----------
win = "w_ok_then_failed"
write(win, "whisper-auto", "v1", "ok", text="first pass", finished_at="2026-09-27T10:00:00Z")
write(win, "whisper-auto", "v2", "failed", finished_at="2026-09-27T11:00:00Z")
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
ts = w.tracks(layer="stt")
assert len(ts) == 1, [t.entry for t in ts]
t = ts[0]
assert t.status == "ok" and t.segments[0]["text"] == "first pass", "the earlier ok run must still be the evidence"
assert t.superseded_by is not None and t.superseded_by["status"] == "failed", "the later failure must be attached, not hidden"
print("1/6 ok-then-failed OK: ok evidence returned, later failure (same config, newer version) attached as superseded_by")

# --- failed-then-ok: no superseded_by, the ok run (which is also latest) is just returned normally ---
win = "w_failed_then_ok"
write(win, "whisper-auto", "v1", "failed", finished_at="2026-09-27T10:00:00Z")
write(win, "whisper-auto", "v2", "ok", text="second pass", finished_at="2026-09-27T11:00:00Z")
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
ts = w.tracks(layer="stt")
assert len(ts) == 1
t = ts[0]
assert t.status == "ok" and t.segments[0]["text"] == "second pass"
assert t.superseded_by is None, "an ok run that IS the latest must not show a phantom supersession"
print("2/6 failed-then-ok OK: latest ok run returned cleanly, no false superseded_by")

# --- failed-only: never silently omitted (the #4751 bug) ---------------------------------------------
win = "w_failed_only"
write(win, "whisper-auto", "v1", "failed", finished_at="2026-09-27T10:00:00Z")
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
ts = w.tracks(layer="stt")
assert len(ts) == 1, "a failed-only engine must still appear (distinguishable from never-written)"
t = ts[0]
assert t.status == "failed" and t.reason == "simulated failure"
assert t.superseded_by is None
print("3/6 failed-only OK: a failed track with no ok run is visible, not dropped")

# --- never-written stays genuinely absent (distinct from failed) -------------------------------------
w = reb_pkg.load_window("w_failed_only", ist_date=DATE, root=ROOT)
assert w.tracks(layer="stt", engine="does-not-exist") == [], "an engine that never ran must return []"
print("4/6 never-written OK: an engine that never ran returns [], distinct from a visible failure")

# --- latest_ok=False is untouched: full history, every status ----------------------------------------
win = "w_ok_then_failed"
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
allts = w.tracks(layer="stt", latest_ok=False)
assert sorted(t.status for t in allts) == ["failed", "ok"], [t.status for t in allts]
print("5/6 latest_ok=False OK: full history unaffected")

# --- eta-refuter-2 #4803: two DIFFERENT configs of the SAME engine must BOTH be returned, never one
# hiding the other just because it finished later --------------------------------------------------
win = "w_two_configs"
cfg_a, cfg_b = {"arm": "v0"}, {"arm": "v0-noETR"}
write(win, "fuser-v0-m6-etr", "v1", "ok", text="with etr", finished_at="2026-09-27T10:00:00Z", cfg=cfg_a)
write(win, "fuser-v0-m6-etr", "v1", "ok", text="without etr", finished_at="2026-09-27T11:00:00Z", cfg=cfg_b)
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
ts = w.tracks(layer="stt", engine="fuser-v0-m6-etr")
assert len(ts) == 2, f"both configs must be returned, got {[(t.config, t.status) for t in ts]}"
texts = {t.config["arm"]: t.segments[0]["text"] for t in ts}
assert texts == {"v0": "with etr", "v0-noETR": "without etr"}
assert all(t.superseded_by is None for t in ts), "different configs are not reruns of each other; neither supersedes the other"
print("6/6 two-configs OK: config_hash is part of the grouping key, so both arms are returned intact")


# --- eta-refuter-3 #4796: segments_between must NEVER read a failed track's segments as evidence -----
win = "w_failed_with_segments"
bad_track = track(win, "whisper-auto", "v1", status="failed", text="partial")
bad_track["segments"] = [{"t0_ms": 0, "t1_ms": 500, "text": "partial"}]  # the schema allows this; the writer accepts it
write_track(ROOT, DATE, ROOM, win, bad_track, manifest_stub=stub(win))
w = reb_pkg.load_window(win, ist_date=DATE, root=ROOT)
assert w.tracks(layer="stt")[0].status == "failed"  # visible via tracks(), per #4751's fix
segs = w.segments_between(0, 1000, layer="stt")
assert segs == [], f"a failed track's segments must never be returned as evidence, got {segs}"
print("EXTRA: segments_between OK: a failed-only track's segments are never surfaced as evidence")

shutil.rmtree(ROOT, ignore_errors=True)
print("ALL OK: tracks(latest_ok=True) never silently drops a failed/skipped run, grouping is config-aware, segments_between ignores non-ok tracks")
