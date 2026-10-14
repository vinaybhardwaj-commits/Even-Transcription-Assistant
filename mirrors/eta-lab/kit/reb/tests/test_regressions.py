#!/usr/bin/env python3
"""Regression tests for eta-refuter-2's review of 20f47579 (bus #4595): B1 orphaned track on a failed
first write, B2 unvalidated path components, B3 torn/locked manifest reads under concurrency."""
import json
import multiprocessing
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
import reb as reb_pkg
from reb.writer import PathComponentError, TrackExistsError, config_hash, write_track

ROOT = tempfile.mkdtemp(prefix="reb-regress-")
DATE, ROOM, WIN = "2026-09-26", "room_jwyrr4dc", "w_regress_0001"
STUB = {
    "window_id": WIN, "room_id": ROOM, "room_slug": "orb3-29ac", "ist_date": DATE,
    "t0_ms": 0, "t1_ms": 300000,
    "audio": {"r2_key": "bench/orb3/2026-09-26/w_regress_0001.webm", "sha256": "ab" * 32,
              "sample_rate": 16000, "duration_ms": 300000},
}


def make_track(engine, cfg=None, layer="stt", window_id=WIN):
    cfg = cfg or {}
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": layer, "engine": engine,
        "model": "m", "version": "v1", "config": cfg, "config_hash": config_hash(cfg),
        "machine": "box", "status": "ok",
        "segments": [{"t0_ms": 0, "t1_ms": 1000, "text": "x"}],
    }


# --- B1: a failed first write (no manifest_stub) must not orphan the track file --------------------
try:
    write_track(ROOT, DATE, ROOM, WIN, make_track("whisper-auto"))  # no manifest_stub -> must fail
    raise AssertionError("expected ValueError: no manifest_stub on a brand-new window")
except ValueError:
    pass
window_dir = os.path.join(ROOT, DATE, ROOM, WIN)
assert not os.path.exists(window_dir), f"B1 regressed: {window_dir} was created despite the failed call"

# now retry WITH the stub — must succeed cleanly, exactly once, no TrackExistsError from the failed attempt
p = write_track(ROOT, DATE, ROOM, WIN, make_track("whisper-auto"), manifest_stub=STUB)
assert os.path.exists(p)
manifest = json.load(open(os.path.join(window_dir, "manifest.json")))
assert len(manifest["tracks"]) == 1
print("B1 OK: a failed first write leaves nothing on disk; the retry with a stub succeeds cleanly")

# a crash between the track file and the manifest (simulated: pass a manifest_stub missing a required
# field, so _write_manifest_entry's validate_manifest fails) must also roll the track file back
bad_stub = dict(STUB); del bad_stub["t1_ms"]; bad_stub["window_id"] = "w_regress_0002"
win2 = "w_regress_0002"
try:
    write_track(ROOT, DATE, ROOM, win2, make_track("whisper-auto", window_id=win2), manifest_stub=bad_stub)
    raise AssertionError("expected the bad stub to fail manifest validation")
except Exception:
    pass
tracks_dir2 = os.path.join(ROOT, DATE, ROOM, win2, "tracks")
assert not os.path.exists(tracks_dir2) or not os.listdir(tracks_dir2), "a manifest failure must roll back the track file"
# and the retry with a correct stub must now succeed (not TrackExistsError from the rolled-back file)
good_stub2 = dict(STUB, window_id=win2)
write_track(ROOT, DATE, ROOM, win2, make_track("whisper-auto", window_id=win2), manifest_stub=good_stub2)
print("B1b OK: a manifest-validation failure rolls the track file back; retry succeeds")


# --- B2: path components are whitelisted; traversal is rejected ------------------------------------
for bad in ("../escape", "..", ".", "a/b", "", "a b", "trailing/"):
    try:
        write_track(ROOT, bad, ROOM, "w3", make_track("whisper-auto", window_id="w3"), manifest_stub=dict(STUB, window_id="w3"))
        raise AssertionError(f"expected PathComponentError for ist_date={bad!r}")
    except PathComponentError:
        pass
outside_marker = os.path.join(os.path.dirname(ROOT), "reb-regress-ESCAPED")
assert not os.path.exists(outside_marker), "B2 regressed: a component escaped root"
for bad in ("../escape", "..", "a/b", ""):
    try:
        write_track(ROOT, DATE, bad, "w3", make_track("whisper-auto", window_id="w3"), manifest_stub=dict(STUB, window_id="w3"))
        raise AssertionError(f"expected PathComponentError for room_id={bad!r}")
    except PathComponentError:
        pass
print("B2 OK: '..'/'/'/empty path components are rejected before any file is touched")


# --- B3: concurrent writers to the SAME window never see a torn/invalid manifest.json --------------
def _worker(engine):
    write_track(ROOT, DATE, ROOM, "w_concurrent", make_track(engine, window_id="w_concurrent"),
                manifest_stub=dict(STUB, window_id="w_concurrent"))


engines = [f"engine-{i}" for i in range(8)]
procs = [multiprocessing.Process(target=_worker, args=(e,)) for e in engines]
[p.start() for p in procs]
[p.join(timeout=30) for p in procs]
assert all(p.exitcode == 0 for p in procs), [p.exitcode for p in procs]
manifest3 = json.load(open(os.path.join(ROOT, DATE, ROOM, "w_concurrent", "manifest.json")))
got_engines = sorted(t["engine"] for t in manifest3["tracks"])
assert got_engines == sorted(engines), got_engines
print("B3 OK: 8 concurrent processes writing the same window all land in one valid manifest.json, none lost")

# --- #4619: a mirror failure after the manifest is committed must NOT delete the track ------------
import reb.r2_mirror as r2m
from reb.writer import MirrorPendingError

_orig_enabled, _orig_put = r2m.enabled, r2m.put
r2m.enabled = lambda: True
r2m.put = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("simulated wrangler failure"))
try:
    win4 = "w_mirrorfail"
    stub4 = dict(STUB, window_id=win4)
    try:
        write_track(ROOT, DATE, ROOM, win4, make_track("whisper-auto", window_id=win4), manifest_stub=stub4)
        raise AssertionError("expected MirrorPendingError")
    except MirrorPendingError:
        pass
    # the track + manifest entry must be fully durable despite the mirror failure
    tracks_dir4 = os.path.join(ROOT, DATE, ROOM, win4, "tracks")
    assert os.listdir(tracks_dir4), "the track file must survive a mirror failure, not be rolled back"
    manifest4 = json.load(open(os.path.join(ROOT, DATE, ROOM, win4, "manifest.json")))
    assert len(manifest4["tracks"]) == 1 and manifest4["tracks"][0]["engine"] == "whisper-auto"
    # a SECOND track for the same window, same failing mirror, must not touch the first (dangling-entry repro from #4619)
    try:
        write_track(ROOT, DATE, ROOM, win4, make_track("sravaani", window_id=win4), manifest_stub=stub4)
        raise AssertionError("expected MirrorPendingError on the second write too")
    except MirrorPendingError:
        pass
    manifest4b = json.load(open(os.path.join(ROOT, DATE, ROOM, win4, "manifest.json")))
    assert len(manifest4b["tracks"]) == 2
    for entry in manifest4b["tracks"]:
        assert os.path.exists(os.path.join(ROOT, entry["path"])), f"manifest lists {entry['path']} but it's missing on disk (#4619)"
finally:
    r2m.enabled, r2m.put = _orig_enabled, _orig_put
print("#4619 OK: a mirror failure raises MirrorPendingError but never deletes an already-committed track; no dangling manifest entries")

shutil.rmtree(ROOT, ignore_errors=True)
print("ALL REGRESSION TESTS OK (B1, B1b, B2, B3 from #4595; mirror-rollback fix from #4619)")
